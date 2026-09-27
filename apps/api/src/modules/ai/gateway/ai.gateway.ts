import type { AiStatusView } from "@expensewise/core/contracts/ai-extra";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { WorkspaceContext } from "../../../common/context.js";
import { CreditsService } from "../../billing/credits.service.js";
import { AiRateLimiter, AiUsageService, type AiUsageStatus } from "../usage.service.js";
import type { ClassificationOutput, ExtractionOutput } from "./schemas.js";
import {
  AI_PROVIDER,
  type AiFeature,
  type AiProvider,
  AiProviderError,
  type ClassifyInput,
  type ExtractInput,
  type GatewayFailureReason,
  type GatewayResult,
  type GenerateInput,
  type ProviderResult,
  type ToolRunInput,
  type ToolRunOutput,
  ZERO_USAGE,
} from "./types.js";

type Caller = Pick<WorkspaceContext, "workspaceId" | "userId" | "settings" | "timezone">;

type RefusalReason = "not_configured" | "disabled" | "budget" | "credits" | "rate_limited";

const REASON_MESSAGES: Record<RefusalReason, string> = {
  not_configured: "AI is not configured on this server",
  disabled: "AI is turned off for this workspace",
  budget: "This month's AI budget is used up",
  credits: "The AI credits for this workspace are used up; the owner can add more in Plan & billing",
  rate_limited: "Too many AI requests; try again in a minute",
};

/**
 * The provider-neutral entry point for every AI call. It decides whether a
 * call may happen (provider configured, workspace setting, monthly budget,
 * AI credits when billing is on, per-user rate limit), makes it, and records
 * it in ai_usage — including the calls it refused to make — then takes the
 * call's credits from the workspace owner. Callers get a result or a reason,
 * never an exception for an AI-side problem, so they can fall back to
 * deterministic processing.
 */
@Injectable()
export class AiGateway {
  private readonly logger = new Logger("AiGateway");

  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(AiUsageService) private readonly usage: AiUsageService,
    @Inject(AiRateLimiter) private readonly limiter: AiRateLimiter,
    @Optional() @Inject(CreditsService) private readonly credits?: CreditsService,
  ) {}

  private async billingEnabled(): Promise<boolean> {
    return this.credits ? this.credits.billingEnabled() : false;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get model(): string | null {
    return this.provider.model;
  }

  /** A provider with credentials exists (not the no-op provider). */
  get configured(): boolean {
    return this.provider.available;
  }

  /** Whether calls would be allowed right now, without making one. */
  async availability(ctx: Caller): Promise<{
    available: boolean;
    reason: "not_configured" | "disabled" | "budget" | "credits" | null;
    spentUsd: number;
  }> {
    const spentUsd = await this.usage.spentThisMonth(ctx);
    if (!this.provider.available) return { available: false, reason: "not_configured", spentUsd };
    if (ctx.settings.aiEnabled === false) return { available: false, reason: "disabled", spentUsd };
    const billing = await this.billingEnabled();
    const { limitUsd } = this.usage.budgetFor(ctx, billing);
    if (limitUsd !== null && spentUsd >= limitUsd) return { available: false, reason: "budget", spentUsd };
    if (billing && this.credits && !(await this.credits.canSpend(ctx.workspaceId))) return { available: false, reason: "credits", spentUsd };
    return { available: true, reason: null, spentUsd };
  }

  async status(ctx: Caller): Promise<AiStatusView> {
    const { available, reason, spentUsd } = await this.availability(ctx);
    const billing = await this.billingEnabled();
    const budget = this.usage.budgetFor(ctx, billing);
    const credits = billing && this.credits ? await this.credits.statusFor(ctx.workspaceId) : null;
    return {
      configured: this.provider.available,
      provider: this.provider.name,
      model: this.provider.model,
      enabled: ctx.settings.aiEnabled !== false,
      available,
      reason,
      budget: {
        limitUsd: budget.limitUsd,
        spentUsd,
        remainingUsd: budget.limitUsd === null ? null : Math.max(0, Math.round((budget.limitUsd - spentUsd) * 1_000_000) / 1_000_000),
        source: budget.source,
      },
      spentThisMonth: spentUsd,
      credits,
      features: {
        extraction: available,
        classification: available,
        narratives: available,
        // The copilot always answers: through the model when available, from built-in readings otherwise.
        copilot: true,
        textParser: true,
        duplicateDetection: true,
        recurringDetection: true,
        anomalyDetection: true,
      },
    };
  }

  /** Reads transactions (and a subscription, if any) from an image, a PDF or text. */
  extractTransactions(ctx: Caller, input: ExtractInput, feature: AiFeature = "capture.extract"): Promise<GatewayResult<ExtractionOutput>> {
    return this.invoke(ctx, feature, () => this.provider.extract(input));
  }

  /** Category/project suggestions for transactions rules and merchant memory could not place. */
  classify(ctx: Caller, input: ClassifyInput, feature: AiFeature = "classify"): Promise<GatewayResult<ClassificationOutput>> {
    return this.invoke(ctx, feature, () => this.provider.classify(input));
  }

  /** Free text from a system prompt and a prompt (report narratives, explanations). */
  generate(ctx: Caller, input: GenerateInput): Promise<GatewayResult<{ text: string }>> {
    return this.invoke(ctx, input.feature ?? "generate", () => this.provider.generate(input));
  }

  /** Alias of `generate` for summaries. */
  summarize(ctx: Caller, input: GenerateInput): Promise<GatewayResult<{ text: string }>> {
    return this.generate(ctx, { feature: "summarize", ...input });
  }

  /**
   * A tool-use loop (the future copilot): the model calls the given tools,
   * inputs are validated with each tool's Zod schema, iterations are capped.
   * One ai_usage row covers the whole loop.
   */
  runWithTools(ctx: Caller, input: ToolRunInput): Promise<GatewayResult<ToolRunOutput>> {
    return this.invoke(ctx, input.feature ?? "copilot", () => this.provider.runWithTools(input));
  }

  private async record(
    ctx: Caller,
    feature: AiFeature,
    status: AiUsageStatus,
    fields: {
      model?: string | null;
      usage?: typeof ZERO_USAGE;
      costUsd?: number;
      latencyMs?: number | null;
      error?: string | null;
    },
  ) {
    return this.usage.record({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      feature,
      provider: this.provider.name,
      model: fields.model ?? this.provider.model ?? "none",
      usage: fields.usage ?? ZERO_USAGE,
      costUsd: fields.costUsd ?? 0,
      latencyMs: fields.latencyMs ?? null,
      status,
      error: fields.error ?? null,
    });
  }

  /** Takes the call's credits from the workspace owner (billing on only; never throws). */
  private async charge(ctx: Caller, usageId: string | null, costUsd: number) {
    if (this.credits) await this.credits.charge({ workspaceId: ctx.workspaceId, usageId, costUsd });
  }

  private async blocked<T>(ctx: Caller, feature: AiFeature): Promise<GatewayResult<T> | null> {
    const refuse = async (reason: RefusalReason, status: AiUsageStatus): Promise<GatewayResult<T>> => {
      const usageId = await this.record(ctx, feature, status, {
        error: reason,
      });
      return {
        ok: false,
        reason,
        message: reason === "not_configured" && this.provider.unavailableReason ? this.provider.unavailableReason : REASON_MESSAGES[reason],
        retryable: reason === "rate_limited",
        provider: this.provider.name,
        model: this.provider.model,
        usage: ZERO_USAGE,
        costUsd: 0,
        latencyMs: 0,
        usageId,
      };
    };
    if (!this.provider.available) return refuse("not_configured", "disabled");
    if (ctx.settings.aiEnabled === false) return refuse("disabled", "disabled");
    const billing = await this.billingEnabled();
    const { limitUsd } = this.usage.budgetFor(ctx, billing);
    if (limitUsd !== null && (await this.usage.spentThisMonth(ctx)) >= limitUsd) return refuse("budget", "budget");
    // With billing on, the workspace owner pays in AI credits.
    if (billing && this.credits && !(await this.credits.canSpend(ctx.workspaceId))) return refuse("credits", "credits");
    // Background jobs act for the workspace, not a person; people are rate limited.
    if (ctx.userId && !(await this.limiter.allow(ctx.userId))) return refuse("rate_limited", "error");
    return null;
  }

  private async invoke<T>(ctx: Caller, feature: AiFeature, call: () => Promise<ProviderResult<T>>): Promise<GatewayResult<T>> {
    const refusal = await this.blocked<T>(ctx, feature);
    if (refusal) return refusal;

    const started = Date.now();
    let result: ProviderResult<T>;
    try {
      result = await call();
    } catch (error) {
      const mapped =
        error instanceof AiProviderError ? error : new AiProviderError("unknown", error instanceof Error ? error.message : String(error), { cause: error });
      const latencyMs = Date.now() - started;
      this.logger.warn(`${feature} failed (${mapped.kind}): ${mapped.message}`);
      const usageId = await this.record(ctx, feature, "error", {
        latencyMs,
        error: `${mapped.kind}: ${mapped.message}`,
      });
      return {
        ok: false,
        reason: "error",
        message: mapped.message,
        retryable: mapped.retryable,
        provider: this.provider.name,
        model: this.provider.model,
        usage: ZERO_USAGE,
        costUsd: 0,
        latencyMs,
        usageId,
      };
    }

    const latencyMs = Date.now() - started;
    const meta = {
      provider: this.provider.name,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs,
    };
    if (result.status === "ok") {
      const usageId = await this.record(ctx, feature, "ok", { ...meta });
      await this.charge(ctx, usageId, result.costUsd);
      return { ok: true, output: result.output, ...meta, usageId };
    }
    const reason: GatewayFailureReason = result.status;
    const usageId = await this.record(ctx, feature, result.status === "refusal" ? "refusal" : "error", {
      ...meta,
      error:
        result.status === "refusal" ? `refusal${result.category ? ` (${result.category})` : ""}: ${result.message}` : `${result.status}: ${result.message}`,
    });
    // The model answered (and was paid for) even if the answer was unusable.
    await this.charge(ctx, usageId, result.costUsd);
    return {
      ok: false,
      reason,
      message: result.message,
      retryable: false,
      ...meta,
      usageId,
    };
  }
}

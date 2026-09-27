import { type ParsedEntry, parseEntry, type SubscriptionInput, type TransactionSource } from "@expensewise/core";
import {
  type CaptureConfirmInput,
  type CaptureConfirmResult,
  type CaptureDraftView,
  type CaptureListItem,
  type CaptureListQuery,
  type CaptureStage,
  type CaptureUploadKind,
  type CaptureView,
  type ConfidenceField,
  captureConfirmInput,
  captureListQuery,
  captureRetryInput,
  type SubscriptionSuggestion,
} from "@expensewise/core/contracts/ai-extra";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { contextFor, todayFor, type WorkspaceContext } from "../../../common/context.js";
import { assertFound, badRequest, conflict, DomainError } from "../../../common/errors.js";
import { db, type Executor } from "../../../db/index.js";
import { captures, counterparties, files, transactions, workspaces } from "../../../db/schema/index.js";
import type { AiConfidence } from "../../../db/schema/types.js";
import { CounterpartiesService } from "../../ledger/catalog.service.js";
import { type TransactionRow, TransactionsService } from "../../ledger/transactions.service.js";
import { SubscriptionsService } from "../../planning/subscriptions.service.js";
import { ALLOWED_TYPES, StorageService } from "../../storage/storage.service.js";
import { AuditService } from "../../system/audit.service.js";
import { EventsService } from "../../system/events.service.js";
import { JobsService } from "../../system/jobs.service.js";
import { InboxService } from "../../system/notify.service.js";
import { AiGateway } from "../gateway/ai.gateway.js";
import type { ExtractionOutput } from "../gateway/schemas.js";
import type { ExtractionHints, GatewayResult } from "../gateway/types.js";
import { DraftBuilder, type ResolvedDraft, type WorkspaceSnapshot } from "./draft-builder.js";
import { buildSubscriptionSuggestion, type Candidate, candidateFromParsed, candidatesFromExtraction, mergeParserIntoAi } from "./normalize.js";
import { CaptureInputError, countPdfPages, looksLikePdf, MAX_PDF_PAGES, prepareImage } from "./preprocess.js";

export type CaptureRow = typeof captures.$inferSelect;
type Method = "ai" | "parser" | "manual" | "duplicate";

/** The capture row's `extraction` column: everything read, and how. */
export type CaptureExtraction = {
  version: 1;
  upload?: {
    filename: string;
    contentType: string;
    bytes: number;
    /** An earlier capture of byte-identical content. */
    duplicateOf: CaptureView["duplicateOf"];
    /** Process even though the file was captured before. */
    force: boolean;
  };
  startedAt?: string;
  method?: Method | null;
  fallbackReason?: string | null;
  retryable?: boolean;
  documentType?: string | null;
  notes?: string[];
  parser?: ParsedEntry | null;
  model?: ExtractionOutput | null;
  preprocess?: {
    width?: number;
    height?: number;
    bytes?: number;
    originalBytes?: number;
    pdfPages?: number | null;
  } | null;
  unresolved?: CaptureView["unresolved"];
  ignored?: Array<{
    index: number;
    ruleIds: string[];
    merchant: string | null;
  }>;
  subscription?: SubscriptionSuggestion | null;
  subscriptionDecision?: "created" | "declined" | "deferred" | "failed" | null;
  subscriptionId?: string | null;
  postedTransactionIds?: string[];
  usageIds?: string[];
};

/** Stored on each draft transaction's `metadata`. */
export type DraftMetadata = {
  captureId: string;
  captureIndex: number;
  method: Method;
  extracted: CaptureDraftView["extracted"] & {
    categoryName: string | null;
    projectName: string | null;
    workspaceHint: string | null;
  };
  review: { missing: ConfidenceField[]; lowConfidence: ConfidenceField[] };
  suggestions: CaptureDraftView["suggestions"];
  duplicates: Array<{
    transactionId: string;
    score: number;
    exact: boolean;
    reasons: string[];
  }>;
  suggestedWorkspace: CaptureDraftView["suggestedWorkspace"];
  subscription: SubscriptionSuggestion | null;
  ruleIds: string[];
};

type ReadResult = {
  method: Method;
  candidates: Candidate[];
  subscription: SubscriptionSuggestion | null;
  fallbackReason: string | null;
  retryable: boolean;
  /** A temporary provider problem: the capture fails and can be retried. */
  failure: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number;
  usageIds: string[];
  documentType: string | null;
  notes: string[];
  parser: ParsedEntry | null;
  modelOutput: ExtractionOutput | null;
  preprocess: CaptureExtraction["preprocess"];
};

/** How long an upload request waits for the result before answering "processing". */
const INLINE_BUDGET_MS = 25_000;
/** A capture stuck in processing this long (a crashed worker) may be claimed again. */
const STALE_PROCESSING_MINUTES = 5;
/** The background job that finishes a capture if the request that started it could not. */
const SAFETY_JOB_DELAY_MS = (STALE_PROCESSING_MINUTES + 1) * 60_000;
/** An undecided subscription suggestion goes to the AI Inbox after this long. */
const FOLLOW_UP_DELAY_MS = 24 * 60 * 60_000;

const SOURCE_FOR: Record<CaptureRow["kind"], TransactionSource> = {
  screenshot: "screenshot",
  receipt: "receipt",
  pdf: "pdf",
  text: "text",
  voice: "voice",
  email: "text",
};

const IMAGE_TYPES = ALLOWED_TYPES.image ?? [];
const MODEL_IMAGE_TYPE = "image/jpeg" as const;

function cycleLabel(cycle: SubscriptionSuggestion["billingCycle"]): string {
  switch (cycle) {
    case "monthly":
      return "Monthly";
    case "quarterly":
      return "Quarterly";
    case "half_yearly":
      return "Half-yearly";
    case "yearly":
      return "Yearly";
    case "custom":
      return "Custom cycle";
    default:
      return "Billing cycle unknown";
  }
}

/**
 * The capture pipeline: a screenshot, receipt, PDF or sentence becomes draft
 * transactions a person reviews. Rules and merchant memory decide first, the
 * deterministic parser handles clear notes without a model, and the model
 * reads what nothing else can. Nothing reaches the ledger without a
 * confirmation, unless the workspace opted into auto-posting and every
 * required field is near-certain.
 */
@Injectable()
export class CaptureService implements OnModuleInit {
  private readonly logger = new Logger("Capture");

  constructor(
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(DraftBuilder) private readonly builder: DraftBuilder,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(CounterpartiesService)
    private readonly counterparties: CounterpartiesService,
    @Inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(InboxService) private readonly inbox: InboxService,
  ) {}

  onModuleInit() {
    this.jobs.register("ai.capture", async (payload) => {
      const ctx = await this.contextForCapture(String(payload.captureId));
      if (!ctx) return { skipped: "capture not found" };
      await this.process(ctx, String(payload.captureId));
      const row = await this.row(ctx, String(payload.captureId));
      return { stage: row.stage };
    });
    this.jobs.register("ai.capture.followup", async (payload) => this.followUp(String(payload.captureId)));
  }

  // ------------------------------------------------------------ intake

  async createFromUpload(
    ctx: WorkspaceContext,
    upload: { buffer: Buffer; filename: string; contentType: string },
    kindHint?: CaptureUploadKind,
  ): Promise<CaptureView> {
    const contentType = upload.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const isPdf = contentType === "application/pdf";
    if (isPdf && !looksLikePdf(upload.buffer)) throw badRequest("This file is not a valid PDF", "invalid_file");
    if (kindHint === "pdf" && !isPdf) throw badRequest("Upload a PDF for a PDF capture", "unsupported_type");
    if (!isPdf && !IMAGE_TYPES.includes(contentType)) throw badRequest(`Unsupported file type ${contentType || "(unknown)"}`, "unsupported_type");

    const kind: CaptureRow["kind"] = isPdf ? "pdf" : kindHint === "receipt" ? "receipt" : "screenshot";
    const fileKind = kind === "pdf" ? (kindHint === "receipt" ? "receipt" : "statement") : kind;
    const saved = await this.storage.save(ctx, { ...upload, contentType }, fileKind, [...IMAGE_TYPES, ...(ALLOWED_TYPES.pdf ?? [])]);
    const duplicateOf = saved.duplicateOf ? await this.earlierCapture(ctx, saved.sha256, saved.id) : null;

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(captures)
        .values({
          workspaceId: ctx.workspaceId,
          kind,
          stage: "received",
          fileId: saved.id,
          createdBy: ctx.userId,
          extraction: {
            version: 1,
            upload: {
              filename: saved.filename,
              contentType,
              bytes: saved.size,
              duplicateOf,
              force: false,
            },
          } satisfies CaptureExtraction,
        })
        .returning();
      const capture = assertFound(created, "Capture");
      await this.audit.record(tx, ctx, {
        action: "capture.created",
        entityType: "capture",
        entityId: capture.id,
        after: { kind, fileId: saved.id },
      });
      await this.jobs.enqueue(
        "ai.capture",
        { captureId: capture.id },
        {
          workspaceId: ctx.workspaceId,
          dedupeKey: `ai.capture:${capture.id}`,
          runAt: new Date(Date.now() + SAFETY_JOB_DELAY_MS),
        },
        tx,
      );
      return capture;
    });
    await this.runInline(ctx, row.id);
    return this.view(ctx, row.id);
  }

  async createFromText(ctx: WorkspaceContext, input: { text: string; kind: "text" | "voice" }): Promise<CaptureView> {
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(captures)
        .values({
          workspaceId: ctx.workspaceId,
          kind: input.kind,
          stage: "received",
          inputText: input.text,
          createdBy: ctx.userId,
          extraction: { version: 1 },
        })
        .returning();
      const capture = assertFound(created, "Capture");
      await this.audit.record(tx, ctx, {
        action: "capture.created",
        entityType: "capture",
        entityId: capture.id,
        after: { kind: input.kind },
      });
      await this.jobs.enqueue(
        "ai.capture",
        { captureId: capture.id },
        {
          workspaceId: ctx.workspaceId,
          dedupeKey: `ai.capture:${capture.id}`,
          runAt: new Date(Date.now() + SAFETY_JOB_DELAY_MS),
        },
        tx,
      );
      return capture;
    });
    await this.runInline(ctx, row.id);
    return this.view(ctx, row.id);
  }

  /** The most recent live capture of byte-identical content. */
  private async earlierCapture(ctx: WorkspaceContext, sha256: string, exceptFileId: string): Promise<CaptureView["duplicateOf"]> {
    const [earlier] = await db
      .select({ capture: captures })
      .from(captures)
      .innerJoin(files, eq(files.id, captures.fileId))
      .where(
        and(
          eq(captures.workspaceId, ctx.workspaceId),
          eq(files.workspaceId, ctx.workspaceId),
          eq(files.sha256, sha256),
          ne(files.id, exceptFileId),
          ne(captures.stage, "discarded"),
        ),
      )
      .orderBy(desc(captures.createdAt))
      .limit(1);
    if (!earlier) return null;
    const extraction = (earlier.capture.extraction ?? {}) as CaptureExtraction;
    return {
      captureId: earlier.capture.id,
      fileId: earlier.capture.fileId as string,
      stage: earlier.capture.stage,
      capturedAt: earlier.capture.createdAt.toISOString(),
      transactionIds: extraction.postedTransactionIds?.length ? extraction.postedTransactionIds : earlier.capture.draftTransactionIds,
    };
  }

  /** Waits for processing up to the inline budget; past it the request answers "processing" and the work continues. */
  private async runInline(ctx: WorkspaceContext, captureId: string) {
    let timer: NodeJS.Timeout | undefined;
    const work = this.process(ctx, captureId).catch((error) => {
      this.logger.error(`Capture ${captureId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, INLINE_BUDGET_MS);
    });
    await Promise.race([work, budget]);
    if (timer) clearTimeout(timer);
  }

  private async contextForCapture(captureId: string): Promise<WorkspaceContext | null> {
    const [row] = await db
      .select({ capture: captures, workspace: workspaces })
      .from(captures)
      .innerJoin(workspaces, eq(workspaces.id, captures.workspaceId))
      .where(eq(captures.id, captureId))
      .limit(1);
    if (!row) return null;
    return contextFor(row.workspace, {
      userId: row.capture.createdBy,
      actorType: "ai",
    });
  }

  // -------------------------------------------------------- processing

  /** Moves received (or abandoned) → processing atomically, so each capture is processed once. */
  private async claim(workspaceId: string, captureId: string): Promise<CaptureRow | null> {
    const [row] = await db
      .update(captures)
      .set({
        stage: "processing",
        error: null,
        extraction: sql`coalesce(${captures.extraction}, '{}'::jsonb) || jsonb_build_object('startedAt', now())`,
      })
      .where(
        and(
          eq(captures.id, captureId),
          eq(captures.workspaceId, workspaceId),
          or(
            eq(captures.stage, "received"),
            and(
              eq(captures.stage, "processing"),
              sql`coalesce((${captures.extraction}->>'startedAt')::timestamptz, ${captures.createdAt}) < now() - make_interval(mins => ${STALE_PROCESSING_MINUTES})`,
            ),
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Reads the capture and stores draft transactions. Idempotent: only a
   * received (or stale) capture is processed; any other call is a no-op.
   */
  async process(ctx: WorkspaceContext, captureId: string): Promise<void> {
    const capture = await this.claim(ctx.workspaceId, captureId);
    if (!capture) return;
    const started = Date.now();
    const extraction = (capture.extraction ?? {
      version: 1,
    }) as CaptureExtraction;
    try {
      const snapshot = await this.builder.snapshot(ctx);
      const read = await this.read(ctx, capture, extraction, snapshot);
      if (read.failure) {
        await this.fail(ctx, capture, extraction, read.failure, true, started, read);
        return;
      }
      await this.persist(ctx, capture, extraction, read, snapshot, started);
    } catch (error) {
      const expected = error instanceof CaptureInputError || error instanceof DomainError;
      if (!expected) this.logger.error(`Capture ${captureId} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      const message = expected ? (error as Error).message : "Something went wrong while reading this capture. Try again.";
      await this.fail(ctx, capture, extraction, message, !(error instanceof CaptureInputError), started, null);
    }
  }

  private hints(ctx: WorkspaceContext, snapshot: WorkspaceSnapshot): ExtractionHints {
    return {
      today: todayFor(ctx),
      timezone: ctx.timezone,
      baseCurrency: ctx.baseCurrency,
      workspaceKind: ctx.workspaceKind,
      accounts: snapshot.accounts.map((a) => ({
        name: a.name,
        kind: a.kind,
        provider: a.provider,
        mask: a.mask,
        currency: a.currency,
      })),
      categories: snapshot.categories.map((c) => ({
        name: c.name,
        kind: c.kind,
      })),
      projects: snapshot.projects.map((p) => p.name),
    };
  }

  private empty(method: Method, extra: Partial<ReadResult> = {}): ReadResult {
    return {
      method,
      candidates: [],
      subscription: null,
      fallbackReason: null,
      retryable: false,
      failure: null,
      provider: null,
      model: null,
      costUsd: 0,
      usageIds: [],
      documentType: null,
      notes: [],
      parser: null,
      modelOutput: null,
      preprocess: null,
      ...extra,
    };
  }

  /** What the gateway said, as the parts of a read result. */
  private fromGateway(result: GatewayResult<ExtractionOutput>): Pick<ReadResult, "provider" | "model" | "costUsd" | "usageIds"> {
    return {
      provider: result.provider,
      model: result.model,
      costUsd: result.costUsd,
      usageIds: result.usageId ? [result.usageId] : [],
    };
  }

  private async read(ctx: WorkspaceContext, capture: CaptureRow, extraction: CaptureExtraction, snapshot: WorkspaceSnapshot): Promise<ReadResult> {
    const today = todayFor(ctx);
    const hints = this.hints(ctx, snapshot);

    // The same bytes were captured before: say so instead of paying to read them again.
    if (extraction.upload?.duplicateOf && !extraction.upload.force) {
      return this.empty("duplicate", {
        notes: ["This file was captured before. Open the earlier capture, or process it again anyway."],
      });
    }

    if (capture.kind === "text" || capture.kind === "voice" || capture.kind === "email") {
      const text = capture.inputText ?? "";
      const parsed = parseEntry(text, {
        today,
        defaultCurrency: ctx.baseCurrency,
        projects: hints.projects,
      });
      const fromParser = candidateFromParsed(parsed, text);
      // A clear note needs no model: amount, type and date are certain (a note
      // without any date means today, which the model could not improve on).
      const clear =
        parsed.amount !== null &&
        parsed.confidence.amount >= 0.8 &&
        parsed.confidence.type >= 0.8 &&
        (parsed.confidence.date >= 0.8 || parsed.dateSource === "default");
      if (clear) {
        return this.empty("parser", {
          candidates: [fromParser],
          parser: parsed,
          subscription: buildSubscriptionSuggestion(null, [fromParser], {
            text,
            today,
          }),
        });
      }
      const result = await this.gateway.extractTransactions(ctx, {
        kind: "text",
        text,
        hints,
        sourceKind: capture.kind === "voice" ? "voice" : "text",
      });
      if (result.ok && result.output.transactions.length) {
        const fromModel = candidatesFromExtraction(result.output, {
          baseCurrency: ctx.baseCurrency,
          today,
        });
        const candidates = fromModel.length === 1 && fromModel[0] ? [mergeParserIntoAi(fromModel[0], fromParser)] : fromModel;
        return this.empty("ai", {
          ...this.fromGateway(result),
          candidates,
          parser: parsed,
          modelOutput: result.output,
          documentType: result.output.documentType,
          notes: result.output.notes,
          subscription: buildSubscriptionSuggestion(result.output.subscription, candidates, { text, today }),
        });
      }
      // No model, or it could not help: the parser's reading stands at its own confidence.
      return this.empty(parsed.amount !== null ? "parser" : "manual", {
        ...this.fromGateway(result),
        candidates: parsed.amount !== null ? [fromParser] : [],
        parser: parsed,
        modelOutput: result.ok ? result.output : null,
        fallbackReason: result.ok ? "The model found no transaction in the note" : result.message,
        retryable: !result.ok && result.retryable,
        notes: result.ok ? result.output.notes : [],
        subscription: parsed.amount !== null ? buildSubscriptionSuggestion(null, [fromParser], { text, today }) : null,
      });
    }

    if (!capture.fileId) throw new CaptureInputError("This capture has no file");
    const { body } = await this.storage.read(ctx, capture.fileId);
    let result: GatewayResult<ExtractionOutput>;
    let preprocess: CaptureExtraction["preprocess"];
    if (capture.kind === "pdf") {
      const pages = countPdfPages(body);
      preprocess = { bytes: body.length, pdfPages: pages };
      result = await this.gateway.extractTransactions(ctx, {
        kind: "pdf",
        data: body,
        mimeType: "application/pdf",
        hints,
        pageCount: pages,
      });
    } else {
      const image = await prepareImage(body);
      preprocess = {
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        originalBytes: image.originalBytes,
      };
      result = await this.gateway.extractTransactions(ctx, {
        kind: "image",
        data: image.data,
        mimeType: MODEL_IMAGE_TYPE,
        hints,
        sourceKind: capture.kind,
      });
    }
    const pageNote =
      preprocess?.pdfPages && preprocess.pdfPages > MAX_PDF_PAGES
        ? [`The PDF has ${preprocess.pdfPages} pages; only the first ${MAX_PDF_PAGES} were read.`]
        : [];

    if (result.ok) {
      const candidates = candidatesFromExtraction(result.output, {
        baseCurrency: ctx.baseCurrency,
        today,
      });
      return this.empty("ai", {
        ...this.fromGateway(result),
        candidates,
        modelOutput: result.output,
        documentType: result.output.documentType,
        notes: [...pageNote, ...result.output.notes, ...(candidates.length ? [] : ["No transaction was found in this file."])],
        preprocess,
        subscription: buildSubscriptionSuggestion(result.output.subscription, candidates, { text: result.output.notes.join(" "), today }),
      });
    }
    if (result.reason === "error" && result.retryable) {
      return this.empty("manual", {
        ...this.fromGateway(result),
        failure: result.message,
        retryable: true,
        preprocess,
      });
    }
    // Budget, disabled, not configured, a refusal or an unusable answer: the person enters it by hand.
    return this.empty("manual", {
      ...this.fromGateway(result),
      fallbackReason: result.message,
      preprocess,
      notes: [...pageNote, "Enter the details from the file by hand."],
    });
  }

  private metadataFor(captureId: string, method: Method, draft: ResolvedDraft, subscription: SubscriptionSuggestion | null): DraftMetadata {
    const c = draft.candidate;
    return {
      captureId,
      captureIndex: c.index,
      method,
      extracted: {
        paymentMethod: c.paymentMethod,
        fee: c.fee,
        lineItems: c.lineItems,
        notes: c.notes,
        ruleIds: draft.ruleIds,
        categoryName: c.categoryName,
        projectName: c.projectName,
        workspaceHint: c.workspaceHint,
      },
      review: { missing: draft.missing, lowConfidence: draft.lowConfidence },
      suggestions: draft.suggestions,
      duplicates: draft.duplicates.map((d) => ({
        transactionId: d.transactionId,
        score: d.score,
        exact: d.exact,
        reasons: d.reasons,
      })),
      suggestedWorkspace: draft.suggestedWorkspace,
      subscription,
      ruleIds: draft.ruleIds,
    };
  }

  private async persist(
    ctx: WorkspaceContext,
    capture: CaptureRow,
    extraction: CaptureExtraction,
    read: ReadResult,
    snapshot: WorkspaceSnapshot,
    started: number,
  ) {
    const today = todayFor(ctx);
    // Drafts are the AI's work on the person's behalf: audited as "ai".
    const aiCtx: WorkspaceContext = { ...ctx, actorType: "ai" };
    const source = SOURCE_FOR[capture.kind];

    const resolved: ResolvedDraft[] = [];
    for (const candidate of read.candidates) {
      resolved.push(
        await this.builder.resolve(aiCtx, candidate, snapshot, {
          source,
          captureId: capture.id,
          fileId: capture.fileId,
          today,
          methodLabel: read.method,
        }),
      );
    }
    const ignored = resolved.filter((d) => d.ignoredBy);
    const unresolved = resolved.filter((d) => !d.ignoredBy && d.candidate.amount === null);
    const drafts = resolved.filter((d) => !d.ignoredBy && d.candidate.amount !== null);
    const suggestion = read.subscription && drafts.some((d) => d.candidate.index === read.subscription?.transactionIndex) ? read.subscription : null;
    const autoPost = ctx.settings.autoPostHighConfidence === true && drafts.length > 0 && drafts.every((d) => DraftBuilder.autoPostable(d));

    const notes = [...read.notes, ...drafts.flatMap((d) => d.candidate.notes)].filter((note, i, all) => note && all.indexOf(note) === i);
    const outcome = await db.transaction(async (tx) => {
      const created: TransactionRow[] = [];
      for (const draft of drafts) {
        const confidence: AiConfidence = {
          ...draft.confidence,
          model: read.method === "ai" ? (read.model ?? undefined) : undefined,
        };
        const isPurchase = suggestion?.transactionIndex === draft.candidate.index;
        const { transaction } = await this.transactions.create(aiCtx, draft.input, {
          exec: tx,
          source,
          sourceRef: capture.id,
          aiConfidence: confidence,
          metadata: this.metadataFor(capture.id, read.method, draft, isPurchase ? suggestion : null),
          reviewReason: draft.reviewReason,
          skipLearning: true,
        });
        created.push(transaction);
      }

      let stage: CaptureStage = "suggested";
      let posted: string[] = [];
      const threshold = ctx.settings.reviewThreshold;
      const belowThreshold = created.every((t) => !threshold || (t.baseAmount !== null && t.baseAmount < threshold));
      if (autoPost && belowThreshold) {
        try {
          // A savepoint: if posting fails (a missing exchange rate), the drafts stay for review.
          await tx.transaction(async (sp) => {
            for (const transaction of created)
              await this.transactions.confirm(
                aiCtx,
                transaction.id,
                {
                  reason: "Auto-posted: every field was read with high confidence",
                },
                { exec: sp },
              );
          });
          stage = "posted";
          posted = created.map((t) => t.id);
        } catch (error) {
          notes.push(`Could not post automatically: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const next: CaptureExtraction = {
        ...extraction,
        method: read.method,
        fallbackReason: read.fallbackReason,
        retryable: read.retryable,
        documentType: read.documentType,
        notes,
        parser: read.parser,
        model: read.modelOutput,
        preprocess: read.preprocess ?? extraction.preprocess ?? null,
        unresolved: unresolved.map((d) => ({
          index: d.candidate.index,
          merchant: d.candidate.merchant,
          date: d.candidate.date,
          reason: "The amount could not be read",
        })),
        ignored: ignored.map((d) => ({
          index: d.candidate.index,
          ruleIds: d.ignoredBy ?? [],
          merchant: d.candidate.merchant,
        })),
        subscription: suggestion,
        subscriptionDecision: null,
        postedTransactionIds: posted,
        usageIds: [...(extraction.usageIds ?? []), ...read.usageIds],
      };
      const [row] = await tx
        .update(captures)
        .set({
          stage,
          provider: read.provider,
          model: read.model,
          extraction: next,
          error: null,
          durationMs: Date.now() - started,
          costUsd: sql`coalesce(${captures.costUsd}, 0) + ${read.costUsd.toFixed(6)}::numeric`,
          isSubscription: suggestion !== null,
          draftTransactionIds: created.map((t) => t.id),
          processedAt: new Date(),
          confirmedAt: stage === "posted" ? new Date() : null,
        })
        .where(eq(captures.id, capture.id))
        .returning();
      await this.audit.record(tx, aiCtx, {
        action: "capture.processed",
        entityType: "capture",
        entityId: capture.id,
        after: {
          stage,
          method: read.method,
          drafts: created.map((t) => t.id),
          posted,
          provider: read.provider,
          model: read.model,
          costUsd: read.costUsd,
        },
      });
      await this.events.publish(tx, ctx, "capture.processed", {
        captureId: capture.id,
        stage,
        method: read.method,
        transactionIds: created.map((t) => t.id),
      });
      return { row: row as CaptureRow, created, posted, stage };
    });

    if (!suggestion) return;
    const purchaseId = outcome.created[drafts.findIndex((d) => d.candidate.index === suggestion.transactionIndex)]?.id ?? null;
    if (outcome.stage === "posted") {
      // Nobody reviewed it: follow the workspace's subscription preference.
      await db.transaction(async (tx) => {
        const decision = ctx.settings.autoCreateDetectedSubscriptions
          ? await this.createSubscription(ctx, outcome.row, suggestion, purchaseId, {}, tx)
          : {
              status: "deferred" as const,
              inboxItemId: await this.subscriptionCandidate(ctx, outcome.row, suggestion, purchaseId, tx),
            };
        await this.recordDecision(tx, capture.id, decision);
      });
    } else {
      await this.jobs.enqueue(
        "ai.capture.followup",
        { captureId: capture.id },
        {
          workspaceId: ctx.workspaceId,
          dedupeKey: `ai.capture.followup:${capture.id}`,
          runAt: new Date(Date.now() + FOLLOW_UP_DELAY_MS),
          maxAttempts: 3,
        },
      );
    }
  }

  private async fail(
    ctx: WorkspaceContext,
    capture: CaptureRow,
    extraction: CaptureExtraction,
    message: string,
    retryable: boolean,
    started: number,
    read: ReadResult | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .update(captures)
        .set({
          stage: "failed",
          error: message.slice(0, 1000),
          provider: read?.provider ?? capture.provider,
          model: read?.model ?? capture.model,
          durationMs: Date.now() - started,
          costUsd: sql`coalesce(${captures.costUsd}, 0) + ${(read?.costUsd ?? 0).toFixed(6)}::numeric`,
          processedAt: new Date(),
          extraction: {
            ...extraction,
            method: null,
            retryable,
            preprocess: read?.preprocess ?? extraction.preprocess ?? null,
            usageIds: [...(extraction.usageIds ?? []), ...(read?.usageIds ?? [])],
          } satisfies CaptureExtraction,
        })
        .where(eq(captures.id, capture.id));
      await this.audit.record(
        tx,
        { ...ctx, actorType: "ai" },
        {
          action: "capture.failed",
          entityType: "capture",
          entityId: capture.id,
          after: { error: message, retryable },
        },
      );
      await this.events.publish(tx, ctx, "capture.processed", {
        captureId: capture.id,
        stage: "failed",
      });
    });
  }

  // ------------------------------------------------------ subscriptions

  private subscriptionInput(
    capture: CaptureRow,
    suggestion: SubscriptionSuggestion,
    purchase: TransactionRow | null,
    overrides: NonNullable<CaptureConfirmInput["subscription"]> | Record<string, never>,
  ): SubscriptionInput | null {
    const o = overrides as Partial<NonNullable<CaptureConfirmInput["subscription"]>>;
    const billingCycle = o.billingCycle ?? suggestion.billingCycle;
    const nextRenewalDate = o.nextRenewalDate ?? suggestion.nextRenewalDate;
    const renewalAmount = o.renewalAmount ?? suggestion.renewalAmount;
    const amount = renewalAmount ?? purchase?.amount ?? null;
    const currency = renewalAmount ? (suggestion.currency ?? purchase?.currency) : (purchase?.currency ?? suggestion.currency);
    if (!billingCycle || !nextRenewalDate || !amount || !currency) return null;
    const startDate = suggestion.startDate ?? suggestion.purchaseDate ?? purchase?.date ?? nextRenewalDate;
    return {
      provider: o.provider ?? suggestion.provider,
      planName: o.planName ?? suggestion.planName,
      amount,
      currency,
      billingCycle,
      intervalCount: 1,
      intervalUnit: billingCycle === "custom" ? "month" : null,
      purchaseDate: suggestion.purchaseDate ?? purchase?.date ?? null,
      startDate: startDate > nextRenewalDate ? nextRenewalDate : startDate,
      expiryDate: o.expiryDate !== undefined ? o.expiryDate : suggestion.expiryDate,
      nextRenewalDate,
      cancellationDeadline: o.cancellationDeadline !== undefined ? o.cancellationDeadline : suggestion.cancellationDeadline,
      autoRenew: o.autoRenew ?? suggestion.autoRenew ?? true,
      accountId: purchase?.accountId ?? null,
      categoryId: purchase?.categoryId ?? null,
      projectId: purchase?.projectId ?? null,
      attachmentFileId: capture.fileId,
      notes: `Detected from a ${capture.kind} capture`,
    };
  }

  /** Creates tracking linked to the posted purchase (never a second expense). Failures are reported, not thrown. */
  private async createSubscription(
    ctx: WorkspaceContext,
    capture: CaptureRow,
    suggestion: SubscriptionSuggestion,
    purchaseId: string | null,
    overrides: NonNullable<CaptureConfirmInput["subscription"]> | Record<string, never>,
    exec: Executor,
  ): Promise<CaptureConfirmResult["subscription"]> {
    const purchase = purchaseId ? await this.transactions.get(ctx, purchaseId, exec) : null;
    const linkable = purchase && purchase.status === "posted" ? purchase : null;
    const input = this.subscriptionInput(capture, suggestion, linkable ?? purchase, overrides);
    if (!input) {
      const inboxItemId = await this.subscriptionCandidate(ctx, capture, suggestion, linkable?.id ?? null, exec);
      return {
        status: "failed",
        message: "The billing cycle or next renewal date is missing",
        inboxItemId,
      };
    }
    try {
      // A savepoint: a subscription problem never undoes the confirmed transactions.
      const created = await (exec as typeof db).transaction((sp) =>
        this.subscriptions.create(ctx, input, {
          exec: sp,
          purchaseTransactionId: linkable?.id ?? null,
        }),
      );
      await this.inbox.resolveByKey(ctx.workspaceId, `capture-subscription:${capture.id}`, ctx.userId, exec);
      return {
        status: "created",
        subscriptionId: created.subscription.id,
        commitmentId: created.commitment.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Subscription from capture ${capture.id} was not created: ${message}`);
      const inboxItemId = await this.subscriptionCandidate(ctx, capture, suggestion, linkable?.id ?? null, exec);
      return { status: "failed", message, inboxItemId };
    }
  }

  /** An AI Inbox item asking whether to track a detected subscription. */
  private subscriptionCandidate(
    ctx: WorkspaceContext,
    capture: CaptureRow,
    suggestion: SubscriptionSuggestion,
    purchaseId: string | null,
    exec: Executor = db,
  ) {
    const renewal = suggestion.nextRenewalDate ? ` · next renewal ${suggestion.renewalDateEstimated ? "around " : ""}${suggestion.nextRenewalDate}` : "";
    return this.inbox.upsert(
      {
        workspaceId: ctx.workspaceId,
        kind: "subscription_candidate",
        severity: "info",
        title: `Track ${suggestion.provider}${suggestion.planName ? ` ${suggestion.planName}` : ""} as a subscription?`,
        body: `${cycleLabel(suggestion.billingCycle)}${renewal}. Detected from a ${capture.kind} capture.`,
        data: {
          captureId: capture.id,
          purchaseTransactionId: purchaseId,
          transactionIds: purchaseId ? [purchaseId] : capture.draftTransactionIds,
          merchant: suggestion.provider,
          amount: suggestion.renewalAmount ?? undefined,
          currency: suggestion.currency ?? undefined,
          cadence: suggestion.billingCycle ?? undefined,
          nextExpected: suggestion.nextRenewalDate,
          subscription: suggestion,
          href: `/capture/${capture.id}`,
        },
        entityType: "capture",
        entityId: capture.id,
        dedupeKey: `capture-subscription:${capture.id}`,
      },
      exec,
    );
  }

  private async recordDecision(exec: Executor, captureId: string, decision: CaptureConfirmResult["subscription"]) {
    const value = decision.status === "none" ? null : decision.status;
    const patch: Partial<CaptureExtraction> = {
      subscriptionDecision: value,
      subscriptionId: decision.status === "created" ? decision.subscriptionId : null,
    };
    await exec
      .update(captures)
      .set({
        extraction: sql`coalesce(${captures.extraction}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(captures.id, captureId));
  }

  /** Job: a suggested capture left undecided for a day puts its subscription suggestion in the AI Inbox. */
  async followUp(captureId: string) {
    const ctx = await this.contextForCapture(captureId);
    if (!ctx) return { skipped: "capture not found" };
    const capture = await this.row(ctx, captureId);
    const extraction = (capture.extraction ?? {}) as CaptureExtraction;
    if (capture.stage !== "suggested" || !extraction.subscription || extraction.subscriptionDecision) return { skipped: "decided" };
    const inboxItemId = await this.subscriptionCandidate(ctx, capture, extraction.subscription, null);
    return { inboxItemId };
  }

  // ------------------------------------------------------------ review

  private async row(ctx: Pick<WorkspaceContext, "workspaceId">, id: string, exec: Executor = db): Promise<CaptureRow> {
    const [row] = await exec
      .select()
      .from(captures)
      .where(and(eq(captures.id, id), eq(captures.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Capture");
  }

  async list(ctx: WorkspaceContext, raw: CaptureListQuery) {
    const query = captureListQuery.parse(raw);
    const where = and(eq(captures.workspaceId, ctx.workspaceId), query.stage?.length ? inArray(captures.stage, query.stage) : undefined);
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(captures)
        .where(where)
        .orderBy(desc(captures.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(captures).where(where),
    ]);
    const items: CaptureListItem[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      stage: row.stage,
      fileId: row.fileId,
      inputText: row.inputText,
      method: ((row.extraction ?? {}) as CaptureExtraction).method ?? null,
      draftCount: row.draftTransactionIds.length,
      isSubscription: row.isSubscription,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
    }));
    return {
      items,
      total: total?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Everything the review screen needs: drafts with confidence, missing fields, duplicates, the subscription card. */
  async view(ctx: WorkspaceContext, id: string): Promise<CaptureView> {
    const capture = await this.row(ctx, id);
    const extraction = (capture.extraction ?? {}) as CaptureExtraction;
    const [file] = capture.fileId
      ? await db
          .select({
            id: files.id,
            filename: files.filename,
            contentType: files.contentType,
            size: files.size,
          })
          .from(files)
          .where(and(eq(files.id, capture.fileId), eq(files.workspaceId, ctx.workspaceId)))
      : [];

    const ids = capture.draftTransactionIds;
    const listed = ids.length
      ? (
          await this.transactions.list(ctx, {
            ids,
            status: ["draft", "pending", "posted", "void"],
            pageSize: 200,
          })
        ).items
      : [];
    const byId = new Map(listed.map((row) => [row.id, row]));
    const rows = ids.map((txId) => byId.get(txId)).filter((row): row is NonNullable<typeof row> => Boolean(row));

    const duplicateIds = [...new Set(rows.flatMap((row) => ((row.metadata as Partial<DraftMetadata>).duplicates ?? []).map((d) => d.transactionId)))];
    const duplicateRows = duplicateIds.length
      ? await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.workspaceId, ctx.workspaceId), inArray(transactions.id, duplicateIds), ne(transactions.status, "void")))
      : [];
    const duplicateById = new Map(duplicateRows.map((row) => [row.id, row]));

    const drafts: CaptureDraftView[] = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Partial<DraftMetadata>;
      return {
        transaction: {
          id: row.id,
          status: row.status,
          type: row.type,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
          baseAmount: row.baseAmount,
          baseCurrency: row.baseCurrency,
          date: row.date,
          occurredAt: row.occurredAt?.toISOString() ?? null,
          merchant: row.merchant,
          counterpartyId: row.counterpartyId,
          description: row.description,
          reference: row.reference,
          accountId: row.accountId,
          accountName: row.accountName,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          projectId: row.projectId,
          projectName: row.projectName,
          reviewReason: row.reviewReason,
        },
        confidence: row.aiConfidence ?? null,
        missing: meta.review?.missing ?? [],
        lowConfidence: meta.review?.lowConfidence ?? [],
        suggestions: meta.suggestions ?? {
          category: null,
          project: null,
          account: null,
          accountCandidates: [],
          unmatchedCategoryName: null,
          unmatchedProjectName: null,
        },
        extracted: {
          paymentMethod: meta.extracted?.paymentMethod ?? null,
          fee: meta.extracted?.fee ?? null,
          lineItems: meta.extracted?.lineItems ?? [],
          notes: meta.extracted?.notes ?? [],
          ruleIds: meta.ruleIds ?? [],
        },
        duplicates: (meta.duplicates ?? []).flatMap((d) => {
          const match = duplicateById.get(d.transactionId);
          if (!match || ids.includes(match.id)) return [];
          return [
            {
              transactionId: d.transactionId,
              score: d.score,
              exact: d.exact,
              reasons: d.reasons,
              transaction: {
                id: match.id,
                status: match.status,
                type: match.type,
                date: match.date,
                amount: match.amount,
                currency: match.currency,
                merchant: match.merchant,
                reference: match.reference,
                accountId: match.accountId,
                source: match.source,
              },
            },
          ];
        }),
        suggestedWorkspace: meta.suggestedWorkspace ?? null,
        subscription: meta.subscription ?? null,
      };
    });

    const suggestion = extraction.subscription ?? null;
    const purchaseIndex = suggestion ? rows.findIndex((row) => (row.metadata as Partial<DraftMetadata>).captureIndex === suggestion.transactionIndex) : -1;
    return {
      capture: {
        id: capture.id,
        kind: capture.kind,
        stage: capture.stage,
        fileId: capture.fileId,
        fileUrl: capture.fileId ? `/api/files/${capture.fileId}` : null,
        file: file ?? null,
        inputText: capture.inputText,
        method: extraction.method ?? null,
        provider: capture.provider,
        model: capture.model,
        fallbackReason: extraction.fallbackReason ?? null,
        error: capture.error,
        retryable: capture.stage === "failed" ? extraction.retryable !== false : Boolean(extraction.retryable),
        durationMs: capture.durationMs,
        costUsd: Number(capture.costUsd ?? 0),
        isSubscription: capture.isSubscription,
        notes: extraction.notes ?? [],
        createdAt: capture.createdAt.toISOString(),
        processedAt: capture.processedAt?.toISOString() ?? null,
        confirmedAt: capture.confirmedAt?.toISOString() ?? null,
      },
      duplicateOf: extraction.upload?.duplicateOf ?? null,
      drafts,
      unresolved: extraction.unresolved ?? [],
      subscription: suggestion ? { ...suggestion, transactionIndex: Math.max(0, purchaseIndex) } : null,
      postedTransactionIds: rows.filter((row) => row.status === "posted").map((row) => row.id),
    };
  }

  /**
   * Posts what the person reviewed. Edited values win; drafts left out are
   * discarded; duplicates are checked again right now; a detected
   * subscription is linked to the posted expense rather than recorded twice.
   */
  async confirm(ctx: WorkspaceContext, id: string, raw: CaptureConfirmInput): Promise<CaptureConfirmResult> {
    const input = captureConfirmInput.parse(raw);
    const capture = await this.row(ctx, id);
    if (capture.stage !== "suggested" && capture.stage !== "failed") {
      throw conflict(
        capture.stage === "processing" || capture.stage === "received" ? "This capture is still being read" : `This capture is already ${capture.stage}`,
        "capture_not_reviewable",
      );
    }
    const extraction = (capture.extraction ?? {}) as CaptureExtraction;
    const draftIds = new Set(capture.draftTransactionIds);
    const listedIds = input.transactions.map((t) => t.id).filter((value): value is string => Boolean(value));
    for (const txId of listedIds) if (!draftIds.has(txId)) throw badRequest("A transaction in the request is not part of this capture", "not_in_capture");
    if (new Set(listedIds).size !== listedIds.length) throw badRequest("A transaction is listed twice", "duplicate_item");

    // Duplicates are checked again at confirmation: the books may have changed since the draft was made.
    if (!input.allowDuplicates) {
      const conflicts: Array<{
        index: number;
        matches: Array<{
          transactionId: string;
          score: number;
          exact: boolean;
          reasons: string[];
          date: string;
          amount: number;
          currency: string;
          merchant: string | null;
        }>;
      }> = [];
      for (const [index, item] of input.transactions.entries()) {
        const matches = (
          await this.transactions.findDuplicates(ctx, {
            id: item.id,
            date: item.date,
            amount: item.amount,
            currency: item.currency,
            merchant: item.merchant ?? null,
            accountId: item.accountId,
            reference: item.reference ?? null,
          })
        ).filter((match) => !draftIds.has(match.id));
        if (matches.length) {
          conflicts.push({
            index,
            matches: matches.slice(0, 5).map((m) => ({
              transactionId: m.id,
              score: m.score,
              exact: m.exact,
              reasons: m.reasons,
              date: m.transaction.date,
              amount: m.transaction.amount,
              currency: m.transaction.currency,
              merchant: m.transaction.merchant,
            })),
          });
        }
      }
      if (conflicts.length) {
        throw conflict(
          "This looks like a transaction that is already recorded. Confirm again with allowDuplicates to post it anyway.",
          "possible_duplicate",
          conflicts,
        );
      }
    }

    const suggestion = extraction.subscription ?? null;
    const result = await db.transaction(async (tx) => {
      const posted: string[] = [];
      const indexOf = new Map<string, number>();
      for (const item of input.transactions) {
        const { id: itemId, ...fields } = item;
        const changes = {
          type: fields.type,
          direction: fields.direction,
          accountId: fields.accountId,
          toAccountId: fields.toAccountId ?? null,
          amount: fields.amount,
          currency: fields.currency,
          accountAmount: fields.accountAmount ?? null,
          toAccountAmount: fields.toAccountAmount ?? null,
          date: fields.date,
          merchant: fields.merchant ?? null,
          categoryId: fields.categoryId ?? null,
          projectId: fields.projectId ?? null,
          description: fields.description ?? null,
          reference: fields.reference ?? null,
          notes: fields.notes ?? null,
        };
        if (!itemId) {
          // Entered by hand from the file (the model could not read it).
          const { transaction } = await this.transactions.create(
            ctx,
            {
              ...changes,
              status: "posted",
              attachmentFileIds: capture.fileId ? [capture.fileId] : undefined,
            },
            {
              exec: tx,
              source: SOURCE_FOR[capture.kind],
              sourceRef: capture.id,
              metadata: { captureId: capture.id, manual: true },
              skipLearning: !input.rememberMerchant,
            },
          );
          posted.push(transaction.id);
          continue;
        }
        const before = await this.transactions.get(ctx, itemId, tx);
        indexOf.set(itemId, ((before.metadata ?? {}) as Partial<DraftMetadata>).captureIndex ?? -1);
        if (before.status === "posted") {
          posted.push(itemId);
          continue;
        }
        if (before.status === "void") throw conflict("A transaction in this capture was deleted", "transaction_void");
        const merchantChanged = (changes.merchant ?? null) !== (before.merchant ?? null);
        const memory = input.rememberMerchant
          ? null
          : await this.memorySnapshot(tx, ctx, merchantChanged ? changes.merchant : before.merchant, merchantChanged ? null : before.counterpartyId);
        const row = await this.transactions.confirm(
          ctx,
          itemId,
          {
            ...changes,
            ...(merchantChanged ? { counterpartyId: null } : {}),
            reason: "Confirmed from capture",
          },
          { exec: tx },
        );
        // Confirming teaches merchant memory; "don't remember" puts it back as it was.
        if (memory && row.counterpartyId) await this.restoreMemory(tx, row.counterpartyId, memory);
        posted.push(itemId);
      }

      const discarded: string[] = [];
      for (const draftId of capture.draftTransactionIds) {
        if (listedIds.includes(draftId)) continue;
        const [existing] = await tx
          .select({ status: transactions.status })
          .from(transactions)
          .where(and(eq(transactions.id, draftId), eq(transactions.workspaceId, ctx.workspaceId)));
        if (existing && (existing.status === "draft" || existing.status === "pending")) {
          await this.transactions.void(ctx, draftId, "Discarded at capture review", { exec: tx });
          discarded.push(draftId);
        }
      }

      const [updated] = await tx
        .update(captures)
        .set({
          stage: "confirmed",
          confirmedAt: new Date(),
          draftTransactionIds: [...listedIds, ...posted.filter((p) => !listedIds.includes(p))],
          extraction: sql`coalesce(${captures.extraction}, '{}'::jsonb) || ${JSON.stringify({ postedTransactionIds: posted })}::jsonb`,
        })
        .where(eq(captures.id, capture.id))
        .returning();
      const confirmed = updated as CaptureRow;

      // The subscription question: create, decline, or leave it for the AI Inbox.
      let subscription: CaptureConfirmResult["subscription"] = {
        status: "none",
      };
      const purchaseId =
        (suggestion ? [...indexOf.entries()].find(([, index]) => index === suggestion.transactionIndex)?.[0] : undefined) ??
        posted.find((p) => listedIds.includes(p)) ??
        posted[0] ??
        null;
      if (input.subscription) {
        const details: SubscriptionSuggestion = suggestion ?? {
          provider: input.subscription.provider,
          planName: null,
          billingCycle: null,
          purchaseDate: null,
          startDate: null,
          nextRenewalDate: null,
          renewalDateEstimated: false,
          expiryDate: null,
          cancellationDeadline: null,
          autoRenew: null,
          renewalAmount: null,
          currency: null,
          confidence: 1,
          source: "heuristic",
          transactionIndex: 0,
        };
        subscription = await this.createSubscription(ctx, confirmed, details, purchaseId, input.subscription, tx);
      } else if (input.subscription === null) {
        subscription = { status: "declined" };
        await this.inbox.resolveByKey(ctx.workspaceId, `capture-subscription:${capture.id}`, ctx.userId, tx);
      } else if (suggestion) {
        subscription = ctx.settings.autoCreateDetectedSubscriptions
          ? await this.createSubscription(ctx, confirmed, suggestion, purchaseId, {}, tx)
          : {
              status: "deferred",
              inboxItemId: await this.subscriptionCandidate(ctx, confirmed, suggestion, purchaseId, tx),
            };
      }
      await this.recordDecision(tx, capture.id, subscription);

      await this.audit.record(tx, ctx, {
        action: "capture.confirmed",
        entityType: "capture",
        entityId: capture.id,
        after: {
          posted,
          discarded,
          subscription: subscription.status,
          rememberMerchant: input.rememberMerchant,
        },
      });
      return { posted, discarded, subscription };
    });

    return {
      capture: await this.view(ctx, id),
      postedTransactionIds: result.posted,
      discardedTransactionIds: result.discarded,
      subscription: result.subscription,
    };
  }

  /** The merchant-memory fields of the counterparty a confirmation will touch, to put back afterwards. */
  private async memorySnapshot(exec: Executor, ctx: WorkspaceContext, merchant: string | null | undefined, counterpartyId: string | null) {
    const row = counterpartyId
      ? (
          await exec
            .select()
            .from(counterparties)
            .where(and(eq(counterparties.id, counterpartyId), eq(counterparties.workspaceId, ctx.workspaceId)))
        )[0]
      : merchant
        ? await this.counterparties.match(exec, ctx.workspaceId, merchant)
        : null;
    return {
      id: row?.id ?? null,
      defaultCategoryId: row?.defaultCategoryId ?? null,
      defaultProjectId: row?.defaultProjectId ?? null,
      confirmations: row?.confirmations ?? 0,
    };
  }

  private async restoreMemory(
    exec: Executor,
    counterpartyId: string,
    memory: {
      id: string | null;
      defaultCategoryId: string | null;
      defaultProjectId: string | null;
      confirmations: number;
    },
  ) {
    const known = memory.id === counterpartyId;
    await exec
      .update(counterparties)
      .set({
        defaultCategoryId: known ? memory.defaultCategoryId : null,
        defaultProjectId: known ? memory.defaultProjectId : null,
        confirmations: known ? memory.confirmations : 0,
      })
      .where(eq(counterparties.id, counterpartyId));
  }

  /** Throws the capture away: its drafts are removed; nothing posted is touched. */
  async discard(ctx: WorkspaceContext, id: string): Promise<CaptureView> {
    const capture = await this.row(ctx, id);
    if (capture.stage === "discarded") return this.view(ctx, id);
    if (capture.stage === "confirmed" || capture.stage === "posted") {
      throw conflict("Posted captures cannot be discarded; void their transactions instead", "capture_posted");
    }
    await db.transaction(async (tx) => {
      const voided: string[] = [];
      for (const draftId of capture.draftTransactionIds) {
        const [existing] = await tx
          .select({ status: transactions.status })
          .from(transactions)
          .where(and(eq(transactions.id, draftId), eq(transactions.workspaceId, ctx.workspaceId)));
        if (existing && (existing.status === "draft" || existing.status === "pending")) {
          await this.transactions.void(ctx, draftId, "Capture discarded", {
            exec: tx,
          });
          voided.push(draftId);
        }
      }
      await tx
        .update(captures)
        .set({
          stage: "discarded",
          extraction: sql`coalesce(${captures.extraction}, '{}'::jsonb) || '{"subscriptionDecision":"declined"}'::jsonb`,
        })
        .where(eq(captures.id, capture.id));
      await this.inbox.resolveByKey(ctx.workspaceId, `capture-subscription:${capture.id}`, ctx.userId, tx);
      await this.audit.record(tx, ctx, {
        action: "capture.discarded",
        entityType: "capture",
        entityId: capture.id,
        before: { stage: capture.stage },
        after: { voided },
      });
    });
    return this.view(ctx, id);
  }

  /** Reads the capture again: its drafts are removed and it is processed from scratch. */
  async retry(ctx: WorkspaceContext, id: string, raw: z.input<typeof captureRetryInput> = {}): Promise<CaptureView> {
    const input = captureRetryInput.parse(raw);
    const capture = await this.row(ctx, id);
    const extraction = (capture.extraction ?? {}) as CaptureExtraction;
    if (capture.stage === "confirmed" || capture.stage === "posted" || capture.stage === "discarded") {
      throw conflict(`A ${capture.stage} capture cannot be processed again`, "capture_not_retryable");
    }
    if (capture.stage === "processing") {
      const startedAt = extraction.startedAt ? new Date(extraction.startedAt).getTime() : capture.createdAt.getTime();
      if (Date.now() - startedAt < STALE_PROCESSING_MINUTES * 60_000) throw conflict("This capture is still being read", "capture_processing");
    }
    await db.transaction(async (tx) => {
      for (const draftId of capture.draftTransactionIds) {
        const [existing] = await tx
          .select({ status: transactions.status })
          .from(transactions)
          .where(and(eq(transactions.id, draftId), eq(transactions.workspaceId, ctx.workspaceId)));
        if (existing && (existing.status === "draft" || existing.status === "pending"))
          await this.transactions.void(ctx, draftId, "Capture processed again", { exec: tx });
      }
      const reset: CaptureExtraction = {
        version: 1,
        upload: extraction.upload
          ? {
              ...extraction.upload,
              force: extraction.upload.force || input.force,
            }
          : undefined,
        usageIds: extraction.usageIds ?? [],
      };
      await tx
        .update(captures)
        .set({
          stage: "received",
          error: null,
          draftTransactionIds: [],
          isSubscription: false,
          processedAt: null,
          extraction: reset,
        })
        .where(eq(captures.id, capture.id));
      await this.audit.record(tx, ctx, {
        action: "capture.retried",
        entityType: "capture",
        entityId: capture.id,
        before: { stage: capture.stage },
        after: { force: input.force },
      });
      await this.jobs.enqueue(
        "ai.capture",
        { captureId: capture.id },
        {
          workspaceId: ctx.workspaceId,
          dedupeKey: `ai.capture:${capture.id}`,
          runAt: new Date(Date.now() + (input.background ? 0 : SAFETY_JOB_DELAY_MS)),
        },
        tx,
      );
    });
    if (!input.background) await this.runInline(ctx, id);
    return this.view(ctx, id);
  }
}

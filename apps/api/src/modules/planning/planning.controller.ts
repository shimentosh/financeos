import {
  budgetInput,
  budgetUpdate,
  commitmentInput,
  commitmentUpdate,
  goalContributionInput,
  goalInput,
  goalUpdate,
  skipOccurrenceInput,
  subscriptionUpdate,
} from "@financeos/core";
import {
  type AnnualCommitmentsQuery,
  annualCommitmentsQuery,
  type BudgetDetailQuery,
  type BudgetQuery,
  budgetDetailQuery,
  budgetQuery,
  type CalendarQuery,
  type CommitmentQuery,
  calendarQuery,
  commitmentQuery,
  type GoalQuery,
  goalQuery,
  type MarkPaidRequest,
  markPaidRequest,
  type PaymentMatchQuery,
  paymentMatchQuery,
  type SubscriptionCancelInput,
  type SubscriptionCreateRequest,
  type SubscriptionQuery,
  subscriptionCancelInput,
  subscriptionCreateRequest,
  subscriptionQuery,
  type UndoPaymentInput,
  type UpcomingQuery,
  undoPaymentInput,
  upcomingQuery,
} from "@financeos/core/contracts/planning-extra";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { Ctx, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { BudgetsService } from "./budgets.service.js";
import { PlanningCalendarService } from "./calendar.service.js";
import { CommitmentsService } from "./commitments.service.js";
import { GoalsService } from "./goals.service.js";
import { OccurrencesService } from "./occurrences.service.js";
import { SubscriptionsService } from "./subscriptions.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });

@Controller("commitments")
@WorkspaceScoped()
export class CommitmentsController {
  constructor(
    @Inject(CommitmentsService) private readonly service: CommitmentsService,
    @Inject(PlanningCalendarService) private readonly calendar: PlanningCalendarService,
    @Inject(OccurrencesService) private readonly occurrences: OccurrencesService,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(commitmentQuery)) query: CommitmentQuery) {
    return this.service.list(ctx, query);
  }

  @Get("upcoming")
  upcoming(@Ctx() ctx: WorkspaceContext, @Query(zod(upcomingQuery)) query: UpcomingQuery) {
    return this.calendar.upcoming(ctx, query);
  }

  @Get("calendar")
  schedule(@Ctx() ctx: WorkspaceContext, @Query(zod(calendarQuery)) query: CalendarQuery) {
    return this.calendar.calendar(ctx, query);
  }

  @Get("annual")
  annual(@Ctx() ctx: WorkspaceContext, @Query(zod(annualCommitmentsQuery)) query: AnnualCommitmentsQuery) {
    return this.calendar.annual(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  async create(@Ctx() ctx: WorkspaceContext, @Body(zod(commitmentInput)) input: z.input<typeof commitmentInput>) {
    const row = await this.service.create(ctx, input);
    return this.service.detail(ctx, row.id);
  }

  @Patch(":id")
  async update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(commitmentUpdate)) input: z.input<typeof commitmentUpdate>) {
    await this.service.update(ctx, id, input);
    return this.service.detail(ctx, id);
  }

  @Post(":id/pause")
  @HttpCode(200)
  async pause(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    await this.service.pause(ctx, id);
    return this.service.detail(ctx, id);
  }

  @Post(":id/resume")
  @HttpCode(200)
  async resume(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    await this.service.resume(ctx, id);
    return this.service.detail(ctx, id);
  }

  @Post(":id/end")
  @HttpCode(200)
  async end(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    await this.service.end(ctx, id);
    return this.service.detail(ctx, id);
  }

  /** Records the next unsettled payment of this commitment. */
  @Post(":id/pay")
  @HttpCode(200)
  pay(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(markPaidRequest)) input: MarkPaidRequest) {
    return this.occurrences.payNext(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }
}

@Controller("occurrences")
@WorkspaceScoped()
export class OccurrencesController {
  constructor(@Inject(OccurrencesService) private readonly service: OccurrencesService) {}

  /** Existing transactions that may already be this payment ("Link existing"). */
  @Get(":id/matches")
  matches(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(paymentMatchQuery)) query: PaymentMatchQuery) {
    return this.service.candidates(ctx, id, query);
  }

  @Post(":id/pay")
  @HttpCode(200)
  pay(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(markPaidRequest)) input: MarkPaidRequest) {
    return this.service.markPaid(ctx, id, input);
  }

  @Post(":id/skip")
  @HttpCode(200)
  skip(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(skipOccurrenceInput)) input: z.input<typeof skipOccurrenceInput>) {
    return this.service.skip(ctx, id, input);
  }

  @Post(":id/undo")
  @HttpCode(200)
  undo(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(undoPaymentInput)) input: UndoPaymentInput) {
    return this.service.undo(ctx, id, input);
  }
}

@Controller("subscriptions")
@WorkspaceScoped()
export class SubscriptionsController {
  constructor(
    @Inject(SubscriptionsService) private readonly service: SubscriptionsService,
    @Inject(OccurrencesService) private readonly occurrences: OccurrencesService,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(subscriptionQuery)) query: SubscriptionQuery) {
    return this.service.list(ctx, query);
  }

  @Get("analytics")
  analytics(@Ctx() ctx: WorkspaceContext) {
    return this.service.analytics(ctx);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  async create(@Ctx() ctx: WorkspaceContext, @Body(zod(subscriptionCreateRequest)) input: SubscriptionCreateRequest) {
    const { purchaseTransactionId, ...subscription } = input;
    const created = await this.service.create(ctx, subscription, { purchaseTransactionId });
    return this.service.detail(ctx, created.subscription.id);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(subscriptionUpdate)) input: z.input<typeof subscriptionUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(subscriptionCancelInput)) input: SubscriptionCancelInput) {
    return this.service.cancel(ctx, id, input);
  }

  @Post(":id/pause")
  @HttpCode(200)
  pause(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.pause(ctx, id);
  }

  @Post(":id/resume")
  @HttpCode(200)
  resume(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.resume(ctx, id);
  }

  /** Records the next renewal payment. */
  @Post(":id/pay")
  @HttpCode(200)
  async pay(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(markPaidRequest)) input: MarkPaidRequest) {
    const subscription = await this.service.get(ctx, id);
    return this.occurrences.payNext(ctx, subscription.commitmentId, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }
}

@Controller("budgets")
@WorkspaceScoped()
export class BudgetsController {
  constructor(@Inject(BudgetsService) private readonly service: BudgetsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(budgetQuery)) query: BudgetQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(budgetDetailQuery)) query: BudgetDetailQuery) {
    return this.service.detail(ctx, id, query);
  }

  @Post()
  async create(@Ctx() ctx: WorkspaceContext, @Body(zod(budgetInput)) input: z.input<typeof budgetInput>) {
    const row = await this.service.create(ctx, input);
    return this.service.detail(ctx, row.id);
  }

  @Patch(":id")
  async update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(budgetUpdate)) input: z.input<typeof budgetUpdate>) {
    await this.service.update(ctx, id, input);
    return this.service.detail(ctx, id);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }
}

@Controller("goals")
@WorkspaceScoped()
export class GoalsController {
  constructor(@Inject(GoalsService) private readonly service: GoalsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(goalQuery)) query: GoalQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(goalInput)) input: z.input<typeof goalInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(goalUpdate)) input: z.input<typeof goalUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }

  @Post(":id/contributions")
  addContribution(
    @Ctx() ctx: WorkspaceContext,
    @Param("id", uuidParam) id: string,
    @Body(zod(goalContributionInput)) input: z.input<typeof goalContributionInput>,
  ) {
    return this.service.addContribution(ctx, id, input);
  }

  @Delete(":id/contributions/:contributionId")
  removeContribution(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Param("contributionId", uuidParam) contributionId: string) {
    return this.service.removeContribution(ctx, id, contributionId);
  }
}

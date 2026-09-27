import {
  type AccountInput,
  accountInput,
  accountUpdate,
  bulkTransactionAction,
  categoryInput,
  categoryUpdate,
  counterpartyInput,
  exchangeRateInput,
  projectInput,
  projectUpdate,
  reconcileInput,
  ruleInput,
  type TransactionInput,
  type TransactionQuery,
  type TransactionUpdate,
  transactionInput,
  transactionQuery,
  transactionUpdate,
} from "@expensewise/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { Ctx, RequireManage, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { AccountsService } from "./accounts.service.js";
import { CategoriesService, CounterpartiesService, ProjectsService, RulesService } from "./catalog.service.js";
import { FxService } from "./fx.service.js";
import { TransactionsService } from "./transactions.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });
const voidBody = z.object({ reason: z.string().max(200).optional() });

@Controller("transactions")
@WorkspaceScoped()
export class TransactionsController {
  constructor(@Inject(TransactionsService) private readonly service: TransactionsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(transactionQuery)) query: TransactionQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  async create(@Ctx() ctx: WorkspaceContext, @Body(zod(transactionInput)) input: TransactionInput) {
    return (await this.service.create(ctx, input)).transaction;
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(transactionUpdate)) input: TransactionUpdate) {
    return this.service.update(ctx, id, input);
  }

  @Post(":id/confirm")
  confirm(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(transactionUpdate)) input: TransactionUpdate) {
    return this.service.confirm(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(voidBody)) body: z.infer<typeof voidBody>) {
    return this.service.void(ctx, id, body.reason);
  }

  @Post("bulk")
  @HttpCode(200)
  bulk(@Ctx() ctx: WorkspaceContext, @Body(zod(bulkTransactionAction)) input: z.input<typeof bulkTransactionAction>) {
    return this.service.bulk(ctx, input);
  }

  @Get(":id/duplicates")
  async duplicates(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    const row = await this.service.get(ctx, id);
    return this.service.findDuplicates(ctx, row);
  }
}

@Controller("accounts")
@WorkspaceScoped()
export class AccountsController {
  constructor(
    @Inject(AccountsService) private readonly service: AccountsService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query("includeArchived") includeArchived?: string) {
    return this.service.list(ctx, { includeArchived: includeArchived === "true" });
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(accountInput)) input: AccountInput) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(accountUpdate)) input: z.input<typeof accountUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }

  @Post(":id/reconcile")
  @HttpCode(200)
  async reconcile(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(reconcileInput)) input: z.output<typeof reconcileInput>) {
    const account = await this.service.get(ctx, id);
    return this.service.reconcile(ctx, id, input, async (amount, direction) => {
      const { transaction } = await this.transactions.create(ctx, {
        type: "adjustment",
        direction,
        accountId: id,
        amount,
        currency: account.currency,
        date: input.asOf,
        description: "Reconciliation adjustment",
      });
      return transaction.id;
    });
  }
}

@Controller("categories")
@WorkspaceScoped()
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly service: CategoriesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query("includeArchived") includeArchived?: string) {
    return this.service.list(ctx, { includeArchived: includeArchived === "true" });
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(categoryInput)) input: z.input<typeof categoryInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(categoryUpdate)) input: z.input<typeof categoryUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }
}

@Controller("counterparties")
@WorkspaceScoped()
export class CounterpartiesController {
  constructor(@Inject(CounterpartiesService) private readonly service: CounterpartiesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query("q") q?: string) {
    return this.service.list(ctx, { q });
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(counterpartyInput)) input: z.input<typeof counterpartyInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(
    @Ctx() ctx: WorkspaceContext,
    @Param("id", uuidParam) id: string,
    @Body(zod(counterpartyInput.partial())) input: Partial<z.input<typeof counterpartyInput>>,
  ) {
    return this.service.update(ctx, id, input);
  }
}

@Controller("projects")
@WorkspaceScoped()
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly service: ProjectsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query("includeArchived") includeArchived?: string) {
    return this.service.list(ctx, { includeArchived: includeArchived === "true" });
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(projectInput)) input: z.input<typeof projectInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(projectUpdate)) input: z.input<typeof projectUpdate>) {
    return this.service.update(ctx, id, input);
  }
}

@Controller("rules")
@WorkspaceScoped()
export class RulesController {
  constructor(@Inject(RulesService) private readonly service: RulesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(ruleInput)) input: z.input<typeof ruleInput>) {
    return this.service.create(ctx, input);
  }

  @Put(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(ruleInput.partial())) input: Partial<z.input<typeof ruleInput>>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }

  /** Dry run: which rules would fire for this record. */
  @Post("test")
  @HttpCode(200)
  test(
    @Ctx() ctx: WorkspaceContext,
    @Body(
      zod(
        z.object({
          merchant: z.string().optional(),
          description: z.string().optional(),
          amount: z.number().int().optional(),
          currency: z.string().optional(),
          accountId: z.string().optional(),
          source: z.string().optional(),
        }),
      ),
    )
    subject: { merchant?: string; description?: string; amount?: number; currency?: string; accountId?: string; source?: string },
  ) {
    return this.service.evaluate(ctx, subject);
  }
}

@Controller("exchange-rates")
@WorkspaceScoped()
export class ExchangeRatesController {
  constructor(@Inject(FxService) private readonly service: FxService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx);
  }

  @Post()
  @RequireManage()
  upsert(@Ctx() ctx: WorkspaceContext, @Body(zod(exchangeRateInput)) input: z.output<typeof exchangeRateInput>) {
    return this.service.upsert(ctx, input);
  }

  @Delete(":id")
  @RequireManage()
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.remove(ctx, id);
  }

  @Get("convert")
  async convert(
    @Ctx() ctx: WorkspaceContext,
    @Query("amount") amount: string,
    @Query("from") from: string,
    @Query("to") to: string,
    @Query("date") date: string,
  ) {
    return this.service.convert(Number(amount), from, to ?? ctx.baseCurrency, date, ctx.workspaceId);
  }
}

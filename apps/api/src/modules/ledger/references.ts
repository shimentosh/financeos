import { and, eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { badRequest } from "../../common/errors.js";
import type { Executor } from "../../db/index.js";

type ScopedTable = PgTable & { id: PgColumn; workspaceId: PgColumn };

/**
 * Proves that ids supplied by a request belong to the caller's workspace.
 * Without this a crafted request could attach a category, account or project
 * from someone else's workspace to a transaction.
 */
export async function assertInWorkspace(
  exec: Executor,
  table: ScopedTable,
  workspaceId: string,
  ids: Array<string | null | undefined>,
  entity: string,
): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return;
  const rows = await exec
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), inArray(table.id, wanted)));
  if (rows.length !== wanted.length) throw badRequest(`${entity} not found in this workspace`, "invalid_reference");
}

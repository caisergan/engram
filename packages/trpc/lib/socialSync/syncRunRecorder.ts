import { and, eq, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type { DB } from "@karakeep/db";
import { socialSyncRuns } from "@karakeep/db/schema";
import logger from "@karakeep/shared/logger";

export type SyncTrigger = "manual" | "scheduled";
export type SyncPhase = "fetching" | "importing" | "finalizing";

/**
 * Owns all writes to `socialSyncRuns`. Best-effort: every method swallows its
 * own errors so run-tracking can never break the actual sync. `start()` returns
 * a no-op recorder (runId = null) if the initial insert fails.
 */
export class SyncRunRecorder {
  private constructor(
    private readonly db: DB,
    readonly runId: string | null,
  ) {}

  static async start(args: {
    db: DB;
    connectionId: string;
    trigger: SyncTrigger;
    jobId?: string;
  }): Promise<SyncRunRecorder> {
    try {
      const [row] = await args.db
        .insert(socialSyncRuns)
        .values({
          connectionId: args.connectionId,
          trigger: args.trigger,
          jobId: args.jobId ?? null,
          status: "running",
          phase: "fetching",
          startedAt: new Date(),
        })
        .returning({ id: socialSyncRuns.id });
      return new SyncRunRecorder(args.db, row?.id ?? null);
    } catch (e) {
      logger.error(`[social-sync] Failed to create run record: ${e}`);
      return new SyncRunRecorder(args.db, null);
    }
  }

  private async patch(values: Partial<typeof socialSyncRuns.$inferInsert>) {
    if (!this.runId) return;
    try {
      await this.db
        .update(socialSyncRuns)
        .set(values)
        .where(eq(socialSyncRuns.id, this.runId));
    } catch (e) {
      logger.warn(`[social-sync] Failed to update run ${this.runId}: ${e}`);
    }
  }

  private async bump(column: AnySQLiteColumn) {
    if (!this.runId) return;
    try {
      await this.db
        .update(socialSyncRuns)
        .set({ [column.name]: sql`${column} + 1` } as Record<string, SQL>)
        .where(eq(socialSyncRuns.id, this.runId));
    } catch (e) {
      logger.warn(`[social-sync] Failed to bump run ${this.runId}: ${e}`);
    }
  }

  async setPhase(phase: SyncPhase) {
    await this.patch({ phase });
  }

  async setItemsFound(n: number) {
    await this.patch({ itemsFound: n });
  }

  async incrementPages() {
    await this.bump(socialSyncRuns.pagesScanned);
  }

  async incrementImported() {
    await this.bump(socialSyncRuns.itemsImported);
  }

  async incrementFailed() {
    await this.bump(socialSyncRuns.itemsFailed);
  }

  async finishSuccess() {
    await this.patch({
      status: "success",
      phase: null,
      finishedAt: new Date(),
    });
  }

  async finishFailure(error: string) {
    await this.patch({
      status: "failure",
      phase: null,
      error: error.slice(0, 2000),
      finishedAt: new Date(),
    });
  }
}

/**
 * Fail any run still `running` that started before `olderThan`. Covers a hard
 * process hang where the worker's own catch never runs. Best-effort.
 */
export async function sweepStaleRuns(db: DB, olderThan: Date): Promise<void> {
  try {
    await db
      .update(socialSyncRuns)
      .set({
        status: "failure",
        phase: null,
        error: "Run timed out",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(socialSyncRuns.status, "running"),
          lt(socialSyncRuns.startedAt, olderThan),
        ),
      );
  } catch (e) {
    logger.error(`[social-sync] sweepStaleRuns failed: ${e}`);
  }
}

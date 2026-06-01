# Social Sync Run Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every social-sync worker run in a new `socialSyncRuns` table, update it live during the run, and surface a per-connection progress bar + recent-runs list in the web settings UI.

**Architecture:** Additive observability layer on top of the (already-fixed) liteque queue. The worker creates a run row on start and updates counters as it fetches/imports; a cron sweep fails hung rows; the tRPC `socialSync` router exposes the active run (embedded in `getConnections`) and a `getRuns` history query; two small React components render them. No queue-core changes.

**Tech Stack:** Drizzle ORM (SQLite/better-sqlite3), tRPC, Zod, Vitest, Next.js + React, `@tanstack/react-query`, Tailwind.

**Spec:** `docs/superpowers/specs/2026-05-31-social-sync-tracking-design.md`

---

## Baseline (before Task 1)

The working tree currently contains Codex's **uncommitted** queue reliability fix (the `LitequeRunner` rewrite in `packages/plugins/queue-liteque/src/index.ts`, the `validator`/`abortSignal` additions in `apps/workers/workers/socialSyncWorker.ts`, new queue tests under `packages/plugins/queue-liteque/src/tests/`, etc.). This feature builds directly on that fix.

**Execution preamble (do once, before Task 1):** Verify the baseline is green, then commit it as a clean base so the tracking commits are isolated.

```bash
pnpm -F @karakeep/plugins exec vitest run      # Codex's queue tests must pass
pnpm typecheck                                 # whole-repo typecheck must pass
git add apps/workers packages/plugins packages/trpc/lib/socialSync packages/shared/types/socialSync.ts docs/social-sync-worker-bug-report.md docs/social-sync-worker-reliability-fix-report.md
git commit -m "fix(social-sync): reliable liteque runner + self-healing dequeue loop"
```

If the queue tests fail, STOP and report — do not build tracking on a broken base.

---

## File Structure

**New files:**
- `packages/trpc/lib/socialSync/syncRunRecorder.ts` — `SyncRunRecorder` class (lifecycle + counter writes) and `sweepStaleRuns()` function. Owns ALL writes to `socialSyncRuns`. Takes a `db` instance (dependency-injected) so it is unit-testable.
- `apps/web/components/settings/SocialSyncProgress.tsx` — renders the active run's progress bar.
- `apps/web/components/settings/SocialSyncRunHistory.tsx` — collapsible recent-runs list.

**Modified files:**
- `packages/db/schema.ts` — new `socialSyncRuns` table + relations.
- `packages/db/index.ts` — export `DB` type (if not already exported).
- `packages/db/drizzle/00XX_add_social_sync_runs.sql` — generated migration.
- `packages/trpc/lib/socialSync/syncEngine.ts` — additive `onPage` hook.
- `packages/shared-server/src/queues.ts` — `trigger` field on the request schema.
- `apps/workers/workers/socialSyncWorker.ts` — recorder wiring, failed-count, `trigger`, cron sweep.
- `packages/trpc/routers/socialSync.ts` — `activeRun` on `getConnections`, new `getRuns`, `trigger` on enqueues.
- `packages/trpc/routers/socialSync.test.ts` — new describe blocks (recorder, sweep, getRuns, activeRun).
- `packages/trpc/lib/socialSync/syncEngine.test.ts` — `onPage` test (create if missing).
- `apps/web/components/settings/SocialSyncSettings.tsx` — wire components + poll-while-active + badges.
- `apps/web/lib/i18n/locales/en/translation.json` — new `social_sync.*` keys.

---

## Conventions (read before starting)

- **Run tests for one package:** `pnpm -F @karakeep/<pkg> exec vitest run <relative/path/to/file>` (paths are relative to the package root, e.g. `packages/trpc`).
- **Typecheck everything:** `pnpm typecheck`. **Lint:** `pnpm lint`. **Format:** `pnpm format:fix`.
- **Migrations:** after editing `packages/db/schema.ts`, run `pnpm db:generate --name <desc>`. Never hand-write migration SQL.
- The tRPC test harness (`packages/trpc/routers/testUtils.ts`) gives each test `{ apiCallers, db }` via `defaultBeforeEach(true)`. `apiCallers[0]` and `apiCallers[1]` are two different users. `db` is the same drizzle instance those callers write through — so a row inserted via `apiCallers[0]` is visible through `db`, and vice-versa.
- The existing `socialSync.test.ts` already mocks `@karakeep/shared-server` (so `SocialSyncQueue.enqueue` is a no-op), `@karakeep/shared/config` (signing secret), and `global.fetch` (so `validateAuth` returns 200). New tests added to that file inherit those mocks.

---

### Task 1: `socialSyncRuns` schema + migration + `DB` type

**Files:**
- Modify: `packages/db/schema.ts` (add table after `socialSyncHistory`, ~line 1050; add relations after `importSessionBookmarksRelations`, ~line 1286)
- Modify: `packages/db/index.ts`
- Create: `packages/db/drizzle/00XX_add_social_sync_runs.sql` (generated)

- [ ] **Step 1: Add the table to `schema.ts`**

Insert immediately after the `socialSyncHistory` table definition (after its closing `);` around line 1050):

```ts
export const socialSyncRuns = sqliteTable(
  "socialSyncRuns",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    connectionId: text("connectionId")
      .notNull()
      .references(() => socialSyncConnections.id, { onDelete: "cascade" }),
    // Queue job id (req.id) for log correlation; null if unavailable.
    jobId: text("jobId"),
    trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
    status: text("status", { enum: ["running", "success", "failure"] })
      .notNull()
      .default("running"),
    // Drives the live label. Null before the first phase / after finish.
    phase: text("phase", { enum: ["fetching", "importing", "finalizing"] }),
    pagesScanned: integer("pagesScanned").notNull().default(0),
    itemsFound: integer("itemsFound").notNull().default(0),
    itemsImported: integer("itemsImported").notNull().default(0),
    itemsFailed: integer("itemsFailed").notNull().default(0),
    error: text("error"),
    startedAt: integer("startedAt", { mode: "timestamp" }).notNull(),
    finishedAt: integer("finishedAt", { mode: "timestamp" }),
  },
  (t) => [
    index("socialSyncRuns_connectionId_startedAt_idx").on(
      t.connectionId,
      t.startedAt,
    ),
  ],
);
```

- [ ] **Step 2: Add the relation**

Insert after the `importSessionBookmarksRelations` block (~line 1286). Also extend the connection relations so `connection.runs` is available for future `with` queries:

```ts
export const socialSyncRunsRelations = relations(socialSyncRuns, ({ one }) => ({
  connection: one(socialSyncConnections, {
    fields: [socialSyncRuns.connectionId],
    references: [socialSyncConnections.id],
  }),
}));
```

If a `socialSyncConnectionsRelations` block already exists, add `runs: many(socialSyncRuns)` to it. If it does NOT exist, add this block too (place it next to the new relations):

```ts
export const socialSyncConnectionsRelations = relations(
  socialSyncConnections,
  ({ many }) => ({
    runs: many(socialSyncRuns),
  }),
);
```

> Note: `db.query.socialSyncRuns.findMany({ where, orderBy, limit })` works from the table registration alone; relations are only needed for `with`. Adding them now keeps the door open and matches codebase style.

- [ ] **Step 3: Export the `DB` type**

Open `packages/db/index.ts`. If it does not already `export type DB`, add (the `db` const is already declared/exported there — the worker imports `{ db } from "@karakeep/db"`):

```ts
export type DB = typeof db;
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate --name add_social_sync_runs`
Expected: a new file `packages/db/drizzle/00XX_add_social_sync_runs.sql` (XX = next number after the current latest, currently 0087) containing `CREATE TABLE ... socialSyncRuns ...` and the index. The drizzle `meta/` snapshot files are updated too.

- [ ] **Step 5: Typecheck**

Run: `pnpm -F @karakeep/db exec tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add packages/db/schema.ts packages/db/index.ts packages/db/drizzle
git commit -m "feat(social-sync): add socialSyncRuns table for run tracking"
```

---

### Task 2: `onPage` observability hook in `planSync`

**Files:**
- Modify: `packages/trpc/lib/socialSync/syncEngine.ts` (interface ~line 37-56; loop ~line 93)
- Test: `packages/trpc/lib/socialSync/syncEngine.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Create `packages/trpc/lib/socialSync/syncEngine.test.ts` (if the file already exists, append the `describe` block below):

```ts
import { describe, expect, test } from "vitest";

import type {
  SocialSyncProvider,
  SyncItem,
} from "@karakeep/shared/types/socialSync";

import { planSync } from "./syncEngine";

function fakeProvider(
  pages: { items: SyncItem[]; nextCursor: string | null; hasMore: boolean }[],
): SocialSyncProvider {
  let i = 0;
  return {
    platform: "instagram",
    async fetchSavedItems() {
      const page = pages[i] ?? { items: [], nextCursor: null, hasMore: false };
      i++;
      return page;
    },
    async validateAuth() {
      return true;
    },
  };
}

describe("planSync onPage hook", () => {
  test("calls onPage once per fetched page, with increasing counts", async () => {
    const provider = fakeProvider([
      {
        items: [{ platformItemId: "a", url: "https://example.com/a" }],
        nextCursor: "c1",
        hasMore: true,
      },
      {
        items: [{ platformItemId: "b", url: "https://example.com/b" }],
        nextCursor: null,
        hasMore: false,
      },
    ]);
    const seen: number[] = [];
    await planSync({
      provider,
      authCookies: "{}",
      sinceTimestamp: null,
      backfillComplete: false,
      resumeCursor: null,
      isSeen: async () => false,
      onPage: (n) => {
        seen.push(n);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  test("works without onPage (no behavior change)", async () => {
    const provider = fakeProvider([
      { items: [], nextCursor: null, hasMore: false },
    ]);
    const res = await planSync({
      provider,
      authCookies: "{}",
      sinceTimestamp: null,
      backfillComplete: false,
      resumeCursor: null,
      isSeen: async () => false,
    });
    expect(res.backfillComplete).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @karakeep/trpc exec vitest run lib/socialSync/syncEngine.test.ts`
Expected: FAIL — `onPage` is not a known property of `PlanSyncInput` (type error) or `seen` stays `[]`.

- [ ] **Step 3: Add the `onPage` field to `PlanSyncInput`**

In `packages/trpc/lib/socialSync/syncEngine.ts`, inside the `PlanSyncInput` interface (after the `signal?: AbortSignal;` line, ~line 52):

```ts
  /** Called once after each page is fetched. Pure observability hook. */
  onPage?: (pagesScanned: number) => void | Promise<void>;
```

- [ ] **Step 4: Invoke the hook in the loop**

In the same file, in the `while` loop, immediately after the `pages++;` line (~line 93):

```ts
    pages++;
    await input.onPage?.(pages);
```

(Replace the existing standalone `pages++;` with these two lines.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @karakeep/trpc exec vitest run lib/socialSync/syncEngine.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add packages/trpc/lib/socialSync/syncEngine.ts packages/trpc/lib/socialSync/syncEngine.test.ts
git commit -m "feat(social-sync): add onPage observability hook to planSync"
```

---

### Task 3: `SyncRunRecorder` + `sweepStaleRuns`

**Files:**
- Create: `packages/trpc/lib/socialSync/syncRunRecorder.ts`
- Test: `packages/trpc/routers/socialSync.test.ts` (append new `describe` blocks — reuses that file's existing mocks/harness)

- [ ] **Step 1: Write the implementation**

Create `packages/trpc/lib/socialSync/syncRunRecorder.ts`:

```ts
import { and, eq, lt, sql, type SQL } from "drizzle-orm";
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
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/trpc/routers/socialSync.test.ts` (before the final closing `});` of the top-level `describe("Social Sync Router", ...)`, OR as sibling `describe`s after it). Add the imports at the top of the file first:

```ts
import { eq } from "drizzle-orm";

import { socialSyncRuns } from "@karakeep/db/schema";

import type { DB } from "@karakeep/db";
import {
  SyncRunRecorder,
  sweepStaleRuns,
} from "../lib/socialSync/syncRunRecorder";
```

Then add these `describe` blocks at the end of the file (top level, after the existing `describe("Social Sync Router", ...)`):

```ts
async function createConnection(apiCaller: {
  socialSync: {
    connect: (i: { platform: "instagram"; cookies: string }) => Promise<unknown>;
    getConnections: () => Promise<{ id: string }[]>;
  };
}) {
  await apiCaller.socialSync.connect({
    platform: "instagram",
    cookies: VALID_INSTAGRAM_COOKIES,
  });
  const [conn] = await apiCaller.socialSync.getConnections();
  return conn.id;
}

describe("SyncRunRecorder", () => {
  test<CustomTestContext>("records a successful run lifecycle", async ({
    apiCallers,
    db,
  }) => {
    const connectionId = await createConnection(apiCallers[0]);
    const rec = await SyncRunRecorder.start({
      db,
      connectionId,
      trigger: "manual",
      jobId: "job-1",
    });
    expect(rec.runId).not.toBeNull();

    await rec.setItemsFound(3);
    await rec.setPhase("importing");
    await rec.incrementImported();
    await rec.incrementImported();
    await rec.incrementFailed();
    await rec.incrementPages();
    await rec.finishSuccess();

    const [row] = await db
      .select()
      .from(socialSyncRuns)
      .where(eq(socialSyncRuns.id, rec.runId!));
    expect(row.status).toBe("success");
    expect(row.itemsFound).toBe(3);
    expect(row.itemsImported).toBe(2);
    expect(row.itemsFailed).toBe(1);
    expect(row.pagesScanned).toBe(1);
    expect(row.phase).toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(row.trigger).toBe("manual");
    expect(row.jobId).toBe("job-1");
  });

  test<CustomTestContext>("finishFailure records the error", async ({
    apiCallers,
    db,
  }) => {
    const connectionId = await createConnection(apiCallers[0]);
    const rec = await SyncRunRecorder.start({
      db,
      connectionId,
      trigger: "scheduled",
    });
    await rec.finishFailure("boom");

    const [row] = await db
      .select()
      .from(socialSyncRuns)
      .where(eq(socialSyncRuns.id, rec.runId!));
    expect(row.status).toBe("failure");
    expect(row.error).toBe("boom");
  });

  test("returns a no-op recorder when the insert fails", async () => {
    const brokenDb = {
      insert: () => {
        throw new Error("db down");
      },
    } as unknown as DB;
    const rec = await SyncRunRecorder.start({
      db: brokenDb,
      connectionId: "whatever",
      trigger: "manual",
    });
    expect(rec.runId).toBeNull();
    // No-op methods must not throw and must not touch the db.
    await expect(rec.incrementImported()).resolves.toBeUndefined();
    await expect(rec.finishSuccess()).resolves.toBeUndefined();
  });
});

describe("sweepStaleRuns", () => {
  test<CustomTestContext>("fails old running rows but leaves recent ones", async ({
    apiCallers,
    db,
  }) => {
    const connectionId = await createConnection(apiCallers[0]);
    await db.insert(socialSyncRuns).values([
      {
        connectionId,
        trigger: "scheduled",
        status: "running",
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
      {
        connectionId,
        trigger: "manual",
        status: "running",
        startedAt: new Date(),
      },
    ]);

    await sweepStaleRuns(db, new Date(Date.now() - 3 * 60 * 1000));

    const rows = await db
      .select()
      .from(socialSyncRuns)
      .where(eq(socialSyncRuns.connectionId, connectionId));
    const oldRow = rows.find((r) => r.trigger === "scheduled");
    const recentRow = rows.find((r) => r.trigger === "manual");
    expect(oldRow?.status).toBe("failure");
    expect(oldRow?.error).toBe("Run timed out");
    expect(recentRow?.status).toBe("running");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm -F @karakeep/trpc exec vitest run routers/socialSync.test.ts`
Expected: FAIL — the new `describe` blocks fail to import `../lib/socialSync/syncRunRecorder` symbols only if the file is missing; since Step 1 created it, they should run. If Step 1 was skipped they error on import. (They genuinely exercise new behavior, so this confirms wiring.)

> If `db` test type is not assignable to `DB` in `SyncRunRecorder.start({ db, ... })`, cast at the call site in the tests: `db: db as unknown as DB`. This is a test-only concession; production passes the real singleton.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @karakeep/trpc exec vitest run routers/socialSync.test.ts`
Expected: PASS (all existing + new tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/trpc/lib/socialSync/syncRunRecorder.ts packages/trpc/routers/socialSync.test.ts
git commit -m "feat(social-sync): SyncRunRecorder + stale-run sweep"
```

---

### Task 4: `trigger` on the queue payload + enqueue sites

**Files:**
- Modify: `packages/shared-server/src/queues.ts:236-238`
- Modify: `packages/trpc/routers/socialSync.ts` (enqueues at ~line 105 and ~line 185)
- (Cron enqueue is handled in Task 5, in the worker file.)

- [ ] **Step 1: Add `trigger` to the request schema**

In `packages/shared-server/src/queues.ts`, replace the `zSocialSyncRequestSchema` definition (lines 236-238):

```ts
export const zSocialSyncRequestSchema = z.object({
  connectionId: z.string(),
  trigger: z.enum(["manual", "scheduled"]).optional().default("scheduled"),
});
```

- [ ] **Step 2: Pass `trigger: "manual"` from the router enqueues**

In `packages/trpc/routers/socialSync.ts`, the `connect` mutation enqueue (~line 105):

```ts
      await SocialSyncQueue.enqueue(
        { connectionId: connection.id, trigger: "manual" },
        { groupId: ctx.user.id },
      );
```

And the `syncNow` mutation enqueue (~line 185):

```ts
      await SocialSyncQueue.enqueue(
        { connectionId: input.connectionId, trigger: "manual" },
        { groupId: ctx.user.id },
      );
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -F @karakeep/shared-server exec tsc --noEmit && pnpm -F @karakeep/trpc exec tsc --noEmit`
Expected: PASS. (`.optional().default()` keeps `{ connectionId }`-only enqueues valid, so nothing else breaks.)

- [ ] **Step 4: Commit**

```bash
git add packages/shared-server/src/queues.ts packages/trpc/routers/socialSync.ts
git commit -m "feat(social-sync): tag sync jobs with manual/scheduled trigger"
```

---

### Task 5: Worker instrumentation + cron sweep

**Files:**
- Modify: `apps/workers/workers/socialSyncWorker.ts` (imports; `run()` body lines 28-187; cron lines 226-273)

- [ ] **Step 1: Add imports**

At the top of `apps/workers/workers/socialSyncWorker.ts`, after the existing `import { planSync } ...` line (~line 24):

```ts
import {
  SyncRunRecorder,
  sweepStaleRuns,
} from "@karakeep/trpc/lib/socialSync/syncRunRecorder";
```

- [ ] **Step 2: Replace the entire `run()` function**

Replace the whole `run` function (from `async function run(` down to its closing `}` before `export class SocialSyncWorker`) with:

```ts
async function run(req: DequeuedJob<ZSocialSyncRequestSchema>) {
  const { connectionId, trigger } = req.data;
  logger.info(`[social-sync][${connectionId}] Starting sync run`);

  const recorder = await SyncRunRecorder.start({
    db,
    connectionId,
    trigger,
    jobId: req.id,
  });

  try {
    const connection = await db.query.socialSyncConnections.findFirst({
      where: eq(socialSyncConnections.id, connectionId),
    });

    if (!connection || !connection.enabled) {
      logger.info(
        `[social-sync][${connectionId}] Connection not found or disabled, skipping`,
      );
      await recorder.finishFailure("Connection not found or disabled");
      return;
    }

    const provider = getProvider(connection.platform);
    let authCookies: string;
    try {
      authCookies = await decryptCookies(connection.authCookies);
    } catch (e) {
      logger.error(
        `[social-sync][${connectionId}] Failed to decrypt cookies: ${e}`,
      );
      await db
        .update(socialSyncConnections)
        .set({
          lastSyncStatus: "failure",
          lastSyncError: "Failed to decrypt stored cookies",
          enabled: false,
        })
        .where(eq(socialSyncConnections.id, connectionId));
      await recorder.finishFailure("Failed to decrypt stored cookies");
      return;
    }

    await recorder.setPhase("fetching");

    let result;
    try {
      result = await planSync({
        provider,
        authCookies,
        sinceTimestamp: connection.lastSyncedAt,
        backfillComplete: connection.backfillComplete,
        resumeCursor: connection.lastCursor,
        maxItems: MAX_ITEMS_PER_RUN,
        signal: req.abortSignal,
        onPage: () => recorder.incrementPages(),
        isSeen: async (platformItemId) => {
          const existing = await db.query.socialSyncHistory.findFirst({
            where: and(
              eq(socialSyncHistory.connectionId, connectionId),
              eq(socialSyncHistory.platformItemId, platformItemId),
            ),
          });
          return !!existing;
        },
      });
    } catch (e: unknown) {
      const err = e as Record<string, unknown>;
      const status = err?.status ?? err?.statusCode;
      if (status === 401 || status === 403) {
        await db
          .update(socialSyncConnections)
          .set({
            lastSyncStatus: "failure",
            lastSyncError: "Authentication expired — update your cookies",
            enabled: false,
          })
          .where(eq(socialSyncConnections.id, connectionId));
        await recorder.finishFailure(
          "Authentication expired — update your cookies",
        );
        return;
      }
      throw e;
    }

    await recorder.setItemsFound(result.newItems.length);
    await recorder.setPhase("importing");

    const trpcClient = await buildImpersonatingTRPCClient(connection.userId);
    let newCount = 0;

    for (const item of result.newItems) {
      try {
        const bookmark = await trpcClient.bookmarks.createBookmark({
          type: BookmarkTypes.LINK,
          url: item.url,
          title: item.title,
          source: "sync",
        });

        const tagName = connection.autoTagName ?? connection.platform;
        let tag = await db.query.bookmarkTags.findFirst({
          where: and(
            eq(bookmarkTags.userId, connection.userId),
            eq(bookmarkTags.name, tagName),
          ),
        });
        if (!tag) {
          [tag] = await db
            .insert(bookmarkTags)
            .values({ userId: connection.userId, name: tagName })
            .returning();
        }
        await db
          .insert(tagsOnBookmarks)
          .values({
            bookmarkId: bookmark.id,
            tagId: tag.id,
            attachedBy: "human",
          })
          .onConflictDoNothing();

        if (item.tags) {
          for (const hashtagName of item.tags) {
            let hashtag = await db.query.bookmarkTags.findFirst({
              where: and(
                eq(bookmarkTags.userId, connection.userId),
                eq(bookmarkTags.name, hashtagName),
              ),
            });
            if (!hashtag) {
              [hashtag] = await db
                .insert(bookmarkTags)
                .values({ userId: connection.userId, name: hashtagName })
                .returning();
            }
            await db
              .insert(tagsOnBookmarks)
              .values({
                bookmarkId: bookmark.id,
                tagId: hashtag.id,
                attachedBy: "human",
              })
              .onConflictDoNothing();
          }
        }

        await db.insert(socialSyncHistory).values({
          connectionId,
          platformItemId: item.platformItemId,
          bookmarkId: bookmark.id,
        });

        newCount++;
        await recorder.incrementImported();
      } catch (e) {
        logger.warn(
          `[social-sync][${connectionId}] Failed to create bookmark for ${item.url}: ${e}`,
        );
        await recorder.incrementFailed();
      }
    }

    await recorder.setPhase("finalizing");
    await db
      .update(socialSyncConnections)
      .set({
        lastSyncedAt: new Date(),
        lastCursor: result.resumeCursor,
        backfillComplete: result.backfillComplete,
        lastSyncStatus: "success",
        lastSyncError: null,
        totalSynced: sql`${socialSyncConnections.totalSynced} + ${newCount}`,
      })
      .where(eq(socialSyncConnections.id, connectionId));

    await recorder.finishSuccess();
    logger.info(
      `[social-sync][${connectionId}] Sync complete: ${newCount} new bookmarks`,
    );
  } catch (e) {
    await recorder.finishFailure(String(e));
    throw e;
  }
}
```

- [ ] **Step 3: Add the stale-run sweep + `trigger` to the cron**

In the `SocialSyncRefreshingWorker` cron callback, after `const now = new Date();` add the sweep, and change the enqueue payload to include `trigger: "scheduled"`:

```ts
    const now = new Date();
    // Fail runs that have been "running" past the job timeout (60s) + grace
    // (120s) — covers a hard process hang where run()'s catch never executed.
    void sweepStaleRuns(db, new Date(now.getTime() - 180 * 1000));
```

And the enqueue inside the cron loop:

```ts
          await SocialSyncQueue.enqueue(
            { connectionId: conn.id, trigger: "scheduled" },
            {
              idempotencyKey: `sync:${conn.id}:${intervalSlot}`,
              groupId: conn.userId,
            },
          );
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -F @karakeep/workers exec tsc --noEmit`
Expected: PASS. (`req.data.trigger` is typed because Task 4 added it to `zSocialSyncRequestSchema`; `req.id` already exists on `DequeuedJob`.)

- [ ] **Step 5: Commit**

```bash
git add apps/workers/workers/socialSyncWorker.ts
git commit -m "feat(social-sync): record run progress + sweep stale runs in worker"
```

---

### Task 6: Router reads — `getRuns` + `activeRun`

**Files:**
- Modify: `packages/trpc/routers/socialSync.ts` (imports; `getConnections` ~line 49-66; add `getRuns`)
- Test: `packages/trpc/routers/socialSync.test.ts` (append describe blocks)

- [ ] **Step 1: Write the failing tests**

Append to `packages/trpc/routers/socialSync.test.ts` (top-level, after the Task 3 blocks):

```ts
describe("getRuns", () => {
  test<CustomTestContext>("returns runs newest-first", async ({
    apiCallers,
    db,
  }) => {
    const connectionId = await createConnection(apiCallers[0]);
    await db.insert(socialSyncRuns).values([
      {
        connectionId,
        trigger: "manual",
        status: "success",
        startedAt: new Date(Date.now() - 120 * 1000),
        itemsImported: 1,
      },
      {
        connectionId,
        trigger: "scheduled",
        status: "failure",
        startedAt: new Date(Date.now() - 60 * 1000),
        error: "nope",
      },
    ]);
    const runs = await apiCallers[0].socialSync.getRuns({ connectionId });
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("failure"); // newest
    expect(runs[1].status).toBe("success");
  });

  test<CustomTestContext>("rejects another user's connection", async ({
    apiCallers,
  }) => {
    const connectionId = await createConnection(apiCallers[0]);
    await expect(
      apiCallers[1].socialSync.getRuns({ connectionId }),
    ).rejects.toThrow();
  });
});

describe("getConnections.activeRun", () => {
  test<CustomTestContext>("exposes the running run, latest by startedAt", async ({
    apiCallers,
    db,
  }) => {
    const connectionId = await createConnection(apiCallers[0]);
    await db.insert(socialSyncRuns).values([
      {
        connectionId,
        trigger: "scheduled",
        status: "running",
        phase: "fetching",
        startedAt: new Date(Date.now() - 120 * 1000),
      },
      {
        connectionId,
        trigger: "manual",
        status: "running",
        phase: "importing",
        itemsFound: 10,
        itemsImported: 4,
        startedAt: new Date(Date.now() - 60 * 1000),
      },
    ]);
    const [c] = await apiCallers[0].socialSync.getConnections();
    expect(c.activeRun).not.toBeNull();
    expect(c.activeRun?.phase).toBe("importing");
    expect(c.activeRun?.itemsImported).toBe(4);
  });

  test<CustomTestContext>("activeRun is null with no running run", async ({
    apiCallers,
  }) => {
    await createConnection(apiCallers[0]);
    const [c] = await apiCallers[0].socialSync.getConnections();
    expect(c.activeRun).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F @karakeep/trpc exec vitest run routers/socialSync.test.ts`
Expected: FAIL — `getRuns` is not a function / `activeRun` is undefined.

- [ ] **Step 3: Update imports in the router**

In `packages/trpc/routers/socialSync.ts`, change the drizzle import (line 2) and schema import (line 4), and add a zod import:

```ts
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";

import { socialSyncConnections, socialSyncRuns } from "@karakeep/db/schema";
```

- [ ] **Step 4: Rewrite `getConnections` to embed `activeRun`**

Replace the existing `getConnections` query (lines 49-66) with:

```ts
  getConnections: socialSyncProcedure.query(async ({ ctx }) => {
    const connections = await ctx.db.query.socialSyncConnections.findMany({
      where: eq(socialSyncConnections.userId, ctx.user.id),
    });

    const connIds = connections.map((c) => c.id);
    const runningRuns = connIds.length
      ? await ctx.db.query.socialSyncRuns.findMany({
          where: and(
            inArray(socialSyncRuns.connectionId, connIds),
            eq(socialSyncRuns.status, "running"),
          ),
          orderBy: (r, { desc }) => [desc(r.startedAt)],
        })
      : [];

    // First row per connection wins = latest, because ordered desc by startedAt.
    const activeByConn = new Map<string, (typeof runningRuns)[number]>();
    for (const r of runningRuns) {
      if (!activeByConn.has(r.connectionId)) activeByConn.set(r.connectionId, r);
    }

    return connections.map((c) => {
      const run = activeByConn.get(c.id);
      return {
        id: c.id,
        platform: c.platform,
        enabled: c.enabled,
        lastSyncedAt: c.lastSyncedAt,
        lastSyncStatus: c.lastSyncStatus,
        lastSyncError: c.lastSyncError,
        syncIntervalMinutes: c.syncIntervalMinutes,
        autoTagName: c.autoTagName ?? c.platform,
        totalSynced: c.totalSynced,
        backfillComplete: c.backfillComplete,
        createdAt: c.createdAt,
        activeRun: run
          ? {
              id: run.id,
              phase: run.phase,
              pagesScanned: run.pagesScanned,
              itemsFound: run.itemsFound,
              itemsImported: run.itemsImported,
              itemsFailed: run.itemsFailed,
              startedAt: run.startedAt,
            }
          : null,
      };
    });
  }),
```

- [ ] **Step 5: Add the `getRuns` query**

In the same router object, add after `getConnections` (before `connect`):

```ts
  getRuns: socialSyncProcedure
    .input(
      z.object({
        connectionId: z.string(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .use(ensureConnectionOwnership)
    .query(async ({ input, ctx }) => {
      const runs = await ctx.db.query.socialSyncRuns.findMany({
        where: eq(socialSyncRuns.connectionId, input.connectionId),
        orderBy: (r, { desc }) => [desc(r.startedAt)],
        limit: input.limit,
      });
      return runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        itemsImported: r.itemsImported,
        itemsFailed: r.itemsFailed,
        error: r.error,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      }));
    }),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm -F @karakeep/trpc exec vitest run routers/socialSync.test.ts`
Expected: PASS (all blocks green).

- [ ] **Step 7: Commit**

```bash
git add packages/trpc/routers/socialSync.ts packages/trpc/routers/socialSync.test.ts
git commit -m "feat(social-sync): expose activeRun + getRuns from the router"
```

---

### Task 7: `SocialSyncProgress` component

**Files:**
- Create: `apps/web/components/settings/SocialSyncProgress.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/components/settings/SocialSyncProgress.tsx`:

```tsx
"use client";

import RelativeTime from "@/components/ui/relative-time";
import { useTranslation } from "@/lib/i18n/client";

export interface ActiveRun {
  id: string;
  phase: "fetching" | "importing" | "finalizing" | null;
  pagesScanned: number;
  itemsFound: number;
  itemsImported: number;
  itemsFailed: number;
  startedAt: Date | string;
}

export function SocialSyncProgress({ run }: { run: ActiveRun | null }) {
  const { t } = useTranslation();
  if (!run) return null;

  const determinate = run.phase === "importing" && run.itemsFound > 0;
  const pct = determinate
    ? Math.min(100, Math.round((run.itemsImported / run.itemsFound) * 100))
    : run.phase === "finalizing"
      ? 95
      : null;

  const label =
    run.phase === "importing"
      ? t("social_sync.progress_importing", {
          imported: run.itemsImported,
          found: run.itemsFound,
        })
      : run.phase === "finalizing"
        ? t("social_sync.progress_finishing")
        : t("social_sync.progress_scanning", { page: run.pagesScanned });

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {label}
          {run.itemsFailed > 0
            ? ` · ${t("social_sync.progress_failed_suffix", { count: run.itemsFailed })}`
            : ""}
        </span>
        <RelativeTime date={new Date(run.startedAt)} />
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full bg-primary transition-all ${
            pct === null ? "w-1/3 animate-pulse" : ""
          }`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @karakeep/web exec tsc --noEmit`
Expected: PASS. (May show pre-existing unrelated warnings; no NEW errors from this file. If `useTranslation` import path differs, match the one already used in `SocialSyncSettings.tsx`: `@/lib/i18n/client`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/settings/SocialSyncProgress.tsx
git commit -m "feat(social-sync): SocialSyncProgress live progress component"
```

---

### Task 8: `SocialSyncRunHistory` component

**Files:**
- Create: `apps/web/components/settings/SocialSyncRunHistory.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/components/settings/SocialSyncRunHistory.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import RelativeTime from "@/components/ui/relative-time";
import { useTranslation } from "@/lib/i18n/client";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

function formatDuration(start: Date, end: Date): string {
  const secs = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function SocialSyncRunHistory({
  connectionId,
}: {
  connectionId: string;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const [open, setOpen] = useState(false);

  const runsQuery = useQuery({
    ...api.socialSync.getRuns.queryOptions({ connectionId }),
    enabled: open,
  });

  const runs = runsQuery.data ?? [];

  return (
    <div className="text-sm">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto px-0 text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾ " : "▸ "}
        {t("social_sync.recent_runs")}
      </Button>

      {open && (
        <ul className="mt-1 space-y-1">
          {runs.length === 0 && (
            <li className="text-xs text-muted-foreground">
              {t("social_sync.no_runs")}
            </li>
          )}
          {runs.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="flex items-center gap-1">
                <span aria-hidden>
                  {r.status === "success"
                    ? "✓"
                    : r.status === "failure"
                      ? "✗"
                      : "⟳"}
                </span>
                <span className="text-muted-foreground">
                  {r.trigger === "manual"
                    ? t("social_sync.run_trigger_manual")
                    : t("social_sync.run_trigger_scheduled")}
                </span>
                <RelativeTime date={new Date(r.startedAt)} />
              </span>
              <span className="text-right text-muted-foreground">
                {r.status === "failure" && r.error
                  ? r.error
                  : t("social_sync.run_imported", { count: r.itemsImported })}
                {r.itemsFailed > 0
                  ? ` · ${t("social_sync.progress_failed_suffix", { count: r.itemsFailed })}`
                  : ""}
                {r.finishedAt
                  ? ` · ${formatDuration(new Date(r.startedAt), new Date(r.finishedAt))}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @karakeep/web exec tsc --noEmit`
Expected: PASS (no new errors; `getRuns` exists from Task 6, so its types resolve through the tRPC client).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/settings/SocialSyncRunHistory.tsx
git commit -m "feat(social-sync): SocialSyncRunHistory recent-runs component"
```

---

### Task 9: Wire components into `PlatformCard` + poll + i18n

**Files:**
- Modify: `apps/web/components/settings/SocialSyncSettings.tsx`
- Modify: `apps/web/lib/i18n/locales/en/translation.json` (social_sync block ~line 1203-1226)

- [ ] **Step 1: Add the i18n keys**

In `apps/web/lib/i18n/locales/en/translation.json`, change the last line of the `social_sync` block from:

```json
    "sync_triggered": "Sync started for {{platform}}"
```

to (add a comma, then the new keys):

```json
    "sync_triggered": "Sync started for {{platform}}",
    "progress_scanning": "Scanning saved feed… page {{page}}",
    "progress_importing": "{{imported}} / {{found}} imported",
    "progress_failed_suffix": "{{count}} failed",
    "progress_finishing": "Finishing…",
    "recent_runs": "Recent runs",
    "no_runs": "No sync runs yet.",
    "run_imported": "+{{count}} imported",
    "run_trigger_manual": "Manual",
    "run_trigger_scheduled": "Scheduled",
    "run_status_running": "Syncing…",
    "queued": "Queued"
```

- [ ] **Step 2: Import the components**

In `apps/web/components/settings/SocialSyncSettings.tsx`, after the existing component imports (near the other `@/components/...` imports), add:

```tsx
import { SocialSyncProgress } from "@/components/settings/SocialSyncProgress";
import { SocialSyncRunHistory } from "@/components/settings/SocialSyncRunHistory";
```

- [ ] **Step 3: Poll only while a sync is active**

Replace the `connectionsQuery` declaration (lines 58-60):

```tsx
  const connectionsQuery = useQuery({
    ...api.socialSync.getConnections.queryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.activeRun) ? 2000 : false,
  });
```

- [ ] **Step 4: Add Syncing/Queued badges**

Replace the `statusBadge` definition (lines 142-148):

```tsx
  const statusBadge = !connection ? (
    <Badge variant="secondary">{t("social_sync.not_connected")}</Badge>
  ) : connection.activeRun ? (
    <Badge variant="default">{t("social_sync.run_status_running")}</Badge>
  ) : connection.lastSyncStatus === "failure" ? (
    <Badge variant="destructive">{t("social_sync.auth_expired")}</Badge>
  ) : connection.lastSyncStatus === "pending" ? (
    <Badge variant="secondary">{t("social_sync.queued")}</Badge>
  ) : (
    <Badge variant="default">{t("social_sync.connected")}</Badge>
  );
```

- [ ] **Step 5: Render the progress bar**

In the connected block, immediately after the stats `<div>` that shows `total_synced` / `last_synced` (it closes around line 176, before the backfilling `<p>`), insert:

```tsx
              <SocialSyncProgress run={connection.activeRun ?? null} />
```

- [ ] **Step 6: Render the history list**

After the action-buttons `<div>` (the one containing Sync Now / Update Cookies / Disconnect, closes ~line 270), still inside the `<>...</>` connected fragment, insert:

```tsx
              <SocialSyncRunHistory connectionId={connection.id} />
```

- [ ] **Step 7: Typecheck + lint + format**

Run: `pnpm -F @karakeep/web exec tsc --noEmit && pnpm lint && pnpm format:fix`
Expected: PASS (no new type errors; lint clean; formatter may reflow the JSON/TSX — that's fine).

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/settings/SocialSyncSettings.tsx apps/web/lib/i18n/locales/en/translation.json
git commit -m "feat(social-sync): wire progress + history into settings UI"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Whole-repo typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 3: Run the full social-sync + engine test suites**

Run: `pnpm -F @karakeep/trpc exec vitest run routers/socialSync.test.ts lib/socialSync/syncEngine.test.ts`
Expected: PASS (all describe blocks: connect, API-key auth, disconnect, updateSettings, setEnabled, SyncRunRecorder, sweepStaleRuns, getRuns, getConnections.activeRun, planSync onPage hook).

- [ ] **Step 4: Run the queue plugin tests (regression guard on the base)**

Run: `pnpm -F @karakeep/plugins exec vitest run`
Expected: PASS (Codex's queue tests still green).

- [ ] **Step 5: Format**

Run: `pnpm format:fix`
Expected: no remaining diffs after commit (run `git status` — should be clean or only formatting already committed).

- [ ] **Step 6: Manual verification (requires Docker stack or `pnpm web` + `pnpm workers`)**

Checklist:
1. Open Settings → Social Sync. Connect (or already-connected) Instagram.
2. Click **Sync Now**. The card badge flips to **Syncing…**; the progress bar appears: first "Scanning saved feed… page N" (indeterminate), then "M / K imported" advancing, then "Finishing…".
3. When done, badge returns to **Connected**; expand **Recent runs** → the run shows `+K imported`, a duration, and "Manual".
4. Force a failure (disconnect network / expire cookies) and Sync Now → run lands in history as `✗ … <error>`; connection error line still shows as before.
5. Confirm idle cards do NOT poll: with no active run, observe no repeated `getConnections` network calls (DevTools Network) until a sync starts.

- [ ] **Step 7: Final commit (if formatter changed anything)**

```bash
git add -A
git commit -m "chore(social-sync): formatting" --allow-empty
```

---

## Self-Review (completed during authoring)

**1. Spec coverage** — every spec section maps to a task:
- §4 table → Task 1. §5 `trigger` payload + §5.1 row-at-start → Tasks 4 (+1). §6.1 recorder → Task 3. §6.2 `onPage` → Task 2. §6.3 `run()` wiring → Task 5. §6.4 stale sweep → Tasks 3 (fn) + 5 (cron call). §7.1 `activeRun` + §7.2 `getRuns` → Task 6. §8.1 progress → Task 7. §8.2 history → Task 8. §8.3 wiring/poll + §8.4 i18n → Task 9. §9 error handling → Task 5 (every exit path finalizes). §10 testing → Tasks 2,3,6 + Task 10 manual.
- **Deviation (intentional, per spec §10 + YAGNI):** no standalone worker-`run()` harness test. `run()` is glue; its tracking behavior is covered by `SyncRunRecorder` unit tests, the `sweepStaleRuns` test, the router tests, and the Task 10 manual checklist. Adding a worker harness would require exporting `run()` and mocking `buildImpersonatingTRPCClient`/providers/`db` — high brittleness for low marginal coverage.
- **Deviation:** spec §11 listed a separate `syncRunRecorder.test.ts` and a `shared/types/socialSync.ts` change. Recorder/sweep tests live in the existing `socialSync.test.ts` to reuse its mocks (DRY); shared types are unneeded because the UI gets its types via tRPC inference.

**2. Placeholder scan** — no TBD/TODO/"handle errors"/"similar to". Every code step has complete, copy-pasteable code.

**3. Type consistency** — names are stable across tasks: `SyncRunRecorder.start({ db, connectionId, trigger, jobId })`, `.setPhase/.setItemsFound/.incrementPages/.incrementImported/.incrementFailed/.finishSuccess/.finishFailure`, `sweepStaleRuns(db, olderThan)`, `onPage(pagesScanned)`, `activeRun` shape (id/phase/pagesScanned/itemsFound/itemsImported/itemsFailed/startedAt) identical in Task 6 router and Task 7 `ActiveRun` interface; `getRuns` row shape (id/trigger/status/itemsImported/itemsFailed/error/startedAt/finishedAt) identical in Task 6 and consumed in Task 8.

# Social Sync Run Tracking — Design Spec

**Date:** 2026-05-31
**Branch:** `feat/social-sync`
**Status:** Approved design (Approach A), ready for implementation plan
**Author:** brainstorming session

---

## 1. Problem

The social-sync worker imports saved posts (Instagram / X / YouTube) on a queue,
but its status is invisible while it runs and unrecorded after it finishes.

Today, all status lives on a single `socialSyncConnections` row
(`lastSyncStatus`, `lastSyncError`, `lastSyncedAt`, `totalSynced`) and is
**overwritten every run**. Consequences:

- **No live progress.** The worker imports items in a loop (`run()` in
  `apps/workers/workers/socialSyncWorker.ts`) but writes nothing until the very
  end, so the UI shows a static "Syncing…" / "Importing saved history…"
  indefinitely with no advancing count.
- **No history.** Each run clobbers the previous result. Users cannot see "the
  18:40 run imported 37 posts in 2 minutes; the 17:55 run failed with auth
  expired."
- **Partial failures are hidden.** Per-item bookmark-creation failures are only
  `logger.warn`-ed (`socialSyncWorker.ts` import loop); the user never sees that
  "92 of 100 imported, 8 failed."
- **The "queued but not yet running" state is invisible** — exactly the state
  that made the original worker bug
  (`docs/social-sync-worker-bug-report.md`) so hard to diagnose.

### Context: the queue was just fixed

Codex repaired the execution path in this same branch (uncommitted working-tree
changes):

- `packages/plugins/queue-liteque/src/index.ts` — replaced liteque's built-in
  `Runner` with a custom `LitequeRunner` + raw-SQL `attemptDequeue`/`finalize`.
  The runner loop now wraps dequeue in `try/catch` and self-heals
  (`"[queue-liteque][…] Dequeue failed, retrying"`) instead of dying silently —
  the root cause (hypothesis #4) in the bug report. Per-job timeout via
  `Promise.race` + `AbortController`; `onComplete`/`onError` hooks fire.
- `apps/workers/workers/socialSyncWorker.ts` — added
  `validator: zSocialSyncRequestSchema`, threads `req.abortSignal` into
  `planSync`, and `await`s + `.catch()`-logs the cron enqueue.

**This spec sits entirely on top of that fixed queue. It changes no queue
mechanics** — it observes the worker's run lifecycle and adds an app-layer
record. (Rationale for not swapping to an external broker like RabbitMQ:
per-job *business* progress — phase, pages, items — is application state no
broker provides; the robustness gap was a consumer-loop bug already fixed; and
a broker breaks Karakeep's single-container SQLite self-hosting model. The queue
backend is already pluggable via `packages/shared/queueing.ts` →
`QueueClient`, with `queue-restate` available as a future escape hatch, so we
keep liteque.)

## 2. Goals / Non-goals

**Goals**

- Persist one record per sync run with lifecycle status and outcome.
- Update that record *during* the run so the UI shows advancing progress.
- Show users (a) a live progress bar for the active run and (b) a short list of
  recent runs per connection.
- Surface partial failures (imported vs. failed counts) and per-run errors.
- Add nothing to the queue core; keep all writes additive and on the worker
  side.

**Non-goals**

- A generic, all-workers queue-observability layer (would touch the just-fixed
  queue core; out of scope — this is social-sync-specific).
- Real-time push (websockets/SSE). We poll, matching the rest of the codebase
  (`@tanstack/react-query` everywhere; no socket infra).
- An admin / global cross-user dashboard.
- A cross-platform "all my sync activity" feed (deliberately deferred; see §12).
- Changing retry counts, intervals, or the sync algorithm (`planSync`).

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ Worker process (apps/workers)                                  │
│                                                                │
│  liteque runner (FIXED, untouched)                             │
│        │ dequeue → funcs.run(job)                              │
│        ▼                                                       │
│  socialSyncWorker.run(req)                                     │
│     ├─ recorder = SyncRunRecorder.start(connId, trigger, jobId)│
│     ├─ planSync({ …, onPage })  ── recorder.incPages ─┐ writes │
│     ├─ import loop ── recorder.incImported/incFailed ─┤  to    │
│     └─ finishSuccess() / finishFailure(err) ──────────┘ socialSyncRuns
│                                                       (app DB) │
│  SocialSyncRefreshingWorker cron (every minute)               │
│     └─ also sweeps stale `running` rows → failure              │
└──────────────────────────────────────────────────────────────┘
                              │ reads
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ tRPC socialSync router (read-only additions)                   │
│   getConnections → embeds `activeRun` (current running row)    │
│   getRuns({ connectionId, limit }) → recent run history        │
└──────────────────────────────────────────────────────────────┘
                              │ react-query (poll while active)
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Web UI (apps/web)                                              │
│   PlatformCard                                                 │
│     ├─ <SocialSyncProgress run={activeRun} />   (live bar)     │
│     └─ <SocialSyncRunHistory connectionId />    (recent runs)  │
└──────────────────────────────────────────────────────────────┘
```

Units, each independently understandable and testable:

| Unit | Responsibility | Depends on |
|---|---|---|
| `socialSyncRuns` table | Durable per-run record | drizzle schema |
| `SyncRunRecorder` | Lifecycle + counter writes to that table | `db`, schema only |
| `onPage` hook in `planSync` | Emit page-scanned signal (pure) | nothing (callback) |
| `run()` instrumentation | Wire recorder into the worker body | recorder, planSync |
| Stale-run sweep | Fail runs left `running` past timeout | `db`, schema |
| `getConnections.activeRun` / `getRuns` | Read API | db query, ownership mw |
| `SocialSyncProgress` | Render active run | tRPC query |
| `SocialSyncRunHistory` | Render recent runs | tRPC query |

## 4. Data model — new `socialSyncRuns` table

New drizzle table in `packages/db/schema.ts`, following the `importSessions`
precedent (status enum + error/message text) and the existing
`socialSyncConnections` conventions (`createId()` PK, `cascade` FK,
`createdAtField()`).

```ts
export const socialSyncRuns = sqliteTable(
  "socialSyncRuns",
  {
    id: text("id").notNull().primaryKey().$defaultFn(() => createId()),
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

Plus relations (next to the existing relations block in `schema.ts`):
`socialSyncRuns` belongs to one `connection`; add `runs: many(socialSyncRuns)`
to the connection relations.

> **Self-review note:** `userId` was intentionally **not** added. Every in-scope
> read (`getRuns`, `activeRun`) scopes through the connection (ownership checked
> on the connection), and the stale sweep is global, so `userId` is derivable via
> the `connectionId` FK and not needed (YAGNI). If the deferred cross-platform
> activity feed (§12) is ever built, add the column + a `userId, startedAt` index
> then.

Migration: `pnpm db:generate --name add_social_sync_runs` → produces the next
`packages/db/drizzle/00XX_add_social_sync_runs.sql` file (currently the latest
is `0087`; use whatever number the generator emits — do not hard-code it).

### Field rationale

- `trigger` — distinguishes "Sync Now" from the cron in history. Source: a new
  optional field on the queue payload (see §5).
- `itemsFound` — set right after `planSync` returns
  (`result.newItems.length`); it is the progress-bar **denominator**. Bounded by
  `MAX_ITEMS_PER_RUN` (100), so large backfills show as several runs.
- `itemsImported` / `itemsFailed` — incremented in the import loop; numerator +
  visible partial-failure count.
- `pagesScanned` — incremented during fetch (the indeterminate phase, before we
  know the denominator).
- `startedAt` set at worker start, **not** at enqueue (see §5.1 decision).

## 5. Queue payload change (minimal, additive)

Extend the request schema in `packages/shared-server/src/queues.ts` so the
worker knows whether a run was user-triggered:

```ts
export const zSocialSyncRequestSchema = z.object({
  connectionId: z.string(),
  trigger: z.enum(["manual", "scheduled"]).optional().default("scheduled"),
});
```

- `syncNow` / `connect` enqueue with `trigger: "manual"`.
- The refresh cron enqueues with `trigger: "scheduled"` (or omits → defaults).
- `.optional().default(...)` keeps any already-enqueued payloads valid (the
  `validator` Codex added will accept old rows).

### 5.1 Decision: create the run row at worker start, not at enqueue

The run row is inserted when `run()` actually begins (status `running`), **not**
when a job is enqueued. Why:

- The cron uses an `idempotencyKey` (`sync:<conn>:<slot>`) to dedup enqueues;
  creating rows at enqueue time would produce orphan/duplicate rows that never
  run.
- Keeps every write on the worker side → one owner of the table, simpler tests.
- The **"Queued"** UI state is derived for free: connection
  `lastSyncStatus === "pending"` **and** no `activeRun` ⇒ "Queued". (This is the
  state that was invisible during the original bug.) No row needed to show it.

## 6. Worker instrumentation

### 6.1 `SyncRunRecorder` (`packages/trpc/lib/socialSync/syncRunRecorder.ts`)

A small class that owns all writes to `socialSyncRuns`. Depends only on `db` +
schema, so it unit-tests in isolation and keeps `run()` readable.

```ts
class SyncRunRecorder {
  // Inserts a `running` row and returns a recorder bound to it.
  // NEVER throws: on insert failure it logs and returns a no-op recorder
  // (runId = null, all methods become logged no-ops) so run() always gets a
  // usable object and tracking can never break the actual sync.
  static async start(args: {
    connectionId: string;
    trigger: "manual" | "scheduled";
    jobId?: string;
  }): Promise<SyncRunRecorder>;

  setPhase(phase: "fetching" | "importing" | "finalizing"): Promise<void>;
  incrementPages(): Promise<void>;          // pagesScanned += 1
  setItemsFound(n: number): Promise<void>;  // denominator
  incrementImported(): Promise<void>;       // itemsImported += 1
  incrementFailed(): Promise<void>;         // itemsFailed += 1
  finishSuccess(): Promise<void>;           // status=success, finishedAt=now, phase=null
  finishFailure(error: string): Promise<void>; // status=failure, error, finishedAt=now
}
```

- All counter updates use SQL expressions (`sql\`... + 1\``) like the existing
  `totalSynced` update — concurrent-safe and cheap.
- **Best-effort / null-object:** every method wraps its write so a tracking
  failure logs and returns rather than throwing into `run()`. `start()` follows
  the same contract: if the INSERT fails it returns a no-op recorder. Net result:
  `run()` never has to null-check or try/catch the recorder.
- Per-item increments are fine on local SQLite (the import loop already does
  several writes per item); throttling (update every N items) is a future option
  if volume ever warrants, not needed now.

### 6.2 `onPage` hook in `planSync` (`packages/trpc/lib/socialSync/syncEngine.ts`)

Add one optional field to `PlanSyncInput`:

```ts
/** Called once after each page is fetched. Pure observability hook. */
onPage?: (pagesScanned: number) => void | Promise<void>;
```

Invoked right after `pages++` in the existing loop. Default undefined → no
behavior change. This is the only change to the (otherwise frozen) sync
algorithm, and it is purely additive.

### 6.3 `run()` changes (`apps/workers/workers/socialSyncWorker.ts`)

Wrap the existing body so every exit path finalizes the row:

```
recorder = await SyncRunRecorder.start({ connectionId, trigger, jobId: req.id })
try {
  // connection not found/disabled → recorder.finishFailure("disabled"/"not found"); return
  // decrypt fail (existing branch)  → recorder.finishFailure("Failed to decrypt…")
  recorder.setPhase("fetching")
  result = planSync({ …, onPage: () => recorder.incrementPages() })
     // 401/403 branch → recorder.finishFailure("Authentication expired…")
  recorder.setItemsFound(result.newItems.length)
  recorder.setPhase("importing")
  for item of result.newItems:
     try { createBookmark + tags + history; recorder.incrementImported() }
     catch { recorder.incrementFailed() }   // was: only logger.warn
  recorder.setPhase("finalizing")
  // existing connection update (lastSyncedAt, totalSynced, …)
  recorder.finishSuccess()
} catch (e) {
  recorder.finishFailure(String(e))
  throw e   // preserve liteque retry semantics
}
```

Notes:

- `trigger` comes from `req.data.trigger`.
- The timeout/abort path surfaces in `run()` as a thrown `AbortError` (liteque
  aborts the signal then rejects) → caught by the outer `catch` →
  `finishFailure` → rethrow. So timeouts are recorded, not lost.
- The existing connection-row updates stay; `socialSyncRuns` is additive. The
  card's coarse last-status line keeps working unchanged.
- A retried job runs `run()` again → a **new** run row per attempt, so history
  naturally shows each retry.

### 6.4 Stale-run sweep (`SocialSyncRefreshingWorker` cron, same file)

The every-minute cron additionally marks any `socialSyncRuns` row that is still
`running` with `startedAt` older than `timeoutSecs + grace` (e.g. 60s + 120s =
180s) as `failure`, `error = "Run timed out"`. Normally the worker itself
finalizes a timed-out run (§6.3); the sweep only covers a hard process hang
where no `catch` runs. Single global
`UPDATE … WHERE status='running' AND startedAt < ?` (no user scoping needed).

## 7. Read API (tRPC, `packages/trpc/routers/socialSync.ts`)

Read-only, using the existing `socialSyncProcedure` (API-key callers need the
`socialSync` read scope; session callers always pass) and the existing
`ensureConnectionOwnership` middleware.

### 7.1 Extend `getConnections`

Embed the current active run so the existing card query drives the live bar:

```ts
// for each connection, its current running row (latest by startedAt) or null
activeRun: { id, phase, pagesScanned, itemsFound, itemsImported,
             itemsFailed, startedAt } | null
```

- Implementation: one query for `status='running'` rows across the user's
  connection IDs, keyed by `connectionId` (avoids N+1).
- **Latest by `startedAt`:** a re-claimed timed-out job can briefly leave two
  `running` rows for one connection (old stuck row + new attempt); pick the most
  recent so the bar tracks the live attempt. The sweep (§6.4) clears the stale
  one shortly after.
- Adding a field is backward-compatible for existing callers (mobile/extension).

### 7.2 New `getRuns`

```ts
getRuns: socialSyncProcedure
  .input(z.object({ connectionId: z.string(), limit: z.number().max(50).default(10) }))
  .use(ensureConnectionOwnership)
  .query(...)  // recent runs for the connection, newest first
```

Returns: `id, trigger, status, itemsImported, itemsFailed, error, startedAt,
finishedAt` (duration derived client-side). Fetched lazily when the user expands
"Recent runs".

## 8. UI (`apps/web/components/settings/`)

`SocialSyncSettings.tsx` is already ~390 lines. Add two small focused components
rather than growing it.

### 8.1 `SocialSyncProgress.tsx`

Props: the `activeRun` from `getConnections`. Renders nothing if null.

- **Fetching** phase → indeterminate bar + "Scanning saved feed… page N".
- **Importing** phase → determinate bar `itemsImported / itemsFound` + count
  text "62 / 100 imported" (+ "N failed" if `itemsFailed > 0`).
- **Finalizing** → near-full bar + "Finishing…".
- When the connection's `backfillComplete` is false, show the existing
  backfilling hint (more saved history will import over subsequent runs) so a
  capped 100-item run doesn't read as "done forever".
- Elapsed time from `startedAt` via the existing `RelativeTime` /
  `useRelativeTime` (`apps/web/components/ui/relative-time.tsx`).
- Use the shadcn `Progress` component if present in
  `apps/web/components/ui`; otherwise a minimal Tailwind bar.

### 8.2 `SocialSyncRunHistory.tsx`

Props: `connectionId`. A collapsible "Recent runs" section that lazily calls
`getRuns` when opened.

- Each row: status icon (✓ success / ✗ failure / spinner running), relative
  start time, `+N imported` (and `N failed` muted), duration
  (`finishedAt − startedAt`), trigger badge (Manual/Scheduled), error text on
  failure.
- Empty state: "No sync runs yet."

### 8.3 Wire into `PlatformCard`

- Render `<SocialSyncProgress run={connection.activeRun} />` above the
  stats line; `<SocialSyncRunHistory connectionId={connection.id} />` below the
  action buttons.
- **Poll only while active**: set the `getConnections` query
  `refetchInterval` to a function of the query data —
  `(query) => query.state.data?.some((c) => c.activeRun) ? 2000 : false`. Idle
  cards do not poll.
- After `syncNow`/`connect` mutations, invalidate `getConnections` (already
  done) so the active run/poll picks up promptly.

### 8.4 i18n

Add `social_sync.*` keys next to the existing block
(`apps/web/lib/i18n/locales/en/translation.json`, ~line 1203). New keys (English
source; other locales fall back to English as elsewhere):

```
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

## 9. Error handling

| Situation | Behavior |
|---|---|
| Per-item bookmark failure | `recorder.incrementFailed()` + keep existing `logger.warn`; run still `success`, history shows "N failed" |
| Connection disabled / not found | `finishFailure` with reason; return (no throw) |
| Cookie decrypt failure | existing branch + `finishFailure`; connection disabled as today |
| 401/403 auth expired | existing branch + `finishFailure("Authentication expired…")` |
| Timeout / abort | thrown into `run()` → outer catch → `finishFailure("Run timed out"…)` → rethrow (liteque retries) |
| Process hard-hang (no throw) | stale-run sweep flips row to `failure` after grace |
| Recorder write itself fails | logged, swallowed — never breaks the sync (null-object) |
| Retry of a failed job | a **new** run row per attempt (each `run()` call = one row); history naturally shows the retries |

## 10. Testing (TDD)

- **`planSync` `onPage`** — pure unit test: a fake provider yielding K pages
  invokes `onPage` exactly K times with increasing counts; absence of `onPage`
  changes nothing (mirrors existing `syncEngine` tests if present).
- **`SyncRunRecorder`** — lifecycle against an in-memory/better-sqlite test db:
  `start` inserts a `running` row; increments accumulate; `finishSuccess` /
  `finishFailure` set terminal status, `finishedAt`, and (for failure) `error`.
  Also: a forced insert/write failure yields a no-op recorder that never throws.
- **Stale-run sweep** — a `running` row with an old `startedAt` is flipped to
  `failure` ("Run timed out") by the sweep; a recent `running` row is untouched.
- **Router** — extend `packages/trpc/routers/socialSync.test.ts` (existing):
  `getRuns` returns rows newest-first and rejects cross-user access
  (ownership); `getConnections.activeRun` is the running row (latest by
  `startedAt`) or null.
- **Worker `run()`** — instrumentation test (mock provider + trpc client):
  success path produces one `success` row with correct
  imported/failed/found/pages; a thrown provider error produces a `failure`
  row with the error and rethrows.
- **Manual verification** — connect a real account, click Sync Now, watch the
  bar advance (fetching → importing count → done) and a row land in "Recent
  runs"; force an auth failure and confirm a `failure` row with the message.

## 11. Files touched

**New**

- `packages/trpc/lib/socialSync/syncRunRecorder.ts`
- `packages/trpc/lib/socialSync/syncRunRecorder.test.ts`
- `packages/db/drizzle/00XX_add_social_sync_runs.sql` (generated)
- `apps/web/components/settings/SocialSyncProgress.tsx`
- `apps/web/components/settings/SocialSyncRunHistory.tsx`

**Modified**

- `packages/db/schema.ts` — `socialSyncRuns` table + relations
- `packages/shared-server/src/queues.ts` — `trigger` on request schema
- `packages/trpc/lib/socialSync/syncEngine.ts` — `onPage` hook
- `packages/trpc/lib/socialSync/syncEngine.test.ts` — onPage test (if file exists)
- `apps/workers/workers/socialSyncWorker.ts` — recorder wiring, trigger,
  failed-count, stale sweep
- `packages/trpc/routers/socialSync.ts` — `activeRun` on getConnections,
  `getRuns`
- `packages/trpc/routers/socialSync.test.ts` — getRuns / activeRun tests
- `packages/shared/types/socialSync.ts` — shared run/phase/trigger types if
  needed by the UI
- `apps/web/components/settings/SocialSyncSettings.tsx` — wire components + poll
- `apps/web/lib/i18n/locales/en/translation.json` — new keys
- enqueue sites for `trigger` (`socialSync.ts` router; cron in worker)

## 12. Out of scope / future

- Generic per-worker tracking for all queues (would touch the fixed queue core).
- Push updates (websockets/SSE) — poll-only for now.
- Retention/pruning of old run rows (acceptable to keep all initially; a future
  cron can trim to last N per connection if volume warrants).
- Cross-platform "activity feed" — would add `userId` back to `socialSyncRuns`
  with a `userId, startedAt` index at that time.

# Social Sync Worker Reliability Fix Report

Date: 2026-05-31

## Summary

The Instagram "Sync Now" issue was caused by the Liteque worker runner failing after claiming a job but before invoking the social-sync job body. Jobs moved to `running`, `numRunsLeft` decreased, but `[social-sync] Starting sync run` never logged because the runner died in the queue adapter.

The fix replaces the unsafe Liteque runner path used by Karakeep with a synchronous SQLite dequeue/finalize implementation, makes runner failures visible, and adds social-sync-specific hardening around validation, enqueue handling, and Instagram fetch timeouts.

## Issues Found

### 1. Liteque claimed jobs before failing

`liteque@0.8.0` calls `better-sqlite3` transactions with an `async` callback. `better-sqlite3` rejects that pattern with:

```text
TypeError: Transaction function cannot return a promise
```

In practice, the async transaction callback could still advance far enough to mark the task as `running` and decrement retries, then the runner rejected before calling the worker's `run()` function.

Evidence:

- Social-sync jobs were stuck in `running`.
- `numRunsLeft` changed from `3` to `2`.
- The first line inside social-sync `run()` never logged.
- A Node 24 container reproduction triggered the same `better-sqlite3` transaction error.

Fix:

- Replaced the unsafe Liteque runner usage in `packages/plugins/queue-liteque/src/index.ts`.
- Added a synchronous raw SQLite `attemptDequeue` implementation.
- Kept Liteque's task semantics: `pending`, `pending_retry`, expired `running`, retry counts, `expireAt`, `availableAt`, and failed-job deletion behavior.

### 2. Job claim happened before concurrency capacity was secured

The upstream runner waited for an unlock, claimed a job, then acquired the semaphore. That leaves a small but real gap where a task can be marked `running` before execution capacity is actually held.

Fix:

- The Karakeep Liteque runner now acquires the concurrency slot before claiming a task.
- The slot is released exactly once after the job finishes or dequeue fails.

### 3. Runner loop failures were silent at the process level

`apps/workers/index.ts` used `Promise.any`, which allowed one worker promise to reject while the overall process kept running. That made partial worker death hard to notice because cron and HTTP health checks still worked.

Fix:

- Worker promises are now wrapped with explicit error logging.
- `Promise.race` is used so unexpected worker termination moves the process into shutdown instead of continuing in a partially-dead state.

### 4. Social-sync jobs were missing queue payload validation

Most other workers pass a Zod validator to `createRunner`, but social-sync did not.

Fix:

- Added `zSocialSyncRequestSchema` as the social-sync runner validator.

### 5. Instagram saved-post fetch had no timeout

`validateAuth` used a timeout, but `fetchSavedItems` did not. Once jobs start running correctly, a stuck Instagram request could hold a job until the runner timeout.

Fix:

- Added a 10 second timeout to Instagram saved-post fetches.
- Propagated the queue job abort signal through `planSync` into provider `fetchSavedItems`.

### 6. Enqueue failures were not awaited consistently

`connect`, `syncNow`, and the refresh cron enqueued social-sync jobs without consistently awaiting or logging failures.

Fix:

- `connect` and `syncNow` now await `SocialSyncQueue.enqueue`.
- The refresh cron awaits enqueue calls and logs scheduling failures.
- `syncNow` resets `lastSyncStatus` to `pending` and clears `lastSyncError` after enqueue.

## Files Changed

- `packages/plugins/queue-liteque/src/index.ts`
- `packages/plugins/queue-liteque/src/tests/queue.test.ts`
- `packages/plugins/vitest.config.ts`
- `apps/workers/index.ts`
- `apps/workers/workers/socialSyncWorker.ts`
- `packages/shared/types/socialSync.ts`
- `packages/trpc/lib/socialSync/syncEngine.ts`
- `packages/trpc/lib/socialSync/instagramProvider.ts`
- `packages/trpc/lib/socialSync/instagramProvider.test.ts`
- `packages/trpc/routers/socialSync.ts`

## Verification

Passed:

```text
pnpm typecheck
23/23 tasks passed

pnpm lint
20/20 tasks passed

pnpm format
21/21 tasks passed

pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/instagramProvider.test.ts lib/socialSync/syncEngine.test.ts
41/41 tests passed

pnpm --filter @karakeep/workers build
passed
```

The worker build emitted an existing optional unresolved-import warning for `@node-rs/xxhash` from Redis client code. It did not fail the build.

Container verification on Node 24:

- Patched Liteque runner with validator: job processed, queue stats drained to zero.
- Patched Liteque runner without validator: job processed, queue stats drained to zero.

Local gap:

- Running the new Liteque Vitest file locally is blocked because this machine is on Node 26 and `liteque` depends on a nested `better-sqlite3@11.3.0` binding that cannot load/build on Node 26.
- The project `.nvmrc` is Node 24, and the Node 24 container verification passed.

## Operational Note

The currently running `engram-web-1` container still uses the old image until it is rebuilt and restarted. The source fix is in the workspace, but the live stack must pick up the rebuilt worker bundle before Instagram sync jobs will drain in that container.

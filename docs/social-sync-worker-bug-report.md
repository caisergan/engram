# Bug Report: Social Sync jobs are enqueued but never executed by the worker

**Date:** 2026-05-31
**Branch:** `feat/social-sync`
**Severity:** High — the Instagram social-sync feature connects/authenticates correctly but **never imports any bookmarks**. Jobs pile up in the queue.
**Status:** Root cause NOT yet found. This report hands off a fully-narrowed investigation.

---

## 1. Symptom

- User connects Instagram successfully (auth works — see §3).
- Clicking **Sync Now** shows toast "Sync started for Instagram".
- UI shows **"0 bookmarks synced"** and **"Importing saved history…"** indefinitely.
- No bookmarks are ever created; no error is surfaced anywhere.

## 2. TL;DR of the finding

`socialSync.syncNow` / `connect` **enqueue** jobs into the liteque queue correctly. The
**social-sync runner dequeues a job (marks it `running`, decrements `numRunsLeft`) but the
job body `run()` never executes its very first line** (`logger.info("[social-sync]… Starting
sync run")`). The job then sits in `running` forever (past its `expireAt`), and the 60s
runner timeout never finalizes it. No errors, no crash, no stack trace anywhere.

So the failure is **between liteque's `attemptDequeue` and the invocation of the worker's
`run()` function** — or the worker process's event loop is blocked right after dequeue.

## 3. What WORKS (already fixed earlier this session, committed)

- **Cookie parsing** — `normalizeCookieInput()` in `packages/shared/types/socialSync.ts`
  now accepts Cookie-Editor array exports, flat objects, and raw cookie strings.
  (commit `1bb00d03`)
- **Instagram auth / SecFetch** — provider now sends `Sec-Fetch-Site: same-origin`
  (+ `Mode`/`Dest`) in `buildHeaders` (`packages/trpc/lib/socialSync/instagramProvider.ts`).
  (commit `1bb00d03`)
- Verified **from inside the running container**: the Instagram validate endpoint returns
  **HTTP 200** with the stored cookies + provider headers. Auth and network egress are fine.
- `validateAuth` returns `true` end-to-end (parse → fetch 200). The connection row exists and
  is `enabled`.

## 4. Evidence

### 4a. Queue DB (`/data/queue.db`, table `tasks`, liteque v0.8.0)

Only `social_sync_queue` has rows. Before my container restart, all 4 were `pending`,
`numRunsLeft: 3` (i.e. **never attempted**). After a restart, one moved to `running`:

```
id=1 status=running    numRunsLeft=2  expireAt=1780241488  availableAt=1780240609060
id=2 status=pending     numRunsLeft=3  expireAt=null         availableAt=1780240620824  (idempotencyKey "sync:<conn>:494511" — enqueued by the cron)
id=4 status=pending     numRunsLeft=3  expireAt=null         availableAt=1780240681450
id=5 status=pending     numRunsLeft=3  expireAt=null         availableAt=1780240712252
```

- Job #1: `numRunsLeft` went 3→2 and status→`running` after restart → it **was claimed once**.
- It then stayed `running` well past `expireAt` (1780241488 ≈ 15:31:28) without being
  finalized to `pending_retry`. The 60s runner timeout did not fire.
- The dequeue query (liteque `attemptDequeue`, `node_modules/liteque/dist/index.js:103`)
  returns all 4 jobs as **eligible** (replicated read-only: `now_ms > availableAt`, status
  pending). `availableAt` is `timestamp_ms`, `createdAt` is `timestamp` (seconds) — that
  seconds/ms mix in one row is **normal for liteque** (different column modes), NOT a bug.

### 4b. App DB (`/data/db.db`)

```
socialSyncConnections: lastSyncStatus="pending", lastSyncedAt=null, totalSynced=0, backfillComplete=0
socialSyncHistory: 0 rows
bookmarks WHERE source='sync': 0
```

Connection id: `duh4ua8jzmtv6615la5gcz55`, platform `instagram`, `enabled=1`.

### 4c. Worker process logs (`docker compose -p engram logs web`)

- `Starting social sync worker ...` logs at startup (twice total = original boot + my manual
  restart; **not** a crash loop).
- The every-minute cron `SocialSyncRefreshingWorker` **fired** (it enqueued job #2 with the
  `sync:<conn>:<slot>` idempotency key) → **the worker process is alive**.
- **Never appears:** `[social-sync][…] Starting sync run`, `Sync complete`, `Job completed`,
  `Job failed`, any stack trace, any `Timeout`, any `error`.
- `grep -c "Starting sync run" /app/apps/workers/dist/index.js` → `1` (the log line **is**
  present in the compiled bundle as `logger_default.info(...)`).

### 4d. Process health

`docker inspect engram-web-1`: `RestartCount=0`, `Status=running`, `OOMKilled=false`.
All-in-one container (s6-overlay) runs `svc-web` and `svc-workers` as separate processes;
web HTTP logs flow continuously, so web is fine. Workers process is up (cron proves it).

## 5. Hypotheses RULED OUT

- ❌ Cookie format / auth — fixed and verified (200 from container).
- ❌ Network egress to Instagram — 200 from inside the container.
- ❌ `availableAt` scheduling/clock skew — jobs are eligible (`now > availableAt`).
- ❌ Queue not registered — `createRunner` (`packages/plugins/queue-liteque/src/index.ts:95-99`)
  throws "Queue not found" if unregistered; it didn't, and jobs DO get claimed.
- ❌ Worker disabled — it logs "Starting social sync worker"; build() is only called for
  enabled workers (`apps/workers/index.ts:120-127`).
- ❌ Process crash loop — `RestartCount=0`, single boot per lifecycle.
- ❌ Bad auth causing 401/403 path — that path sets `lastSyncStatus="failure"` and a specific
  error; we see `pending`, not `failure`.

## 6. LEADING hypotheses (for the next agent)

The job is dequeued (status→running, numRunsLeft decremented) but `run()`'s first line never
logs and the job never finalizes. The fault is in the narrow window in liteque's
`runImpl`/`runOnce` (`node_modules/liteque/dist/index.js:206-266`) between `attemptDequeue`
(211) and `funcs.run(dequeuedJob)` (261), OR the worker event loop is blocked right after.

1. **Semaphore deadlock at `concurrency: 1`.** The social-sync runner is created with
   `concurrency: 1` (`apps/workers/workers/socialSyncWorker.ts:212`). liteque's loop does
   `await semaphore.waitForUnlock()` (210) then `await semaphore.acquire()` (226) before
   `runOnce`. A bug/edge case in liteque's `Semaphore` at concurrency 1 could let dequeue
   happen but block before `runOnce`, leaving the job `running` and the loop stuck. **Most
   other workers use concurrency > 1** — social sync is unusual here. **Test:** bump
   concurrency to 2+ and see if jobs drain.

2. **Missing `validator` differentiates social-sync from every other worker.** All other
   `createRunner` calls pass `validator: zXxxRequestSchema`; the social-sync one does NOT
   (`socialSyncWorker.ts:211-215`). In `runOnce` (`liteque…:240`) `validator` is only used if
   present, so this *shouldn't* matter — but it's the clearest code-level difference. **Test:**
   add `validator: zSocialSyncRequestSchema`.

3. **Bundling / circular-import making a runtime symbol undefined.** The worker is shipped as
   a bundled `apps/workers/dist/index.js` (tsdown). `run()` imports heavily from
   `@karakeep/trpc` (`buildImpersonatingTRPCClient` from `"trpc"`, `decryptCookies`,
   `getProvider`, `planSync`). If a circular import left `logger_default` (or another symbol)
   in a TDZ/undefined state *only along the run() call path*, the first `logger_default.info`
   could throw a TypeError that is swallowed oddly. (Counter-evidence: startup logging via the
   same logger works, and an immediate throw should rapidly drive `numRunsLeft` to 0 — we see
   it stuck at 2. So this is weaker, but worth checking the bundled call graph.)

4. **Silent runner-loop death on a prior attempt.** liteque's `runImpl` while-loop does NOT
   wrap `attemptDequeue` in try/catch. If `attemptDequeue` (a DB transaction) ever throws, the
   `run()` promise rejects; in `apps/workers/index.ts:150-157` that rejection is swallowed by
   `Promise.any([...])` (it only rejects if ALL reject), so a single runner can die while the
   process lives (crons keep firing). This explains why the **pre-restart** runner consumed
   nothing. It does not by itself explain the post-restart `running`-but-no-log state.

## 7. How to reproduce / observe

```bash
# Worker activity (live):
docker compose -p engram logs -f web | grep -iE "social-sync|social sync"

# Queue state:
docker exec engram-web-1 sh -lc 'cd /app/apps/web && node -e "
const D=require(\"better-sqlite3\");const db=new D(\"/data/queue.db\",{readonly:true});
console.log(JSON.stringify(db.prepare(\"SELECT id,status,numRunsLeft,availableAt,expireAt FROM tasks WHERE queue=\\047social_sync_queue\\047 ORDER BY id\").all(),null,1))"'

# Connection / results:
docker exec engram-web-1 sh -lc 'cd /app/apps/web && node -e "
const D=require(\"better-sqlite3\");const db=new D(\"/data/db.db\",{readonly:true});
console.log(db.prepare(\"SELECT lastSyncStatus,totalSynced,backfillComplete FROM socialSyncConnections\").all());
console.log(\"history:\", db.prepare(\"SELECT COUNT(*) c FROM socialSyncHistory\").get().c)"'
```

**Best repro for debugging:** run the workers locally **unbundled** (`pnpm workers`, Node 24)
against a DB with a connected Instagram account, set a breakpoint / add logging in liteque's
`runImpl`/`runOnce` and in `socialSyncWorker.run`, and watch whether `funcs.run` is invoked.
The bundled container build hides stack traces; local source will not.

## 8. Suggested next steps (in priority order)

1. Reproduce locally with `pnpm workers` and add a `console.error` at the very top of
   `run()` in `socialSyncWorker.ts` AND inside liteque's `runOnce` right before `funcs.run`.
   Determine definitively whether `funcs.run` is called.
2. Add `validator: zSocialSyncRequestSchema` and bump `concurrency` to match other workers;
   re-test (cheap, high-signal — addresses hypotheses 1 & 2).
3. Wrap the liteque runner loop body (or our `createRunner` wrapper in
   `packages/plugins/queue-liteque/src/index.ts`) so `attemptDequeue` errors are logged and
   the loop self-heals instead of dying silently (addresses hypothesis 4 regardless).
4. Add an `AbortSignal.timeout` to `instagramProvider.fetchSavedItems` (currently the
   saved-posts `fetch` has NO timeout, unlike `validateAuth`) — not the current root cause but
   a latent hang risk once jobs do run. See `instagramProvider.ts:83-86`.
5. Add user-visible sync progress/error surfacing (the connection's `lastSyncError` is shown
   in the UI but nothing populates it when the job silently never runs).

## 9. Key code locations

| What | File:line |
|------|-----------|
| Worker job body (`run`) + first log line | `apps/workers/workers/socialSyncWorker.ts:25,27` |
| Runner creation (concurrency:1, NO validator) | `apps/workers/workers/socialSyncWorker.ts:188-216` |
| Refresh cron (enqueues due connections) | `apps/workers/workers/socialSyncWorker.ts:221-265` |
| Worker bootstrap + `worker.run()` fan-out + swallowing `Promise.any` | `apps/workers/index.ts:91-94,120-157` |
| `syncNow` / `connect` enqueue | `packages/trpc/routers/socialSync.ts:105-108,185-188` |
| Queue definitions (`SocialSyncQueue`, numRetries:2) | `packages/shared-server/src/queues.ts:241-250` |
| Liteque plugin `createRunner` + `wrappedRun` | `packages/plugins/queue-liteque/src/index.ts:90-136` |
| Liteque `attemptDequeue` / `runImpl` / `runOnce` | `node_modules/liteque/dist/index.js:101-120,206-266` |

## 10. Current live state (for the next agent to inspect)

- Container `engram-web-1` is running; web healthy at `http://localhost:3030`.
- `/data/queue.db` has 4 `social_sync_queue` jobs (1 `running`, 3 `pending`) — left in place
  intentionally so the bug is reproducible.
- Connection `duh4ua8jzmtv6615la5gcz55` is connected/enabled, 0 synced.
- ⚠️ The stored Instagram `sessionid` was pasted into chat earlier and should be rotated
  (log out that IG session / change password) once debugging no longer needs live cookies.

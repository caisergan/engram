import path from "node:path";
import { Semaphore } from "async-mutex";
import {
  buildDBClient,
  SqliteQueue as LQ,
  migrateDB,
  RetryAfterError,
} from "liteque";

import type { PluginProvider } from "@karakeep/shared/plugins";
import type {
  DequeuedJob,
  EnqueueOptions,
  Queue,
  QueueClient,
  QueueOptions,
  Runner,
  RunnerFuncs,
  RunnerOptions,
} from "@karakeep/shared/queueing";
import logger from "@karakeep/shared/logger";
import serverConfig from "@karakeep/shared/config";
import { QueueRetryAfterError } from "@karakeep/shared/queueing";

type LitequeTaskStatus = "pending" | "running" | "pending_retry" | "failed";

interface LitequeTaskRow {
  id: number;
  queue: string;
  payload: string;
  createdAt: number;
  availableAt: number | null;
  status: LitequeTaskStatus;
  expireAt: number | null;
  allocationId: string;
  numRunsLeft: number;
  maxNumRuns: number;
  idempotencyKey: string | null;
  priority: number;
}

interface RawSqliteRunResult {
  changes: number;
}

interface RawSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RawSqliteRunResult;
}

interface RawSqliteDatabase {
  prepare(sql: string): RawSqliteStatement;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult;
  close(): void;
}

function generateAllocationId() {
  return Math.random().toString(36).substring(2, 15);
}

function isLitequeTaskStatus(value: unknown): value is LitequeTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "pending_retry" ||
    value === "failed"
  );
}

function isLitequeTaskRow(value: unknown): value is LitequeTaskRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "number" &&
    typeof row.queue === "string" &&
    typeof row.payload === "string" &&
    typeof row.createdAt === "number" &&
    (typeof row.availableAt === "number" || row.availableAt === null) &&
    isLitequeTaskStatus(row.status) &&
    (typeof row.expireAt === "number" || row.expireAt === null) &&
    typeof row.allocationId === "string" &&
    typeof row.numRunsLeft === "number" &&
    typeof row.maxNumRuns === "number" &&
    (typeof row.idempotencyKey === "string" || row.idempotencyKey === null) &&
    typeof row.priority === "number"
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatError(error: unknown) {
  const err = asError(error);
  return `${err.message}\n${err.stack}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LitequeQueueWrapper<T> implements Queue<T> {
  constructor(
    private readonly _name: string,
    private readonly lq: LQ<T>,
    public readonly opts: QueueOptions,
    private readonly rawDb: RawSqliteDatabase,
  ) {}

  ensureInit(): Promise<void> {
    return Promise.resolve();
  }

  name(): string {
    return this._name;
  }

  async enqueue(
    payload: T,
    options?: EnqueueOptions,
  ): Promise<string | undefined> {
    const job = await this.lq.enqueue(payload, options);
    // liteque returns a Job with numeric id
    return job ? String(job.id) : undefined;
  }

  async stats() {
    return this.lq.stats();
  }

  async cancelAllNonRunning(): Promise<number> {
    return this.lq.cancelAllNonRunning();
  }

  attemptDequeue(options: { timeoutSecs: number }): LitequeTaskRow | null {
    const nowMs = Date.now();
    const nowSecs = Math.floor(nowMs / 1000);

    return this.rawDb.transaction(() => {
      const row = this.rawDb
        .prepare(
          `SELECT id, queue, payload, createdAt, availableAt, status, expireAt,
                  allocationId, numRunsLeft, maxNumRuns, idempotencyKey, priority
             FROM tasks
            WHERE queue = ?
              AND (availableAt <= ? OR availableAt IS NULL)
              AND (
                status IN ('pending', 'pending_retry')
                OR (status = 'running' AND expireAt < ?)
              )
            ORDER BY priority ASC, createdAt ASC
            LIMIT 1`,
        )
        .get(this._name, nowMs, nowSecs);

      if (!row) return null;
      if (!isLitequeTaskRow(row)) {
        throw new Error(`Invalid liteque task row for queue ${this._name}`);
      }

      if (row.numRunsLeft === 0) {
        this.finalize(row.id, row.allocationId, "failed");
        return null;
      }

      const nextAllocationId = generateAllocationId();
      const updated = this.rawDb
        .prepare(
          `UPDATE tasks
              SET status = 'running',
                  numRunsLeft = numRunsLeft - 1,
                  allocationId = ?,
                  expireAt = ?
            WHERE id = ?
              AND allocationId = ?
          RETURNING id, queue, payload, createdAt, availableAt, status, expireAt,
                    allocationId, numRunsLeft, maxNumRuns, idempotencyKey, priority`,
        )
        .get(
          nextAllocationId,
          nowSecs + options.timeoutSecs,
          row.id,
          row.allocationId,
        );

      if (!updated) return null;
      if (!isLitequeTaskRow(updated)) {
        throw new Error(
          `Invalid updated liteque task row for queue ${this._name}`,
        );
      }
      return updated;
    })();
  }

  finalize(
    id: number,
    allocationId: string,
    status: "completed" | "failed" | "pending_retry",
    availableAt = new Date(),
    refundRetry = false,
  ) {
    if (
      status === "completed" ||
      (status === "failed" && !this.opts.keepFailedJobs)
    ) {
      this.rawDb
        .prepare("DELETE FROM tasks WHERE id = ? AND allocationId = ?")
        .run(id, allocationId);
      return;
    }

    this.rawDb
      .prepare(
        `UPDATE tasks
            SET status = ?,
                expireAt = NULL,
                availableAt = ?,
                numRunsLeft = numRunsLeft + ?
          WHERE id = ?
            AND allocationId = ?`,
      )
      .run(
        status,
        availableAt.getTime(),
        refundRetry ? 1 : 0,
        id,
        allocationId,
      );
  }
}

class LitequeQueueClient implements QueueClient {
  private readonly db = buildDBClient(
    path.join(serverConfig.dataDir, "queue.db"),
    {
      walEnabled: serverConfig.database.walMode,
    },
  );

  private readonly rawDb = (
    this.db as unknown as { session: { client: RawSqliteDatabase } }
  ).session.client;

  private queues = new Map<string, LitequeQueueWrapper<unknown>>();

  async prepare(): Promise<void> {
    migrateDB(this.db);
  }

  async start(): Promise<void> {
    // No-op for sqlite
  }

  createQueue<T>(name: string, options: QueueOptions): Queue<T> {
    if (this.queues.has(name)) {
      throw new Error(`Queue ${name} already exists`);
    }
    const lq = new LQ<T>(name, this.db, {
      defaultJobArgs: { numRetries: options.defaultJobArgs.numRetries },
      keepFailedJobs: options.keepFailedJobs,
    });
    const wrapper = new LitequeQueueWrapper<T>(name, lq, options, this.rawDb);
    this.queues.set(name, wrapper);
    return wrapper;
  }

  createRunner<T, R = void>(
    queue: Queue<T>,
    funcs: RunnerFuncs<T, R>,
    opts: RunnerOptions<T>,
  ): Runner<T> {
    const name = queue.name();
    let wrapper = this.queues.get(name);
    if (!wrapper) {
      throw new Error(`Queue ${name} not found`);
    }

    const runner = new LitequeRunner<T, R>(name, wrapper, funcs, opts);

    return {
      run: () => runner.run(),
      stop: () => runner.stop(),
      runUntilEmpty: () => runner.runUntilEmpty(),
    };
  }

  async shutdown(): Promise<void> {
    this.rawDb.close();
  }
}

class LitequeRunner<T, R = void> implements Runner<T> {
  private stopping = false;

  constructor(
    private readonly name: string,
    private readonly queue: LitequeQueueWrapper<T>,
    private readonly funcs: RunnerFuncs<T, R>,
    private readonly opts: RunnerOptions<T>,
  ) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`Queue ${name} must use a positive integer concurrency`);
    }
  }

  async run() {
    await this.runImpl(false);
  }

  stop() {
    this.stopping = true;
  }

  async runUntilEmpty() {
    await this.runImpl(true);
  }

  private async runImpl(breakOnEmpty: boolean) {
    const semaphore = new Semaphore(this.opts.concurrency);
    const inFlight = new Map<number, Promise<void>>();

    while (!this.stopping) {
      const [, release] = await semaphore.acquire();
      let released = false;
      const releaseSlot = () => {
        if (!released) {
          released = true;
          release();
        }
      };

      try {
        const job = this.queue.attemptDequeue({
          timeoutSecs: this.opts.timeoutSecs,
        });

        if (!job) {
          releaseSlot();
          if (inFlight.size > 0 || !breakOnEmpty) {
            await sleep(this.opts.pollIntervalMs ?? 1000);
            continue;
          }

          const queueStats = await this.queue.stats();
          if (queueStats.pending + queueStats.pending_retry > 0) {
            await sleep(this.opts.pollIntervalMs ?? 1000);
            continue;
          }
          break;
        }

        const running = this.runOnce(job)
          .catch((error: unknown) => {
            logger.error(
              `[queue-liteque][${this.name}][${job.id}] Runner failed: ${formatError(error)}`,
            );
          })
          .finally(() => {
            inFlight.delete(job.id);
            releaseSlot();
          });
        inFlight.set(job.id, running);
      } catch (error: unknown) {
        releaseSlot();
        logger.error(
          `[queue-liteque][${this.name}] Dequeue failed, retrying: ${formatError(error)}`,
        );
        await sleep(this.opts.pollIntervalMs ?? 1000);
      }
    }

    await Promise.allSettled(inFlight.values());
  }

  private async runOnce(job: LitequeTaskRow) {
    const runNumber = job.maxNumRuns - job.numRunsLeft - 1;
    let parsed: T;

    try {
      const raw = JSON.parse(job.payload) as unknown;
      parsed = this.opts.validator
        ? this.opts.validator.parse(raw)
        : (raw as T);
    } catch (error: unknown) {
      await this.notifyError(job, undefined, asError(error), runNumber);
      this.queue.finalize(
        job.id,
        job.allocationId,
        job.numRunsLeft <= 0 ? "failed" : "pending_retry",
      );
      return;
    }

    const abortController = new AbortController();
    const dequeuedJob: DequeuedJob<T> = {
      id: job.id.toString(),
      data: parsed,
      priority: job.priority,
      runNumber,
      abortSignal: abortController.signal,
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("Timeout"));
        }, this.opts.timeoutSecs * 1000);
      });

      const result = await Promise.race([
        this.funcs.run(dequeuedJob),
        timeoutPromise,
      ]);
      if (timeout) clearTimeout(timeout);
      await this.funcs.onComplete?.(dequeuedJob, result);
      this.queue.finalize(job.id, job.allocationId, "completed");
    } catch (error: unknown) {
      if (timeout) clearTimeout(timeout);
      if (error instanceof QueueRetryAfterError) {
        this.queue.finalize(
          job.id,
          job.allocationId,
          "pending_retry",
          new Date(Date.now() + error.delayMs),
          true,
        );
        return;
      }
      if (error instanceof RetryAfterError) {
        this.queue.finalize(
          job.id,
          job.allocationId,
          "pending_retry",
          new Date(Date.now() + error.delayMs),
          true,
        );
        return;
      }

      await this.notifyError(job, dequeuedJob, asError(error), runNumber);
      this.queue.finalize(
        job.id,
        job.allocationId,
        job.numRunsLeft <= 0 ? "failed" : "pending_retry",
      );
    }
  }

  private async notifyError(
    job: LitequeTaskRow,
    dequeuedJob: DequeuedJob<T> | undefined,
    error: Error,
    runNumber: number,
  ) {
    await this.funcs
      .onError?.({
        ...(dequeuedJob ?? {
          id: job.id.toString(),
          priority: job.priority,
          runNumber,
        }),
        error,
        numRetriesLeft: job.numRunsLeft,
      })
      .catch((onErrorError: unknown) => {
        logger.error(
          `[queue-liteque][${this.name}][${job.id}] onError failed: ${formatError(onErrorError)}`,
        );
      });
  }
}

export class LitequeQueueProvider implements PluginProvider<QueueClient> {
  private client: QueueClient | null = null;

  async getClient(): Promise<QueueClient | null> {
    if (!this.client) {
      const client = new LitequeQueueClient();
      this.client = client;
    }
    return this.client;
  }
}

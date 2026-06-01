import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { QueueClient } from "@karakeep/shared/queueing";

const requestSchema = z.object({
  connectionId: z.string(),
});

type Request = z.infer<typeof requestSchema>;

describe("Liteque Queue Provider", () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalWalMode = process.env.DB_WAL_MODE;
  const originalNoColor = process.env.NO_COLOR;
  let dataDir: string;
  let queueClient: QueueClient | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "karakeep-liteque-test-"));
    process.env.DATA_DIR = dataDir;
    process.env.DB_WAL_MODE = "false";
    process.env.NO_COLOR = "false";
    vi.resetModules();

    const { LitequeQueueProvider } = await import("../index");
    const provider = new LitequeQueueProvider();
    const client = await provider.getClient();
    if (!client) {
      throw new Error("Failed to create Liteque queue client");
    }
    queueClient = client;
    await queueClient.prepare();
  });

  afterEach(async () => {
    if (queueClient?.shutdown) {
      await queueClient.shutdown();
    }
    await rm(dataDir, { force: true, recursive: true });
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalWalMode === undefined) {
      delete process.env.DB_WAL_MODE;
    } else {
      process.env.DB_WAL_MODE = originalWalMode;
    }
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it("runs queued jobs with better-sqlite3 transactions", async () => {
    if (!queueClient) throw new Error("Queue client was not initialized");
    const queue = queueClient.createQueue<Request>("social-sync-test", {
      defaultJobArgs: { numRetries: 2 },
      keepFailedJobs: false,
    });
    const processed: Request[] = [];

    const runner = queueClient.createRunner(
      queue,
      {
        run: async (job) => {
          processed.push(job.data);
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 1,
        timeoutSecs: 1,
        validator: requestSchema,
      },
    );

    await queue.enqueue({ connectionId: "conn_1" });
    if (!runner.runUntilEmpty) {
      throw new Error("Liteque test runner does not support runUntilEmpty");
    }
    await runner.runUntilEmpty();

    await expect(queue.stats()).resolves.toEqual({
      failed: 0,
      pending: 0,
      pending_retry: 0,
      running: 0,
    });
    expect(processed).toEqual([{ connectionId: "conn_1" }]);
  });

  it("runs queued jobs without a validator", async () => {
    if (!queueClient) throw new Error("Queue client was not initialized");
    const queue = queueClient.createQueue<Request>("social-sync-no-validator", {
      defaultJobArgs: { numRetries: 2 },
      keepFailedJobs: false,
    });
    const processed: Request[] = [];

    const runner = queueClient.createRunner(
      queue,
      {
        run: async (job) => {
          processed.push(job.data);
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 1,
        timeoutSecs: 1,
      },
    );

    await queue.enqueue({ connectionId: "conn_2" });
    if (!runner.runUntilEmpty) {
      throw new Error("Liteque test runner does not support runUntilEmpty");
    }
    await runner.runUntilEmpty();

    expect(processed).toEqual([{ connectionId: "conn_2" }]);
  });
});

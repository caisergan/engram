import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DB } from "@karakeep/db";
import { socialSyncRuns } from "@karakeep/db/schema";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach, getApiKeyCallerForPlainKey } from "../testUtils";
import {
  SyncRunRecorder,
  sweepStaleRuns,
} from "../lib/socialSync/syncRunRecorder";

vi.mock("@karakeep/shared/config", async (original) => {
  const mod = (await original()) as { default: Record<string, unknown> };
  return {
    default: {
      ...mod.default,
      signingSecret: () => "test-secret-that-is-long-enough-for-hmac-signing!!",
    },
  };
});

vi.mock("@karakeep/shared-server", async (original) => {
  const mod = (await original()) as typeof import("@karakeep/shared-server");
  return {
    ...mod,
    LinkCrawlerQueue: { enqueue: vi.fn() },
    OpenAIQueue: { enqueue: vi.fn() },
    SearchIndexingQueue: { enqueue: vi.fn() },
    RuleEngineQueue: { enqueue: vi.fn() },
    SocialSyncQueue: { enqueue: vi.fn() },
    triggerSearchReindex: vi.fn(),
  };
});

beforeEach<CustomTestContext>(async (ctx) => {
  await defaultBeforeEach(true)(ctx);
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ form_data: {} }),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALID_INSTAGRAM_COOKIES = JSON.stringify({
  sessionid: "abc123",
  csrftoken: "xyz789",
  ds_user_id: "12345",
});

describe("Social Sync Router", () => {
  describe("connect", () => {
    test<CustomTestContext>("creates a connection with valid cookies", async ({
      apiCallers,
    }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });

      const connections = await apiCallers[0].socialSync.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0].platform).toBe("instagram");
      expect(connections[0].enabled).toBe(true);
      expect(connections[0].autoTagName).toBe("instagram");
    });

    test<CustomTestContext>("rejects invalid cookies", async ({
      apiCallers,
    }) => {
      await expect(
        apiCallers[0].socialSync.connect({
          platform: "instagram",
          cookies: '{"bad": "cookies"}',
        }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("rejects duplicate platform connection", async ({
      apiCallers,
    }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      await expect(
        apiCallers[0].socialSync.connect({
          platform: "instagram",
          cookies: VALID_INSTAGRAM_COOKIES,
        }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("connections are per-user", async ({
      apiCallers,
    }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const user1 = await apiCallers[0].socialSync.getConnections();
      const user2 = await apiCallers[1].socialSync.getConnections();
      expect(user1).toHaveLength(1);
      expect(user2).toHaveLength(0);
    });
  });

  describe("API-key auth (extension)", () => {
    test<CustomTestContext>("allows an API key to connect", async ({
      apiCallers,
      db,
    }) => {
      const created = await apiCallers[0].apiKeys.create({ name: "ext" });
      const apiKeyCaller = await getApiKeyCallerForPlainKey(db, created.key);

      await apiKeyCaller.socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });

      const connections = await apiKeyCaller.socialSync.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0].platform).toBe("instagram");
    });

    test<CustomTestContext>("rejects an API key without the socialSync scope", async ({
      apiCallers,
      db,
    }) => {
      const created = await apiCallers[0].apiKeys.create({
        name: "narrow",
        scopes: ["bookmarks:read"],
      });
      const apiKeyCaller = await getApiKeyCallerForPlainKey(db, created.key);

      await expect(
        apiKeyCaller.socialSync.connect({
          platform: "instagram",
          cookies: VALID_INSTAGRAM_COOKIES,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    test<CustomTestContext>("still rejects an API key for syncNow", async ({
      apiCallers,
      db,
    }) => {
      const created = await apiCallers[0].apiKeys.create({ name: "ext" });
      const apiKeyCaller = await getApiKeyCallerForPlainKey(db, created.key);

      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const [conn] = await apiCallers[0].socialSync.getConnections();

      await expect(
        apiKeyCaller.socialSync.syncNow({ connectionId: conn.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("disconnect", () => {
    test<CustomTestContext>("removes connection", async ({ apiCallers }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections = await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.disconnect({
        connectionId: connections[0].id,
      });
      const after = await apiCallers[0].socialSync.getConnections();
      expect(after).toHaveLength(0);
    });
  });

  describe("updateSettings", () => {
    test<CustomTestContext>("updates sync interval", async ({ apiCallers }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections = await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.updateSettings({
        connectionId: connections[0].id,
        syncIntervalMinutes: 30,
      });
      const updated = await apiCallers[0].socialSync.getConnections();
      expect(updated[0].syncIntervalMinutes).toBe(30);
    });

    test<CustomTestContext>("updates auto-tag name", async ({ apiCallers }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections = await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.updateSettings({
        connectionId: connections[0].id,
        autoTagName: "ig-saves",
      });
      const updated = await apiCallers[0].socialSync.getConnections();
      expect(updated[0].autoTagName).toBe("ig-saves");
    });
  });

  describe("setEnabled", () => {
    test<CustomTestContext>("toggles enabled flag", async ({ apiCallers }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections = await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.setEnabled({
        connectionId: connections[0].id,
        enabled: false,
      });
      const updated = await apiCallers[0].socialSync.getConnections();
      expect(updated[0].enabled).toBe(false);
    });
  });
});

async function createConnection(apiCaller: {
  socialSync: {
    connect: (i: {
      platform: "instagram";
      cookies: string;
    }) => Promise<unknown>;
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

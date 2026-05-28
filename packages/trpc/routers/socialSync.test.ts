import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

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

beforeEach<CustomTestContext>(defaultBeforeEach(true));

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

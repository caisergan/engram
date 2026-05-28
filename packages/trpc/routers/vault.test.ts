import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { bookmarks } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach, getApiCaller } from "../testUtils";
import { verifyVaultToken } from "../lib/vaultCrypto";

const TEST_SECRET = "test-secret-that-is-long-enough-for-hmac-signing!!";

vi.mock("@karakeep/shared/config", async (original) => {
  const mod = (await original()) as { default: Record<string, unknown> };
  return {
    default: {
      ...mod.default,
      signingSecret: () => TEST_SECRET,
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
    triggerSearchReindex: vi.fn(),
  };
});

beforeEach<CustomTestContext>(defaultBeforeEach(true));

async function setupAndUnlockVault(
  api: ReturnType<typeof getApiCaller>,
  pin = "123456",
) {
  await api.vault.setup({ pin });
  const { token } = await api.vault.unlock({ pin });
  return { token, decoded: verifyVaultToken(token, TEST_SECRET) };
}

function callerWithVaultKey(
  db: CustomTestContext["db"],
  userId: string,
  email: string,
  vaultKey: Buffer,
) {
  return getApiCaller(db, userId, email, "user", { type: "session" }, vaultKey);
}

describe("Vault Router", () => {
  const testPin = "123456";

  describe("setup", () => {
    test<CustomTestContext>("sets up vault with a PIN", async ({
      apiCallers,
    }) => {
      expect(await apiCallers[0].vault.isSetup()).toBe(false);
      await apiCallers[0].vault.setup({ pin: testPin });
      expect(await apiCallers[0].vault.isSetup()).toBe(true);
    });

    test<CustomTestContext>("rejects setup if vault already exists", async ({
      apiCallers,
    }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      await expect(
        apiCallers[0].vault.setup({ pin: testPin }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("vaults are per-user", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      expect(await apiCallers[0].vault.isSetup()).toBe(true);
      expect(await apiCallers[1].vault.isSetup()).toBe(false);
    });
  });

  describe("unlock / lock", () => {
    test<CustomTestContext>("unlock returns a valid token", async ({
      apiCallers,
    }) => {
      const { decoded } = await setupAndUnlockVault(apiCallers[0]);
      expect(decoded.userId).toBeTruthy();
      expect(decoded.encryptionKey).toBeInstanceOf(Buffer);
    });

    test<CustomTestContext>("unlock rejects wrong PIN", async ({
      apiCallers,
    }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      await expect(
        apiCallers[0].vault.unlock({ pin: "wrong-pin" }),
      ).rejects.toThrow(/incorrect/i);
    });

    test<CustomTestContext>("unlock rejects if vault not set up", async ({
      apiCallers,
    }) => {
      await expect(
        apiCallers[0].vault.unlock({ pin: testPin }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("isUnlocked returns false without token", async ({
      apiCallers,
    }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      expect(await apiCallers[0].vault.isUnlocked()).toBe(false);
    });

    test<CustomTestContext>("isUnlocked returns true with valid vaultKey in context", async ({
      apiCallers,
      db,
    }) => {
      const users = await db.query.users.findMany();
      const { decoded } = await setupAndUnlockVault(apiCallers[0]);
      const vaultCaller = callerWithVaultKey(
        db,
        users[0].id,
        users[0].email,
        decoded.encryptionKey,
      );
      expect(await vaultCaller.vault.isUnlocked()).toBe(true);
    });
  });

  describe("settings", () => {
    test<CustomTestContext>("getSettings returns defaults", async ({
      apiCallers,
    }) => {
      const settings = await apiCallers[0].vault.getSettings();
      expect(settings.autoLockMinutes).toBe(5);
    });

    test<CustomTestContext>("updateSettings changes auto-lock timeout", async ({
      apiCallers,
    }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      await apiCallers[0].vault.updateSettings({ autoLockMinutes: 30 });
      const settings = await apiCallers[0].vault.getSettings();
      expect(settings.autoLockMinutes).toBe(30);
    });
  });
});

describe("Vault Bookmark Filtering", () => {
  test<CustomTestContext>("vaulted bookmarks are excluded from getBookmarks by default", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "normal bookmark",
    });
    await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "will be vaulted",
    });

    const beforeVault = await api.bookmarks.getBookmarks({});
    expect(beforeVault.bookmarks).toHaveLength(2);

    const bookmarkToVault = beforeVault.bookmarks[0];
    await db
      .update(bookmarks)
      .set({ vaulted: true })
      .where(eq(bookmarks.id, bookmarkToVault.id));

    const afterVault = await api.bookmarks.getBookmarks({});
    expect(afterVault.bookmarks).toHaveLength(1);
  });

  test<CustomTestContext>("vaulted bookmarks visible when explicitly requested with vault access", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    const { decoded } = await setupAndUnlockVault(api);
    const vaultCaller = callerWithVaultKey(
      db,
      users[0].id,
      users[0].email,
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "vaulted text",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Not visible without vault query
    const normal = await api.bookmarks.getBookmarks({});
    expect(normal.bookmarks).toHaveLength(0);

    // Visible with vault query and vault key
    const vaulted = await vaultCaller.bookmarks.getBookmarks({
      vaulted: true,
    });
    expect(vaulted.bookmarks).toHaveLength(1);
  });
});

describe("Move to Vault", () => {
  test<CustomTestContext>("moves a text bookmark to the vault and encrypts content", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    const { decoded } = await setupAndUnlockVault(api);
    const vaultCaller = callerWithVaultKey(
      db,
      users[0].id,
      users[0].email,
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "secret note content",
      title: "Secret Note",
    });

    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Not visible in normal queries
    const normal = await api.bookmarks.getBookmarks({});
    expect(normal.bookmarks).toHaveLength(0);

    // Visible and decrypted in vault queries
    const vaulted = await vaultCaller.bookmarks.getBookmarks({
      vaulted: true,
    });
    expect(vaulted.bookmarks).toHaveLength(1);
    expect(vaulted.bookmarks[0].title).toBe("Secret Note");

    // Verify raw DB has encrypted data
    const rawBookmark = await db.query.bookmarks.findFirst({
      where: eq(bookmarks.id, bookmark.id),
    });
    expect(rawBookmark?.title).toBeNull();
    expect(rawBookmark?.encryptedTitle).toBeTruthy();
    expect(rawBookmark?.encryptedTitle).not.toBe("Secret Note");
    expect(rawBookmark?.vaulted).toBe(true);
  });

  test<CustomTestContext>("moveToVault fails without vault access", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    await api.vault.setup({ pin: "123456" });

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "test",
    });

    await expect(
      api.bookmarks.moveToVault({ bookmarkId: bookmark.id }),
    ).rejects.toThrow(/vault is locked/i);
  });
});

describe("Decrypt on Read", () => {
  test<CustomTestContext>("getBookmark on vaulted bookmark fails without vault access", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    const { decoded } = await setupAndUnlockVault(api);
    const vaultCaller = callerWithVaultKey(
      db,
      users[0].id,
      users[0].email,
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "secret",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    await expect(
      api.bookmarks.getBookmark({ bookmarkId: bookmark.id }),
    ).rejects.toThrow(/forbidden|vault/i);
  });
});

describe("Change PIN", () => {
  test<CustomTestContext>("re-encrypts all vault content with new key", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];
    const oldPin = "123456";
    const newPin = "654321";

    const { decoded } = await setupAndUnlockVault(api, oldPin);
    const vaultCaller = callerWithVaultKey(
      db,
      users[0].id,
      users[0].email,
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "secret data",
      title: "Secret Title",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    await vaultCaller.vault.changePin({ currentPin: oldPin, newPin });

    // Old PIN no longer works
    await expect(api.vault.unlock({ pin: oldPin })).rejects.toThrow(
      /incorrect/i,
    );

    // New PIN works and content is readable
    const { token: newToken } = await api.vault.unlock({ pin: newPin });
    const newDecoded = verifyVaultToken(newToken, TEST_SECRET);
    const newVaultCaller = callerWithVaultKey(
      db,
      users[0].id,
      users[0].email,
      newDecoded.encryptionKey,
    );

    const vaulted = await newVaultCaller.bookmarks.getBookmarks({
      vaulted: true,
    });
    expect(vaulted.bookmarks).toHaveLength(1);
    expect(vaulted.bookmarks[0].title).toBe("Secret Title");
  });
});

describe("Delete Vault", () => {
  test<CustomTestContext>("deletes all vaulted bookmarks and clears vault settings", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    const { decoded } = await setupAndUnlockVault(api);
    const vaultCaller = callerWithVaultKey(
      db,
      users[0].id,
      users[0].email,
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "to be deleted",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    await vaultCaller.vault.deleteVault({ pin: "123456" });

    expect(await api.vault.isSetup()).toBe(false);
    const all = await api.bookmarks.getBookmarks({});
    expect(all.bookmarks).toHaveLength(0);
  });
});

# Social Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sync engine that periodically fetches saved posts from Instagram, X, and YouTube using cookie-based API calls, creating bookmarks with auto-tagging.

**Architecture:** Provider-adapter pattern. A shared sync engine handles scheduling, dedup, bookmark creation, and state. Platform-specific scraping lives in provider files implementing a `SocialSyncProvider` interface. A cron worker checks for due connections every minute and enqueues sync jobs to a queue. A queue consumer worker processes them sequentially.

**Tech Stack:** Drizzle ORM (SQLite), tRPC, Node.js `crypto` (reusing vault crypto), `node-cron`, React, Next.js, Tailwind CSS, shadcn/ui.

**Design Spec:** `docs/superpowers/specs/2026-05-28-social-sync-design.md`

**Note on providers:** The spec states that scraping implementations are expected to change. This plan creates the full infrastructure (schema, encryption, workers, router, UI) and stub providers with the interface contract. Provider internals (actual HTTP calls to platform APIs) are intentionally minimal — they'll be filled in or replaced as the scraping approach evolves.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/shared/types/socialSync.ts` | Zod schemas for social sync API inputs/outputs + SocialSyncProvider interface |
| `packages/trpc/lib/cookieEncryption.ts` | Server-scoped cookie encryption (AES-256-GCM key derived from NEXTAUTH_SECRET) |
| `packages/trpc/lib/cookieEncryption.test.ts` | Tests for cookie encryption |
| `packages/trpc/lib/socialSync/providers.ts` | Provider registry + provider interface re-export |
| `packages/trpc/lib/socialSync/instagramProvider.ts` | Instagram provider stub |
| `packages/trpc/lib/socialSync/xProvider.ts` | X/Twitter provider stub |
| `packages/trpc/lib/socialSync/youtubeProvider.ts` | YouTube provider stub |
| `packages/trpc/routers/socialSync.ts` | tRPC router for social sync CRUD + syncNow |
| `packages/trpc/routers/socialSync.test.ts` | Tests for social sync router |
| `apps/workers/workers/socialSyncWorker.ts` | Queue consumer + cron refreshing worker |
| `apps/web/app/settings/sync/page.tsx` | Social sync settings page route |
| `apps/web/components/settings/SocialSyncSettings.tsx` | Settings UI: platform cards, connect dialog |

### Modified Files

| File | Change |
|------|--------|
| `packages/db/schema.ts` | Add `socialSyncConnections` + `socialSyncHistory` tables, add `"sync"` to bookmark source enum |
| `packages/shared-server/src/queues.ts` | Add `SocialSyncQueue` definition |
| `packages/trpc/routers/_app.ts` | Register `socialSync` router |
| `apps/workers/index.ts` | Register `SocialSyncWorker` + start cron |
| `apps/web/app/settings/layout.tsx` | Add "Social Sync" sidebar item |
| `apps/web/lib/i18n/locales/en/translation.json` | Add sync-related translation keys |

---

## Task 1: Database Schema, Migration & Zod Types

**Files:**
- Modify: `packages/db/schema.ts`
- Create: `packages/shared/types/socialSync.ts`

### Step 1.1: Add tables and source enum to schema

- [ ] **Add `"sync"` to the bookmark source enum**

In `packages/db/schema.ts`, find the `source` field on the `bookmarks` table (around line 226) and add `"sync"` to the enum array:

```typescript
    source: text("source", {
      enum: [
        "api",
        "web",
        "extension",
        "cli",
        "mobile",
        "singlefile",
        "rss",
        "import",
        "sync",
      ],
    }),
```

- [ ] **Add `socialSyncConnections` table**

Add after the existing table definitions (after `bookmarkAssets` or at the end of the tables section):

```typescript
export const socialSyncConnections = sqliteTable(
  "socialSyncConnections",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform", {
      enum: ["instagram", "x", "youtube"],
    }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    authCookies: text("authCookies").notNull(),
    lastSyncedAt: integer("lastSyncedAt", { mode: "timestamp" }),
    lastSyncStatus: text("lastSyncStatus", {
      enum: ["pending", "success", "failure"],
    })
      .notNull()
      .default("pending"),
    lastSyncError: text("lastSyncError"),
    syncIntervalMinutes: integer("syncIntervalMinutes").notNull().default(60),
    autoTagName: text("autoTagName"),
    lastCursor: text("lastCursor"),
    totalSynced: integer("totalSynced").notNull().default(0),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (t) => [
    index("socialSyncConnections_userId_idx").on(t.userId),
    unique("socialSyncConnections_userId_platform_uniq").on(
      t.userId,
      t.platform,
    ),
  ],
);
```

- [ ] **Add `socialSyncHistory` table**

```typescript
export const socialSyncHistory = sqliteTable(
  "socialSyncHistory",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    connectionId: text("connectionId")
      .notNull()
      .references(() => socialSyncConnections.id, { onDelete: "cascade" }),
    platformItemId: text("platformItemId").notNull(),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    syncedAt: createdAtField(),
  },
  (t) => [
    index("socialSyncHistory_connectionId_platformItemId_idx").on(
      t.connectionId,
      t.platformItemId,
    ),
    index("socialSyncHistory_bookmarkId_idx").on(t.bookmarkId),
  ],
);
```

- [ ] **Generate migration**

Run: `pnpm --filter @karakeep/db generate --name add_social_sync_tables`
Expected: New migration file in `packages/db/drizzle/`

### Step 1.2: Create Zod types

- [ ] **Create `packages/shared/types/socialSync.ts`**

```typescript
import { z } from "zod";

export const zSocialPlatformSchema = z.enum(["instagram", "x", "youtube"]);
export type SocialPlatform = z.infer<typeof zSocialPlatformSchema>;

export const zSyncIntervalSchema = z
  .number()
  .int()
  .refine((v) => [15, 30, 60, 360, 720, 1440].includes(v), {
    message: "Sync interval must be 15, 30, 60, 360, 720, or 1440 minutes",
  });

export const zConnectSchema = z.object({
  platform: zSocialPlatformSchema,
  cookies: z.string().min(1),
  autoTagName: z.string().optional(),
});

export const zUpdateCookiesSchema = z.object({
  connectionId: z.string(),
  cookies: z.string().min(1),
});

export const zDisconnectSchema = z.object({
  connectionId: z.string(),
});

export const zSetEnabledSchema = z.object({
  connectionId: z.string(),
  enabled: z.boolean(),
});

export const zUpdateSyncSettingsSchema = z.object({
  connectionId: z.string(),
  syncIntervalMinutes: zSyncIntervalSchema.optional(),
  autoTagName: z.string().optional(),
});

export const zSyncNowSchema = z.object({
  connectionId: z.string(),
});

export const zGetSyncStatsSchema = z.object({
  connectionId: z.string(),
});

export const zConnectionResponseSchema = z.object({
  id: z.string(),
  platform: zSocialPlatformSchema,
  enabled: z.boolean(),
  lastSyncedAt: z.date().nullable(),
  lastSyncStatus: z.enum(["pending", "success", "failure"]),
  lastSyncError: z.string().nullable(),
  syncIntervalMinutes: z.number(),
  autoTagName: z.string().nullable(),
  totalSynced: z.number(),
  createdAt: z.date(),
});

export interface SyncItem {
  platformItemId: string;
  url: string;
  title?: string;
  tags?: string[];
}

export interface SocialSyncProvider {
  platform: SocialPlatform;

  fetchSavedItems(config: {
    authCookies: string;
    cursor: string | null;
    sinceTimestamp: Date | null;
    limit: number;
  }): Promise<{
    items: SyncItem[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;

  validateAuth(authCookies: string): Promise<boolean>;
}
```

- [ ] **Commit**

```bash
git add packages/db/schema.ts packages/db/drizzle/ packages/shared/types/socialSync.ts
git commit -m "feat(social-sync): add database schema, migration, and Zod types"
```

---

## Task 2: Cookie Encryption Utility

**Files:**
- Create: `packages/trpc/lib/cookieEncryption.ts`
- Create: `packages/trpc/lib/cookieEncryption.test.ts`

### Step 2.1: Write tests

- [ ] **Create test file**

```typescript
// packages/trpc/lib/cookieEncryption.test.ts
import { describe, expect, test, vi } from "vitest";

import { decryptCookies, encryptCookies } from "./cookieEncryption";

vi.mock("@karakeep/shared/config", async (original) => {
  const mod = (await original()) as { default: Record<string, unknown> };
  return {
    default: {
      ...mod.default,
      signingSecret: () => "test-secret-long-enough-for-key-derivation!!",
    },
  };
});

describe("Cookie Encryption", () => {
  test("round-trips cookie JSON", async () => {
    const cookies = JSON.stringify({
      sessionid: "abc123",
      csrftoken: "xyz789",
    });
    const encrypted = await encryptCookies(cookies);
    expect(encrypted).not.toBe(cookies);
    const decrypted = await decryptCookies(encrypted);
    expect(decrypted).toBe(cookies);
  });

  test("produces different ciphertext each time", async () => {
    const cookies = '{"token": "same"}';
    const a = await encryptCookies(cookies);
    const b = await encryptCookies(cookies);
    expect(a).not.toBe(b);
  });

  test("fails to decrypt tampered data", async () => {
    const encrypted = await encryptCookies('{"a":"b"}');
    const tampered = encrypted.slice(0, -2) + "XX";
    expect(() => decryptCookies(tampered)).toThrow();
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run lib/cookieEncryption.test.ts`
Expected: FAIL — module not found

### Step 2.2: Implement cookie encryption

- [ ] **Create `packages/trpc/lib/cookieEncryption.ts`**

```typescript
import serverConfig from "@karakeep/shared/config";

import { decryptText, deriveEncryptionKey, encryptText } from "./vaultCrypto";

const FIXED_SALT = "engram-social-sync-cookie-encryption";

let cachedKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  cachedKey = await deriveEncryptionKey(serverConfig.signingSecret(), FIXED_SALT);
  return cachedKey;
}

export async function encryptCookies(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  return encryptText(plaintext, key);
}

export async function decryptCookies(ciphertext: string): Promise<string> {
  const key = await getEncryptionKey();
  return decryptText(ciphertext, key);
}
```

- [ ] **Run tests to verify they pass**

Run: `cd packages/trpc && pnpm vitest run lib/cookieEncryption.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/lib/cookieEncryption.ts packages/trpc/lib/cookieEncryption.test.ts
git commit -m "feat(social-sync): add server-scoped cookie encryption utility"
```

---

## Task 3: Provider Interface & Stub Providers

**Files:**
- Create: `packages/trpc/lib/socialSync/providers.ts`
- Create: `packages/trpc/lib/socialSync/instagramProvider.ts`
- Create: `packages/trpc/lib/socialSync/xProvider.ts`
- Create: `packages/trpc/lib/socialSync/youtubeProvider.ts`

### Step 3.1: Create provider registry

- [ ] **Create `packages/trpc/lib/socialSync/providers.ts`**

```typescript
import type {
  SocialPlatform,
  SocialSyncProvider,
} from "@karakeep/shared/types/socialSync";

import { instagramProvider } from "./instagramProvider";
import { xProvider } from "./xProvider";
import { youtubeProvider } from "./youtubeProvider";

const providers: Record<SocialPlatform, SocialSyncProvider> = {
  instagram: instagramProvider,
  x: xProvider,
  youtube: youtubeProvider,
};

export function getProvider(platform: SocialPlatform): SocialSyncProvider {
  return providers[platform];
}
```

### Step 3.2: Create stub providers

Each provider implements the interface but has placeholder scraping logic. The `validateAuth` method does a basic check that required cookie keys are present. The `fetchSavedItems` method returns empty results — actual API calls will be implemented when the scraping approach is finalized.

- [ ] **Create `packages/trpc/lib/socialSync/instagramProvider.ts`**

```typescript
import type { SocialSyncProvider } from "@karakeep/shared/types/socialSync";

const REQUIRED_COOKIES = ["sessionid", "csrftoken", "ds_user_id"];

export const instagramProvider: SocialSyncProvider = {
  platform: "instagram",

  async validateAuth(authCookies: string): Promise<boolean> {
    try {
      const cookies = JSON.parse(authCookies);
      return REQUIRED_COOKIES.every(
        (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
      );
    } catch {
      return false;
    }
  },

  async fetchSavedItems(_config) {
    // Stub: actual Instagram API scraping to be implemented
    return { items: [], nextCursor: null, hasMore: false };
  },
};
```

- [ ] **Create `packages/trpc/lib/socialSync/xProvider.ts`**

```typescript
import type { SocialSyncProvider } from "@karakeep/shared/types/socialSync";

const REQUIRED_COOKIES = ["auth_token", "ct0"];

export const xProvider: SocialSyncProvider = {
  platform: "x",

  async validateAuth(authCookies: string): Promise<boolean> {
    try {
      const cookies = JSON.parse(authCookies);
      return REQUIRED_COOKIES.every(
        (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
      );
    } catch {
      return false;
    }
  },

  async fetchSavedItems(_config) {
    // Stub: actual X/Twitter API scraping to be implemented
    return { items: [], nextCursor: null, hasMore: false };
  },
};
```

- [ ] **Create `packages/trpc/lib/socialSync/youtubeProvider.ts`**

```typescript
import type { SocialSyncProvider } from "@karakeep/shared/types/socialSync";

const REQUIRED_COOKIES = ["SID", "HSID", "SSID"];

export const youtubeProvider: SocialSyncProvider = {
  platform: "youtube",

  async validateAuth(authCookies: string): Promise<boolean> {
    try {
      const cookies = JSON.parse(authCookies);
      return REQUIRED_COOKIES.every(
        (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
      );
    } catch {
      return false;
    }
  },

  async fetchSavedItems(_config) {
    // Stub: actual YouTube InnerTube API scraping to be implemented
    return { items: [], nextCursor: null, hasMore: false };
  },
};
```

- [ ] **Commit**

```bash
git add packages/trpc/lib/socialSync/
git commit -m "feat(social-sync): add provider interface, registry, and stub providers"
```

---

## Task 4: Queue Definition

**Files:**
- Modify: `packages/shared-server/src/queues.ts`

### Step 4.1: Add SocialSyncQueue

- [ ] **Add queue schema and definition to `packages/shared-server/src/queues.ts`**

Add near the other queue definitions (after `FeedQueue`):

```typescript
export const zSocialSyncRequestSchema = z.object({
  connectionId: z.string(),
});
export type ZSocialSyncRequestSchema = z.infer<typeof zSocialSyncRequestSchema>;

export const SocialSyncQueue = createDeferredQueue<ZSocialSyncRequestSchema>(
  "social_sync_queue",
  {
    defaultJobArgs: {
      numRetries: 2,
    },
    keepFailedJobs: false,
  },
);
```

Add the `z` import if not already present (it should be — check top of file).

- [ ] **Commit**

```bash
git add packages/shared-server/src/queues.ts
git commit -m "feat(social-sync): add SocialSyncQueue definition"
```

---

## Task 5: Social Sync tRPC Router

**Files:**
- Create: `packages/trpc/routers/socialSync.ts`
- Create: `packages/trpc/routers/socialSync.test.ts`
- Modify: `packages/trpc/routers/_app.ts`

### Step 5.1: Write tests

- [ ] **Create `packages/trpc/routers/socialSync.test.ts`**

```typescript
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

vi.mock("@karakeep/shared/config", async (original) => {
  const mod = (await original()) as { default: Record<string, unknown> };
  return {
    default: {
      ...mod.default,
      signingSecret: () =>
        "test-secret-that-is-long-enough-for-hmac-signing!!",
    },
  };
});

vi.mock("@karakeep/shared-server", async (original) => {
  const mod =
    (await original()) as typeof import("@karakeep/shared-server");
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

      const connections =
        await apiCallers[0].socialSync.getConnections();
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
      const connections =
        await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.disconnect({
        connectionId: connections[0].id,
      });
      const after = await apiCallers[0].socialSync.getConnections();
      expect(after).toHaveLength(0);
    });
  });

  describe("updateSettings", () => {
    test<CustomTestContext>("updates sync interval", async ({
      apiCallers,
    }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections =
        await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.updateSettings({
        connectionId: connections[0].id,
        syncIntervalMinutes: 30,
      });
      const updated =
        await apiCallers[0].socialSync.getConnections();
      expect(updated[0].syncIntervalMinutes).toBe(30);
    });

    test<CustomTestContext>("updates auto-tag name", async ({
      apiCallers,
    }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections =
        await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.updateSettings({
        connectionId: connections[0].id,
        autoTagName: "ig-saves",
      });
      const updated =
        await apiCallers[0].socialSync.getConnections();
      expect(updated[0].autoTagName).toBe("ig-saves");
    });
  });

  describe("setEnabled", () => {
    test<CustomTestContext>("toggles enabled flag", async ({
      apiCallers,
    }) => {
      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const connections =
        await apiCallers[0].socialSync.getConnections();
      await apiCallers[0].socialSync.setEnabled({
        connectionId: connections[0].id,
        enabled: false,
      });
      const updated =
        await apiCallers[0].socialSync.getConnections();
      expect(updated[0].enabled).toBe(false);
    });
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run routers/socialSync.test.ts`
Expected: FAIL — `socialSync` router not found

### Step 5.2: Implement the router

- [ ] **Create `packages/trpc/routers/socialSync.ts`**

```typescript
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

import {
  socialSyncConnections,
  socialSyncHistory,
} from "@karakeep/db/schema";
import {
  zConnectSchema,
  zConnectionResponseSchema,
  zDisconnectSchema,
  zSetEnabledSchema,
  zSyncNowSchema,
  zUpdateCookiesSchema,
  zUpdateSyncSettingsSchema,
} from "@karakeep/shared/types/socialSync";
import { SocialSyncQueue } from "@karakeep/shared-server";

import { router, sessionProcedure, authedProcedure } from "../index";
import { decryptCookies, encryptCookies } from "../lib/cookieEncryption";
import { getProvider } from "../lib/socialSync/providers";

function ensureConnectionOwnership() {
  return sessionProcedure.use(async (opts) => {
    const input = opts.input as { connectionId: string };
    const connection = await opts.ctx.db.query.socialSyncConnections.findFirst({
      where: and(
        eq(socialSyncConnections.id, input.connectionId),
        eq(socialSyncConnections.userId, opts.ctx.user.id),
      ),
    });
    if (!connection) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Connection not found",
      });
    }
    return opts.next({ ctx: { ...opts.ctx, connection } });
  });
}

export const socialSyncAppRouter = router({
  getConnections: authedProcedure.query(async ({ ctx }) => {
    const connections = await ctx.db.query.socialSyncConnections.findMany({
      where: eq(socialSyncConnections.userId, ctx.user.id),
    });
    return connections.map((c) => ({
      id: c.id,
      platform: c.platform,
      enabled: c.enabled,
      lastSyncedAt: c.lastSyncedAt,
      lastSyncStatus: c.lastSyncStatus,
      lastSyncError: c.lastSyncError,
      syncIntervalMinutes: c.syncIntervalMinutes,
      autoTagName: c.autoTagName ?? c.platform,
      totalSynced: c.totalSynced,
      createdAt: c.createdAt,
    }));
  }),

  connect: sessionProcedure
    .input(zConnectSchema)
    .mutation(async ({ input, ctx }) => {
      const existing = await ctx.db.query.socialSyncConnections.findFirst({
        where: and(
          eq(socialSyncConnections.userId, ctx.user.id),
          eq(socialSyncConnections.platform, input.platform),
        ),
      });
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Already connected to ${input.platform}`,
        });
      }

      const provider = getProvider(input.platform);
      const valid = await provider.validateAuth(input.cookies);
      if (!valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Could not authenticate with these cookies. Make sure you're logged in and the cookies are current.",
        });
      }

      const encrypted = await encryptCookies(input.cookies);
      const [connection] = await ctx.db
        .insert(socialSyncConnections)
        .values({
          userId: ctx.user.id,
          platform: input.platform,
          authCookies: encrypted,
          autoTagName: input.autoTagName ?? input.platform,
        })
        .returning();

      SocialSyncQueue.enqueue(
        { connectionId: connection.id },
        { groupId: ctx.user.id },
      );
    }),

  updateCookies: ensureConnectionOwnership()
    .input(zUpdateCookiesSchema)
    .mutation(async ({ input, ctx }) => {
      const connection = (ctx as any).connection;
      const provider = getProvider(connection.platform);
      const valid = await provider.validateAuth(input.cookies);
      if (!valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Could not authenticate with these cookies. Make sure you're logged in and the cookies are current.",
        });
      }

      const encrypted = await encryptCookies(input.cookies);
      await ctx.db
        .update(socialSyncConnections)
        .set({
          authCookies: encrypted,
          enabled: true,
          lastSyncError: null,
          lastSyncStatus: "pending",
        })
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),

  disconnect: ensureConnectionOwnership()
    .input(zDisconnectSchema)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .delete(socialSyncConnections)
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),

  setEnabled: ensureConnectionOwnership()
    .input(zSetEnabledSchema)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(socialSyncConnections)
        .set({ enabled: input.enabled })
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),

  updateSettings: ensureConnectionOwnership()
    .input(zUpdateSyncSettingsSchema)
    .mutation(async ({ input, ctx }) => {
      const updates: Record<string, unknown> = {};
      if (input.syncIntervalMinutes !== undefined) {
        updates.syncIntervalMinutes = input.syncIntervalMinutes;
      }
      if (input.autoTagName !== undefined) {
        updates.autoTagName = input.autoTagName;
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db
          .update(socialSyncConnections)
          .set(updates)
          .where(eq(socialSyncConnections.id, input.connectionId));
      }
    }),

  syncNow: ensureConnectionOwnership()
    .input(zSyncNowSchema)
    .mutation(async ({ input, ctx }) => {
      const connection = (ctx as any).connection;
      if (!connection.enabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Connection is disabled. Enable it first.",
        });
      }
      SocialSyncQueue.enqueue(
        { connectionId: input.connectionId },
        { groupId: ctx.user.id },
      );
    }),
});
```

- [ ] **Register the router in `packages/trpc/routers/_app.ts`**

Add import:
```typescript
import { socialSyncAppRouter } from "./socialSync";
```

Add to router object:
```typescript
  socialSync: socialSyncAppRouter,
```

- [ ] **Run tests**

Run: `cd packages/trpc && pnpm vitest run routers/socialSync.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/routers/socialSync.ts packages/trpc/routers/socialSync.test.ts packages/trpc/routers/_app.ts
git commit -m "feat(social-sync): add social sync tRPC router with connect, disconnect, settings, syncNow"
```

---

## Task 6: Social Sync Worker

**Files:**
- Create: `apps/workers/workers/socialSyncWorker.ts`
- Modify: `apps/workers/index.ts`

### Step 6.1: Create the worker

- [ ] **Create `apps/workers/workers/socialSyncWorker.ts`**

```typescript
import cron from "node-cron";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { logger } from "@karakeep/shared/logger";
import { db } from "@karakeep/db";
import {
  bookmarkTags,
  bookmarks,
  socialSyncConnections,
  socialSyncHistory,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import {
  SocialSyncQueue,
  type ZSocialSyncRequestSchema,
} from "@karakeep/shared-server";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { decryptCookies } from "@karakeep/trpc/lib/cookieEncryption";
import { getProvider } from "@karakeep/trpc/lib/socialSync/providers";
import { getQueueClient } from "../queue";

const MAX_ITEMS_PER_RUN = 100;

async function run(req: DequeuedJob<ZSocialSyncRequestSchema>) {
  const { connectionId } = req.data;
  logger.info(`[social-sync][${connectionId}] Starting sync run`);

  const connection = await db.query.socialSyncConnections.findFirst({
    where: eq(socialSyncConnections.id, connectionId),
  });

  if (!connection || !connection.enabled) {
    logger.info(`[social-sync][${connectionId}] Connection not found or disabled, skipping`);
    return;
  }

  const provider = getProvider(connection.platform);
  let authCookies: string;
  try {
    authCookies = await decryptCookies(connection.authCookies);
  } catch (e) {
    logger.error(`[social-sync][${connectionId}] Failed to decrypt cookies: ${e}`);
    await db
      .update(socialSyncConnections)
      .set({
        lastSyncStatus: "failure",
        lastSyncError: "Failed to decrypt stored cookies",
        enabled: false,
      })
      .where(eq(socialSyncConnections.id, connectionId));
    return;
  }

  let result;
  try {
    result = await provider.fetchSavedItems({
      authCookies,
      cursor: connection.lastCursor,
      sinceTimestamp: connection.lastSyncedAt,
      limit: MAX_ITEMS_PER_RUN,
    });
  } catch (e: any) {
    const isAuthError =
      e?.status === 401 || e?.status === 403 || e?.statusCode === 401 || e?.statusCode === 403;
    if (isAuthError) {
      await db
        .update(socialSyncConnections)
        .set({
          lastSyncStatus: "failure",
          lastSyncError: "Authentication expired — update your cookies",
          enabled: false,
        })
        .where(eq(socialSyncConnections.id, connectionId));
      return;
    }
    throw e;
  }

  let newCount = 0;
  for (const item of result.items) {
    const existing = await db.query.socialSyncHistory.findFirst({
      where: and(
        eq(socialSyncHistory.connectionId, connectionId),
        eq(socialSyncHistory.platformItemId, item.platformItemId),
      ),
    });
    if (existing) continue;

    const [bookmark] = await db
      .insert(bookmarks)
      .values({
        userId: connection.userId,
        type: BookmarkTypes.LINK,
        source: "sync",
        title: item.title ?? null,
      })
      .returning();

    const { bookmarkLinks } = await import("@karakeep/db/schema");
    await db.insert(bookmarkLinks).values({
      id: bookmark.id,
      url: item.url,
    });

    // Apply auto-tag
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

    // Apply hashtag tags from the item
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
  }

  await db
    .update(socialSyncConnections)
    .set({
      lastSyncedAt: new Date(),
      lastCursor: result.nextCursor,
      lastSyncStatus: "success",
      lastSyncError: null,
      totalSynced: sql`${socialSyncConnections.totalSynced} + ${newCount}`,
    })
    .where(eq(socialSyncConnections.id, connectionId));

  logger.info(
    `[social-sync][${connectionId}] Sync complete: ${newCount} new bookmarks`,
  );
}

export class SocialSyncWorker {
  static async build() {
    logger.info("Starting social sync worker ...");
    const worker =
      (await getQueueClient())!.createRunner<ZSocialSyncRequestSchema>(
        SocialSyncQueue,
        {
          run,
          onComplete: async (job) => {
            logger.info(
              `[social-sync][${job.id}] Job completed successfully`,
            );
          },
          onError: async (job) => {
            logger.error(
              `[social-sync][${job.id}] Job failed: ${job.error}\n${job.error?.stack}`,
            );
            if (job.data && job.numRetriesLeft === 0) {
              await db
                .update(socialSyncConnections)
                .set({
                  lastSyncStatus: "failure",
                  lastSyncError: String(job.error),
                })
                .where(eq(socialSyncConnections.id, job.data.connectionId));
            }
          },
        },
        {
          concurrency: 1,
          pollIntervalMs: 1000,
          timeoutSecs: 60,
        },
      );
    return worker;
  }
}

export const SocialSyncRefreshingWorker = cron.schedule(
  "* * * * *",
  () => {
    const now = new Date();
    db.query.socialSyncConnections
      .findMany({
        where: and(
          eq(socialSyncConnections.enabled, true),
          or(
            isNull(socialSyncConnections.lastSyncedAt),
            lt(
              socialSyncConnections.lastSyncedAt,
              new Date(now.getTime() - 60 * 1000),
            ),
          ),
        ),
        columns: { id: true, userId: true, syncIntervalMinutes: true, lastSyncedAt: true },
      })
      .then((connections) => {
        for (const conn of connections) {
          if (conn.lastSyncedAt) {
            const nextDue = new Date(
              conn.lastSyncedAt.getTime() +
                conn.syncIntervalMinutes * 60 * 1000,
            );
            if (nextDue > now) continue;
          }

          const intervalSlot = Math.floor(
            now.getTime() / (conn.syncIntervalMinutes * 60 * 1000),
          );
          SocialSyncQueue.enqueue(
            { connectionId: conn.id },
            {
              idempotencyKey: `sync:${conn.id}:${intervalSlot}`,
              groupId: conn.userId,
            },
          );
        }
      });
  },
  { runOnInit: false, scheduled: false },
);
```

### Step 6.2: Register the worker

- [ ] **Modify `apps/workers/index.ts`**

Add imports at top:
```typescript
import { SocialSyncWorker, SocialSyncRefreshingWorker } from "./workers/socialSyncWorker";
import { SocialSyncQueue } from "@karakeep/shared-server";
```

Add to `workerBuilders`:
```typescript
  socialSync: async () => {
    await SocialSyncQueue.ensureInit();
    return SocialSyncWorker.build();
  },
```

Add cron start after the feed cron start block:
```typescript
if (workers.some((w) => w.name === "socialSync")) {
  SocialSyncRefreshingWorker.start();
}
```

Add cron stop in shutdown:
```typescript
if (workers.some((w) => w.name === "socialSync")) {
  SocialSyncRefreshingWorker.stop();
}
```

- [ ] **Commit**

```bash
git add apps/workers/workers/socialSyncWorker.ts apps/workers/index.ts
git commit -m "feat(social-sync): add SocialSyncWorker queue consumer and cron refreshing worker"
```

---

## Task 7: i18n Translations

**Files:**
- Modify: `apps/web/lib/i18n/locales/en/translation.json`

### Step 7.1: Add translation keys

- [ ] **Add to `settings` section and create `social_sync` section**

In the `settings` section of the translation file, add:
```json
  "sync": {
    "social_sync": "Social Sync"
  }
```

Add a top-level `social_sync` section (before or after the `vault` section):
```json
  "social_sync": {
    "title": "Social Sync",
    "description": "Automatically import saved posts from social platforms",
    "connect": "Connect",
    "disconnect": "Disconnect",
    "disconnect_confirm": "This will remove the connection and sync history. Your imported bookmarks will be kept.",
    "update_cookies": "Update Cookies",
    "sync_now": "Sync Now",
    "connected": "Connected",
    "not_connected": "Not connected",
    "auth_expired": "Auth expired",
    "syncing": "Syncing...",
    "last_synced": "Last synced {{time}}",
    "total_synced": "{{count}} bookmarks synced",
    "sync_interval": "Sync every",
    "auto_tag": "Auto-tag",
    "interval_15m": "15 minutes",
    "interval_30m": "30 minutes",
    "interval_1h": "1 hour",
    "interval_6h": "6 hours",
    "interval_12h": "12 hours",
    "interval_24h": "24 hours",
    "connect_title": "Connect {{platform}}",
    "connect_instructions_main": "Install a cookie export extension (e.g. 'Cookie-Editor'), navigate to {{platform}}, export cookies as JSON, and paste below.",
    "connect_instructions_alt": "Or open DevTools (F12) → Application → Cookies, and copy the required values.",
    "cookies_placeholder": "Paste cookies as JSON...",
    "cookie_validation_failed": "Could not authenticate with these cookies. Make sure you're logged in and the cookies are current.",
    "connected_success": "Connected to {{platform}}",
    "disconnected_success": "Disconnected from {{platform}}",
    "sync_triggered": "Sync started for {{platform}}",
    "platform_instagram": "Instagram",
    "platform_x": "X (Twitter)",
    "platform_youtube": "YouTube"
  }
```

- [ ] **Commit**

```bash
git add apps/web/lib/i18n/locales/en/translation.json
git commit -m "feat(social-sync): add English translation keys"
```

---

## Task 8: Settings UI — Social Sync Page

**Files:**
- Create: `apps/web/app/settings/sync/page.tsx`
- Create: `apps/web/components/settings/SocialSyncSettings.tsx`
- Modify: `apps/web/app/settings/layout.tsx`

### Step 8.1: Create the settings page route

- [ ] **Create `apps/web/app/settings/sync/page.tsx`**

```typescript
import type { Metadata } from "next";
import { SocialSyncSettings } from "@/components/settings/SocialSyncSettings";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("settings.sync.social_sync")} | Karakeep`,
  };
}

export default async function SyncSettingsPage() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("social_sync.title")}</h1>
      <p className="text-muted-foreground">{t("social_sync.description")}</p>
      <SocialSyncSettings />
    </div>
  );
}
```

### Step 8.2: Create the settings component

- [ ] **Create `apps/web/components/settings/SocialSyncSettings.tsx`**

```typescript
"use client";

import { useState } from "react";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import RelativeTime from "@/components/ui/relative-time";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { SocialPlatform } from "@karakeep/shared/types/socialSync";
import { useTRPC } from "@karakeep/shared-react/trpc";

const PLATFORMS: { id: SocialPlatform; name: string }[] = [
  { id: "instagram", name: "Instagram" },
  { id: "x", name: "X (Twitter)" },
  { id: "youtube", name: "YouTube" },
];

const INTERVALS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "24 hours" },
];

function PlatformCard({
  platform,
}: {
  platform: { id: SocialPlatform; name: string };
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(
    api.socialSync.getConnections.queryOptions(),
  );
  const connection = connectionsQuery.data?.find(
    (c) => c.platform === platform.id,
  );

  const [connectOpen, setConnectOpen] = useState(false);
  const [cookies, setCookies] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [updateCookiesOpen, setUpdateCookiesOpen] = useState(false);
  const [updateCookiesValue, setUpdateCookiesValue] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries(
      api.socialSync.getConnections.queryFilter(),
    );

  const connectMutation = useMutation(
    api.socialSync.connect.mutationOptions({
      onSuccess: () => {
        toast.success(t("social_sync.connected_success", { platform: platform.name }));
        invalidate();
        setConnectOpen(false);
        setCookies("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const disconnectMutation = useMutation(
    api.socialSync.disconnect.mutationOptions({
      onSuccess: () => {
        toast.success(t("social_sync.disconnected_success", { platform: platform.name }));
        invalidate();
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const updateCookiesMutation = useMutation(
    api.socialSync.updateCookies.mutationOptions({
      onSuccess: () => {
        toast.success(t("social_sync.connected_success", { platform: platform.name }));
        invalidate();
        setUpdateCookiesOpen(false);
        setUpdateCookiesValue("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const setEnabledMutation = useMutation(
    api.socialSync.setEnabled.mutationOptions({
      onSuccess: invalidate,
      onError: (err) => toast.error(err.message),
    }),
  );

  const updateSettingsMutation = useMutation(
    api.socialSync.updateSettings.mutationOptions({
      onSuccess: invalidate,
      onError: (err) => toast.error(err.message),
    }),
  );

  const syncNowMutation = useMutation(
    api.socialSync.syncNow.mutationOptions({
      onSuccess: () =>
        toast.success(t("social_sync.sync_triggered", { platform: platform.name })),
      onError: (err) => toast.error(err.message),
    }),
  );

  const statusBadge = !connection ? (
    <Badge variant="secondary">{t("social_sync.not_connected")}</Badge>
  ) : connection.lastSyncStatus === "failure" ? (
    <Badge variant="destructive">{t("social_sync.auth_expired")}</Badge>
  ) : (
    <Badge variant="default">{t("social_sync.connected")}</Badge>
  );

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">{platform.name}</CardTitle>
          {statusBadge}
        </CardHeader>
        <CardContent className="space-y-4">
          {!connection ? (
            <Button onClick={() => setConnectOpen(true)}>
              {t("social_sync.connect")}
            </Button>
          ) : (
            <>
              <div className="text-muted-foreground flex items-center gap-4 text-sm">
                <span>
                  {t("social_sync.total_synced", {
                    count: connection.totalSynced,
                  })}
                </span>
                {connection.lastSyncedAt && (
                  <span>
                    {t("social_sync.last_synced", { time: "" })}
                    <RelativeTime date={connection.lastSyncedAt} />
                  </span>
                )}
              </div>

              {connection.lastSyncError && (
                <p className="text-destructive text-sm">
                  {connection.lastSyncError}
                </p>
              )}

              <div className="flex items-center justify-between">
                <Label>{t("social_sync.sync_interval")}</Label>
                <Select
                  value={String(connection.syncIntervalMinutes)}
                  onValueChange={(v) =>
                    updateSettingsMutation.mutate({
                      connectionId: connection.id,
                      syncIntervalMinutes: parseInt(v),
                    })
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVALS.map((i) => (
                      <SelectItem key={i.value} value={String(i.value)}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <Label>{t("social_sync.auto_tag")}</Label>
                <Input
                  className="w-40"
                  value={connection.autoTagName}
                  onChange={(e) =>
                    updateSettingsMutation.mutate({
                      connectionId: connection.id,
                      autoTagName: e.target.value,
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <Label>Enabled</Label>
                <Switch
                  checked={connection.enabled}
                  onCheckedChange={(checked) =>
                    setEnabledMutation.mutate({
                      connectionId: connection.id,
                      enabled: checked,
                    })
                  }
                />
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!connection.enabled || syncNowMutation.isPending}
                  onClick={() =>
                    syncNowMutation.mutate({
                      connectionId: connection.id,
                    })
                  }
                >
                  {t("social_sync.sync_now")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setUpdateCookiesOpen(true)}
                >
                  {t("social_sync.update_cookies")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setDisconnectOpen(true)}
                >
                  {t("social_sync.disconnect")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Connect Dialog */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("social_sync.connect_title", { platform: platform.name })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {t("social_sync.connect_instructions_main", {
                platform: platform.name,
              })}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("social_sync.connect_instructions_alt")}
            </p>
            <Textarea
              placeholder={t("social_sync.cookies_placeholder")}
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              rows={5}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </DialogClose>
            <Button
              onClick={() =>
                connectMutation.mutate({
                  platform: platform.id,
                  cookies,
                })
              }
              disabled={connectMutation.isPending || !cookies.trim()}
            >
              {t("social_sync.connect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Update Cookies Dialog */}
      <Dialog open={updateCookiesOpen} onOpenChange={setUpdateCookiesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("social_sync.update_cookies")}</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder={t("social_sync.cookies_placeholder")}
            value={updateCookiesValue}
            onChange={(e) => setUpdateCookiesValue(e.target.value)}
            rows={5}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </DialogClose>
            <Button
              onClick={() =>
                connection &&
                updateCookiesMutation.mutate({
                  connectionId: connection.id,
                  cookies: updateCookiesValue,
                })
              }
              disabled={
                updateCookiesMutation.isPending || !updateCookiesValue.trim()
              }
            >
              {t("social_sync.update_cookies")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Dialog */}
      {connection && (
        <ActionConfirmingDialog
          open={disconnectOpen}
          setOpen={setDisconnectOpen}
          title={t("social_sync.disconnect")}
          description={
            <p className="text-muted-foreground text-sm">
              {t("social_sync.disconnect_confirm")}
            </p>
          }
          actionButton={(_setOpen) => (
            <Button
              variant="destructive"
              onClick={() =>
                disconnectMutation.mutate({
                  connectionId: connection.id,
                })
              }
              disabled={disconnectMutation.isPending}
            >
              {t("social_sync.disconnect")}
            </Button>
          )}
        />
      )}
    </>
  );
}

export function SocialSyncSettings() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {PLATFORMS.map((p) => (
        <PlatformCard key={p.id} platform={p} />
      ))}
    </div>
  );
}
```

### Step 8.3: Add sidebar item to settings layout

- [ ] **Modify `apps/web/app/settings/layout.tsx`**

Add import (find the lucide imports):
```typescript
import { RefreshCw } from "lucide-react";
```

Add to `settingsSidebarItems` array (after the feeds/RSS item):
```typescript
    {
      name: t("settings.sync.social_sync"),
      icon: <RefreshCw size={18} />,
      path: "/settings/sync",
    },
```

- [ ] **Commit**

```bash
git add apps/web/app/settings/sync/ apps/web/components/settings/SocialSyncSettings.tsx apps/web/app/settings/layout.tsx
git commit -m "feat(social-sync): add Social Sync settings page with platform cards and connect dialog"
```

---

## Task 9: Typecheck & Full Test Suite

### Step 9.1: Fix type errors and verify

- [ ] **Run typecheck**

Run: `pnpm typecheck`

Fix any type errors. Common ones to watch for:
- Missing `vaultKey: null` in new context objects
- `socialSyncConnections` / `socialSyncHistory` not exported from schema (ensure they're exported)
- `SocialSyncQueue` not exported from `@karakeep/shared-server` (ensure the barrel export includes it)
- Worker import paths

- [ ] **Run tests**

Run: `pnpm --filter @karakeep/trpc test`
Expected: All tests pass including new social sync tests

- [ ] **Run lint and format**

Run: `pnpm lint:fix && pnpm format:fix`

- [ ] **Regenerate OpenAPI spec** (the source enum changed)

Run: `pnpm --filter @karakeep/open-api generate`

- [ ] **Commit**

```bash
git add -A
git commit -m "chore: fix typecheck, lint, formatting, and regenerate OpenAPI spec for social sync"
```

---

## Implementation Notes

### Provider Evolution

The providers are stubs. When ready to implement actual scraping:

1. Pick one provider (e.g. Instagram)
2. Implement `fetchSavedItems` with real HTTP calls using the auth cookies
3. Test manually by connecting in the UI, clicking "Sync Now"
4. Iterate on the response parsing
5. Repeat for other providers

The framework (worker, scheduler, dedup, UI) is fully functional — only the data fetching part of each provider needs to be filled in.

### Adding New Platforms

1. Add the platform to the `zSocialPlatformSchema` enum in `packages/shared/types/socialSync.ts`
2. Add it to the `platform` enum in the `socialSyncConnections` table in `packages/db/schema.ts`
3. Create a provider file in `packages/trpc/lib/socialSync/`
4. Register it in `packages/trpc/lib/socialSync/providers.ts`
5. Add it to the `PLATFORMS` array in `apps/web/components/settings/SocialSyncSettings.tsx`
6. Generate a migration

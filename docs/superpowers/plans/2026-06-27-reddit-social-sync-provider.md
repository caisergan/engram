# Reddit Social-Sync Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cookie-based Reddit provider so the existing social-sync cron imports the user's Reddit **Saved** list (posts `t3` + comments `t1`) as bookmarks.

**Architecture:** A new `redditProvider` implements the existing `SocialSyncProvider` interface; the worker/engine/scheduler/router are platform-generic and unchanged. Fetching/mapping sit behind a small `RedditTransport` seam (cookie now, OAuth later) because Reddit's cookie `.json` and `oauth.reddit.com` return identical Listing JSON. Reddit pages are publicly crawlable, so synced bookmarks crawl normally (no crawler change).

**Tech Stack:** TypeScript, Drizzle/SQLite, tRPC, Vitest. Reddit web `.json` API.

**Spec:** `docs/superpowers/specs/2026-06-27-reddit-social-sync-provider-design.md`

> **Testing reality:** Provider logic is unit-tested with a mocked `fetch` (deterministic, mirrors `instagramProvider.test.ts`). Whether live Reddit accepts the request from the user's datacenter VM cannot be unit-tested — that's a manual step (connect + sync on a running instance), called out in the spec's feasibility caveat.

---

## File Structure

| File | Change |
|---|---|
| `packages/shared/types/socialSync.ts` | Add `"reddit"` to `zSocialPlatformSchema`; add `PLATFORM_REQUIRED_COOKIES.reddit`. |
| `packages/db/schema.ts` | Add `"reddit"` to the `socialSyncConnections.platform` enum array (lines 991–993). |
| `apps/web/components/settings/SocialSyncSettings.tsx` | Append `{ id: "reddit", name: "Reddit" }` to `PLATFORMS`. |
| `packages/trpc/lib/socialSync/redditProvider.ts` | **New** — the provider (stub in Task 1, real in Task 2). |
| `packages/trpc/lib/socialSync/providers.ts` | Register `reddit: redditProvider`. |
| `packages/shared/types/socialSync.test.ts` | Assert `PLATFORM_REQUIRED_COOKIES.reddit`. |
| `packages/trpc/lib/socialSync/redditProvider.test.ts` | **New** — provider unit tests. |

---

## Task 1: Foundation — platform enum, required cookies, stub provider, UI entry

Adding `"reddit"` to the `SocialPlatform` enum makes `providers.ts` (`Record<SocialPlatform, …>`) fail to typecheck until a Reddit provider is registered. So this task lands the enum, the required cookies, a **stub** provider (real impl comes in Task 2), the registration, the schema enum, and the UI list together — leaving a compiling, deployable state where Reddit appears in the UI but fetches nothing (like the X/YouTube stubs).

**Files:**
- Modify: `packages/shared/types/socialSync.ts:3`, `:80-84`
- Test: `packages/shared/types/socialSync.test.ts:29` (PLATFORM_REQUIRED_COOKIES block)
- Create: `packages/trpc/lib/socialSync/redditProvider.ts`
- Modify: `packages/trpc/lib/socialSync/providers.ts`
- Modify: `packages/db/schema.ts:992`
- Modify: `apps/web/components/settings/SocialSyncSettings.tsx`

- [ ] **Step 1: Write the failing shared-types test**

In `packages/shared/types/socialSync.test.ts`, inside the existing `describe("PLATFORM_REQUIRED_COOKIES", …)` block (after the `youtube` assertion at line ~37), add:
```ts
  test("reddit requires reddit_session and token_v2", () => {
    expect(PLATFORM_REQUIRED_COOKIES.reddit).toEqual([
      "reddit_session",
      "token_v2",
    ]);
  });
```

- [ ] **Step 2: Run it — verify it fails**

Run:
```bash
pnpm --filter @karakeep/shared exec vitest run types/socialSync.test.ts
```
Expected: FAIL — `PLATFORM_REQUIRED_COOKIES.reddit` is `undefined` (and a TS error that `reddit` doesn't exist on the Record).

- [ ] **Step 3: Add "reddit" to the platform enum**

In `packages/shared/types/socialSync.ts` line 3, change:
```ts
export const zSocialPlatformSchema = z.enum(["instagram", "x", "youtube"]);
```
to:
```ts
export const zSocialPlatformSchema = z.enum([
  "instagram",
  "x",
  "youtube",
  "reddit",
]);
```

- [ ] **Step 4: Add Reddit's required cookies**

In the same file, change `PLATFORM_REQUIRED_COOKIES` (lines 80–84) to:
```ts
export const PLATFORM_REQUIRED_COOKIES: Record<SocialPlatform, string[]> = {
  instagram: ["sessionid", "csrftoken", "ds_user_id"],
  x: ["auth_token", "ct0"],
  youtube: ["SID", "HSID", "SSID"],
  reddit: ["reddit_session", "token_v2"],
};
```

- [ ] **Step 5: Create the stub provider**

Create `packages/trpc/lib/socialSync/redditProvider.ts`:
```ts
import {
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "@karakeep/shared/types/socialSync";
import type { SocialSyncProvider } from "@karakeep/shared/types/socialSync";

// Stub — real implementation lands in the next task. Keeps the platform enum
// compiling (providers.ts requires a Reddit entry) and shows Reddit in the UI
// as a no-op, matching the existing X/YouTube stubs.
export const redditProvider: SocialSyncProvider = {
  platform: "reddit",

  async validateAuth(authCookies: string): Promise<boolean> {
    const cookies = normalizeCookieInput(authCookies);
    if (!cookies) return false;
    return PLATFORM_REQUIRED_COOKIES.reddit.every(
      (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
    );
  },

  async fetchSavedItems() {
    return { items: [], nextCursor: null, hasMore: false };
  },
};
```

- [ ] **Step 6: Register the provider**

In `packages/trpc/lib/socialSync/providers.ts`, add the import and registry entry:
```ts
import { instagramProvider } from "./instagramProvider";
import { redditProvider } from "./redditProvider";
import { xProvider } from "./xProvider";
import { youtubeProvider } from "./youtubeProvider";

const providers: Record<SocialPlatform, SocialSyncProvider> = {
  instagram: instagramProvider,
  x: xProvider,
  youtube: youtubeProvider,
  reddit: redditProvider,
};
```

- [ ] **Step 7: Add "reddit" to the DB schema enum**

In `packages/db/schema.ts` (lines 991–993), change:
```ts
    platform: text("platform", {
      enum: ["instagram", "x", "youtube"],
    }).notNull(),
```
to:
```ts
    platform: text("platform", {
      enum: ["instagram", "x", "youtube", "reddit"],
    }).notNull(),
```

- [ ] **Step 8: Confirm db:generate is a no-op (no migration expected)**

Run:
```bash
pnpm --filter @karakeep/db db:generate --name add_reddit_platform
git status --short packages/db/drizzle
```
Expected: drizzle reports "No schema changes, nothing to migrate" (or produces no new file under `packages/db/drizzle/`). `git status` shows no new migration. The `platform` column is plain SQLite `text`; the enum is a TypeScript-only hint, so adding a value changes no SQL. If a file IS unexpectedly generated, inspect it (it should be a no-op/empty) and delete it.

- [ ] **Step 9: Add Reddit to the settings UI list**

In `apps/web/components/settings/SocialSyncSettings.tsx`, change `PLATFORMS` to:
```ts
const PLATFORMS: { id: SocialPlatform; name: string }[] = [
  { id: "instagram", name: "Instagram" },
  { id: "x", name: "X (Twitter)" },
  { id: "youtube", name: "YouTube" },
  { id: "reddit", name: "Reddit" },
];
```

- [ ] **Step 10: Typecheck + run the shared-types test**

Run:
```bash
pnpm --filter @karakeep/shared typecheck && pnpm --filter @karakeep/trpc typecheck
pnpm --filter @karakeep/shared exec vitest run types/socialSync.test.ts
```
Expected: typecheck passes (the `Record<SocialPlatform, …>` exhaustiveness in `providers.ts` and `PLATFORM_REQUIRED_COOKIES` is satisfied); the shared-types test passes.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/types/socialSync.ts packages/shared/types/socialSync.test.ts \
  packages/trpc/lib/socialSync/redditProvider.ts packages/trpc/lib/socialSync/providers.ts \
  packages/db/schema.ts apps/web/components/settings/SocialSyncSettings.tsx
git commit -m "feat(social-sync): add reddit platform (enum, cookies, UI, stub provider)"
```

---

## Task 2: Implement the Reddit provider (validateAuth + fetchSavedItems)

TDD: write the full provider test suite first (it fails against the stub), then replace the stub with the real implementation.

**Files:**
- Create: `packages/trpc/lib/socialSync/redditProvider.test.ts`
- Modify: `packages/trpc/lib/socialSync/redditProvider.ts` (replace the stub with the real provider)

- [ ] **Step 1: Write the failing provider test suite**

Create `packages/trpc/lib/socialSync/redditProvider.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { redditProvider } from "./redditProvider";

const VALID_COOKIES = JSON.stringify({
  reddit_session: "sess-abc",
  token_v2: "tok-xyz",
});

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const ME = { kind: "t2", data: { name: "alice" } };

function listing(children: unknown[], after: string | null = null) {
  return { kind: "Listing", data: { after, children } };
}

function t3(over: Record<string, unknown> = {}) {
  return {
    kind: "t3",
    data: {
      name: "t3_post1",
      permalink: "/r/programming/comments/post1/title/",
      title: "A great post",
      subreddit: "programming",
      ...over,
    },
  };
}

function t1(over: Record<string, unknown> = {}) {
  return {
    kind: "t1",
    data: {
      name: "t1_cmt1",
      permalink: "/r/aww/comments/post9/title/cmt1/",
      link_title: "Cute dog",
      subreddit: "aww",
      ...over,
    },
  };
}

describe("redditProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe("validateAuth", () => {
    test("returns false for invalid JSON", async () => {
      expect(await redditProvider.validateAuth("not json")).toBe(false);
    });

    test("returns false when reddit_session is missing", async () => {
      expect(
        await redditProvider.validateAuth(JSON.stringify({ token_v2: "t" })),
      ).toBe(false);
    });

    test("returns true when /api/me.json returns a username", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res(ME));
      expect(await redditProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("returns false on a 403", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      expect(await redditProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });

    test("returns false on a network error", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("net"));
      expect(await redditProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });
  });

  describe("fetchSavedItems", () => {
    test("resolves username, maps posts and comments, encodes the cursor", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(ME)) // /api/me.json
        .mockResolvedValueOnce(res(listing([t3(), t1()], "t1_cmt1")));

      const result = await redditProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });

      expect(result.items).toEqual([
        {
          platformItemId: "t3_post1",
          url: "https://www.reddit.com/r/programming/comments/post1/title/",
          title: "A great post",
          tags: ["programming"],
        },
        {
          platformItemId: "t1_cmt1",
          url: "https://www.reddit.com/r/aww/comments/post9/title/cmt1/",
          title: "Cute dog",
          tags: ["aww"],
        },
      ]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("alice t1_cmt1");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const savedUrl = fetchMock.mock.calls[1]![0] as string;
      expect(savedUrl).toContain("/user/alice/saved.json");
      expect(savedUrl).toContain("limit=100");
    });

    test("on later pages uses the cursor's username+after and skips /api/me.json", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(listing([t3()], null)));

      const result = await redditProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "alice t3_post0",
        sinceTimestamp: null,
        limit: 100,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("/user/alice/saved.json");
      expect(url).toContain("after=t3_post0");
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("sends the full cookie blob as a Cookie header", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(listing([], null)));

      await redditProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "alice ",
        sinceTimestamp: null,
        limit: 100,
      });

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Cookie).toContain("reddit_session=sess-abc");
      expect(headers.Cookie).toContain("token_v2=tok-xyz");
    });

    test("throws with .status when Reddit blocks the saved listing", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      await expect(
        redditProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: "alice t3_x",
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    test("throws 401 for invalid cookies", async () => {
      await expect(
        redditProvider.fetchSavedItems({
          authCookies: "not json",
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run:
```bash
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/redditProvider.test.ts
```
Expected: FAIL — the stub returns `[]` and a presence-only `validateAuth`, so the mapping/username/cursor/error tests fail.

- [ ] **Step 3: Replace the stub with the real provider**

Replace the entire contents of `packages/trpc/lib/socialSync/redditProvider.ts` with:
```ts
import {
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "@karakeep/shared/types/socialSync";
import type {
  SocialSyncProvider,
  SyncItem,
} from "@karakeep/shared/types/socialSync";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REDDIT_BASE_URL = "https://www.reddit.com";
const MAX_PAGE_SIZE = 100;
const VALIDATE_TIMEOUT_MS = 5000;
const FETCH_SAVED_ITEMS_TIMEOUT_MS = 10000;

// Reddit's cookie `.json` web API and oauth.reddit.com return identical Listing
// JSON; only the base URL and auth header differ. Keeping fetch/map auth-agnostic
// behind this transport lets an OAuth transport drop in later with no change to
// parsing or mapping.
interface RedditTransport {
  baseUrl: string;
  headers: Record<string, string>;
}

function cookieTransport(authCookies: string): RedditTransport | null {
  const cookies = normalizeCookieInput(authCookies);
  if (!cookies) return null;
  const hasRequired = PLATFORM_REQUIRED_COOKIES.reddit.every(
    (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
  );
  if (!hasRequired) return null;
  // Send the full provided cookie set, not just the required keys — Reddit's
  // exact auth-cookie needs are finicky, so forward everything the user gave.
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return {
    baseUrl: REDDIT_BASE_URL,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Cookie: cookieHeader,
    },
  };
}

function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface RedditMe {
  data?: { name?: unknown };
}

async function resolveUsername(
  transport: RedditTransport,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await fetch(`${transport.baseUrl}/api/me.json`, {
    method: "GET",
    headers: transport.headers,
    signal: withTimeout(signal, VALIDATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(
        `Reddit blocked the request (status ${res.status}). Update your cookies, or it may be an IP block.`,
      ),
      { status: res.status },
    );
  }
  const body = (await res.json()) as RedditMe;
  const name = asString(body?.data?.name);
  if (!name) {
    throw Object.assign(new Error("Could not resolve Reddit username"), {
      status: 401,
    });
  }
  return name;
}

interface RedditChild {
  kind?: unknown;
  data?: Record<string, unknown>;
}

interface RedditListing {
  data?: { children?: unknown; after?: unknown };
}

// Map a saved Reddit child (t3 post or t1 comment) to a SyncItem. We supply only
// url/title/tags and leave description/imageUrl unset so the normal crawler
// enriches the (public) reddit page; the worker adds the "reddit" auto-tag.
function mapChild(child: RedditChild): SyncItem | null {
  const data = child?.data;
  if (!data) return null;
  const name = asString(data.name);
  const permalink = asString(data.permalink);
  if (!name || !permalink) return null;
  const subreddit = asString(data.subreddit);
  const tags = subreddit ? [subreddit] : [];
  const url = `${REDDIT_BASE_URL}${permalink}`;
  if (child.kind === "t3") {
    return { platformItemId: name, url, title: asString(data.title), tags };
  }
  if (child.kind === "t1") {
    return { platformItemId: name, url, title: asString(data.link_title), tags };
  }
  return null;
}

// The opaque cursor carries the resolved username so later pages skip the
// /api/me.json round-trip: "<username> <after>".
function encodeCursor(username: string, after: string): string {
  return `${username} ${after}`;
}

function decodeCursor(cursor: string): {
  username: string;
  after: string | null;
} {
  const sep = cursor.indexOf(" ");
  if (sep === -1) return { username: cursor, after: null };
  const after = cursor.slice(sep + 1);
  return { username: cursor.slice(0, sep), after: after.length > 0 ? after : null };
}

export const redditProvider: SocialSyncProvider = {
  platform: "reddit",

  async validateAuth(authCookies: string): Promise<boolean> {
    const transport = cookieTransport(authCookies);
    if (!transport) return false;
    try {
      const res = await fetch(`${transport.baseUrl}/api/me.json`, {
        method: "GET",
        headers: transport.headers,
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as RedditMe;
      return asString(body?.data?.name) !== undefined;
    } catch {
      return false;
    }
  },

  async fetchSavedItems(config) {
    const transport = cookieTransport(config.authCookies);
    if (!transport) {
      throw Object.assign(new Error("Invalid Reddit cookies"), { status: 401 });
    }

    let username: string;
    let after: string | null;
    if (config.cursor) {
      const decoded = decodeCursor(config.cursor);
      username = decoded.username;
      after = decoded.after;
    } else {
      username = await resolveUsername(transport, config.signal);
      after = null;
    }

    const limit = Math.min(config.limit, MAX_PAGE_SIZE);
    const url = new URL(
      `${transport.baseUrl}/user/${encodeURIComponent(username)}/saved.json`,
    );
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("raw_json", "1");
    if (after) url.searchParams.set("after", after);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: transport.headers,
      signal: withTimeout(config.signal, FETCH_SAVED_ITEMS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `Reddit blocked the request (status ${response.status}). Update your cookies, or it may be an IP block.`,
        ),
        { status: response.status },
      );
    }

    const data = (await response.json()) as RedditListing;
    const rawChildren = Array.isArray(data?.data?.children)
      ? (data.data.children as RedditChild[])
      : [];
    const items: SyncItem[] = [];
    for (const child of rawChildren) {
      const item = mapChild(child);
      if (item) items.push(item);
    }

    const nextAfter = asString(data?.data?.after) ?? null;
    return {
      items,
      nextCursor: nextAfter ? encodeCursor(username, nextAfter) : null,
      hasMore: nextAfter !== null,
    };
  },
};
```

- [ ] **Step 4: Run the tests — verify they pass**

Run:
```bash
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/redditProvider.test.ts
```
Expected: PASS (all `validateAuth` + `fetchSavedItems` tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/trpc/lib/socialSync/redditProvider.ts packages/trpc/lib/socialSync/redditProvider.test.ts
git commit -m "feat(social-sync): implement cookie-based Reddit saved-posts provider"
```

---

## Task 3: Repo-wide verification

**Files:** (no edits — verification + format)

- [ ] **Step 1: Format the changed packages**

Run:
```bash
pnpm --filter @karakeep/shared format:fix
pnpm --filter @karakeep/trpc format:fix
pnpm --filter @karakeep/db format:fix
pnpm --filter @karakeep/web format:fix
```
Expected: completes; re-stage + amend if anything reformatted (see Step 5).

- [ ] **Step 2: Typecheck the touched packages**

Run:
```bash
pnpm --filter @karakeep/shared typecheck && \
pnpm --filter @karakeep/trpc typecheck && \
pnpm --filter @karakeep/db typecheck && \
pnpm --filter @karakeep/web typecheck
```
Expected: all pass.

- [ ] **Step 3: Lint the touched packages**

Run:
```bash
pnpm --filter @karakeep/shared lint && pnpm --filter @karakeep/trpc lint
```
Expected: 0 warnings, 0 errors.

- [ ] **Step 4: Run the relevant test suites**

Run:
```bash
pnpm --filter @karakeep/shared exec vitest run types/socialSync.test.ts
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync
```
Expected: all pass (shared types + every socialSync test incl. `redditProvider.test.ts`, `syncEngine.test.ts`, `instagramProvider.test.ts`).

- [ ] **Step 5: Commit any formatting changes**

```bash
git add -A
git commit -m "chore(social-sync): format reddit provider changes" || echo "nothing to format"
```

---

## Task 4: Manual feasibility check (handed to the user)

**Files:** (none — runbook the user runs against a running instance)

- [ ] **Step 1:** In Reddit (logged in, on www.reddit.com), export your cookies (Cookie-Editor extension → Export, or copy the `Cookie` header from DevTools → Network). Ensure `reddit_session` and `token_v2` are present.
- [ ] **Step 2:** In Engram → Settings → Social Sync → **Reddit** → Connect → paste the cookies → save. If it reports the connection as valid, `validateAuth` reached `/api/me.json` successfully.
- [ ] **Step 3:** Click **Sync now**. Expected: your saved posts/comments appear as bookmarks tagged `reddit` + their subreddit. If the run fails with a 403 / "Reddit blocked the request", that's the **datacenter-IP block** the spec warned about — at which point the OAuth transport (the seam is already in place) is the follow-up.

---

## Self-Review

**Spec coverage:**
- Enum + `PLATFORM_REQUIRED_COOKIES.reddit` → Task 1 (steps 3–4) + test (step 1). ✓
- Schema enum + no-migration confirmation → Task 1 (steps 7–8). ✓
- Settings UI list → Task 1 (step 9). ✓
- Stub→register (compiling no-op) → Task 1 (steps 5–6). ✓
- `RedditTransport` OAuth-ready seam, `validateAuth` via `/api/me.json`, `fetchSavedItems` username resolution + cursor, t3/t1 mapping (tags=subreddit, no description/imageUrl), full-cookie header, `.status` error with IP-block wording → Task 2 (step 3) + tests (step 1). ✓
- No crawler change, no `isRedditUrl` → reflected by absence of any crawler task. ✓
- Deferred extension auto-read / OAuth code → not in plan (correctly out of scope). ✓
- Testing: mocked-fetch unit tests + manual feasibility → Task 2 + Task 4. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete content; every command has an expected result. Task 4 is an explicit manual runbook, not a placeholder.

**Type/name consistency:** `redditProvider`, `cookieTransport`, `RedditTransport`, `resolveUsername`, `mapChild`, `encodeCursor`/`decodeCursor`, `asString`, `withTimeout` are defined in Task 2 step 3 and used consistently. Cursor format `"<username> <after>"` is produced by `encodeCursor` and parsed by `decodeCursor`, and the tests assert exactly `"alice t1_cmt1"` / `"alice t3_post0"`. `PLATFORM_REQUIRED_COOKIES.reddit = ["reddit_session", "token_v2"]` matches across the type change, the test, and `cookieTransport`. `platform: "reddit"` matches the enum value added in both `socialSync.ts` and `schema.ts`.

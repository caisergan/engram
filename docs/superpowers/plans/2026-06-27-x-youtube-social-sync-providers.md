# X + YouTube Social-Sync Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the X and YouTube no-op stubs with real cookie-based providers that import X Bookmarks and YouTube Watch Later.

**Architecture:** Each provider implements the existing `SocialSyncProvider` behind a cookie `Transport` seam (OAuth-ready). X uses the internal GraphQL `Bookmarks` query (login-gated → provider populates content + crawler skip); YouTube uses InnerTube `browse VLWL` with a computed `SAPISIDHASH` (publicly crawlable → no skip).

**Tech Stack:** TypeScript, tRPC, Vitest, Node `crypto` (SHA-1 for SAPISIDHASH). X GraphQL + YouTube InnerTube private APIs.

**Spec:** `docs/superpowers/specs/2026-06-27-x-youtube-social-sync-providers-design.md`

> **Fragility (see spec):** the X `BOOKMARKS_QUERY_ID`/`FEATURES` and YouTube `CLIENT_VERSION` are undocumented constants that drift — they're isolated and commented. Unit tests prove the parse/auth logic against research-inferred fixtures; live feasibility is a manual step (Task 5).

---

## File Structure

| File | Change |
|---|---|
| `packages/shared/types/socialSync.ts` | `PLATFORM_REQUIRED_COOKIES.youtube` → 5 cookies; add `isXUrl`. |
| `packages/shared/types/socialSync.test.ts` | Update youtube assertion; add `isXUrl` tests. |
| `apps/workers/workers/crawlerWorker.ts` | Extend the `source==="sync"` crawl-skip to also skip `isXUrl`. |
| `packages/trpc/lib/socialSync/xProvider.ts` | Replace stub with the X Bookmarks provider. |
| `packages/trpc/lib/socialSync/xProvider.test.ts` | **New** — X provider tests. |
| `packages/trpc/lib/socialSync/youtubeProvider.ts` | Replace stub with the YouTube Watch Later provider. |
| `packages/trpc/lib/socialSync/youtubeProvider.test.ts` | **New** — YouTube provider tests. |

---

## Task 1: Shared types + crawler skip

**Files:**
- Modify: `packages/shared/types/socialSync.ts` (`PLATFORM_REQUIRED_COOKIES` line 80–84; add `isXUrl` after `isInstagramUrl`)
- Modify: `packages/shared/types/socialSync.test.ts` (line 37 youtube assertion; add `isXUrl` describe)
- Modify: `apps/workers/workers/crawlerWorker.ts` (import line 86; skip block line 2231)

- [ ] **Step 1: Write the failing shared-types tests**

In `packages/shared/types/socialSync.test.ts`, change the youtube assertion (line 37) and add an `isXUrl` block. First update the import (line 5 area) to include `isXUrl`:
```ts
import {
  buildCookieBlob,
  isInstagramUrl,
  isXUrl,
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "./socialSync";
```
Change the youtube line inside `PLATFORM_REQUIRED_COOKIES` test:
```ts
    expect(PLATFORM_REQUIRED_COOKIES.youtube).toEqual([
      "SID",
      "HSID",
      "SSID",
      "SAPISID",
      "APISID",
    ]);
```
Add a new describe block after the `isInstagramUrl` block (after line 27):
```ts
describe("isXUrl", () => {
  test("matches x.com and twitter.com and subdomains", () => {
    expect(isXUrl("https://x.com/user/status/123")).toBe(true);
    expect(isXUrl("https://www.twitter.com/user/status/123")).toBe(true);
    expect(isXUrl("https://mobile.x.com/i/bookmarks")).toBe(true);
  });

  test("does not match look-alikes or non-URLs", () => {
    expect(isXUrl("https://notx.com/")).toBe(false);
    expect(isXUrl("https://x.com.evil.com/")).toBe(false);
    expect(isXUrl("not a url")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run:
```bash
pnpm --filter @karakeep/shared exec vitest run types/socialSync.test.ts
```
Expected: FAIL — youtube assertion mismatch and `isXUrl is not a function`.

- [ ] **Step 3: Update youtube required cookies**

In `packages/shared/types/socialSync.ts`, change `PLATFORM_REQUIRED_COOKIES` (lines 80–84) to:
```ts
export const PLATFORM_REQUIRED_COOKIES: Record<SocialPlatform, string[]> = {
  instagram: ["sessionid", "csrftoken", "ds_user_id"],
  x: ["auth_token", "ct0"],
  youtube: ["SID", "HSID", "SSID", "SAPISID", "APISID"],
};
```

- [ ] **Step 4: Add `isXUrl`**

In the same file, after the `isInstagramUrl` function (end of file), add:
```ts

/**
 * True when `url` points at x.com / twitter.com (or a subdomain). Like Instagram,
 * X gates tweet pages behind a login wall, so the crawler skips re-fetching
 * content the social-sync importer already populated from the authenticated API.
 */
export function isXUrl(url: string): boolean {
  try {
    return /(^|\.)(x\.com|twitter\.com)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run — shared-types tests pass**

Run:
```bash
pnpm --filter @karakeep/shared exec vitest run types/socialSync.test.ts
```
Expected: PASS.

- [ ] **Step 6: Extend the crawler skip to X**

In `apps/workers/workers/crawlerWorker.ts` line 86, change the import:
```ts
import { isInstagramUrl, isXUrl } from "@karakeep/shared/types/socialSync";
```
Change the skip condition + log (lines 2231–2234):
```ts
  if (source === "sync" && (isInstagramUrl(url) || isXUrl(url))) {
    logger.info(
      `[Crawler][${jobId}] Skipping crawl for synced login-gated bookmark "${bookmarkId}"; using importer-provided content`,
    );
```

- [ ] **Step 7: Typecheck shared + workers**

Run:
```bash
pnpm --filter @karakeep/shared typecheck && pnpm --filter @karakeep/workers typecheck
```
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/types/socialSync.ts packages/shared/types/socialSync.test.ts \
  apps/workers/workers/crawlerWorker.ts
git commit -m "feat(social-sync): expand youtube cookies, add isXUrl + X crawl skip"
```

---

## Task 2: X Bookmarks provider

**Files:**
- Create: `packages/trpc/lib/socialSync/xProvider.test.ts`
- Modify: `packages/trpc/lib/socialSync/xProvider.ts` (replace stub)

- [ ] **Step 1: Write the failing test suite**

Create `packages/trpc/lib/socialSync/xProvider.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { xProvider } from "./xProvider";

const VALID_COOKIES = JSON.stringify({ auth_token: "atk", ct0: "csrf123" });

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function tweetEntry(id: string, screen: string, text: string, media?: string) {
  const legacy: Record<string, unknown> = { full_text: text };
  if (media) {
    legacy.extended_entities = { media: [{ media_url_https: media }] };
  }
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        tweet_results: {
          result: {
            __typename: "Tweet",
            rest_id: id,
            legacy,
            core: {
              user_results: { result: { legacy: { screen_name: screen } } },
            },
          },
        },
      },
    },
  };
}

function timeline(entries: unknown[], bottomCursor: string | null = null) {
  const all = [...entries];
  if (bottomCursor) {
    all.push({
      entryId: `cursor-bottom-0`,
      content: { value: bottomCursor },
    });
  }
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [{ type: "TimelineAddEntries", entries: all }],
        },
      },
    },
  };
}

describe("xProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe("validateAuth", () => {
    test("false when ct0 missing", async () => {
      expect(
        await xProvider.validateAuth(JSON.stringify({ auth_token: "a" })),
      ).toBe(false);
    });

    test("true when the bookmarks probe returns 200", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res(timeline([])));
      expect(await xProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("false on 403", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      expect(await xProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });
  });

  describe("fetchSavedItems", () => {
    test("maps bookmarked tweets and the bottom cursor", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(
          res(
            timeline(
              [
                tweetEntry("111", "alice", "hello world", "https://pbs/img.jpg"),
                tweetEntry("222", "bob", "second tweet"),
              ],
              "CURSOR_NEXT",
            ),
          ),
        );

      const result = await xProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });

      expect(result.items).toEqual([
        {
          platformItemId: "111",
          url: "https://x.com/alice/status/111",
          title: "@alice",
          description: "hello world",
          imageUrl: "https://pbs/img.jpg",
          tags: ["x"],
        },
        {
          platformItemId: "222",
          url: "https://x.com/bob/status/222",
          title: "@bob",
          description: "second tweet",
          imageUrl: undefined,
          tags: ["x"],
        },
      ]);
      expect(result.nextCursor).toBe("CURSOR_NEXT");
      expect(result.hasMore).toBe(true);

      // auth headers
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      expect(headers["x-csrf-token"]).toBe("csrf123");
      expect(headers.Cookie).toContain("ct0=csrf123");
    });

    test("stops (hasMore false) when a page has no tweets", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        res(timeline([], "CURSOR_END")),
      );
      const result = await xProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "CURSOR_PREV",
        sinceTimestamp: null,
        limit: 100,
      });
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("throws with .status on a non-OK response", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 429));
      await expect(
        xProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 429 });
    });

    test("throws 401 for invalid cookies", async () => {
      await expect(
        xProvider.fetchSavedItems({
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

- [ ] **Step 2: Run — verify it fails**

Run:
```bash
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/xProvider.test.ts
```
Expected: FAIL (stub returns `[]` and a presence-only validateAuth).

- [ ] **Step 3: Replace the stub with the real provider**

Replace the entire contents of `packages/trpc/lib/socialSync/xProvider.ts` with:
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
// The public web app Bearer token (a long-stable constant shipped in x.com's JS).
const PUBLIC_WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
// FRAGILE — X rotates the GraphQL query id and feature flags every few weeks.
// Refresh from DevTools: open x.com/i/bookmarks → Network → the `Bookmarks`
// request → copy the id from the URL path and the `features` query param.
const BOOKMARKS_QUERY_ID = "j5KExFXMHpAla_HxgYUMSA";
const BOOKMARKS_FEATURES = {
  graphql_timeline_v2_bookmark_timeline: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};
const MAX_PAGE_SIZE = 100;
const VALIDATE_TIMEOUT_MS = 5000;
const FETCH_SAVED_ITEMS_TIMEOUT_MS = 10000;

interface XTransport {
  baseUrl: string;
  headers: Record<string, string>;
}

function cookieTransport(authCookies: string): XTransport | null {
  const cookies = normalizeCookieInput(authCookies);
  if (!cookies) return null;
  const hasRequired = PLATFORM_REQUIRED_COOKIES.x.every(
    (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
  );
  if (!hasRequired) return null;
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return {
    baseUrl: "https://x.com/i/api/graphql",
    headers: {
      Authorization: `Bearer ${PUBLIC_WEB_BEARER}`,
      "x-csrf-token": cookies.ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Cookie: cookieHeader,
    },
  };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildUrl(
  transport: XTransport,
  count: number,
  cursor: string | null,
): string {
  const variables: Record<string, unknown> = {
    count,
    includePromotedContent: false,
  };
  if (cursor) variables.cursor = cursor;
  const url = new URL(`${transport.baseUrl}/${BOOKMARKS_QUERY_ID}/Bookmarks`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(BOOKMARKS_FEATURES));
  return url.toString();
}

interface XEntry {
  entryId?: unknown;
  content?: Record<string, unknown>;
}

// Pull the TimelineAddEntries entries out of the bookmark timeline response.
function getEntries(data: unknown): XEntry[] {
  const instructions = (
    data as {
      data?: {
        bookmark_timeline_v2?: { timeline?: { instructions?: unknown } };
      };
    }
  )?.data?.bookmark_timeline_v2?.timeline?.instructions;
  if (!Array.isArray(instructions)) return [];
  for (const ins of instructions) {
    if (
      ins &&
      typeof ins === "object" &&
      (ins as { type?: unknown }).type === "TimelineAddEntries" &&
      Array.isArray((ins as { entries?: unknown }).entries)
    ) {
      return (ins as { entries: XEntry[] }).entries;
    }
  }
  return [];
}

function mapTweet(entry: XEntry): SyncItem | null {
  const itemContent = (
    entry.content as { itemContent?: Record<string, unknown> } | undefined
  )?.itemContent;
  let result = (
    itemContent as { tweet_results?: { result?: Record<string, unknown> } }
  )?.tweet_results?.result;
  if (!result) return null;
  // Tweets behind a visibility wrapper nest the real tweet under `.tweet`.
  if (result.__typename === "TweetWithVisibilityResults") {
    result = result.tweet as Record<string, unknown> | undefined;
  }
  if (!result) return null;
  const restId = asString(result.rest_id);
  if (!restId) return null;
  const legacy = result.legacy as Record<string, unknown> | undefined;
  const screenName =
    asString(
      (
        result.core as {
          user_results?: { result?: { legacy?: { screen_name?: unknown } } };
        }
      )?.user_results?.result?.legacy?.screen_name,
    ) ?? "i";
  const media =
    (legacy?.extended_entities as { media?: unknown })?.media ??
    (legacy?.entities as { media?: unknown })?.media;
  const imageUrl = Array.isArray(media)
    ? asString(
        (media[0] as { media_url_https?: unknown } | undefined)?.media_url_https,
      )
    : undefined;
  return {
    platformItemId: restId,
    url: `https://x.com/${screenName}/status/${restId}`,
    title: `@${screenName}`,
    description: asString(legacy?.full_text),
    imageUrl,
    tags: ["x"],
  };
}

function getBottomCursor(entries: XEntry[]): string | null {
  for (const entry of entries) {
    if (
      typeof entry.entryId === "string" &&
      entry.entryId.startsWith("cursor-bottom")
    ) {
      return asString((entry.content as { value?: unknown })?.value) ?? null;
    }
  }
  return null;
}

export const xProvider: SocialSyncProvider = {
  platform: "x",

  async validateAuth(authCookies: string): Promise<boolean> {
    const transport = cookieTransport(authCookies);
    if (!transport) return false;
    try {
      const res = await fetch(buildUrl(transport, 1, null), {
        method: "GET",
        headers: transport.headers,
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      await res.json();
      return true;
    } catch {
      return false;
    }
  },

  async fetchSavedItems(config) {
    const transport = cookieTransport(config.authCookies);
    if (!transport) {
      throw Object.assign(new Error("Invalid X cookies"), { status: 401 });
    }

    const count = Math.min(config.limit, MAX_PAGE_SIZE);
    const response = await fetch(buildUrl(transport, count, config.cursor), {
      method: "GET",
      headers: transport.headers,
      signal: withTimeout(config.signal, FETCH_SAVED_ITEMS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `X blocked the request (status ${response.status}). Update your cookies, or it may be rate-limited/IP-blocked.`,
        ),
        { status: response.status },
      );
    }

    const data = (await response.json()) as unknown;
    const entries = getEntries(data);
    const items: SyncItem[] = [];
    for (const entry of entries) {
      if (
        typeof entry.entryId === "string" &&
        entry.entryId.startsWith("tweet-")
      ) {
        const item = mapTweet(entry);
        if (item) items.push(item);
      }
    }

    const bottomCursor = getBottomCursor(entries);
    const hasMore = items.length > 0 && bottomCursor !== null;
    return {
      items,
      nextCursor: hasMore ? bottomCursor : null,
      hasMore,
    };
  },
};
```

- [ ] **Step 4: Run — verify it passes**

Run:
```bash
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/xProvider.test.ts
```
Expected: PASS (all X tests).

- [ ] **Step 5: Commit**

```bash
git add packages/trpc/lib/socialSync/xProvider.ts packages/trpc/lib/socialSync/xProvider.test.ts
git commit -m "feat(social-sync): implement cookie-based X Bookmarks provider"
```

---

## Task 3: YouTube Watch Later provider

**Files:**
- Create: `packages/trpc/lib/socialSync/youtubeProvider.test.ts`
- Modify: `packages/trpc/lib/socialSync/youtubeProvider.ts` (replace stub)

- [ ] **Step 1: Write the failing test suite**

Create `packages/trpc/lib/socialSync/youtubeProvider.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { youtubeProvider } from "./youtubeProvider";

const VALID_COOKIES = JSON.stringify({
  SID: "sid",
  HSID: "hsid",
  SSID: "ssid",
  SAPISID: "sapisid-value",
  APISID: "apisid",
});

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function video(id: string, title: string) {
  return { playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] } } };
}

function firstPage(videos: unknown[], continuation: string | null = null) {
  const contents: unknown[] = [...videos];
  if (continuation) {
    contents.push({
      continuationItemRenderer: {
        continuationEndpoint: { continuationCommand: { token: continuation } },
      },
    });
  }
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      itemSectionRenderer: {
                        contents: [{ playlistVideoListRenderer: { contents } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

describe("youtubeProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe("validateAuth", () => {
    test("false when SAPISID missing", async () => {
      expect(
        await youtubeProvider.validateAuth(
          JSON.stringify({ SID: "s", HSID: "h", SSID: "s", APISID: "a" }),
        ),
      ).toBe(false);
    });

    test("true when the browse probe returns 200", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res(firstPage([])));
      expect(await youtubeProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("false on 401", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 401));
      expect(await youtubeProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });
  });

  describe("fetchSavedItems", () => {
    test("maps Watch Later videos, the continuation cursor, and sends a SAPISIDHASH auth header", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(
          res(
            firstPage(
              [video("vid1", "First video"), video("vid2", "Second video")],
              "CONT_TOKEN",
            ),
          ),
        );

      const result = await youtubeProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });

      expect(result.items).toEqual([
        {
          platformItemId: "vid1",
          url: "https://www.youtube.com/watch?v=vid1",
          title: "First video",
          tags: ["youtube"],
        },
        {
          platformItemId: "vid2",
          url: "https://www.youtube.com/watch?v=vid2",
          title: "Second video",
          tags: ["youtube"],
        },
      ]);
      expect(result.nextCursor).toBe("CONT_TOKEN");
      expect(result.hasMore).toBe(true);

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/);
      expect(headers.Cookie).toContain("SAPISID=sapisid-value");
    });

    test("no continuation → hasMore false", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        res(firstPage([video("only", "Only video")], null)),
      );
      const result = await youtubeProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });
      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("throws with .status on a non-OK response", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      await expect(
        youtubeProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    test("throws 401 for invalid cookies", async () => {
      await expect(
        youtubeProvider.fetchSavedItems({
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

- [ ] **Step 2: Run — verify it fails**

Run:
```bash
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/youtubeProvider.test.ts
```
Expected: FAIL (stub).

- [ ] **Step 3: Replace the stub with the real provider**

Replace the entire contents of `packages/trpc/lib/socialSync/youtubeProvider.ts` with:
```ts
import { createHash } from "crypto";

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
const ORIGIN = "https://www.youtube.com";
// Public web InnerTube key (shipped in youtube.com's JS).
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
// FRAGILE — bump occasionally to a current value from youtube.com's ytcfg
// (`INNERTUBE_CONTEXT.client.clientVersion`).
const CLIENT_VERSION = "2.20240620.05.00";
const WATCH_LATER_BROWSE_ID = "VLWL";
const BROWSE_URL = `${ORIGIN}/youtubei/v1/browse`;
const FETCH_SAVED_ITEMS_TIMEOUT_MS = 10000;
const VALIDATE_TIMEOUT_MS = 5000;

interface YouTubeTransport {
  headers: Record<string, string>;
}

// Authorization: SAPISIDHASH <ts>_<sha1(`<ts> <SAPISID> <origin>`)>
function sapisidHash(sapisid: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const hash = createHash("sha1")
    .update(`${ts} ${sapisid} ${ORIGIN}`)
    .digest("hex");
  return `SAPISIDHASH ${ts}_${hash}`;
}

function cookieTransport(authCookies: string): YouTubeTransport | null {
  const cookies = normalizeCookieInput(authCookies);
  if (!cookies) return null;
  const hasRequired = PLATFORM_REQUIRED_COOKIES.youtube.every(
    (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
  );
  if (!hasRequired) return null;
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return {
    headers: {
      Authorization: sapisidHash(cookies.SAPISID),
      Cookie: cookieHeader,
      "Content-Type": "application/json",
      "x-origin": ORIGIN,
      "x-goog-authuser": "0",
      "User-Agent": USER_AGENT,
    },
  };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function browseBody(cursor: string | null): string {
  const context = {
    client: {
      clientName: "WEB",
      clientVersion: CLIENT_VERSION,
      hl: "en",
      gl: "US",
    },
  };
  return JSON.stringify(
    cursor
      ? { context, continuation: cursor }
      : { context, browseId: WATCH_LATER_BROWSE_ID },
  );
}

// The renderer tree differs between the first page and continuations, so walk it
// recursively for playlistVideoRenderer items and the continuation token instead
// of hardcoding deep paths.
function collectVideos(
  node: unknown,
  out: { videoId: string; title?: string }[],
): void {
  if (Array.isArray(node)) {
    for (const n of node) collectVideos(n, out);
    return;
  }
  if (node && typeof node === "object") {
    const r = (node as { playlistVideoRenderer?: Record<string, unknown> })
      .playlistVideoRenderer;
    if (r) {
      const videoId = r.videoId;
      const title =
        (r.title as { runs?: { text?: unknown }[] })?.runs?.[0]?.text ??
        (r.title as { simpleText?: unknown })?.simpleText;
      if (typeof videoId === "string" && videoId.length > 0) {
        out.push({
          videoId,
          title: typeof title === "string" ? title : undefined,
        });
      }
    }
    for (const value of Object.values(node)) collectVideos(value, out);
  }
}

function findContinuation(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const c = findContinuation(n);
      if (c) return c;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const token = (
      node as {
        continuationItemRenderer?: {
          continuationEndpoint?: { continuationCommand?: { token?: unknown } };
        };
      }
    ).continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof token === "string" && token.length > 0) return token;
    for (const value of Object.values(node)) {
      const c = findContinuation(value);
      if (c) return c;
    }
  }
  return null;
}

export const youtubeProvider: SocialSyncProvider = {
  platform: "youtube",

  async validateAuth(authCookies: string): Promise<boolean> {
    const transport = cookieTransport(authCookies);
    if (!transport) return false;
    try {
      const res = await fetch(
        `${BROWSE_URL}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
        {
          method: "POST",
          headers: transport.headers,
          body: browseBody(null),
          signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        },
      );
      if (!res.ok) return false;
      await res.json();
      return true;
    } catch {
      return false;
    }
  },

  async fetchSavedItems(config) {
    const transport = cookieTransport(config.authCookies);
    if (!transport) {
      throw Object.assign(new Error("Invalid YouTube cookies"), { status: 401 });
    }

    const response = await fetch(
      `${BROWSE_URL}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
      {
        method: "POST",
        headers: transport.headers,
        body: browseBody(config.cursor),
        signal: withTimeout(config.signal, FETCH_SAVED_ITEMS_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `YouTube blocked the request (status ${response.status}). Update your cookies, or it may be an IP block.`,
        ),
        { status: response.status },
      );
    }

    const data = (await response.json()) as unknown;
    const videos: { videoId: string; title?: string }[] = [];
    collectVideos(data, videos);
    const items: SyncItem[] = videos.map((v) => ({
      platformItemId: v.videoId,
      url: `${ORIGIN}/watch?v=${v.videoId}`,
      title: v.title,
      tags: ["youtube"],
    }));

    const nextCursor = findContinuation(data);
    return {
      items,
      nextCursor,
      hasMore: nextCursor !== null,
    };
  },
};
```

- [ ] **Step 4: Run — verify it passes**

Run:
```bash
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync/youtubeProvider.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/trpc/lib/socialSync/youtubeProvider.ts packages/trpc/lib/socialSync/youtubeProvider.test.ts
git commit -m "feat(social-sync): implement cookie-based YouTube Watch Later provider"
```

---

## Task 4: Repo-wide verification

- [ ] **Step 1: Format**

Run:
```bash
pnpm --filter @karakeep/shared format:fix
pnpm --filter @karakeep/trpc format:fix
pnpm --filter @karakeep/workers format:fix
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @karakeep/shared typecheck && \
pnpm --filter @karakeep/trpc typecheck && \
pnpm --filter @karakeep/workers typecheck
```
Expected: all pass.

- [ ] **Step 3: Lint**

Run:
```bash
pnpm --filter @karakeep/shared lint && pnpm --filter @karakeep/trpc lint
```
Expected: 0 warnings, 0 errors.

- [ ] **Step 4: Run the social-sync test suites**

Run:
```bash
pnpm --filter @karakeep/shared exec vitest run types/socialSync.test.ts
pnpm --filter @karakeep/trpc exec vitest run lib/socialSync
```
Expected: all pass (shared types + instagram/x/youtube/syncEngine).

- [ ] **Step 5: Commit any formatting**

```bash
git add -A
git commit -m "chore(social-sync): format X + YouTube provider changes" || echo "nothing to format"
```

---

## Task 5: Manual feasibility check (handed to the user)

- [ ] **X:** In x.com (logged in), export cookies (need `auth_token` + `ct0`). Settings → Social Sync → **X** → Connect → paste → Sync now. If it 404/400s, the `BOOKMARKS_QUERY_ID`/`FEATURES` are stale — refresh them from DevTools (comment in `xProvider.ts`).
- [ ] **YouTube:** In youtube.com (logged in), export cookies (need `SID/HSID/SSID/SAPISID/APISID`). Connect **YouTube** → paste → Sync now. Watch Later videos should import tagged `youtube`. A 401/403 means the SAPISIDHASH/session was rejected (or IP block).

---

## Self-Review

**Spec coverage:**
- youtube cookies expand + `isXUrl` + X crawler skip → Task 1. ✓
- X provider (bearer/csrf headers, GraphQL Bookmarks, timeline parse, t-mapping with description/imageUrl, cursor, validateAuth, `.status` errors) → Task 2. ✓
- YouTube provider (SAPISIDHASH, InnerTube browse VLWL, recursive renderer parse, continuation cursor, validateAuth, `.status` errors) → Task 3. ✓
- Tests (mocked fetch fixtures) → Tasks 2–3 step 1; shared-types → Task 1. ✓
- Verification + manual feasibility → Tasks 4–5. ✓
- No enum/schema change (x/youtube already exist) → reflected; no such task. ✓

**Placeholder scan:** No TBD/TODO. Fragile constants (`BOOKMARKS_QUERY_ID`, `BOOKMARKS_FEATURES`, `CLIENT_VERSION`) are real values with refresh comments — documented external dependencies, not placeholders. Every step has complete code + expected output.

**Type/name consistency:** `cookieTransport`/`withTimeout`/`asString` defined per provider; `xProvider`/`youtubeProvider` exports match `providers.ts` registration (unchanged). `PLATFORM_REQUIRED_COOKIES.youtube` 5-cookie array matches Task 1 type change, the shared test, and `cookieTransport`'s presence check. `isXUrl` defined in Task 1 step 4, used in Task 1 step 6 (crawler) and tested in step 1. SAPISIDHASH header regex in the YT test (`^SAPISIDHASH \d+_[0-9a-f]{40}$`) matches `sapisidHash`'s output format.

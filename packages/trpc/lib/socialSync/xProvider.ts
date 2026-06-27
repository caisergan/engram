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
        (media[0] as { media_url_https?: unknown } | undefined)
          ?.media_url_https,
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

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

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
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
    return {
      platformItemId: name,
      url,
      title: asString(data.link_title),
      tags,
    };
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
  return {
    username: cursor.slice(0, sep),
    after: after.length > 0 ? after : null,
  };
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

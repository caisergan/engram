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
    ).continuationItemRenderer?.continuationEndpoint?.continuationCommand
      ?.token;
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
      throw Object.assign(new Error("Invalid YouTube cookies"), {
        status: 401,
      });
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

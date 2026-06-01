import {
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "@karakeep/shared/types/socialSync";
import type {
  SocialSyncProvider,
  SyncItem,
} from "@karakeep/shared/types/socialSync";
const IG_APP_ID = "936619743392459";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const VALIDATE_URL =
  "https://www.instagram.com/api/v1/accounts/edit/web_form_data/";
const SAVED_POSTS_URL = "https://www.instagram.com/api/v1/feed/saved/posts/";
const MAX_PAGE_SIZE = 50;
const VALIDATE_TIMEOUT_MS = 5000;
const FETCH_SAVED_ITEMS_TIMEOUT_MS = 10000;

interface ParsedCookies {
  sessionid: string;
  csrftoken: string;
  ds_user_id: string;
}

function parseCookies(authCookies: string): ParsedCookies | null {
  const cookies = normalizeCookieInput(authCookies);
  if (!cookies) return null;
  const valid = PLATFORM_REQUIRED_COOKIES.instagram.every(
    (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
  );
  if (!valid) return null;
  return {
    sessionid: cookies.sessionid,
    csrftoken: cookies.csrftoken,
    ds_user_id: cookies.ds_user_id,
  };
}

function buildHeaders(cookies: ParsedCookies): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    "X-IG-App-ID": IG_APP_ID,
    "X-CSRFToken": cookies.csrftoken,
    // Instagram's web API rejects requests whose Sec-Fetch-Site is not
    // same-origin with HTTP 400 "SecFetch Policy violation.". Node's fetch
    // sends a violating value by default, so set the browser-like same-origin
    // values the real web client uses.
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie: `sessionid=${cookies.sessionid}; csrftoken=${cookies.csrftoken}; ds_user_id=${cookies.ds_user_id}`,
  };
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#(\w+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

interface ImageCandidate {
  url?: unknown;
  width?: unknown;
}

interface ImageVersions {
  candidates?: unknown;
}

/** Pick the highest-resolution candidate URL from an `image_versions2` blob. */
function pickBestCandidate(
  imageVersions: ImageVersions | null | undefined,
): string | undefined {
  const candidates = imageVersions?.candidates;
  if (!Array.isArray(candidates)) return undefined;

  let best: { url: string; width: number } | undefined;
  for (const candidate of candidates as ImageCandidate[]) {
    if (typeof candidate?.url !== "string" || candidate.url.length === 0) {
      continue;
    }
    const width = typeof candidate.width === "number" ? candidate.width : 0;
    if (!best || width > best.width) {
      best = { url: candidate.url, width };
    }
  }
  return best?.url;
}

/**
 * Resolve the best preview image for a saved media object. Photos and reels
 * carry their image (or video cover) in `image_versions2`; carousels nest the
 * frames in `carousel_media`, so we fall back to the first frame's image.
 */
function extractImageUrl(media: Record<string, unknown>): string | undefined {
  const direct = pickBestCandidate(
    media.image_versions2 as ImageVersions | null | undefined,
  );
  if (direct) return direct;

  const carousel = media.carousel_media;
  if (Array.isArray(carousel)) {
    for (const frame of carousel as Record<string, unknown>[]) {
      const frameImage = pickBestCandidate(
        frame?.image_versions2 as ImageVersions | null | undefined,
      );
      if (frameImage) return frameImage;
    }
  }
  return undefined;
}

function buildFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(FETCH_SAVED_ITEMS_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export const instagramProvider: SocialSyncProvider = {
  platform: "instagram",

  async validateAuth(authCookies: string): Promise<boolean> {
    const cookies = parseCookies(authCookies);
    if (!cookies) return false;

    try {
      const response = await fetch(VALIDATE_URL, {
        method: "GET",
        headers: buildHeaders(cookies),
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  async fetchSavedItems(config) {
    const cookies = parseCookies(config.authCookies);
    if (!cookies) {
      throw Object.assign(new Error("Invalid Instagram cookies"), {
        status: 401,
      });
    }

    const count = Math.min(config.limit, MAX_PAGE_SIZE);
    const url = new URL(SAVED_POSTS_URL);
    url.searchParams.set("count", String(count));
    if (config.cursor) {
      url.searchParams.set("max_id", config.cursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: buildHeaders(cookies),
      signal: buildFetchSignal(config.signal),
    });

    if (!response.ok) {
      throw Object.assign(
        new Error(`Instagram API error: ${response.status}`),
        { status: response.status },
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items: SyncItem[] = [];

    for (const raw of rawItems) {
      const media = (raw as Record<string, unknown>)?.media as
        | Record<string, unknown>
        | undefined;
      if (!media?.code) continue;

      const code = media.code as string;
      const user = media.user as { username?: string } | null | undefined;
      const caption = media.caption as { text?: string } | null | undefined;
      const productType = media.product_type as string | undefined;

      const isReel = productType === "clips";
      const itemUrl = isReel
        ? `https://www.instagram.com/reel/${code}/`
        : `https://www.instagram.com/p/${code}/`;

      const username = user?.username ?? "unknown";
      const captionText = caption?.text ?? "";
      const hashtags = extractHashtags(captionText);
      const imageUrl = extractImageUrl(media);

      items.push({
        platformItemId: code,
        url: itemUrl,
        title: `@${username}`,
        tags: ["instagram", ...hashtags],
        description: captionText.length > 0 ? captionText : undefined,
        imageUrl,
      });
    }

    return {
      items,
      nextCursor: (data.next_max_id as string) ?? null,
      hasMore: (data.more_available as boolean) ?? false,
    };
  },
};

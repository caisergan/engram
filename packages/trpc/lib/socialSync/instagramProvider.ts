import { PLATFORM_REQUIRED_COOKIES } from "@karakeep/shared/types/socialSync";
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

interface ParsedCookies {
  sessionid: string;
  csrftoken: string;
  ds_user_id: string;
}

function parseCookies(authCookies: string): ParsedCookies | null {
  try {
    const cookies = JSON.parse(authCookies);
    const valid = PLATFORM_REQUIRED_COOKIES.instagram.every(
      (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
    );
    if (!valid) return null;
    return cookies as ParsedCookies;
  } catch {
    return null;
  }
}

function buildHeaders(cookies: ParsedCookies): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    "X-IG-App-ID": IG_APP_ID,
    "X-CSRFToken": cookies.csrftoken,
    Cookie: `sessionid=${cookies.sessionid}; csrftoken=${cookies.csrftoken}; ds_user_id=${cookies.ds_user_id}`,
  };
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#(\w+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
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

      items.push({
        platformItemId: code,
        url: itemUrl,
        title: `@${username}`,
        tags: ["instagram", ...hashtags],
      });
    }

    return {
      items,
      nextCursor: (data.next_max_id as string) ?? null,
      hasMore: (data.more_available as boolean) ?? false,
    };
  },
};

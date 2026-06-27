import { z } from "zod";

export const zSocialPlatformSchema = z.enum([
  "instagram",
  "x",
  "youtube",
  "reddit",
]);
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

export interface SyncItem {
  platformItemId: string;
  url: string;
  title?: string;
  tags?: string[];
  /**
   * Post caption / description text. Providers that fetch from an authenticated
   * API (e.g. Instagram) populate this so the importer doesn't have to rely on a
   * public crawl that would hit a login wall.
   */
  description?: string;
  /**
   * Best available preview image (photo, reel cover, or first carousel frame).
   * The importer downloads this into a banner asset because the CDN URLs are
   * signed and expire, so persisting the URL alone would yield broken images.
   */
  imageUrl?: string;
}

export interface SocialSyncProvider {
  platform: SocialPlatform;

  fetchSavedItems(config: {
    authCookies: string;
    cursor: string | null;
    sinceTimestamp: Date | null;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{
    items: SyncItem[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;

  validateAuth(authCookies: string): Promise<boolean>;
}

export const PLATFORM_REQUIRED_COOKIES: Record<SocialPlatform, string[]> = {
  instagram: ["sessionid", "csrftoken", "ds_user_id"],
  x: ["auth_token", "ct0"],
  youtube: ["SID", "HSID", "SSID", "SAPISID", "APISID"],
  reddit: ["reddit_session", "token_v2"],
};

/**
 * Build the JSON cookie blob the social-sync providers expect, keeping only the
 * required cookies for the platform. Returns null if any required cookie is
 * missing or empty (e.g. the user isn't logged in).
 */
export function buildCookieBlob(
  platform: SocialPlatform,
  available: Record<string, string>,
): string | null {
  const blob: Record<string, string> = {};
  for (const name of PLATFORM_REQUIRED_COOKIES[platform]) {
    const value = available[name];
    if (typeof value !== "string" || value.length === 0) return null;
    blob[name] = value;
  }
  return JSON.stringify(blob);
}

/**
 * Normalize whatever cookie payload a user (or the browser extension) provides
 * into a flat `{ name: value }` map. Providers validate the required cookies
 * against this map, so they don't each have to understand the input shape.
 *
 * Accepts the three shapes users actually paste/send:
 *  - A cookie-export extension array, e.g. Cookie-Editor: `[{ name, value, ... }]`
 *  - A flat object blob (what {@link buildCookieBlob} emits): `{ sessionid: "..." }`
 *  - A raw cookie header string: `"sessionid=...; csrftoken=..."`
 *
 * Values are kept verbatim (URL-encoded values are preserved as-is, which is how
 * they must be sent in the Cookie header). Returns null only when the input is
 * blank or cannot be parsed as any of the supported shapes.
 */
export function normalizeCookieInput(
  input: string,
): Record<string, string> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);

    // Cookie-export extension format: array of { name, value, ... } entries.
    if (Array.isArray(parsed)) {
      const map: Record<string, string> = {};
      for (const entry of parsed) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { name?: unknown }).name === "string" &&
          typeof (entry as { value?: unknown }).value === "string"
        ) {
          const { name, value } = entry as { name: string; value: string };
          map[name] = value;
        }
      }
      return map;
    }

    // Flat object blob: { name: value }. Keep only string values.
    if (parsed && typeof parsed === "object") {
      const map: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === "string") map[name] = value;
      }
      return map;
    }

    return null;
  } catch {
    // Not JSON — fall through to raw cookie-header parsing.
  }

  // Raw cookie header string: "name=value; name2=value2".
  if (trimmed.includes("=")) {
    const map: Record<string, string> = {};
    for (const part of trimmed.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (!name) continue;
      map[name] = part.slice(eq + 1).trim();
    }
    return map;
  }

  return null;
}

/**
 * True when `url` points at instagram.com (or a subdomain). Instagram post
 * pages can't be crawled server-side without a session (they redirect to a
 * login wall), so the crawler uses this to skip re-fetching content that the
 * social-sync importer already populated from the authenticated API.
 */
export function isInstagramUrl(url: string): boolean {
  try {
    return /(^|\.)instagram\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

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

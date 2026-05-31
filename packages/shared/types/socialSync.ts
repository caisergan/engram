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

export const PLATFORM_REQUIRED_COOKIES: Record<SocialPlatform, string[]> = {
  instagram: ["sessionid", "csrftoken", "ds_user_id"],
  x: ["auth_token", "ct0"],
  youtube: ["SID", "HSID", "SSID"],
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

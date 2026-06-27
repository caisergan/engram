import { buildCookieBlob } from "@karakeep/shared/types/socialSync";

import type { ConnectablePlatform } from "./socialSyncPermissions";

const PLATFORM_COOKIE_DOMAINS: Record<ConnectablePlatform, string[]> = {
  instagram: [".instagram.com"],
  x: [".x.com", ".twitter.com"],
  reddit: [".reddit.com"],
};

/**
 * Read the current session cookies for a platform via the extension cookies API
 * (which can read httpOnly cookies like `sessionid`) and produce the JSON blob
 * the social-sync backend expects. Returns null if a required cookie is missing
 * (i.e. the user isn't logged in to that platform in this browser).
 */
export async function readPlatformCookies(
  platform: ConnectablePlatform,
): Promise<string | null> {
  const available: Record<string, string> = {};
  for (const domain of PLATFORM_COOKIE_DOMAINS[platform]) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const cookie of cookies) {
      // First non-empty value wins (cookies may appear on multiple subdomains).
      if (cookie.value && !available[cookie.name]) {
        available[cookie.name] = cookie.value;
      }
    }
  }
  return buildCookieBlob(platform, available);
}

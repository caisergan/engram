/**
 * Per-platform permission helpers for social-sync connect. The `cookies`
 * permission and platform host access are *optional* — requested on demand from
 * a user gesture (the Connect button), never granted at install time.
 */

export type ConnectablePlatform = "instagram" | "x";

const PLATFORM_ORIGINS: Record<ConnectablePlatform, string[]> = {
  instagram: ["https://*.instagram.com/*"],
  x: ["https://*.x.com/*", "https://*.twitter.com/*"],
};

function permissionsFor(
  platform: ConnectablePlatform,
): chrome.permissions.Permissions {
  return { permissions: ["cookies"], origins: PLATFORM_ORIGINS[platform] };
}

export function requestPlatformAccess(
  platform: ConnectablePlatform,
): Promise<boolean> {
  return chrome.permissions.request(permissionsFor(platform));
}

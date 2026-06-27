import {
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "@karakeep/shared/types/socialSync";
import type { SocialSyncProvider } from "@karakeep/shared/types/socialSync";

// Stub — real implementation lands in the next task. Keeps the platform enum
// compiling (providers.ts requires a Reddit entry) and shows Reddit in the UI
// as a no-op, matching the existing X/YouTube stubs.
export const redditProvider: SocialSyncProvider = {
  platform: "reddit",

  async validateAuth(authCookies: string): Promise<boolean> {
    const cookies = normalizeCookieInput(authCookies);
    if (!cookies) return false;
    return PLATFORM_REQUIRED_COOKIES.reddit.every(
      (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
    );
  },

  async fetchSavedItems() {
    return { items: [], nextCursor: null, hasMore: false };
  },
};

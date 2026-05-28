import type { SocialSyncProvider } from "@karakeep/shared/types/socialSync";

const REQUIRED_COOKIES = ["sessionid", "csrftoken", "ds_user_id"];

export const instagramProvider: SocialSyncProvider = {
  platform: "instagram",

  async validateAuth(authCookies: string): Promise<boolean> {
    try {
      const cookies = JSON.parse(authCookies);
      return REQUIRED_COOKIES.every(
        (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
      );
    } catch {
      return false;
    }
  },

  async fetchSavedItems(_config) {
    // Stub: actual Instagram API scraping to be implemented
    return { items: [], nextCursor: null, hasMore: false };
  },
};

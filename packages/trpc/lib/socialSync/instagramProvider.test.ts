import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { instagramProvider } from "./instagramProvider";

const VALID_COOKIES = JSON.stringify({
  sessionid: "abc123",
  csrftoken: "xyz789",
  ds_user_id: "12345",
});

function mockFetchResponse(
  body: unknown,
  status = 200,
  ok = status >= 200 && status < 300,
) {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as Response);
}

function makeInstagramItem(overrides: Record<string, unknown> = {}) {
  return {
    media: {
      code: "ABC123def",
      user: { username: "testuser" },
      caption: { text: "Check this out #design #ai" },
      media_type: 1,
      product_type: "feed",
      ...overrides,
    },
  };
}

describe("instagramProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validateAuth", () => {
    test("returns false for invalid JSON", async () => {
      expect(await instagramProvider.validateAuth("not json")).toBe(false);
    });

    test("returns false when sessionid is missing", async () => {
      const cookies = JSON.stringify({
        csrftoken: "xyz",
        ds_user_id: "123",
      });
      expect(await instagramProvider.validateAuth(cookies)).toBe(false);
    });

    test("returns false when csrftoken is missing", async () => {
      const cookies = JSON.stringify({
        sessionid: "abc",
        ds_user_id: "123",
      });
      expect(await instagramProvider.validateAuth(cookies)).toBe(false);
    });

    test("returns false when ds_user_id is missing", async () => {
      const cookies = JSON.stringify({
        sessionid: "abc",
        csrftoken: "xyz",
      });
      expect(await instagramProvider.validateAuth(cookies)).toBe(false);
    });

    test("returns false when a cookie value is empty string", async () => {
      const cookies = JSON.stringify({
        sessionid: "",
        csrftoken: "xyz",
        ds_user_id: "123",
      });
      expect(await instagramProvider.validateAuth(cookies)).toBe(false);
    });

    test("returns true when Instagram API confirms session is valid", async () => {
      mockFetchResponse({ form_data: {} }, 200);
      expect(await instagramProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("accepts a Cookie-Editor array export (what the connect dialog asks for)", async () => {
      mockFetchResponse({ form_data: {} }, 200);
      const cookieEditorExport = JSON.stringify([
        { name: "sessionid", value: "abc123", domain: ".instagram.com" },
        { name: "csrftoken", value: "xyz789", domain: ".instagram.com" },
        { name: "ds_user_id", value: "12345", domain: ".instagram.com" },
        { name: "ig_did", value: "irrelevant", domain: ".instagram.com" },
      ]);
      expect(await instagramProvider.validateAuth(cookieEditorExport)).toBe(
        true,
      );
    });

    test("builds the Cookie header from an array export", async () => {
      const spy = mockFetchResponse({ form_data: {} }, 200);
      const cookieEditorExport = JSON.stringify([
        { name: "sessionid", value: "abc123" },
        { name: "csrftoken", value: "xyz789" },
        { name: "ds_user_id", value: "12345" },
      ]);
      await instagramProvider.validateAuth(cookieEditorExport);
      const [, options] = spy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Cookie"]).toContain("sessionid=abc123");
      expect(headers["X-CSRFToken"]).toBe("xyz789");
    });

    test("returns false when Instagram API returns 401", async () => {
      mockFetchResponse({}, 401, false);
      expect(await instagramProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });

    test("returns false when Instagram API returns 403", async () => {
      mockFetchResponse({}, 403, false);
      expect(await instagramProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });

    test("returns false when fetch throws (network error)", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(
        new Error("Network error"),
      );
      expect(await instagramProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });

    test("sends correct headers to Instagram API", async () => {
      const spy = mockFetchResponse({ form_data: {} }, 200);
      await instagramProvider.validateAuth(VALID_COOKIES);

      expect(spy).toHaveBeenCalledOnce();
      const [url, options] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("instagram.com/api/v1/accounts/edit/web_form_data");
      expect(options.headers).toBeDefined();
      const headers = options.headers as Record<string, string>;
      expect(headers["X-IG-App-ID"]).toBe("936619743392459");
      expect(headers["Cookie"]).toContain("sessionid=abc123");
      expect(headers["Cookie"]).toContain("csrftoken=xyz789");
      expect(headers["Cookie"]).toContain("ds_user_id=12345");
      expect(headers["X-CSRFToken"]).toBe("xyz789");
    });

    test("sends Sec-Fetch-Site=same-origin to satisfy Instagram's SecFetch policy", async () => {
      const spy = mockFetchResponse({ form_data: {} }, 200);
      await instagramProvider.validateAuth(VALID_COOKIES);
      const [, options] = spy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      // Node's fetch otherwise sends a Sec-Fetch-Site value Instagram rejects
      // with HTTP 400 "SecFetch Policy violation.".
      expect(headers["Sec-Fetch-Site"]).toBe("same-origin");
    });
  });

  describe("fetchSavedItems", () => {
    test("fetches saved posts and maps to SyncItems", async () => {
      mockFetchResponse({
        items: [makeInstagramItem()],
        more_available: false,
        next_max_id: null,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].platformItemId).toBe("ABC123def");
      expect(result.items[0].url).toBe(
        "https://www.instagram.com/p/ABC123def/",
      );
      expect(result.items[0].title).toBe("@testuser");
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("uses /reel/ URL for clips product type", async () => {
      mockFetchResponse({
        items: [makeInstagramItem({ product_type: "clips" })],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items[0].url).toBe(
        "https://www.instagram.com/reel/ABC123def/",
      );
    });

    test("uses /p/ URL for non-clips media", async () => {
      mockFetchResponse({
        items: [makeInstagramItem({ product_type: "feed", media_type: 8 })],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items[0].url).toBe(
        "https://www.instagram.com/p/ABC123def/",
      );
    });

    test("extracts hashtags from caption into tags", async () => {
      mockFetchResponse({
        items: [
          makeInstagramItem({
            caption: { text: "Love this #design #AI #web3" },
          }),
        ],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items[0].tags).toContain("instagram");
      expect(result.items[0].tags).toContain("design");
      expect(result.items[0].tags).toContain("AI");
      expect(result.items[0].tags).toContain("web3");
    });

    test("includes instagram tag even when no hashtags in caption", async () => {
      mockFetchResponse({
        items: [makeInstagramItem({ caption: { text: "No hashtags here" } })],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items[0].tags).toEqual(["instagram"]);
    });

    test("handles missing caption gracefully", async () => {
      mockFetchResponse({
        items: [makeInstagramItem({ caption: null })],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items[0].tags).toEqual(["instagram"]);
      expect(result.items[0].title).toBe("@testuser");
    });

    test("handles missing username gracefully", async () => {
      mockFetchResponse({
        items: [makeInstagramItem({ user: null })],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items[0].title).toBe("@unknown");
    });

    test("passes cursor as max_id query parameter", async () => {
      const spy = mockFetchResponse({
        items: [],
        more_available: false,
      });

      await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "cursor_abc_123",
        sinceTimestamp: null,
        limit: 50,
      });

      const [url] = spy.mock.calls[0] as [string];
      expect(url).toContain("max_id=cursor_abc_123");
    });

    test("does not include max_id when cursor is null", async () => {
      const spy = mockFetchResponse({
        items: [],
        more_available: false,
      });

      await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      const [url] = spy.mock.calls[0] as [string];
      expect(url).not.toContain("max_id");
    });

    test("returns nextCursor and hasMore from response", async () => {
      mockFetchResponse({
        items: [makeInstagramItem()],
        more_available: true,
        next_max_id: "next_page_cursor",
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.nextCursor).toBe("next_page_cursor");
      expect(result.hasMore).toBe(true);
    });

    test("caps count at 50 even if limit is higher", async () => {
      const spy = mockFetchResponse({
        items: [],
        more_available: false,
      });

      await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 200,
      });

      const [url] = spy.mock.calls[0] as [string];
      expect(url).toContain("count=50");
    });

    test("uses limit as count when limit is less than 50", async () => {
      const spy = mockFetchResponse({
        items: [],
        more_available: false,
      });

      await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 10,
      });

      const [url] = spy.mock.calls[0] as [string];
      expect(url).toContain("count=10");
    });

    test("skips items with missing media.code", async () => {
      mockFetchResponse({
        items: [
          makeInstagramItem(),
          { media: { user: { username: "nocode" }, media_type: 1 } },
          makeInstagramItem({ code: "SECOND" }),
        ],
        more_available: false,
      });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].platformItemId).toBe("ABC123def");
      expect(result.items[1].platformItemId).toBe("SECOND");
    });

    test("throws with status on 401 response", async () => {
      mockFetchResponse({ message: "login_required" }, 401, false);

      await expect(
        instagramProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 50,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    test("throws with status on 403 response", async () => {
      mockFetchResponse({}, 403, false);

      await expect(
        instagramProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 50,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    test("throws with status on 429 response", async () => {
      mockFetchResponse({}, 429, false);

      await expect(
        instagramProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 50,
        }),
      ).rejects.toMatchObject({ status: 429 });
    });

    test("returns empty items when response has no items array", async () => {
      mockFetchResponse({ some_other_field: true });

      const result = await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    test("sends correct auth headers", async () => {
      const spy = mockFetchResponse({
        items: [],
        more_available: false,
      });

      await instagramProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 50,
      });

      const [, options] = spy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["X-IG-App-ID"]).toBe("936619743392459");
      expect(headers["Cookie"]).toContain("sessionid=abc123");
      expect(headers["X-CSRFToken"]).toBe("xyz789");
      expect(headers["User-Agent"]).toBeDefined();
      expect(headers["User-Agent"]).toContain("Chrome");
    });
  });
});

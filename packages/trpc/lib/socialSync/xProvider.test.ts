import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { xProvider } from "./xProvider";

const VALID_COOKIES = JSON.stringify({ auth_token: "atk", ct0: "csrf123" });

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function tweetEntry(id: string, screen: string, text: string, media?: string) {
  const legacy: Record<string, unknown> = { full_text: text };
  if (media) {
    legacy.extended_entities = { media: [{ media_url_https: media }] };
  }
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        tweet_results: {
          result: {
            __typename: "Tweet",
            rest_id: id,
            legacy,
            core: {
              user_results: { result: { legacy: { screen_name: screen } } },
            },
          },
        },
      },
    },
  };
}

function timeline(entries: unknown[], bottomCursor: string | null = null) {
  const all = [...entries];
  if (bottomCursor) {
    all.push({
      entryId: `cursor-bottom-0`,
      content: { value: bottomCursor },
    });
  }
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [{ type: "TimelineAddEntries", entries: all }],
        },
      },
    },
  };
}

describe("xProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe("validateAuth", () => {
    test("false when ct0 missing", async () => {
      expect(
        await xProvider.validateAuth(JSON.stringify({ auth_token: "a" })),
      ).toBe(false);
    });

    test("true when the bookmarks probe returns 200", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res(timeline([])));
      expect(await xProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("false on 403", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      expect(await xProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });
  });

  describe("fetchSavedItems", () => {
    test("maps bookmarked tweets and the bottom cursor", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(
          res(
            timeline(
              [
                tweetEntry("111", "alice", "hello world", "https://pbs/img.jpg"),
                tweetEntry("222", "bob", "second tweet"),
              ],
              "CURSOR_NEXT",
            ),
          ),
        );

      const result = await xProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });

      expect(result.items).toEqual([
        {
          platformItemId: "111",
          url: "https://x.com/alice/status/111",
          title: "@alice",
          description: "hello world",
          imageUrl: "https://pbs/img.jpg",
          tags: ["x"],
        },
        {
          platformItemId: "222",
          url: "https://x.com/bob/status/222",
          title: "@bob",
          description: "second tweet",
          imageUrl: undefined,
          tags: ["x"],
        },
      ]);
      expect(result.nextCursor).toBe("CURSOR_NEXT");
      expect(result.hasMore).toBe(true);

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      expect(headers["x-csrf-token"]).toBe("csrf123");
      expect(headers.Cookie).toContain("ct0=csrf123");
    });

    test("stops (hasMore false) when a page has no tweets", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        res(timeline([], "CURSOR_END")),
      );
      const result = await xProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "CURSOR_PREV",
        sinceTimestamp: null,
        limit: 100,
      });
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("throws with .status on a non-OK response", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 429));
      await expect(
        xProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 429 });
    });

    test("throws 401 for invalid cookies", async () => {
      await expect(
        xProvider.fetchSavedItems({
          authCookies: "not json",
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});

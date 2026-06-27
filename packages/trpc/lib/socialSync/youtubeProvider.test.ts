import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { youtubeProvider } from "./youtubeProvider";

const VALID_COOKIES = JSON.stringify({
  SID: "sid",
  HSID: "hsid",
  SSID: "ssid",
  SAPISID: "sapisid-value",
  APISID: "apisid",
});

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function video(id: string, title: string) {
  return {
    playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] } },
  };
}

function firstPage(videos: unknown[], continuation: string | null = null) {
  const contents: unknown[] = [...videos];
  if (continuation) {
    contents.push({
      continuationItemRenderer: {
        continuationEndpoint: { continuationCommand: { token: continuation } },
      },
    });
  }
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      itemSectionRenderer: {
                        contents: [{ playlistVideoListRenderer: { contents } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

describe("youtubeProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe("validateAuth", () => {
    test("false when SAPISID missing", async () => {
      expect(
        await youtubeProvider.validateAuth(
          JSON.stringify({ SID: "s", HSID: "h", SSID: "s", APISID: "a" }),
        ),
      ).toBe(false);
    });

    test("true when the browse probe returns 200", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res(firstPage([])));
      expect(await youtubeProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("false on 401", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 401));
      expect(await youtubeProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });
  });

  describe("fetchSavedItems", () => {
    test("maps Watch Later videos, the continuation cursor, and sends a SAPISIDHASH auth header", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(
          res(
            firstPage(
              [video("vid1", "First video"), video("vid2", "Second video")],
              "CONT_TOKEN",
            ),
          ),
        );

      const result = await youtubeProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });

      expect(result.items).toEqual([
        {
          platformItemId: "vid1",
          url: "https://www.youtube.com/watch?v=vid1",
          title: "First video",
          tags: ["youtube"],
        },
        {
          platformItemId: "vid2",
          url: "https://www.youtube.com/watch?v=vid2",
          title: "Second video",
          tags: ["youtube"],
        },
      ]);
      expect(result.nextCursor).toBe("CONT_TOKEN");
      expect(result.hasMore).toBe(true);

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/);
      expect(headers.Cookie).toContain("SAPISID=sapisid-value");
    });

    test("no continuation → hasMore false", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        res(firstPage([video("only", "Only video")], null)),
      );
      const result = await youtubeProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });
      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("throws with .status on a non-OK response", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      await expect(
        youtubeProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    test("throws 401 for invalid cookies", async () => {
      await expect(
        youtubeProvider.fetchSavedItems({
          authCookies: "not json",
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});

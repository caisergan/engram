import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { redditProvider } from "./redditProvider";

const VALID_COOKIES = JSON.stringify({
  reddit_session: "sess-abc",
  token_v2: "tok-xyz",
});

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const ME = { kind: "t2", data: { name: "alice" } };

function listing(children: unknown[], after: string | null = null) {
  return { kind: "Listing", data: { after, children } };
}

function t3(over: Record<string, unknown> = {}) {
  return {
    kind: "t3",
    data: {
      name: "t3_post1",
      permalink: "/r/programming/comments/post1/title/",
      title: "A great post",
      subreddit: "programming",
      ...over,
    },
  };
}

function t1(over: Record<string, unknown> = {}) {
  return {
    kind: "t1",
    data: {
      name: "t1_cmt1",
      permalink: "/r/aww/comments/post9/title/cmt1/",
      link_title: "Cute dog",
      subreddit: "aww",
      ...over,
    },
  };
}

describe("redditProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe("validateAuth", () => {
    test("returns false for invalid JSON", async () => {
      expect(await redditProvider.validateAuth("not json")).toBe(false);
    });

    test("returns false when reddit_session is missing", async () => {
      expect(
        await redditProvider.validateAuth(JSON.stringify({ token_v2: "t" })),
      ).toBe(false);
    });

    test("returns true when /api/me.json returns a username", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res(ME));
      expect(await redditProvider.validateAuth(VALID_COOKIES)).toBe(true);
    });

    test("returns false on a 403", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      expect(await redditProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });

    test("returns false on a network error", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("net"));
      expect(await redditProvider.validateAuth(VALID_COOKIES)).toBe(false);
    });
  });

  describe("fetchSavedItems", () => {
    test("resolves username, maps posts and comments, encodes the cursor", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(ME)) // /api/me.json
        .mockResolvedValueOnce(res(listing([t3(), t1()], "t1_cmt1")));

      const result = await redditProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: null,
        sinceTimestamp: null,
        limit: 100,
      });

      expect(result.items).toEqual([
        {
          platformItemId: "t3_post1",
          url: "https://www.reddit.com/r/programming/comments/post1/title/",
          title: "A great post",
          tags: ["programming"],
        },
        {
          platformItemId: "t1_cmt1",
          url: "https://www.reddit.com/r/aww/comments/post9/title/cmt1/",
          title: "Cute dog",
          tags: ["aww"],
        },
      ]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("alice t1_cmt1");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const savedUrl = fetchMock.mock.calls[1]![0] as string;
      expect(savedUrl).toContain("/user/alice/saved.json");
      expect(savedUrl).toContain("limit=100");
    });

    test("on later pages uses the cursor's username+after and skips /api/me.json", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(listing([t3()], null)));

      const result = await redditProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "alice t3_post0",
        sinceTimestamp: null,
        limit: 100,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("/user/alice/saved.json");
      expect(url).toContain("after=t3_post0");
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test("sends the full cookie blob as a Cookie header", async () => {
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(listing([], null)));

      await redditProvider.fetchSavedItems({
        authCookies: VALID_COOKIES,
        cursor: "alice ",
        sinceTimestamp: null,
        limit: 100,
      });

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Cookie).toContain("reddit_session=sess-abc");
      expect(headers.Cookie).toContain("token_v2=tok-xyz");
    });

    test("throws with .status when Reddit blocks the saved listing", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(res({}, 403));
      await expect(
        redditProvider.fetchSavedItems({
          authCookies: VALID_COOKIES,
          cursor: "alice t3_x",
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    test("throws 401 for invalid cookies", async () => {
      await expect(
        redditProvider.fetchSavedItems({
          authCookies: "not json",
          cursor: null,
          sinceTimestamp: null,
          limit: 100,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});

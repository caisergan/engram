import { describe, expect, test } from "vitest";

import type {
  SocialSyncProvider,
  SyncItem,
} from "@karakeep/shared/types/socialSync";

import { planSync } from "./syncEngine";

interface Page {
  items: SyncItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A provider that serves a scripted list of pages in order and records the
 * cursor passed on each call, so tests can assert what was fetched (and that
 * we did not over-fetch).
 */
function scriptedProvider(pages: Page[]) {
  const cursors: (string | null)[] = [];
  let i = 0;
  const provider: SocialSyncProvider = {
    platform: "instagram",
    validateAuth: () => Promise.resolve(true),
    fetchSavedItems: (config) => {
      cursors.push(config.cursor);
      const page = pages[i] ?? { items: [], nextCursor: null, hasMore: false };
      i++;
      return Promise.resolve(page);
    },
  };
  return { provider, cursors };
}

function item(id: string): SyncItem {
  return {
    platformItemId: id,
    url: `https://www.instagram.com/p/${id}/`,
    title: `@${id}`,
    tags: ["instagram"],
  };
}

function page(items: SyncItem[], nextCursor: string | null): Page {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

function seenChecker(ids: string[]) {
  const set = new Set(ids);
  return (id: string) => Promise.resolve(set.has(id));
}

const ids = (items: SyncItem[]) => items.map((i) => i.platformItemId);

describe("planSync", () => {
  describe("steady state (backfill complete)", () => {
    test("starts from the top and stops at the first fully-seen page", async () => {
      // The bug: previously a run resumed from a deep persisted cursor and never
      // re-checked the top, so newly-saved posts (which appear at the top) were
      // missed. A steady-state run must anchor at the top.
      const { provider, cursors } = scriptedProvider([
        page([item("newA"), item("old1"), item("old2")], "c1"),
        page([item("old3"), item("old4")], "c2"), // entirely already-seen
        page([item("old5")], "c3"), // must NOT be fetched
      ]);

      const result = await planSync({
        provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: true,
        resumeCursor: null,
        isSeen: seenChecker(["old1", "old2", "old3", "old4", "old5"]),
      });

      expect(ids(result.newItems)).toEqual(["newA"]);
      // First fetch must be from the top (cursor null), and we stop after the
      // first all-seen page instead of walking the whole history.
      expect(cursors).toEqual([null, "c1"]);
      expect(result.resumeCursor).toBeNull();
      expect(result.backfillComplete).toBe(true);
    });

    test("collects new items across multiple pages until a seen page", async () => {
      const { provider } = scriptedProvider([
        page([item("n1"), item("n2")], "c1"),
        page([item("n3"), item("old1")], "c2"),
        page([item("old2"), item("old3")], "c3"), // all seen -> stop
        page([item("n4")], "c4"), // must NOT be reached
      ]);

      const result = await planSync({
        provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: true,
        resumeCursor: null,
        isSeen: seenChecker(["old1", "old2", "old3"]),
      });

      expect(ids(result.newItems)).toEqual(["n1", "n2", "n3"]);
      expect(result.resumeCursor).toBeNull();
      expect(result.backfillComplete).toBe(true);
    });

    test("stops at the bottom of history and resets to the top", async () => {
      const { provider, cursors } = scriptedProvider([
        page([item("n1")], null), // hasMore false
      ]);

      const result = await planSync({
        provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: true,
        resumeCursor: null,
        isSeen: seenChecker([]),
      });

      expect(ids(result.newItems)).toEqual(["n1"]);
      expect(cursors).toEqual([null]);
      expect(result.resumeCursor).toBeNull();
      expect(result.backfillComplete).toBe(true);
    });

    test("stops at maxItems with a resume cursor when catch-up exceeds the cap", async () => {
      const { provider } = scriptedProvider([
        page([item("n1"), item("n2")], "c1"),
        page([item("n3"), item("n4")], "c2"),
        page([item("n5"), item("n6")], "c3"),
      ]);

      const result = await planSync({
        provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: true,
        resumeCursor: null,
        isSeen: seenChecker([]),
        maxItems: 3,
      });

      // Hit the cap before any all-seen page: persist a deep resume cursor and
      // stay complete. New top-of-feed saves are delayed (documented trade-off),
      // not lost.
      expect(result.newItems.length).toBeGreaterThanOrEqual(3);
      expect(result.backfillComplete).toBe(true);
      expect(result.resumeCursor).not.toBeNull();
    });

    test("a capped run resumes deep next run, then resets to top once caught up", async () => {
      const run1 = scriptedProvider([page([item("n1"), item("n2")], "c1")]);
      const r1 = await planSync({
        provider: run1.provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: true,
        resumeCursor: null,
        isSeen: seenChecker([]),
        maxItems: 2,
      });
      expect(r1.resumeCursor).toBe("c1");

      const run2 = scriptedProvider([
        page([item("n3")], "c2"),
        page([item("seen1")], "c3"), // all-seen -> caught up, reset to top
      ]);
      const r2 = await planSync({
        provider: run2.provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: true,
        resumeCursor: r1.resumeCursor,
        isSeen: seenChecker(["seen1"]),
      });

      expect(run2.cursors[0]).toBe("c1"); // resumed deep, NOT from the top
      expect(ids(r2.newItems)).toEqual(["n3"]);
      expect(r2.resumeCursor).toBeNull(); // caught up -> next run starts at top
    });
  });

  describe("initial backfill (backfill incomplete)", () => {
    test("walks history from the top and resumes via cursor across runs", async () => {
      // Run 1: small per-run budget forces a stop with a resume cursor.
      const run1 = scriptedProvider([
        page([item("h1"), item("h2")], "c1"),
        page([item("h3"), item("h4")], "c2"),
      ]);

      const r1 = await planSync({
        provider: run1.provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: false,
        resumeCursor: null,
        isSeen: seenChecker([]),
        maxItems: 4,
      });

      expect(ids(r1.newItems)).toEqual(["h1", "h2", "h3", "h4"]);
      expect(r1.resumeCursor).toBe("c2");
      expect(r1.backfillComplete).toBe(false);

      // Run 2: resumes from the stored cursor and reaches the bottom.
      const run2 = scriptedProvider([
        page([item("h5"), item("h6")], null), // hasMore false -> bottom
      ]);

      const r2 = await planSync({
        provider: run2.provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: r1.backfillComplete,
        resumeCursor: r1.resumeCursor,
        isSeen: seenChecker([]),
        maxItems: 4,
      });

      expect(run2.cursors[0]).toBe("c2"); // resumed from where run 1 stopped
      expect(ids(r2.newItems)).toEqual(["h5", "h6"]);
      expect(r2.resumeCursor).toBeNull();
      expect(r2.backfillComplete).toBe(true);
    });

    test("does not stop on a zero-new page before reaching the bottom", async () => {
      // During backfill we must keep paging past an all-seen page (e.g. a
      // duplicate in the feed) until we actually hit the bottom.
      const { provider } = scriptedProvider([
        page([item("dup")], "c1"), // already seen -> zero new, but keep going
        page([item("h2")], null), // bottom
      ]);

      const result = await planSync({
        provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: false,
        resumeCursor: null,
        isSeen: seenChecker(["dup"]),
      });

      expect(ids(result.newItems)).toEqual(["h2"]);
      expect(result.backfillComplete).toBe(true);
      expect(result.resumeCursor).toBeNull();
    });

    test("respects maxItems and returns a resume cursor without completing", async () => {
      const { provider } = scriptedProvider([
        page([item("h1"), item("h2")], "c1"),
        page([item("h3"), item("h4")], "c2"),
        page([item("h5")], "c3"),
      ]);

      const result = await planSync({
        provider,
        authCookies: "{}",
        sinceTimestamp: null,
        backfillComplete: false,
        resumeCursor: null,
        isSeen: seenChecker([]),
        maxItems: 3,
      });

      // Stops after the page that pushed us to/over the cap.
      expect(result.newItems.length).toBeGreaterThanOrEqual(3);
      expect(result.backfillComplete).toBe(false);
      expect(result.resumeCursor).not.toBeNull();
    });
  });

  test("dedupes the same item appearing on multiple pages within a run", async () => {
    const { provider } = scriptedProvider([
      page([item("a"), item("b")], "c1"),
      page([item("b"), item("c")], null), // "b" repeats
    ]);

    const result = await planSync({
      provider,
      authCookies: "{}",
      sinceTimestamp: null,
      backfillComplete: false,
      resumeCursor: null,
      isSeen: seenChecker([]),
    });

    expect(ids(result.newItems)).toEqual(["a", "b", "c"]);
  });
});

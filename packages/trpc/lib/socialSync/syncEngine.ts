import type {
  SocialSyncProvider,
  SyncItem,
} from "@karakeep/shared/types/socialSync";

/**
 * Pure paging/decision logic for a single social-sync run, extracted from the
 * worker so it can be unit-tested without a database.
 *
 * The saved feed of every supported platform is ordered newest-saved-first and
 * paginates *backwards* into history via an opaque cursor. That creates two
 * distinct jobs:
 *
 *   - Initial backfill: import the user's pre-existing saves. We resume a
 *     downward walk from a stored cursor across runs until we reach the bottom
 *     of history, then mark the connection backfill-complete.
 *
 *   - Steady state: catch newly-saved posts. New saves appear at the *top* of
 *     the feed, so every steady-state run must re-anchor at the top and stop as
 *     soon as it reaches the region we already synced (a page with nothing new).
 *     Resuming from a deep cursor here is the bug this engine fixes — it would
 *     keep walking history and never revisit the top where new saves land.
 *
 * `maxItems` bounds the work per run; if we hit it before reaching the bottom
 * (backfill) or the already-synced region (steady state), we return a resume
 * cursor so the next run continues where this one left off.
 *
 * Trade-off when a steady-state run hits `maxItems` mid-walk (i.e. the user
 * saved more than one run's worth of items since the last sync): we persist the
 * deep resume cursor and the *next* run continues that downward walk rather than
 * re-anchoring at the top. Nothing is lost — every item is imported within a few
 * runs — but brand-new saves made during that catch-up window are delayed until
 * the walk drains. We accept this because the alternative (always restart at the
 * top and stop at the first all-seen page) would silently *skip* the older
 * not-yet-imported items below the top, which is strictly worse.
 */
export interface PlanSyncInput {
  provider: SocialSyncProvider;
  authCookies: string;
  // Advisory only. Passed through to the provider (used by time-bounded feeds
  // like X/YouTube). Providers MUST NOT use it to filter out the top of the
  // saved feed — steady-state correctness relies on `isSeen` + the all-seen-page
  // stop, not on this timestamp. The Instagram saved feed has no usable per-item
  // save timestamp, so its provider ignores this.
  sinceTimestamp: Date | null;
  /** Whether the initial historical backfill has already completed. */
  backfillComplete: boolean;
  /** Cursor to resume paging from. `null` means start from the top. */
  resumeCursor: string | null;
  /** Returns true if an item was already imported on a previous run. */
  isSeen: (platformItemId: string) => Promise<boolean>;
  pageSize?: number;
  maxItems?: number;
  maxPages?: number;
}

export interface PlanSyncResult {
  /** New, de-duplicated items to import, in fetch order. */
  newItems: SyncItem[];
  /** Cursor to persist for the next run. `null` means start from the top. */
  resumeCursor: string | null;
  /** Updated backfill-complete flag. */
  backfillComplete: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_PAGES = 20;

export async function planSync(input: PlanSyncInput): Promise<PlanSyncResult> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;

  let backfillComplete = input.backfillComplete;
  // A normal run resets this to null, so in steady state we start from the top;
  // a non-null value means a previous run hit its cap mid-walk and we resume.
  let cursor = input.resumeCursor;

  const newItems: SyncItem[] = [];
  const collected = new Set<string>();
  let pages = 0;

  while (pages < maxPages && newItems.length < maxItems) {
    const result = await input.provider.fetchSavedItems({
      authCookies: input.authCookies,
      cursor,
      sinceTimestamp: input.sinceTimestamp,
      limit: pageSize,
    });
    pages++;

    let newInPage = 0;
    for (const item of result.items) {
      if (collected.has(item.platformItemId)) continue;
      if (await input.isSeen(item.platformItemId)) continue;
      collected.add(item.platformItemId);
      newItems.push(item);
      newInPage++;
    }

    // Reached the bottom of history: backfill is done and the next run starts
    // again from the top to pick up future saves.
    if (!result.hasMore || !result.nextCursor) {
      backfillComplete = true;
      cursor = null;
      break;
    }

    cursor = result.nextCursor;

    // Steady state only: a page with nothing new means we've reached the region
    // we already synced. Stop and let the next run re-anchor at the top. During
    // initial backfill we deliberately page past zero-new pages until the bottom.
    if (backfillComplete && newInPage === 0) {
      cursor = null;
      break;
    }
  }

  return { newItems, resumeCursor: cursor, backfillComplete };
}

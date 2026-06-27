# Design: X (Bookmarks) + YouTube (Watch Later) social-sync providers

_Date: 2026-06-27 · Repo: `github.com/caisergan/engram`_

## Goal

Replace the two existing no-op stubs (`xProvider`, `youtubeProvider`) with real cookie-based providers
so the hourly social-sync cron imports the user's **X Bookmarks** and **YouTube Watch Later** as
bookmarks. Both follow the Instagram/Reddit template and the cookie-now / OAuth-ready pattern.

## Established decisions

- **X scope:** Bookmarks (X's only "saved" analog).
- **YouTube scope:** Watch Later (the closest analog to "Save"; cookie-only — not in any official API).
- **YouTube cookies expand:** add `SAPISID` + `APISID` to `PLATFORM_REQUIRED_COOKIES.youtube` (needed for
  the `SAPISIDHASH` auth header).
- **X crawler skip:** add `isXUrl` + a crawler skip (X gates tweet viewing behind login, like Instagram).
- **Fragility accepted:** X's GraphQL query-id/feature-flags and YouTube's InnerTube clientVersion/parse
  paths are undocumented and change; they're isolated as clearly-marked constants.

No enum/schema/migration change — `x` and `youtube` already exist in the platform enum (they're stubs).

## Feasibility & fragility caveat (must stay visible)

These two are materially more fragile than Reddit/Instagram, and unverifiable from here:
- **X** is the most fragile in the project. The internal GraphQL `Bookmarks` query-id and `features`
  flags rotate every few weeks; a stale value yields `404`/`400`. The provider hardcodes best-effort
  values with a comment on refreshing them from DevTools. Expect periodic maintenance; OAuth is not a
  cheap fallback (X bookmarks aren't in any free API tier).
- **YouTube** needs a computed `SAPISIDHASH` and deep InnerTube renderer parsing; the `clientVersion`
  and renderer paths can drift.
- Both share the **datacenter-IP** risk (the worker runs on the Google VM).
- Unit tests prove the **parse + auth-header logic** against fixtures inferred from research (not
  live-verified, unlike Reddit's documented Listing). Real feasibility is only provable by connecting
  on a live instance (manual step).

## Shared architecture

Each provider keeps a small `Transport` (`{ baseUrl/url, headers }`) seam so an OAuth transport can
replace the cookie one later with no change to parsing. The worker/engine/scheduler are generic; the
only shared edits are the YouTube cookie list, `isXUrl` + the X crawler skip, and the provider files.

---

## X provider (`packages/trpc/lib/socialSync/xProvider.ts`)

- **Required cookies:** `auth_token`, `ct0` (unchanged).
- **Auth headers:**
  - `Authorization: Bearer <PUBLIC_WEB_BEARER>` — the well-known public web bearer constant.
  - `x-csrf-token: <ct0>`, `x-twitter-auth-type: OAuth2Session`, `x-twitter-active-user: yes`,
    `x-twitter-client-language: en`.
  - `Cookie: auth_token=…; ct0=…`, browser `User-Agent`, `Content-Type: application/json`.
- **Endpoint (fragile):** `GET https://x.com/i/api/graphql/<BOOKMARKS_QUERY_ID>/Bookmarks`
  with `?variables=<json>&features=<json>`.
  - `variables`: `{ count: min(limit,100), cursor?: <cursor>, includePromotedContent: false }`.
  - `features`: a JSON flag blob (hardcoded best-effort, marked for refresh).
- **Parse:** `data.bookmark_timeline_v2.timeline.instructions` → the `TimelineAddEntries` instruction →
  `entries[]`. For each entry whose `entryId` starts `tweet-`: `content.itemContent.tweet_results.result`
  (unwrap `TweetWithVisibilityResults.tweet` when present) → `rest_id`, `legacy.full_text`,
  `core.user_results.result.legacy.screen_name`, first media `media_url_https` from
  `legacy.extended_entities.media` / `legacy.entities.media`. Next cursor: the entry whose `entryId`
  starts `cursor-bottom-` → `content.value`; `hasMore` = that cursor exists and the page had tweets.
- **SyncItem:** `platformItemId = rest_id`, `url = https://x.com/<screen_name>/status/<rest_id>`,
  `title = @<screen_name>`, `description = full_text`, `imageUrl = <first media url>`, `tags = ["x"]`.
- **validateAuth:** issue the Bookmarks query with `count=1`; `true` iff `200` and a parseable timeline.
- **Crawl:** X requires login to view tweets, so the provider populates `description`/`imageUrl` and we
  add a crawler skip via `isXUrl` (mirrors Instagram).
- **Errors:** non-OK → throw with `.status`; `401/403` disables the connection (message notes cookies or
  rate-limit/IP).

---

## YouTube provider (`packages/trpc/lib/socialSync/youtubeProvider.ts`)

- **Required cookies:** `["SID", "HSID", "SSID", "SAPISID", "APISID"]` (expanded; `SAPISID` feeds the hash).
- **Auth:** `Authorization: SAPISIDHASH <ts>_<sha1(`${ts} ${SAPISID} https://www.youtube.com`)>` where
  `ts = floor(Date.now()/1000)`; plus `Cookie` (full blob), `x-origin: https://www.youtube.com`,
  `x-goog-authuser: 0`, `Content-Type: application/json`, browser `User-Agent`.
- **Endpoint:** `POST https://www.youtube.com/youtubei/v1/browse?key=<INNERTUBE_API_KEY>&prettyPrint=false`.
  - First page body: `{ context: { client: { clientName: "WEB", clientVersion: <CV>, hl: "en", gl: "US" } }, browseId: "VLWL" }`.
  - Continuation body: `{ context: {…}, continuation: <token> }`.
  - `INNERTUBE_API_KEY` + `clientVersion` are public constants, marked fragile.
- **Parse:** first page —
  `contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content.sectionListRenderer.contents[].itemSectionRenderer.contents[].playlistVideoListRenderer.contents[]`;
  continuation page — `onResponseReceivedActions[].appendContinuationItemsAction.continuationItems[]`.
  Each `playlistVideoRenderer` → `videoId`, `title.runs[0].text`. Next cursor: the
  `continuationItemRenderer.continuationEndpoint.continuationCommand.token` among the items (or null).
- **SyncItem:** `platformItemId = videoId`, `url = https://www.youtube.com/watch?v=<videoId>`,
  `title = <title>`, `tags = ["youtube"]` (no description/imageUrl — watch pages are publicly crawlable).
- **validateAuth:** issue the first-page browse; `true` iff `200` and a parseable structure.
- **Crawl:** publicly crawlable → **no skip** (like Reddit); the crawler enriches.
- **Errors:** non-OK → throw with `.status`.

---

## Shared-types & crawler changes

- `packages/shared/types/socialSync.ts`:
  - `PLATFORM_REQUIRED_COOKIES.youtube = ["SID", "HSID", "SSID", "SAPISID", "APISID"]`.
  - add `isXUrl(url)` (matches `x.com` / `twitter.com`), mirroring `isInstagramUrl`.
- `packages/shared/types/socialSync.test.ts`: update the youtube assertion; add `isXUrl` tests.
- `apps/workers/workers/crawlerWorker.ts`: extend the existing `source === "sync"` skip to also skip
  `isXUrl(url)` (same handling Instagram gets).

## Out of scope

- OAuth transports (seams only), browser-extension auto-read for these platforms, X media beyond the
  first image, YouTube lists other than Watch Later, the pre-existing `socialSyncHistory` index drift.

## Testing

- **Unit (TDD, mocked `fetch` + realistic fixtures)** — new `xProvider.test.ts` and
  `youtubeProvider.test.ts` mirroring `instagramProvider.test.ts`: item mapping, URL building, cursor +
  `hasMore`, the auth headers/SAPISIDHASH being sent, `validateAuth` ok/401/403, error `.status`.
- **Shared-types** — `PLATFORM_REQUIRED_COOKIES.youtube` + `isXUrl`.
- **Existing** — sync engine, router, instagram, reddit tests keep passing.
- **Manual (user-run)** — connect X / YouTube with cookies on a live instance and sync; this is where
  the fragile constants / IP block are proven or disproven.

## File summary

| Action | File |
|---|---|
| Modify | `packages/shared/types/socialSync.ts` — youtube cookies + `isXUrl` |
| Modify | `packages/shared/types/socialSync.test.ts` — youtube + `isXUrl` assertions |
| Replace | `packages/trpc/lib/socialSync/xProvider.ts` — real X Bookmarks provider |
| Create | `packages/trpc/lib/socialSync/xProvider.test.ts` |
| Replace | `packages/trpc/lib/socialSync/youtubeProvider.ts` — real YouTube Watch Later provider |
| Create | `packages/trpc/lib/socialSync/youtubeProvider.test.ts` |
| Modify | `apps/workers/workers/crawlerWorker.ts` — add `isXUrl` to the sync crawl-skip |

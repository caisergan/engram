# Social Sync Feature — Design Spec

## Overview

A built-in sync engine that periodically fetches saved/bookmarked content from Instagram, X (Twitter), and YouTube using cookie-based API calls, then creates bookmarks in Engram with auto-tagging. Follows a provider-adapter pattern so scraping logic per platform is isolated and replaceable without touching the sync framework.

**Primary goal:** Consolidate all saved content across social platforms into Engram automatically.

## Requirements

- Ongoing live sync (not one-time import) for Instagram saved posts, X bookmarks, and YouTube liked videos
- Cookie/session-based authentication (no OAuth, no paid API tiers)
- Per-user, per-platform connections with independent scheduling
- Deduplication — never import the same item twice
- Incremental sync via cursor/pagination — only fetch new items
- Auto-tag imported bookmarks by platform name (configurable)
- Graceful handling of expired cookies with user notification
- Provider interface is a thin contract — scraping implementations are expected to change

## Architecture

### Provider-Adapter Pattern

A shared sync engine handles scheduling, dedup, bookmark creation, and state management. Platform-specific logic lives in provider adapters that implement a common interface. Adding a new platform (e.g. Reddit, TikTok) means writing one adapter file.

```
SocialSyncRefreshingWorker (cron, every minute)
  └─ checks which connections are due for sync
  └─ enqueues jobs to SocialSyncQueue

SocialSyncWorker (queue consumer)
  └─ loads connection config
  └─ decrypts authCookies
  └─ calls provider.fetchSavedItems() with stored cursor
  └─ deduplicates against socialSyncHistory
  └─ creates bookmarks (source: "sync", auto-tags)
  └─ updates connection state (cursor, lastSyncedAt, status)
```

### SocialSyncProvider Interface

```typescript
interface SocialSyncProvider {
  platform: "instagram" | "x" | "youtube";

  fetchSavedItems(config: {
    authCookies: string;
    cursor: string | null;
    limit: number;
  }): Promise<{
    items: SyncItem[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;

  validateAuth(authCookies: string): Promise<boolean>;
}

interface SyncItem {
  platformItemId: string;
  url: string;
  title?: string;
  tags?: string[];
}
```

The interface is intentionally minimal. Providers own their scraping approach entirely — the engine only cares about the return type. When scraping logic needs to change (new endpoints, browser automation, official APIs), only the provider file changes.

## Schema & Data Model

### socialSyncConnections

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | text (CUID) | auto | Primary key |
| `userId` | text | — | FK to users, onDelete cascade |
| `platform` | text enum: `"instagram"`, `"x"`, `"youtube"` | — | Platform identifier |
| `enabled` | boolean | true | Whether auto-sync is active |
| `authCookies` | text | — | Encrypted cookie blob (AES-256-GCM, IV prepended — same format as vault crypto `encryptText`) |
| `lastSyncedAt` | timestamp | null | Last successful sync time |
| `lastSyncStatus` | text enum: `"pending"`, `"success"`, `"failure"` | `"pending"` | Status of last run |
| `lastSyncError` | text | null | Error message if failed |
| `syncIntervalMinutes` | integer | 60 | Sync frequency (allowed: 15, 30, 60, 360, 720, 1440) |
| `autoTagName` | text | platform name | Tag applied to all synced bookmarks |
| `lastCursor` | text | null | Platform-specific pagination cursor for incremental sync |
| `totalSynced` | integer | 0 | Running count of total bookmarks synced via this connection |
| `createdAt` | timestamp | now | |
| `modifiedAt` | timestamp | now | Auto-updated on changes |

Unique constraint on `(userId, platform)` — one connection per platform per user.

### socialSyncHistory

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | text (CUID) | auto | Primary key |
| `connectionId` | text | — | FK to socialSyncConnections, onDelete cascade |
| `platformItemId` | text | — | Platform-specific unique ID (tweet ID, shortcode, video ID) |
| `bookmarkId` | text | — | FK to bookmarks, onDelete cascade |
| `syncedAt` | timestamp | now | |

Index on `(connectionId, platformItemId)` for fast dedup lookups.

### Cookie Encryption

Cookies are encrypted using the same `encryptText` / `decryptText` functions from `packages/trpc/lib/vaultCrypto.ts`. The encryption key is derived from `NEXTAUTH_SECRET` using PBKDF2 with a fixed application-level salt (`"engram-social-sync-cookie-encryption"`). This is computed once at startup and cached in memory.

This differs from the vault (where the key comes from a user PIN) — here the key is server-scoped since cookies need to be decrypted by background workers without user interaction.

### Bookmark source enum

Add `"sync"` to the existing source enum on the bookmarks table:
```
"api" | "web" | "extension" | "cli" | "mobile" | "singlefile" | "rss" | "import" | "sync"
```

## Platform Providers

Each provider is a single file (~100-150 lines) implementing `SocialSyncProvider`. The scraping logic described below is the initial implementation — it is expected to change as platform APIs evolve. All three providers use cookie-based internal API calls (no official API keys required).

### Instagram (`instagramProvider.ts`)

- **Auth cookies:** `sessionid`, `csrftoken`, `ds_user_id`
- **Endpoint:** `GET https://www.instagram.com/api/v1/feed/saved/posts/` (internal API)
- **Item ID:** media shortcode
- **URL format:** `https://www.instagram.com/p/{shortcode}/`
- **Auto-tags:** `["instagram"]` + hashtags extracted from caption
- **Cursor:** `next_max_id` from response pagination

### X / Twitter (`xProvider.ts`)

- **Auth cookies:** `auth_token`, `ct0`
- **Endpoint:** `GET https://x.com/i/api/graphql/.../Bookmarks` (internal GraphQL API)
- **Item ID:** tweet ID
- **URL format:** `https://x.com/{username}/status/{tweetId}`
- **Auto-tags:** `["x"]` + hashtags from tweet text
- **Cursor:** GraphQL pagination cursor from response

### YouTube (`youtubeProvider.ts`)

- **Auth cookies:** `SID`, `HSID`, `SSID`, `LOGIN_INFO`
- **Endpoint:** `https://www.youtube.com/youtubei/v1/browse` (internal InnerTube API, cookie-authenticated)
- **Item ID:** video ID
- **URL format:** `https://www.youtube.com/watch?v={videoId}`
- **Auto-tags:** `["youtube"]`
- **Cursor:** continuation token from InnerTube response
- **Target:** Liked Videos playlist (playlist ID `LL`)

## Worker Integration

### SocialSyncRefreshingWorker (cron)

Runs every minute. Queries `socialSyncConnections` for rows where:
- `enabled = true`
- `lastSyncedAt IS NULL` OR `lastSyncedAt + syncIntervalMinutes < now()`

Enqueues one job per due connection to `SocialSyncQueue` with idempotency key `sync:{connectionId}:{intervalSlot}` where `intervalSlot = floor(now / syncIntervalMinutes)` — this prevents duplicate runs within the same scheduling window regardless of interval length.

### SocialSyncWorker (queue consumer)

- **Queue:** `SocialSyncQueue`
- **Concurrency:** 1 (sequential per connection to respect rate limits)
- **Timeout:** 60s per job
- **Retries:** 2 with backoff

**Per-sync run:**
1. Load connection from DB, decrypt `authCookies`
2. Call `provider.fetchSavedItems({ authCookies, cursor, limit: 100 })`
3. For each item, check `socialSyncHistory` for existing `(connectionId, platformItemId)`
4. For new items: create bookmark via `bookmarks.createBookmark({ type: "link", url, source: "sync" })`, attach auto-tag + any hashtags
5. Insert into `socialSyncHistory`, increment `totalSynced`
6. Update connection: `lastSyncedAt`, `lastCursor`, `lastSyncStatus: "success"`
7. Cap at 100 items per run. If `hasMore`, save cursor — remainder picked up next run.

### First sync / backfill behavior

When a user first connects a platform, they may have hundreds or thousands of saved items. The sync handles this naturally:
- First run fetches the newest 100 items (most platforms return newest-first)
- Cursor is saved after each batch
- Subsequent scheduled runs continue from the cursor, fetching the next 100
- This backfills gradually without blocking the worker or hitting rate limits
- The UI shows "Syncing..." with the `totalSynced` counter incrementing over time

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Cookies expired (401/403) | Set `lastSyncStatus: "failure"`, `lastSyncError: "Authentication expired — update your cookies"`. Set `enabled: false`. |
| Rate limited (429) | Retry with backoff. If exhausted, mark failure, try next scheduled run. |
| Network error | Retry (up to 2). Mark failure if exhausted. |
| Platform API changed (parse error) | Mark failure with descriptive error. Log for debugging. |
| Duplicate item | Skip silently (dedup via `socialSyncHistory`). |
| Bookmark quota exceeded | Skip remaining items, mark status with quota warning. |

## tRPC API

### New router: `socialSync.ts`

| Procedure | Type | Auth | Description |
|-----------|------|------|-------------|
| `socialSync.getConnections` | query | authed | List all connections for current user (excludes `authCookies` from response) |
| `socialSync.connect` | mutation | session | Create connection: validate cookies via provider, encrypt and store, trigger first sync |
| `socialSync.updateCookies` | mutation | session | Update cookies for existing connection, re-validate, re-enable if previously disabled |
| `socialSync.disconnect` | mutation | session | Delete connection + sync history (keeps bookmarks) |
| `socialSync.setEnabled` | mutation | session | Enable/disable auto-sync |
| `socialSync.updateSettings` | mutation | session | Update interval, auto-tag name |
| `socialSync.syncNow` | mutation | session | Trigger immediate sync (rate limited: 1 per connection per 5 minutes) |
| `socialSync.getSyncStats` | query | authed | Return `totalSynced`, `lastSyncedAt`, `lastSyncStatus` for a connection |

## UI Design

### Settings page — Social Sync section (`/settings/sync` or section in `/settings/info`)

**Layout:** Card per platform (Instagram, X, YouTube), each showing:

- Platform logo + name
- Connection status badge: "Connected" (green), "Not connected" (gray), "Auth expired" (red)
- Total synced count (e.g. "423 bookmarks synced")
- Last synced: relative time (e.g. "2 minutes ago")
- Enable/disable toggle
- Sync interval dropdown: 15min, 30min, 1hr, 6hr, 12hr, 24hr
- Auto-tag name input (editable, defaults to platform name)
- Action buttons: "Sync Now", "Update Cookies", "Disconnect"

### Connect dialog

1. User clicks "Connect" on a platform card
2. Dialog with instructions specific to the platform:
   - Option A: "Install a cookie export extension (e.g. 'Cookie-Editor' or 'EditThisCookie'), navigate to [platform], export cookies as JSON, and paste below."
   - Option B (advanced): "Open [platform] in your browser, open DevTools (F12) → Application → Cookies → [domain], and copy the values for: [list of required cookie names]."
3. Textarea for pasting cookies as JSON: `{ "sessionid": "...", "csrftoken": "..." }`
4. Submit → server calls `provider.validateAuth()` → on success, saves encrypted cookies and triggers first sync
5. On validation failure → show error "Could not authenticate with these cookies. Make sure you're logged in and the cookies are current."

### Notifications

- When cookies expire: connection card shows red "Auth expired" badge
- On manual "Sync Now": toast with "Synced X new bookmarks from [platform]"

## Security

- Cookies are encrypted at rest using AES-256-GCM with a key derived from `NEXTAUTH_SECRET` (server-scoped, not user-specific)
- The encryption key is derived once at startup via PBKDF2 with a fixed salt and cached in memory
- Cookies are only decrypted in memory during sync worker execution and `connect`/`updateCookies` validation
- Cookies are never sent back to the client — the `getConnections` response excludes the `authCookies` field
- `disconnect` permanently deletes stored cookies and sync history
- `syncNow` is rate limited (1 per connection per 5 minutes) to prevent abuse

## Out of Scope

- OAuth-based authentication
- Browser extension for automatic cookie capture
- Mobile app sync settings
- Real-time webhooks / push-based sync
- Import from data export files (may be added later as a separate feature)
- Reddit sync (can be added as a new provider later)
- Downloading/archiving media files (images, videos) from posts

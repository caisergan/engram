# Instagram Provider Implementation — Design Spec

## Overview

Fill in the stub `instagramProvider.ts` with real HTTP calls to Instagram's internal web API. This implements `validateAuth()` (live session check) and `fetchSavedItems()` (fetch saved posts with pagination) against the existing `SocialSyncProvider` interface.

## Scope

- Single file change: `packages/trpc/lib/socialSync/instagramProvider.ts`
- New test file: `packages/trpc/lib/socialSync/instagramProvider.test.ts`
- No schema, interface, router, or worker changes — all infrastructure is already in place.

## API Details

### Authentication Headers (all requests)

| Header | Value |
|--------|-------|
| `User-Agent` | Desktop Chrome UA string |
| `X-IG-App-ID` | `936619743392459` |
| `X-CSRFToken` | Value from `csrftoken` cookie |
| `Cookie` | `sessionid={sessionid}; csrftoken={csrftoken}; ds_user_id={ds_user_id}` |

### Required Cookies

`sessionid`, `csrftoken`, `ds_user_id` — provided as JSON in `authCookies`.

### validateAuth

- **Local check:** Parse JSON, verify all three required cookie fields are non-empty strings.
- **Remote check:** `GET https://www.instagram.com/api/v1/accounts/edit/web_form_data/` with auth headers.
- **Return:** `true` if status 200, `false` otherwise.
- **Timeout:** 5 seconds. On timeout or network error, return `false`.

### fetchSavedItems

- **Endpoint:** `GET https://www.instagram.com/api/v1/feed/saved/posts/`
- **Query params:** `count=50`, optionally `max_id={cursor}` for pagination.
- **Response shape (relevant fields):**

```json
{
  "items": [
    {
      "media": {
        "code": "ABC123",
        "user": { "username": "someuser" },
        "caption": { "text": "post caption #hashtag" },
        "media_type": 1,
        "product_type": "feed"
      }
    }
  ],
  "more_available": true,
  "next_max_id": "cursor_string"
}
```

- **Media type mapping:**
  - `product_type === "clips"` → Reel → URL: `https://www.instagram.com/reel/{code}/`
  - Everything else → Post → URL: `https://www.instagram.com/p/{code}/`
- **SyncItem mapping:**
  - `platformItemId`: `media.code`
  - `url`: based on media type (see above)
  - `title`: `@{username}` (or `@unknown` if missing)
  - `tags`: `["instagram"]` + hashtags extracted from caption via regex `/#(\w+)/g`
- **Pagination:** return `{ nextCursor: next_max_id, hasMore: more_available }`
- **Limit:** respect `config.limit` by setting `count=min(limit, 50)` (Instagram caps at 50 per page)

### Error Handling

| Scenario | Behavior |
|----------|----------|
| 401/403 response | Throw error with `.status` property → worker disables connection |
| 429 response | Throw error → worker retries with backoff |
| Network/timeout error | Propagate naturally → worker retry logic handles it |
| Malformed response JSON | Throw descriptive error → worker marks failure |
| Missing `items` array | Return empty items, `hasMore: false` |
| Item missing `media.code` | Skip that item silently |

### Rate Limiting

No in-call pagination loop. The worker fetches one page per run (up to 50 items), saves the cursor, and continues next scheduled run. Rate limiting between runs is handled by the worker's `syncIntervalMinutes`.

## Out of Scope

- Instagram collections filtering (future enhancement)
- Media download/archiving
- Stories or DMs
- OAuth or official Graph API

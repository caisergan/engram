# Social Sync — One-Click Connect via Browser Extension (Instagram + X)

**Status:** Design / awaiting review
**Date:** 2026-05-31
**Related:** [`2026-05-28-social-sync-design.md`](./2026-05-28-social-sync-design.md) (the sync engine this builds on)

## Summary

Replace the manual "copy cookies out of DevTools and paste JSON" connect flow with a
one-click **Connect** button inside the Karakeep browser extension. The extension reads
the platform's session cookies — including `httpOnly` cookies like `sessionid` that page
scripts cannot see — via the `chrome.cookies` API and hands them to the existing
social-sync backend. Covers **Instagram** and **X**. YouTube (which can use real Google
OAuth) is deliberately a separate, later spec.

## Background & constraints

- Social sync authenticates to each platform's private API with **session cookies**, not
  OAuth — there is no official API that exposes Instagram *saved posts*. (See the related
  design doc.)
- Today the only way to supply cookies is manual: DevTools → Application → Cookies → copy
  each value → paste a JSON blob into the web settings dialog. High friction, and because
  sessions expire it must be repeated periodically.
- **Only the extension `cookies` API can read `httpOnly` cookies** (`sessionid`,
  `auth_token`, …). A content script running in the page cannot. This is the core reason
  the capture must live in the extension rather than the web app.
- The extension authenticates to the server with an **API key**. The existing
  `socialSync.connect` / `updateCookies` mutations are `sessionProcedure`, defined as
  `authedProcedure.use(rejectApiKeyAuth())` — they **reject API-key auth**. So the
  extension cannot call them today; only `getConnections` (`authedProcedure`) works for it.

## Decisions (settled during brainstorming)

1. Long-term auth is **hybrid** per platform; **this spec covers extension cookie capture
   for Instagram + X**. YouTube OAuth is a separate spec.
2. The connect UX lives **in the extension** (Options page), not the web app. The web
   settings page keeps owning status / interval / auto-tag / disconnect.
3. Server change: **relax `socialSync.connect` and `updateCookies` from `sessionProcedure`
   to `authedProcedure`** so the API-key-authenticated extension can call them.

## Scope

**In scope**

- A "Social Sync" section in the extension Options page with per-platform Connect /
  Reconnect for Instagram and X.
- Extension permission + cookie-reading utilities.
- A shared single-source-of-truth for each platform's required cookie names.
- The minimal server auth relaxation.

**Out of scope**

- YouTube OAuth (separate spec).
- Web-app-triggered capture (the "messaged from web settings" and "deep-link to popup"
  alternatives) — possible later polish.
- Mobile app. Changes to the cookie providers' fetch logic, the `planSync` worker, or the
  encryption scheme.

## Architecture & components

### 1. Shared — required-cookie names (single source of truth)

Add to `packages/shared/types/socialSync.ts`:

```ts
export const PLATFORM_REQUIRED_COOKIES: Record<SocialPlatform, string[]> = {
  instagram: ["sessionid", "csrftoken", "ds_user_id"],
  x: ["auth_token", "ct0"],
  youtube: ["SID", "HSID", "SSID"],
};
```

Refactor the three providers (`instagramProvider.ts`, `xProvider.ts`, `youtubeProvider.ts`)
to import this instead of each defining a private `REQUIRED_COOKIES`. This guarantees the
extension's capture list and the provider's validation list can never drift apart.

### 2. Server — allow API-key (extension) connect

In `packages/trpc/routers/socialSync.ts`, change **`connect`** and **`updateCookies`** from
`sessionProcedure` to `authedProcedure`. One line each; no change to their bodies —
validation (`provider.validateAuth`), encryption, storage, and first-sync enqueue stay
identical. (`disconnect`, `setEnabled`, `updateSettings`, `syncNow` remain
`sessionProcedure` — the extension does not need them; they're driven from the web UI.)

### 3. Extension — manifest permissions

`apps/browser-extension/manifest.json`:

- Add `"optional_permissions": ["cookies"]`.
- Add **narrow** optional host permissions for the platform domains alongside the existing
  `<all_urls>`: `https://*.instagram.com/*`, `https://*.x.com/*`,
  `https://*.twitter.com/*`.

All requested at connect time from a user gesture — nothing new is granted at install time.

### 4. Extension — permission & cookie utilities

`src/utils/socialSyncPermissions.ts` (mirrors the existing `permissions.ts`):

```ts
export const PLATFORM_ORIGINS: Record<"instagram" | "x", string[]> = {
  instagram: ["https://*.instagram.com/*"],
  x: ["https://*.x.com/*", "https://*.twitter.com/*"],
};
// requestPlatformAccess(platform): chrome.permissions.request({ permissions: ["cookies"], origins })
// hasPlatformAccess(platform), removePlatformAccess(platform)
```

`src/utils/readPlatformCookies.ts`:

```ts
// readPlatformCookies(platform): Promise<string | null>
//  - for each cookie domain, chrome.cookies.getAll({ domain })
//  - collect { name: value } for PLATFORM_REQUIRED_COOKIES[platform]
//  - if any required cookie is missing/empty -> return null (user not logged in)
//  - else return JSON.stringify(map)   // exactly the shape socialSync.connect expects
```

Cookie domains: Instagram `.instagram.com`; X `.x.com` and `.twitter.com`.

### 5. Extension — Social Sync section in `OptionsPage.tsx`

Add a section listing Instagram and X. For each platform:

- Read status from `socialSync.getConnections` (already API-key callable): show
  **Connected / Not connected / Auth expired**, plus `totalSynced` if present.
- A **Connect** (or **Reconnect** if a connection exists) button whose click handler:
  1. `requestPlatformAccess(platform)` — if denied → toast "Permission needed".
  2. `readPlatformCookies(platform)` — if `null` → toast "Open and log into {platform} in
     this browser, then try again".
  3. If **no** existing connection → `socialSync.connect({ platform, cookies })`.
     If a connection **exists** (fresh cookies / expired reconnect) →
     `socialSync.updateCookies({ connectionId, cookies })` (this re-enables a disabled one).
  4. On success → toast + invalidate `getConnections`. On error → toast the server message
     (e.g. validateAuth failure).

## Data flow (connect)

```
user clicks Connect (gesture)
  → requestPlatformAccess()           [chrome.permissions]
  → readPlatformCookies()             [chrome.cookies.getAll — reads httpOnly]
  → socialSync.connect/updateCookies  [tRPC over existing API-key channel]
      → provider.validateAuth()       [server-side fetch to platform]
      → encrypt + store + enqueue first sync
  → extension shows "Connected"
```

## Connect vs. update logic

`getConnections` tells the extension whether a connection already exists for the platform.
None → `connect`. Exists → `updateCookies` (covers re-supplying cookies after expiry, which
clears the error and re-enables the connection). This avoids the `connect` "Already
connected" error path.

## Error handling

| Case | Behavior |
| --- | --- |
| Permission request denied | Toast: "Permission needed to read {platform} cookies" |
| Not logged in / a required cookie missing | Toast: "Open and log into {platform} in this browser, then try again" |
| `validateAuth` fails server-side | Toast: server message ("Could not authenticate with these cookies…") |
| Network / server error | Toast: error message |
| Connection already exists | UI routes to `updateCookies` instead of `connect` |

## Security considerations

- **Relaxing to `authedProcedure`:** an API key can now create/update a social connection
  for *its own user*. An API key already acts fully as that user (creates bookmarks, reads
  data), so this stays within the same trust boundary — it is not cross-user escalation.
  Future hardening (noted as follow-up, not in this spec): gate behind a dedicated
  `socialSync` API-key scope.
- Cookies are read transiently in the extension and sent over the existing authenticated
  HTTPS tRPC channel. **The extension does not persist cookies in its own storage.**
- Cookies remain encrypted at rest on the server (AES-256-GCM, unchanged) and are never
  returned to any client (`getConnections` already excludes them).
- Host permissions are **narrow** (specific platform domains) and **optional** (requested
  on demand), not a broad `<all_urls>` grant.

## Testing

- **Shared:** unit test asserting each provider consumes `PLATFORM_REQUIRED_COOKIES` (and
  that the map has the expected names per platform).
- **Extension utils:** unit-test `readPlatformCookies` against a mocked `chrome.cookies`
  (all present → JSON blob; one missing → `null`). Unit-test the permission util against a
  mocked `chrome.permissions`.
- **Server:** extend the `socialSync` router tests to cover an **API-key-authenticated**
  context calling `connect`/`updateCookies` successfully (the behavior the relaxation
  enables), and that `disconnect`/`syncNow` still reject API-key auth.
- **Manual:** load the unpacked extension, log into Instagram in the browser, click
  Connect, confirm the connection appears and the first sync imports bookmarks.

## Not changing

The cookie providers' fetch logic, the `planSync` sync worker, the encryption scheme, and
the web settings page (status / interval / auto-tag / disconnect stay in the web app).

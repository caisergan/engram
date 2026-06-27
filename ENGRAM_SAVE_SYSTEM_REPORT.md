# Engram — "Save Everything" System: State, Gaps & Recommendations

_Report date: 2026-06-27. Branch analyzed: `feat/social-sync`._

This report maps your goal — a self-hosted hub where your Mac and iPhone save content from
Instagram / X (Twitter) / Reddit / YouTube and the open web — against what the codebase
already does, then lays out the gaps and a recommended path.

---

## 1. Your goal, restated as a system

You want **two complementary capture paths** feeding one self-hosted store on your Google VM:

1. **Ad-hoc / manual capture** — "I'm looking at something right now, save it":
   - iPhone: double-tap-back → save what's on screen.
   - Mac: a keyboard shortcut (you said Cmd+D) → save the current browser page.
2. **Bulk / passive capture** — "pull everything I bookmarked on the platforms themselves":
   - An hourly job that logs into each social platform and imports your **Saved Posts**.

A key insight up front: **these two paths overlap, and that's good.** The hourly cron is what
actually harvests your *saved* social posts wholesale. The back-tap / Cmd+D shortcuts are for
*ad-hoc* things that aren't a platform "save" (a web article, a friend's link, a screenshot).
You don't need the manual path to reach inside the Instagram/Twitter apps — the cron does that.

---

## 2. What already exists (the good news)

The backend is genuinely well-suited to this. Most of the hard plumbing is done.

### 2.1 Core ingestion API — DONE
- **`POST /api/v1/bookmarks`** accepts `link`, `text`, or `asset` (image/PDF) bookmarks.
  A link save is a one-liner: `{ "type": "link", "url": "..." }`. Returns `201` immediately;
  the server crawls/enriches asynchronously. _( `packages/api/routes/bookmarks.ts:48` )_
- **`POST /api/v1/bookmarks/singlefile`** — one call to save a full-page HTML archive (used by
  the extension) so the server doesn't have to re-fetch. _( `bookmarks.ts:111` )_
- **Built-in dedup**: saving an existing URL returns the existing bookmark instead of duplicating.
- **Enrichment pipeline**: after save, background workers crawl the page (Playwright screenshot,
  PDF, metadata), run AI auto-tagging/summary, and index for search.
- **SDK** (`@karakeep/sdk`) gives a typed client usable from any script/Shortcut.

### 2.2 Remote auth — DONE
- API-key Bearer auth: `Authorization: Bearer ak2_<keyId>_<secret>`, validated on every request.
- Keys can be minted from the web UI, or bootstrapped from email+password via
  `apiKeys.exchange` (what the mobile app and extension already use).
- CORS is wide-open (`origin: *`, `Authorization` allowed), so non-browser clients work.

### 2.3 iOS app capture — **mostly DONE** (this surprised me, in a good way)
- The Expo app **already ships a fully working iOS Share Extension** (`expo-share-intent`).
  It appears in the iOS share sheet for **URLs, web pages, images, text, and PDFs**, saves to
  your configured server, and auto-dismisses. _( `apps/mobile/app/sharing.tsx`, `app.config.js:77` )_
- It has a **self-host server-address screen** and custom-header support.
- So a real "back-tap → save" flow is achievable **today** with no new mobile code (see §4.1).

### 2.4 Browser extension capture — **mostly DONE**
- MV3 extension (Chrome + Firefox) that saves the current tab, with **auto-save on** by default.
- It **already has a keyboard command**: `add-link`, default **`Ctrl+Shift+E`**, which saves the
  current tab and is fully wired. _( `apps/browser-extension/manifest.json:69`, `background.ts:269` )_
- Optional SingleFile full-page capture, self-host address + API-key config.

### 2.5 Social sync — **infrastructure DONE, providers PARTIAL**
- A real scheduler exists: `node-cron` ticks every minute and enqueues a sync per connection
  based on a **per-connection interval (default 60 min = hourly)**, with idempotency keys so it
  never double-fires. _( `apps/workers/workers/socialSyncWorker.ts:439` )_
- **Instagram is fully end-to-end**: cookie auth → paginated `feed/saved/posts` fetch → dedup →
  bookmark creation → image mirrored locally + caption/hashtags as tags.
- Cookies are **AES-256-GCM encrypted at rest**; progress + run-history UI is built and live-polled.
- A browser-extension helper can **auto-read your cookies** for Instagram and X with one click.

### 2.6 Deployment — DONE (minus TLS)
- One-command Docker Compose: an all-in-one container (web + workers + DB migration via s6) plus
  `chrome` and `meilisearch` sidecars. SQLite + an in-process liteque queue — **no Redis/broker**.
- `NEXTAUTH_URL` is the single switch that points all clients at your public server.

---

## 3. The gaps (the work that remains)

| # | Gap | Where | Severity |
|---|-----|-------|----------|
| G1 | **X (Twitter) provider is a stub** — `fetchSavedItems` returns `[]` | `xProvider.ts:18` | High |
| G2 | **YouTube provider is a stub** — returns `[]` | `youtubeProvider.ts:18` | High |
| G3 | **Reddit doesn't exist at all** — not in platform enum, no provider | — | High |
| G4 | **Cmd+D can't be bound** — it's browser-reserved on macOS; extensions can't claim it | browser limitation | Medium |
| G5 | **No first-class iOS Shortcut / App Intent** — back-tap must route through the share sheet | `apps/mobile` (no Swift App Intent) | Medium |
| G6 | **No TLS / reverse proxy** in the repo — needed for iPhone-on-cellular to reach the VM | infra | High |
| G7 | **Cookie auth is fragile** — sessions expire; refresh is manual via the UI | `socialSyncWorker.ts:272` | Medium |
| G8 | **Custom mobile build required** — share extension needs an EAS/TestFlight build, not App Store | `apps/mobile` | Medium |
| G9 | **No `docker/.env.example`**, `DB_WAL_MODE` off by default | `docker/`, `config.ts:234` | Low |
| G10 | Keyboard-save path doesn't pre-fill the page title | `background.ts:271` | Low |

---

## 4. Recommendations, mapped to your three workflows

### 4.1 iPhone "double-tap-back to save"

**Reality check:** iOS Back Tap can't read arbitrary content out of a third-party app's screen.
What it *can* do is run a **Shortcut**. So the practical wiring is:

- **For web pages (Safari):** Back Tap → a Shortcut that takes the current Safari URL and runs
  the share/"Open in Engram" action → existing share extension saves it. Works today.
- **For posts inside the Instagram/X/YouTube/Reddit *apps*:** Back Tap can't grab the post. Use
  the app's native **Share button → Engram** (the share extension already handles this). And for
  anything you tapped "Save" on inside those apps, **the hourly cron picks it up automatically** —
  so you rarely need to do this by hand.

**Recommended approach (lowest effort, highest payoff):**
1. Build the mobile app with EAS, point it at your server, install via TestFlight (G8). _No code._
2. Create one **iOS Shortcut** "Save to Engram" and assign it to **Back Tap → Double Tap**. _No code._
3. _(Optional polish)_ Add a native **App Intent** ("Save to Engram" as a first-class Shortcuts
   action with the current URL) so the back-tap is one tap snappier (G5). This is real Swift work.

> Honest take: the share-sheet route already gives you 95% of this. I'd ship that first and only
> build the App Intent if the extra tap annoys you.

### 4.2 Mac "Cmd+D to save the page"

**Reality check:** `Cmd+D` is hard-reserved by Chrome/Safari/Firefox for native bookmarking;
an extension **cannot** bind it (G4). Two honest options:

- **Recommended:** Rebind the **already-working** `add-link` command to **`Cmd+Shift+D`** (or
  similar) via `chrome://extensions/shortcuts`. Zero code; with auto-save on it's a silent
  one-keystroke save. Add a `"mac"` default in the manifest so new installs get it (G10 fix here too).
- **If you truly want literal Cmd+D:** a system-level helper outside the browser — a Raycast/Alfred
  command, Hammerspoon binding, or a tiny Swift menu-bar app — that grabs the frontmost browser URL
  and `POST`s to `/api/v1/bookmarks`. More moving parts; only worth it if Cmd+Shift+D bothers you.

### 4.3 Hourly social cron

The scheduler and Instagram are done — **the remaining work is finishing the other three providers.**

- **Reddit (G3):** _Do this first and properly._ Reddit has an **official OAuth API** with a
  `/user/<name>/saved` endpoint — far more robust than cookie scraping and won't silently expire.
  Recommend implementing Reddit via OAuth rather than the cookie pattern used elsewhere. Requires a
  schema migration to add `"reddit"` to the platform enum + a new provider.
- **YouTube (G2):** "Saved" maps to playlists / Watch Later. The official **YouTube Data API**
  (OAuth) is the durable route; the InnerTube-scraping stub is fragile. Note Watch Later isn't
  exposed via the official API, so scope this to "saved playlists" + liked videos.
- **X / Twitter (G1):** The hardest. The official API is expensive/limited; the existing design
  assumes cookie scraping of bookmarks. Expect this to be the most brittle and to need periodic
  cookie refresh (G7). Consider doing it last.
- **Cookie-expiry UX (G7):** Add a notification (email/webhook/push) when a connection auto-disables
  so you know to refresh cookies, instead of silently stopping.

### 4.4 Deployment hardening (do this early — it unblocks everything mobile)

- **Put Caddy in front (G6)** for automatic HTTPS (Let's Encrypt) → proxy to `localhost:3030`.
  Set `NEXTAUTH_URL=https://your.domain`. iPhone-on-cellular needs this.
- Set `DB_WAL_MODE=true`; create a `docker/.env` (template it as `.env.example`) (G9).
- Lock signups with `DISABLE_SIGNUPS=true` after creating your account.

---

## 5. Suggested sequencing

1. **Stand up the server properly** — Caddy + HTTPS + `NEXTAUTH_URL` + WAL. _Unblocks all clients._
2. **Wire the Mac shortcut** — rebind to `Cmd+Shift+D`, add `"mac"` default + title fix. _Hours._
3. **Wire the iPhone** — EAS build → TestFlight → Back Tap Shortcut. _A day, mostly build/signing._
4. **Finish social providers** — Reddit (OAuth) → YouTube (OAuth) → X (cookie). _The real dev work._
5. **Polish** — cookie-expiry notifications; optional iOS App Intent.

Steps 1–3 give you the full ad-hoc capture experience with **almost no new code**. Step 4 is where
the remaining engineering lives.

---

## 6. Decisions locked in (2026-06-27)

- **Mac shortcut → `Cmd+Shift+D`.** No system helper. Rebind the existing `add-link` command and add
  a `"mac"` default in the manifest. (Cmd+D stays as the browser's native bookmark — no conflict.)
- **Social auth → cookie-based for all four platforms**, matching the Instagram/X pattern. Reddit and
  YouTube providers follow the same `SocialSyncProvider` interface + AES-GCM cookie storage. Trade-off
  accepted: cookies expire and need periodic manual refresh — so the cookie-expiry notification (G7)
  becomes more valuable, not less. Reddit still needs a schema migration to add `"reddit"` to the
  platform enum.
- **iOS distribution → self-built via Xcode with a FREE Apple account.** This works, with one real
  caveat below.

### ⚠️ Free Apple Developer account caveat (affects the iPhone flow)

A free account can build and sideload the app **and** the share extension via Xcode, but:
- **Provisioning profiles expire after 7 days.** The app (and its share extension) **stops launching
  after ~1 week** until you re-build/re-deploy from Xcode. For a "save things every day" tool, that
  weekly re-sign is the main friction.
- Limited to **3 sideloaded apps** per device; the device must occasionally re-trust the cert.
- App Groups (used by the share extension to pass data to the app) generally work on free accounts,
  but are another thing that can break on re-sign — worth verifying early.

**Honest recommendation:** build it free first to validate the whole flow end-to-end. If you end up
relying on it daily, a paid account ($99/yr) removes the 7-day expiry and unlocks TestFlight — by far
the cleanest long-term install path. Not required to start, just the thing that will annoy you.

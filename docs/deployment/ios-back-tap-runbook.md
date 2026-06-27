# iOS Back-Tap "Save to Engram" runbook

This sets up double-tap-the-back-of-your-iPhone to save the current page into Engram. The app side
is the `karakeep://save?url=...` deep link (added in `apps/mobile/app/save.tsx`); the rest is an iOS
Shortcut + the Back Tap accessibility trigger (no code, your side).

## 1. Build & install the app

The deep link only exists in a native build (not Expo Go). Build with EAS or Xcode, point it at your
self-hosted server (Settings → Server Address), and sign in.

> **Free Apple account caveat:** a free account's provisioning expires after ~7 days, so the app (and
> its share extension / deep link) stops launching until you re-deploy from Xcode. Fine for trying it;
> a paid account ($99/yr) removes the weekly re-sign and unlocks TestFlight.

**Scheme:** a release/preview build uses `karakeep://`; a dev build uses `karakeep-dev://`. Use the
matching scheme in the Shortcut below.

## 2. Create the Shortcut "Save to Engram"

In the Shortcuts app → **+** → add these actions in order:

1. **Get Current URL** (category: Safari / Web) — returns the URL of the frontmost Safari tab.
2. **URL Encode** — *Text* action: `URL Encode` the result of step 1.
3. **Open URLs** — set the URL to:
   ```
   karakeep://save?url=[Encoded URL]
   ```
   (Insert the step-2 variable where `[Encoded URL]` is. For a dev build use `karakeep-dev://save?url=…`.)

Name it **Save to Engram**.

What happens: the app opens on the `save` route, creates the bookmark via the same API the share
sheet uses, shows a brief "Hoarded!" confirmation, and auto-dismisses back to the dashboard. If you're
not signed in, it routes you to sign-in instead.

## 3. Assign it to Back Tap

Settings → **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → choose **Save to Engram**.

## 4. Use it

Open any page in **Safari** → double-tap the back of the phone → it saves.

### Notes / limits
- **Safari pages** work best (Back Tap can read the current Safari URL). For content inside the
  **Instagram / X / YouTube / Reddit apps**, Back Tap can't read the page — use that app's **Share**
  button → **Engram** (the share extension, already built), and remember the **hourly social-sync
  cron** imports your *saved* posts from those platforms wholesale anyway.
- If "Get Current URL" returns nothing, run the Shortcut once from the Safari **Share sheet** to grant
  it permission, then Back Tap will work.
- The same `karakeep://save?url=<encoded>` deep link works from any automation (e.g. a Mac shortcut),
  not just Back Tap.

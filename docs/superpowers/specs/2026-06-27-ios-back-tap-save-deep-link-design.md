# Design: iOS Back-Tap "Save to Engram" via a deep link

_Date: 2026-06-27 · Repo: `github.com/caisergan/engram`_

## Goal

Enable the report's iPhone back-tap capture (`ENGRAM_SAVE_SYSTEM_REPORT.md` §4.1) with a real one-action
flow: double-tap-back → iOS Shortcut → the app saves the current page. The Expo app already ships a
working iOS Share Extension; the missing app-side primitive is a deep link that saves directly without
the share-sheet step.

## Approach

Add a `karakeep://save?url=<encoded>` (and `?text=<encoded>`) deep link handled by a new Expo Router
route `apps/mobile/app/save.tsx`. It mirrors the proven share-intent screen (`app/sharing.tsx`) — same
tRPC `createBookmark` mutation, same `source: "mobile"`, same loading/success/error UI and auto-dismiss —
but the payload comes from the deep-link query params instead of the OS share sheet.

A Back-Tap Shortcut ("Get Current URL → URL Encode → Open `karakeep://save?url=…`") drives it. The deep
link is generic, so any automation (incl. a Mac shortcut) can use it.

## Implementation

- **`apps/mobile/app/save.tsx`** (new): inner `SaveFromLink` component reads
  `useLocalSearchParams<{ url?, text? }>()`, and in an effect: if not signed in → `router.replace("signin")`;
  if `url` → save a LINK; else if `text` → LINK when it parses as a URL, otherwise TEXT; else error. The
  outer `Save` component owns the `mode` state, the loading/success/error animations, and the
  auto-dismiss timers — structurally identical to `sharing.tsx` (save logic in an inner component, so no
  hooks run after a conditional return).
- **`apps/mobile/app/_layout.tsx`** (modified): register `<Stack.Screen name="save" options={{ headerShown: false }} />`
  next to `sharing`. Expo Router's file-system routing maps `karakeep://save` to the file automatically;
  the `scheme` is already configured in `app.config.js`. Params arrive URL-decoded.

## Decisions

- **Deep link over a native App Intent.** A first-class Siri/Shortcuts App Intent would need Swift + a
  config plugin (heavy, deferred in the report). The deep link is pure Expo/RN, reuses the working save
  flow, and is enough for a Back-Tap Shortcut.
- **Auth guard added** (sharing.tsx lacks one): a direct deep link can arrive before sign-in, so route to
  `signin` rather than firing a guaranteed-to-fail save.
- **No double-decoding:** Expo Router already decodes query params, so the values are used as-is.

## Testing

`apps/mobile` has **no test runner** (no jest/vitest; scripts are typecheck/lint/format only), and this is
screen code, so there's nothing to unit-test. Verification is `typecheck` + `lint` + `format` (all green),
plus the manual on-device flow in `docs/deployment/ios-back-tap-runbook.md` (build → Shortcut → Back Tap →
save). Real device verification is the user's step.

## Out of scope

- Native App Intent / Siri action, share-extension changes, and EAS build/signing (covered by the runbook).

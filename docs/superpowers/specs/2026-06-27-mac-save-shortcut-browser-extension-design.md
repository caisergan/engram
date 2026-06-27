# Design: Mac save shortcut for the browser extension

_Date: 2026-06-27 · Repo: `github.com/caisergan/engram`_

## Goal

Give macOS Chrome a one-keystroke "save the current page to Engram" shortcut, the desktop
ad-hoc-capture item from `ENGRAM_SAVE_SYSTEM_REPORT.md` §4.2. The extension already has a working
`add-link` keyboard command (`Ctrl+Shift+E`) that saves the current tab and auto-saves by default;
this just gives it a Mac-friendly default binding and fixes a small title gap.

## Why not `Cmd+D` / `Cmd+Shift+D`

`Cmd+D` is Chrome's built-in "Bookmark this tab" and cannot be claimed by an extension. `Cmd+Shift+D`
is Chrome's "Bookmark All Tabs" on Mac — a `suggested_key` collision means Chrome won't auto-bind it
and a manual binding can be shadowed. **Chosen binding: `Cmd+Shift+S`** (free on Chrome and Firefox
Mac; `Cmd+S` is save-page, `Cmd+Shift+S` is unused).

## Changes (2 edits, no new files)

### 1. `apps/browser-extension/manifest.json`

Add a `mac` entry to the existing `add-link` command's `suggested_key`; leave `default`
(`Ctrl+Shift+E`, Windows/Linux) unchanged:

```json
"commands": {
  "add-link": {
    "suggested_key": {
      "default": "Ctrl+Shift+E",
      "mac": "Command+Shift+S"
    },
    "description": "Send the current page URL to Karakeep."
  }
}
```

### 2. `apps/browser-extension/src/background/background.ts` (`handleCommand`)

Pass the current page title to `addLinkToKarakeep`, matching the context-menu path
(`background.ts:127`). The keyboard command only ever saves the current page (`pageUrl = tab.url`,
no `srcUrl`/`linkUrl`), so `tab.title` is unambiguously correct:

```ts
addLinkToKarakeep({
  selectionText: undefined,
  srcUrl: undefined,
  linkUrl: undefined,
  pageUrl: tab?.url,
  title: tab?.title,
});
```

## Behavior

With `autoSave` on (default), `Cmd+Shift+S` saves the current tab silently — the popup opens
briefly, the bookmark is created via the existing `createBookmark` tRPC mutation, and the popup
closes. The bookmark now carries the page title immediately instead of waiting for the server crawl.

## Scope / impact

- **Existing installs:** changing `suggested_key` only affects fresh installs or un-customized
  bindings; Chrome does not override a user's existing/assigned shortcut on update. Rebuilding and
  reloading the extension picks up `Cmd+Shift+S`.
- **Firefox:** the manifest is shared (`VITE_BUILD_FIREFOX`); `suggested_key.mac` is honored and
  `Cmd+Shift+S` is free there too. Out of primary scope (user is on Chrome) but not broken.
- Out of scope: any change to the popup/save flow, auto-save behavior, SingleFile capture, or
  non-keyboard entry points.

## Verification

This is manifest config plus a one-line param pass; the `browser-extension` package has no automated
test harness for the service worker or manifest. Verification is therefore:

1. **Build** the extension (`pnpm build` in `apps/browser-extension`) — it compiles and the emitted
   `manifest.json` contains the `mac` suggested_key.
2. **Manual load** (runbook handed to the user): load unpacked in Chrome →
   `chrome://extensions/shortcuts` shows `Cmd+Shift+S` for "Send the current page URL to Karakeep" →
   press it on any page → a bookmark is created with the page title.

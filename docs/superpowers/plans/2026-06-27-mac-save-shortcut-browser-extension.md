# Mac Save Shortcut (Browser Extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind the existing `add-link` extension command to `Cmd+Shift+S` on macOS and pre-fill the page title when saving via the keyboard.

**Architecture:** Two small edits to the existing extension — a `mac` entry in the `add-link` command's `suggested_key` (manifest), and passing `tab.title` in the keyboard command handler. No new files, no behavior changes beyond the binding + title.

**Tech Stack:** MV3 browser extension, Vite + `@crxjs/vite-plugin`, TypeScript service worker (`chrome.commands`).

**Spec:** `docs/superpowers/specs/2026-06-27-mac-save-shortcut-browser-extension-design.md`

> **Note on testing:** This is manifest config + a one-line param pass in a service worker. The `apps/browser-extension` package has **no automated test harness** for the manifest or background script (its scripts are only `dev`/`build`/`lint`/`format`/`typecheck`). So "verification" here is `typecheck` + `build` + an assertion on the emitted `dist/manifest.json`, plus a documented manual-load check (Task 4) — not a unit test. Stated honestly rather than inventing a brittle mock.

---

## File Structure

| File | Change |
|---|---|
| `apps/browser-extension/manifest.json` | Add `"mac": "Command+Shift+S"` to the `add-link` command's `suggested_key`. |
| `apps/browser-extension/src/background/background.ts` | In `handleCommand`, pass `title: tab?.title` to `addLinkToKarakeep`. |

---

## Task 1: Add the macOS keybinding to the manifest

**Files:**
- Modify: `apps/browser-extension/manifest.json` (the `commands.add-link.suggested_key` block, ~lines 69–76)

- [ ] **Step 1: Edit the suggested_key**

Find:
```json
  "commands": {
    "add-link": {
      "suggested_key": {
        "default": "Ctrl+Shift+E"
      },
      "description": "Send the current page URL to Karakeep."
    }
  }
```
Replace with:
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

- [ ] **Step 2: Verify the JSON is valid and contains both keys**

Run:
```bash
cd apps/browser-extension && node -e "const m=require('./manifest.json'); const k=m.commands['add-link'].suggested_key; if(k.default!=='Ctrl+Shift+E'||k.mac!=='Command+Shift+S') throw new Error('wrong keys: '+JSON.stringify(k)); console.log('OK', JSON.stringify(k))"
```
Expected: `OK {"default":"Ctrl+Shift+E","mac":"Command+Shift+S"}`

---

## Task 2: Pre-fill the page title in the keyboard handler

**Files:**
- Modify: `apps/browser-extension/src/background/background.ts` (`handleCommand`, ~lines 271–276)

- [ ] **Step 1: Pass the title**

Find:
```ts
    addLinkToKarakeep({
      selectionText: undefined,
      srcUrl: undefined,
      linkUrl: undefined,
      pageUrl: tab?.url,
    });
```
Replace with:
```ts
    addLinkToKarakeep({
      selectionText: undefined,
      srcUrl: undefined,
      linkUrl: undefined,
      pageUrl: tab?.url,
      title: tab?.title,
    });
```

- [ ] **Step 2: Verify the edit is present**

Run:
```bash
cd apps/browser-extension && grep -n "title: tab?.title" src/background/background.ts
```
Expected: one match inside `handleCommand` (the line you just added).

---

## Task 3: Typecheck, build, verify emitted manifest, commit

**Files:** (no edits — verification + commit)

- [ ] **Step 1: Typecheck**

Run:
```bash
pnpm --filter @karakeep/browser-extension typecheck
```
Expected: no errors (exits 0).

- [ ] **Step 2: Build**

Run:
```bash
pnpm --filter @karakeep/browser-extension build
```
Expected: build completes, `apps/browser-extension/dist/manifest.json` is produced.

- [ ] **Step 3: Verify the built manifest carries the Mac binding**

Run:
```bash
cd apps/browser-extension && node -e "const m=require('./dist/manifest.json'); const k=m.commands['add-link'].suggested_key; if(k.mac!=='Command+Shift+S') throw new Error('mac key missing in build: '+JSON.stringify(k)); console.log('built OK', JSON.stringify(k))"
```
Expected: `built OK {"default":"Ctrl+Shift+E","mac":"Command+Shift+S"}`

- [ ] **Step 4: Commit**

```bash
git add apps/browser-extension/manifest.json apps/browser-extension/src/background/background.ts
git commit -m "feat(extension): add Cmd+Shift+S Mac save shortcut + pre-fill title on keyboard save"
```

---

## Task 4: Manual-load verification (handed to the user)

**Files:** (none — a checklist the user runs in Chrome on macOS)

- [ ] **Step 1: Load the built extension**

In Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`apps/browser-extension/dist`. (Set the server address + sign in first if this is a fresh load.)

- [ ] **Step 2: Confirm the shortcut bound**

Open `chrome://extensions/shortcuts`. Under **Karakeep**, the command "Send the current page URL to
Karakeep" should show **⌘⇧S**. If it shows unbound, click the field and press `Cmd+Shift+S` to assign
(it should accept it — `Cmd+Shift+S` is not a Chrome default).

- [ ] **Step 3: Confirm save-with-title works**

Navigate to any web page (e.g. a news article) → press `Cmd+Shift+S`. Expected: the popup flashes and
the page is saved (auto-save on by default). In your Engram dashboard the new bookmark shows the
page's title immediately (before the server-side crawl finishes).

---

## Self-Review

**Spec coverage:**
- Spec "Changes §1" (manifest `mac` key) → Task 1. ✓
- Spec "Changes §2" (handler `title`) → Task 2. ✓
- Spec "Verification" (build + emitted-manifest assertion + manual load) → Tasks 3 & 4. ✓
- Spec "Why not Cmd+Shift+D" / binding choice → encoded as `Command+Shift+S` in Task 1. ✓
- Spec scope notes (existing installs, Firefox, out-of-scope) → no code; nothing to implement. ✓

**Placeholder scan:** No TBD/TODO. Every step has exact find/replace blocks or exact commands with
expected output. The "no test harness" note is a deliberate, accurate statement, not a placeholder.

**Type/name consistency:** Command id `add-link`, key string `Command+Shift+S`, and the
`addLinkToKarakeep({ ..., title })` field name match the existing code (`background.ts` `handleCommand`
and the `addLinkToKarakeep` signature, which already accepts `title?: string`). Build artifact path
`apps/browser-extension/dist/manifest.json` is consistent across Task 3 steps.

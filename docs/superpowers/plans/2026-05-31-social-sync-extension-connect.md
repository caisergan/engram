# Social Sync Extension Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users connect Instagram and X to Social Sync with one click in the browser extension — the extension reads their session cookies and sends them to the existing backend — instead of copy-pasting cookies from DevTools.

**Architecture:** A pure cookie-blob builder + a shared required-cookie map live in `@karakeep/shared` (consumed by both the sync providers and the extension, so they never drift). The extension's Options page gets a "Social Sync" section that requests narrow `cookies`+host permissions on demand, reads cookies via `chrome.cookies.getAll` (which can read `httpOnly`), and calls the existing `socialSync.connect`/`updateCookies` mutations. Those two mutations are relaxed from `sessionProcedure` to `authedProcedure` so the API-key-authenticated extension can call them.

**Tech Stack:** TypeScript, tRPC, React + @tanstack/react-query, Chrome MV3 extension APIs (`chrome.cookies`, `chrome.permissions`), Vitest.

**Note on test environment:** Tasks 1–2 tests run under the current Node (they don't touch the DB). Task 3's test is DB-backed (`better-sqlite3`); it requires the working test DB env (Node 24 / synced `better-sqlite3`), which is being handled separately. Write the test regardless; run it once the DB env is in place.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/shared/types/socialSync.ts` | Add `PLATFORM_REQUIRED_COOKIES` map + pure `buildCookieBlob()` | Modify |
| `packages/shared/types/socialSync.test.ts` | Unit tests for the above | Create |
| `packages/trpc/lib/socialSync/instagramProvider.ts` | Consume shared cookie map | Modify |
| `packages/trpc/lib/socialSync/xProvider.ts` | Consume shared cookie map | Modify |
| `packages/trpc/lib/socialSync/youtubeProvider.ts` | Consume shared cookie map | Modify |
| `packages/trpc/routers/socialSync.ts` | Relax `connect`/`updateCookies` to `authedProcedure` | Modify |
| `packages/trpc/routers/socialSync.test.ts` | Tests for API-key access | Modify |
| `apps/browser-extension/manifest.json` | Add `cookies` optional permission + narrow host perms | Modify |
| `apps/browser-extension/src/utils/socialSyncPermissions.ts` | Request/check per-platform cookie+host permission | Create |
| `apps/browser-extension/src/utils/readPlatformCookies.ts` | Read platform cookies → JSON blob | Create |
| `apps/browser-extension/src/components/SocialSyncConnect.tsx` | Options-page UI section | Create |
| `apps/browser-extension/src/OptionsPage.tsx` | Render the new section | Modify |

---

## Task 1: Shared cookie map + pure blob builder

**Files:**
- Modify: `packages/shared/types/socialSync.ts`
- Test: `packages/shared/types/socialSync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/types/socialSync.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { buildCookieBlob, PLATFORM_REQUIRED_COOKIES } from "./socialSync";

describe("PLATFORM_REQUIRED_COOKIES", () => {
  test("declares the required cookies per platform", () => {
    expect(PLATFORM_REQUIRED_COOKIES.instagram).toEqual([
      "sessionid",
      "csrftoken",
      "ds_user_id",
    ]);
    expect(PLATFORM_REQUIRED_COOKIES.x).toEqual(["auth_token", "ct0"]);
    expect(PLATFORM_REQUIRED_COOKIES.youtube).toEqual(["SID", "HSID", "SSID"]);
  });
});

describe("buildCookieBlob", () => {
  test("returns a JSON blob of only the required cookies", () => {
    const blob = buildCookieBlob("instagram", {
      sessionid: "a",
      csrftoken: "b",
      ds_user_id: "c",
      extra: "ignored",
    });
    expect(blob).not.toBeNull();
    expect(JSON.parse(blob!)).toEqual({
      sessionid: "a",
      csrftoken: "b",
      ds_user_id: "c",
    });
  });

  test("returns null when a required cookie is missing", () => {
    expect(buildCookieBlob("instagram", { sessionid: "a", csrftoken: "b" })).toBeNull();
  });

  test("returns null when a required cookie is empty", () => {
    expect(
      buildCookieBlob("x", { auth_token: "", ct0: "x" }),
    ).toBeNull();
  });

  test("builds the X blob", () => {
    const blob = buildCookieBlob("x", { auth_token: "t", ct0: "c" });
    expect(JSON.parse(blob!)).toEqual({ auth_token: "t", ct0: "c" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && pnpm exec vitest run types/socialSync.test.ts`
Expected: FAIL — `buildCookieBlob`/`PLATFORM_REQUIRED_COOKIES` are not exported.

- [ ] **Step 3: Implement in `packages/shared/types/socialSync.ts`**

Append to the file (after the existing `SocialPlatform` type/exports):

```ts
export const PLATFORM_REQUIRED_COOKIES: Record<SocialPlatform, string[]> = {
  instagram: ["sessionid", "csrftoken", "ds_user_id"],
  x: ["auth_token", "ct0"],
  youtube: ["SID", "HSID", "SSID"],
};

/**
 * Build the JSON cookie blob the social-sync providers expect, keeping only the
 * required cookies for the platform. Returns null if any required cookie is
 * missing or empty (e.g. the user isn't logged in).
 */
export function buildCookieBlob(
  platform: SocialPlatform,
  available: Record<string, string>,
): string | null {
  const blob: Record<string, string> = {};
  for (const name of PLATFORM_REQUIRED_COOKIES[platform]) {
    const value = available[name];
    if (typeof value !== "string" || value.length === 0) return null;
    blob[name] = value;
  }
  return JSON.stringify(blob);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && pnpm exec vitest run types/socialSync.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/types/socialSync.ts packages/shared/types/socialSync.test.ts
git commit -m "feat(social-sync): add shared cookie map and buildCookieBlob"
```

---

## Task 2: Providers consume the shared cookie map

**Files:**
- Modify: `packages/trpc/lib/socialSync/instagramProvider.ts:6`
- Modify: `packages/trpc/lib/socialSync/xProvider.ts:3`
- Modify: `packages/trpc/lib/socialSync/youtubeProvider.ts:3`

- [ ] **Step 1: Update `instagramProvider.ts`**

Replace line 6 (`const REQUIRED_COOKIES = ["sessionid", "csrftoken", "ds_user_id"];`) by removing it, and add to the import block at the top:

```ts
import {
  PLATFORM_REQUIRED_COOKIES,
  type SocialSyncProvider,
  type SyncItem,
} from "@karakeep/shared/types/socialSync";
```

Then in `parseCookies`, change the validation line to use the map:

```ts
    const valid = PLATFORM_REQUIRED_COOKIES.instagram.every(
      (key) => typeof cookies[key] === "string" && cookies[key].length > 0,
    );
```

(The existing import currently is `import type { SocialSyncProvider, SyncItem } from "..."`; merge the value import as shown.)

- [ ] **Step 2: Update `xProvider.ts`**

Remove line 3 (`const REQUIRED_COOKIES = ["auth_token", "ct0"];`). Add the import:

```ts
import { PLATFORM_REQUIRED_COOKIES } from "@karakeep/shared/types/socialSync";
```

Replace the `REQUIRED_COOKIES.every(...)` usage with `PLATFORM_REQUIRED_COOKIES.x.every(...)`.

- [ ] **Step 3: Update `youtubeProvider.ts`**

Remove line 3 (`const REQUIRED_COOKIES = ["SID", "HSID", "SSID"];`). Add the import:

```ts
import { PLATFORM_REQUIRED_COOKIES } from "@karakeep/shared/types/socialSync";
```

Replace the `REQUIRED_COOKIES.every(...)` usage with `PLATFORM_REQUIRED_COOKIES.youtube.every(...)`.

- [ ] **Step 4: Run the provider tests to verify no regression**

Run: `cd packages/trpc && pnpm exec vitest run lib/socialSync`
Expected: PASS (instagramProvider.test.ts 28 + syncEngine.test.ts 7 = 35).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @karakeep/trpc typecheck`
Expected: Done, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/trpc/lib/socialSync/instagramProvider.ts packages/trpc/lib/socialSync/xProvider.ts packages/trpc/lib/socialSync/youtubeProvider.ts
git commit -m "refactor(social-sync): providers consume shared cookie map"
```

---

## Task 3: Relax connect/updateCookies to authedProcedure

**Files:**
- Modify: `packages/trpc/routers/socialSync.ts:59,102`
- Test: `packages/trpc/routers/socialSync.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/trpc/routers/socialSync.test.ts`, add the import (merge into the existing testUtils import on line ~4):

```ts
import { defaultBeforeEach, getApiKeyCallerForPlainKey } from "../testUtils";
```

Add a new describe block inside `describe("Social Sync Router", ...)`:

```ts
  describe("API-key auth (extension)", () => {
    test<CustomTestContext>("allows an API key to connect", async ({
      apiCallers,
      db,
    }) => {
      const created = await apiCallers[0].apiKeys.create({ name: "ext" });
      const apiKeyCaller = await getApiKeyCallerForPlainKey(db, created.key);

      await apiKeyCaller.socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });

      const connections = await apiKeyCaller.socialSync.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0].platform).toBe("instagram");
    });

    test<CustomTestContext>("still rejects an API key for syncNow", async ({
      apiCallers,
      db,
    }) => {
      const created = await apiCallers[0].apiKeys.create({ name: "ext" });
      const apiKeyCaller = await getApiKeyCallerForPlainKey(db, created.key);

      await apiCallers[0].socialSync.connect({
        platform: "instagram",
        cookies: VALID_INSTAGRAM_COOKIES,
      });
      const [conn] = await apiCallers[0].socialSync.getConnections();

      await expect(
        apiKeyCaller.socialSync.syncNow({ connectionId: conn.id }),
      ).rejects.toThrow();
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/trpc && pnpm exec vitest run routers/socialSync.test.ts`
Expected: The "allows an API key to connect" test FAILS (UNAUTHORIZED — `connect` is still `sessionProcedure`). The "still rejects" test passes.

> If the DB test env isn't ready (`better-sqlite3`/Node mismatch), the suite fails to load instead. Run this step once the env is fixed.

- [ ] **Step 3: Relax the procedures**

In `packages/trpc/routers/socialSync.ts`:
- Line 59: change `connect: sessionProcedure` → `connect: authedProcedure`
- Line 102: change `updateCookies: sessionProcedure` → `updateCookies: authedProcedure`

Leave `disconnect`, `setEnabled`, `updateSettings`, `syncNow` as `sessionProcedure`. The `authedProcedure` symbol is already imported on line 16.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/trpc && pnpm exec vitest run routers/socialSync.test.ts`
Expected: PASS (existing tests + both new tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @karakeep/trpc typecheck`
Expected: Done.

- [ ] **Step 6: Commit**

```bash
git add packages/trpc/routers/socialSync.ts packages/trpc/routers/socialSync.test.ts
git commit -m "feat(social-sync): allow API-key auth to connect/update cookies"
```

---

## Task 4: Extension manifest permissions

**Files:**
- Modify: `apps/browser-extension/manifest.json:47-48`

- [ ] **Step 1: Add the cookies optional permission and narrow host perms**

Replace lines 47–48:

```json
  "permissions": ["storage", "tabs", "contextMenus", "activeTab", "scripting"],
  "optional_host_permissions": ["<all_urls>"],
```

with:

```json
  "permissions": ["storage", "tabs", "contextMenus", "activeTab", "scripting"],
  "optional_permissions": ["cookies"],
  "optional_host_permissions": [
    "<all_urls>",
    "https://*.instagram.com/*",
    "https://*.x.com/*",
    "https://*.twitter.com/*"
  ],
```

- [ ] **Step 2: Verify the manifest is valid JSON**

Run: `node -e "require('./apps/browser-extension/manifest.json'); console.log('manifest valid')"`
Expected: `manifest valid`

- [ ] **Step 3: Commit**

```bash
git add apps/browser-extension/manifest.json
git commit -m "feat(extension): declare cookies + platform host permissions"
```

---

## Task 5: Extension permission util

**Files:**
- Create: `apps/browser-extension/src/utils/socialSyncPermissions.ts`

> No unit test: the `@karakeep/browser-extension` package has no Vitest harness, and this is a thin wrapper over `chrome.permissions`. Adding a test framework here is out of scope (YAGNI). It's verified by typecheck and the Task 8 manual smoke test; the pure logic that matters is covered in Task 1.

- [ ] **Step 1: Create the util**

```ts
/**
 * Per-platform permission helpers for social-sync connect. The `cookies`
 * permission and platform host access are *optional* — requested on demand from
 * a user gesture (the Connect button), never granted at install time.
 */

export type ConnectablePlatform = "instagram" | "x";

const PLATFORM_ORIGINS: Record<ConnectablePlatform, string[]> = {
  instagram: ["https://*.instagram.com/*"],
  x: ["https://*.x.com/*", "https://*.twitter.com/*"],
};

function permissionsFor(
  platform: ConnectablePlatform,
): chrome.permissions.Permissions {
  return { permissions: ["cookies"], origins: PLATFORM_ORIGINS[platform] };
}

export function hasPlatformAccess(
  platform: ConnectablePlatform,
): Promise<boolean> {
  return chrome.permissions.contains(permissionsFor(platform));
}

export function requestPlatformAccess(
  platform: ConnectablePlatform,
): Promise<boolean> {
  return chrome.permissions.request(permissionsFor(platform));
}

export function removePlatformAccess(
  platform: ConnectablePlatform,
): Promise<boolean> {
  return chrome.permissions.remove(permissionsFor(platform));
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @karakeep/browser-extension typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/browser-extension/src/utils/socialSyncPermissions.ts
git commit -m "feat(extension): add social-sync permission helpers"
```

---

## Task 6: Extension cookie reader

**Files:**
- Create: `apps/browser-extension/src/utils/readPlatformCookies.ts`

> No unit test (same reason as Task 5). The pure transform — required-cookie filtering and the null-when-missing behavior — lives in `buildCookieBlob` and is fully tested in Task 1; this wrapper only adapts `chrome.cookies.getAll` output into that function's input.

- [ ] **Step 1: Create the util**

```ts
import { buildCookieBlob } from "@karakeep/shared/types/socialSync";

import type { ConnectablePlatform } from "./socialSyncPermissions";

const PLATFORM_COOKIE_DOMAINS: Record<ConnectablePlatform, string[]> = {
  instagram: [".instagram.com"],
  x: [".x.com", ".twitter.com"],
};

/**
 * Read the current session cookies for a platform via the extension cookies API
 * (which can read httpOnly cookies like `sessionid`) and produce the JSON blob
 * the social-sync backend expects. Returns null if a required cookie is missing
 * (i.e. the user isn't logged in to that platform in this browser).
 */
export async function readPlatformCookies(
  platform: ConnectablePlatform,
): Promise<string | null> {
  const available: Record<string, string> = {};
  for (const domain of PLATFORM_COOKIE_DOMAINS[platform]) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const cookie of cookies) {
      // First non-empty value wins (cookies may appear on multiple subdomains).
      if (cookie.value && !available[cookie.name]) {
        available[cookie.name] = cookie.value;
      }
    }
  }
  return buildCookieBlob(platform, available);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @karakeep/browser-extension typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/browser-extension/src/utils/readPlatformCookies.ts
git commit -m "feat(extension): read platform cookies into a sync blob"
```

---

## Task 7: Social Sync section in the Options page

**Files:**
- Create: `apps/browser-extension/src/components/SocialSyncConnect.tsx`
- Modify: `apps/browser-extension/src/OptionsPage.tsx`

- [ ] **Step 1: Create the component**

`apps/browser-extension/src/components/SocialSyncConnect.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../utils/trpc";
import type { ConnectablePlatform } from "../utils/socialSyncPermissions";
import { requestPlatformAccess } from "../utils/socialSyncPermissions";
import { readPlatformCookies } from "../utils/readPlatformCookies";
import { Button } from "./ui/button";

const PLATFORMS: { id: ConnectablePlatform; name: string }[] = [
  { id: "instagram", name: "Instagram" },
  { id: "x", name: "X" },
];

export default function SocialSyncConnect() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(
    api.socialSync.getConnections.queryOptions(),
  );
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries(
      api.socialSync.getConnections.queryFilter(),
    );

  const connectMutation = useMutation(
    api.socialSync.connect.mutationOptions(),
  );
  const updateMutation = useMutation(
    api.socialSync.updateCookies.mutationOptions(),
  );

  const handleConnect = async (
    platform: ConnectablePlatform,
    name: string,
    existingId: string | undefined,
  ) => {
    setStatus((s) => ({ ...s, [platform]: "" }));
    setBusy(platform);
    try {
      // Permission request must be the first thing off the user gesture.
      const granted = await requestPlatformAccess(platform);
      if (!granted) {
        setStatus((s) => ({
          ...s,
          [platform]: `Permission needed to read ${name} cookies`,
        }));
        return;
      }
      const cookies = await readPlatformCookies(platform);
      if (!cookies) {
        setStatus((s) => ({
          ...s,
          [platform]: `Open and log into ${name} in this browser, then try again`,
        }));
        return;
      }
      if (existingId) {
        await updateMutation.mutateAsync({ connectionId: existingId, cookies });
      } else {
        await connectMutation.mutateAsync({ platform, cookies });
      }
      setStatus((s) => ({ ...s, [platform]: "Connected" }));
      invalidate();
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [platform]: e instanceof Error ? e.message : "Failed to connect",
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">Social Sync</h3>
      {PLATFORMS.map((p) => {
        const connection = connectionsQuery.data?.find(
          (c) => c.platform === p.id,
        );
        const connected = !!connection;
        return (
          <div key={p.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span>{p.name}</span>
              <Button
                disabled={busy === p.id}
                onClick={() => handleConnect(p.id, p.name, connection?.id)}
              >
                {connected ? "Reconnect" : "Connect"}
              </Button>
            </div>
            {status[p.id] && (
              <span className="text-sm text-muted-foreground">
                {status[p.id]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Render it in `OptionsPage.tsx`**

Add the import near the other component imports at the top of `apps/browser-extension/src/OptionsPage.tsx`:

```tsx
import SocialSyncConnect from "./components/SocialSyncConnect";
```

Render `<SocialSyncConnect />` as its own section in the page body alongside the existing settings sections — directly after the client-side-crawling settings block is a good spot. If the exact location is unclear, place it as the last child just before the outermost closing `</div>` of the page's content container.

- [ ] **Step 3: Typecheck and build the extension**

Run: `pnpm --filter @karakeep/browser-extension typecheck`
Expected: no errors.
Run: `pnpm --filter @karakeep/browser-extension build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/browser-extension/src/components/SocialSyncConnect.tsx apps/browser-extension/src/OptionsPage.tsx
git commit -m "feat(extension): add Social Sync connect section to options"
```

---

## Task 8: Full verification & manual test

- [ ] **Step 1: Typecheck all affected packages**

Run:
```bash
pnpm --filter @karakeep/shared --filter @karakeep/trpc --filter @karakeep/browser-extension --filter @karakeep/workers typecheck
```
Expected: all Done.

- [ ] **Step 2: Lint & format changed files**

Run:
```bash
pnpm --filter @karakeep/shared --filter @karakeep/trpc --filter @karakeep/browser-extension lint
pnpm exec oxfmt --check packages/shared/types/socialSync.ts packages/trpc/routers/socialSync.ts apps/browser-extension/src/components/SocialSyncConnect.tsx apps/browser-extension/src/utils/socialSyncPermissions.ts apps/browser-extension/src/utils/readPlatformCookies.ts
```
Expected: 0 errors; correct format.

- [ ] **Step 3: Run the relevant test suites**

Run:
```bash
cd packages/shared && pnpm exec vitest run types/socialSync.test.ts
cd ../trpc && pnpm exec vitest run lib/socialSync routers/socialSync.test.ts
```
Expected: all pass. (The `routers/socialSync.test.ts` run requires the working DB test env.)

- [ ] **Step 4: Manual smoke test**

1. Build + load the unpacked extension (`apps/browser-extension/dist`) in Chrome.
2. Sign the extension into your Engram server (API key).
3. In a browser tab, log into instagram.com.
4. Open the extension Options page → Social Sync → click **Connect** on Instagram → approve the permission prompt.
5. Confirm the status shows "Connected" and the Engram web settings page shows the Instagram connection with a first sync running. Verify imported bookmarks appear under the `instagram` tag.
6. Repeat for X (log into x.com first).

- [ ] **Step 5: Final commit (if any lint/format fixes were applied)**

```bash
git add -A
git commit -m "chore(social-sync): lint/format extension connect"
```

# Vault Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a password-protected vault that hides sensitive bookmarks behind a PIN, encrypting all text fields and asset files with AES-256-GCM so they are unreadable at rest.

**Architecture:** A `vaulted` boolean on bookmarks (following the existing `archived` pattern) controls visibility. Vault PIN is hashed with bcrypt; a separate PBKDF2-derived key encrypts content. The encryption key travels in a signed token (custom header) during an active vault session — never stored on disk. All queries globally filter out `vaulted = true` unless the vault is explicitly unlocked.

**Tech Stack:** Node.js `crypto` (AES-256-GCM, PBKDF2, bcrypt), Drizzle ORM (SQLite), tRPC, React, Next.js App Router, Tailwind CSS, shadcn/ui.

**Design Spec:** `docs/superpowers/specs/2026-05-28-vault-feature-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/trpc/lib/vaultCrypto.ts` | AES-256-GCM encrypt/decrypt, PBKDF2 key derivation, vault token sign/verify |
| `packages/trpc/lib/vaultCrypto.test.ts` | Tests for all crypto functions |
| `packages/shared/types/vault.ts` | Zod schemas for vault API inputs/outputs |
| `packages/trpc/routers/vault.ts` | tRPC router: setup, unlock, lock, settings, changePin, deleteVault |
| `packages/trpc/routers/vault.test.ts` | Tests for vault router + bookmark filtering + encryption round-trips |
| `apps/web/components/dashboard/vault/VaultProvider.tsx` | React context: stores vault token, provides unlock/lock/isUnlocked |
| `apps/web/components/dashboard/vault/VaultUnlockForm.tsx` | PIN entry form (locked state) |
| `apps/web/components/dashboard/vault/VaultContent.tsx` | Vault page content (unlocked state — bookmark grid + lock button) |
| `apps/web/app/dashboard/vault/page.tsx` | Vault page route |
| `apps/web/components/dashboard/bookmarks/MoveToVaultDialog.tsx` | Confirmation dialog for moving bookmark to vault |
| `apps/web/components/settings/VaultSettings.tsx` | Settings section: setup vault, change PIN, auto-lock timeout, delete vault |

### Modified Files

| File | Change |
|------|--------|
| `packages/db/schema.ts` | Add vault columns to `users`, `bookmarks`, `assets` tables + index |
| `packages/shared/types/bookmarks.ts` | Add `vaulted` to `zBareBookmarkSchema`, `zGetBookmarksRequestSchema`, `zNewBookmarkRequestSchema` |
| `packages/trpc/index.ts` | Add `vaultKey: string \| null` to `Context` and `AuthedContext` |
| `packages/trpc/testUtils.ts` | Accept `vaultKey` in `getApiCaller` |
| `packages/trpc/routers/_app.ts` | Register `vault` router |
| `packages/trpc/routers/bookmarks.ts` | Add `moveToVault` mutation; pass `vaulted: false` default filter |
| `packages/trpc/models/bookmarks.ts` | Filter vaulted in `buildCommonFilters`; decrypt fields in `toZodSchema` |
| `apps/web/server/api/client.ts` | Read `x-vault-token` header, verify, pass `vaultKey` to context |
| `apps/web/app/dashboard/layout.tsx` | Add "Vault" sidebar item |
| `apps/web/components/dashboard/bookmarks/BookmarkOptions.tsx` | Add "Move to Vault" context menu item |
| `apps/web/lib/i18n/locales/en/translation.json` | Add vault-related translation keys |
| `apps/workers/workers/searchWorker.ts` | Skip indexing when `bookmark.vaulted === true` |

---

## Task 1: Vault Crypto Utilities

**Files:**
- Create: `packages/trpc/lib/vaultCrypto.ts`
- Create: `packages/trpc/lib/vaultCrypto.test.ts`

### Step 1.1: Write tests for key derivation and encrypt/decrypt

- [ ] **Write the test file**

```typescript
// packages/trpc/lib/vaultCrypto.test.ts
import { describe, expect, test } from "vitest";

import {
  decryptText,
  deriveEncryptionKey,
  encryptText,
  hashPin,
  verifyPin,
  createVaultToken,
  verifyVaultToken,
  encryptBuffer,
  decryptBuffer,
} from "./vaultCrypto";

describe("Vault Crypto", () => {
  const testPin = "123456";
  const testSalt = "a".repeat(32);
  const testSecret = "test-signing-secret-at-least-32-chars-long!!";

  describe("deriveEncryptionKey", () => {
    test("derives a consistent key from same pin and salt", async () => {
      const key1 = await deriveEncryptionKey(testPin, testSalt);
      const key2 = await deriveEncryptionKey(testPin, testSalt);
      expect(key1).toEqual(key2);
      expect(key1.length).toBe(32);
    });

    test("derives different keys for different pins", async () => {
      const key1 = await deriveEncryptionKey("111111", testSalt);
      const key2 = await deriveEncryptionKey("222222", testSalt);
      expect(key1).not.toEqual(key2);
    });

    test("derives different keys for different salts", async () => {
      const key1 = await deriveEncryptionKey(testPin, "a".repeat(32));
      const key2 = await deriveEncryptionKey(testPin, "b".repeat(32));
      expect(key1).not.toEqual(key2);
    });
  });

  describe("encryptText / decryptText", () => {
    test("round-trips text correctly", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const plaintext = "Hello, Vault!";
      const ciphertext = encryptText(plaintext, key);
      expect(ciphertext).not.toBe(plaintext);
      const decrypted = decryptText(ciphertext, key);
      expect(decrypted).toBe(plaintext);
    });

    test("produces different ciphertext each time (random IV)", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const c1 = encryptText("same text", key);
      const c2 = encryptText("same text", key);
      expect(c1).not.toBe(c2);
    });

    test("fails to decrypt with wrong key", async () => {
      const key1 = await deriveEncryptionKey("111111", testSalt);
      const key2 = await deriveEncryptionKey("222222", testSalt);
      const ciphertext = encryptText("secret", key1);
      expect(() => decryptText(ciphertext, key2)).toThrow();
    });

    test("handles empty string", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const ciphertext = encryptText("", key);
      expect(decryptText(ciphertext, key)).toBe("");
    });

    test("handles unicode text", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const text = "Hello 🔒 Vault — encrypted! 日本語";
      const ciphertext = encryptText(text, key);
      expect(decryptText(ciphertext, key)).toBe(text);
    });
  });

  describe("encryptBuffer / decryptBuffer", () => {
    test("round-trips buffer correctly", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const original = Buffer.from("binary data here \x00\x01\x02");
      const encrypted = encryptBuffer(original, key);
      expect(encrypted).not.toEqual(original);
      const decrypted = decryptBuffer(encrypted, key);
      expect(decrypted).toEqual(original);
    });

    test("handles empty buffer", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const encrypted = encryptBuffer(Buffer.alloc(0), key);
      expect(decryptBuffer(encrypted, key)).toEqual(Buffer.alloc(0));
    });
  });

  describe("hashPin / verifyPin", () => {
    test("verifies correct pin", async () => {
      const { hash, salt } = await hashPin(testPin);
      expect(hash).toBeTruthy();
      expect(salt).toBeTruthy();
      const valid = await verifyPin(testPin, hash, salt);
      expect(valid).toBe(true);
    });

    test("rejects wrong pin", async () => {
      const { hash, salt } = await hashPin(testPin);
      const valid = await verifyPin("wrong-pin", hash, salt);
      expect(valid).toBe(false);
    });
  });

  describe("createVaultToken / verifyVaultToken", () => {
    test("round-trips token data", () => {
      const key = Buffer.alloc(32, 1);
      const token = createVaultToken(
        { userId: "user-1", encryptionKey: key },
        testSecret,
        5,
      );
      const result = verifyVaultToken(token, testSecret);
      expect(result.userId).toBe("user-1");
      expect(Buffer.from(result.encryptionKey)).toEqual(key);
    });

    test("rejects tampered token", () => {
      const key = Buffer.alloc(32, 1);
      const token = createVaultToken(
        { userId: "user-1", encryptionKey: key },
        testSecret,
        5,
      );
      const tampered = token.slice(0, -1) + "X";
      expect(() => verifyVaultToken(tampered, testSecret)).toThrow();
    });

    test("rejects expired token", () => {
      const key = Buffer.alloc(32, 1);
      const token = createVaultToken(
        { userId: "user-1", encryptionKey: key },
        testSecret,
        -1, // already expired
      );
      expect(() => verifyVaultToken(token, testSecret)).toThrow();
    });
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run lib/vaultCrypto.test.ts`
Expected: FAIL — module `./vaultCrypto` not found

### Step 1.2: Implement vault crypto

- [ ] **Write the implementation**

```typescript
// packages/trpc/lib/vaultCrypto.ts
import crypto from "crypto";

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

export async function deriveEncryptionKey(
  pin: string,
  salt: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      pin,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      "sha256",
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

export function encryptText(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Format: base64(iv + authTag + ciphertext)
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptText(ciphertext: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function encryptBuffer(plainBuffer: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainBuffer),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptBuffer(encryptedBuffer: Buffer, key: Buffer): Buffer {
  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const authTag = encryptedBuffer.subarray(
    IV_LENGTH,
    IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const encrypted = encryptedBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export async function hashPin(
  pin: string,
): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await new Promise<string>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, 64, "sha512", (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
  return { hash, salt };
}

export async function verifyPin(
  pin: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const hash = await new Promise<string>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, 64, "sha512", (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(storedHash, "hex"),
  );
}

export function generateSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}

interface VaultTokenPayload {
  userId: string;
  encryptionKey: Buffer;
}

export function createVaultToken(
  payload: VaultTokenPayload,
  secret: string,
  autoLockMinutes: number,
): string {
  const data = {
    uid: payload.userId,
    key: payload.encryptionKey.toString("base64"),
    exp: Date.now() + autoLockMinutes * 60 * 1000,
  };
  const payloadStr = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadStr)
    .digest("base64url");
  return `${payloadStr}.${signature}`;
}

export function verifyVaultToken(
  token: string,
  secret: string,
): { userId: string; encryptionKey: Buffer } {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) throw new Error("Invalid vault token format");

  const payloadStr = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadStr)
    .digest("base64url");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature, "base64url"),
      Buffer.from(expectedSig, "base64url"),
    )
  ) {
    throw new Error("Invalid vault token signature");
  }

  const data = JSON.parse(Buffer.from(payloadStr, "base64url").toString());
  if (typeof data.exp !== "number" || data.exp < Date.now()) {
    throw new Error("Vault token expired");
  }

  return {
    userId: data.uid,
    encryptionKey: Buffer.from(data.key, "base64"),
  };
}
```

- [ ] **Run tests to verify they pass**

Run: `cd packages/trpc && pnpm vitest run lib/vaultCrypto.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/lib/vaultCrypto.ts packages/trpc/lib/vaultCrypto.test.ts
git commit -m "feat(vault): add vault crypto utilities — AES-256-GCM encrypt/decrypt, PBKDF2 key derivation, signed tokens"
```

---

## Task 2: Database Schema & Zod Types

**Files:**
- Modify: `packages/db/schema.ts` (users table ~line 32, bookmarks table ~line 188, assets table ~line 295)
- Modify: `packages/shared/types/bookmarks.ts` (zBareBookmarkSchema ~line 102, zGetBookmarksRequestSchema ~line 201, zNewBookmarkRequestSchema ~line 156)
- Create: `packages/shared/types/vault.ts`

### Step 2.1: Add vault columns to the schema

- [ ] **Modify `packages/db/schema.ts` — users table**

Add vault columns after the AI settings block (after `curatedTagIds` field, around line 99):

```typescript
  // Vault Settings
  vaultPinHash: text("vaultPinHash"),
  vaultPinSalt: text("vaultPinSalt"),
  vaultEncryptionSalt: text("vaultEncryptionSalt"),
  vaultAutoLockMinutes: integer("vaultAutoLockMinutes").notNull().default(5),
```

- [ ] **Modify `packages/db/schema.ts` — bookmarks table**

Add `vaulted` column after `favourited` (line 201):

```typescript
    vaulted: integer("vaulted", { mode: "boolean" }).notNull().default(false),
```

Add encrypted columns after `note` (around line 213):

```typescript
    encryptedTitle: text("encryptedTitle"),
    encryptedUrl: text("encryptedUrl"),
    encryptedNote: text("encryptedNote"),
```

Add a composite index in the indexes array (after line 245):

```typescript
    index("bookmarks_userId_vaulted_createdAt_id_idx").on(
      b.userId,
      b.vaulted,
      b.createdAt,
      b.id,
    ),
```

- [ ] **Modify `packages/db/schema.ts` — assets table**

Add `encrypted` column after `fileName` (around line 322):

```typescript
    encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
```

- [ ] **Generate migration**

Run: `cd packages/db && pnpm db:generate --name add_vault_columns`
Expected: New migration file created in `packages/db/drizzle/`

- [ ] **Verify migration by running tests**

Run: `cd packages/trpc && pnpm vitest run lib/vaultCrypto.test.ts`
Expected: PASS (schema changes don't break crypto tests; in-memory DB uses schema.ts directly)

### Step 2.2: Add `vaulted` to Zod bookmark schemas

- [ ] **Modify `packages/shared/types/bookmarks.ts` — `zBareBookmarkSchema` (~line 102)**

Add `vaulted` after `favourited`:

```typescript
  vaulted: z.boolean(),
```

So the schema becomes:
```typescript
export const zBareBookmarkSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  modifiedAt: z.date().nullable(),
  title: z.string().nullish(),
  archived: z.boolean(),
  favourited: z.boolean(),
  vaulted: z.boolean(),
  taggingStatus: z.enum(["success", "failure", "pending"]).nullable(),
  // ...rest unchanged
});
```

- [ ] **Modify `packages/shared/types/bookmarks.ts` — `zGetBookmarksRequestSchema` (~line 201)**

Add `vaulted` filter after `favourited`:

```typescript
  vaulted: z.boolean().optional(),
```

- [ ] **Modify `packages/shared/types/bookmarks.ts` — `zNewBookmarkRequestSchema` (~line 156)**

Add `vaulted` option in the common fields object:

```typescript
    vaulted: z.boolean().optional(),
```

- [ ] **Modify `packages/shared/types/bookmarks.ts` — `zUpdateBookmarksRequestSchema` (~line 226)**

Add `vaulted` field:

```typescript
  vaulted: z.boolean().optional(),
```

### Step 2.3: Create vault Zod schemas

- [ ] **Create `packages/shared/types/vault.ts`**

```typescript
// packages/shared/types/vault.ts
import { z } from "zod";

export const zVaultSetupSchema = z.object({
  pin: z.string().min(4).max(64),
});

export const zVaultUnlockSchema = z.object({
  pin: z.string().min(1),
});

export const zVaultChangePinSchema = z.object({
  currentPin: z.string().min(1),
  newPin: z.string().min(4).max(64),
});

export const zVaultUpdateSettingsSchema = z.object({
  autoLockMinutes: z.number().int().refine(
    (v) => [1, 5, 15, 30, 60].includes(v),
    { message: "Auto-lock must be 1, 5, 15, 30, or 60 minutes" },
  ),
});

export const zVaultSettingsSchema = z.object({
  autoLockMinutes: z.number(),
});

export const zVaultDeleteSchema = z.object({
  pin: z.string().min(1),
});

export const zMoveToVaultSchema = z.object({
  bookmarkId: z.string(),
});
```

- [ ] **Commit**

```bash
git add packages/db/schema.ts packages/shared/types/bookmarks.ts packages/shared/types/vault.ts packages/db/drizzle/
git commit -m "feat(vault): add vault database schema, migration, and Zod types"
```

---

## Task 3: tRPC Context Extension

**Files:**
- Modify: `packages/trpc/index.ts` (Context interface ~line 44)
- Modify: `packages/trpc/testUtils.ts` (getApiCaller ~line 36)
- Modify: `apps/web/server/api/client.ts` (createContextFromRequest ~line 10)

### Step 3.1: Extend tRPC context with vaultKey

- [ ] **Modify `packages/trpc/index.ts`**

Add `vaultKey` to `Context` interface (line 44-51):

Replace:
```typescript
export interface Context {
  user: User | null;
  auth?: RequestAuth;
  db: typeof db;
  req: {
    ip: string | null;
  };
}
```

With:
```typescript
export interface Context {
  user: User | null;
  auth?: RequestAuth;
  db: typeof db;
  req: {
    ip: string | null;
  };
  vaultKey: Buffer | null;
}
```

Add `vaultKey` to `AuthedContext` (line 53-60):

Replace:
```typescript
export interface AuthedContext {
  user: User;
  auth?: RequestAuth;
  db: typeof db;
  req: {
    ip: string | null;
  };
}
```

With:
```typescript
export interface AuthedContext {
  user: User;
  auth?: RequestAuth;
  db: typeof db;
  req: {
    ip: string | null;
  };
  vaultKey: Buffer | null;
}
```

### Step 3.2: Update test utilities

- [ ] **Modify `packages/trpc/testUtils.ts` — `getApiCaller` function (line 36-58)**

Add `vaultKey` parameter:

Replace:
```typescript
export function getApiCaller(
  db: TestDB,
  userId?: string,
  email?: string,
  role: "user" | "admin" = "user",
  auth: Context["auth"] = userId ? { type: "session" } : null,
) {
  const createCaller = createCallerFactory(appRouter);
  return createCaller({
    user: userId
      ? {
          id: userId,
          email,
          role,
        }
      : null,
    auth,
    db,
    req: {
      ip: null,
    },
  });
}
```

With:
```typescript
export function getApiCaller(
  db: TestDB,
  userId?: string,
  email?: string,
  role: "user" | "admin" = "user",
  auth: Context["auth"] = userId ? { type: "session" } : null,
  vaultKey: Buffer | null = null,
) {
  const createCaller = createCallerFactory(appRouter);
  return createCaller({
    user: userId
      ? {
          id: userId,
          email,
          role,
        }
      : null,
    auth,
    db,
    req: {
      ip: null,
    },
    vaultKey,
  });
}
```

### Step 3.3: Update web context creation

- [ ] **Modify `apps/web/server/api/client.ts`**

Add import at top:
```typescript
import { verifyVaultToken } from "@karakeep/trpc/lib/vaultCrypto";
import serverConfig from "@karakeep/shared/config";
```

In `createContextFromRequest`, before the return statement (after the auth resolution), add vault token reading:

Replace the entire `createContextFromRequest` function:
```typescript
export async function createContextFromRequest(req: Request) {
  const ip = requestIp.getClientIp({
    headers: Object.fromEntries(req.headers.entries()),
  });
  const authorizationHeader = req.headers.get("Authorization");
  if (authorizationHeader && authorizationHeader.startsWith("Bearer ")) {
    const token = authorizationHeader.split(" ")[1];
    try {
      const authResult = await authenticateApiKey(token, db);
      const vaultKey = extractVaultKey(req, authResult.user.id);
      return {
        user: authResult.user,
        auth: {
          type: "apiKey" as const,
          keyId: authResult.apiKey.keyId,
          scopes: authResult.apiKey.scopes,
        },
        db,
        req: { ip },
        vaultKey,
      };
    } catch {
      // Fallthrough to cookie-based auth
    }
  }

  return createContext(db, ip, req);
}

function extractVaultKey(req: Request, userId: string): Buffer | null {
  const vaultToken = req.headers.get("x-vault-token");
  if (!vaultToken) return null;
  try {
    const result = verifyVaultToken(vaultToken, serverConfig.signingSecret());
    if (result.userId !== userId) return null;
    return result.encryptionKey;
  } catch {
    return null;
  }
}
```

Update `createContext` to accept an optional `req` parameter for vault key extraction:

Replace:
```typescript
export const createContext = async (
  database?: typeof db,
  ip?: string | null,
): Promise<Context> => {
  const session = await getServerAuthSession();
  if (ip === undefined) {
    const hdrs = await headers();
    ip = requestIp.getClientIp({
      headers: Object.fromEntries(hdrs.entries()),
    });
  }
  return {
    user: session?.user ?? null,
    auth: session?.user
      ? {
          type: "session" as const,
        }
      : null,
    db: database ?? db,
    req: {
      ip,
    },
  };
};
```

With:
```typescript
export const createContext = async (
  database?: typeof db,
  ip?: string | null,
  req?: Request,
): Promise<Context> => {
  const session = await getServerAuthSession();
  if (ip === undefined) {
    const hdrs = await headers();
    ip = requestIp.getClientIp({
      headers: Object.fromEntries(hdrs.entries()),
    });
  }
  const userId = session?.user?.id;
  const vaultKey = req && userId ? extractVaultKey(req, userId) : null;
  return {
    user: session?.user ?? null,
    auth: session?.user
      ? {
          type: "session" as const,
        }
      : null,
    db: database ?? db,
    req: {
      ip,
    },
    vaultKey,
  };
};
```

- [ ] **Run typecheck to verify**

Run: `pnpm typecheck`
Expected: Type errors are expected for any code that creates a Context without `vaultKey`. Fix those by adding `vaultKey: null`.

- [ ] **Fix any remaining type errors across the codebase**

Search for other files that construct a `Context` object and add `vaultKey: null`:
- `apps/web/app/api/[[...route]]/route.ts` — context is created via `createContextFromRequest`, already handled
- Any Hono middleware or API package files that create contexts

Run: `grep -rn "createContext\|ctx:" packages/api/src/ --include="*.ts" | head -20`

Fix all context creation sites by adding `vaultKey: null`.

- [ ] **Commit**

```bash
git add packages/trpc/index.ts packages/trpc/testUtils.ts apps/web/server/api/client.ts
git commit -m "feat(vault): extend tRPC context with vaultKey for vault session management"
```

---

## Task 4: Vault tRPC Router — Setup, Unlock, Lock

**Files:**
- Create: `packages/trpc/routers/vault.ts`
- Create: `packages/trpc/routers/vault.test.ts`
- Modify: `packages/trpc/routers/_app.ts`

### Step 4.1: Write tests for vault setup and unlock

- [ ] **Create test file**

```typescript
// packages/trpc/routers/vault.test.ts
import { beforeEach, describe, expect, test, vi } from "vitest";

import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach, getApiCaller } from "../testUtils";
import { verifyVaultToken } from "../lib/vaultCrypto";

vi.mock("@karakeep/shared/config", () => ({
  default: {
    demoMode: false,
    signingSecret: () => "test-secret-that-is-long-enough-for-hmac-signing!!",
  },
}));

vi.mock("@karakeep/shared-server", async (original) => {
  const mod = (await original()) as typeof import("@karakeep/shared-server");
  return {
    ...mod,
    LinkCrawlerQueue: { enqueue: vi.fn() },
    OpenAIQueue: { enqueue: vi.fn() },
    SearchIndexingQueue: { enqueue: vi.fn() },
    RuleEngineQueue: { enqueue: vi.fn() },
    triggerSearchReindex: vi.fn(),
  };
});

beforeEach<CustomTestContext>(defaultBeforeEach(true));

describe("Vault Router", () => {
  const testPin = "123456";

  describe("setup", () => {
    test<CustomTestContext>("sets up vault with a PIN", async ({ apiCallers }) => {
      const isSetupBefore = await apiCallers[0].vault.isSetup();
      expect(isSetupBefore).toBe(false);

      await apiCallers[0].vault.setup({ pin: testPin });

      const isSetupAfter = await apiCallers[0].vault.isSetup();
      expect(isSetupAfter).toBe(true);
    });

    test<CustomTestContext>("rejects setup if vault already exists", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      await expect(
        apiCallers[0].vault.setup({ pin: testPin }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("vaults are per-user", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      const user1Setup = await apiCallers[0].vault.isSetup();
      const user2Setup = await apiCallers[1].vault.isSetup();
      expect(user1Setup).toBe(true);
      expect(user2Setup).toBe(false);
    });
  });

  describe("unlock / lock", () => {
    test<CustomTestContext>("unlock returns a valid token", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      const { token } = await apiCallers[0].vault.unlock({ pin: testPin });
      expect(token).toBeTruthy();
      const decoded = verifyVaultToken(
        token,
        "test-secret-that-is-long-enough-for-hmac-signing!!",
      );
      expect(decoded.userId).toBeTruthy();
      expect(decoded.encryptionKey).toBeInstanceOf(Buffer);
    });

    test<CustomTestContext>("unlock rejects wrong PIN", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      await expect(
        apiCallers[0].vault.unlock({ pin: "wrong-pin" }),
      ).rejects.toThrow(/incorrect/i);
    });

    test<CustomTestContext>("unlock rejects if vault not set up", async ({ apiCallers }) => {
      await expect(
        apiCallers[0].vault.unlock({ pin: testPin }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("isUnlocked returns false without token", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      const unlocked = await apiCallers[0].vault.isUnlocked();
      expect(unlocked).toBe(false);
    });

    test<CustomTestContext>("isUnlocked returns true with valid vaultKey in context", async ({
      apiCallers,
      db,
    }) => {
      const users = await db.query.users.findMany();
      await apiCallers[0].vault.setup({ pin: testPin });
      const { token } = await apiCallers[0].vault.unlock({ pin: testPin });
      const decoded = verifyVaultToken(
        token,
        "test-secret-that-is-long-enough-for-hmac-signing!!",
      );
      const callerWithVault = getApiCaller(
        db,
        users[0].id,
        users[0].email,
        "user",
        { type: "session" },
        decoded.encryptionKey,
      );
      const unlocked = await callerWithVault.vault.isUnlocked();
      expect(unlocked).toBe(true);
    });
  });

  describe("settings", () => {
    test<CustomTestContext>("getSettings returns defaults", async ({ apiCallers }) => {
      const settings = await apiCallers[0].vault.getSettings();
      expect(settings.autoLockMinutes).toBe(5);
    });

    test<CustomTestContext>("updateSettings changes auto-lock timeout", async ({ apiCallers }) => {
      await apiCallers[0].vault.setup({ pin: testPin });
      await apiCallers[0].vault.updateSettings({ autoLockMinutes: 30 });
      const settings = await apiCallers[0].vault.getSettings();
      expect(settings.autoLockMinutes).toBe(30);
    });
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: FAIL — `vault` router not found on `apiCallers[0]`

### Step 4.2: Implement vault router

- [ ] **Create `packages/trpc/routers/vault.ts`**

```typescript
// packages/trpc/routers/vault.ts
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { users } from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import {
  zVaultChangePinSchema,
  zVaultDeleteSchema,
  zVaultSetupSchema,
  zVaultUnlockSchema,
  zVaultUpdateSettingsSchema,
} from "@karakeep/shared/types/vault";

import {
  authedProcedure,
  router,
  sessionProcedure,
} from "../index";
import {
  createVaultToken,
  deriveEncryptionKey,
  generateSalt,
  hashPin,
  verifyPin,
} from "../lib/vaultCrypto";

export const vaultAppRouter = router({
  isSetup: authedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.user.id),
      columns: { vaultPinHash: true },
    });
    return !!user?.vaultPinHash;
  }),

  isUnlocked: authedProcedure.query(({ ctx }) => {
    return ctx.vaultKey !== null;
  }),

  setup: sessionProcedure
    .input(zVaultSetupSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.user.id),
        columns: { vaultPinHash: true },
      });
      if (user?.vaultPinHash) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault is already set up",
        });
      }

      const { hash: pinHash, salt: pinSalt } = await hashPin(input.pin);
      const encryptionSalt = generateSalt();

      await ctx.db
        .update(users)
        .set({
          vaultPinHash: pinHash,
          vaultPinSalt: pinSalt,
          vaultEncryptionSalt: encryptionSalt,
        })
        .where(eq(users.id, ctx.user.id));
    }),

  unlock: sessionProcedure
    .input(zVaultUnlockSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.user.id),
        columns: {
          vaultPinHash: true,
          vaultPinSalt: true,
          vaultEncryptionSalt: true,
          vaultAutoLockMinutes: true,
        },
      });

      if (!user?.vaultPinHash || !user.vaultPinSalt || !user.vaultEncryptionSalt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault is not set up",
        });
      }

      const valid = await verifyPin(input.pin, user.vaultPinHash, user.vaultPinSalt);
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Incorrect PIN",
        });
      }

      const encryptionKey = await deriveEncryptionKey(
        input.pin,
        user.vaultEncryptionSalt,
      );

      const token = createVaultToken(
        { userId: ctx.user.id, encryptionKey },
        serverConfig.signingSecret(),
        user.vaultAutoLockMinutes,
      );

      return { token };
    }),

  getSettings: authedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.user.id),
      columns: { vaultAutoLockMinutes: true },
    });
    return { autoLockMinutes: user?.vaultAutoLockMinutes ?? 5 };
  }),

  updateSettings: sessionProcedure
    .input(zVaultUpdateSettingsSchema)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(users)
        .set({ vaultAutoLockMinutes: input.autoLockMinutes })
        .where(eq(users.id, ctx.user.id));
    }),
});
```

- [ ] **Register the vault router in `packages/trpc/routers/_app.ts`**

Add import:
```typescript
import { vaultAppRouter } from "./vault";
```

Add to the router object:
```typescript
  vault: vaultAppRouter,
```

- [ ] **Run tests to verify they pass**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/routers/vault.ts packages/trpc/routers/vault.test.ts packages/trpc/routers/_app.ts
git commit -m "feat(vault): add vault tRPC router with setup, unlock, lock, and settings"
```

---

## Task 5: Filter Vaulted Bookmarks from All Queries

**Files:**
- Modify: `packages/trpc/models/bookmarks.ts` (~line 462 `buildCommonFilters`)
- Modify: `packages/trpc/routers/bookmarks.ts` (getBookmarks, search)
- Add tests to: `packages/trpc/routers/vault.test.ts`

### Step 5.1: Write tests for vaulted bookmark filtering

- [ ] **Append tests to `packages/trpc/routers/vault.test.ts`**

```typescript
describe("Vault Bookmark Filtering", () => {
  test<CustomTestContext>("vaulted bookmarks are excluded from getBookmarks by default", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    // Create two bookmarks
    await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "normal bookmark",
    });
    await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "will be vaulted",
    });

    // Both visible before vaulting
    const beforeVault = await api.bookmarks.getBookmarks({});
    expect(beforeVault.bookmarks).toHaveLength(2);

    // Manually set one as vaulted (simulating moveToVault)
    const bookmarkToVault = beforeVault.bookmarks[0];
    await db
      .update(bookmarks)
      .set({ vaulted: true })
      .where(eq(bookmarks.id, bookmarkToVault.id));

    // Only non-vaulted visible
    const afterVault = await api.bookmarks.getBookmarks({});
    expect(afterVault.bookmarks).toHaveLength(1);
  });

  test<CustomTestContext>("vaulted bookmarks visible when explicitly requested with vault access", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "vaulted text",
    });

    const all = await api.bookmarks.getBookmarks({});
    await db
      .update(bookmarks)
      .set({ vaulted: true })
      .where(eq(bookmarks.id, all.bookmarks[0].id));

    // With vaulted: true filter and vault key in context
    await api.vault.setup({ pin: "123456" });
    const { token } = await api.vault.unlock({ pin: "123456" });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db,
      users[0].id,
      users[0].email,
      "user",
      { type: "session" },
      decoded.encryptionKey,
    );
    const vaulted = await vaultCaller.bookmarks.getBookmarks({ vaulted: true });
    expect(vaulted.bookmarks).toHaveLength(1);
  });
});
```

Add necessary import at top of test file:
```typescript
import { eq } from "drizzle-orm";
import { bookmarks } from "@karakeep/db/schema";
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: FAIL — vaulted bookmarks still appear in results (filter not yet implemented)

### Step 5.2: Add vaulted filter to `buildCommonFilters`

- [ ] **Modify `packages/trpc/models/bookmarks.ts` — `buildCommonFilters` (~line 462)**

Replace:
```typescript
    const buildCommonFilters = (): (SQL | undefined)[] => [
      input.archived !== undefined
        ? eq(bookmarks.archived, input.archived)
        : undefined,
      input.favourited !== undefined
        ? eq(bookmarks.favourited, input.favourited)
        : undefined,
      input.ids ? inArray(bookmarks.id, input.ids) : undefined,
    ];
```

With:
```typescript
    const buildCommonFilters = (): (SQL | undefined)[] => [
      input.archived !== undefined
        ? eq(bookmarks.archived, input.archived)
        : undefined,
      input.favourited !== undefined
        ? eq(bookmarks.favourited, input.favourited)
        : undefined,
      input.vaulted !== undefined
        ? eq(bookmarks.vaulted, input.vaulted)
        : eq(bookmarks.vaulted, false),
      input.ids ? inArray(bookmarks.id, input.ids) : undefined,
    ];
```

Key difference from `archived`: vaulted defaults to `false` when not specified (always exclude vaulted bookmarks), whereas `archived` defaults to undefined (include both).

- [ ] **Run tests to verify they pass**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: All tests PASS

- [ ] **Run existing bookmark tests to verify no regressions**

Run: `cd packages/trpc && pnpm vitest run routers/bookmarks.test.ts`
Expected: All existing tests PASS (the default `vaulted: false` filter doesn't affect existing queries since all bookmarks default to `vaulted = false`)

- [ ] **Commit**

```bash
git add packages/trpc/models/bookmarks.ts packages/trpc/routers/vault.test.ts
git commit -m "feat(vault): filter vaulted bookmarks from all queries by default"
```

---

## Task 6: Move Bookmark to Vault (Encryption)

**Files:**
- Modify: `packages/trpc/routers/bookmarks.ts` (add `moveToVault` mutation)
- Add tests to: `packages/trpc/routers/vault.test.ts`

### Step 6.1: Write tests for moveToVault

- [ ] **Append tests to `packages/trpc/routers/vault.test.ts`**

```typescript
describe("Move to Vault", () => {
  test<CustomTestContext>("moves a text bookmark to the vault and encrypts content", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    // Setup vault and unlock
    await api.vault.setup({ pin: "123456" });
    const { token } = await api.vault.unlock({ pin: "123456" });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db,
      users[0].id,
      users[0].email,
      "user",
      { type: "session" },
      decoded.encryptionKey,
    );

    // Create bookmark
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "secret note content",
      title: "Secret Note",
    });

    // Move to vault
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Not visible in normal queries
    const normal = await api.bookmarks.getBookmarks({});
    expect(normal.bookmarks).toHaveLength(0);

    // Visible and decrypted in vault queries
    const vaulted = await vaultCaller.bookmarks.getBookmarks({ vaulted: true });
    expect(vaulted.bookmarks).toHaveLength(1);
    expect(vaulted.bookmarks[0].title).toBe("Secret Note");

    // Verify raw DB has encrypted data (title column is null, encryptedTitle has ciphertext)
    const rawBookmark = await db.query.bookmarks.findFirst({
      where: eq(bookmarks.id, bookmark.id),
    });
    expect(rawBookmark?.title).toBeNull();
    expect(rawBookmark?.encryptedTitle).toBeTruthy();
    expect(rawBookmark?.encryptedTitle).not.toBe("Secret Note");
    expect(rawBookmark?.vaulted).toBe(true);
  });

  test<CustomTestContext>("moveToVault fails without vault access", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    await api.vault.setup({ pin: "123456" });

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "test",
    });

    // No vault key in context
    await expect(
      api.bookmarks.moveToVault({ bookmarkId: bookmark.id }),
    ).rejects.toThrow(/vault is locked/i);
  });

  test<CustomTestContext>("moveToVault is irreversible — no unvault", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    await api.vault.setup({ pin: "123456" });
    const { token } = await api.vault.unlock({ pin: "123456" });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db,
      users[0].id,
      users[0].email,
      "user",
      { type: "session" },
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "locked forever",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Attempting to set vaulted=false via update should fail
    await expect(
      vaultCaller.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        vaulted: false,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: FAIL — `moveToVault` not defined on bookmarks router

### Step 6.2: Implement moveToVault mutation

- [ ] **Modify `packages/trpc/routers/bookmarks.ts`**

Add imports at top:
```typescript
import {
  encryptText,
} from "../lib/vaultCrypto";
import { zMoveToVaultSchema } from "@karakeep/shared/types/vault";
```

Add the `moveToVault` procedure to the `bookmarksAppRouter` (near other mutations like `updateBookmark`):

```typescript
  moveToVault: bookmarksProcedure
    .input(zMoveToVaultSchema)
    .use(ensureBookmarkOwnership)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.vaultKey) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Vault is locked",
        });
      }

      const bookmark = await ctx.db.query.bookmarks.findFirst({
        where: eq(bookmarks.id, input.bookmarkId),
        with: { link: true, text: true },
      });

      if (!bookmark) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bookmark not found" });
      }

      if (bookmark.vaulted) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Bookmark is already in the vault",
        });
      }

      const key = ctx.vaultKey;

      await ctx.db.transaction(async (tx) => {
        // Encrypt and null out bookmark-level fields
        const encryptedTitle = bookmark.title
          ? encryptText(bookmark.title, key)
          : null;
        const encryptedNote = bookmark.note
          ? encryptText(bookmark.note, key)
          : null;

        await tx
          .update(bookmarks)
          .set({
            vaulted: true,
            title: null,
            note: null,
            summary: null,
            encryptedTitle,
            encryptedNote,
            taggingStatus: null,
            summarizationStatus: null,
          })
          .where(eq(bookmarks.id, input.bookmarkId));

        // Encrypt link URL if it's a link bookmark
        if (bookmark.link) {
          const encryptedUrl = encryptText(bookmark.link.url, key);
          await tx
            .update(bookmarkLinks)
            .set({
              url: encryptedUrl,
              title: null,
              description: null,
              imageUrl: null,
              favicon: null,
              htmlContent: null,
              author: null,
              publisher: null,
            })
            .where(eq(bookmarkLinks.id, input.bookmarkId));
        }

        // Encrypt text content if it's a text bookmark
        if (bookmark.text?.text) {
          const encryptedText = encryptText(bookmark.text.text, key);
          await tx
            .update(bookmarkTexts)
            .set({ text: encryptedText })
            .where(eq(bookmarkTexts.id, input.bookmarkId));
        }

        // Encrypt associated assets
        const bookmarkAssetRecords = await tx.query.assets.findMany({
          where: eq(assets.bookmarkId, input.bookmarkId),
        });
        for (const asset of bookmarkAssetRecords) {
          try {
            const { asset: assetBuffer } = await readAsset({
              userId: ctx.user.id,
              assetId: asset.id,
            });
            const encryptedBuffer = encryptBuffer(assetBuffer, key);
            await saveAsset({
              userId: ctx.user.id,
              assetId: asset.id,
              asset: encryptedBuffer,
              metadata: {
                contentType: asset.contentType ?? "application/octet-stream",
                fileName: asset.fileName ?? asset.id,
              },
              quotaApproved: true,
            });
            await tx
              .update(assets)
              .set({ encrypted: true })
              .where(eq(assets.id, asset.id));
          } catch {
            // Asset may not exist on disk yet (pending crawl)
          }
        }

        // Remove from tag associations (vaulted bookmarks have no tags)
        await tx
          .delete(tagsOnBookmarks)
          .where(eq(tagsOnBookmarks.bookmarkId, input.bookmarkId));

        // Remove from lists
        await tx
          .delete(bookmarksInLists)
          .where(eq(bookmarksInLists.bookmarkId, input.bookmarkId));
      });

      // Remove from search index
      SearchIndexingQueue.enqueue({
        bookmarkId: input.bookmarkId,
        type: "delete",
      });
    }),
```

Add necessary imports to `bookmarks.ts` if not already present:
```typescript
import { encryptBuffer } from "../lib/vaultCrypto";
import { readAsset, saveAsset } from "@karakeep/shared/assetdb";
import { assets, bookmarksInLists } from "@karakeep/db/schema";
```

- [ ] **Prevent un-vaulting via updateBookmark**

In the `updateBookmark` mutation (around where it processes `input.archived`), add a check:

```typescript
      if (input.vaulted === false) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Bookmarks cannot be removed from the vault",
        });
      }
```

- [ ] **Run tests**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/routers/bookmarks.ts packages/trpc/routers/vault.test.ts
git commit -m "feat(vault): add moveToVault mutation with text and asset encryption"
```

---

## Task 7: Decrypt Vaulted Bookmarks on Read

**Files:**
- Modify: `packages/trpc/models/bookmarks.ts` (~line 151 `toZodSchema`)
- Modify: `packages/trpc/routers/bookmarks.ts` (getBookmarks, getBookmark)
- Add tests to: `packages/trpc/routers/vault.test.ts`

### Step 7.1: Write tests for decryption on read

- [ ] **Append to `packages/trpc/routers/vault.test.ts`**

```typescript
describe("Decrypt on Read", () => {
  test<CustomTestContext>("vaulted link bookmark URL is decrypted when vault is unlocked", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    await api.vault.setup({ pin: "123456" });
    const { token } = await api.vault.unlock({ pin: "123456" });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db,
      users[0].id,
      users[0].email,
      "user",
      { type: "session" },
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url: "https://secret-site.com/page",
      title: "Secret Page",
    });

    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    const vaulted = await vaultCaller.bookmarks.getBookmarks({
      vaulted: true,
      includeContent: true,
    });
    expect(vaulted.bookmarks).toHaveLength(1);

    const b = vaulted.bookmarks[0];
    expect(b.title).toBe("Secret Page");
    if (b.content.type === BookmarkTypes.LINK) {
      expect(b.content.url).toBe("https://secret-site.com/page");
    }
  });

  test<CustomTestContext>("getBookmark on vaulted bookmark fails without vault access", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    await api.vault.setup({ pin: "123456" });
    const { token } = await api.vault.unlock({ pin: "123456" });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db,
      users[0].id,
      users[0].email,
      "user",
      { type: "session" },
      decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "secret",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Without vault key — should deny access
    await expect(
      api.bookmarks.getBookmark({ bookmarkId: bookmark.id }),
    ).rejects.toThrow(/forbidden|vault/i);
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: FAIL — decrypted content is ciphertext, not plaintext; getBookmark doesn't block vaulted access

### Step 7.2: Add vault access check to getBookmark

- [ ] **Modify `packages/trpc/routers/bookmarks.ts` — `getBookmark` procedure**

After fetching the bookmark and before returning, add:

```typescript
      // Block access to vaulted bookmarks without vault key
      if (bookmark.vaulted && !ctx.vaultKey) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Vault is locked",
        });
      }
```

### Step 7.3: Add decryption to `toZodSchema`

- [ ] **Modify `packages/trpc/models/bookmarks.ts` — `toZodSchema` method (~line 151)**

Change the signature to accept a vault key:

Replace:
```typescript
  private static async toZodSchema(
    bookmark: BookmarkQueryReturnType,
    includeContent: boolean,
  ): Promise<ZBookmark> {
```

With:
```typescript
  private static async toZodSchema(
    bookmark: BookmarkQueryReturnType,
    includeContent: boolean,
    vaultKey: Buffer | null = null,
  ): Promise<ZBookmark> {
```

At the beginning of `toZodSchema`, add decryption logic:

```typescript
    // Decrypt vaulted bookmark fields
    let decryptedTitle = rest.title;
    let decryptedNote = rest.note;

    if (bookmark.vaulted && vaultKey) {
      const { decryptText } = await import("../lib/vaultCrypto");
      if (bookmark.encryptedTitle) {
        decryptedTitle = decryptText(bookmark.encryptedTitle, vaultKey);
      }
      if (bookmark.encryptedNote) {
        decryptedNote = decryptText(bookmark.encryptedNote, vaultKey);
      }
    }
```

In the link content builder, decrypt the URL:

Replace:
```typescript
        url: link.url,
```

With:
```typescript
        url: bookmark.vaulted && vaultKey
          ? (() => {
              const { decryptText } = require("../lib/vaultCrypto");
              return decryptText(link.url, vaultKey);
            })()
          : link.url,
```

Actually, a cleaner approach — use `await import` at the top of the function, then use inline:

Add after the destructuring of `bookmark`:
```typescript
    const decrypt = bookmark.vaulted && vaultKey
      ? (await import("../lib/vaultCrypto")).decryptText
      : null;
```

Then use it:
- For title: `decryptedTitle = decrypt && bookmark.encryptedTitle ? decrypt(bookmark.encryptedTitle, vaultKey!) : rest.title;`
- For note: `decryptedNote = decrypt && bookmark.encryptedNote ? decrypt(bookmark.encryptedNote, vaultKey!) : rest.note;`
- For link URL: `url: decrypt ? decrypt(link.url, vaultKey!) : link.url,`
- For text content: `text: decrypt ? decrypt(text.text ?? "", vaultKey!) : text.text ?? "",`

In the return object, replace `...rest` title and note:
```typescript
    return {
      tags: ...,
      content,
      assets: ...,
      ...rest,
      title: decryptedTitle,
      note: decryptedNote,
    };
```

- [ ] **Update all call sites of `toZodSchema` to pass `vaultKey`**

In `Bookmark.fromId()`:
```typescript
    return new Bookmark(
      ctx,
      await Bookmark.toZodSchema(bookmark, includeContent, ctx.vaultKey),
    );
```

In `Bookmark.loadMulti()` (the mapping loop):
```typescript
    const bookmarkPromises = bookmarks.map((b) =>
      Bookmark.toZodSchema(b, input.includeContent, ctx.vaultKey),
    );
```

- [ ] **Run tests**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: All tests PASS

- [ ] **Run bookmark tests to verify no regressions**

Run: `cd packages/trpc && pnpm vitest run routers/bookmarks.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/models/bookmarks.ts packages/trpc/routers/bookmarks.ts packages/trpc/routers/vault.test.ts
git commit -m "feat(vault): decrypt vaulted bookmarks on read, block access without vault key"
```

---

## Task 8: Change PIN & Delete Vault

**Files:**
- Modify: `packages/trpc/routers/vault.ts`
- Add tests to: `packages/trpc/routers/vault.test.ts`

### Step 8.1: Write tests

- [ ] **Append tests to `packages/trpc/routers/vault.test.ts`**

```typescript
describe("Change PIN", () => {
  test<CustomTestContext>("re-encrypts all vault content with new key", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];
    const oldPin = "123456";
    const newPin = "654321";

    // Setup and create vaulted bookmark
    await api.vault.setup({ pin: oldPin });
    const { token } = await api.vault.unlock({ pin: oldPin });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db, users[0].id, users[0].email, "user",
      { type: "session" }, decoded.encryptionKey,
    );

    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "secret data",
      title: "Secret Title",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Change PIN
    await vaultCaller.vault.changePin({ currentPin: oldPin, newPin });

    // Old PIN no longer works
    await expect(api.vault.unlock({ pin: oldPin })).rejects.toThrow(/incorrect/i);

    // New PIN works and content is readable
    const { token: newToken } = await api.vault.unlock({ pin: newPin });
    const newDecoded = verifyVaultToken(
      newToken,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const newVaultCaller = getApiCaller(
      db, users[0].id, users[0].email, "user",
      { type: "session" }, newDecoded.encryptionKey,
    );

    const vaulted = await newVaultCaller.bookmarks.getBookmarks({ vaulted: true });
    expect(vaulted.bookmarks).toHaveLength(1);
    expect(vaulted.bookmarks[0].title).toBe("Secret Title");
  });
});

describe("Delete Vault", () => {
  test<CustomTestContext>("deletes all vaulted bookmarks and clears vault settings", async ({
    apiCallers,
    db,
  }) => {
    const users = await db.query.users.findMany();
    const api = apiCallers[0];

    await api.vault.setup({ pin: "123456" });
    const { token } = await api.vault.unlock({ pin: "123456" });
    const decoded = verifyVaultToken(
      token,
      "test-secret-that-is-long-enough-for-hmac-signing!!",
    );
    const vaultCaller = getApiCaller(
      db, users[0].id, users[0].email, "user",
      { type: "session" }, decoded.encryptionKey,
    );

    // Create and vault a bookmark
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "to be deleted",
    });
    await vaultCaller.bookmarks.moveToVault({ bookmarkId: bookmark.id });

    // Delete vault
    await vaultCaller.vault.deleteVault({ pin: "123456" });

    // Vault is no longer set up
    expect(await api.vault.isSetup()).toBe(false);

    // Vaulted bookmarks are gone
    const all = await api.bookmarks.getBookmarks({});
    expect(all.bookmarks).toHaveLength(0);
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: FAIL — `changePin` and `deleteVault` not defined

### Step 8.2: Implement changePin and deleteVault

- [ ] **Add to `packages/trpc/routers/vault.ts`**

```typescript
  changePin: sessionProcedure
    .input(zVaultChangePinSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.vaultKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Vault is locked" });
      }

      const user = await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.user.id),
        columns: {
          vaultPinHash: true,
          vaultPinSalt: true,
          vaultEncryptionSalt: true,
        },
      });

      if (!user?.vaultPinHash || !user.vaultPinSalt || !user.vaultEncryptionSalt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Vault is not set up" });
      }

      const valid = await verifyPin(input.currentPin, user.vaultPinHash, user.vaultPinSalt);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Incorrect current PIN" });
      }

      const oldKey = ctx.vaultKey;
      const newEncryptionSalt = generateSalt();
      const newKey = await deriveEncryptionKey(input.newPin, newEncryptionSalt);
      const { hash: newPinHash, salt: newPinSalt } = await hashPin(input.newPin);

      const { encryptText, decryptText, encryptBuffer, decryptBuffer } =
        await import("../lib/vaultCrypto");

      await ctx.db.transaction(async (tx) => {
        // Re-encrypt all vaulted bookmarks
        const vaultedBookmarks = await tx.query.bookmarks.findMany({
          where: and(
            eq(bookmarks.userId, ctx.user.id),
            eq(bookmarks.vaulted, true),
          ),
          with: { link: true, text: true },
        });

        for (const bookmark of vaultedBookmarks) {
          const updates: Record<string, string | null> = {};

          if (bookmark.encryptedTitle) {
            const plain = decryptText(bookmark.encryptedTitle, oldKey);
            updates.encryptedTitle = encryptText(plain, newKey);
          }
          if (bookmark.encryptedNote) {
            const plain = decryptText(bookmark.encryptedNote, oldKey);
            updates.encryptedNote = encryptText(plain, newKey);
          }

          if (Object.keys(updates).length > 0) {
            await tx
              .update(bookmarks)
              .set(updates)
              .where(eq(bookmarks.id, bookmark.id));
          }

          // Re-encrypt link URL
          if (bookmark.link) {
            const plainUrl = decryptText(bookmark.link.url, oldKey);
            await tx
              .update(bookmarkLinks)
              .set({ url: encryptText(plainUrl, newKey) })
              .where(eq(bookmarkLinks.id, bookmark.id));
          }

          // Re-encrypt text content
          if (bookmark.text?.text) {
            const plainText = decryptText(bookmark.text.text, oldKey);
            await tx
              .update(bookmarkTexts)
              .set({ text: encryptText(plainText, newKey) })
              .where(eq(bookmarkTexts.id, bookmark.id));
          }

          // Re-encrypt assets
          const assetRecords = await tx.query.assets.findMany({
            where: and(
              eq(assets.bookmarkId, bookmark.id),
              eq(assets.encrypted, true),
            ),
          });
          for (const asset of assetRecords) {
            try {
              const { asset: buf } = await readAsset({
                userId: ctx.user.id,
                assetId: asset.id,
              });
              const plainBuf = decryptBuffer(buf, oldKey);
              const reEncrypted = encryptBuffer(plainBuf, newKey);
              await saveAsset({
                userId: ctx.user.id,
                assetId: asset.id,
                asset: reEncrypted,
                metadata: {
                  contentType: asset.contentType ?? "application/octet-stream",
                  fileName: asset.fileName ?? asset.id,
                },
                quotaApproved: true,
              });
            } catch {
              // Asset may not exist
            }
          }
        }

        // Update user vault credentials
        await tx
          .update(users)
          .set({
            vaultPinHash: newPinHash,
            vaultPinSalt: newPinSalt,
            vaultEncryptionSalt: newEncryptionSalt,
          })
          .where(eq(users.id, ctx.user.id));
      });
    }),

  deleteVault: sessionProcedure
    .input(zVaultDeleteSchema)
    .mutation(async ({ input, ctx }) => {
      const user = await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.user.id),
        columns: { vaultPinHash: true, vaultPinSalt: true },
      });

      if (!user?.vaultPinHash || !user.vaultPinSalt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Vault is not set up" });
      }

      const valid = await verifyPin(input.pin, user.vaultPinHash, user.vaultPinSalt);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Incorrect PIN" });
      }

      await ctx.db.transaction(async (tx) => {
        // Delete all vaulted bookmarks (cascade deletes links, texts, assets, tags)
        const vaultedBookmarks = await tx.query.bookmarks.findMany({
          where: and(
            eq(bookmarks.userId, ctx.user.id),
            eq(bookmarks.vaulted, true),
          ),
          columns: { id: true },
          with: { assets: true },
        });

        for (const bookmark of vaultedBookmarks) {
          // Clean up asset files
          for (const asset of bookmark.assets) {
            try {
              await deleteAsset({ userId: ctx.user.id, assetId: asset.id });
            } catch {
              // Asset may not exist
            }
          }

          // Delete from search index
          SearchIndexingQueue.enqueue({
            bookmarkId: bookmark.id,
            type: "delete",
          });
        }

        // Delete all vaulted bookmarks from DB
        await tx
          .delete(bookmarks)
          .where(
            and(
              eq(bookmarks.userId, ctx.user.id),
              eq(bookmarks.vaulted, true),
            ),
          );

        // Clear vault settings
        await tx
          .update(users)
          .set({
            vaultPinHash: null,
            vaultPinSalt: null,
            vaultEncryptionSalt: null,
            vaultAutoLockMinutes: 5,
          })
          .where(eq(users.id, ctx.user.id));
      });
    }),
```

Add required imports to `vault.ts`:
```typescript
import { and } from "drizzle-orm";
import {
  assets,
  bookmarkLinks,
  bookmarks,
  bookmarkTexts,
} from "@karakeep/db/schema";
import { deleteAsset, readAsset, saveAsset } from "@karakeep/shared/assetdb";
import { SearchIndexingQueue } from "@karakeep/shared-server";
import {
  encryptText,
  decryptText,
  encryptBuffer,
  decryptBuffer,
} from "../lib/vaultCrypto";
```

- [ ] **Run tests**

Run: `cd packages/trpc && pnpm vitest run routers/vault.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add packages/trpc/routers/vault.ts packages/trpc/routers/vault.test.ts
git commit -m "feat(vault): add changePin with re-encryption and deleteVault with cleanup"
```

---

## Task 9: Search Index Exclusion

**Files:**
- Modify: `apps/workers/workers/searchWorker.ts`

### Step 9.1: Exclude vaulted bookmarks from search index

- [ ] **Modify search indexing worker**

In `apps/workers/workers/searchWorker.ts`, in the `runIndex()` function, after fetching the bookmark from the database, add:

```typescript
    // Don't index vaulted bookmarks — they should be invisible to search
    if (bookmark.vaulted) {
      await runDelete(bookmarkId, batch);
      return;
    }
```

This ensures:
- When a bookmark is created normally and then moved to vault, the search entry is deleted (handled by `moveToVault` calling `SearchIndexingQueue.enqueue({ type: "delete" })`)
- If a re-index is triggered for some reason, vaulted bookmarks are skipped

- [ ] **Commit**

```bash
git add apps/workers/workers/searchWorker.ts
git commit -m "feat(vault): exclude vaulted bookmarks from search index"
```

---

## Task 10: i18n Translations

**Files:**
- Modify: `apps/web/lib/i18n/locales/en/translation.json`

### Step 10.1: Add vault translation keys

- [ ] **Add keys to English translation file**

Add a `vault` section and related keys:

```json
  "vault": {
    "title": "Vault",
    "locked": "Vault is locked",
    "unlock": "Unlock Vault",
    "lock": "Lock Vault",
    "enter_pin": "Enter your vault PIN",
    "pin_placeholder": "PIN",
    "incorrect_pin": "Incorrect PIN",
    "setup_title": "Set Up Vault",
    "setup_description": "Create a PIN to protect your most sensitive bookmarks. Bookmarks moved to the vault are encrypted and hidden from all views.",
    "setup_pin_label": "Choose a PIN",
    "setup_confirm_label": "Confirm PIN",
    "setup_warning": "If you forget your PIN, your vault data cannot be recovered.",
    "setup_button": "Create Vault",
    "settings_title": "Vault",
    "auto_lock_label": "Auto-lock after",
    "auto_lock_minutes": "{count} minutes",
    "auto_lock_minute": "1 minute",
    "change_pin": "Change PIN",
    "change_pin_current": "Current PIN",
    "change_pin_new": "New PIN",
    "change_pin_confirm": "Confirm new PIN",
    "delete_vault": "Delete Vault",
    "delete_vault_warning": "This will permanently delete all bookmarks in the vault. This action cannot be undone.",
    "delete_vault_confirm": "Enter your PIN to confirm deletion",
    "move_to_vault": "Move to Vault",
    "move_to_vault_confirm": "This bookmark will be permanently moved to the vault. This cannot be undone.",
    "move_to_vault_unlock_first": "Unlock your vault first to move this bookmark.",
    "auto_lock_timer": "Locks in {time}",
    "empty": "Your vault is empty",
    "empty_description": "Move bookmarks here to encrypt and hide them from all views.",
    "pins_dont_match": "PINs don't match"
  }
```

Also add to the `common` section:
```json
  "vault": "Vault"
```

- [ ] **Commit**

```bash
git add apps/web/lib/i18n/locales/en/translation.json
git commit -m "feat(vault): add English translation keys for vault feature"
```

---

## Task 11: Web UI — Vault Provider (React Context)

**Files:**
- Create: `apps/web/components/dashboard/vault/VaultProvider.tsx`

### Step 11.1: Create VaultProvider

- [ ] **Create the React context for vault state**

```typescript
// apps/web/components/dashboard/vault/VaultProvider.tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface VaultContextType {
  isUnlocked: boolean;
  token: string | null;
  unlock: (token: string, autoLockMinutes: number) => void;
  lock: () => void;
  timeRemaining: number | null;
}

const VaultContext = createContext<VaultContextType>({
  isUnlocked: false,
  token: null,
  unlock: () => {},
  lock: () => {},
  timeRemaining: null,
});

export function useVault() {
  return useContext(VaultContext);
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const lock = useCallback(() => {
    setToken(null);
    setExpiresAt(null);
    setTimeRemaining(null);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const unlock = useCallback(
    (newToken: string, autoLockMinutes: number) => {
      setToken(newToken);
      const exp = Date.now() + autoLockMinutes * 60 * 1000;
      setExpiresAt(exp);
      setTimeRemaining(autoLockMinutes * 60);

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        const remaining = Math.max(0, Math.floor((exp - Date.now()) / 1000));
        setTimeRemaining(remaining);
        if (remaining <= 0) {
          lock();
        }
      }, 1000);
    },
    [lock],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <VaultContext.Provider
      value={{
        isUnlocked: token !== null,
        token,
        unlock,
        lock,
        timeRemaining,
      }}
    >
      {children}
    </VaultContext.Provider>
  );
}
```

- [ ] **Wire VaultProvider into the dashboard layout**

In `apps/web/app/dashboard/layout.tsx`, wrap the content with `VaultProvider`. Import and add it as a wrapper around the existing providers:

```typescript
import { VaultProvider } from "@/components/dashboard/vault/VaultProvider";
```

Add `<VaultProvider>` around the children in the layout (inside or alongside the existing context providers).

- [ ] **Configure tRPC client to include vault token header**

Find the tRPC client configuration file (likely in `apps/web/lib/trpc.ts` or similar). Add a custom header link that injects `x-vault-token`:

This depends on how the tRPC client is set up. The vault token needs to be accessible from the tRPC link. Since `useVault()` is a React hook, and tRPC links are configured outside React, use a module-level variable:

```typescript
// apps/web/lib/vaultToken.ts
let vaultToken: string | null = null;

export function setVaultToken(token: string | null) {
  vaultToken = token;
}

export function getVaultToken(): string | null {
  return vaultToken;
}
```

In `VaultProvider`, sync the token:
```typescript
import { setVaultToken } from "@/lib/vaultToken";

// In unlock callback:
setVaultToken(newToken);

// In lock callback:
setVaultToken(null);
```

In the tRPC client setup, add the header:
```typescript
import { getVaultToken } from "@/lib/vaultToken";

// In the httpBatchLink or similar:
headers() {
  const vaultToken = getVaultToken();
  return vaultToken ? { "x-vault-token": vaultToken } : {};
}
```

- [ ] **Commit**

```bash
git add apps/web/components/dashboard/vault/VaultProvider.tsx apps/web/lib/vaultToken.ts apps/web/app/dashboard/layout.tsx
git commit -m "feat(vault): add VaultProvider React context and vault token header injection"
```

---

## Task 12: Web UI — Vault Page

**Files:**
- Create: `apps/web/app/dashboard/vault/page.tsx`
- Create: `apps/web/components/dashboard/vault/VaultUnlockForm.tsx`
- Create: `apps/web/components/dashboard/vault/VaultContent.tsx`

### Step 12.1: Create PIN entry form

- [ ] **Create VaultUnlockForm**

```typescript
// apps/web/components/dashboard/vault/VaultUnlockForm.tsx
"use client";

import { useState } from "react";
import { useTranslation } from "@/lib/i18n/client";
import { Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useVault } from "./VaultProvider";
import { api } from "@/lib/trpc";

export function VaultUnlockForm() {
  const { t } = useTranslation();
  const { unlock } = useVault();
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);

  const unlockMutation = api.vault.unlock.useMutation({
    onSuccess: async (data) => {
      const settings = await settingsQuery.refetch();
      unlock(data.token, settings.data?.autoLockMinutes ?? 5);
      setPin("");
    },
    onError: () => {
      toast.error(t("vault.incorrect_pin"));
      setPin("");
    },
    onSettled: () => setLoading(false),
  });

  const settingsQuery = api.vault.getSettings.useQuery();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    setLoading(true);
    unlockMutation.mutate({ pin });
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col items-center gap-6"
      >
        <Lock className="text-muted-foreground size-12" />
        <p className="text-muted-foreground text-lg">{t("vault.locked")}</p>
        <Input
          type="password"
          placeholder={t("vault.pin_placeholder")}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="text-center text-lg tracking-widest"
          autoFocus
        />
        <Button type="submit" disabled={loading || !pin.trim()} className="w-full">
          {t("vault.unlock")}
        </Button>
      </form>
    </div>
  );
}
```

### Step 12.2: Create vault content (unlocked view)

- [ ] **Create VaultContent**

```typescript
// apps/web/components/dashboard/vault/VaultContent.tsx
"use client";

import { useTranslation } from "@/lib/i18n/client";
import { Lock, LockOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { UpdatableBookmarksGrid } from "@/components/dashboard/bookmarks/UpdatableBookmarksGrid";
import { useVault } from "./VaultProvider";
import { api } from "@/lib/trpc";

export function VaultContent() {
  const { t } = useTranslation();
  const { lock, timeRemaining } = useVault();

  const bookmarksQuery = api.bookmarks.getBookmarks.useInfiniteQuery(
    { vaulted: true },
    { getNextPageParam: (lastPage) => lastPage.nextCursor },
  );

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <p className="text-2xl">{t("vault.title")}</p>
          <LockOpen className="my-auto size-5" />
          <InfoTooltip size={17} className="my-auto" variant="explain">
            <p>{t("vault.move_to_vault_confirm")}</p>
          </InfoTooltip>
        </div>
        <div className="flex items-center gap-3">
          {timeRemaining !== null && (
            <span className="text-muted-foreground text-sm">
              {t("vault.auto_lock_timer", { time: formatTime(timeRemaining) })}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={lock}>
            <Lock className="mr-1 size-4" />
            {t("vault.lock")}
          </Button>
        </div>
      </div>
      <Separator />
      <UpdatableBookmarksGrid
        query={{ vaulted: true }}
        bookmarks={{
          bookmarks: bookmarksQuery.data?.pages.flatMap((p) => p.bookmarks) ?? [],
          nextCursor: bookmarksQuery.data?.pages.at(-1)?.nextCursor ?? null,
        }}
        showEditorCard={true}
      />
    </div>
  );
}
```

### Step 12.3: Create vault page

- [ ] **Create the page route**

```typescript
// apps/web/app/dashboard/vault/page.tsx
"use client";

import { useVault } from "@/components/dashboard/vault/VaultProvider";
import { VaultUnlockForm } from "@/components/dashboard/vault/VaultUnlockForm";
import { VaultContent } from "@/components/dashboard/vault/VaultContent";
import { api } from "@/lib/trpc";

export default function VaultPage() {
  const { isUnlocked } = useVault();
  const isSetupQuery = api.vault.isSetup.useQuery();

  if (isSetupQuery.isLoading) return null;

  if (!isSetupQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">
          Set up your vault in Settings to get started.
        </p>
      </div>
    );
  }

  if (!isUnlocked) {
    return <VaultUnlockForm />;
  }

  return <VaultContent />;
}
```

- [ ] **Commit**

```bash
git add apps/web/app/dashboard/vault/ apps/web/components/dashboard/vault/VaultUnlockForm.tsx apps/web/components/dashboard/vault/VaultContent.tsx
git commit -m "feat(vault): add vault page with PIN entry and unlocked bookmark grid"
```

---

## Task 13: Web UI — Sidebar Vault Item

**Files:**
- Modify: `apps/web/app/dashboard/layout.tsx` (~line 58 sidebar items)

### Step 13.1: Add vault to sidebar

- [ ] **Add vault item to the sidebar items array**

In `apps/web/app/dashboard/layout.tsx`, add after the Archive item in the `items` array:

```typescript
    {
      name: t("common.vault"),
      icon: <Lock size={18} />,
      path: "/dashboard/vault",
    },
```

Add the `Lock` import from lucide-react:
```typescript
import { Lock } from "lucide-react";
```

- [ ] **Start dev server and verify**

Run: `pnpm web` (in a separate terminal)

Open browser to `http://localhost:3000/dashboard` and verify:
- "Vault" appears in the sidebar after "Archive"
- Clicking it navigates to `/dashboard/vault`
- The vault page shows "Set up your vault in Settings" (since vault is not set up yet)

- [ ] **Commit**

```bash
git add apps/web/app/dashboard/layout.tsx
git commit -m "feat(vault): add vault item to dashboard sidebar"
```

---

## Task 14: Web UI — Move to Vault Dialog

**Files:**
- Create: `apps/web/components/dashboard/bookmarks/MoveToVaultDialog.tsx`
- Modify: `apps/web/components/dashboard/bookmarks/BookmarkOptions.tsx`

### Step 14.1: Create the confirmation dialog

- [ ] **Create MoveToVaultDialog**

```typescript
// apps/web/components/dashboard/bookmarks/MoveToVaultDialog.tsx
"use client";

import { useState } from "react";
import { useTranslation } from "@/lib/i18n/client";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useVault } from "@/components/dashboard/vault/VaultProvider";
import { api } from "@/lib/trpc";

export function MoveToVaultDialog({
  bookmarkId,
  open,
  onOpenChange,
}: {
  bookmarkId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { isUnlocked } = useVault();
  const utils = api.useUtils();

  const moveToVaultMutation = api.bookmarks.moveToVault.useMutation({
    onSuccess: () => {
      toast.success(t("vault.move_to_vault"));
      utils.bookmarks.getBookmarks.invalidate();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  if (!isUnlocked) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("vault.move_to_vault")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("vault.move_to_vault_unlock_first")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.close")}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("vault.move_to_vault")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("vault.move_to_vault_confirm")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => moveToVaultMutation.mutate({ bookmarkId })}
            disabled={moveToVaultMutation.isPending}
          >
            {t("vault.move_to_vault")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

### Step 14.2: Add "Move to Vault" to context menu

- [ ] **Modify `apps/web/components/dashboard/bookmarks/BookmarkOptions.tsx`**

In the actions array (around line 268, near the "archive" action), add a "Move to Vault" action:

```typescript
{
  id: "moveToVault",
  title: t("vault.move_to_vault"),
  icon: <Lock className="mr-2 size-4" />,
  visible: isOwner && !bookmark.vaulted && isVaultSetup,
  disabled: demoMode,
  onClick: () => setMoveToVaultOpen(true),
},
```

Add state and query:
```typescript
const [moveToVaultOpen, setMoveToVaultOpen] = useState(false);
const isVaultSetupQuery = api.vault.isSetup.useQuery();
const isVaultSetup = isVaultSetupQuery.data ?? false;
```

Add the dialog component in the JSX return:
```typescript
<MoveToVaultDialog
  bookmarkId={bookmark.id}
  open={moveToVaultOpen}
  onOpenChange={setMoveToVaultOpen}
/>
```

Add imports:
```typescript
import { Lock } from "lucide-react";
import { MoveToVaultDialog } from "./MoveToVaultDialog";
```

- [ ] **Test in browser**

Open `http://localhost:3000/dashboard`, create a bookmark, click the three-dot menu. Verify "Move to Vault" appears (only after setting up vault in settings).

- [ ] **Commit**

```bash
git add apps/web/components/dashboard/bookmarks/MoveToVaultDialog.tsx apps/web/components/dashboard/bookmarks/BookmarkOptions.tsx
git commit -m "feat(vault): add Move to Vault context menu action with confirmation dialog"
```

---

## Task 15: Web UI — Vault Settings

**Files:**
- Create: `apps/web/components/settings/VaultSettings.tsx`
- Modify: Settings page to include VaultSettings section

### Step 15.1: Create VaultSettings component

- [ ] **Create `apps/web/components/settings/VaultSettings.tsx`**

```typescript
// apps/web/components/settings/VaultSettings.tsx
"use client";

import { useState } from "react";
import { useTranslation } from "@/lib/i18n/client";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/trpc";

function VaultSetupForm() {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const utils = api.useUtils();

  const setupMutation = api.vault.setup.useMutation({
    onSuccess: () => {
      toast.success(t("vault.setup_title"));
      utils.vault.isSetup.invalidate();
      setPin("");
      setConfirmPin("");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin !== confirmPin) {
      toast.error(t("vault.pins_dont_match"));
      return;
    }
    setupMutation.mutate({ pin });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {t("vault.setup_description")}
      </p>
      <div className="space-y-2">
        <Label>{t("vault.setup_pin_label")}</Label>
        <Input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          minLength={4}
          maxLength={64}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("vault.setup_confirm_label")}</Label>
        <Input
          type="password"
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value)}
        />
      </div>
      <p className="text-destructive text-xs">{t("vault.setup_warning")}</p>
      <Button type="submit" disabled={setupMutation.isPending || pin.length < 4}>
        {t("vault.setup_button")}
      </Button>
    </form>
  );
}

function VaultManageForm() {
  const { t } = useTranslation();
  const settingsQuery = api.vault.getSettings.useQuery();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePin, setDeletePin] = useState("");
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");
  const utils = api.useUtils();

  const updateSettingsMutation = api.vault.updateSettings.useMutation({
    onSuccess: () => toast.success("Settings updated"),
    onError: (err) => toast.error(err.message),
  });

  const changePinMutation = api.vault.changePin.useMutation({
    onSuccess: () => {
      toast.success(t("vault.change_pin"));
      setChangePinOpen(false);
      setCurrentPin("");
      setNewPin("");
      setConfirmNewPin("");
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteVaultMutation = api.vault.deleteVault.useMutation({
    onSuccess: () => {
      toast.success(t("vault.delete_vault"));
      utils.vault.isSetup.invalidate();
      setDeleteDialogOpen(false);
      setDeletePin("");
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="space-y-6">
      {/* Auto-lock timeout */}
      <div className="flex items-center justify-between">
        <Label>{t("vault.auto_lock_label")}</Label>
        <Select
          value={String(settingsQuery.data?.autoLockMinutes ?? 5)}
          onValueChange={(v) =>
            updateSettingsMutation.mutate({ autoLockMinutes: parseInt(v) })
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 5, 15, 30, 60].map((m) => (
              <SelectItem key={m} value={String(m)}>
                {m === 1 ? t("vault.auto_lock_minute") : t("vault.auto_lock_minutes", { count: m })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Change PIN */}
      <div>
        <Button variant="outline" onClick={() => setChangePinOpen(true)}>
          {t("vault.change_pin")}
        </Button>
      </div>

      {/* Delete Vault */}
      <div>
        <Button
          variant="destructive"
          onClick={() => setDeleteDialogOpen(true)}
        >
          {t("vault.delete_vault")}
        </Button>
      </div>

      {/* Change PIN Dialog */}
      <AlertDialog open={changePinOpen} onOpenChange={setChangePinOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("vault.change_pin")}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t("vault.change_pin_current")}</Label>
              <Input
                type="password"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("vault.change_pin_new")}</Label>
              <Input
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("vault.change_pin_confirm")}</Label>
              <Input
                type="password"
                value={confirmNewPin}
                onChange={(e) => setConfirmNewPin(e.target.value)}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (newPin !== confirmNewPin) {
                  toast.error(t("vault.pins_dont_match"));
                  return;
                }
                changePinMutation.mutate({ currentPin, newPin });
              }}
              disabled={changePinMutation.isPending}
            >
              {t("vault.change_pin")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Vault Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("vault.delete_vault")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("vault.delete_vault_warning")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <Label>{t("vault.delete_vault_confirm")}</Label>
            <Input
              type="password"
              value={deletePin}
              onChange={(e) => setDeletePin(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteVaultMutation.mutate({ pin: deletePin })}
              disabled={deleteVaultMutation.isPending || !deletePin}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("vault.delete_vault")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function VaultSettings() {
  const { t } = useTranslation();
  const isSetupQuery = api.vault.isSetup.useQuery();

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{t("vault.settings_title")}</h2>
      {isSetupQuery.isLoading ? null : isSetupQuery.data ? (
        <VaultManageForm />
      ) : (
        <VaultSetupForm />
      )}
    </div>
  );
}
```

### Step 15.2: Add VaultSettings to settings page

- [ ] **Find the settings page and add VaultSettings**

Locate the settings page component (likely `apps/web/app/dashboard/settings/page.tsx` or `apps/web/components/settings/UserOptions.tsx`). Add:

```typescript
import { VaultSettings } from "@/components/settings/VaultSettings";
```

And render `<VaultSettings />` as a new section, with a `<Separator />` before it.

- [ ] **Test in browser**

Navigate to Settings. Verify:
- "Vault" section appears
- Can set up vault with a PIN
- After setup, shows auto-lock dropdown, change PIN, and delete vault

- [ ] **Commit**

```bash
git add apps/web/components/settings/VaultSettings.tsx
git commit -m "feat(vault): add vault settings UI — setup, change PIN, auto-lock, delete"
```

---

## Task 16: Export Exclusion

**Files:**
- Modify: `apps/web/app/api/bookmarks/export/route.tsx`

### Step 16.1: Exclude vaulted bookmarks from exports

- [ ] **Modify the export route**

In `apps/web/app/api/bookmarks/export/route.tsx`, ensure the `getBookmarks` request includes `vaulted: false` (or relies on the default filter already added in Task 5).

Check the existing request object. Since Task 5 already defaults `vaulted` to `false` in `buildCommonFilters` when not explicitly set, exports should automatically exclude vaulted bookmarks without changes.

Verify by reading the export route and confirming no explicit `vaulted: true` is set.

- [ ] **Commit** (if changes were needed)

```bash
# Only if export code needed changes
git add apps/web/app/api/bookmarks/export/route.tsx
git commit -m "feat(vault): verify vaulted bookmarks excluded from exports"
```

---

## Task 17: Typecheck & Full Test Suite

### Step 17.1: Run full verification

- [ ] **Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Run full test suite**

Run: `pnpm test`
Expected: All tests pass, including new vault tests and existing bookmark tests

- [ ] **Run linter**

Run: `pnpm lint`
Expected: No lint errors (fix any if found)

- [ ] **Run formatter**

Run: `pnpm format:fix`

- [ ] **Final commit with any fixes**

```bash
git add -A
git commit -m "chore: fix typecheck, lint, and formatting for vault feature"
```

---

## Implementation Notes

### Vault Token Flow
```
User enters PIN
  → tRPC vault.unlock validates PIN (bcrypt)
  → Server derives encryption key (PBKDF2)
  → Server signs token { userId, encryptionKey, exp } (HMAC-SHA256)
  → Client stores token in React state (VaultProvider)
  → Client sends token as x-vault-token header on every request
  → Server reads header in createContextFromRequest → ctx.vaultKey
  → tRPC procedures check ctx.vaultKey for vault access
```

### Security Properties
- **At rest:** Encryption key is derived from PIN and never stored. Raw DB file shows ciphertext only.
- **In session:** Key lives in signed token (client memory) and ctx.vaultKey (server request scope).
- **Auto-lock:** Token has expiry. Expired token = null vaultKey = vault locked.
- **Tab close:** Token in React state = lost on close = vault locked.
- **Server restart:** No server-side session state = vault locked immediately.

### Key Differences from `archived` Pattern
- `archived`: optional filter (undefined = show both). Three-state: true/false/undefined.
- `vaulted`: defaults to `false` when not specified. Always excluded unless explicitly requested.
- `archived`: can be toggled (archive/unarchive). Reversible.
- `vaulted`: one-way. Once vaulted, cannot be un-vaulted. Only deleted.

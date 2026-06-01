# Vault Feature — Design Spec

## Overview

A password-protected vault section within Karakeep that hides sensitive bookmarks from all normal views. Vaulted bookmarks are encrypted at rest (title, URL, note, text content, and asset files) and only accessible after entering a PIN. Once a bookmark enters the vault, it cannot be moved back out — it can only be edited or deleted.

**Primary goal:** Privacy from others who might see your screen or share your device.

## Requirements

- Single vault per user
- Separate PIN from the login password
- Configurable auto-lock timeout (1, 5, 15, 30, 60 minutes)
- Vaulted bookmarks are completely invisible when locked — no trace in search, tags, lists, stats, or exports
- Bookmarks moved to the vault are permanently there (one-way operation)
- All sensitive data encrypted at rest: text fields in SQLite + asset files on disk
- Works with both LocalFileSystemAssetStore and S3AssetStore

## Schema & Data Model

### Users table additions

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `vaultPinHash` | text | null | bcrypt hash of the vault PIN |
| `vaultPinSalt` | text | null | Salt for PIN hashing |
| `vaultEncryptionSalt` | text | null | Separate salt for PBKDF2 key derivation |
| `vaultAutoLockMinutes` | integer | 5 | Auto-lock timeout |

### Bookmarks table additions

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `vaulted` | integer (boolean) | false | Whether the bookmark is in the vault |
| `encryptedTitle` | text | null | AES-256-GCM encrypted title |
| `encryptedUrl` | text | null | AES-256-GCM encrypted URL |
| `encryptedNote` | text | null | AES-256-GCM encrypted note |

### Assets table additions

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `encrypted` | integer (boolean) | false | Whether the asset file is encrypted |

### BookmarkTexts / BookmarkLinks

When a bookmark is vaulted:
- `bookmarkTexts.text` is replaced with AES-256-GCM ciphertext
- `bookmarkLinks.url` is replaced with AES-256-GCM ciphertext
- Original `title`, `url`, `note` columns on `bookmarks` table are set to null
- Encrypted versions stored in `encryptedTitle`, `encryptedUrl`, `encryptedNote`

### Index

- `bookmarks_userId_vaulted_idx` on `(userId, vaulted)` for efficient filtering

## Encryption Design

### Algorithm

- **Encryption:** AES-256-GCM (authenticated encryption)
- **Key derivation:** PBKDF2 with SHA-256, using `vaultEncryptionSalt` (per-user, generated on vault setup)
- **PIN verification:** bcrypt with `vaultPinSalt` (separate from encryption salt)
- **IV:** Random 12-byte IV prepended to each ciphertext

### What gets encrypted

| Data | Location | Encrypted when vaulted |
|------|----------|----------------------|
| Bookmark title | `bookmarks.encryptedTitle` | Yes |
| Bookmark URL | `bookmarks.encryptedUrl` | Yes |
| Bookmark note | `bookmarks.encryptedNote` | Yes |
| Text content | `bookmarkTexts.text` | Yes (in place) |
| Link URL | `bookmarkLinks.url` | Yes (in place) |
| Asset files | `asset.bin` on disk/S3 | Yes (in place) |
| Asset metadata | `metadata.json` | No (content type is not sensitive) |

### Encryption flow (move to vault)

1. Derive AES-256 key from PIN + `vaultEncryptionSalt` via PBKDF2
2. For each text field: encrypt with AES-256-GCM, store in encrypted column, null out original
3. For each associated asset: read `Buffer` via `readAsset()`, encrypt, write back via `saveAsset()`, set `encrypted = true`

### Decryption flow (read vaulted content)

1. Extract encryption key from vault session JWT (`ctx.vaultKey`)
2. Decrypt text fields in memory before returning to client
3. Decrypt asset Buffers in memory before streaming to client

### Changing the PIN

1. Verify current PIN
2. Derive old key from old PIN + existing `vaultEncryptionSalt`
3. Generate new `vaultEncryptionSalt`, derive new key from new PIN + new salt
4. Batch operation: decrypt all vaulted content with old key, re-encrypt with new key
5. Update `vaultPinHash`, `vaultPinSalt`, `vaultEncryptionSalt`
6. This is potentially slow — show progress indicator in UI

## Authentication & Session

### Vault setup

1. User navigates to Settings → Vault
2. Enters a PIN (4-8 digits or full password)
3. Server generates `vaultPinSalt` and `vaultEncryptionSalt`
4. Server stores bcrypt hash of PIN and salts on user record

### Unlocking

1. User clicks "Vault" in sidebar → PIN entry modal
2. tRPC mutation `vault.unlock` verifies PIN against bcrypt hash
3. On success: derive encryption key via PBKDF2
4. Sign JWT: `{ userId, vaultUnlockedAt, encryptionKey }` with expiry = `vaultAutoLockMinutes`
5. Store JWT in secure httpOnly cookie (`karakeep-vault-token`)
6. Subsequent requests include cookie — server extracts key for decryption

### Locking

- **Auto-lock:** JWT expires → next request sees expired token → vault is locked
- **Manual lock:** tRPC mutation `vault.lock` clears the cookie
- **Tab close:** Cookie persists but JWT expiry enforces timeout

### Security notes

- Encryption key lives inside the JWT cookie — as secure as `NEXTAUTH_SECRET`
- Acceptable for self-hosted app where user controls the server
- PIN verification (bcrypt) is separate from key derivation (PBKDF2) — different salts
- A raw `.db` file dump shows `vaulted = true` but all content is ciphertext
- Asset files on disk are unreadable ciphertext

## tRPC API

### New router: `vault.ts`

| Procedure | Type | Auth | Description |
|-----------|------|------|-------------|
| `vault.setup` | mutation | session | Create vault PIN (one-time) |
| `vault.unlock` | mutation | session | Verify PIN, set vault cookie |
| `vault.lock` | mutation | session | Clear vault cookie |
| `vault.isSetup` | query | authed | Returns boolean |
| `vault.isUnlocked` | query | authed | Returns boolean (is cookie valid?) |
| `vault.changePin` | mutation | session + vault | Re-encrypt all content with new key |
| `vault.getSettings` | query | authed | Get auto-lock timeout |
| `vault.updateSettings` | mutation | session | Update auto-lock timeout |

### Modified existing procedures

**`bookmarks.getBookmarks`:**
- Add `eq(bookmarks.vaulted, false)` filter to ALL queries by default
- Only include vaulted bookmarks when explicitly requested AND `ensureVaultAccess` middleware passes

**`bookmarks.getBookmark`:**
- If bookmark is vaulted, check vault cookie via `ensureVaultAccess`
- If locked → throw `FORBIDDEN`
- If unlocked → decrypt fields before returning

**`bookmarks.moveToVault`** (new mutation):
- One-way operation. Encrypts all text fields + asset files
- Sets `vaulted = true`
- No reverse operation exists

**`bookmarks.createBookmark`:**
- Accept optional `vaulted: true` parameter to create directly into vault
- Requires vault to be unlocked

### Middleware: `ensureVaultAccess`

Applied to any procedure that reads/writes vaulted content:
1. Check vault cookie is present
2. Verify JWT is valid and not expired
3. Extract encryption key, attach to `ctx.vaultKey`
4. On failure → `TRPCError({ code: "FORBIDDEN", message: "Vault is locked" })`

### Filtering (follows `archived` pattern)

All bookmark list queries, search, tags, lists, stats, exports:
```
eq(bookmarks.vaulted, false)
```

Vault page query:
```
eq(bookmarks.vaulted, true)  // + ensureVaultAccess
```

## UI Design

### Sidebar

- New "Vault" item after "Archive"
- Lock icon when locked, unlock icon when unlocked
- No bookmark count when locked (no trace)
- Bookmark count shown when unlocked

### Vault page (`/dashboard/vault`)

**Locked state:**
- Centered PIN entry form
- Lock icon, PIN input field, "Unlock" button
- Minimal — no hint about contents

**Unlocked state:**
- Standard bookmark grid/list view (reuses existing bookmark components)
- "Lock Vault" button in top bar
- Subtle timer showing time until auto-lock
- Context menu on bookmarks: "Edit", "Delete" only
- No "Remove from Vault" — bookmarks are permanent

### Moving bookmarks to vault

- "Move to Vault" option in bookmark card context menu (three-dot menu)
- Only appears if user has set up a vault
- Shows confirmation dialog: "This bookmark will be permanently moved to the vault. This cannot be undone."
- If vault is locked → prompt for PIN first, then move
- If vault is unlocked → move after confirmation

### Creating bookmarks in vault

- When on the vault page (unlocked), the "Add bookmark" action creates directly into the vault

### Settings (`/dashboard/settings`)

New "Vault" section:
- **First time:** "Set up Vault" button → modal with PIN input + confirm PIN
- **After setup:**
  - Change PIN button
  - Auto-lock timeout dropdown (1, 5, 15, 30, 60 minutes)
  - "Delete Vault" danger button — deletes the vault AND all its contents permanently

### What does NOT change

- Search — vaulted bookmarks excluded
- Tags — vaulted bookmarks excluded from counts
- Lists — vaulted bookmarks excluded, cannot be added to lists
- RSS/exports/API — all exclude vaulted bookmarks unless vault is unlocked
- Mobile app / browser extension — vault is web-only for now, vaulted bookmarks simply don't appear

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Wrong PIN | "Incorrect PIN" error, no lockout (self-hosted, no brute-force concern) |
| Vault cookie expired mid-session | Next request returns 403, UI shows PIN prompt |
| Move to vault fails mid-encryption | Transaction rollback — bookmark stays unvaulted |
| Change PIN fails mid-re-encryption | Transaction rollback — old PIN and encryption remain |
| User deletes account | Cascade delete removes vault data + encrypted assets |
| Forgotten PIN | Data is unrecoverable — encryption key is derived from PIN and never stored. UI warns during setup. |

## Out of Scope

- Multiple vaults per user
- Biometric unlock (Face ID / fingerprint)
- Mobile app vault support
- Sharing vaulted bookmarks
- AI tagging of vaulted bookmarks
- Vault backup/export

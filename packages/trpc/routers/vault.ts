import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

import {
  assets,
  bookmarkLinks,
  bookmarks,
  bookmarkTexts,
  users,
} from "@karakeep/db/schema";
import { deleteAsset, readAsset, saveAsset } from "@karakeep/shared/assetdb";
import { QuotaApproved } from "@karakeep/shared/storageQuota";
import serverConfig from "@karakeep/shared/config";
import {
  zVaultChangePinSchema,
  zVaultDeleteSchema,
  zVaultSetupSchema,
  zVaultUnlockSchema,
  zVaultUpdateSettingsSchema,
} from "@karakeep/shared/types/vault";
import { SearchIndexingQueue } from "@karakeep/shared-server";

import { authedProcedure, router, sessionProcedure } from "../index";
import {
  createVaultToken,
  decryptBuffer,
  decryptText,
  deriveEncryptionKey,
  encryptBuffer,
  encryptText,
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

      if (
        !user?.vaultPinHash ||
        !user.vaultPinSalt ||
        !user.vaultEncryptionSalt
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault is not set up",
        });
      }

      const valid = await verifyPin(
        input.pin,
        user.vaultPinHash,
        user.vaultPinSalt,
      );
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

  changePin: sessionProcedure
    .input(zVaultChangePinSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.vaultKey) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Vault is locked",
        });
      }

      const user = await ctx.db.query.users.findFirst({
        where: eq(users.id, ctx.user.id),
        columns: {
          vaultPinHash: true,
          vaultPinSalt: true,
          vaultEncryptionSalt: true,
        },
      });

      if (
        !user?.vaultPinHash ||
        !user.vaultPinSalt ||
        !user.vaultEncryptionSalt
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault is not set up",
        });
      }

      const valid = await verifyPin(
        input.currentPin,
        user.vaultPinHash,
        user.vaultPinSalt,
      );
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Incorrect current PIN",
        });
      }

      const oldKey = ctx.vaultKey;
      const newEncryptionSalt = generateSalt();
      const newKey = await deriveEncryptionKey(input.newPin, newEncryptionSalt);
      const { hash: newPinHash, salt: newPinSalt } = await hashPin(
        input.newPin,
      );

      const vaultedBookmarks = await ctx.db.query.bookmarks.findMany({
        where: and(
          eq(bookmarks.userId, ctx.user.id),
          eq(bookmarks.vaulted, true),
        ),
        with: { link: true, text: true },
      });

      // Re-encrypt asset files (file I/O) and compute the new ciphertext for the
      // encrypted columns BEFORE the synchronous transaction — neither file I/O
      // nor awaits can run inside a better-sqlite3 transaction. The DB writes are
      // then applied atomically below.
      const bookmarkWrites: {
        id: string;
        updates: Record<string, string | null>;
        linkUrl: string | null;
        textContent: string | null;
      }[] = [];

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

        const linkUrl = bookmark.link
          ? encryptText(decryptText(bookmark.link.url, oldKey), newKey)
          : null;
        const textContent = bookmark.text?.text
          ? encryptText(decryptText(bookmark.text.text, oldKey), newKey)
          : null;

        bookmarkWrites.push({ id: bookmark.id, updates, linkUrl, textContent });

        const assetRecords = await ctx.db.query.assets.findMany({
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
              quotaApproved: QuotaApproved._create(
                ctx.user.id,
                reEncrypted.byteLength,
              ),
            });
          } catch {
            // Asset may not exist on disk
          }
        }
      }

      ctx.db.transaction((tx) => {
        for (const { id, updates, linkUrl, textContent } of bookmarkWrites) {
          if (Object.keys(updates).length > 0) {
            tx.update(bookmarks).set(updates).where(eq(bookmarks.id, id)).run();
          }

          if (linkUrl !== null) {
            tx.update(bookmarkLinks)
              .set({ url: linkUrl })
              .where(eq(bookmarkLinks.id, id))
              .run();
          }

          if (textContent !== null) {
            tx.update(bookmarkTexts)
              .set({ text: textContent })
              .where(eq(bookmarkTexts.id, id))
              .run();
          }
        }

        tx.update(users)
          .set({
            vaultPinHash: newPinHash,
            vaultPinSalt: newPinSalt,
            vaultEncryptionSalt: newEncryptionSalt,
          })
          .where(eq(users.id, ctx.user.id))
          .run();
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
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault is not set up",
        });
      }

      const valid = await verifyPin(
        input.pin,
        user.vaultPinHash,
        user.vaultPinSalt,
      );
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Incorrect PIN",
        });
      }

      const vaultedBookmarks = await ctx.db.query.bookmarks.findMany({
        where: and(
          eq(bookmarks.userId, ctx.user.id),
          eq(bookmarks.vaulted, true),
        ),
        columns: { id: true },
        with: { assets: true },
      });

      // Delete asset files and enqueue search-index removals BEFORE the
      // synchronous transaction — file I/O and queue calls cannot run inside a
      // better-sqlite3 transaction.
      for (const bookmark of vaultedBookmarks) {
        for (const asset of bookmark.assets) {
          try {
            await deleteAsset({
              userId: ctx.user.id,
              assetId: asset.id,
            });
          } catch {
            // Asset may not exist
          }
        }

        SearchIndexingQueue.enqueue({
          bookmarkId: bookmark.id,
          type: "delete",
        });
      }

      ctx.db.transaction((tx) => {
        tx.delete(bookmarks)
          .where(
            and(eq(bookmarks.userId, ctx.user.id), eq(bookmarks.vaulted, true)),
          )
          .run();

        tx.update(users)
          .set({
            vaultPinHash: null,
            vaultPinSalt: null,
            vaultEncryptionSalt: null,
            vaultAutoLockMinutes: 5,
          })
          .where(eq(users.id, ctx.user.id))
          .run();
      });
    }),
});

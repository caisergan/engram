import { experimental_trpcMiddleware, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

import { socialSyncConnections } from "@karakeep/db/schema";
import {
  zConnectSchema,
  zDisconnectSchema,
  zSetEnabledSchema,
  zSyncNowSchema,
  zUpdateCookiesSchema,
  zUpdateSyncSettingsSchema,
} from "@karakeep/shared/types/socialSync";
import { SocialSyncQueue } from "@karakeep/shared-server";

import type { AuthedContext } from "../index";
import {
  createScopedAuthedProcedure,
  router,
  sessionProcedure,
} from "../index";
import { encryptCookies } from "../lib/cookieEncryption";
import { getProvider } from "../lib/socialSync/providers";

// API-key callers must hold the `socialSync` scope (read for queries, readwrite
// for mutations); session callers always pass. Full-access keys (e.g. the
// browser extension's) satisfy this; narrowly-scoped keys are rejected.
const socialSyncProcedure = createScopedAuthedProcedure("socialSync");

const ensureConnectionOwnership = experimental_trpcMiddleware<{
  ctx: AuthedContext;
  input: { connectionId: string };
}>().create(async (opts) => {
  const connection = await opts.ctx.db.query.socialSyncConnections.findFirst({
    where: and(
      eq(socialSyncConnections.id, opts.input.connectionId),
      eq(socialSyncConnections.userId, opts.ctx.user.id),
    ),
  });
  if (!connection) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Connection not found",
    });
  }
  return opts.next({ ctx: { ...opts.ctx, connection } });
});

export const socialSyncAppRouter = router({
  getConnections: socialSyncProcedure.query(async ({ ctx }) => {
    const connections = await ctx.db.query.socialSyncConnections.findMany({
      where: eq(socialSyncConnections.userId, ctx.user.id),
    });
    return connections.map((c) => ({
      id: c.id,
      platform: c.platform,
      enabled: c.enabled,
      lastSyncedAt: c.lastSyncedAt,
      lastSyncStatus: c.lastSyncStatus,
      lastSyncError: c.lastSyncError,
      syncIntervalMinutes: c.syncIntervalMinutes,
      autoTagName: c.autoTagName ?? c.platform,
      totalSynced: c.totalSynced,
      backfillComplete: c.backfillComplete,
      createdAt: c.createdAt,
    }));
  }),

  connect: socialSyncProcedure
    .input(zConnectSchema)
    .mutation(async ({ input, ctx }) => {
      const existing = await ctx.db.query.socialSyncConnections.findFirst({
        where: and(
          eq(socialSyncConnections.userId, ctx.user.id),
          eq(socialSyncConnections.platform, input.platform),
        ),
      });
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Already connected to ${input.platform}`,
        });
      }

      const provider = getProvider(input.platform);
      const valid = await provider.validateAuth(input.cookies);
      if (!valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Could not authenticate with these cookies. Make sure you're logged in and the cookies are current.",
        });
      }

      const encrypted = await encryptCookies(input.cookies);
      const [connection] = await ctx.db
        .insert(socialSyncConnections)
        .values({
          userId: ctx.user.id,
          platform: input.platform,
          authCookies: encrypted,
          autoTagName: input.autoTagName ?? input.platform,
        })
        .returning();

      SocialSyncQueue.enqueue(
        { connectionId: connection.id },
        { groupId: ctx.user.id },
      );
    }),

  updateCookies: socialSyncProcedure
    .input(zUpdateCookiesSchema)
    .use(ensureConnectionOwnership)
    .mutation(async ({ input, ctx }) => {
      const provider = getProvider(ctx.connection.platform);
      const valid = await provider.validateAuth(input.cookies);
      if (!valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Could not authenticate with these cookies. Make sure you're logged in and the cookies are current.",
        });
      }

      const encrypted = await encryptCookies(input.cookies);
      await ctx.db
        .update(socialSyncConnections)
        .set({
          authCookies: encrypted,
          enabled: true,
          lastSyncError: null,
          lastSyncStatus: "pending",
        })
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),

  disconnect: sessionProcedure
    .input(zDisconnectSchema)
    .use(ensureConnectionOwnership)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .delete(socialSyncConnections)
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),

  setEnabled: sessionProcedure
    .input(zSetEnabledSchema)
    .use(ensureConnectionOwnership)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(socialSyncConnections)
        .set({ enabled: input.enabled })
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),

  updateSettings: sessionProcedure
    .input(zUpdateSyncSettingsSchema)
    .use(ensureConnectionOwnership)
    .mutation(async ({ input, ctx }) => {
      const updates: Record<string, unknown> = {};
      if (input.syncIntervalMinutes !== undefined) {
        updates.syncIntervalMinutes = input.syncIntervalMinutes;
      }
      if (input.autoTagName !== undefined) {
        updates.autoTagName = input.autoTagName;
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db
          .update(socialSyncConnections)
          .set(updates)
          .where(eq(socialSyncConnections.id, input.connectionId));
      }
    }),

  syncNow: sessionProcedure
    .input(zSyncNowSchema)
    .use(ensureConnectionOwnership)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.connection.enabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Connection is disabled. Enable it first.",
        });
      }
      SocialSyncQueue.enqueue(
        { connectionId: input.connectionId },
        { groupId: ctx.user.id },
      );
    }),
});

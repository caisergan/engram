import { experimental_trpcMiddleware, TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { socialSyncConnections, socialSyncRuns } from "@karakeep/db/schema";
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

    const connIds = connections.map((c) => c.id);
    const runningRuns = connIds.length
      ? await ctx.db.query.socialSyncRuns.findMany({
          where: and(
            inArray(socialSyncRuns.connectionId, connIds),
            eq(socialSyncRuns.status, "running"),
          ),
          orderBy: (r, { desc }) => [desc(r.startedAt)],
        })
      : [];

    // First row per connection wins = latest, because ordered desc by startedAt.
    const activeByConn = new Map<string, (typeof runningRuns)[number]>();
    for (const r of runningRuns) {
      if (!activeByConn.has(r.connectionId))
        activeByConn.set(r.connectionId, r);
    }

    return connections.map((c) => {
      const run = activeByConn.get(c.id);
      return {
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
        activeRun: run
          ? {
              id: run.id,
              phase: run.phase,
              pagesScanned: run.pagesScanned,
              itemsFound: run.itemsFound,
              itemsImported: run.itemsImported,
              itemsFailed: run.itemsFailed,
              startedAt: run.startedAt,
            }
          : null,
      };
    });
  }),

  getRuns: socialSyncProcedure
    .input(
      z.object({
        connectionId: z.string(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .use(ensureConnectionOwnership)
    .query(async ({ input, ctx }) => {
      const runs = await ctx.db.query.socialSyncRuns.findMany({
        where: eq(socialSyncRuns.connectionId, input.connectionId),
        orderBy: (r, { desc }) => [desc(r.startedAt)],
        limit: input.limit,
      });
      return runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        itemsImported: r.itemsImported,
        itemsFailed: r.itemsFailed,
        error: r.error,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
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
        { connectionId: connection.id, trigger: "manual" },
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
        { connectionId: input.connectionId, trigger: "manual" },
        { groupId: ctx.user.id },
      );
      await ctx.db
        .update(socialSyncConnections)
        .set({ lastSyncStatus: "pending", lastSyncError: null })
        .where(eq(socialSyncConnections.id, input.connectionId));
    }),
});

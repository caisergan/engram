import { and, eq, isNull, or, sql } from "drizzle-orm";
import cron from "node-cron";
import { buildImpersonatingTRPCClient } from "trpc";

import { db } from "@karakeep/db";
import {
  bookmarkTags,
  socialSyncConnections,
  socialSyncHistory,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import logger from "@karakeep/shared/logger";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import { getQueueClient } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { ZSocialSyncRequestSchema } from "@karakeep/shared-server";
import {
  SocialSyncQueue,
  zSocialSyncRequestSchema,
} from "@karakeep/shared-server";

import { decryptCookies } from "@karakeep/trpc/lib/cookieEncryption";
import { getProvider } from "@karakeep/trpc/lib/socialSync/providers";
import { planSync } from "@karakeep/trpc/lib/socialSync/syncEngine";
import {
  SyncRunRecorder,
  sweepStaleRuns,
} from "@karakeep/trpc/lib/socialSync/syncRunRecorder";

const MAX_ITEMS_PER_RUN = 100;

async function run(req: DequeuedJob<ZSocialSyncRequestSchema>) {
  const { connectionId, trigger } = req.data;
  logger.info(`[social-sync][${connectionId}] Starting sync run`);

  const recorder = await SyncRunRecorder.start({
    db,
    connectionId,
    trigger,
    jobId: req.id,
  });

  try {
    const connection = await db.query.socialSyncConnections.findFirst({
      where: eq(socialSyncConnections.id, connectionId),
    });

    if (!connection || !connection.enabled) {
      logger.info(
        `[social-sync][${connectionId}] Connection not found or disabled, skipping`,
      );
      await recorder.finishFailure("Connection not found or disabled");
      return;
    }

    const provider = getProvider(connection.platform);
    let authCookies: string;
    try {
      authCookies = await decryptCookies(connection.authCookies);
    } catch (e) {
      logger.error(
        `[social-sync][${connectionId}] Failed to decrypt cookies: ${e}`,
      );
      await db
        .update(socialSyncConnections)
        .set({
          lastSyncStatus: "failure",
          lastSyncError: "Failed to decrypt stored cookies",
          enabled: false,
        })
        .where(eq(socialSyncConnections.id, connectionId));
      await recorder.finishFailure("Failed to decrypt stored cookies");
      return;
    }

    await recorder.setPhase("fetching");

    let result;
    try {
      result = await planSync({
        provider,
        authCookies,
        sinceTimestamp: connection.lastSyncedAt,
        backfillComplete: connection.backfillComplete,
        resumeCursor: connection.lastCursor,
        maxItems: MAX_ITEMS_PER_RUN,
        signal: req.abortSignal,
        onPage: () => recorder.incrementPages(),
        isSeen: async (platformItemId) => {
          const existing = await db.query.socialSyncHistory.findFirst({
            where: and(
              eq(socialSyncHistory.connectionId, connectionId),
              eq(socialSyncHistory.platformItemId, platformItemId),
            ),
          });
          return !!existing;
        },
      });
    } catch (e: unknown) {
      const err = e as Record<string, unknown>;
      const status = err?.status ?? err?.statusCode;
      if (status === 401 || status === 403) {
        await db
          .update(socialSyncConnections)
          .set({
            lastSyncStatus: "failure",
            lastSyncError: "Authentication expired — update your cookies",
            enabled: false,
          })
          .where(eq(socialSyncConnections.id, connectionId));
        await recorder.finishFailure(
          "Authentication expired — update your cookies",
        );
        return;
      }
      throw e;
    }

    await recorder.setItemsFound(result.newItems.length);
    await recorder.setPhase("importing");

    const trpcClient = await buildImpersonatingTRPCClient(connection.userId);
    let newCount = 0;

    for (const item of result.newItems) {
      try {
        const bookmark = await trpcClient.bookmarks.createBookmark({
          type: BookmarkTypes.LINK,
          url: item.url,
          title: item.title,
          source: "sync",
        });

        const tagName = connection.autoTagName ?? connection.platform;
        let tag = await db.query.bookmarkTags.findFirst({
          where: and(
            eq(bookmarkTags.userId, connection.userId),
            eq(bookmarkTags.name, tagName),
          ),
        });
        if (!tag) {
          [tag] = await db
            .insert(bookmarkTags)
            .values({ userId: connection.userId, name: tagName })
            .returning();
        }
        await db
          .insert(tagsOnBookmarks)
          .values({
            bookmarkId: bookmark.id,
            tagId: tag.id,
            attachedBy: "human",
          })
          .onConflictDoNothing();

        if (item.tags) {
          for (const hashtagName of item.tags) {
            let hashtag = await db.query.bookmarkTags.findFirst({
              where: and(
                eq(bookmarkTags.userId, connection.userId),
                eq(bookmarkTags.name, hashtagName),
              ),
            });
            if (!hashtag) {
              [hashtag] = await db
                .insert(bookmarkTags)
                .values({ userId: connection.userId, name: hashtagName })
                .returning();
            }
            await db
              .insert(tagsOnBookmarks)
              .values({
                bookmarkId: bookmark.id,
                tagId: hashtag.id,
                attachedBy: "human",
              })
              .onConflictDoNothing();
          }
        }

        await db.insert(socialSyncHistory).values({
          connectionId,
          platformItemId: item.platformItemId,
          bookmarkId: bookmark.id,
        });

        newCount++;
        await recorder.incrementImported();
      } catch (e) {
        logger.warn(
          `[social-sync][${connectionId}] Failed to create bookmark for ${item.url}: ${e}`,
        );
        await recorder.incrementFailed();
      }
    }

    await recorder.setPhase("finalizing");
    await db
      .update(socialSyncConnections)
      .set({
        lastSyncedAt: new Date(),
        lastCursor: result.resumeCursor,
        backfillComplete: result.backfillComplete,
        lastSyncStatus: "success",
        lastSyncError: null,
        totalSynced: sql`${socialSyncConnections.totalSynced} + ${newCount}`,
      })
      .where(eq(socialSyncConnections.id, connectionId));

    await recorder.finishSuccess();
    logger.info(
      `[social-sync][${connectionId}] Sync complete: ${newCount} new bookmarks`,
    );
  } catch (e) {
    await recorder.finishFailure(String(e));
    throw e;
  }
}

export class SocialSyncWorker {
  static async build() {
    logger.info("Starting social sync worker ...");
    const worker =
      (await getQueueClient())!.createRunner<ZSocialSyncRequestSchema>(
        SocialSyncQueue,
        {
          run,
          onComplete: async (job) => {
            logger.info(`[social-sync][${job.id}] Job completed successfully`);
          },
          onError: async (job) => {
            logger.error(
              `[social-sync][${job.id}] Job failed: ${job.error}\n${job.error?.stack}`,
            );
            if (job.data && job.numRetriesLeft === 0) {
              await db
                .update(socialSyncConnections)
                .set({
                  lastSyncStatus: "failure",
                  lastSyncError: String(job.error),
                })
                .where(eq(socialSyncConnections.id, job.data.connectionId));
            }
          },
        },
        {
          concurrency: 1,
          pollIntervalMs: 1000,
          timeoutSecs: 60,
          validator: zSocialSyncRequestSchema,
        },
      );
    return worker;
  }
}

export const SocialSyncRefreshingWorker = cron.schedule(
  "* * * * *",
  () => {
    const now = new Date();
    // Fail runs that have been "running" past the job timeout (60s) + grace
    // (120s) — covers a hard process hang where run()'s catch never executed.
    void sweepStaleRuns(db, new Date(now.getTime() - 180 * 1000));
    db.query.socialSyncConnections
      .findMany({
        where: and(
          eq(socialSyncConnections.enabled, true),
          or(
            isNull(socialSyncConnections.lastSyncedAt),
            sql`${socialSyncConnections.lastSyncedAt} < ${Math.floor(now.getTime() / 1000) - 60 * 15}`,
          ),
        ),
        columns: {
          id: true,
          userId: true,
          syncIntervalMinutes: true,
          lastSyncedAt: true,
        },
      })
      .then(async (connections) => {
        for (const conn of connections) {
          if (conn.lastSyncedAt) {
            const nextDue = new Date(
              conn.lastSyncedAt.getTime() +
                conn.syncIntervalMinutes * 60 * 1000,
            );
            if (nextDue > now) continue;
          }

          const intervalSlot = Math.floor(
            now.getTime() / (conn.syncIntervalMinutes * 60 * 1000),
          );
          await SocialSyncQueue.enqueue(
            { connectionId: conn.id, trigger: "scheduled" },
            {
              idempotencyKey: `sync:${conn.id}:${intervalSlot}`,
              groupId: conn.userId,
            },
          );
        }
      })
      .catch((error: unknown) => {
        logger.error(`[social-sync] Failed to schedule refresh jobs: ${error}`);
      });
  },
  { runOnInit: false, scheduled: false },
);

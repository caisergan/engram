import { and, eq, isNull, or, sql } from "drizzle-orm";
import cron from "node-cron";
import { buildImpersonatingTRPCClient } from "trpc";

import { db } from "@karakeep/db";
import {
  assets,
  AssetTypes,
  bookmarkLinks,
  bookmarkTags,
  socialSyncConnections,
  socialSyncHistory,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import { newAssetId, saveAsset } from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import { getQueueClient } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { SyncItem } from "@karakeep/shared/types/socialSync";
import type { ZSocialSyncRequestSchema } from "@karakeep/shared-server";
import {
  QuotaService,
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

async function findOrCreateTag(userId: string, name: string) {
  let tag = await db.query.bookmarkTags.findFirst({
    where: and(eq(bookmarkTags.userId, userId), eq(bookmarkTags.name, name)),
  });
  if (!tag) {
    [tag] = await db.insert(bookmarkTags).values({ userId, name }).returning();
  }
  return tag;
}

async function attachTag(bookmarkId: string, tagId: string) {
  await db
    .insert(tagsOnBookmarks)
    .values({
      bookmarkId,
      tagId,
      attachedBy: "human",
    })
    .onConflictDoNothing();
}

async function attachSyncTags({
  userId,
  bookmarkId,
  platform,
  autoTagName,
  itemTags,
}: {
  userId: string;
  bookmarkId: string;
  platform: string;
  autoTagName: string | null;
  itemTags?: string[];
}) {
  const tagNames = new Set([autoTagName ?? platform, ...(itemTags ?? [])]);
  for (const tagName of tagNames) {
    const tag = await findOrCreateTag(userId, tagName);
    await attachTag(bookmarkId, tag.id);
  }
}

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;
// A browser-like UA; Instagram's CDN serves a placeholder for unknown agents.
const IMAGE_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Download a provider-supplied preview image and store it as the bookmark's
 * banner asset. Social CDN image URLs are signed and expire, so we persist the
 * bytes rather than the URL. Returns null (and logs) on any failure so a missing
 * image never fails the whole import.
 */
async function storeBannerImage(
  imageUrl: string,
  userId: string,
  bookmarkId: string,
  connectionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const timeoutSignal = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(imageUrl, {
      headers: { "User-Agent": IMAGE_FETCH_USER_AGENT },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) {
      throw new Error(`Image download failed: ${response.status}`);
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim();
    if (!contentType || !contentType.startsWith("image/")) {
      throw new Error(`Unexpected image content type: ${contentType}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > serverConfig.maxAssetSizeMb * 1024 * 1024) {
      throw new Error(
        `Image exceeds maximum allowed size: ${serverConfig.maxAssetSizeMb}MB`,
      );
    }

    const quotaApproved = await QuotaService.checkStorageQuota(
      db,
      userId,
      buffer.byteLength,
    );

    const assetId = newAssetId();
    await saveAsset({
      userId,
      assetId,
      asset: buffer,
      metadata: { contentType },
      quotaApproved,
    });

    await db.insert(assets).values({
      id: assetId,
      bookmarkId,
      userId,
      assetType: AssetTypes.LINK_BANNER_IMAGE,
      contentType,
      size: buffer.byteLength,
    });

    return true;
  } catch (e) {
    logger.warn(
      `[social-sync][${connectionId}] Failed to store banner image for ${bookmarkId}: ${e}`,
    );
    return false;
  }
}

/**
 * Persist the caption + preview image the provider already fetched from the
 * authenticated API, so the bookmark renders correctly without relying on a
 * public crawl (which Instagram blocks behind a login wall). The crawler is
 * configured to skip synced Instagram bookmarks, so these writes are not
 * clobbered.
 */
async function enrichSyncedLink({
  bookmarkId,
  userId,
  item,
  connectionId,
  signal,
}: {
  bookmarkId: string;
  userId: string;
  item: SyncItem;
  connectionId: string;
  signal?: AbortSignal;
}) {
  let imageUrl: string | null = null;
  if (item.imageUrl) {
    const stored = await storeBannerImage(
      item.imageUrl,
      userId,
      bookmarkId,
      connectionId,
      signal,
    );
    // Keep the source URL as a fallback only if we managed to mirror the bytes;
    // an expired CDN URL with no asset renders as a broken image.
    if (stored) {
      imageUrl = item.imageUrl;
    }
  }

  await db
    .update(bookmarkLinks)
    .set({
      description: item.description ?? null,
      imageUrl,
      crawledAt: new Date(),
      crawlStatus: "success",
      crawlStatusCode: 200,
    })
    .where(eq(bookmarkLinks.id, bookmarkId));
}

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
    let importedCount = 0;
    let failedCount = 0;

    for (const item of result.newItems) {
      try {
        const bookmark = await trpcClient.bookmarks.createBookmark({
          type: BookmarkTypes.LINK,
          url: item.url,
          title: item.title,
          source: "sync",
        });

        await db
          .insert(socialSyncHistory)
          .values({
            connectionId,
            platformItemId: item.platformItemId,
            bookmarkId: bookmark.id,
          })
          .onConflictDoNothing();

        if (!bookmark.alreadyExists) {
          importedCount++;
          await recorder.incrementImported();

          // Only enrich freshly-created bookmarks; never overwrite the content
          // of a pre-existing one (it may have been edited or crawled already).
          if (item.description !== undefined || item.imageUrl !== undefined) {
            try {
              await enrichSyncedLink({
                bookmarkId: bookmark.id,
                userId: connection.userId,
                item,
                connectionId,
                signal: req.abortSignal,
              });
            } catch (e) {
              logger.warn(
                `[social-sync][${connectionId}] Imported ${item.url} but failed to enrich content: ${e}`,
              );
            }
          }
        }

        try {
          await attachSyncTags({
            userId: connection.userId,
            bookmarkId: bookmark.id,
            platform: connection.platform,
            autoTagName: connection.autoTagName,
            itemTags: item.tags,
          });
        } catch (e) {
          logger.warn(
            `[social-sync][${connectionId}] Imported ${item.url} but failed to attach tags: ${e}`,
          );
        }
      } catch (e) {
        failedCount++;
        logger.warn(
          `[social-sync][${connectionId}] Failed to create bookmark for ${item.url}: ${e}`,
        );
        await recorder.incrementFailed();
      }
    }

    await recorder.setPhase("finalizing");
    const hasImportFailures = failedCount > 0;
    await db
      .update(socialSyncConnections)
      .set(
        hasImportFailures
          ? {
              lastSyncStatus: "failure",
              lastSyncError: `Imported ${importedCount} saved items, failed ${failedCount}. Failed items will be retried.`,
              totalSynced: sql`${socialSyncConnections.totalSynced} + ${importedCount}`,
            }
          : {
              lastSyncedAt: new Date(),
              lastCursor: result.resumeCursor,
              backfillComplete: result.backfillComplete,
              lastSyncStatus: "success",
              lastSyncError: null,
              totalSynced: sql`${socialSyncConnections.totalSynced} + ${importedCount}`,
            },
      )
      .where(eq(socialSyncConnections.id, connectionId));

    if (hasImportFailures) {
      const error = `Failed to import ${failedCount} of ${result.newItems.length} saved items`;
      await recorder.finishFailure(error);
      logger.warn(
        `[social-sync][${connectionId}] Sync finished with failures: ${importedCount} imported, ${failedCount} failed`,
      );
      return;
    }

    await recorder.finishSuccess();
    logger.info(
      `[social-sync][${connectionId}] Sync complete: ${importedCount} new bookmarks`,
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

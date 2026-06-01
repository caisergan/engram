DELETE FROM `socialSyncHistory`
WHERE rowid NOT IN (
	SELECT MIN(rowid)
	FROM `socialSyncHistory`
	GROUP BY `connectionId`, `platformItemId`
);
--> statement-breakpoint
DROP INDEX `socialSyncHistory_connectionId_platformItemId_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `socialSyncHistory_connectionId_platformItemId_uniq` ON `socialSyncHistory` (`connectionId`,`platformItemId`);

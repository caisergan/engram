CREATE TABLE `socialSyncConnections` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`platform` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`authCookies` text NOT NULL,
	`lastSyncedAt` integer,
	`lastSyncStatus` text DEFAULT 'pending' NOT NULL,
	`lastSyncError` text,
	`syncIntervalMinutes` integer DEFAULT 60 NOT NULL,
	`autoTagName` text,
	`lastCursor` text,
	`totalSynced` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `socialSyncConnections_userId_idx` ON `socialSyncConnections` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `socialSyncConnections_userId_platform_uniq` ON `socialSyncConnections` (`userId`,`platform`);--> statement-breakpoint
CREATE TABLE `socialSyncHistory` (
	`id` text PRIMARY KEY NOT NULL,
	`connectionId` text NOT NULL,
	`platformItemId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `socialSyncConnections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `socialSyncHistory_connectionId_platformItemId_idx` ON `socialSyncHistory` (`connectionId`,`platformItemId`);--> statement-breakpoint
CREATE INDEX `socialSyncHistory_bookmarkId_idx` ON `socialSyncHistory` (`bookmarkId`);
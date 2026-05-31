CREATE TABLE `socialSyncRuns` (
	`id` text PRIMARY KEY NOT NULL,
	`connectionId` text NOT NULL,
	`jobId` text,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text,
	`pagesScanned` integer DEFAULT 0 NOT NULL,
	`itemsFound` integer DEFAULT 0 NOT NULL,
	`itemsImported` integer DEFAULT 0 NOT NULL,
	`itemsFailed` integer DEFAULT 0 NOT NULL,
	`error` text,
	`startedAt` integer NOT NULL,
	`finishedAt` integer,
	FOREIGN KEY (`connectionId`) REFERENCES `socialSyncConnections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `socialSyncRuns_connectionId_startedAt_idx` ON `socialSyncRuns` (`connectionId`,`startedAt`);
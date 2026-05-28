ALTER TABLE `assets` ADD `encrypted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `vaulted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `encryptedTitle` text;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `encryptedUrl` text;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `encryptedNote` text;--> statement-breakpoint
CREATE INDEX `bookmarks_userId_vaulted_createdAt_id_idx` ON `bookmarks` (`userId`,`vaulted`,`createdAt`,`id`);--> statement-breakpoint
ALTER TABLE `user` ADD `vaultPinHash` text;--> statement-breakpoint
ALTER TABLE `user` ADD `vaultPinSalt` text;--> statement-breakpoint
ALTER TABLE `user` ADD `vaultEncryptionSalt` text;--> statement-breakpoint
ALTER TABLE `user` ADD `vaultAutoLockMinutes` integer DEFAULT 5 NOT NULL;
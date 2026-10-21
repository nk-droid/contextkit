CREATE TABLE `facts_documents` (
	`repository_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_label` text NOT NULL,
	`revision` text,
	`artifact_id` text NOT NULL,
	`component_count` integer NOT NULL,
	`symbol_count` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `facts_documents_updated_at_idx` ON `facts_documents` (`updated_at`);
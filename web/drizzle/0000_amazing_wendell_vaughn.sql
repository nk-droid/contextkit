CREATE TABLE `graph_documents` (
	`repository_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`revision` text,
	`description` text,
	`schema_version` integer NOT NULL,
	`graph_count` integer NOT NULL,
	`node_count` integer NOT NULL,
	`edge_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

-- Sahale Career v0.1 — the internship application tracker.
--
-- Additive only: two new tables and their indexes. No existing table is
-- altered or rebuilt and no row is touched, so Fitness data, conversations
-- and settings come through byte-for-byte.
-- * career_applications: one row per employer-position application. Only the
--   company is required; an unknown title or detail stays NULL.
-- * career_status_changes: append-only status history, removed only together
--   with its application (ON DELETE CASCADE).
-- Both tables start empty: no demo or prototype records are inserted.

CREATE TABLE `career_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`role` text,
	`term` text,
	`posting_url` text,
	`source` text,
	`portal_url` text,
	`location` text,
	`track` text,
	`status` text NOT NULL,
	`applied_on` text,
	`deadline` text,
	`resume_ref` text,
	`referral` text,
	`next_action` text,
	`next_action_due` text,
	`notes` text,
	`evidence_url` text,
	`status_changed_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "career_applications_named" CHECK(length(trim("career_applications"."company")) > 0 AND ("career_applications"."role" IS NULL OR length(trim("career_applications"."role")) > 0))
);
--> statement-breakpoint
CREATE INDEX `career_applications_status` ON `career_applications` (`status`);--> statement-breakpoint
CREATE TABLE `career_status_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_at` text NOT NULL,
	`occurred_on` text,
	FOREIGN KEY (`application_id`) REFERENCES `career_applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `career_status_changes_application` ON `career_status_changes` (`application_id`,`changed_at`);
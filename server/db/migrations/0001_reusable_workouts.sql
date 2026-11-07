-- Sahale v0.1.1 — reusable workouts + live session logging.
--
-- Hand-written (drizzle-kit can't express the data moves). Runs inside the
-- runtime's single migration transaction with foreign keys off; the runner
-- backs the database up first and requires foreign_key_check to pass.
--
-- What happens to existing rows:
-- * Goals, blocks, exercises, notes, conversations: untouched.
-- * v0.1 dated workouts become plans (date overlays) that keep their exact
--   prescription (own_prescription = 1) and are flagged legacy = 1. No
--   reusable template is invented for them.
-- * A single rep count becomes rep_min = rep_max. A load of 0 meant "none
--   prescribed" and becomes NULL. A numeric RPE becomes target_rpe; anything
--   else (e.g. "7–8") and any reps label (e.g. "10/leg") is kept verbatim in
--   the note, labelled, rather than guessed at.
-- * Session entries' JSON prescription snapshot becomes structured columns
--   the same way. An unreadable snapshot is kept as text in target_note.
-- * Logged sets are copied as they are (load/reps become nullable).
-- * Pending v0.1 workout proposals are marked stale: their format no longer
--   matches the model. Applied ones stay as history.

CREATE TABLE `fitness_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`focus` text,
	`notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `fitness_blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `fitness_templates_block` ON `fitness_templates` (`block_id`,`position`);
--> statement-breakpoint
CREATE TABLE `fitness_template_items` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`sets` integer NOT NULL,
	`rep_min` integer NOT NULL,
	`rep_max` integer NOT NULL,
	`target_rpe` real,
	`target_load` real,
	`note` text,
	FOREIGN KEY (`template_id`) REFERENCES `fitness_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `fitness_exercises`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fitness_template_items_reps" CHECK("fitness_template_items"."rep_min" <= "fitness_template_items"."rep_max")
);
--> statement-breakpoint
CREATE INDEX `fitness_template_items_template` ON `fitness_template_items` (`template_id`);
--> statement-breakpoint

-- Plans: v0.1 dated workouts, kept with their own prescriptions.
CREATE TABLE `fitness_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text,
	`block_id` text,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`focus` text,
	`notes` text,
	`own_prescription` integer DEFAULT false NOT NULL,
	`legacy` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `fitness_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`block_id`) REFERENCES `fitness_blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `fitness_plans` (`id`, `template_id`, `block_id`, `date`, `name`, `focus`, `notes`, `own_prescription`, `legacy`, `version`, `origin`, `created_at`, `updated_at`)
SELECT `id`, NULL, `block_id`, `date`, `name`, `focus`, `notes`, 1, 1, `version`, `origin`, `created_at`, `updated_at` FROM `fitness_workouts`;
--> statement-breakpoint
CREATE INDEX `fitness_plans_date` ON `fitness_plans` (`date`);
--> statement-breakpoint
CREATE INDEX `fitness_plans_template` ON `fitness_plans` (`template_id`);
--> statement-breakpoint
CREATE TABLE `fitness_plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`sets` integer NOT NULL,
	`rep_min` integer NOT NULL,
	`rep_max` integer NOT NULL,
	`target_rpe` real,
	`target_load` real,
	`note` text,
	`adjusted_by` text,
	`adjustment_note` text,
	FOREIGN KEY (`plan_id`) REFERENCES `fitness_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `fitness_exercises`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fitness_plan_items_reps" CHECK("fitness_plan_items"."rep_min" <= "fitness_plan_items"."rep_max")
);
--> statement-breakpoint
INSERT INTO `fitness_plan_items` (`id`, `plan_id`, `position`, `exercise_id`, `sets`, `rep_min`, `rep_max`, `target_rpe`, `target_load`, `note`, `adjusted_by`, `adjustment_note`)
SELECT `id`, `workout_id`, `position`, `exercise_id`, `sets`, `reps`, `reps`, `rpe_num`, NULLIF(`load`, 0),
	NULLIF(LTRIM(
		COALESCE(`note`, '')
		|| CASE WHEN `reps_label` IS NOT NULL AND TRIM(`reps_label`) <> '' AND TRIM(`reps_label`) <> CAST(`reps` AS TEXT) THEN ' · Reps: ' || TRIM(`reps_label`) ELSE '' END
		|| CASE WHEN `rpe_num` IS NULL AND `rpe` IS NOT NULL AND TRIM(`rpe`) <> '' THEN ' · RPE ' || TRIM(`rpe`) ELSE '' END,
	' ·'), ''),
	`adjusted_by`, `adjustment_note`
FROM (
	SELECT *,
		CASE WHEN `rpe` IS NOT NULL AND TRIM(`rpe`) <> '' AND TRIM(`rpe`) NOT GLOB '*[^0-9.]*'
			AND CAST(TRIM(`rpe`) AS REAL) BETWEEN 1 AND 10
			AND CAST(TRIM(`rpe`) AS REAL) * 2 = CAST(CAST(TRIM(`rpe`) AS REAL) * 2 AS INTEGER)
		THEN CAST(TRIM(`rpe`) AS REAL) END AS `rpe_num`
	FROM `fitness_workout_items`
);
--> statement-breakpoint
CREATE INDEX `fitness_plan_items_plan` ON `fitness_plan_items` (`plan_id`);
--> statement-breakpoint

-- Sessions: workout_id → plan_id; template link; structural version; one live session at a time.
CREATE TABLE `__new_fitness_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text,
	`template_id` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_min` integer,
	`note` text,
	`readiness` integer,
	`block_id` text,
	`week` integer,
	`is_deload` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `fitness_plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `fitness_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`block_id`) REFERENCES `fitness_blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_fitness_sessions` (`id`, `plan_id`, `template_id`, `name`, `status`, `started_at`, `ended_at`, `duration_min`, `note`, `readiness`, `block_id`, `week`, `is_deload`, `version`, `origin`, `created_at`, `updated_at`)
SELECT `id`, `workout_id`, NULL, `name`, `status`, `started_at`, `ended_at`, `duration_min`, `note`, `readiness`, `block_id`, `week`, `is_deload`, 1, `origin`, `created_at`, `updated_at` FROM `fitness_sessions`;
--> statement-breakpoint
DROP TABLE `fitness_sessions`;
--> statement-breakpoint
ALTER TABLE `__new_fitness_sessions` RENAME TO `fitness_sessions`;
--> statement-breakpoint
CREATE INDEX `fitness_sessions_started` ON `fitness_sessions` (`started_at`);
--> statement-breakpoint
CREATE INDEX `fitness_sessions_status` ON `fitness_sessions` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_sessions_one_active` ON `fitness_sessions` (`status`) WHERE status = 'active';
--> statement-breakpoint

-- Session entries: JSON prescription snapshot → structured columns.
CREATE TABLE `__new_fitness_session_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`note` text,
	`target_sets` integer,
	`target_rep_min` integer,
	`target_rep_max` integer,
	`target_rpe` real,
	`target_load` real,
	`target_note` text,
	`adjusted_by` text,
	`adjustment_note` text,
	FOREIGN KEY (`session_id`) REFERENCES `fitness_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `fitness_exercises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_fitness_session_entries` (`id`, `session_id`, `position`, `exercise_id`, `note`, `target_sets`, `target_rep_min`, `target_rep_max`, `target_rpe`, `target_load`, `target_note`, `adjusted_by`, `adjustment_note`)
SELECT `id`, `session_id`, `position`, `exercise_id`, `note`,
	CASE WHEN `ok` THEN `t_sets` END,
	CASE WHEN `ok` THEN `t_reps` END,
	CASE WHEN `ok` THEN `t_reps` END,
	CASE WHEN `ok` THEN `t_rpe_num` END,
	CASE WHEN `ok` THEN NULLIF(`t_load`, 0) END,
	CASE
		WHEN `ok` THEN NULLIF(LTRIM(
			COALESCE(`t_note`, '')
			|| CASE WHEN `t_label` IS NOT NULL AND TRIM(`t_label`) <> '' AND TRIM(`t_label`) <> CAST(`t_reps` AS TEXT) THEN ' · Reps: ' || TRIM(`t_label`) ELSE '' END
			|| CASE WHEN `t_rpe_num` IS NULL AND `t_rpe` IS NOT NULL AND TRIM(`t_rpe`) <> '' THEN ' · RPE ' || TRIM(`t_rpe`) ELSE '' END,
		' ·'), '')
		WHEN `target` IS NOT NULL THEN 'v0.1 prescription could not be read: ' || SUBSTR(`target`, 1, 200)
	END,
	CASE WHEN `ok` AND `t_adj` IN ('owner', 'sahale') THEN `t_adj` END,
	CASE WHEN `ok` THEN `t_adj_note` END
FROM (
	SELECT *,
		COALESCE(typeof(`t_sets`) = 'integer' AND typeof(`t_reps`) = 'integer' AND `t_sets` >= 1 AND `t_reps` >= 0, 0) AS `ok`,
		CASE
			WHEN typeof(`t_rpe`) IN ('integer', 'real') AND `t_rpe` BETWEEN 1 AND 10 AND `t_rpe` * 2 = CAST(`t_rpe` * 2 AS INTEGER) THEN CAST(`t_rpe` AS REAL)
			WHEN typeof(`t_rpe`) = 'text' AND TRIM(`t_rpe`) <> '' AND TRIM(`t_rpe`) NOT GLOB '*[^0-9.]*'
				AND CAST(TRIM(`t_rpe`) AS REAL) BETWEEN 1 AND 10
				AND CAST(TRIM(`t_rpe`) AS REAL) * 2 = CAST(CAST(TRIM(`t_rpe`) AS REAL) * 2 AS INTEGER)
			THEN CAST(TRIM(`t_rpe`) AS REAL)
		END AS `t_rpe_num`
	FROM (
		SELECT *,
			json_extract(`j`, '$.sets') AS `t_sets`,
			json_extract(`j`, '$.reps') AS `t_reps`,
			json_extract(`j`, '$.load') AS `t_load`,
			json_extract(`j`, '$.rpe') AS `t_rpe`,
			json_extract(`j`, '$.repsLabel') AS `t_label`,
			json_extract(`j`, '$.note') AS `t_note`,
			json_extract(`j`, '$.adjustedBy') AS `t_adj`,
			json_extract(`j`, '$.adjustmentNote') AS `t_adj_note`
		FROM (SELECT *, CASE WHEN json_valid(`target`) THEN CASE WHEN json_type(`target`) = 'object' THEN `target` END END AS `j` FROM `fitness_session_entries`)
	)
);
--> statement-breakpoint
DROP TABLE `fitness_session_entries`;
--> statement-breakpoint
ALTER TABLE `__new_fitness_session_entries` RENAME TO `fitness_session_entries`;
--> statement-breakpoint
CREATE INDEX `fitness_session_entries_session` ON `fitness_session_entries` (`session_id`);
--> statement-breakpoint

-- Session sets: load/reps nullable until entered; a per-set note.
CREATE TABLE `__new_fitness_session_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`position` integer NOT NULL,
	`weight` real,
	`reps` integer,
	`rpe` real,
	`done` integer DEFAULT false NOT NULL,
	`note` text,
	FOREIGN KEY (`entry_id`) REFERENCES `fitness_session_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_fitness_session_sets` (`id`, `entry_id`, `position`, `weight`, `reps`, `rpe`, `done`, `note`)
SELECT `id`, `entry_id`, `position`, `weight`, `reps`, `rpe`, `done`, NULL FROM `fitness_session_sets`;
--> statement-breakpoint
DROP TABLE `fitness_session_sets`;
--> statement-breakpoint
ALTER TABLE `__new_fitness_session_sets` RENAME TO `fitness_session_sets`;
--> statement-breakpoint
CREATE INDEX `fitness_session_sets_entry` ON `fitness_session_sets` (`entry_id`);
--> statement-breakpoint

DROP TABLE `fitness_workout_items`;
--> statement-breakpoint
DROP TABLE `fitness_workouts`;
--> statement-breakpoint

UPDATE `proposals`
SET `status` = 'stale',
	`last_error` = 'Sahale v0.1.1 changed how workouts are stored (reusable workouts + live sessions), so this v0.1 proposal can no longer be applied. Ask again for a fresh one.',
	`decided_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` = 'pending' AND `kind` = 'fitness.adjust_workout';

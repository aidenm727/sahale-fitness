CREATE TABLE `fitness_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phase` text DEFAULT '' NOT NULL,
	`intent` text DEFAULT '' NOT NULL,
	`scheme` text DEFAULT '' NOT NULL,
	`start_date` text NOT NULL,
	`weeks` integer NOT NULL,
	`deload_week` integer,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `committed_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`via` text NOT NULL,
	`proposal_id` text,
	`reverts_action_id` text,
	`reverted_by_action_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`summary` text NOT NULL,
	`before_state` text NOT NULL,
	`after_state` text NOT NULL,
	`before_version` integer,
	`after_version` integer,
	`committed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `committed_actions_target` ON `committed_actions` (`target_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`context_include` text DEFAULT '[]' NOT NULL,
	`context_exclude` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_one_active_per_scope` ON `conversations` (`scope_key`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `fitness_exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short` text,
	`pattern` text NOT NULL,
	`equipment` text DEFAULT '' NOT NULL,
	`is_main` integer DEFAULT false NOT NULL,
	`is_bodyweight` integer DEFAULT false NOT NULL,
	`cues` text DEFAULT '[]' NOT NULL,
	`note` text,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fitness_goal_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`target_load` real NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `fitness_goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `fitness_exercises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fitness_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`statement` text NOT NULL,
	`target_date` text,
	`bodyweight_target` real,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fitness_goals_status` ON `fitness_goals` (`status`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`focus` text,
	`context_labels` text,
	`needs` text,
	`error` text,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_label` text NOT NULL,
	`mode` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`error_category` text,
	`error_code` text,
	`error_message` text,
	`request_id` text,
	`usage` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`latency_ms` integer,
	`first_token_ms` integer,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`context_items` integer DEFAULT 0 NOT NULL,
	`manifest` text NOT NULL,
	`instructions` text NOT NULL,
	`input` text NOT NULL,
	`raw_output` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_runs_started` ON `model_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `fitness_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`tag` text,
	`pinned` integer DEFAULT true NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`payload` text NOT NULL,
	`target_id` text,
	`target_version` integer,
	`problems` text,
	`last_error` text,
	`action_id` text,
	`created_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE INDEX `proposals_conversation` ON `proposals` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `fitness_session_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`note` text,
	`target` text,
	FOREIGN KEY (`session_id`) REFERENCES `fitness_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `fitness_exercises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fitness_session_entries_session` ON `fitness_session_entries` (`session_id`);--> statement-breakpoint
CREATE TABLE `fitness_session_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`position` integer NOT NULL,
	`weight` real NOT NULL,
	`reps` integer NOT NULL,
	`rpe` real,
	`done` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `fitness_session_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fitness_session_sets_entry` ON `fitness_session_sets` (`entry_id`);--> statement-breakpoint
CREATE TABLE `fitness_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text,
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
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workout_id`) REFERENCES `fitness_workouts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`block_id`) REFERENCES `fitness_blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `fitness_sessions_started` ON `fitness_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `fitness_sessions_status` ON `fitness_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fitness_workout_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`sets` integer NOT NULL,
	`reps` integer NOT NULL,
	`reps_label` text,
	`load` real DEFAULT 0 NOT NULL,
	`rpe` text,
	`note` text,
	`adjusted_by` text,
	`adjustment_note` text,
	FOREIGN KEY (`workout_id`) REFERENCES `fitness_workouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `fitness_exercises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fitness_workout_items_workout` ON `fitness_workout_items` (`workout_id`);--> statement-breakpoint
CREATE TABLE `fitness_workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text,
	`date` text NOT NULL,
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
CREATE INDEX `fitness_workouts_date` ON `fitness_workouts` (`date`);
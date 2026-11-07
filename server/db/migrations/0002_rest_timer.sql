-- Sahale v0.1.2 — rest timer.
--
-- Additive only: new nullable columns, no table rebuild, no data moved.
-- * fitness_exercises.rest_sec: the rest after each set of that exercise
--   (seconds; 0 = no timer; NULL = the default for its kind).
-- * fitness_sessions.rest_*: the live workout's current rest, stored as a
--   deadline so it survives a locked phone, a reload or a runtime restart.
-- Existing rows are untouched; every new column starts NULL.

ALTER TABLE `fitness_exercises` ADD `rest_sec` integer;--> statement-breakpoint
ALTER TABLE `fitness_sessions` ADD `rest_set_id` text;--> statement-breakpoint
ALTER TABLE `fitness_sessions` ADD `rest_sec` integer;--> statement-breakpoint
ALTER TABLE `fitness_sessions` ADD `rest_ends_at` text;--> statement-breakpoint
ALTER TABLE `fitness_sessions` ADD `rest_paused_ms` integer;

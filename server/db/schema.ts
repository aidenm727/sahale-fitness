/**
 * The durable state. Edit this, then `npm run db:generate` to produce a new SQL
 * migration in server/db/migrations (never edit an applied migration).
 *
 * The migrations also create tables from an earlier version of the app that nothing here
 * defines any more; they stay in existing databases, unused, and `db:generate` will want to
 * drop them. See "Migrations" in README.md before generating one.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const origin = () => text('origin', { enum: ['owner', 'demo', 'library'] }).notNull()
const createdAt = () => text('created_at').notNull()
const updatedAt = () => text('updated_at').notNull()

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: updatedAt(),
})

/* ------------------------------------------------------------------ */
/* Fitness                                                             */
/* ------------------------------------------------------------------ */

export const exercises = sqliteTable('fitness_exercises', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  short: text('short'),
  pattern: text('pattern').notNull(),
  equipment: text('equipment').notNull().default(''),
  isMain: integer('is_main', { mode: 'boolean' }).notNull().default(false),
  isBodyweight: integer('is_bodyweight', { mode: 'boolean' }).notNull().default(false),
  cues: text('cues', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  note: text('note'),
  /** Rest after each set, in seconds; 0 = no timer; null = the default for its kind. */
  restSec: integer('rest_sec'),
  origin: origin(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const goals = sqliteTable(
  'fitness_goals',
  {
    id: text('id').primaryKey(),
    statement: text('statement').notNull(),
    targetDate: text('target_date'),
    bodyweightTarget: real('bodyweight_target'),
    status: text('status', { enum: ['active', 'archived'] }).notNull(),
    origin: origin(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('fitness_goals_status').on(t.status)],
)

export const goalTargets = sqliteTable('fitness_goal_targets', {
  id: text('id').primaryKey(),
  goalId: text('goal_id')
    .notNull()
    .references(() => goals.id, { onDelete: 'cascade' }),
  exerciseId: text('exercise_id')
    .notNull()
    .references(() => exercises.id),
  targetLoad: real('target_load').notNull(),
  position: integer('position').notNull(),
})

export const blocks = sqliteTable('fitness_blocks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phase: text('phase').notNull().default(''),
  intent: text('intent').notNull().default(''),
  scheme: text('scheme').notNull().default(''),
  startDate: text('start_date').notNull(),
  weeks: integer('weeks').notNull(),
  deloadWeek: integer('deload_week'),
  origin: origin(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * A reusable workout ("Lower A"). Not tied to a date: it belongs to a block,
 * sits in the block's normal order, and is started whenever the owner trains.
 */
export const templates = sqliteTable(
  'fitness_templates',
  {
    id: text('id').primaryKey(),
    blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    /** Order within the block (the normal sequence: Upper A, Lower A, …). */
    position: integer('position').notNull(),
    name: text('name').notNull(),
    focus: text('focus'),
    notes: text('notes'),
    /** Bumped on every change, for optimistic concurrency. */
    version: integer('version').notNull().default(1),
    origin: origin(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('fitness_templates_block').on(t.blockId, t.position)],
)

/** Prescription columns shared by template items and plan items. */
const prescription = () => ({
  exerciseId: text('exercise_id')
    .notNull()
    .references(() => exercises.id),
  sets: integer('sets').notNull(),
  repMin: integer('rep_min').notNull(),
  repMax: integer('rep_max').notNull(),
  targetRpe: real('target_rpe'),
  targetLoad: real('target_load'),
  note: text('note'),
})

export const templateItems = sqliteTable(
  'fitness_template_items',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    ...prescription(),
  },
  (t) => [index('fitness_template_items_template').on(t.templateId), check('fitness_template_items_reps', sql`${t.repMin} <= ${t.repMax}`)],
)

/**
 * An optional date overlay: "Lower A on Oct 8". Removing or moving it never
 * touches the template. A plan normally uses its template's current
 * prescription; it carries its own (`ownPrescription`) only when one day was
 * adjusted on purpose, or when it came from v0.1's dated workouts (`legacy`).
 */
export const plans = sqliteTable(
  'fitness_plans',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').references(() => templates.id, { onDelete: 'set null' }),
    blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    date: text('date').notNull(),
    /** Display name when there is no template (legacy) — otherwise the template's name wins. */
    name: text('name').notNull(),
    focus: text('focus'),
    notes: text('notes'),
    ownPrescription: integer('own_prescription', { mode: 'boolean' }).notNull().default(false),
    /** Migrated from a v0.1 dated workout; no template was invented for it. */
    legacy: integer('legacy', { mode: 'boolean' }).notNull().default(false),
    version: integer('version').notNull().default(1),
    origin: origin(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('fitness_plans_date').on(t.date), index('fitness_plans_template').on(t.templateId)],
)

export const planItems = sqliteTable(
  'fitness_plan_items',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    ...prescription(),
    adjustedBy: text('adjusted_by', { enum: ['owner', 'sahale'] }),
    adjustmentNote: text('adjustment_note'),
  },
  (t) => [index('fitness_plan_items_plan').on(t.planId), check('fitness_plan_items_reps', sql`${t.repMin} <= ${t.repMax}`)],
)

/** An actual workout: started, logged set by set, finished into history. */
export const sessions = sqliteTable(
  'fitness_sessions',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').references(() => plans.id, { onDelete: 'set null' }),
    templateId: text('template_id').references(() => templates.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'completed'] }).notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    durationMin: integer('duration_min'),
    note: text('note'),
    readiness: integer('readiness'),
    blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    week: integer('week'),
    isDeload: integer('is_deload', { mode: 'boolean' }).notNull().default(false),
    /** Bumped when the session's prescription/structure changes (not when sets are logged). */
    version: integer('version').notNull().default(1),
    /**
     * The rest after the last completed set, as a deadline rather than a
     * counter, so it stays right however long the phone was locked. Only
     * meaningful while `rest_set_id` names a done set of this live session.
     */
    restSetId: text('rest_set_id'),
    /** Planned length in seconds, adjustments included (for the progress bar). */
    restSec: integer('rest_sec'),
    /** When the rest ends while it runs; null while paused. */
    restEndsAt: text('rest_ends_at'),
    /** Time left while paused. */
    restPausedMs: integer('rest_paused_ms'),
    origin: origin(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('fitness_sessions_started').on(t.startedAt),
    index('fitness_sessions_status').on(t.status),
    uniqueIndex('fitness_sessions_one_active').on(t.status).where(sql`status = 'active'`),
  ],
)

/**
 * One exercise in a session. The `target*` columns are a snapshot of the
 * prescription when the session started (null when added ad hoc) — later
 * template edits never reach back into history.
 */
export const sessionEntries = sqliteTable(
  'fitness_session_entries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    exerciseId: text('exercise_id')
      .notNull()
      .references(() => exercises.id),
    note: text('note'),
    targetSets: integer('target_sets'),
    targetRepMin: integer('target_rep_min'),
    targetRepMax: integer('target_rep_max'),
    targetRpe: real('target_rpe'),
    targetLoad: real('target_load'),
    targetNote: text('target_note'),
    adjustedBy: text('adjusted_by', { enum: ['owner', 'sahale'] }),
    adjustmentNote: text('adjustment_note'),
  },
  (t) => [index('fitness_session_entries_session').on(t.sessionId)],
)

/** What was actually performed. Load/reps stay empty until the owner enters them. */
export const sessionSets = sqliteTable(
  'fitness_session_sets',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => sessionEntries.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    weight: real('weight'),
    reps: integer('reps'),
    rpe: real('rpe'),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
  },
  (t) => [index('fitness_session_sets_entry').on(t.entryId)],
)

export const notes = sqliteTable('fitness_notes', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  tag: text('tag'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(true),
  origin: origin(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

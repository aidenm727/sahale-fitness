/**
 * Validation for everything that crosses into the runtime. The server parses API
 * inputs with these before touching state.
 */
import { z } from 'zod'
import { isDateKey } from './dates'
import { MAX_REST_SEC } from './fitness/derive'
import { NOTE_TAGS, PATTERNS } from './fitness/types'

const id = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/, 'Invalid id')
const dateKey = z.string().refine(isDateKey, 'Expected a calendar date (YYYY-MM-DD)')
const isoTime = z.string().datetime({ offset: true })
const text = (max: number) => z.string().trim().max(max)
const load = z.number().finite().min(0).max(2000)
const sets = z.number().int().min(1).max(20)
const reps = z.number().int().min(0).max(100)
const rpe = z.number().min(1).max(10).multipleOf(0.5)
const repRange = <T extends { repMin?: number; repMax?: number }>(p: T) => p.repMin === undefined || p.repMax === undefined || p.repMin <= p.repMax
const repRangeIssue = { message: 'The low end of the rep range must not exceed the high end', path: ['repMax'] }

/* ------------------------------------------------------------------ */
/* Fitness API inputs                                                  */
/* ------------------------------------------------------------------ */

export const GoalInput = z.object({
  statement: text(500).min(1),
  date: dateKey.optional(),
  bodyweightTarget: z.number().min(50).max(600).optional(),
  targets: z.array(z.object({ exerciseId: id, target: load.positive() })).max(12).default([]),
})
export type GoalInput = z.infer<typeof GoalInput>

export const BlockInput = z.object({
  name: text(80).min(1),
  phase: text(40).default(''),
  intent: text(500).default(''),
  scheme: text(60).default(''),
  startDate: dateKey,
  weeks: z.number().int().min(1).max(26),
  deloadWeek: z.number().int().min(1).max(26).optional(),
})
export type BlockInput = z.infer<typeof BlockInput>

/** One prescribed exercise: sets × a rep range (5–8, or exact when equal), optional RPE and load. */
export const PrescriptionInput = z
  .object({
    id: id.optional(),
    exerciseId: id,
    sets,
    repMin: reps,
    repMax: reps,
    rpe: rpe.optional(),
    load: load.optional(),
    note: text(300).optional(),
  })
  .refine(repRange, repRangeIssue)
export type PrescriptionInput = z.infer<typeof PrescriptionInput>

export const TemplateInput = z.object({
  name: text(80).min(1),
  focus: text(60).optional(),
  blockId: id.nullable().optional(),
  notes: text(1000).optional(),
  items: z.array(PrescriptionInput).max(20).default([]),
})
export type TemplateInput = z.infer<typeof TemplateInput>

export const TemplatePatch = z.object({
  name: text(80).min(1).optional(),
  focus: text(60).optional(),
  blockId: id.nullable().optional(),
  notes: text(1000).optional(),
  items: z.array(PrescriptionInput).max(20).optional(),
  /** Optimistic concurrency: the version the editor started from. */
  version: z.number().int().min(1),
})
export type TemplatePatch = z.infer<typeof TemplatePatch>

export const TemplateOrderInput = z.object({ blockId: id.nullable(), ids: z.array(id).min(1).max(40) })
export const DuplicateTemplateInput = z.object({ name: text(80).min(1).optional() })

export const PlanInput = z.object({ templateId: id, date: dateKey, notes: text(500).optional() })
export const PlanPatch = z.object({
  version: z.number().int().min(1),
  date: dateKey.optional(),
  notes: text(500).optional(),
  /** Give this one day its own prescription (the template is not touched). */
  items: z.array(PrescriptionInput).max(20).optional(),
})
export type PlanPatch = z.infer<typeof PlanPatch>
export const PlanVersion = z.object({ version: z.number().int().min(1) })

const exerciseFields = {
  name: text(80).min(1),
  short: text(24).optional(),
  pattern: z.enum(PATTERNS),
  equipment: text(80),
  main: z.boolean(),
  bodyweight: z.boolean(),
  cues: z.array(text(200).min(1)).max(12),
  note: text(500).optional(),
  /** Rest after each set in seconds; 0 = no timer; null = the default for its kind. */
  restSec: z.number().int().min(0).max(MAX_REST_SEC).nullable().optional(),
}
export const ExerciseInput = z.object({
  ...exerciseFields,
  /** Movement family; "Other" when the owner doesn't say. */
  pattern: exerciseFields.pattern.default('Other'),
  equipment: exerciseFields.equipment.default(''),
  main: exerciseFields.main.default(false),
  bodyweight: exerciseFields.bodyweight.default(false),
  cues: exerciseFields.cues.default([]),
})
export type ExerciseInput = z.infer<typeof ExerciseInput>
/** Changes only the fields sent: no defaults, so a one-field edit can't reset the others. */
export const ExercisePatch = z.object(exerciseFields).partial()

export const StartSessionInput = z.object({
  templateId: id.optional(),
  planId: id.optional(),
  name: text(80).optional(),
  /** Backfilling a past session; defaults to now. */
  startedAt: isoTime.optional(),
})
export type StartSessionInput = z.infer<typeof StartSessionInput>

export const SessionPatch = z.object({
  name: text(80).min(1).optional(),
  note: text(2000).optional(),
  readiness: z.number().int().min(1).max(5).nullable().optional(),
  startedAt: isoTime.optional(),
  durationMin: z.number().int().min(1).max(600).optional(),
})

/** The live workout's rest: skip it, pause / resume it, or give it more or less time. */
export const RestInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('skip') }).strict(),
  z.object({ op: z.literal('pause') }).strict(),
  z.object({ op: z.literal('resume') }).strict(),
  z.object({ op: z.literal('adjust'), sec: z.number().int().min(-MAX_REST_SEC).max(MAX_REST_SEC).refine((n) => n !== 0, 'Adjust by a non-zero amount') }).strict(),
])
export type RestInput = z.infer<typeof RestInput>

export const AddEntryInput = z.object({ exerciseId: id })

/** What actually happened in one set. `null` clears a value. */
export const SetPatch = z.object({
  weight: load.nullable().optional(),
  reps: reps.nullable().optional(),
  rpe: rpe.nullable().optional(),
  done: z.boolean().optional(),
  note: text(200).nullable().optional(),
})
export type SetPatch = z.infer<typeof SetPatch>

export const FinishSessionInput = z.object({
  durationMin: z.number().int().min(1).max(600).optional(),
  /** Also log sets that have reps entered but weren't ticked done. */
  keepUnticked: z.boolean().default(false),
})
export type FinishSessionInput = z.infer<typeof FinishSessionInput>

export const NoteInput = z.object({
  text: text(2000).min(1),
  tag: z.enum(NOTE_TAGS).optional(),
  pinned: z.boolean().default(true),
})
export const NotePatch = z.object({
  text: text(2000).min(1).optional(),
  tag: z.enum(NOTE_TAGS).nullable().optional(),
  pinned: z.boolean().optional(),
})

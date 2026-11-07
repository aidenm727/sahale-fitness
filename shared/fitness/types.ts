/**
 * Fitness — the shapes Sahale's runtime hands to the browser.
 *
 * The server owns these records (SQLite). The browser only ever renders a
 * snapshot and asks the server to change it.
 */

/** Where a record came from. Demo rows can be cleared without touching the owner's. */
export type Origin = 'owner' | 'demo' | 'library'

export const PATTERNS = ['Squat', 'Hinge', 'Press', 'Pull', 'Core', 'Accessory', 'Conditioning', 'Other'] as const
export type Pattern = (typeof PATTERNS)[number]

export const NOTE_TAGS = ['body', 'technique', 'program', 'logistics'] as const
export type NoteTag = (typeof NOTE_TAGS)[number]

export interface Exercise {
  id: string
  name: string
  short?: string
  /** Movement family / category. */
  pattern: Pattern
  main: boolean
  equipment: string
  bodyweight: boolean
  cues: string[]
  note?: string
  /** Rest after each set, in seconds (0 = no timer). Absent = the default for its kind (see restSecFor). */
  restSec?: number
  /** 'library' = built in; 'owner' = created in Sahale by the owner. */
  origin: Origin
}

export interface GoalTarget {
  exerciseId: string
  target: number
}

export interface Goal {
  id: string
  statement: string
  /** Test day / target date (YYYY-MM-DD). */
  date?: string
  bodyweightTarget?: number
  targets: GoalTarget[]
  origin: Origin
  updatedAt: string
}

export interface Block {
  id: string
  n: number
  name: string
  phase: string
  intent: string
  scheme: string
  startDate: string
  weeks: number
  deloadWeek?: number
  /** Last calendar day of the block (inclusive). */
  endDate: string
  status: 'done' | 'current' | 'planned'
  origin: Origin
  updatedAt: string
}

/**
 * What to do for one exercise. A rep range is first-class: 5–8 is
 * `repMin: 5, repMax: 8`; an exact target has `repMin === repMax`.
 */
export interface Prescription {
  id?: string
  exerciseId: string
  sets: number
  repMin: number
  repMax: number
  /** Target RPE (e.g. 8 or 7.5). */
  rpe?: number
  /** Target load in lb, when one is prescribed. */
  load?: number
  note?: string
  adjustedBy?: 'owner' | 'sahale'
  adjustmentNote?: string
}

export type PrescribedItem = Prescription & { id: string }

/** A reusable workout in a block ("Lower A"). Has no date. */
export interface WorkoutTemplate {
  id: string
  blockId?: string
  position: number
  name: string
  focus?: string
  notes?: string
  version: number
  items: PrescribedItem[]
  /** Most recent completed session started from this template. */
  lastSessionId?: string
  lastDoneAt?: string
  /** Open (not yet fulfilled) plans for this template, soonest first. */
  planIds: string[]
  origin: Origin
  updatedAt: string
}

export type PlanStatus = 'planned' | 'today' | 'active' | 'done' | 'missed'

/**
 * An optional date overlay on a template ("Lower A on Oct 8"). Clearing or
 * moving it never touches the template; missing the date logs nothing.
 */
export interface Plan {
  id: string
  templateId?: string
  date: string
  name: string
  focus?: string
  notes?: string
  /** True when this day has its own prescription instead of the template's. */
  custom: boolean
  /** Carried over from a v0.1 dated workout; no template was invented for it. */
  legacy: boolean
  version: number
  /** The prescription the workout will use (its own, or the template's). */
  items: PrescribedItem[]
  blockId?: string
  block?: number
  week?: number
  deload: boolean
  status: PlanStatus
  /** The session that fulfilled (or is fulfilling) this plan. */
  sessionId?: string
  origin: Origin
  updatedAt: string
}

export interface SetLog {
  id?: string
  /** Actual load (lb); empty until entered. */
  weight?: number
  /** Actual reps; empty until entered. Always set on a completed set. */
  reps?: number
  rpe?: number
  done?: boolean
  note?: string
}

export interface EntryLog {
  id?: string
  exerciseId: string
  sets: SetLog[]
  note?: string
  /** The prescription when the session started (absent when added ad hoc). */
  target?: Prescription
}

/**
 * The rest after a completed set in the live workout. It is a deadline, not a
 * counter: the time left is always `endsAt - now`, however long the page was
 * asleep in between.
 */
export interface RestState {
  /** The completed set this rest follows. */
  setId: string
  entryId: string
  exerciseId: string
  /** Planned length in seconds, adjustments included. */
  sec: number
  /** When the rest ends (ISO) while it runs; absent while paused. */
  endsAt?: string
  /** Time left while paused. */
  pausedMs?: number
}

export interface SessionLog {
  id: string
  planId?: string
  templateId?: string
  name: string
  /** Start time (ISO). */
  date: string
  endedAt?: string
  durationMin: number
  entries: EntryLog[]
  note?: string
  readiness?: number
  blockId?: string
  block?: number
  week?: number
  deload?: boolean
  status: 'active' | 'completed'
  /** Bumped when the session's prescription/structure changes. */
  version: number
  /** The live workout's current rest, if any. */
  rest?: RestState
  origin: Origin
}

export interface FitnessNote {
  id: string
  text: string
  date: string
  tag?: NoteTag
  pinned: boolean
  origin: Origin
}

export interface FitnessSnapshot {
  generatedAt: string
  today: string
  timeZone: string
  exercises: Exercise[]
  goal: Goal | null
  blocks: Block[]
  currentBlockId?: string
  /** The block whose workouts make up the program (current, else the latest with workouts). */
  programBlockId?: string
  /** Reusable workouts, by block then position. */
  templates: WorkoutTemplate[]
  /** The next workout in the program's sequence. */
  nextTemplateId?: string
  /** Plans (date overlays), oldest first. */
  plans: Plan[]
  todayPlanId?: string
  /** The soonest plan after today. */
  upcomingPlanId?: string
  /** Completed sessions, newest first. */
  sessions: SessionLog[]
  active: SessionLog | null
  notes: FitnessNote[]
  counts: { owner: number; demo: number }
}

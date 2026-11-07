/** Pure derivations over Fitness records, shared by the server, the pages and the tests. */
import type { EntryLog, Exercise, Pattern, Prescription, RestState, SessionLog, SetLog, WorkoutTemplate } from './types'

export function e1rm(weight: number, reps: number): number {
  if (reps <= 1) return weight
  return weight * (1 + reps / 30)
}

/** Sets that count as performed: ticked done with reps entered. */
export function performed(sets: SetLog[]): (SetLog & { reps: number })[] {
  return sets.filter((s): s is SetLog & { reps: number } => !!s.done && s.reps !== undefined)
}

export function topSet(entry: EntryLog): SetLog | undefined {
  return performed(entry.sets).reduce<SetLog | undefined>((best, s) => (!best || e1rm(s.weight ?? 0, s.reps) > e1rm(best.weight ?? 0, best.reps ?? 0) ? s : best), undefined)
}

export function volume(session: SessionLog, exerciseById: Record<string, Exercise>): number {
  let v = 0
  for (const e of session.entries) {
    if (exerciseById[e.exerciseId]?.bodyweight) continue
    for (const s of performed(e.sets)) v += (s.weight ?? 0) * s.reps
  }
  return v
}

export interface TrendPoint {
  date: string
  value: number
  label?: string
  sessionId?: string
}

/** Estimated 1RM per session for a lift (deload sessions excluded), oldest first. */
export function e1rmSeries(sessions: SessionLog[], exerciseId: string): TrendPoint[] {
  return sessions
    .filter((s) => !s.deload)
    .flatMap((s) => {
      const entry = s.entries.find((e) => e.exerciseId === exerciseId)
      const t = entry && topSet(entry)
      if (!t || !t.weight || t.reps === undefined) return []
      return [{ date: s.date, value: Math.round(e1rm(t.weight, t.reps)), label: `${fmtLoad(t.weight)} × ${t.reps}`, sessionId: s.id }]
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Most recent entry for an exercise with performed sets. `sessions` must be newest first. */
export function lastEntryFor(sessions: SessionLog[], exerciseId: string, before?: string): { session: SessionLog; entry: EntryLog } | undefined {
  for (const s of sessions) {
    if (before && s.date >= before) continue
    const entry = s.entries.find((e) => e.exerciseId === exerciseId && performed(e.sets).length)
    if (entry) return { session: s, entry }
  }
  return undefined
}

export interface PreviousPerformance {
  session: SessionLog
  entry: EntryLog
  /** True when it came from the same workout template. */
  sameWorkout: boolean
}

/**
 * "Last time" for an exercise: the newest completed session of the same
 * workout template that has it, else the newest session of any kind.
 * `sessions` must be completed sessions, newest first.
 */
export function previousFor(sessions: SessionLog[], exerciseId: string, templateId?: string, excludeSessionId?: string): PreviousPerformance | undefined {
  const pool = excludeSessionId ? sessions.filter((s) => s.id !== excludeSessionId) : sessions
  if (templateId) {
    const same = lastEntryFor(
      pool.filter((s) => s.templateId === templateId),
      exerciseId,
    )
    if (same) return { ...same, sameWorkout: true }
  }
  const any = lastEntryFor(pool, exerciseId)
  return any ? { ...any, sameWorkout: !!templateId && any.session.templateId === templateId } : undefined
}

export function bestSetEver(sessions: SessionLog[], exerciseId: string): { set: SetLog; session: SessionLog } | undefined {
  let best: { set: SetLog; session: SessionLog } | undefined
  for (const s of sessions) {
    const entry = s.entries.find((e) => e.exerciseId === exerciseId)
    const t = entry && topSet(entry)
    if (t && (!best || e1rm(t.weight ?? 0, t.reps ?? 0) > e1rm(best.set.weight ?? 0, best.set.reps ?? 0))) best = { set: t, session: s }
  }
  return best
}

export function fmtLoad(w: number | undefined, bodyweight?: boolean): string {
  if (w === undefined) return bodyweight ? 'BW' : '—'
  if (bodyweight || w === 0) return w ? `BW+${w}` : 'BW'
  return Number.isInteger(w) ? String(w) : w.toFixed(1)
}

/** "5–8", or "8" when the range is exact. */
export function fmtReps(p: Pick<Prescription, 'repMin' | 'repMax'>): string {
  return p.repMin === p.repMax ? String(p.repMin) : `${p.repMin}–${p.repMax}`
}

export function fmtRpe(r: number | undefined): string {
  return r === undefined ? '' : `RPE ${Number.isInteger(r) ? r : r.toFixed(1)}`
}

/** "185×8, 185×8, 185×7" — performed sets only. */
export function fmtSets(sets: SetLog[]): string {
  const done = performed(sets)
  if (!done.length) return '—'
  const sameW = done.every((s) => s.weight === done[0].weight)
  const sameR = done.every((s) => s.reps === done[0].reps)
  const w = fmtLoad(done[0].weight ?? 0)
  if (sameW && sameR) return `${w} × ${done[0].reps} × ${done.length}`
  if (sameW) return `${w} × ${done.map((s) => s.reps).join(', ')}`
  return done.map((s) => `${fmtLoad(s.weight ?? 0)}×${s.reps}`).join(', ')
}

/** Each performed set on its own: "185×8 @7.5". */
export function fmtSetList(sets: SetLog[], bodyweight?: boolean): string[] {
  return performed(sets).map((s) => `${bodyweight && !s.weight ? 'BW' : fmtLoad(s.weight ?? 0)}×${s.reps}${s.rpe ? ` @${s.rpe}` : ''}`)
}

/** "3 × 5–8 @ 185" (load only when prescribed). RPE is shown separately with fmtRpe. */
export function fmtPrescription(p: Prescription, ex?: Pick<Exercise, 'bodyweight'>): string {
  const base = `${p.sets} × ${fmtReps(p)}`
  if (p.load === undefined || (ex?.bodyweight && !p.load)) return base
  return `${base} @ ${fmtLoad(p.load, ex?.bodyweight)}`
}

/** Prescription with RPE: "3 × 5–8 @ 185, RPE 8". */
export function fmtPrescriptionFull(p: Prescription, ex?: Pick<Exercise, 'bodyweight'>): string {
  return [fmtPrescription(p, ex), fmtRpe(p.rpe)].filter(Boolean).join(', ')
}

/* Rest -------------------------------------------------------------- */

/** Rest lengths offered for an exercise, in seconds. */
export const REST_CHOICES = [30, 45, 60, 75, 90, 120, 150, 180, 210, 240, 300]
/** The longest rest Sahale stores (15 min). */
export const MAX_REST_SEC = 900

const COMPOUND = new Set<Pattern>(['Squat', 'Hinge', 'Press', 'Pull'])

/**
 * Rest after each set of an exercise, in seconds (0 = no timer): the owner's
 * choice for that exercise, else 3:00 for a main lift, 2:00 for another
 * compound movement and 1:30 for everything else.
 */
export function restSecFor(ex: Pick<Exercise, 'restSec' | 'main' | 'pattern'> | undefined): number {
  if (ex?.restSec !== undefined) return ex.restSec
  if (ex?.main) return 180
  return ex && COMPOUND.has(ex.pattern) ? 120 : 90
}

/** "1:30", "12:05". The sign is dropped; callers say whether it's left or over. */
export function fmtClock(sec: number): string {
  const s = Math.abs(Math.trunc(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Where a rest stands at `now` (ms): time left, negative once it has run out.
 * Always computed from the deadline, so a page that slept shows the truth the
 * moment it wakes. A device clock behind the runtime's never shows more than
 * the whole rest.
 */
export function restLeft(rest: RestState, now: number): { leftMs: number; paused: boolean; over: boolean; progress: number } {
  const paused = rest.endsAt === undefined
  const total = rest.sec * 1000
  const leftMs = Math.min(paused ? (rest.pausedMs ?? 0) : Date.parse(rest.endsAt!) - now, total)
  return { leftMs, paused, over: leftMs <= 0, progress: total > 0 ? 1 - Math.max(0, leftMs) / total : 1 }
}

/** Seconds to show: counts down to 0:00 exactly at the deadline, then counts the time over. */
export function restDisplaySec(leftMs: number): number {
  return leftMs > 0 ? Math.ceil(leftMs / 1000) : Math.floor(-leftMs / 1000)
}

/**
 * The next workout in a block's normal order: the one after the most recently
 * completed workout from that block (wrapping around), else the first.
 * `sessions` must be completed sessions, newest first.
 */
export function nextInSequence(templates: WorkoutTemplate[], sessions: SessionLog[]): WorkoutTemplate | undefined {
  if (!templates.length) return undefined
  const ordered = [...templates].sort((a, b) => a.position - b.position)
  const ids = new Set(ordered.map((t) => t.id))
  const last = sessions.find((s) => s.templateId && ids.has(s.templateId))
  if (!last) return ordered[0]
  const i = ordered.findIndex((t) => t.id === last.templateId)
  return ordered[(i + 1) % ordered.length]
}


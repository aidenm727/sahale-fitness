/**
 * The Fitness domain service — the only code that writes Fitness state.
 *
 * The model:
 * - a block holds reusable workout templates in a normal order (Upper A,
 *   Lower A, …) — templates have no date;
 * - a plan optionally puts a template on a date; moving or clearing it never
 *   touches the template, and missing the date logs nothing;
 * - starting a workout creates a session that snapshots the prescription, so
 *   later template edits never reach back into history;
 * - actual sets (load / reps / RPE / note) are recorded separately from the
 *   prescription and only count once ticked done.
 *
 * Every multi-record change runs in one SQLite transaction, and every mutation
 * returns nothing until it has committed; routes then read a fresh snapshot.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { addDays, daysBetween, localDate } from '../../shared/dates'
import { nextInSequence, restSecFor } from '../../shared/fitness/derive'
import type {
  Block,
  EntryLog,
  Exercise,
  FitnessNote,
  FitnessSnapshot,
  Goal,
  NoteTag,
  Origin,
  Pattern,
  Plan,
  PlanStatus,
  PrescribedItem,
  Prescription,
  RestState,
  SessionLog,
  WorkoutTemplate,
} from '../../shared/fitness/types'
import type {
  BlockInput,
  ExerciseInput,
  FinishSessionInput,
  GoalInput,
  PlanPatch,
  PrescriptionInput,
  RestInput,
  SetPatch,
  StartSessionInput,
  TemplateInput,
  TemplatePatch,
} from '../../shared/schemas'
import type { Clock } from '../clock'
import type { Db, DbLike } from '../db'
import * as t from '../db/schema'
import { conflict, invalid, notFound } from '../errors'
import { newId } from '../ids'
import { buildDemo } from './demo'
import { LIBRARY } from './library'

export type { Clock }

type BlockRow = typeof t.blocks.$inferSelect
type TemplateRow = typeof t.templates.$inferSelect
type TemplateItemRow = typeof t.templateItems.$inferSelect
type PlanRow = typeof t.plans.$inferSelect
type PlanItemRow = typeof t.planItems.$inferSelect
type EntryRow = typeof t.sessionEntries.$inferSelect
type SessionRow = typeof t.sessions.$inferSelect

/** Starting a workout fulfils its template's plan when one is open within this many days. */
export const PLAN_MATCH_DAYS = 7
const MAX_SETS = 30

/* ------------------------------------------------------------------ */
/* Read model                                                          */
/* ------------------------------------------------------------------ */

function blockView(rows: BlockRow[], today: string): Block[] {
  return [...rows]
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.createdAt.localeCompare(b.createdAt))
    .map((b, i) => {
      const endDate = addDays(b.startDate, b.weeks * 7 - 1)
      const status: Block['status'] = today > endDate ? 'done' : today >= b.startDate ? 'current' : 'planned'
      return {
        id: b.id,
        n: i + 1,
        name: b.name,
        phase: b.phase,
        intent: b.intent,
        scheme: b.scheme,
        startDate: b.startDate,
        weeks: b.weeks,
        deloadWeek: b.deloadWeek ?? undefined,
        endDate,
        status,
        origin: b.origin,
        updatedAt: b.updatedAt,
      }
    })
}

function placeInBlock(blocks: Block[], date: string, blockId?: string | null) {
  const b = blockId ? blocks.find((x) => x.id === blockId) : blocks.find((x) => date >= x.startDate && date <= x.endDate)
  if (!b) return {}
  const d = daysBetween(b.startDate, date)
  if (d < 0 || d >= b.weeks * 7) return { block: b }
  const week = Math.floor(d / 7) + 1
  return { block: b, week, deload: week === b.deloadWeek }
}

function exerciseView(r: typeof t.exercises.$inferSelect): Exercise {
  return {
    id: r.id,
    name: r.name,
    short: r.short ?? undefined,
    pattern: r.pattern as Pattern,
    main: r.isMain,
    equipment: r.equipment,
    bodyweight: r.isBodyweight,
    cues: r.cues,
    note: r.note ?? undefined,
    restSec: r.restSec ?? undefined,
    origin: r.origin,
  }
}

function itemView(i: TemplateItemRow | PlanItemRow): PrescribedItem {
  return {
    id: i.id,
    exerciseId: i.exerciseId,
    sets: i.sets,
    repMin: i.repMin,
    repMax: i.repMax,
    rpe: i.targetRpe ?? undefined,
    load: i.targetLoad ?? undefined,
    note: i.note ?? undefined,
    ...('adjustedBy' in i && i.adjustedBy ? { adjustedBy: i.adjustedBy } : {}),
    ...('adjustmentNote' in i && i.adjustmentNote ? { adjustmentNote: i.adjustmentNote } : {}),
  }
}

function entryTarget(e: EntryRow): Prescription | undefined {
  if (e.targetSets === null || e.targetRepMin === null || e.targetRepMax === null) return undefined
  return {
    exerciseId: e.exerciseId,
    sets: e.targetSets,
    repMin: e.targetRepMin,
    repMax: e.targetRepMax,
    rpe: e.targetRpe ?? undefined,
    load: e.targetLoad ?? undefined,
    note: e.targetNote ?? undefined,
    adjustedBy: e.adjustedBy ?? undefined,
    adjustmentNote: e.adjustmentNote ?? undefined,
  }
}

/** Prescription columns for a template/plan item row. */
function prescriptionCols(it: Prescription) {
  return { exerciseId: it.exerciseId, sets: it.sets, repMin: it.repMin, repMax: it.repMax, targetRpe: it.rpe ?? null, targetLoad: it.load ?? null, note: it.note || null }
}

/** Prescription snapshot columns for a session entry. */
function targetCols(it: Prescription | undefined) {
  return {
    targetSets: it?.sets ?? null,
    targetRepMin: it?.repMin ?? null,
    targetRepMax: it?.repMax ?? null,
    targetRpe: it?.rpe ?? null,
    targetLoad: it?.load ?? null,
    targetNote: it?.note || null,
    adjustedBy: it?.adjustedBy ?? null,
    adjustmentNote: it?.adjustmentNote ?? null,
  }
}

/**
 * A session's rest, if it still applies: it belongs to the live workout and
 * follows a set that is still done. Un-ticking, deleting or removing that set
 * ends it without anything else having to remember to.
 */
export function restView(row: SessionRow, session: Pick<SessionLog, 'entries'>): RestState | undefined {
  if (row.status !== 'active' || !row.restSetId || row.restSec === null || (row.restEndsAt === null && row.restPausedMs === null)) return undefined
  for (const e of session.entries) {
    const set = e.sets.find((s) => s.id === row.restSetId)
    if (!set) continue
    if (!set.done) return undefined
    return {
      setId: row.restSetId,
      entryId: e.id!,
      exerciseId: e.exerciseId,
      sec: row.restSec,
      ...(row.restEndsAt !== null ? { endsAt: row.restEndsAt } : { pausedMs: row.restPausedMs! }),
    }
  }
  return undefined
}

export class FitnessService {
  constructor(readonly db: Db) {}

  /** Insert any missing library exercises. Never overwrites. */
  ensureLibrary(now = new Date()) {
    const stamp = now.toISOString()
    const existing = new Set(this.db.select({ id: t.exercises.id }).from(t.exercises).all().map((r) => r.id))
    const missing = LIBRARY.filter((e) => !existing.has(e.id))
    if (!missing.length) return
    this.db.transaction((tx) => {
      for (const e of missing) {
        tx.insert(t.exercises)
          .values({ id: e.id, name: e.name, short: e.short ?? null, pattern: e.pattern, equipment: e.equipment, isMain: e.main, isBodyweight: e.bodyweight, cues: e.cues, note: e.note ?? null, origin: 'library', createdAt: stamp, updatedAt: stamp })
          .run()
      }
    })
  }

  snapshot(clock: Clock): FitnessSnapshot {
    const db = this.db
    const exercises = db.select().from(t.exercises).orderBy(asc(t.exercises.name)).all().map(exerciseView)
    const goalRow = db.select().from(t.goals).where(eq(t.goals.status, 'active')).orderBy(desc(t.goals.updatedAt)).get()
    const goal: Goal | null = goalRow
      ? {
          id: goalRow.id,
          statement: goalRow.statement,
          date: goalRow.targetDate ?? undefined,
          bodyweightTarget: goalRow.bodyweightTarget ?? undefined,
          targets: db
            .select()
            .from(t.goalTargets)
            .where(eq(t.goalTargets.goalId, goalRow.id))
            .orderBy(asc(t.goalTargets.position))
            .all()
            .map((x) => ({ exerciseId: x.exerciseId, target: x.targetLoad })),
          origin: goalRow.origin,
          updatedAt: goalRow.updatedAt,
        }
      : null

    const blocks = blockView(db.select().from(t.blocks).all(), clock.today)
    const currentBlock = blocks.find((b) => b.status === 'current')
    const blockById = new Map(blocks.map((b) => [b.id, b]))

    /* Sessions ------------------------------------------------------ */
    const sessionRows = db.select().from(t.sessions).orderBy(desc(t.sessions.startedAt)).all()
    const entryRows = db.select().from(t.sessionEntries).orderBy(asc(t.sessionEntries.position)).all()
    const setRows = db.select().from(t.sessionSets).orderBy(asc(t.sessionSets.position)).all()
    const setsByEntry = new Map<string, typeof setRows>()
    for (const s of setRows) setsByEntry.set(s.entryId, [...(setsByEntry.get(s.entryId) ?? []), s])
    const entriesBySession = new Map<string, EntryLog[]>()
    for (const e of entryRows) {
      const list = entriesBySession.get(e.sessionId) ?? []
      const target = entryTarget(e)
      list.push({
        id: e.id,
        exerciseId: e.exerciseId,
        // A v0.1 snapshot that couldn't be read is surfaced as a note rather than hidden.
        note: e.note ?? (target ? undefined : (e.targetNote ?? undefined)),
        target,
        sets: (setsByEntry.get(e.id) ?? []).map((s) => ({
          id: s.id,
          weight: s.weight ?? undefined,
          reps: s.reps ?? undefined,
          rpe: s.rpe ?? undefined,
          done: s.done,
          note: s.note ?? undefined,
        })),
      })
      entriesBySession.set(e.sessionId, list)
    }
    const allSessions: SessionLog[] = sessionRows.map((s) => ({
      id: s.id,
      planId: s.planId ?? undefined,
      templateId: s.templateId ?? undefined,
      name: s.name,
      date: s.startedAt,
      endedAt: s.endedAt ?? undefined,
      durationMin: s.status === 'active' ? Math.max(0, Math.round((clock.now.getTime() - new Date(s.startedAt).getTime()) / 60_000)) : (s.durationMin ?? 0),
      entries: entriesBySession.get(s.id) ?? [],
      note: s.note ?? undefined,
      readiness: s.readiness ?? undefined,
      blockId: s.blockId ?? undefined,
      block: s.blockId ? blockById.get(s.blockId)?.n : undefined,
      week: s.week ?? undefined,
      deload: s.isDeload,
      status: s.status,
      version: s.version,
      origin: s.origin,
    }))
    const active = allSessions.find((s) => s.status === 'active') ?? null
    if (active) {
      const rest = restView(sessionRows.find((s) => s.id === active.id)!, active)
      if (rest) active.rest = rest
    }
    const sessions = allSessions.filter((s) => s.status === 'completed')

    /* Templates ----------------------------------------------------- */
    const templateRows = db.select().from(t.templates).all()
    const templateItemsBy = new Map<string, PrescribedItem[]>()
    for (const i of db.select().from(t.templateItems).orderBy(asc(t.templateItems.position)).all()) {
      templateItemsBy.set(i.templateId, [...(templateItemsBy.get(i.templateId) ?? []), itemView(i)])
    }
    const blockOrder = (id: string | null) => (id ? (blockById.get(id)?.n ?? 0) : Number.MAX_SAFE_INTEGER)
    const templateById = new Map(templateRows.map((r) => [r.id, r]))

    /* Plans --------------------------------------------------------- */
    const planItemsBy = new Map<string, PrescribedItem[]>()
    for (const i of db.select().from(t.planItems).orderBy(asc(t.planItems.position)).all()) {
      planItemsBy.set(i.planId, [...(planItemsBy.get(i.planId) ?? []), itemView(i)])
    }
    const doneFor = new Map<string, string>()
    for (const s of sessions) if (s.planId && !doneFor.has(s.planId)) doneFor.set(s.planId, s.id)
    const plans: Plan[] = db
      .select()
      .from(t.plans)
      .orderBy(asc(t.plans.date), asc(t.plans.createdAt))
      .all()
      .map((p) => {
        const tpl = p.templateId ? templateById.get(p.templateId) : undefined
        const place = placeInBlock(blocks, p.date, p.blockId ?? tpl?.blockId)
        const isActive = active?.planId === p.id
        const status: PlanStatus = isActive ? 'active' : doneFor.has(p.id) ? 'done' : p.date < clock.today ? 'missed' : p.date === clock.today ? 'today' : 'planned'
        return {
          id: p.id,
          templateId: p.templateId ?? undefined,
          date: p.date,
          name: tpl?.name ?? p.name,
          focus: (tpl ? tpl.focus : p.focus) ?? undefined,
          notes: p.notes ?? undefined,
          custom: p.ownPrescription,
          legacy: p.legacy,
          version: p.version,
          items: p.ownPrescription ? (planItemsBy.get(p.id) ?? []) : tpl ? (templateItemsBy.get(tpl.id) ?? []) : [],
          blockId: place.block?.id,
          block: place.block?.n,
          week: place.week,
          deload: !!place.deload,
          status,
          sessionId: isActive ? active!.id : doneFor.get(p.id),
          origin: p.origin,
          updatedAt: p.updatedAt,
        }
      })

    const templates: WorkoutTemplate[] = [...templateRows]
      .sort((a, b) => blockOrder(a.blockId) - blockOrder(b.blockId) || a.position - b.position || a.createdAt.localeCompare(b.createdAt))
      .map((r) => {
        const last = sessions.find((s) => s.templateId === r.id)
        return {
          id: r.id,
          blockId: r.blockId ?? undefined,
          position: r.position,
          name: r.name,
          focus: r.focus ?? undefined,
          notes: r.notes ?? undefined,
          version: r.version,
          items: templateItemsBy.get(r.id) ?? [],
          lastSessionId: last?.id,
          lastDoneAt: last?.date,
          planIds: plans.filter((p) => p.templateId === r.id && (p.status === 'planned' || p.status === 'today' || p.status === 'missed')).map((p) => p.id),
          origin: r.origin,
          updatedAt: r.updatedAt,
        }
      })

    // The program = the current block's workouts; else the newest block that has any; else the
    // next block to start (so a block planned for next week is where new workouts go); else the last.
    const withTemplates = new Set(templates.map((x) => x.blockId))
    const programBlock = currentBlock ?? [...blocks].reverse().find((b) => withTemplates.has(b.id)) ?? blocks.find((b) => b.status === 'planned') ?? blocks.at(-1)
    const programTemplates = templates.filter((x) => x.blockId === programBlock?.id)
    const nextTemplate = nextInSequence(programTemplates, sessions)

    const todays = plans.filter((p) => p.date === clock.today)
    const todayPlan = todays.find((p) => p.status !== 'done') ?? todays[0]
    const upcomingPlan = plans.find((p) => p.date > clock.today && p.status === 'planned')

    const notes: FitnessNote[] = db
      .select()
      .from(t.notes)
      .orderBy(desc(t.notes.createdAt))
      .all()
      .map((n) => ({ id: n.id, text: n.text, date: n.createdAt, tag: (n.tag as NoteTag | null) ?? undefined, pinned: n.pinned, origin: n.origin }))

    const count = (o: Origin) =>
      [goalRow ? [goalRow] : [], blocks, templates, plans, sessions, notes].reduce((n, rows) => n + (rows as { origin: Origin }[]).filter((r) => r.origin === o).length, 0)

    return {
      generatedAt: clock.now.toISOString(),
      today: clock.today,
      timeZone: clock.timeZone,
      exercises,
      goal,
      blocks,
      currentBlockId: currentBlock?.id,
      programBlockId: programBlock?.id,
      templates,
      nextTemplateId: nextTemplate?.id,
      plans,
      todayPlanId: todayPlan?.id,
      upcomingPlanId: upcomingPlan?.id,
      sessions,
      active,
      notes,
      counts: { owner: count('owner'), demo: count('demo') },
    }
  }

  /* ---------------------------------------------------------------- */
  /* Goal                                                              */
  /* ---------------------------------------------------------------- */

  private assertExercises(tx: DbLike, ids: string[]) {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    const found = new Set(tx.select({ id: t.exercises.id }).from(t.exercises).where(inArray(t.exercises.id, unique)).all().map((r) => r.id))
    const missing = unique.filter((id) => !found.has(id))
    if (missing.length) throw invalid(`Unknown exercise: ${missing.join(', ')}`)
  }

  putGoal(input: GoalInput, clock: Clock) {
    const stamp = clock.now.toISOString()
    this.db.transaction((tx) => {
      this.assertExercises(tx, input.targets.map((x) => x.exerciseId))
      const existing = tx.select().from(t.goals).where(eq(t.goals.status, 'active')).get()
      const id = existing?.id ?? newId('g')
      const values = { statement: input.statement, targetDate: input.date ?? null, bodyweightTarget: input.bodyweightTarget ?? null, origin: 'owner' as const, updatedAt: stamp }
      if (existing) tx.update(t.goals).set(values).where(eq(t.goals.id, id)).run()
      else tx.insert(t.goals).values({ id, status: 'active', createdAt: stamp, ...values }).run()
      tx.delete(t.goalTargets).where(eq(t.goalTargets.goalId, id)).run()
      input.targets.forEach((x, position) => tx.insert(t.goalTargets).values({ id: newId('gt'), goalId: id, exerciseId: x.exerciseId, targetLoad: x.target, position }).run())
    })
  }

  archiveGoal(clock: Clock) {
    this.db.update(t.goals).set({ status: 'archived', updatedAt: clock.now.toISOString() }).where(eq(t.goals.status, 'active')).run()
  }

  /* ---------------------------------------------------------------- */
  /* Blocks                                                            */
  /* ---------------------------------------------------------------- */

  private checkDeload(weeks: number, deloadWeek?: number) {
    if (deloadWeek !== undefined && deloadWeek > weeks) throw invalid('The deload week must fall inside the block')
  }

  createBlock(input: BlockInput, clock: Clock): string {
    this.checkDeload(input.weeks, input.deloadWeek)
    const stamp = clock.now.toISOString()
    const id = newId('b')
    this.db.insert(t.blocks).values({ id, ...input, deloadWeek: input.deloadWeek ?? null, origin: 'owner', createdAt: stamp, updatedAt: stamp }).run()
    return id
  }

  updateBlock(id: string, input: Partial<BlockInput>, clock: Clock) {
    const row = this.db.select().from(t.blocks).where(eq(t.blocks.id, id)).get()
    if (!row) throw notFound('Block')
    const weeks = input.weeks ?? row.weeks
    const deloadWeek = input.deloadWeek === undefined ? (row.deloadWeek ?? undefined) : input.deloadWeek
    this.checkDeload(weeks, deloadWeek)
    this.db
      .update(t.blocks)
      .set({ ...input, deloadWeek: deloadWeek ?? null, origin: 'owner', updatedAt: clock.now.toISOString() })
      .where(eq(t.blocks.id, id))
      .run()
  }

  /** Deleting a block keeps its workouts (they become unassigned) and all history. */
  deleteBlock(id: string) {
    this.db.transaction((tx) => {
      const r = tx.delete(t.blocks).where(eq(t.blocks.id, id)).run()
      if (!r.changes) throw notFound('Block')
      this.renumber(tx, null)
    })
  }

  /* ---------------------------------------------------------------- */
  /* Workout templates                                                 */
  /* ---------------------------------------------------------------- */

  getTemplate(tx: DbLike, id: string): { template: TemplateRow; items: TemplateItemRow[] } | null {
    const template = tx.select().from(t.templates).where(eq(t.templates.id, id)).get()
    if (!template) return null
    const items = tx.select().from(t.templateItems).where(eq(t.templateItems.templateId, id)).orderBy(asc(t.templateItems.position)).all()
    return { template, items }
  }

  private assertBlock(tx: DbLike, blockId: string | null | undefined) {
    if (blockId && !tx.select({ id: t.blocks.id }).from(t.blocks).where(eq(t.blocks.id, blockId)).get()) throw invalid('Unknown block')
  }

  private blockTemplates(tx: DbLike, blockId: string | null) {
    return tx
      .select()
      .from(t.templates)
      .where(blockId ? eq(t.templates.blockId, blockId) : isNull(t.templates.blockId))
      .orderBy(asc(t.templates.position), asc(t.templates.createdAt))
      .all()
  }

  /** Close gaps in a block's order (0, 1, 2, …). */
  private renumber(tx: DbLike, blockId: string | null) {
    this.blockTemplates(tx, blockId).forEach((r, position) => {
      if (r.position !== position) tx.update(t.templates).set({ position }).where(eq(t.templates.id, r.id)).run()
    })
  }

  private nextPosition(tx: DbLike, blockId: string | null): number {
    return this.blockTemplates(tx, blockId).reduce((m, r) => Math.max(m, r.position + 1), 0)
  }

  private writeTemplateItems(tx: DbLike, templateId: string, items: PrescriptionInput[], keep: Map<string, TemplateItemRow>) {
    const kept = new Set(items.flatMap((i) => (i.id && keep.has(i.id) ? [i.id] : [])))
    for (const old of keep.values()) if (!kept.has(old.id)) tx.delete(t.templateItems).where(eq(t.templateItems.id, old.id)).run()
    items.forEach((it, position) => {
      if (it.id && keep.has(it.id)) tx.update(t.templateItems).set({ position, ...prescriptionCols(it) }).where(eq(t.templateItems.id, it.id)).run()
      else tx.insert(t.templateItems).values({ id: newId('ti'), templateId, position, ...prescriptionCols(it) }).run()
    })
  }

  createTemplate(input: TemplateInput, clock: Clock): string {
    const stamp = clock.now.toISOString()
    const id = newId('wt')
    this.db.transaction((tx) => {
      this.assertExercises(tx, input.items.map((i) => i.exerciseId))
      this.assertBlock(tx, input.blockId)
      const blockId = input.blockId ?? null
      tx.insert(t.templates)
        .values({ id, blockId, position: this.nextPosition(tx, blockId), name: input.name, focus: input.focus || null, notes: input.notes || null, version: 1, origin: 'owner', createdAt: stamp, updatedAt: stamp })
        .run()
      this.writeTemplateItems(tx, id, input.items, new Map())
    })
    return id
  }

  /**
   * Edit a reusable workout. Only the template changes: history keeps its
   * snapshots and plans that have their own prescription keep theirs.
   */
  updateTemplate(id: string, patch: TemplatePatch, clock: Clock) {
    this.db.transaction((tx) => {
      const current = this.getTemplate(tx, id)
      if (!current) throw notFound('Workout')
      if (current.template.version !== patch.version) {
        throw conflict('version_conflict', 'This workout changed since you opened it. Reload and try again.', { version: current.template.version })
      }
      if (patch.items) {
        this.assertExercises(tx, patch.items.map((i) => i.exerciseId))
        const byId = new Map(current.items.map((i) => [i.id, i]))
        for (const it of patch.items) if (it.id && !byId.has(it.id)) throw invalid('An exercise row does not belong to this workout')
        this.writeTemplateItems(tx, id, patch.items, byId)
      }
      const moving = patch.blockId !== undefined && (patch.blockId ?? null) !== current.template.blockId
      if (moving) this.assertBlock(tx, patch.blockId)
      tx.update(t.templates)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.focus !== undefined ? { focus: patch.focus || null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
          ...(moving ? { blockId: patch.blockId ?? null, position: this.nextPosition(tx, patch.blockId ?? null) } : {}),
          version: current.template.version + 1,
          origin: 'owner',
          updatedAt: clock.now.toISOString(),
        })
        .where(eq(t.templates.id, id))
        .run()
      if (moving) this.renumber(tx, current.template.blockId)
    })
  }

  /**
   * Delete a reusable workout. Its plain plans (date overlays) go with it;
   * a plan that has its own prescription stays as a one-off; sessions keep
   * their snapshots and stay in history.
   */
  deleteTemplate(id: string) {
    this.db.transaction((tx) => {
      const current = tx.select().from(t.templates).where(eq(t.templates.id, id)).get()
      if (!current) throw notFound('Workout')
      tx.delete(t.plans)
        .where(and(eq(t.plans.templateId, id), eq(t.plans.ownPrescription, false)))
        .run()
      tx.delete(t.templates).where(eq(t.templates.id, id)).run()
      this.renumber(tx, current.blockId)
    })
  }

  duplicateTemplate(id: string, name: string | undefined, clock: Clock): string {
    const stamp = clock.now.toISOString()
    const copy = newId('wt')
    this.db.transaction((tx) => {
      const src = this.getTemplate(tx, id)
      if (!src) throw notFound('Workout')
      // Slot the copy right after the original.
      for (const r of this.blockTemplates(tx, src.template.blockId)) {
        if (r.position > src.template.position) tx.update(t.templates).set({ position: r.position + 1 }).where(eq(t.templates.id, r.id)).run()
      }
      tx.insert(t.templates)
        .values({
          id: copy,
          blockId: src.template.blockId,
          position: src.template.position + 1,
          name: name ?? `${src.template.name} (copy)`,
          focus: src.template.focus,
          notes: src.template.notes,
          version: 1,
          origin: 'owner',
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run()
      src.items.forEach((it, position) => tx.insert(t.templateItems).values({ ...it, id: newId('ti'), templateId: copy, position }).run())
      this.renumber(tx, src.template.blockId)
    })
    return copy
  }

  /** Set a block's normal order. `ids` must be exactly that block's workouts. */
  reorderTemplates(blockId: string | null, ids: string[], clock: Clock) {
    this.db.transaction((tx) => {
      const rows = this.blockTemplates(tx, blockId)
      const have = new Set(rows.map((r) => r.id))
      if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((x) => !have.has(x))) {
        throw conflict('order_mismatch', 'The list of workouts changed. Reload and try again.')
      }
      const stamp = clock.now.toISOString()
      ids.forEach((id, position) => tx.update(t.templates).set({ position, updatedAt: stamp }).where(eq(t.templates.id, id)).run())
    })
  }

  /* ---------------------------------------------------------------- */
  /* Plans (optional dates)                                            */
  /* ---------------------------------------------------------------- */

  getPlan(tx: DbLike, id: string): { plan: PlanRow; items: PlanItemRow[] } | null {
    const plan = tx.select().from(t.plans).where(eq(t.plans.id, id)).get()
    if (!plan) return null
    const items = tx.select().from(t.planItems).where(eq(t.planItems.planId, id)).orderBy(asc(t.planItems.position)).all()
    return { plan, items }
  }

  private planSessions(tx: DbLike, planId: string) {
    return tx.select().from(t.sessions).where(eq(t.sessions.planId, planId)).all()
  }

  /** Put a reusable workout on a date. The template itself is untouched. */
  createPlan(input: { templateId: string; date: string; notes?: string }, clock: Clock): string {
    const stamp = clock.now.toISOString()
    const id = newId('pl')
    this.db.transaction((tx) => {
      const tpl = tx.select().from(t.templates).where(eq(t.templates.id, input.templateId)).get()
      if (!tpl) throw notFound('Workout')
      const same = tx
        .select({ id: t.plans.id })
        .from(t.plans)
        .where(and(eq(t.plans.templateId, tpl.id), eq(t.plans.date, input.date)))
        .all()
      if (same.some((p) => !this.planSessions(tx, p.id).length)) throw conflict('already_planned', `${tpl.name} is already planned for that day.`)
      tx.insert(t.plans)
        .values({ id, templateId: tpl.id, blockId: tpl.blockId, date: input.date, name: tpl.name, focus: tpl.focus, notes: input.notes || null, ownPrescription: false, legacy: false, version: 1, origin: 'owner', createdAt: stamp, updatedAt: stamp })
        .run()
    })
    return id
  }

  /** Move a plan, annotate it, or give this one day its own prescription. */
  updatePlan(id: string, patch: PlanPatch, clock: Clock) {
    this.db.transaction((tx) => {
      const current = this.getPlan(tx, id)
      if (!current) throw notFound('Plan')
      if (current.plan.version !== patch.version) throw conflict('version_conflict', 'This plan changed since you opened it. Reload and try again.', { version: current.plan.version })
      const linked = this.planSessions(tx, id)
      if (linked.some((s) => s.status === 'completed')) throw conflict('plan_done', 'That planned workout is already done — its session is in History.')
      if (patch.items) {
        if (linked.some((s) => s.status === 'active')) throw conflict('session_active', 'That workout is being logged right now; change the live session instead.')
        this.assertExercises(tx, patch.items.map((i) => i.exerciseId))
        tx.delete(t.planItems).where(eq(t.planItems.planId, id)).run()
        patch.items.forEach((it, position) => tx.insert(t.planItems).values({ id: newId('pi'), planId: id, position, ...prescriptionCols(it), adjustedBy: 'owner' }).run())
      }
      tx.update(t.plans)
        .set({
          ...(patch.date !== undefined ? { date: patch.date } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
          ...(patch.items ? { ownPrescription: true } : {}),
          version: current.plan.version + 1,
          origin: 'owner',
          updatedAt: clock.now.toISOString(),
        })
        .where(eq(t.plans.id, id))
        .run()
    })
  }

  /** Drop a plan's own prescription so it follows its template again. */
  resetPlan(id: string, version: number, clock: Clock) {
    this.db.transaction((tx) => {
      const current = this.getPlan(tx, id)
      if (!current) throw notFound('Plan')
      if (current.plan.version !== version) throw conflict('version_conflict', 'This plan changed since you opened it. Reload and try again.')
      if (!current.plan.templateId) throw conflict('no_template', 'This planned workout has no reusable workout to fall back to.')
      if (this.planSessions(tx, id).length) throw conflict('plan_started', 'That planned workout has already been started.')
      tx.delete(t.planItems).where(eq(t.planItems.planId, id)).run()
      tx.update(t.plans).set({ ownPrescription: false, version: version + 1, origin: 'owner', updatedAt: clock.now.toISOString() }).where(eq(t.plans.id, id)).run()
    })
  }

  /** Clear a plan. The template and any session started from it stay. */
  deletePlan(id: string) {
    const r = this.db.delete(t.plans).where(eq(t.plans.id, id)).run()
    if (!r.changes) throw notFound('Plan')
  }

  /**
   * Turn a one-off plan (e.g. a v0.1 dated workout) into a reusable workout.
   * The plan then follows the new template.
   */
  planToTemplate(id: string, input: { name?: string; blockId?: string | null }, clock: Clock): string {
    return this.db.transaction((tx) => {
      const current = this.getPlan(tx, id)
      if (!current) throw notFound('Plan')
      const items: PrescriptionInput[] = (
        current.plan.ownPrescription ? current.items : current.plan.templateId ? (this.getTemplate(tx, current.plan.templateId)?.items ?? []) : []
      ).map((i) => ({ exerciseId: i.exerciseId, sets: i.sets, repMin: i.repMin, repMax: i.repMax, rpe: i.targetRpe ?? undefined, load: i.targetLoad ?? undefined, note: i.note ?? undefined }))
      const blockId = input.blockId === undefined ? current.plan.blockId : input.blockId
      this.assertBlock(tx, blockId)
      const stamp = clock.now.toISOString()
      const templateId = newId('wt')
      tx.insert(t.templates)
        .values({ id: templateId, blockId, position: this.nextPosition(tx, blockId), name: input.name ?? current.plan.name, focus: current.plan.focus, notes: null, version: 1, origin: 'owner', createdAt: stamp, updatedAt: stamp })
        .run()
      this.writeTemplateItems(tx, templateId, items, new Map())
      if (!this.planSessions(tx, id).length) {
        tx.delete(t.planItems).where(eq(t.planItems.planId, id)).run()
        tx.update(t.plans)
          .set({ templateId, ownPrescription: false, legacy: false, version: current.plan.version + 1, origin: 'owner', updatedAt: stamp })
          .where(eq(t.plans.id, id))
          .run()
      }
      return templateId
    })
  }

  /* ---------------------------------------------------------------- */
  /* Exercises                                                         */
  /* ---------------------------------------------------------------- */

  createExercise(input: ExerciseInput, clock: Clock): string {
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'exercise'
    const stamp = clock.now.toISOString()
    return this.db.transaction((tx) => {
      const clash = tx
        .select({ id: t.exercises.id })
        .from(t.exercises)
        .where(sql`lower(${t.exercises.name}) = ${input.name.toLowerCase()}`)
        .get()
      if (clash) throw conflict('exercise_exists', `“${input.name}” already exists.`, { id: clash.id })
      let id = slug
      for (let n = 2; tx.select().from(t.exercises).where(eq(t.exercises.id, id)).get(); n++) id = `${slug}-${n}`
      tx.insert(t.exercises)
        .values({ id, name: input.name, short: input.short ?? null, pattern: input.pattern, equipment: input.equipment, isMain: input.main, isBodyweight: input.bodyweight, cues: input.cues, note: input.note ?? null, restSec: input.restSec ?? null, origin: 'owner', createdAt: stamp, updatedAt: stamp })
        .run()
      return id
    })
  }

  updateExercise(id: string, input: Partial<ExerciseInput>, clock: Clock) {
    const r = this.db
      .update(t.exercises)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.short !== undefined ? { short: input.short || null } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        ...(input.equipment !== undefined ? { equipment: input.equipment } : {}),
        ...(input.main !== undefined ? { isMain: input.main } : {}),
        ...(input.bodyweight !== undefined ? { isBodyweight: input.bodyweight } : {}),
        ...(input.cues !== undefined ? { cues: input.cues } : {}),
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        ...(input.restSec !== undefined ? { restSec: input.restSec } : {}),
        updatedAt: clock.now.toISOString(),
      })
      .where(eq(t.exercises.id, id))
      .run()
    if (!r.changes) throw notFound('Exercise')
  }

  /** Delete an exercise you created, only while nothing refers to it. */
  deleteExercise(id: string) {
    this.db.transaction((tx) => {
      const row = tx.select().from(t.exercises).where(eq(t.exercises.id, id)).get()
      if (!row) throw notFound('Exercise')
      if (row.origin === 'library') throw conflict('builtin_exercise', 'Built-in exercises can’t be deleted.')
      const used =
        tx.select({ id: t.templateItems.id }).from(t.templateItems).where(eq(t.templateItems.exerciseId, id)).get() ||
        tx.select({ id: t.planItems.id }).from(t.planItems).where(eq(t.planItems.exerciseId, id)).get() ||
        tx.select({ id: t.sessionEntries.id }).from(t.sessionEntries).where(eq(t.sessionEntries.exerciseId, id)).get() ||
        tx.select({ id: t.goalTargets.id }).from(t.goalTargets).where(eq(t.goalTargets.exerciseId, id)).get()
      if (used) throw conflict('exercise_in_use', `${row.name} is used in a workout or your history, so it can’t be deleted. Rename it instead.`)
      tx.delete(t.exercises).where(eq(t.exercises.id, id)).run()
    })
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                          */
  /* ---------------------------------------------------------------- */

  private touchSession(tx: DbLike, id: string, clock: Clock, structural = false) {
    tx.update(t.sessions)
      .set({ origin: 'owner', updatedAt: clock.now.toISOString(), ...(structural ? { version: sql`${t.sessions.version} + 1` } : {}) })
      .where(eq(t.sessions.id, id))
      .run()
  }

  sessionOf(tx: DbLike, id: string) {
    const s = tx.select().from(t.sessions).where(eq(t.sessions.id, id)).get()
    if (!s) throw notFound('Session')
    return s
  }

  private entryContext(tx: DbLike, entryId: string) {
    const entry = tx.select().from(t.sessionEntries).where(eq(t.sessionEntries.id, entryId)).get()
    if (!entry) throw notFound('Entry')
    return { entry, session: this.sessionOf(tx, entry.sessionId) }
  }

  /** The open plan a template-start should fulfil: same template, not started, nearest date within a week. */
  private matchPlan(tx: DbLike, templateId: string, day: string): PlanRow | undefined {
    const candidates = tx
      .select()
      .from(t.plans)
      .where(eq(t.plans.templateId, templateId))
      .all()
      .filter((p) => Math.abs(daysBetween(day, p.date)) <= PLAN_MATCH_DAYS && !this.planSessions(tx, p.id).length)
    return candidates.sort((a, b) => Math.abs(daysBetween(day, a.date)) - Math.abs(daysBetween(day, b.date)) || a.date.localeCompare(b.date))[0]
  }

  /**
   * Start a workout: from a template, from a plan, or empty. The session is
   * written immediately with a snapshot of the prescription and one empty
   * row per prescribed set.
   */
  startSession(input: StartSessionInput, clock: Clock): string {
    const stamp = clock.now.toISOString()
    const id = newId('s')
    this.db.transaction((tx) => {
      if (tx.select().from(t.sessions).where(eq(t.sessions.status, 'active')).get()) {
        throw conflict('session_active', 'A workout is already in progress. Finish or discard it first.')
      }
      const startedAt = input.startedAt ?? stamp
      if (new Date(startedAt).getTime() > clock.now.getTime() + 5 * 60_000) throw invalid('A workout cannot start in the future')
      const day = localDate(startedAt, clock.timeZone)

      let plan: PlanRow | undefined
      let template: TemplateRow | undefined
      if (input.planId) {
        plan = tx.select().from(t.plans).where(eq(t.plans.id, input.planId)).get()
        if (!plan) throw notFound('Plan')
        if (this.planSessions(tx, plan.id).length) throw conflict('plan_done', 'That planned workout is already logged.')
        template = plan.templateId ? tx.select().from(t.templates).where(eq(t.templates.id, plan.templateId)).get() : undefined
        if (input.templateId && input.templateId !== plan.templateId) throw invalid('That plan is for a different workout')
      } else if (input.templateId) {
        template = tx.select().from(t.templates).where(eq(t.templates.id, input.templateId)).get()
        if (!template) throw notFound('Workout')
        plan = this.matchPlan(tx, template.id, day)
      }

      let items: Prescription[] = []
      if (plan?.ownPrescription) items = this.getPlan(tx, plan.id)!.items.map(itemView)
      else if (template) items = this.getTemplate(tx, template.id)!.items.map(itemView)

      const blocks = blockView(tx.select().from(t.blocks).all(), clock.today)
      const place = placeInBlock(blocks, day, template?.blockId ?? plan?.blockId)
      tx.insert(t.sessions)
        .values({
          id,
          planId: plan?.id ?? null,
          templateId: template?.id ?? null,
          name: input.name?.trim() || template?.name || plan?.name || 'Workout',
          status: 'active',
          startedAt,
          blockId: place.block?.id ?? null,
          week: place.week ?? null,
          isDeload: !!place.deload,
          version: 1,
          origin: 'owner',
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run()
      items.forEach((it, position) => {
        const entryId = newId('se')
        tx.insert(t.sessionEntries)
          .values({ id: entryId, sessionId: id, position, exerciseId: it.exerciseId, ...targetCols(it) })
          .run()
        for (let s = 0; s < it.sets; s++) tx.insert(t.sessionSets).values({ id: newId('ss'), entryId, position: s, done: false }).run()
      })
    })
    return id
  }

  patchSession(id: string, patch: { name?: string; note?: string; readiness?: number | null; startedAt?: string; durationMin?: number }, clock: Clock) {
    this.db.transaction((tx) => {
      this.sessionOf(tx, id)
      tx.update(t.sessions)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.note !== undefined ? { note: patch.note || null } : {}),
          ...(patch.readiness !== undefined ? { readiness: patch.readiness } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.durationMin !== undefined ? { durationMin: patch.durationMin } : {}),
        })
        .where(eq(t.sessions.id, id))
        .run()
      this.touchSession(tx, id, clock)
    })
  }

  /** The most recent performed sets for an exercise (for filling in a completed-session edit). */
  private lastPerformed(tx: DbLike, exerciseId: string): { weight: number | null; reps: number } | undefined {
    const row = tx
      .select({ weight: t.sessionSets.weight, reps: t.sessionSets.reps })
      .from(t.sessionSets)
      .innerJoin(t.sessionEntries, eq(t.sessionEntries.id, t.sessionSets.entryId))
      .innerJoin(t.sessions, eq(t.sessions.id, t.sessionEntries.sessionId))
      .where(and(eq(t.sessionEntries.exerciseId, exerciseId), eq(t.sessions.status, 'completed'), eq(t.sessionSets.done, true)))
      .orderBy(desc(t.sessions.startedAt), desc(t.sessionSets.position))
      .get()
    return row && row.reps !== null ? { weight: row.weight, reps: row.reps } : undefined
  }

  addEntry(sessionId: string, exerciseId: string, clock: Clock): string {
    const id = newId('se')
    this.db.transaction((tx) => {
      const session = this.sessionOf(tx, sessionId)
      this.assertExercises(tx, [exerciseId])
      const position = (tx.select({ n: sql<number>`coalesce(max(${t.sessionEntries.position}), -1)` }).from(t.sessionEntries).where(eq(t.sessionEntries.sessionId, sessionId)).get()?.n ?? -1) + 1
      tx.insert(t.sessionEntries).values({ id, sessionId, position, exerciseId }).run()
      if (session.status === 'active') {
        tx.insert(t.sessionSets).values({ id: newId('ss'), entryId: id, position: 0, done: false }).run()
      } else {
        // Editing history: a logged set needs numbers, so start from last time's.
        const last = this.lastPerformed(tx, exerciseId)
        tx.insert(t.sessionSets)
          .values({ id: newId('ss'), entryId: id, position: 0, weight: last?.weight ?? null, reps: last?.reps ?? 5, done: true })
          .run()
      }
      this.touchSession(tx, sessionId, clock, true)
    })
    return id
  }

  removeEntry(entryId: string, clock: Clock) {
    this.db.transaction((tx) => {
      const { session } = this.entryContext(tx, entryId)
      tx.delete(t.sessionEntries).where(eq(t.sessionEntries.id, entryId)).run()
      this.touchSession(tx, session.id, clock, true)
    })
  }

  patchEntry(entryId: string, note: string | undefined, clock: Clock) {
    this.db.transaction((tx) => {
      const { session } = this.entryContext(tx, entryId)
      tx.update(t.sessionEntries).set({ note: note || null }).where(eq(t.sessionEntries.id, entryId)).run()
      this.touchSession(tx, session.id, clock)
    })
  }

  addSet(entryId: string, clock: Clock) {
    this.db.transaction((tx) => {
      const { entry, session } = this.entryContext(tx, entryId)
      const sets = tx.select().from(t.sessionSets).where(eq(t.sessionSets.entryId, entryId)).orderBy(asc(t.sessionSets.position)).all()
      if (sets.length >= MAX_SETS) throw invalid(`That is a lot of sets — ${MAX_SETS} is the limit`)
      const position = (sets.at(-1)?.position ?? -1) + 1
      if (session.status === 'active') {
        tx.insert(t.sessionSets).values({ id: newId('ss'), entryId, position, done: false }).run()
      } else {
        const prev = sets.at(-1)
        const last = prev?.reps != null ? { weight: prev.weight, reps: prev.reps } : this.lastPerformed(tx, entry.exerciseId)
        tx.insert(t.sessionSets)
          .values({ id: newId('ss'), entryId, position, weight: last?.weight ?? entry.targetLoad ?? null, reps: last?.reps ?? entry.targetRepMax ?? 5, done: true })
          .run()
      }
      this.touchSession(tx, session.id, clock)
    })
  }

  /** Record what actually happened in a set. A set counts only once it's done, and a done set has reps. */
  patchSet(setId: string, patch: SetPatch, clock: Clock) {
    this.db.transaction((tx) => {
      const set = tx.select().from(t.sessionSets).where(eq(t.sessionSets.id, setId)).get()
      if (!set) throw notFound('Set')
      const { session } = this.entryContext(tx, set.entryId)
      const next = {
        weight: patch.weight === undefined ? set.weight : patch.weight,
        reps: patch.reps === undefined ? set.reps : patch.reps,
        rpe: patch.rpe === undefined ? set.rpe : patch.rpe,
        done: patch.done ?? set.done,
        note: patch.note === undefined ? set.note : patch.note || null,
      }
      if (next.done && next.reps === null) throw invalid('Enter the reps before marking the set done.', { field: 'reps' })
      if (session.status === 'completed' && !next.done) throw invalid('Sets in a finished workout are logged sets — delete the set instead.')
      tx.update(t.sessionSets).set(next).where(eq(t.sessionSets.id, setId)).run()
      if (session.status === 'active' && next.done && !set.done) this.startRest(tx, session.id, set, clock)
      else if (session.status === 'active' && !next.done && set.done && session.restSetId === setId) this.setRest(tx, session.id, null)
      this.touchSession(tx, session.id, clock)
    })
  }

  /* Rest -------------------------------------------------------------- */

  private setRest(tx: DbLike, sessionId: string, rest: { setId: string; sec: number; endsAt: string | null; pausedMs: number | null } | null) {
    tx.update(t.sessions)
      .set({ restSetId: rest?.setId ?? null, restSec: rest?.sec ?? null, restEndsAt: rest?.endsAt ?? null, restPausedMs: rest?.pausedMs ?? null })
      .where(eq(t.sessions.id, sessionId))
      .run()
  }

  /**
   * A working set was just completed: rest for that exercise's rest length,
   * replacing any rest still running. No rest when the exercise has none, or
   * when nothing is left to do in the workout.
   */
  private startRest(tx: DbLike, sessionId: string, set: typeof t.sessionSets.$inferSelect, clock: Clock) {
    const exercise = tx
      .select({ restSec: t.exercises.restSec, main: t.exercises.isMain, pattern: t.exercises.pattern })
      .from(t.sessionEntries)
      .innerJoin(t.exercises, eq(t.exercises.id, t.sessionEntries.exerciseId))
      .where(eq(t.sessionEntries.id, set.entryId))
      .get()
    const sec = exercise ? restSecFor({ restSec: exercise.restSec ?? undefined, main: exercise.main, pattern: exercise.pattern as Pattern }) : 0
    const remaining = tx
      .select({ id: t.sessionSets.id })
      .from(t.sessionSets)
      .innerJoin(t.sessionEntries, eq(t.sessionEntries.id, t.sessionSets.entryId))
      .where(and(eq(t.sessionEntries.sessionId, sessionId), eq(t.sessionSets.done, false), ne(t.sessionSets.id, set.id)))
      .get()
    if (!sec || !remaining) return this.setRest(tx, sessionId, null)
    this.setRest(tx, sessionId, { setId: set.id, sec, endsAt: new Date(clock.now.getTime() + sec * 1000).toISOString(), pausedMs: null })
  }

  /** Skip, pause, resume or adjust the live workout's rest. Doing so when there is no rest changes nothing. */
  controlRest(sessionId: string, input: RestInput, clock: Clock) {
    this.db.transaction((tx) => {
      const session = this.sessionOf(tx, sessionId)
      if (session.status !== 'active') throw conflict('not_active', 'This workout is already finished.')
      const now = clock.now.getTime()
      const current = this.snapshotRest(tx, session)
      if (!current) return
      const running = current.endsAt !== undefined
      const left = running ? Date.parse(current.endsAt!) - now : (current.pausedMs ?? 0)
      const base = { setId: current.setId, sec: current.sec }
      switch (input.op) {
        case 'skip':
          return this.setRest(tx, sessionId, null)
        case 'pause':
          if (running && left > 0) this.setRest(tx, sessionId, { ...base, endsAt: null, pausedMs: left })
          return
        case 'resume':
          if (!running) this.setRest(tx, sessionId, { ...base, endsAt: new Date(now + left).toISOString(), pausedMs: null })
          return
        case 'adjust': {
          // Taking time off a rest that has already run out does nothing; adding time to it starts from now.
          if (left <= 0 && input.sec < 0) return
          const nextLeft = Math.max(0, Math.max(0, left) + input.sec * 1000)
          const sec = Math.max(Math.ceil(nextLeft / 1000), current.sec + input.sec, 1)
          // A paused rest with no time left is simply done.
          if (running || nextLeft === 0) this.setRest(tx, sessionId, { ...base, sec, endsAt: new Date(now + nextLeft).toISOString(), pausedMs: null })
          else this.setRest(tx, sessionId, { ...base, sec, endsAt: null, pausedMs: nextLeft })
        }
      }
    })
  }

  /** The session's rest as the UI sees it (see restView). */
  private snapshotRest(tx: DbLike, session: typeof t.sessions.$inferSelect): RestState | undefined {
    if (!session.restSetId) return undefined
    const row = tx
      .select({ id: t.sessionSets.id, done: t.sessionSets.done, entryId: t.sessionEntries.id, exerciseId: t.sessionEntries.exerciseId, sessionId: t.sessionEntries.sessionId })
      .from(t.sessionSets)
      .innerJoin(t.sessionEntries, eq(t.sessionEntries.id, t.sessionSets.entryId))
      .where(eq(t.sessionSets.id, session.restSetId))
      .get()
    if (!row || row.sessionId !== session.id) return undefined
    return restView(session, { entries: [{ id: row.entryId, exerciseId: row.exerciseId, sets: [{ id: row.id, done: row.done }] }] })
  }

  deleteSet(setId: string, clock: Clock) {
    this.db.transaction((tx) => {
      const set = tx.select().from(t.sessionSets).where(eq(t.sessionSets.id, setId)).get()
      if (!set) throw notFound('Set')
      const { session } = this.entryContext(tx, set.entryId)
      tx.delete(t.sessionSets).where(eq(t.sessionSets.id, setId)).run()
      // History only holds exercises that were performed.
      if (session.status === 'completed' && !tx.select({ id: t.sessionSets.id }).from(t.sessionSets).where(eq(t.sessionSets.entryId, set.entryId)).get()) {
        tx.delete(t.sessionEntries).where(eq(t.sessionEntries.id, set.entryId)).run()
      }
      this.touchSession(tx, session.id, clock)
    })
  }

  /**
   * Finish: keep the performed sets (optionally also sets with reps entered
   * but not ticked), drop the empty ones, and move the session to history —
   * all in one transaction. The template is never changed by this.
   */
  finishSession(id: string, input: Partial<FinishSessionInput>, clock: Clock) {
    this.db.transaction((tx) => {
      const session = this.sessionOf(tx, id)
      if (session.status !== 'active') throw conflict('not_active', 'This workout is already finished.')
      const entries = tx.select().from(t.sessionEntries).where(eq(t.sessionEntries.sessionId, id)).all()
      const entryIds = entries.map((e) => e.id)
      const inSession = entryIds.length ? inArray(t.sessionSets.entryId, entryIds) : sql`0`
      if (input.keepUnticked) {
        tx.update(t.sessionSets)
          .set({ done: true })
          .where(and(inSession, eq(t.sessionSets.done, false), sql`${t.sessionSets.reps} IS NOT NULL`))
          .run()
      }
      const done = tx
        .select()
        .from(t.sessionSets)
        .where(and(inSession, eq(t.sessionSets.done, true)))
        .all()
      if (!done.length) throw conflict('nothing_logged', 'Log at least one set before finishing, or discard the workout.')
      if (done.some((s) => s.reps === null)) throw invalid('A set marked done has no reps. Enter them first.')
      const elapsed = Math.round((clock.now.getTime() - new Date(session.startedAt).getTime()) / 60_000)
      if (input.durationMin === undefined && elapsed > 600) throw invalid('This workout started long ago — enter how long it took.', { field: 'durationMin' })
      tx.delete(t.sessionSets)
        .where(and(inSession, eq(t.sessionSets.done, false)))
        .run()
      const withSets = new Set(done.map((s) => s.entryId))
      for (const e of entries) if (!withSets.has(e.id)) tx.delete(t.sessionEntries).where(eq(t.sessionEntries.id, e.id)).run()
      const minutes = input.durationMin ?? Math.max(1, elapsed)
      tx.update(t.sessions)
        .set({
          status: 'completed',
          durationMin: minutes,
          endedAt: new Date(new Date(session.startedAt).getTime() + minutes * 60_000).toISOString(),
          restSetId: null,
          restSec: null,
          restEndsAt: null,
          restPausedMs: null,
          origin: 'owner',
          updatedAt: clock.now.toISOString(),
        })
        .where(eq(t.sessions.id, id))
        .run()
    })
  }

  discardSession(id: string) {
    const r = this.db.delete(t.sessions).where(and(eq(t.sessions.id, id), eq(t.sessions.status, 'active'))).run()
    if (!r.changes) throw conflict('not_active', 'Only a workout in progress can be discarded.')
  }

  deleteSession(id: string) {
    const r = this.db.delete(t.sessions).where(and(eq(t.sessions.id, id), ne(t.sessions.status, 'active'))).run()
    if (!r.changes) throw notFound('Session')
  }

  /* ---------------------------------------------------------------- */
  /* Notes                                                             */
  /* ---------------------------------------------------------------- */

  addNote(input: { text: string; tag?: NoteTag; pinned: boolean }, clock: Clock): string {
    const stamp = clock.now.toISOString()
    const id = newId('n')
    this.db.insert(t.notes).values({ id, text: input.text, tag: input.tag ?? null, pinned: input.pinned, origin: 'owner', createdAt: stamp, updatedAt: stamp }).run()
    return id
  }

  patchNote(id: string, patch: { text?: string; tag?: NoteTag | null; pinned?: boolean }, clock: Clock) {
    const r = this.db
      .update(t.notes)
      .set({ ...patch, ...(patch.text !== undefined ? { origin: 'owner' as const } : {}), updatedAt: clock.now.toISOString() })
      .where(eq(t.notes.id, id))
      .run()
    if (!r.changes) throw notFound('Note')
  }

  deleteNote(id: string) {
    const r = this.db.delete(t.notes).where(eq(t.notes.id, id)).run()
    if (!r.changes) throw notFound('Note')
  }

  /* ---------------------------------------------------------------- */
  /* Demo data                                                         */
  /* ---------------------------------------------------------------- */

  loadDemo(clock: Clock) {
    const d = buildDemo(clock.now, clock.today)
    this.db.transaction((tx) => {
      const has = (table: typeof t.templates | typeof t.plans | typeof t.sessions | typeof t.blocks) => tx.select({ id: table.id }).from(table).where(eq(table.origin, 'demo')).get()
      if (has(t.templates) || has(t.plans) || has(t.sessions) || has(t.blocks)) throw conflict('demo_present', 'Demo data is already loaded.')
      if (tx.select().from(t.sessions).where(eq(t.sessions.status, 'active')).get()) throw conflict('session_active', 'Finish or discard the workout in progress first.')
      // The owner's goal wins; demo only adds one when there is none.
      if (!tx.select().from(t.goals).where(eq(t.goals.status, 'active')).get()) {
        tx.insert(t.goals).values(d.goal).run()
        for (const g of d.goalTargets) tx.insert(t.goalTargets).values(g).run()
      }
      for (const rows of [
        [t.blocks, d.blocks],
        [t.templates, d.templates],
        [t.templateItems, d.templateItems],
        [t.plans, d.plans],
        [t.sessions, d.sessions],
        [t.sessionEntries, d.entries],
        [t.sessionSets, d.sets],
        [t.notes, d.notes],
      ] as const) {
        for (const r of rows[1]) tx.insert(rows[0] as typeof t.blocks).values(r as typeof t.blocks.$inferInsert).run()
      }
    })
  }

  /** Remove exactly the rows that came from demo data. Owner rows are untouched. */
  clearDemo() {
    this.db.transaction((tx) => {
      tx.delete(t.sessions).where(eq(t.sessions.origin, 'demo')).run()
      tx.delete(t.plans).where(eq(t.plans.origin, 'demo')).run()
      const demoTemplates = tx.select().from(t.templates).where(eq(t.templates.origin, 'demo')).all()
      tx.delete(t.templates).where(eq(t.templates.origin, 'demo')).run()
      tx.delete(t.blocks).where(eq(t.blocks.origin, 'demo')).run()
      tx.delete(t.goals).where(eq(t.goals.origin, 'demo')).run()
      tx.delete(t.notes).where(eq(t.notes.origin, 'demo')).run()
      for (const b of new Set(demoTemplates.map((x) => x.blockId))) this.renumber(tx, b)
      this.renumber(tx, null)
    })
  }
}

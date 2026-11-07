/**
 * v0.1.1 — reusable workouts + live session logging. Every test uses an
 * isolated temporary database; nothing touches ~/.local/share/sahale.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { nextInSequence, previousFor } from '../shared/fitness/derive'
import type { SessionLog } from '../shared/fitness/types'
import { openDatabase, readMigrations } from '../server/db'
import type { Clock, FitnessService } from '../server/fitness/service'
import { clockAt, harness, MIGRATIONS, NOW, openDb, services, tempDir } from './helpers'

const LOWER_A = {
  name: 'Lower A',
  focus: 'Squat / Quads',
  items: [
    { exerciseId: 'back-squat', sets: 3, repMin: 5, repMax: 8, rpe: 8 },
    { exerciseId: 'rdl', sets: 3, repMin: 6, repMax: 10, rpe: 8 },
    { exerciseId: 'split-squat', sets: 2, repMin: 8, repMax: 12, rpe: 8, note: 'Per leg' },
    { exerciseId: 'leg-curl', sets: 3, repMin: 8, repMax: 15 },
  ],
}

const at = (minutes: number) => clockAt(new Date(NOW.getTime() + minutes * 60_000))
const day = (days: number, hour = 18) => clockAt(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days, hour))

/** Log every prescribed set of the live session with the given numbers, then finish. */
function logAll(fitness: FitnessService, clock: Clock, load: (exerciseId: string, i: number) => [number | null, number, number?]) {
  const active = fitness.snapshot(clock).active!
  for (const e of active.entries) {
    e.sets.forEach((s, i) => {
      const [weight, reps, rpe] = load(e.exerciseId, i)
      fitness.patchSet(s.id!, { weight, reps, rpe: rpe ?? null, done: true }, clock)
    })
  }
  fitness.finishSession(active.id, { durationMin: 60 }, clock)
  return active.id
}

describe('reusable workouts', () => {
  it('a workout template needs no date, and rep ranges persist as structured data', async () => {
    const path = join(tempDir(), 'sahale.db')
    const clock = clockAt()
    {
      const db = await openDb(path)
      const { fitness } = services(db)
      const block = fitness.createBlock({ name: 'Strength + Hypertrophy Base', phase: 'Accumulation', intent: '', scheme: 'Double progression', startDate: clock.today, weeks: 8 }, clock)
      fitness.createTemplate({ ...LOWER_A, blockId: block }, clock)
      db.sqlite.close()
    }
    const db = await openDb(path)
    const snap = services(db).fitness.snapshot(clock)
    expect(snap.templates).toHaveLength(1)
    const w = snap.templates[0]
    expect(w).not.toHaveProperty('date')
    expect(snap.plans).toEqual([]) // nothing scheduled
    expect(w.items.map((i) => [i.exerciseId, i.sets, i.repMin, i.repMax, i.rpe, i.load, i.note])).toEqual([
      ['back-squat', 3, 5, 8, 8, undefined, undefined],
      ['rdl', 3, 6, 10, 8, undefined, undefined],
      ['split-squat', 2, 8, 12, 8, undefined, 'Per leg'],
      ['leg-curl', 3, 8, 15, undefined, undefined, undefined],
    ])
    // Stored as real columns, not a string to parse later.
    expect(db.sqlite.prepare(`SELECT rep_min, rep_max, target_rpe FROM fitness_template_items WHERE exercise_id = 'back-squat'`).get()).toEqual({ rep_min: 5, rep_max: 8, target_rpe: 8 })
    expect(snap.nextTemplateId).toBe(w.id)
    db.sqlite.close()
  })

  it('creates, edits, duplicates and reorders workouts in a block over the API', async () => {
    const h = await harness()
    const block = (await h.call('POST', '/api/fitness/blocks', { name: 'Base', startDate: '2026-10-05', weeks: 8 })).body.id
    const ids: string[] = []
    for (const name of ['Upper A', 'Lower A', 'Upper B']) {
      const r = await h.call('POST', '/api/fitness/templates', { name, blockId: block, items: [{ exerciseId: 'bench-press', sets: 3, repMin: 6, repMax: 10 }] })
      expect(r.status).toBe(201)
      ids.push(r.body.id)
    }
    const dup = await h.call('POST', `/api/fitness/templates/${ids[1]}/duplicate`, { name: 'Lower B' })
    expect(dup.status).toBe(201)
    let snap = dup.body.snapshot
    expect(snap.templates.map((w: { name: string }) => w.name)).toEqual(['Upper A', 'Lower A', 'Lower B', 'Upper B'])

    const order = [ids[0], ids[1], ids[2], dup.body.id]
    snap = (await h.call('POST', '/api/fitness/templates/order', { blockId: block, ids: order })).body.snapshot
    expect(snap.templates.map((w: { name: string }) => w.name)).toEqual(['Upper A', 'Lower A', 'Upper B', 'Lower B'])
    expect((await h.call('POST', '/api/fitness/templates/order', { blockId: block, ids: order.slice(1) })).status).toBe(409)

    const lowerA = snap.templates[1]
    const edit = await h.call('PATCH', `/api/fitness/templates/${lowerA.id}`, {
      version: lowerA.version,
      items: [{ id: lowerA.items[0].id, exerciseId: 'back-squat', sets: 3, repMin: 5, repMax: 8, rpe: 8 }, { exerciseId: 'leg-press', sets: 3, repMin: 10, repMax: 15 }],
    })
    expect(edit.status).toBe(200)
    const after = edit.body.snapshot.templates[1]
    expect(after.version).toBe(2)
    expect(after.items[0].id).toBe(lowerA.items[0].id)
    expect(after.items.map((i: { repMin: number; repMax: number }) => `${i.repMin}–${i.repMax}`)).toEqual(['5–8', '10–15'])
    // An edit made against the old version is refused.
    expect((await h.call('PATCH', `/api/fitness/templates/${lowerA.id}`, { version: lowerA.version, name: 'x' })).status).toBe(409)
  })

  it('custom exercises persist and work everywhere built-in ones do', async () => {
    const path = join(tempDir(), 'sahale.db')
    const h = await harness({ dbPath: path })
    const created = await h.call('POST', '/api/fitness/exercises', { name: 'Smith Machine Calf Raise', equipment: 'Smith machine', note: 'Slow eccentric' })
    expect(created.status).toBe(201)
    const id = created.body.id
    expect(created.body.snapshot.exercises.find((e: { id: string }) => e.id === id)).toMatchObject({ name: 'Smith Machine Calf Raise', pattern: 'Other', origin: 'owner', equipment: 'Smith machine' })
    expect((await h.call('POST', '/api/fitness/exercises', { name: 'smith machine calf raise' })).status).toBe(409)

    // In a template, a live session and history.
    const w = (await h.call('POST', '/api/fitness/templates', { name: 'Lower A', items: [{ exerciseId: id, sets: 2, repMin: 10, repMax: 15 }] })).body.id
    const started = (await h.call('POST', '/api/fitness/sessions', { templateId: w })).body
    const set = started.snapshot.active.entries[0].sets[0]
    await h.call('PATCH', `/api/fitness/sets/${set.id}`, { weight: 90, reps: 14, done: true })
    const finished = (await h.call('POST', `/api/fitness/sessions/${started.id}/finish`, {})).body.snapshot
    expect(finished.sessions[0].entries[0]).toMatchObject({ exerciseId: id, sets: [{ weight: 90, reps: 14, done: true }] })

    // In use → can't be deleted; built-ins can never be deleted.
    expect((await h.call('DELETE', `/api/fitness/exercises/${id}`)).status).toBe(409)
    expect((await h.call('DELETE', '/api/fitness/exercises/back-squat')).status).toBe(409)
    const unused = (await h.call('POST', '/api/fitness/exercises', { name: 'Typo Curl' })).body.id
    expect((await h.call('DELETE', `/api/fitness/exercises/${unused}`)).status).toBe(200)

    h.database.sqlite.close()
    const db = await openDb(path)
    expect(services(db).fitness.snapshot(h.clock).exercises.find((e) => e.id === id)?.origin).toBe('owner')
    db.sqlite.close()
  })

  it('deleting a workout keeps history and one-off plans, and drops its plain plans', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    const w = fitness.createTemplate(LOWER_A, clock)
    fitness.startSession({ templateId: w }, clock)
    logAll(fitness, clock, () => [100, 8])
    const plain = fitness.createPlan({ templateId: w, date: '2026-10-08' }, clock)
    const custom = fitness.createPlan({ templateId: w, date: '2026-10-09' }, clock)
    fitness.updatePlan(custom, { version: 1, items: [{ exerciseId: 'back-squat', sets: 2, repMin: 5, repMax: 5 }] }, clock)
    fitness.deleteTemplate(w)
    const snap = fitness.snapshot(clock)
    expect(snap.templates).toEqual([])
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0].entries[0].target).toMatchObject({ repMin: 5, repMax: 8 })
    expect(snap.plans.map((p) => p.id)).toEqual([custom])
    expect(snap.plans.find((p) => p.id === plain)).toBeUndefined()
  })
})

describe('live workout sessions', () => {
  it('Start workout writes a durable active session with the prescription and empty set rows', async () => {
    const h = await harness()
    const w = (await h.call('POST', '/api/fitness/templates', LOWER_A)).body.id
    const r = await h.call('POST', '/api/fitness/sessions', { templateId: w })
    expect(r.status).toBe(201)
    const active = r.body.snapshot.active
    expect(active).toMatchObject({ id: r.body.id, name: 'Lower A', templateId: w, status: 'active' })
    expect(active.entries.map((e: { target: { sets: number; repMin: number; repMax: number } }) => `${e.target.sets}×${e.target.repMin}–${e.target.repMax}`)).toEqual(['3×5–8', '3×6–10', '2×8–12', '3×8–15'])
    // One row per prescribed set — nothing performed yet, so nothing filled in.
    expect(active.entries[0].sets).toEqual([
      { id: expect.any(String), done: false },
      { id: expect.any(String), done: false },
      { id: expect.any(String), done: false },
    ])
    expect(h.database.sqlite.prepare(`SELECT status FROM fitness_sessions`).all()).toEqual([{ status: 'active' }])
    // Only one live workout at a time — enforced by the service and the database.
    expect((await h.call('POST', '/api/fitness/sessions', { templateId: w })).body.code).toBe('session_active')
    expect(() =>
      h.database.sqlite.prepare(`INSERT INTO fitness_sessions (id, name, status, started_at, origin, created_at, updated_at) VALUES ('s_x', 'x', 'active', 'x', 'owner', 'x', 'x')`).run(),
    ).toThrow(/UNIQUE/)
  })

  it('an active session survives a restart with logged and entered-but-unticked sets intact', async () => {
    const path = join(tempDir(), 'sahale.db')
    const clock = clockAt()
    let id: string
    {
      const db = await openDb(path)
      const { fitness } = services(db)
      id = fitness.startSession({ templateId: fitness.createTemplate(LOWER_A, clock) }, clock)
      const sets = fitness.snapshot(clock).active!.entries[0].sets
      fitness.patchSet(sets[0].id!, { weight: 185, reps: 8, rpe: 7.5, done: true }, clock)
      fitness.patchSet(sets[1].id!, { weight: 185, note: 'belt on' }, clock) // typed, not ticked
      db.sqlite.close() // e.g. the runtime restarts mid-workout
    }
    const db = await openDb(path)
    const active = services(db).fitness.snapshot(at(20)).active!
    expect(active.id).toBe(id)
    expect(active.durationMin).toBe(20)
    expect(active.entries[0].sets.map((s) => [s.weight, s.reps, s.rpe, s.done, s.note])).toEqual([
      [185, 8, 7.5, true, undefined],
      [185, undefined, undefined, false, 'belt on'],
      [undefined, undefined, undefined, false, undefined],
    ])
    db.sqlite.close()
  })

  it('keeps actual sets separate from the prescription', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    fitness.startSession({ templateId: fitness.createTemplate(LOWER_A, clock) }, clock)
    const entry = fitness.snapshot(clock).active!.entries[0]
    fitness.patchSet(entry.sets[0].id!, { weight: 185, reps: 8, rpe: 7.5, done: true }, clock)
    fitness.patchSet(entry.sets[1].id!, { weight: 185, reps: 8, rpe: 8, done: true }, clock)
    fitness.patchSet(entry.sets[2].id!, { weight: 185, reps: 7, rpe: 9, done: true }, clock)
    fitness.addSet(entry.id!, clock) // a fourth set beyond the prescription
    const after = fitness.snapshot(clock).active!.entries[0]
    expect(after.target).toEqual({ exerciseId: 'back-squat', sets: 3, repMin: 5, repMax: 8, rpe: 8, load: undefined, note: undefined, adjustedBy: undefined, adjustmentNote: undefined })
    expect(after.sets.map((s) => [s.weight, s.reps, s.rpe, s.done])).toEqual([
      [185, 8, 7.5, true],
      [185, 8, 8, true],
      [185, 7, 9, true],
      [undefined, undefined, undefined, false],
    ])
    // A set can't be "done" without reps.
    expect(() => fitness.patchSet(after.sets[3].id!, { done: true }, clock)).toThrow(/reps/)
  })

  it('Finish moves the workout to history atomically; it never needs every set, and never edits the template', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    const w = fitness.createTemplate(LOWER_A, clock)
    const id = fitness.startSession({ templateId: w }, clock)
    expect(() => fitness.finishSession(id, {}, at(5))).toThrow(/at least one set/)
    const entries = fitness.snapshot(clock).active!.entries
    fitness.patchSet(entries[0].sets[0].id!, { weight: 185, reps: 8, done: true }, clock)
    fitness.patchSet(entries[0].sets[1].id!, { weight: 185, reps: 7 }, clock) // entered, not ticked
    fitness.finishSession(id, { keepUnticked: true }, at(52))
    const snap = fitness.snapshot(at(52))
    expect(snap.active).toBeNull()
    expect(snap.sessions[0]).toMatchObject({ id, status: 'completed', durationMin: 52, templateId: w })
    expect(snap.sessions[0].endedAt).toBe(new Date(NOW.getTime() + 52 * 60_000).toISOString())
    expect(snap.sessions[0].entries).toHaveLength(1) // exercises with nothing logged aren't history
    expect(snap.sessions[0].entries[0].sets.map((s) => [s.weight, s.reps])).toEqual([
      [185, 8],
      [185, 7],
    ])
    expect(snap.templates[0]).toMatchObject({ version: 1, lastSessionId: id, items: expect.arrayContaining([expect.objectContaining({ exerciseId: 'back-squat', repMin: 5, repMax: 8 })]) })
    expect(() => fitness.finishSession(id, {}, clock)).toThrow(/already finished/)

    // Without keepUnticked, an entered-but-unticked set is dropped.
    const second = fitness.startSession({ templateId: w }, day(2))
    const e2 = fitness.snapshot(day(2)).active!.entries[0]
    fitness.patchSet(e2.sets[0].id!, { weight: 190, reps: 6, done: true }, day(2))
    fitness.patchSet(e2.sets[1].id!, { weight: 190, reps: 5 }, day(2))
    fitness.finishSession(second, {}, day(2))
    expect(fitness.snapshot(day(2)).sessions[0].entries[0].sets.map((s) => s.reps)).toEqual([6])
  })

  it('completed history keeps its prescription snapshot when the template changes later', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    const w = fitness.createTemplate(LOWER_A, clock)
    fitness.startSession({ templateId: w }, clock)
    const id = logAll(fitness, clock, (_e, i) => [185, 8 - i, 8])
    const before = fitness.snapshot(clock).sessions[0]

    const tpl = fitness.snapshot(clock).templates[0]
    fitness.updateTemplate(w, { version: tpl.version, name: 'Lower A (v2)', items: [{ exerciseId: 'front-squat', sets: 5, repMin: 3, repMax: 3, rpe: 9 }] }, clock)
    const after = fitness.snapshot(clock).sessions[0]
    expect(after).toEqual(before)
    expect(after.name).toBe('Lower A')
    expect(after.entries[0].target).toMatchObject({ exerciseId: 'back-squat', sets: 3, repMin: 5, repMax: 8 })
    expect(after.id).toBe(id)
  })
})

describe('optional planning', () => {
  it('a plan can be set, moved and cleared without touching the template', async () => {
    const h = await harness()
    const w = (await h.call('POST', '/api/fitness/templates', LOWER_A)).body
    const tpl = w.snapshot.templates[0]
    const plan = await h.call('POST', '/api/fitness/plans', { templateId: w.id, date: '2026-10-08' })
    expect(plan.status).toBe(201)
    expect(plan.body.snapshot.plans[0]).toMatchObject({ templateId: w.id, date: '2026-10-08', status: 'planned', name: 'Lower A', custom: false })
    expect(plan.body.snapshot.upcomingPlanId).toBe(plan.body.id)
    expect((await h.call('POST', '/api/fitness/plans', { templateId: w.id, date: '2026-10-08' })).status).toBe(409) // already planned

    const moved = await h.call('PATCH', `/api/fitness/plans/${plan.body.id}`, { version: 1, date: '2026-10-09' })
    expect(moved.body.snapshot.plans[0]).toMatchObject({ date: '2026-10-09', version: 2 })
    const cleared = await h.call('DELETE', `/api/fitness/plans/${plan.body.id}`)
    expect(cleared.body.snapshot.plans).toEqual([])
    expect(cleared.body.snapshot.templates[0]).toEqual(tpl)
  })

  it('a missed planned date creates no history; the workout can still be started later', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const w = fitness.createTemplate(LOWER_A, clockAt())
    const planned = fitness.createPlan({ templateId: w, date: day(1).today }, clockAt()) // Tuesday
    const old = fitness.createPlan({ templateId: w, date: day(-10).today }, clockAt())

    const thursday = day(3)
    let snap = fitness.snapshot(thursday)
    expect(snap.plans.find((p) => p.id === planned)).toMatchObject({ status: 'missed', sessionId: undefined })
    expect(snap.sessions).toEqual([])
    expect(snap.active).toBeNull()
    expect(snap.nextTemplateId).toBe(w) // still the next workout

    // Train two days late: starting the workout fulfils the missed plan (within a week), not the old one.
    const s = fitness.startSession({ templateId: w }, thursday)
    snap = fitness.snapshot(thursday)
    expect(snap.active).toMatchObject({ id: s, planId: planned })
    expect(snap.plans.find((p) => p.id === old)!.status).toBe('missed')
    logAll(fitness, thursday, () => [100, 8])
    expect(fitness.snapshot(thursday).plans.find((p) => p.id === planned)).toMatchObject({ status: 'done', sessionId: s })
  })

  it('starting early also fulfils the plan, and a day adjusted on its own uses its own prescription', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    const w = fitness.createTemplate(LOWER_A, clock)
    const plan = fitness.createPlan({ templateId: w, date: day(2).today }, clock)
    fitness.updatePlan(plan, { version: 1, items: [{ exerciseId: 'back-squat', sets: 2, repMin: 3, repMax: 3, rpe: 7 }] }, clock)
    const s = fitness.startSession({ templateId: w }, clock) // two days early
    const active = fitness.snapshot(clock).active!
    expect(active.planId).toBe(plan)
    expect(active.entries.map((e) => [e.exerciseId, e.target?.sets, e.target?.repMin])).toEqual([['back-squat', 2, 3]])
    expect(fitness.snapshot(clock).templates[0].items).toHaveLength(4) // template untouched
    fitness.discardSession(s)
    fitness.resetPlan(plan, 2, clock)
    expect(fitness.snapshot(clock).plans[0]).toMatchObject({ custom: false, items: fitness.snapshot(clock).templates[0].items })
  })
})

describe('previous performance and sequence', () => {
  it('resolves "last time" from the same workout first, then any workout', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const a = fitness.createTemplate(LOWER_A, clockAt())
    const b = fitness.createTemplate({ name: 'Lower B', items: [{ exerciseId: 'back-squat', sets: 2, repMin: 8, repMax: 12 }] }, clockAt())

    fitness.startSession({ templateId: a }, day(-6))
    logAll(fitness, day(-6), (e, i) => (e === 'back-squat' ? [185, [8, 8, 7][i], [7.5, 8, 9][i]] : [100, 10]))
    fitness.startSession({ templateId: b }, day(-3))
    logAll(fitness, day(-3), () => [155, 12])

    const sessions = fitness.snapshot(clockAt()).sessions
    const sameWorkout = previousFor(sessions, 'back-squat', a)!
    expect(sameWorkout).toMatchObject({ sameWorkout: true, session: { name: 'Lower A' } })
    expect(sameWorkout.entry.sets.map((s) => `${s.weight}×${s.reps}`)).toEqual(['185×8', '185×8', '185×7'])
    expect(previousFor(sessions, 'back-squat')).toMatchObject({ sameWorkout: false, session: { name: 'Lower B' } })
    expect(previousFor(sessions, 'rdl', b)).toMatchObject({ sameWorkout: false, session: { name: 'Lower A' } }) // falls back
    expect(previousFor(sessions, 'deadlift', a)).toBeUndefined()
  })

  it('suggests the next workout from the block order, whatever the calendar says', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    const block = fitness.createBlock({ name: 'Base', phase: '', intent: '', scheme: '', startDate: clock.today, weeks: 8 }, clock)
    const [ua, la, ub, lb] = ['Upper A', 'Lower A', 'Upper B', 'Lower B'].map((name) => fitness.createTemplate({ name, blockId: block, items: [{ exerciseId: 'bench-press', sets: 1, repMin: 5, repMax: 8 }] }, clock))
    expect(fitness.snapshot(clock).nextTemplateId).toBe(ua)
    for (const [w, next, d] of [
      [ua, la, 0],
      [la, ub, 3],
      [lb, ua, 4], // skipped Upper B; the sequence continues after what was actually done
    ] as const) {
      fitness.startSession({ templateId: w }, day(d))
      logAll(fitness, day(d), () => [100, 5])
      expect(fitness.snapshot(day(d)).nextTemplateId).toBe(next)
    }
    const t = fitness.snapshot(clock).templates
    expect(nextInSequence(t, [{ templateId: ub } as SessionLog])?.id).toBe(lb)
  })
})

describe('migrating a v0.1 database', () => {
  /** A database migrated only to v0.1's schema, filled like a real owner's. */
  async function v01Database() {
    const dir = tempDir()
    const migrations = join(dir, 'v01-migrations')
    cpSync(MIGRATIONS, migrations, { recursive: true })
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8'))
    journal.entries = journal.entries.slice(0, 1)
    writeFileSync(join(migrations, 'meta', '_journal.json'), JSON.stringify(journal))
    const path = join(dir, 'sahale.db')
    const opened = await openDatabase(path, { migrationsDir: migrations })
    const db = opened.sqlite!
    const run = (sql: string) => db.prepare(sql).run()
    run(`INSERT INTO fitness_exercises (id, name, pattern, origin, created_at, updated_at) VALUES ('back-squat', 'Back Squat', 'Squat', 'library', 'x', 'x'), ('split-squat', 'Bulgarian Split Squat', 'Squat', 'library', 'x', 'x')`)
    run(`INSERT INTO fitness_goals (id, statement, target_date, status, origin, created_at, updated_at) VALUES ('g_real', 'Build strength, build muscle', '2026-12-11', 'active', 'owner', '2026-10-07T00:10:00.000Z', '2026-10-07T00:10:00.000Z')`)
    run(`INSERT INTO fitness_goal_targets (id, goal_id, exercise_id, target_load, position) VALUES ('gt1', 'g_real', 'back-squat', 315, 0)`)
    run(`INSERT INTO fitness_blocks (id, name, phase, intent, scheme, start_date, weeks, deload_week, origin, created_at, updated_at) VALUES ('b_real', 'Strength + Hypertrophy Base', 'Accumulation', 'Build muscle and strength', 'Double progression; compounds 5–10, accessories 8–20', '2026-10-06', 8, NULL, 'owner', '2026-10-07T00:11:48.457Z', '2026-10-07T00:11:48.457Z')`)
    run(`INSERT INTO fitness_notes (id, text, pinned, origin, created_at, updated_at) VALUES ('n1', 'Left knee', 1, 'owner', 'x', 'x')`)
    run(`INSERT INTO fitness_workouts (id, block_id, date, name, version, origin, created_at, updated_at) VALUES ('w_old', 'b_real', '2026-10-08', 'Lower', 3, 'owner', 'x', 'x'), ('w_done', 'b_real', '2026-10-06', 'Upper', 1, 'owner', 'x', 'x')`)
    run(`INSERT INTO fitness_workout_items (id, workout_id, position, exercise_id, sets, reps, reps_label, load, rpe, note) VALUES ('wi1', 'w_old', 0, 'back-squat', 4, 5, NULL, 265, '8', NULL), ('wi2', 'w_old', 1, 'split-squat', 3, 10, '10/leg', 35, '7–8', 'knee')`)
    run(`INSERT INTO fitness_sessions (id, workout_id, name, status, started_at, ended_at, duration_min, origin, created_at, updated_at) VALUES ('s_done', 'w_done', 'Upper', 'completed', '2026-10-06T17:00:00.000Z', '2026-10-06T18:00:00.000Z', 60, 'owner', 'x', 'x')`)
    run(`INSERT INTO fitness_session_entries (id, session_id, position, exercise_id, target) VALUES ('se1', 's_done', 0, 'back-squat', '{"exerciseId":"back-squat","sets":3,"reps":5,"load":225,"rpe":"8"}')`)
    run(`INSERT INTO fitness_session_sets (id, entry_id, position, weight, reps, rpe, done) VALUES ('ss1', 'se1', 0, 225, 5, 8, 1)`)
    const snapshotRows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    const before = { goals: snapshotRows('fitness_goals'), targets: snapshotRows('fitness_goal_targets'), blocks: snapshotRows('fitness_blocks'), notes: snapshotRows('fitness_notes') }
    db.close()
    return { dir, path, before }
  }

  it('backs up first, keeps the goal and training block exactly, and maps old workouts without inventing templates', async () => {
    const { dir, path, before } = await v01Database()
    const opened = await openDatabase(path, { migrationsDir: MIGRATIONS, backupsDir: join(dir, 'backups') })
    // 0001 and every later migration, in order.
    expect(opened.status).toMatchObject({ state: 'ready', appliedNow: readMigrations(MIGRATIONS).slice(1).map((m) => m.tag) })
    expect(opened.status.appliedNow.slice(0, 2)).toEqual(['0001_reusable_workouts', '0002_rest_timer'])
    expect(opened.status.backup).toMatch(/before-0001_reusable_workouts\.db$/)
    expect(existsSync(opened.status.backup!)).toBe(true)
    // The backup is the untouched v0.1 database.
    const backup = new Database(opened.status.backup!, { readonly: true })
    expect(backup.prepare(`SELECT count(*) AS n FROM fitness_workouts`).get()).toEqual({ n: 2 })
    backup.close()

    const db = opened.sqlite!
    const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    expect({ goals: rows('fitness_goals'), targets: rows('fitness_goal_targets'), blocks: rows('fitness_blocks'), notes: rows('fitness_notes') }).toEqual(before)

    const fitness = services(opened as Parameters<typeof services>[0]).fitness
    const snap = fitness.snapshot(clockAt())
    expect(snap.goal).toMatchObject({ id: 'g_real', statement: 'Build strength, build muscle', date: '2026-12-11', targets: [{ exerciseId: 'back-squat', target: 315 }] })
    expect(snap.blocks).toEqual([expect.objectContaining({ id: 'b_real', name: 'Strength + Hypertrophy Base', weeks: 8, scheme: 'Double progression; compounds 5–10, accessories 8–20' })])
    expect(snap.templates).toEqual([]) // nothing invented
    expect(snap.plans.map((p) => [p.id, p.date, p.name, p.legacy, p.custom, p.status, p.version])).toEqual([
      ['w_done', '2026-10-06', 'Upper', true, true, 'done', 1],
      ['w_old', '2026-10-08', 'Lower', true, true, 'planned', 3],
    ])
    expect(snap.plans[1].items.map((i) => [i.exerciseId, i.sets, i.repMin, i.repMax, i.load, i.rpe, i.note])).toEqual([
      ['back-squat', 4, 5, 5, 265, 8, undefined],
      ['split-squat', 3, 10, 10, 35, undefined, 'knee · Reps: 10/leg · RPE 7–8'], // ambiguity kept, labelled
    ])
    expect(snap.sessions[0]).toMatchObject({ id: 's_done', planId: 'w_done', status: 'completed', durationMin: 60 })
    expect(snap.sessions[0].entries[0]).toMatchObject({ target: { sets: 3, repMin: 5, repMax: 5, load: 225, rpe: 8 }, sets: [{ weight: 225, reps: 5, rpe: 8, done: true }] })
    expect(db.pragma('foreign_key_check')).toEqual([])

    // A legacy one-off can become a reusable workout when the owner chooses.
    const tpl = fitness.planToTemplate('w_old', { name: 'Lower A' }, clockAt())
    const after = fitness.snapshot(clockAt())
    expect(after.templates).toEqual([expect.objectContaining({ id: tpl, name: 'Lower A', blockId: 'b_real' })])
    expect(after.plans.find((p) => p.id === 'w_old')).toMatchObject({ templateId: tpl, custom: false, legacy: false })
    db.close()
  })

  it('migrates the owner’s real-world shape (one goal, one block, nothing else) cleanly', async () => {
    const dir = tempDir()
    const migrations = join(dir, 'm')
    cpSync(MIGRATIONS, migrations, { recursive: true })
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8'))
    journal.entries = journal.entries.slice(0, 1)
    writeFileSync(join(migrations, 'meta', '_journal.json'), JSON.stringify(journal))
    const path = join(dir, 'sahale.db')
    const first = await openDatabase(path, { migrationsDir: migrations })
    first.sqlite!.prepare(`INSERT INTO fitness_goals (id, statement, status, origin, created_at, updated_at) VALUES ('g', 'Get strong', 'active', 'owner', 'x', 'x')`).run()
    first.sqlite!.prepare(`INSERT INTO fitness_blocks (id, name, start_date, weeks, origin, created_at, updated_at) VALUES ('b', 'Base', '2026-10-06', 8, 'owner', 'x', 'x')`).run()
    first.sqlite!.close()
    const opened = await openDatabase(path, { migrationsDir: MIGRATIONS, backupsDir: join(dir, 'backups') })
    expect(opened.status.state).toBe('ready')
    const snap = services(opened as Parameters<typeof services>[0]).fitness.snapshot(clockAt())
    expect(snap.goal?.statement).toBe('Get strong')
    expect(snap.blocks.map((b) => b.name)).toEqual(['Base'])
    expect(snap.programBlockId).toBe('b')
    opened.sqlite!.close()
  })
})

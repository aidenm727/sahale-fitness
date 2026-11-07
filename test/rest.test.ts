/**
 * v0.1.2 — the rest timer. Rest is part of the live session in the database,
 * stored as a deadline; every test uses an isolated temporary database.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fmtClock, restDisplaySec, restLeft, restSecFor } from '../shared/fitness/derive'
import type { FitnessSnapshot, RestState } from '../shared/fitness/types'
import { openDatabase, readMigrations } from '../server/db'
import { clockAt, harness, MIGRATIONS, NOW, openDb, services, tempDir } from './helpers'

const UPPER = {
  name: 'Upper A',
  items: [
    { exerciseId: 'bench-press', sets: 2, repMin: 5, repMax: 8 }, // main lift → 3:00
    { exerciseId: 'lateral-raise', sets: 1, repMin: 12, repMax: 20 }, // accessory → 1:30
  ],
}

/** A runtime whose clock the test moves by hand. */
async function live(dbPath?: string) {
  let now = NOW.getTime()
  const h = await harness({ dbPath, now: () => new Date(now) })
  const tpl = (await h.call('POST', '/api/fitness/templates', UPPER)).body.id
  const started = (await h.call('POST', '/api/fitness/sessions', { templateId: tpl })).body
  const snap = () => h.call('GET', '/api/fitness').then((r) => r.body as FitnessSnapshot)
  const sets = (s: FitnessSnapshot) => s.active!.entries.flatMap((e) => e.sets.map((x) => x.id!))
  return {
    h,
    sessionId: started.id as string,
    ids: sets(started.snapshot),
    snap,
    at: (seconds: number) => (now = NOW.getTime() + seconds * 1000),
    tick: (setId: string, body: object = { weight: 185, reps: 6, done: true }) => h.call('PATCH', `/api/fitness/sets/${setId}`, body),
    rest: (body: object) => h.call('POST', `/api/fitness/sessions/${started.id}/rest`, body),
  }
}
const iso = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString()
const left = (rest: RestState | undefined, seconds: number) => restLeft(rest!, NOW.getTime() + seconds * 1000).leftMs

describe('rest after a working set', () => {
  it('starts when a set is completed, as a deadline for that exercise’s rest length', async () => {
    const w = await live()
    const before = await w.snap()
    expect(before.active!.rest).toBeUndefined()

    w.at(30)
    const r = await w.tick(w.ids[0])
    expect(r.status).toBe(200)
    const rest = r.body.snapshot.active.rest as RestState
    expect(rest).toEqual({ setId: w.ids[0], entryId: before.active!.entries[0].id, exerciseId: 'bench-press', sec: 180, endsAt: iso(30 + 180) })
    // Stored as a deadline in the session row, not a running count.
    expect(w.h.database.sqlite.prepare(`SELECT rest_set_id, rest_sec, rest_ends_at, rest_paused_ms FROM fitness_sessions WHERE id = ?`).get(w.sessionId)).toEqual({
      rest_set_id: w.ids[0],
      rest_sec: 180,
      rest_ends_at: iso(210),
      rest_paused_ms: null,
    })
    // Re-sending "done" (a double tap, a keepalive flush) doesn't restart it.
    w.at(60)
    expect((await w.tick(w.ids[0])).body.snapshot.active.rest.endsAt).toBe(iso(210))
    // Typing into another set doesn't touch it either.
    expect((await w.tick(w.ids[1], { weight: 190 })).body.snapshot.active.rest.endsAt).toBe(iso(210))
  })

  it('uses the exercise’s own rest when set: 0 means no timer, null goes back to the default', async () => {
    const w = await live()
    expect((await w.h.call('PATCH', '/api/fitness/exercises/bench-press', { restSec: 150 })).body.snapshot.exercises.find((e: { id: string }) => e.id === 'bench-press').restSec).toBe(150)
    expect((await w.tick(w.ids[0])).body.snapshot.active.rest).toMatchObject({ sec: 150, endsAt: iso(150) })

    await w.h.call('PATCH', '/api/fitness/exercises/bench-press', { restSec: 0 })
    const off = (await w.tick(w.ids[1])).body.snapshot as FitnessSnapshot
    expect(off.active!.rest).toBeUndefined() // and the earlier rest is over: a newer set was done

    await w.h.call('PATCH', '/api/fitness/exercises/bench-press', { restSec: null })
    const back = (await w.snap()).exercises.find((e) => e.id === 'bench-press')!
    expect(back.restSec).toBeUndefined()
    expect(restSecFor(back)).toBe(180)
    // Setting only the rest leaves everything else about the exercise as it was.
    expect(back).toMatchObject({ name: 'Bench Press', pattern: 'Press', main: true, bodyweight: false, equipment: 'Barbell · medium grip', origin: 'library' })
    expect(back.cues).toHaveLength(3)

    // Out of range or fractional values are refused and change nothing.
    for (const restSec of [-1, 901, 12.5, '90']) expect((await w.h.call('PATCH', '/api/fitness/exercises/bench-press', { restSec })).status).toBe(400)
    expect((await w.snap()).exercises.find((e) => e.id === 'bench-press')!.restSec).toBeUndefined()
  })

  it('custom exercises can carry a rest length from creation', async () => {
    const h = await harness()
    const r = await h.call('POST', '/api/fitness/exercises', { name: 'Landmine Press', restSec: 60 })
    expect(r.body.snapshot.exercises.find((e: { id: string }) => e.id === r.body.id)).toMatchObject({ name: 'Landmine Press', restSec: 60 })
  })

  it('a newer set replaces the rest; the last set of the workout starts none', async () => {
    const w = await live()
    await w.tick(w.ids[0])
    w.at(100)
    expect((await w.tick(w.ids[1])).body.snapshot.active.rest).toMatchObject({ setId: w.ids[1], endsAt: iso(100 + 180) })
    w.at(200)
    // Nothing is left after this one: no rest, and the previous one is over.
    expect((await w.tick(w.ids[2])).body.snapshot.active.rest).toBeUndefined()
  })

  it('un-ticking, deleting or removing the set that started it ends the rest', async () => {
    const w = await live()
    await w.tick(w.ids[0])
    expect((await w.tick(w.ids[0], { done: false })).body.snapshot.active.rest).toBeUndefined()
    expect(w.h.database.sqlite.prepare(`SELECT rest_set_id FROM fitness_sessions WHERE id = ?`).get(w.sessionId)).toEqual({ rest_set_id: null })

    // Ticking again starts a fresh rest from now.
    w.at(40)
    expect((await w.tick(w.ids[0])).body.snapshot.active.rest).toMatchObject({ endsAt: iso(220) })
    expect((await w.h.call('DELETE', `/api/fitness/sets/${w.ids[0]}`)).body.snapshot.active.rest).toBeUndefined()

    const entry = (await w.snap()).active!.entries[0]
    await w.tick(entry.sets[0].id!)
    expect((await w.snap()).active!.rest).toBeDefined()
    expect((await w.h.call('DELETE', `/api/fitness/entries/${entry.id}`)).body.snapshot.active.rest).toBeUndefined()
    // Controls on a rest that no longer applies change nothing.
    expect((await w.rest({ op: 'adjust', sec: 30 })).body.snapshot.active.rest).toBeUndefined()
  })

  it('never starts while editing a finished workout', async () => {
    const w = await live()
    await w.tick(w.ids[0])
    await w.h.call('POST', `/api/fitness/sessions/${w.sessionId}/finish`, {})
    const done = (await w.snap()).sessions[0]
    expect(done.rest).toBeUndefined()
    await w.h.call('POST', `/api/fitness/entries/${done.entries[0].id}/sets`)
    const added = (await w.snap()).sessions[0].entries[0].sets
    await w.tick(added.at(-1)!.id!, { reps: 4 })
    const row = w.h.database.sqlite.prepare(`SELECT rest_set_id, rest_sec, rest_ends_at, rest_paused_ms FROM fitness_sessions WHERE id = ?`).get(w.sessionId)
    expect(row).toEqual({ rest_set_id: null, rest_sec: null, rest_ends_at: null, rest_paused_ms: null })
  })
})

describe('rest controls', () => {
  it('skip, pause, resume and ±time move the deadline, not a counter', async () => {
    const w = await live()
    await w.tick(w.ids[0]) // 3:00 rest, ends at +180s

    w.at(60)
    let rest = (await w.rest({ op: 'adjust', sec: 30 })).body.snapshot.active.rest
    expect(rest).toMatchObject({ sec: 210, endsAt: iso(210) })
    rest = (await w.rest({ op: 'adjust', sec: -15 })).body.snapshot.active.rest
    expect(rest).toMatchObject({ sec: 195, endsAt: iso(195) })

    w.at(95) // 100 s left
    rest = (await w.rest({ op: 'pause' })).body.snapshot.active.rest
    expect(rest).toEqual(expect.objectContaining({ pausedMs: 100_000 }))
    expect(rest.endsAt).toBeUndefined()
    w.at(400) // paused time doesn't count
    expect(left(rest, 400)).toBe(100_000)
    rest = (await w.rest({ op: 'adjust', sec: 15 })).body.snapshot.active.rest
    expect(rest).toMatchObject({ pausedMs: 115_000 })
    expect((await w.rest({ op: 'pause' })).body.snapshot.active.rest).toEqual(rest) // already paused

    rest = (await w.rest({ op: 'resume' })).body.snapshot.active.rest
    expect(rest).toMatchObject({ endsAt: iso(515) })
    expect(rest.pausedMs).toBeUndefined()

    expect((await w.rest({ op: 'skip' })).body.snapshot.active.rest).toBeUndefined()
    expect((await w.rest({ op: 'skip' })).status).toBe(200) // nothing to skip is fine
  })

  it('once rest has run out, taking time off does nothing and adding time counts from now', async () => {
    const w = await live()
    await w.tick(w.ids[2]) // lateral raise: 1:30
    w.at(120) // 30 s over
    const over = (await w.snap()).active!.rest!
    expect(restLeft(over, NOW.getTime() + 120_000)).toMatchObject({ leftMs: -30_000, over: true, progress: 1 })
    expect((await w.rest({ op: 'adjust', sec: -15 })).body.snapshot.active.rest).toEqual(over)
    expect((await w.rest({ op: 'pause' })).body.snapshot.active.rest).toEqual(over)
    expect((await w.rest({ op: 'adjust', sec: 15 })).body.snapshot.active.rest).toMatchObject({ endsAt: iso(135) })
  })

  it('taking all the time off a paused rest ends it instead of leaving it paused at 0:00', async () => {
    const w = await live()
    await w.tick(w.ids[2]) // 1:30
    w.at(60)
    await w.rest({ op: 'pause' }) // 30 s left
    const rest = (await w.rest({ op: 'adjust', sec: -45 })).body.snapshot.active.rest as RestState
    expect(rest).toMatchObject({ endsAt: iso(60) })
    expect(rest.pausedMs).toBeUndefined()
    expect(restLeft(rest, NOW.getTime() + 60_000)).toMatchObject({ over: true, paused: false })
  })

  it('validates input, and refuses a finished workout', async () => {
    const w = await live()
    await w.tick(w.ids[0])
    for (const body of [{}, { op: 'stop' }, { op: 'adjust' }, { op: 'adjust', sec: 0 }, { op: 'adjust', sec: 2.5 }, { op: 'adjust', sec: 5000 }, { op: 'skip', extra: 1 }]) {
      expect((await w.rest(body)).status).toBe(400)
    }
    expect((await w.snap()).active!.rest).toMatchObject({ endsAt: iso(180) })
    await w.h.call('POST', `/api/fitness/sessions/${w.sessionId}/finish`, {})
    expect((await w.rest({ op: 'skip' })).status).toBe(409)
    expect((await w.h.call('POST', '/api/fitness/sessions/s_missing/rest', { op: 'skip' })).status).toBe(404)
  })
})

describe('rest and the workout record', () => {
  it('rest never changes the logged sets, the prescription or the session version, and Finish clears it', async () => {
    const w = await live()
    await w.tick(w.ids[0], { weight: 185, reps: 6, rpe: 8, done: true })
    const record = (s: FitnessSnapshot) => ({ version: s.active!.version, entries: s.active!.entries })
    const before = record(await w.snap())
    for (const op of [{ op: 'adjust', sec: 30 }, { op: 'pause' }, { op: 'adjust', sec: -15 }, { op: 'resume' }, { op: 'skip' }]) {
      w.at(10)
      expect((await w.rest(op)).status).toBe(200)
    }
    await w.tick(w.ids[1], { weight: 185, reps: 5, done: true })
    expect((await w.snap()).active!.rest).toBeDefined()
    expect(record(await w.snap()).version).toBe(before.version)
    expect(record(await w.snap()).entries[0].sets[0]).toEqual(before.entries[0].sets[0])

    const finished = (await w.h.call('POST', `/api/fitness/sessions/${w.sessionId}/finish`, {})).body.snapshot as FitnessSnapshot
    expect(finished.active).toBeNull()
    expect(finished.sessions[0].entries.map((e) => e.sets.map((s) => [s.weight, s.reps, s.rpe, s.done]))).toEqual([
      [
        [185, 6, 8, true],
        [185, 5, undefined, true],
      ],
    ])
    expect(w.h.database.sqlite.prepare(`SELECT rest_set_id, rest_ends_at FROM fitness_sessions WHERE id = ?`).get(w.sessionId)).toEqual({ rest_set_id: null, rest_ends_at: null })
  })

  it('a running rest survives a restart and still ends at the same moment', async () => {
    const path = join(tempDir(), 'sahale.db')
    const w = await live(path)
    w.at(20)
    await w.tick(w.ids[0])
    w.h.database.sqlite.close()

    // Reopened 2½ minutes later — as if the phone had been locked and the runtime restarted.
    const db = await openDb(path)
    const snap = services(db).fitness.snapshot(clockAt(new Date(NOW.getTime() + 170_000)))
    expect(snap.active!.rest).toMatchObject({ setId: w.ids[0], endsAt: iso(200) })
    expect(left(snap.active!.rest, 170)).toBe(30_000)
    db.sqlite.close()
  })

  it('discarding the workout takes its rest with it', async () => {
    const w = await live()
    await w.tick(w.ids[0])
    await w.h.call('POST', `/api/fitness/sessions/${w.sessionId}/discard`)
    expect((await w.snap()).active).toBeNull()
    expect(w.h.database.sqlite.prepare(`SELECT count(*) AS n FROM fitness_sessions`).get()).toEqual({ n: 0 })
  })
})

describe('upgrading a v0.1.1 database', () => {
  it('adds the rest columns without touching existing rows, after a backup', async () => {
    const dir = tempDir()
    const migrations = join(dir, 'm')
    cpSync(MIGRATIONS, migrations, { recursive: true })
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8'))
    journal.entries = journal.entries.slice(0, 2)
    writeFileSync(join(migrations, 'meta', '_journal.json'), JSON.stringify(journal))
    const path = join(dir, 'sahale.db')
    const first = await openDatabase(path, { migrationsDir: migrations })
    // A workout in progress, written the way v0.1.1 writes it.
    const run = (sql: string) => first.sqlite!.prepare(sql).run()
    run(`INSERT INTO fitness_exercises (id, name, pattern, equipment, is_main, is_bodyweight, cues, origin, created_at, updated_at) VALUES ('bench-press', 'Bench Press', 'Press', 'Barbell', 1, 0, '["Pause the first rep"]', 'library', 'x', 'x')`)
    run(`INSERT INTO fitness_sessions (id, name, status, started_at, version, is_deload, origin, created_at, updated_at) VALUES ('s_live', 'Upper A', 'active', '${NOW.toISOString()}', 1, 0, 'owner', 'x', 'x')`)
    run(`INSERT INTO fitness_session_entries (id, session_id, position, exercise_id, target_sets, target_rep_min, target_rep_max) VALUES ('se1', 's_live', 0, 'bench-press', 2, 5, 8)`)
    run(`INSERT INTO fitness_session_sets (id, entry_id, position, weight, reps, done) VALUES ('ss1', 'se1', 0, 185, 6, 1), ('ss2', 'se1', 1, NULL, NULL, 0)`)
    const rows = (sql: string) => first.sqlite!.prepare(sql).all()
    const before = { sessions: rows(`SELECT * FROM fitness_sessions`), entries: rows(`SELECT * FROM fitness_session_entries`), sets: rows(`SELECT * FROM fitness_session_sets ORDER BY id`), exercises: rows(`SELECT * FROM fitness_exercises ORDER BY id`) }
    first.sqlite!.close()

    const opened = await openDatabase(path, { migrationsDir: MIGRATIONS, backupsDir: join(dir, 'backups') })
    // 0002 and every later migration, in order (the list grows; a hard-coded tail would break on the next one).
    expect(opened.status).toMatchObject({ state: 'ready', appliedNow: readMigrations(MIGRATIONS).slice(2).map((m) => m.tag) })
    expect(opened.status.appliedNow[0]).toBe('0002_rest_timer')
    expect(opened.status.backup).toMatch(/before-0002_rest_timer\.db$/)
    expect(existsSync(opened.status.backup!)).toBe(true)
    const after = (sql: string) => opened.sqlite!.prepare(sql).all() as Record<string, unknown>[]
    const strip = (r: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)))
    expect(after(`SELECT * FROM fitness_sessions`).map((r) => strip(r, ['rest_set_id', 'rest_sec', 'rest_ends_at', 'rest_paused_ms']))).toEqual(before.sessions)
    expect(after(`SELECT rest_set_id, rest_sec, rest_ends_at, rest_paused_ms FROM fitness_sessions`)).toEqual([{ rest_set_id: null, rest_sec: null, rest_ends_at: null, rest_paused_ms: null }])
    expect(after(`SELECT * FROM fitness_session_entries`)).toEqual(before.entries)
    expect(after(`SELECT * FROM fitness_session_sets ORDER BY id`)).toEqual(before.sets)
    expect(after(`SELECT * FROM fitness_exercises ORDER BY id`).map((r) => strip(r, ['rest_sec']))).toEqual(before.exercises)
    expect(after(`SELECT rest_sec FROM fitness_exercises`)).toEqual([{ rest_sec: null }])

    // The workout that was live during the upgrade carries on, without a rest running;
    // the next set completed starts one.
    const { fitness } = services(opened as Parameters<typeof services>[0])
    const clock = clockAt(new Date(NOW.getTime() + 600_000))
    expect(fitness.snapshot(clock).active).toMatchObject({ id: 's_live' })
    expect(fitness.snapshot(clock).active!.rest).toBeUndefined()
    fitness.patchSet('ss2', { weight: 185, reps: 5, done: true }, clock)
    expect(fitness.snapshot(clock).active!.rest).toBeUndefined() // the last set: nothing left to rest for
    fitness.addSet('se1', clock)
    fitness.patchSet(fitness.snapshot(clock).active!.entries[0].sets[1].id!, { done: false }, clock)
    fitness.patchSet('ss2', { done: true }, clock)
    expect(fitness.snapshot(clock).active!.rest).toMatchObject({ setId: 'ss2', sec: 180 })
    opened.sqlite!.close()
  })
})

describe('rest arithmetic', () => {
  it('defaults by kind of exercise', () => {
    expect(restSecFor({ main: true, pattern: 'Squat' })).toBe(180)
    expect(restSecFor({ main: false, pattern: 'Pull' })).toBe(120)
    expect(restSecFor({ main: false, pattern: 'Accessory' })).toBe(90)
    expect(restSecFor({ main: true, pattern: 'Squat', restSec: 0 })).toBe(0)
    expect(restSecFor(undefined)).toBe(90)
  })

  it('counts down to 0:00 exactly at the deadline, then counts the time over', () => {
    const rest: RestState = { setId: 's', entryId: 'e', exerciseId: 'x', sec: 90, endsAt: iso(90) }
    const at = (s: number) => restLeft(rest, NOW.getTime() + s * 1000)
    expect(fmtClock(restDisplaySec(at(0).leftMs))).toBe('1:30')
    expect(fmtClock(restDisplaySec(at(0.2).leftMs))).toBe('1:30')
    expect(fmtClock(restDisplaySec(at(1).leftMs))).toBe('1:29')
    expect(fmtClock(restDisplaySec(at(89.9).leftMs))).toBe('0:01')
    expect(at(90)).toMatchObject({ leftMs: 0, over: true, progress: 1 })
    expect(fmtClock(restDisplaySec(at(90).leftMs))).toBe('0:00')
    expect(fmtClock(restDisplaySec(at(754).leftMs))).toBe('11:04')
    expect(at(45).progress).toBeCloseTo(0.5)
    // A device clock running behind the runtime never shows more than the whole rest.
    expect(at(-20).leftMs).toBe(90_000)
  })
})

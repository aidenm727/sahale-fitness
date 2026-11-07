import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clockAt, harness, NOW, openDb, services, tempDir } from './helpers'

describe('Fitness state', () => {
  it('persists goals, blocks, workouts, logged sessions and notes across a restart', async () => {
    const path = join(tempDir(), 'sahale.db')
    const clock = clockAt()
    let sessionId: string
    {
      const db = await openDb(path)
      const { fitness } = services(db)
      fitness.putGoal({ statement: 'Squat 300 by December', date: '2026-12-15', targets: [{ exerciseId: 'back-squat', target: 300 }] }, clock)
      const b = fitness.createBlock({ name: 'Base', phase: 'Base', intent: '', scheme: '5×5', startDate: '2026-09-28', weeks: 4, deloadWeek: 4 }, clock)
      const w = fitness.createTemplate({ name: 'Lower', blockId: b, items: [{ exerciseId: 'back-squat', sets: 2, repMin: 5, repMax: 5, load: 225 }] }, clock)
      fitness.createPlan({ templateId: w, date: clock.today }, clock)
      sessionId = fitness.startSession({ templateId: w }, clock)
      const sets = fitness.snapshot(clock).active!.entries[0].sets
      fitness.patchSet(sets[0].id!, { weight: 230, reps: 5, done: true, rpe: 8 }, clock)
      fitness.patchSet(sets[1].id!, { weight: 230, reps: 5, done: true }, clock)
      fitness.finishSession(sessionId, { durationMin: 55 }, clock)
      fitness.addNote({ text: 'Left hip tight on deep squats', tag: 'body', pinned: true }, clock)
      db.sqlite.close()
    }
    const db = await openDb(path)
    const snap = services(db).fitness.snapshot(clock)
    expect(snap.goal?.statement).toBe('Squat 300 by December')
    expect(snap.goal?.targets).toEqual([{ exerciseId: 'back-squat', target: 300 }])
    expect(snap.blocks[0]).toMatchObject({ name: 'Base', status: 'current', weeks: 4 })
    expect(snap.templates).toHaveLength(1)
    expect(snap.templates[0]).toMatchObject({ name: 'Lower', lastSessionId: sessionId })
    expect(snap.active).toBeNull()
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0]).toMatchObject({ name: 'Lower', durationMin: 55, origin: 'owner', status: 'completed', block: 1, week: 2 })
    expect(snap.sessions[0].entries[0].sets.map((x) => [x.weight, x.reps, x.rpe])).toEqual([
      [230, 5, 8],
      [230, 5, undefined],
    ])
    // Starting the template fulfilled today's plan.
    expect(snap.plans[0]).toMatchObject({ status: 'done', sessionId })
    expect(snap.notes[0]).toMatchObject({ text: 'Left hip tight on deep squats', pinned: true, origin: 'owner' })
    db.sqlite.close()
  })

  it('keeps a live session across a restart and only logs the sets marked done', async () => {
    const path = join(tempDir(), 'sahale.db')
    const clock = clockAt()
    let sessionId: string
    {
      const db = await openDb(path)
      const { fitness } = services(db)
      const w = fitness.createTemplate(
        {
          name: 'Upper',
          items: [
            { exerciseId: 'bench-press', sets: 3, repMin: 5, repMax: 5, load: 185 },
            { exerciseId: 'pull-up', sets: 2, repMin: 6, repMax: 6 },
          ],
        },
        clock,
      )
      sessionId = fitness.startSession({ templateId: w }, clock)
      fitness.patchSet(fitness.snapshot(clock).active!.entries[0].sets[0].id!, { weight: 185, reps: 5, done: true }, clock)
      db.sqlite.close()
    }
    const db = await openDb(path)
    const { fitness } = services(db)
    const active = fitness.snapshot(clock).active!
    expect(active.id).toBe(sessionId)
    expect(active.entries[0].sets.filter((s) => s.done)).toHaveLength(1)
    fitness.finishSession(sessionId, {}, clockAt(new Date(NOW.getTime() + 47 * 60_000)))
    const done = fitness.snapshot(clock).sessions[0]
    expect(done.entries).toHaveLength(1) // pull-ups had nothing done
    expect(done.entries[0].sets).toHaveLength(1)
    expect(done.durationMin).toBe(47)
    db.sqlite.close()
  })

  it('distinguishes demo rows from owner rows and clears only demo', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    fitness.addNote({ text: 'mine', pinned: true }, clock)
    fitness.loadDemo(clock)
    const loaded = fitness.snapshot(clock)
    expect(loaded.counts.demo).toBeGreaterThan(50)
    expect(loaded.counts.owner).toBe(1)
    expect(loaded.plans.find((p) => p.id === loaded.todayPlanId)?.name).toBe('Lower · Squat')
    expect(loaded.templates.find((w) => w.id === loaded.nextTemplateId)?.name).toBe('Lower · Squat')
    expect(() => fitness.loadDemo(clock)).toThrow(/already loaded/)

    // Owner logs against a demo plan: the session is theirs and survives clearing demo.
    const s = fitness.startSession({ planId: loaded.todayPlanId }, clock)
    fitness.patchSet(fitness.snapshot(clock).active!.entries[0].sets[0].id!, { weight: 265, reps: 5, done: true }, clock)
    fitness.finishSession(s, { durationMin: 60 }, clock)
    fitness.clearDemo()
    const cleared = fitness.snapshot(clock)
    expect(cleared.counts.demo).toBe(0)
    expect(cleared.notes.map((n) => n.text)).toEqual(['mine'])
    expect(cleared.sessions.map((x) => x.id)).toEqual([s])
    expect(cleared.sessions[0].planId).toBeUndefined()
    expect(cleared.sessions[0].templateId).toBeUndefined()
    expect(cleared.sessions[0].entries[0].target).toMatchObject({ exerciseId: 'back-squat', repMin: 4, repMax: 6 }) // the snapshot stays
    expect(cleared.templates).toEqual([])
    expect(cleared.exercises.length).toBeGreaterThan(20) // the library stays
  })

  it('rejects edits made against an old version of a workout', async () => {
    const db = await openDb()
    const { fitness } = services(db)
    const clock = clockAt()
    const w = fitness.createTemplate({ name: 'A', items: [] }, clock)
    fitness.updateTemplate(w, { version: 1, name: 'B' }, clock)
    expect(() => fitness.updateTemplate(w, { version: 1, name: 'C' }, clock)).toThrow(/changed since/)
    expect(fitness.snapshot(clock).templates[0]).toMatchObject({ name: 'B', version: 2 })
  })
})

describe('Fitness API validation', () => {
  it('rejects malformed input with 400 and changes nothing', async () => {
    const h = await harness()
    const before = await h.call('GET', '/api/fitness')
    const cases: [string, string, unknown][] = [
      ['POST', '/api/fitness/plans', { templateId: 'wt_x', date: '2026-02-30' }],
      ['POST', '/api/fitness/templates', { name: 'x', items: [{ exerciseId: 'back-squat', sets: 0, repMin: 5, repMax: 5 }] }],
      ['POST', '/api/fitness/templates', { name: 'x', items: [{ exerciseId: 'not-a-lift', sets: 3, repMin: 5, repMax: 8 }] }],
      ['POST', '/api/fitness/templates', { name: 'x', items: [{ exerciseId: 'back-squat', sets: 3, repMin: 8, repMax: 5 }] }],
      ['POST', '/api/fitness/templates', { name: 'x', items: [{ exerciseId: 'back-squat', sets: 3, reps: 5 }] }],
      ['POST', '/api/fitness/templates', { name: 'x', items: [{ exerciseId: 'back-squat', sets: 3, repMin: 5, repMax: 8, rpe: 8.3 }] }],
      ['PUT', '/api/fitness/goal', { statement: '', targets: [] }],
      ['POST', '/api/fitness/blocks', { name: 'B', startDate: '2026-10-01', weeks: 4, deloadWeek: 6 }],
      ['POST', '/api/fitness/notes', { text: '   ' }],
    ]
    for (const [method, url, body] of cases) {
      const r = await h.call(method as 'POST', url, body)
      expect(r.status, `${method} ${url}`).toBe(400)
      expect(r.body.code).toBe('invalid_input')
    }
    const after = await h.call('GET', '/api/fitness')
    expect({ ...after.body, generatedAt: 0 }).toEqual({ ...before.body, generatedAt: 0 })
  })

  it('answers 503 with a reason when the database could not be migrated', async () => {
    const { buildApp } = await import('../server/app')
    const { loadConfig } = await import('../server/config')
    const { app } = await buildApp({
      config: { ...loadConfig({ SAHALE_DATA_DIR: tempDir() }), serveStatic: false },
      database: { sqlite: null, db: null, status: { state: 'migration_failed', path: 'x', applied: [], available: [], appliedNow: [], error: 'boom' } },
    })
    const r = await app.inject({ method: 'GET', url: '/api/fitness', headers: { host: 'localhost:4310' } })
    expect(r.statusCode).toBe(503)
    expect(JSON.parse(r.body)).toMatchObject({ code: 'migration_failed' })
    const health = await app.inject({ method: 'GET', url: '/api/runtime/health', headers: { host: 'localhost:4310' } })
    expect(JSON.parse(health.body)).toEqual({ ok: true, db: 'migration_failed' })
  })

  it('only serves loopback hosts and the Sahale UI', async () => {
    const h = await harness()
    expect((await h.app.inject({ method: 'GET', url: '/api/fitness', headers: { host: 'evil.example' } })).statusCode).toBe(403)
    expect((await h.app.inject({ method: 'POST', url: '/api/fitness/notes', headers: { host: 'localhost:4310', 'content-type': 'application/json' }, payload: '{"text":"x"}' })).statusCode).toBe(403)
    expect(
      (await h.app.inject({ method: 'POST', url: '/api/fitness/notes', headers: { host: 'localhost:4310', origin: 'https://evil.example', 'x-sahale-client': '1', 'content-type': 'application/json' }, payload: '{"text":"x"}' }))
        .statusCode,
    ).toBe(403)
  })
})

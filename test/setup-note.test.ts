import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { optionalTextForSave, SETUP_NOTE_SHORT, setupNoteView } from '../src/domains/fitness/setupNote'
import { harness, openDb, services, tempDir } from './helpers'

describe('setup note in the logger', () => {
  it('shows the exercise note when present', () => {
    expect(setupNoteView('Medium / -1 / seat 4', false)).toEqual({ text: 'Medium / -1 / seat 4', collapsible: false, clamped: false })
  })

  it('shows nothing when the note is empty, blank or missing', () => {
    expect(setupNoteView('', false)).toBeNull()
    expect(setupNoteView('  \n ', false)).toBeNull()
    expect(setupNoteView(undefined, false)).toBeNull()
    expect(setupNoteView(null, false)).toBeNull()
  })

  it('collapses a long note until tapped, then expands it', () => {
    const long = 'x'.repeat(SETUP_NOTE_SHORT + 1)
    expect(setupNoteView(long, false)).toEqual({ text: long, collapsible: true, clamped: true })
    expect(setupNoteView(long, true)).toEqual({ text: long, collapsible: true, clamped: false })
  })

  it('treats a note of more than two lines as long', () => {
    expect(setupNoteView('a\nb\nc', false)?.collapsible).toBe(true)
    expect(setupNoteView('a\nb', false)?.collapsible).toBe(false)
  })
})

describe('saving the note and short name from the exercise editor', () => {
  it('sends an emptied note or short name on an edit so the server clears it', () => {
    expect(optionalTextForSave('', true)).toBe('')
    expect(optionalTextForSave('Seat 4', true)).toBe('Seat 4')
  })

  it('leaves an empty note or short name out of a new exercise', () => {
    expect(optionalTextForSave('', false)).toBeUndefined()
    expect(optionalTextForSave('Seat 4', false)).toBe('Seat 4')
  })
})

describe('exercise note is editable, built-ins included', () => {
  it('saves a note on a built-in exercise, shows it in the snapshot, keeps it across a restart, and clears with an empty string', async () => {
    const path = join(tempDir(), 'sahale.db')
    const h = await harness({ dbPath: path })
    const noteOf = (snap: { exercises: Array<{ id: string; note?: string }> }) => snap.exercises.find((e) => e.id === 'bench-press')?.note

    const saved = await h.call('PATCH', '/api/fitness/exercises/bench-press', { note: 'Medium / -1 / seat 4' })
    expect(saved.status).toBe(200)
    expect(noteOf(saved.body.snapshot)).toBe('Medium / -1 / seat 4')
    expect((await h.call('PATCH', '/api/fitness/exercises/bench-press', { note: 'x'.repeat(501) })).status).toBe(400)

    // Library seeding at startup never overwrites an owner edit.
    h.database.sqlite.close()
    const db = await openDb(path)
    const fitness = services(db).fitness
    fitness.ensureLibrary()
    expect(noteOf(fitness.snapshot(h.clock))).toBe('Medium / -1 / seat 4')
    db.sqlite.close()

    const h2 = await harness({ dbPath: path })
    const cleared = await h2.call('PATCH', '/api/fitness/exercises/bench-press', { note: '' })
    expect(noteOf(cleared.body.snapshot)).toBeUndefined()
  })
})

describe('short name is editable and clearable', () => {
  it('sets a short name on a built-in exercise and clears it with an empty string', async () => {
    const h = await harness()
    const shortOf = (snap: { exercises: Array<{ id: string; short?: string }> }) => snap.exercises.find((e) => e.id === 'bench-press')?.short

    const set = await h.call('PATCH', '/api/fitness/exercises/bench-press', { short: 'Bench' })
    expect(shortOf(set.body.snapshot)).toBe('Bench')
    expect((await h.call('PATCH', '/api/fitness/exercises/bench-press', { short: 'x'.repeat(25) })).status).toBe(400)
    // Omitting the field leaves it alone; sending "" clears it.
    expect(shortOf((await h.call('PATCH', '/api/fitness/exercises/bench-press', { note: 'n' })).body.snapshot)).toBe('Bench')
    expect(shortOf((await h.call('PATCH', '/api/fitness/exercises/bench-press', { short: '' })).body.snapshot)).toBeUndefined()
  })
})

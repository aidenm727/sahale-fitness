/**
 * The rest timer. The runtime starts a rest when a working set is ticked done
 * and keeps it on the live session as a deadline; this file only renders it.
 * Time left is always `deadline - now`, recomputed on every frame we draw and
 * the moment the page becomes visible again, so a locked phone or a reopened
 * Home Screen app shows the right number at once. Nothing here counts ticks.
 */
import { useEffect, useState } from 'react'
import { Pause, Play, SkipForward, Timer } from 'lucide-react'
import { fmtClock, REST_CHOICES, restDisplaySec, restLeft, restSecFor } from '@shared/fitness/derive'
import type { Exercise, RestState, SessionLog } from '@shared/fitness/types'
import { act, type FitnessView } from '@/state/fitness'

/** `Date.now()`, refreshed a few times a second, and immediately when the page is shown again. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const t = setInterval(update, 250)
    const onVisible = () => document.visibilityState === 'visible' && update()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', update)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', update)
    }
  }, [])
  return now
}

function control(sessionId: string, body: object) {
  act('POST', `/api/fitness/sessions/${sessionId}/rest`, body)
}

/**
 * A nudge when the rest runs out while the app is on screen: a vibration where
 * the browser supports it (Android; not iOS Safari). Nothing can fire while
 * the phone is locked or the app is closed (README, "Rest timer"), and a page
 * that wakes up after the deadline doesn't buzz late.
 */
export function useRestCue(rest: RestState | undefined) {
  const endsAt = rest?.endsAt
  useEffect(() => {
    if (!endsAt) return
    const ms = Date.parse(endsAt) - Date.now()
    if (ms <= 0) return
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible' && Date.now() - Date.parse(endsAt) < 2000) navigator.vibrate?.([180, 90, 180])
    }, ms)
    return () => clearTimeout(t)
  }, [endsAt])
}

/**
 * The live rest, with its controls. `place` decides the layout: a row in the
 * sticky bar above the logger on wide screens, or a dock under the thumb on
 * phones. CSS shows exactly one of them.
 */
export function RestPanel({ session, f, place }: { session: SessionLog; f: FitnessView; place: 'bar' | 'dock' }) {
  const rest = session.rest!
  const now = useNow()
  const { leftMs, paused, over, progress } = restLeft(rest, now)
  const entry = session.entries.find((e) => e.id === rest.entryId)
  const setNo = entry ? entry.sets.findIndex((s) => s.id === rest.setId) + 1 : 0
  const name = f.ex[rest.exerciseId]?.short ?? f.name(rest.exerciseId)
  const time = `${over ? '+' : ''}${fmtClock(restDisplaySec(leftMs))}`
  const id = session.id
  return (
    <div className={`rest rest-${place}${over ? ' over' : ''}${paused ? ' paused' : ''}`} role="timer" aria-label={over ? `Rest done, ${time} over` : `Rest, ${fmtClock(restDisplaySec(leftMs))} left${paused ? ', paused' : ''}`}>
      <div className="rest-meter" aria-hidden>
        <span style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
      </div>
      <div className="rest-read">
        <span className="rest-label">
          <Timer aria-hidden /> {over ? 'Rest done' : paused ? 'Paused' : 'Rest'}
          <span className="rest-after">
            {' '}
            · {name}
            {setNo ? ` set ${setNo}` : ''}
          </span>
        </span>
        <span className="rest-time mono" aria-hidden>
          {time}
        </span>
      </div>
      <div className="rest-ctl">
        <button className="btn rest-adj" disabled={over} onClick={() => control(id, { op: 'adjust', sec: -15 })} aria-label="15 seconds less">
          −15
        </button>
        <button className="btn rest-adj" onClick={() => control(id, { op: 'adjust', sec: 15 })} aria-label="15 seconds more">
          +15
        </button>
        {!over && (
          <button className="btn rest-pause" onClick={() => control(id, { op: paused ? 'resume' : 'pause' })} aria-label={paused ? 'Resume rest' : 'Pause rest'}>
            {paused ? <Play /> : <Pause />}
          </button>
        )}
        <button className={`btn rest-skip${over ? ' btn-primary' : ''}`} onClick={() => control(id, { op: 'skip' })}>
          {over ? 'Done' : 'Skip'} <SkipForward />
        </button>
      </div>
    </div>
  )
}

/**
 * How long to rest after each set of an exercise — its own setting, used in
 * every workout. A native select so a phone gets its own picker.
 */
export function RestChoice({ ex }: { ex: Exercise | undefined }) {
  if (!ex) return null
  const current = restSecFor(ex)
  const auto = restSecFor({ ...ex, restSec: undefined })
  const choices = [...new Set([...REST_CHOICES, current])].filter((s) => s > 0).sort((a, b) => a - b)
  return (
    <label className={`rest-choice${current ? '' : ' off'}`} title={`Rest after each ${ex.name} set, in every workout`}>
      <Timer aria-hidden />
      <span className="mono">{current ? fmtClock(current) : 'No rest timer'}</span>
      <select
        value={ex.restSec === undefined ? '' : String(ex.restSec)}
        onChange={(e) => act('PATCH', `/api/fitness/exercises/${ex.id}`, { restSec: e.target.value === '' ? null : Number(e.target.value) })}
        aria-label={`Rest after each ${ex.name} set`}
      >
        <option value="">Default ({fmtClock(auto)})</option>
        {choices.map((s) => (
          <option key={s} value={s}>
            {fmtClock(s)}
          </option>
        ))}
        <option value="0">No rest timer</option>
      </select>
    </label>
  )
}

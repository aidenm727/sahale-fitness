import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { e1rmSeries, fmtSets, lastEntryFor } from '@shared/fitness/derive'
import { PATTERNS } from '@shared/fitness/types'
import { fmt } from '@/lib/time'
import { useFitnessView } from '@/state/fitness'
import { Sparkline } from '@/ui/charts'
import { Page, PageHeader, Section, SubNav } from '@/ui/Page'
import { ExerciseEditor } from './editors'
import { CustomTag, FitnessUnavailable } from './parts'

export function ExercisesPage() {
  const f = useFitnessView()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const rows = useMemo(
    () =>
      (f?.snap.exercises ?? []).map((e) => ({
        e,
        series: e1rmSeries(f!.sessions, e.id),
        last: lastEntryFor(f!.sessions, e.id),
      })),
    [f],
  )
  if (!f) return <FitnessUnavailable />

  return (
    <Page>
      <PageHeader
        eyebrow="Fitness · Exercises"
        title="Exercises"
        lede={<>Every movement here, built in and your own, with your history and cues. Missing one? Create it; it works everywhere a built-in exercise does.</>}
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            <Plus /> New exercise
          </button>
        }
      />
      <SubNav />

      {PATTERNS.map((p) => {
        const group = rows.filter((r) => r.e.pattern === p)
        if (!group.length) return null
        return (
          <Section key={p} title={p} meta={`${group.length} movement${group.length > 1 ? 's' : ''}`}>
            <div className="rows ex-rows">
              {group.map(({ e, series, last }) => {
                // Estimated 1RM only means something for barbell strength work.
                const trend = !e.bodyweight && e.equipment.startsWith('Barbell') && series.length > 0
                return (
                  <Link key={e.id} to={`/exercises/${e.id}`}>
                    <span className="strong">
                      {e.name}
                      {e.main && <span className="main-mark">main</span>} <CustomTag ex={e} />
                    </span>
                    <span className="muted">{e.equipment}</span>
                    <span className="mono">{last ? fmtSets(last.entry.sets) : '—'}</span>
                    <span className="muted">{last ? fmt.rel(last.session.date) : ''}</span>
                    <span className="mono ex-e1rm">{trend ? series[series.length - 1].value : ''}</span>
                    <span>{trend && series.length > 2 && <Sparkline values={series.map((s) => s.value)} width={88} height={22} />}</span>
                  </Link>
                )
              })}
            </div>
          </Section>
        )
      })}
      {creating && <ExerciseEditor onClose={() => setCreating(false)} onCreated={(id) => navigate(`/exercises/${id}`)} />}
    </Page>
  )
}

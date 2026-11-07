import { Menu, Play } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { workoutAction } from '@/sahale/actions'
import type { Crumb } from '@/sahale/tree'
import { useHere } from '@/sahale/useHere'
import { useFitness } from '@/state/fitness'
import { useUi } from '@/state/ui'
import { Mark } from './Mark'

export function TopBar() {
  const here = useHere()
  const navigate = useNavigate()
  const navOpen = useUi((s) => s.navOpen)
  const setNav = useUi((s) => s.setNav)
  // Re-render when Fitness state changes, since the action depends on it.
  useFitness((s) => s.snapshot?.generatedAt)
  const action = workoutAction()

  return (
    <header className="topbar">
      <button className="nav-toggle" onClick={() => setNav(!navOpen)} aria-label="Navigation" aria-controls="sahale-rail" aria-expanded={navOpen}>
        <Menu />
      </button>
      <PathBar trail={here.trail} />
      <div className="topbar-spacer" />
      {action && (
        <div className="topbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => action.run(navigate)} title={action.label}>
            <Play />
            <span className="tb-label">{action.label}</span>
          </button>
        </div>
      )}
    </header>
  )
}

function PathBar({ trail }: { trail: Crumb[] }) {
  return (
    <nav className="pathbar" aria-label="Location">
      {trail.map((c, i) => {
        const last = i === trail.length - 1
        return (
          <span key={c.href + i} className="crumb-wrap">
            <Link to={c.href} className={`crumb${last ? ' here' : ''}`} aria-current={last ? 'page' : undefined}>
              {i === 0 ? (
                <>
                  <Mark size={16} />
                  <span className="crumb-home-text">{c.title}</span>
                </>
              ) : (
                c.title
              )}
            </Link>
            {!last && <span className="crumb-sep">/</span>}
          </span>
        )
      })}
    </nav>
  )
}

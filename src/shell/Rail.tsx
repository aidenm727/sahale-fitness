import { Link, NavLink } from 'react-router'
import { childrenOf, nodeById, type NavNode } from '@/sahale/tree'
import { useHere } from '@/sahale/useHere'
import { useFitness } from '@/state/fitness'
import { useRuntime } from '@/state/runtime'
import { Mark } from './Mark'

export function Rail() {
  const here = useHere()
  const live = useFitness((s) => !!s.snapshot?.active)
  const inTrail = new Set(here.trail.slice(1).map((c) => c.node.id))

  return (
    <aside className="rail" id="sahale-rail">
      <Link to="/" className="rail-brand" aria-label="Sahale Fitness overview">
        <Mark size={24} />
        <div>
          <div className="rail-name">Sahale Fitness</div>
          <div className="rail-sub">workout logger</div>
        </div>
      </Link>

      <nav className="rail-nav" aria-label="Fitness">
        <RailRow node={{ ...nodeById.overview, title: 'Overview' }} active={here.node.id === 'overview' && !here.unmatched} />
        {childrenOf('overview').map((n) => (
          <RailRow key={n.id} node={n} active={here.node.id === n.id} inPath={inTrail.has(n.id)} badge={n.id === 'today' && live ? 'live' : undefined} />
        ))}
      </nav>

      <div className="rail-foot">
        <RuntimeChip />
      </div>
    </aside>
  )
}

function RailRow({ node, active, inPath, badge }: { node: NavNode; active: boolean; inPath?: boolean; badge?: string }) {
  const Icon = node.icon
  return (
    <NavLink to={node.path} end className={`rail-row depth-1${active ? ' is-here' : ''}${inPath ? ' in-path' : ''}`} aria-current={active ? 'page' : undefined}>
      {Icon && <Icon className="rail-icon" />}
      <span className="rail-title">{node.title}</span>
      {badge && <span className="rail-badge live">{badge}</span>}
    </NavLink>
  )
}

/** Where the runtime stands, one glance: reachable? database? */
function RuntimeChip() {
  const { reachable, db } = useRuntime()
  const down = reachable === false || (!!db && db !== 'ready')
  const text = reachable === false ? 'Runtime offline' : db && db !== 'ready' ? `Database: ${db.replace('_', ' ')}` : db ? 'Runtime ready' : 'Checking…'
  return (
    <Link to="/runtime" className={`runtime-chip rc-${down ? 'down' : 'live'}`} title="Runtime status">
      <span className="rail-flag-dot" />
      <span>{text}</span>
    </Link>
  )
}

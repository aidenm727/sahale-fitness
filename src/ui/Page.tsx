import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { childrenOf } from '@/sahale/tree'

export function Page({ children, wide, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  return <div className={`page${wide ? ' page-wide' : ''}${className ? ` ${className}` : ''}`}>{children}</div>
}

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="ph">
      {eyebrow && (
        <div className="ph-eyebrow">
          <span className="dot" />
          <span className="label">{eyebrow}</span>
        </div>
      )}
      <h1 className="ph-title">{title}</h1>
      {lede && <p className="ph-lede">{lede}</p>}
      {actions && <div className="ph-actions">{actions}</div>}
    </header>
  )
}

export function Section({
  title,
  meta,
  actions,
  children,
  quiet,
  className = '',
  id,
}: {
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  quiet?: boolean
  className?: string
  id?: string
}) {
  return (
    <section className={`sec${quiet ? ' sec-quiet' : ''} ${className}`} id={id}>
      {(title || meta || actions) && (
        <div className="sec-head">
          {title && <h2 className="sec-title">{title}</h2>}
          {meta && <span className="sec-meta">{meta}</span>}
          {actions && <div className="sec-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/** The app's views, derived from the map. */
export function SubNav() {
  return (
    <nav className="subnav" aria-label="Fitness views">
      <NavLink to="/" end>
        Overview
      </NavLink>
      {childrenOf('overview').map((k) => (
        <NavLink key={k.id} to={k.path}>
          {k.title}
        </NavLink>
      ))}
    </nav>
  )
}

export function Stat({ label, value, unit, delta, tone }: { label: ReactNode; value: ReactNode; unit?: string; delta?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {delta && <span className={`stat-delta${tone ? ` ${tone}` : ''}`}>{delta}</span>}
    </div>
  )
}

import { useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useHere } from '@/sahale/useHere'
import { useFitness } from '@/state/fitness'
import { useRuntime } from '@/state/runtime'
import { useUi } from '@/state/ui'
import { Rail } from './Rail'
import { TopBar } from './TopBar'

const APP_NAME = 'Sahale Fitness'

export function Shell() {
  const here = useHere()
  const location = useLocation()
  const navOpen = useUi((s) => s.navOpen)
  const contentRef = useRef<HTMLDivElement>(null)

  // Fitness state and runtime status come from the runtime.
  useEffect(() => {
    void useFitness.getState().load()
    void useRuntime.getState().refresh()
    const tick = setInterval(() => void useRuntime.getState().refresh(), 20_000)
    const onFocus = () => {
      void useFitness.getState().load()
      void useRuntime.getState().refresh()
    }
    // A Home Screen app coming back from the background doesn't always get a focus event.
    const onVisible = () => document.visibilityState === 'visible' && onFocus()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useUi.getState().navOpen) useUi.getState().setNav(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const leaf = here.trail[here.trail.length - 1]
    document.title = here.unmatched ? `Off the map — ${APP_NAME}` : here.node.id === 'overview' ? APP_NAME : `${leaf.title} — ${APP_NAME}`
  }, [here])

  // Scroll to top on navigation, or to an anchor when the URL has one. The drawer closes.
  useEffect(() => {
    useUi.getState().setNav(false)
    const el = contentRef.current
    if (!el) return
    if (location.hash) {
      requestAnimationFrame(() => {
        const target = document.getElementById(location.hash.slice(1))
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        target?.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true })
      })
    } else {
      el.scrollTop = 0
    }
  }, [location.pathname, location.hash])

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <Rail />
      {navOpen && <div className="nav-scrim" onClick={() => useUi.getState().setNav(false)} aria-hidden />}
      <main className="main">
        <TopBar />
        <div className="content" ref={contentRef}>
          <Outlet key={location.pathname} />
        </div>
      </main>
      <WriteErrorToast />
    </div>
  )
}

/** A write that failed is never silent: say so, and that nothing changed. */
function WriteErrorToast() {
  const err = useFitness((s) => s.writeError)
  const clear = useFitness.getState().clearWriteError
  useEffect(() => {
    if (!err) return
    const t = setTimeout(clear, 9000)
    return () => clearTimeout(t)
  }, [err, clear])
  if (!err) return null
  return (
    <div className="toast toast-bad" role="alert">
      <b>{err.kind === 'unreachable' ? 'Not saved — runtime unreachable' : err.kind === 'database' ? 'Not saved — database problem' : 'Not saved'}</b>
      <span>{err.message}</span>
      <button className="btn btn-ghost btn-sm" onClick={clear}>
        Dismiss
      </button>
    </div>
  )
}

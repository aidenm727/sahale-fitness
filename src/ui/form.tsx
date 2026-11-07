/**
 * Dialogs and labelled fields shared by every editor. A dialog closes only when
 * its owner says so, so a failed save stays on screen.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  // Close on a press that starts and ends on the backdrop: not a drag out of a field, not a touch scroll.
  const pressedBackdrop = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog closes (a nested "create exercise" sits over the workout editor).
      if (e.key !== 'Escape') return
      const all = document.querySelectorAll('.modal')
      if (all[all.length - 1] === ref.current) onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Portalled to <body>: a dialog opened from inside another (e.g. "Create exercise" in the
  // workout editor) must not be positioned inside the outer dialog's transformed box.
  return createPortal(
    <div
      className="modal-overlay"
      onPointerDown={(e) => (pressedBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => pressedBackdrop.current && e.target === e.currentTarget && onClose()}
    >
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{footer}</footer>
      </div>
    </div>,
    document.body,
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

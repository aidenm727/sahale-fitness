/** The Sahale mark: a ridgeline over a contour. */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M2.5 17.5 L9 7.5 L12.4 12.6 L15 9.2 L21.5 17.5" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M6 20.5 H18" stroke="currentColor" strokeOpacity=".4" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Small, hand-built SVG charts. Thin marks, recessive axes, one hue per chart
 * (the current domain), a hover layer on everything, and a table twin for
 * screen readers.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import { dayKey, fmt } from '@/lib/time'

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)))
    ro.observe(el)
    setW(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceTicks(min: number, max: number, count = 3): number[] {
  const span = max - min || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? mag * 10
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100)
  return out
}

/* ------------------------------------------------------------------ */
/* Trend: one series over time, crosshair + tooltip                    */
/* ------------------------------------------------------------------ */

export interface TrendDatum {
  date: string
  value: number
  label?: string
}

export function TrendChart({
  data,
  height = 160,
  target,
  bands = [],
  compact,
  area = true,
  format = (v) => String(v),
  unit = '',
  title,
  domain,
  ariaLabel,
}: {
  data: TrendDatum[]
  height?: number
  target?: { value: number; label: string }
  bands?: { from: string; to: string; label?: string }[]
  compact?: boolean
  area?: boolean
  format?: (v: number) => string
  unit?: string
  title?: string
  domain?: [number, number]
  ariaLabel: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = compact ? { l: 0, r: 6, t: 8, b: 6 } : { l: 36, r: 12, t: 12, b: 22 }

  const geo = useMemo(() => {
    if (!data.length || !width) return null
    const xs = data.map((d) => new Date(d.date).getTime())
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const vals = data.map((d) => d.value).concat(target ? [target.value] : [])
    let lo = domain?.[0] ?? Math.min(...vals)
    let hi = domain?.[1] ?? Math.max(...vals)
    const padY = (hi - lo) * 0.12 || 1
    if (!domain) {
      lo -= padY
      hi += padY
    }
    const iw = width - pad.l - pad.r
    const ih = height - pad.t - pad.b
    const x = (t: number) => pad.l + ((t - x0) / (x1 - x0 || 1)) * iw
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * ih
    const pts = data.map((d, i) => ({ x: x(xs[i]), y: y(d.value), d }))
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')
    const areaPath = `${line}L${pts[pts.length - 1].x.toFixed(1)},${pad.t + ih}L${pts[0].x.toFixed(1)},${pad.t + ih}Z`
    const yTicks = compact ? [] : niceTicks(lo, hi, 3)
    const xTickCount = compact ? 0 : Math.max(2, Math.min(5, Math.floor(iw / 110)))
    const xTicks = Array.from({ length: xTickCount }, (_, i) => x0 + ((x1 - x0) * i) / (xTickCount - 1))
    return { x, y, pts, line, areaPath, yTicks, xTicks, ih, iw }
  }, [data, width, height, target, domain, compact, pad.l, pad.r, pad.t, pad.b])

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!geo) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0
    for (let i = 1; i < geo.pts.length; i++) if (Math.abs(geo.pts[i].x - px) < Math.abs(geo.pts[best].x - px)) best = i
    setHover(best)
  }

  const last = geo?.pts[geo.pts.length - 1]
  const h = hover !== null && geo ? geo.pts[hover] : null

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {geo && (
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={ariaLabel}>
          {bands.map((b, i) => {
            const bx0 = geo.x(new Date(b.from).getTime())
            const bx1 = geo.x(new Date(b.to).getTime())
            const cx0 = Math.max(pad.l, bx0)
            const cx1 = Math.min(width - pad.r, bx1)
            if (cx1 <= cx0) return null
            return (
              <g key={i}>
                <rect className="band" x={cx0} y={pad.t} width={cx1 - cx0} height={geo.ih} />
                {b.label && cx1 - cx0 > 60 && (
                  <text className="band-label" x={cx0 + 6} y={pad.t + geo.ih - 7}>
                    {b.label}
                  </text>
                )}
              </g>
            )
          })}
          {!compact && (
            <g className="grid axis">
              {geo.yTicks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={geo.y(t)} y2={geo.y(t)} />
                  <text x={pad.l - 8} y={geo.y(t) + 3} textAnchor="end">
                    {format(t)}
                  </text>
                </g>
              ))}
              {geo.xTicks.map((t, i) => (
                <text key={i} x={geo.x(t)} y={height - 5} textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}>
                  {fmt.monthDay(new Date(t))}
                </text>
              ))}
            </g>
          )}
          {target && (
            <g>
              <line className="target" x1={pad.l} x2={width - pad.r} y1={geo.y(target.value)} y2={geo.y(target.value)} />
              <text className="target-label" x={width - pad.r} y={geo.y(target.value) - 5} textAnchor="end">
                {target.label}
              </text>
            </g>
          )}
          {area && <path className="area" d={geo.areaPath} />}
          <path className="series" d={geo.line} />
          {h && <line className="crosshair" x1={h.x} x2={h.x} y1={pad.t} y2={pad.t + geo.ih} />}
          {last && !h && <circle className="end-dot" cx={last.x} cy={last.y} r={4} />}
          {h && <circle className="hover-dot" cx={h.x} cy={h.y} r={4} />}
        </svg>
      )}
      {h && (
        <div className="tooltip" style={{ left: h.x, top: h.y }}>
          <b>
            {format(h.d.value)}
            {unit}
          </b>
          <span className="key" />
          {title ? `${title} · ` : ''}
          {fmt.monthDay(h.d.date)}
          {h.d.label ? ` · ${h.d.label}` : ''}
        </div>
      )}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{fmt.date(d.date)}</td>
              <td>
                {format(d.value)}
                {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                           */
/* ------------------------------------------------------------------ */

export function Sparkline({ values, width = 96, height = 28, color }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pts = values.map((v, i) => [2 + (i / (values.length - 1)) * (width - 6), 3 + (1 - (v - lo) / (hi - lo || 1)) * (height - 6)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
  const last = pts[pts.length - 1]
  return (
    <svg width={width} height={height} className="chart" style={color ? ({ '--series': color } as CSSProperties) : undefined} aria-hidden>
      <path className="series" d={d} style={{ strokeWidth: 1.5 }} />
      <circle className="end-dot" cx={last[0]} cy={last[1]} r={3} />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Calendar heatmap (sequential, one hue)                              */
/* ------------------------------------------------------------------ */

export interface HeatDatum {
  date: string
  value: number
  tip?: ReactNode
}

export function Heatmap({
  weeks,
  data,
  levels = [0, 1, 2, 3],
  ariaLabel,
  legend,
}: {
  weeks: number
  data: Map<string, HeatDatum>
  levels?: number[]
  ariaLabel: string
  legend?: [string, string]
}) {
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null)
  const cell = 13
  const gap = 3
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // Columns are weeks ending today; rows are days (Mon..Sun).
  const end = new Date(today)
  const dow = (end.getDay() + 6) % 7
  const start = new Date(end)
  start.setDate(start.getDate() - dow - (weeks - 1) * 7)
  const cells: { key: string; x: number; y: number; d: Date; v?: HeatDatum; future: boolean }[] = []
  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      const d = new Date(start)
      d.setDate(start.getDate() + w * 7 + r)
      const key = dayKey(d)
      cells.push({ key, x: w * (cell + gap), y: r * (cell + gap), d, v: data.get(key), future: d > today })
    }
  }
  const maxV = Math.max(1, ...[...data.values()].map((v) => v.value))
  const level = (v: number) => {
    const t = v / maxV
    return t <= 0 ? 0 : t < 0.5 ? 1 : t < 0.8 ? 2 : 3
  }
  const fills = ['transparent', 'color-mix(in oklab, var(--domain) 35%, var(--raised-2))', 'color-mix(in oklab, var(--domain) 65%, var(--raised-2))', 'var(--domain)']
  const W = weeks * (cell + gap)
  const H = 7 * (cell + gap)
  const hc = hover && cells.find((c) => c.key === hover.key)
  return (
    <div className="chart" style={{ width: W + 22 }}>
      <svg width={W + 22} height={H} role="img" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
        {['M', '', 'W', '', 'F', '', ''].map((l, r) => (
          <text key={r} x={0} y={r * (cell + gap) + 10} style={{ fill: 'var(--text-4)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
            {l}
          </text>
        ))}
        <g transform="translate(22,0)">
          {cells.map((c) => {
            const lv = c.v ? level(c.v.value) : 0
            const isToday = c.key === dayKey(today)
            return (
              <rect
                key={c.key}
                x={c.x}
                y={c.y}
                width={cell}
                height={cell}
                rx={3}
                onPointerEnter={() => setHover({ key: c.key, x: c.x + 22 + cell / 2, y: c.y })}
                style={{
                  fill: c.future ? 'transparent' : fills[lv],
                  stroke: isToday ? 'var(--text-2)' : lv === 0 ? 'var(--line-2)' : 'none',
                  strokeWidth: 1,
                  opacity: c.future ? 0.35 : 1,
                }}
              />
            )
          })}
        </g>
      </svg>
      {legend && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
          <span>{legend[0]}</span>
          {levels.slice(1).map((l) => (
            <span key={l} style={{ width: 10, height: 10, borderRadius: 2, background: fills[l] }} />
          ))}
          <span>{legend[1]}</span>
        </div>
      )}
      {hover && hc && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <b>{hc.v ? hc.v.tip ?? hc.v.value : 'Rest'}</b>
          {fmt.date(hc.d)}
        </div>
      )}
    </div>
  )
}

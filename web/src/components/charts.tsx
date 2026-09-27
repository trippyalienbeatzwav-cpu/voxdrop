import { useState } from 'react';
import { cx } from '../lib/format';

export interface Series {
  key: string;
  label: string;
  color: string;
}

/**
 * Accessible stacked bar chart (SVG). Values are exposed via a visually
 * hidden data table and per-bar focusable tooltips, so the chart never
 * relies on colour or hover alone.
 */
export function StackedBars<T extends Record<string, number | string>>({
  data,
  xKey,
  series,
  height = 200,
  format = (n: number) => String(n),
  title,
}: {
  data: T[];
  xKey: keyof T;
  series: Series[];
  height?: number;
  format?: (n: number) => string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((a, s) => a + Number(d[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const bw = 100 / Math.max(1, data.length);
  return (
    <figure className="relative">
      <figcaption className="sr-only">{title}</figcaption>
      <div className="mb-3 flex flex-wrap gap-3 text-xs text-muted" aria-hidden>
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="relative" style={{ height }}>
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="border-t border-dashed border-line/70" />
          ))}
        </div>
        <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
          {data.map((d, i) => {
            let y = height;
            return (
              <g key={i} opacity={hover === null || hover === i ? 1 : 0.45}>
                {series.map((s) => {
                  const v = Number(d[s.key] ?? 0);
                  const h = (v / max) * (height - 4);
                  y -= h;
                  return <rect key={s.key} x={i * bw + bw * 0.18} width={bw * 0.64} y={y} height={Math.max(0, h)} fill={s.color} rx={0.6} />;
                })}
              </g>
            );
          })}
        </svg>
        <div className="absolute inset-0 flex">
          {data.map((d, i) => (
            <button
              key={i}
              className="h-full flex-1 rounded-sm outline-offset-0 focus-visible:bg-white/5"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${String(d[xKey])}: ${series.map((s) => `${s.label} ${format(Number(d[s.key] ?? 0))}`).join(', ')}`}
            />
          ))}
        </div>
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-overlay px-3 py-2 text-xs shadow-lg"
            style={{ left: `${(hover + 0.5) * bw}%` }}
          >
            <div className="mb-1 font-semibold">{String(data[hover]![xKey])}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-muted">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="num">{format(Number(data[hover]![s.key] ?? 0))}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-subtle" aria-hidden>
        <span>{String(data[0]?.[xKey] ?? '')}</span>
        <span>{String(data[data.length - 1]?.[xKey] ?? '')}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>{String(xKey)}</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <td>{String(d[xKey])}</td>
              {series.map((s) => (
                <td key={s.key}>{format(Number(d[s.key] ?? 0))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Sparkline({ values, color = 'var(--color-volt)', height = 40, className }: { values: number[]; color?: string; height?: number; className?: string }) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${height - (v / max) * (height - 4) - 2}`).join(' ');
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className={cx('w-full', className)} style={{ height }} aria-hidden>
      <polyline points={`0,${height} ${pts} 100,${height}`} fill={color} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal ranked bars for "top N" lists. */
export function RankBars({ rows, format = String }: { rows: Array<{ label: string; value: number; color?: string; sub?: string }>; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={i} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-3 text-sm">
          <span className="num text-subtle">{i + 1}</span>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{r.label}</span>
              {r.sub && <span className="shrink-0 text-xs text-subtle">{r.sub}</span>}
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-overlay">
              <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? 'var(--color-volt)' }} />
            </div>
          </div>
          <span className="num text-right font-semibold">{format(r.value)}</span>
        </li>
      ))}
    </ol>
  );
}

/** 24-hour activity heat strip (peak hours). */
export function HourStrip({ hours }: { hours: Array<{ hour: number; n: number }> }) {
  const max = Math.max(1, ...hours.map((h) => h.n));
  return (
    <div>
      <div className="grid grid-cols-12 gap-1 sm:grid-cols-24" role="list" aria-label="Messages by hour of day (UTC)">
        {hours.map((h) => (
          <div key={h.hour} role="listitem" aria-label={`${h.hour}:00 UTC — ${h.n} messages`} title={`${h.hour}:00 — ${h.n}`} className="h-10 rounded-md ring-1 ring-line" style={{ background: `rgb(255 212 59 / ${0.06 + (h.n / max) * 0.8})` }} />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-subtle" aria-hidden>
        <span>00:00</span>
        <span>12:00</span>
        <span>23:00 UTC</span>
      </div>
    </div>
  );
}

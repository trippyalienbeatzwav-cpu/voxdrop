import { useRef, type ReactNode } from 'react';
import { cx } from '../../lib/format';

export interface TabDef<T extends string> {
  value: T;
  label: string;
  count?: number | null;
  icon?: ReactNode;
}

/** ARIA tabs with roving tabindex and arrow-key navigation. Horizontally scrollable on mobile. */
export function Tabs<T extends string>({ tabs, value, onChange, label, className }: { tabs: TabDef<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      onChange(tabs[next]!.value);
      ref.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
    }
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className={cx('-mx-1 flex gap-1 overflow-x-auto px-1 pb-1', className)}>
      {tabs.map((t, i) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              'inline-flex h-10 shrink-0 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-colors',
              active ? 'bg-raised text-fg ring-1 ring-line-strong' : 'text-muted hover:bg-raised/60 hover:text-fg',
            )}
          >
            {t.icon}
            {t.label}
            {t.count != null && (
              <span className={cx('num min-w-6 rounded-md px-1.5 py-0.5 text-[11px]', active ? 'bg-volt text-on-volt' : 'bg-overlay text-muted')}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

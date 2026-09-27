import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../lib/format';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'danger';
  disabled?: boolean;
  shortcut?: string;
}

/**
 * Accessible dropdown menu (menu button pattern): arrow keys move focus,
 * Esc closes and returns focus to the trigger, click-outside closes.
 * Also usable as a context menu by passing `anchor` coordinates.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  label,
  open: controlledOpen,
  onOpenChange,
  anchor,
}: {
  trigger?: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; 'aria-controls': string }) => ReactNode;
  items: Array<MenuItem | 'divider'>;
  align?: 'start' | 'end';
  label: string;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  anchor?: { x: number; y: number } | null;
}) {
  const [internal, setInternal] = useState(false);
  const open = controlledOpen ?? internal;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInternal(v));
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled])');
    first?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      (root.current?.querySelector('[aria-haspopup]') as HTMLElement | null)?.focus();
    }
  };

  const menu = open && (
    <div
      ref={list}
      id={id}
      role="menu"
      aria-label={label}
      onKeyDown={onKey}
      style={anchor ? { position: 'fixed', left: Math.min(anchor.x, window.innerWidth - 230), top: Math.min(anchor.y, window.innerHeight - 320) } : undefined}
      className={cx(
        'z-50 min-w-52 animate-rise rounded-xl border border-line bg-raised p-1.5 shadow-[var(--shadow-pop)]',
        !anchor && 'absolute top-full mt-2',
        !anchor && (align === 'end' ? 'right-0' : 'left-0'),
      )}
    >
      {items.map((it, i) =>
        it === 'divider' ? (
          <div key={i} className="my-1 h-px bg-line" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              setOpen(false);
              it.onSelect();
            }}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors disabled:opacity-40',
              it.tone === 'danger' ? 'text-danger hover:bg-danger/10 focus:bg-danger/10' : 'text-fg hover:bg-overlay focus:bg-overlay',
            )}
          >
            {it.icon && <span className="text-muted [&>svg]:size-4">{it.icon}</span>}
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <kbd className="rounded border border-line px-1.5 font-mono text-[10px] text-subtle">{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );

  return (
    <div ref={root} className="relative inline-flex">
      {trigger?.({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': 'menu', 'aria-controls': id })}
      {menu}
    </div>
  );
}

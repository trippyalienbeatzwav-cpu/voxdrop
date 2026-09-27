import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cx } from '../../lib/format';
import { errorCopy } from '../../lib/api';

type Tone = 'success' | 'danger' | 'info' | 'warning';
interface ToastInput {
  title: string;
  body?: string;
  tone?: Tone;
  durationMs?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

const Ctx = createContext<(t: ToastInput) => void>(() => undefined);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: ToastInput) => {
      const id = ++seq;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.durationMs ?? (t.tone === 'danger' ? 7000 : 4500));
    },
    [dismiss],
  );
  const icon = { success: CheckCircle2, danger: AlertTriangle, warning: AlertTriangle, info: Info };
  const color = { success: 'text-success', danger: 'text-danger', warning: 'text-amber', info: 'text-cyan' };
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pr-6">
        {items.map((t) => {
          const Icon = icon[t.tone ?? 'info'];
          return (
            <div key={t.id} role={t.tone === 'danger' ? 'alert' : 'status'} className="pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-3 rounded-2xl border border-line bg-raised p-4 shadow-[var(--shadow-pop)]">
              <Icon className={cx('mt-0.5 size-5 shrink-0', color[t.tone ?? 'info'])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-fg">{t.title}</p>
                {t.body && <p className="mt-0.5 text-sm text-muted">{t.body}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} className="-m-1 rounded-lg p-1 text-subtle hover:text-fg" aria-label="Dismiss notification">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

/** Toast for a failed mutation, using the API's error code copy. */
export function useErrorToast() {
  const toast = useToast();
  return useMemo(() => (err: unknown) => toast({ ...errorCopy(err), tone: 'danger' }), [toast]);
}

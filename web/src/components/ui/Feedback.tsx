import { useState, type ReactNode } from 'react';
import { AlertOctagon, Ban, Coins, Lock, RefreshCw, SearchX, WifiOff } from 'lucide-react';
import { ApiError, errorCopy } from '../../lib/api';
import { cx, fmtPoints, initials } from '../../lib/format';
import type { MessageStatus } from '../../lib/types';
import { Button, ButtonLink } from './Button';
import { kickLoginHref } from '../../lib/session';

type Tone = 'neutral' | 'volt' | 'magenta' | 'cyan' | 'violet' | 'amber' | 'danger' | 'success';
const toneCls: Record<Tone, string> = {
  neutral: 'bg-overlay text-muted border-line',
  volt: 'bg-volt/10 text-volt border-volt/25',
  magenta: 'bg-magenta/10 text-magenta border-magenta/25',
  cyan: 'bg-cyan/10 text-cyan border-cyan/25',
  violet: 'bg-violet/10 text-violet border-violet/25',
  amber: 'bg-amber/10 text-amber border-amber/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  success: 'bg-success/10 text-success border-success/25',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-semibold', toneCls[tone], className)}>
      {dot && <span className="size-1.5 animate-pulse-dot rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const statusTone: Record<MessageStatus, Tone> = {
  PENDING: 'amber',
  APPROVED: 'cyan',
  QUEUED: 'violet',
  PLAYING: 'volt',
  PLAYED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};
export function StatusBadge({ status }: { status: MessageStatus }) {
  return (
    <Badge tone={statusTone[status]} dot={status === 'PLAYING'}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </Badge>
  );
}

export function LiveBadge({ live }: { live: boolean }) {
  return live ? (
    <Badge tone="magenta" dot>
      LIVE
    </Badge>
  ) : (
    <Badge>Offline</Badge>
  );
}

export function Points({ value, className, size = 'md' }: { value: number; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cx('inline-flex items-center gap-1 font-semibold text-volt', size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-xs' : 'text-sm', className)}>
      <Coins className={size === 'lg' ? 'size-6' : size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
      <span className="num">{fmtPoints(value)}</span>
      <span className="sr-only">points</span>
    </span>
  );
}

export function Avatar({ src, name, size = 40, className, ring }: { src?: string | null; name: string; size?: number; className?: string; ring?: string }) {
  const [broken, setBroken] = useState(false);
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className={cx('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-semibold', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 90% 80%)`, boxShadow: ring ? `0 0 0 2px var(--color-canvas), 0 0 0 4px ${ring}` : undefined }}
    >
      {src && !broken ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" /> : initials(name)}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('space-y-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card flex items-center gap-4 p-4">
          <Skeleton className="size-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-14 text-center', className)}>
      {icon && <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-raised text-muted [&>svg]:size-7">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      {body && <p className="mt-1.5 max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Error state that picks copy + icon from the API error code. Never a blank screen. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN';
  const { title, body } = errorCopy(error);
  const icon = code === 'OFFLINE' ? <WifiOff /> : code === 'UNAUTHORIZED' ? <Lock /> : code === 'FORBIDDEN' ? <Ban /> : code === 'NOT_FOUND' ? <SearchX /> : <AlertOctagon />;
  return (
    <EmptyState
      className={className}
      icon={icon}
      title={title}
      body={body}
      action={
        code === 'UNAUTHORIZED' ? (
          <a href={kickLoginHref(location.pathname)} className="inline-flex h-11 items-center rounded-xl bg-kick px-4 font-semibold text-black">
            Continue with Kick
          </a>
        ) : code === 'FORBIDDEN' ? (
          <ButtonLink to="/home">Back to home</ButtonLink>
        ) : onRetry ? (
          <Button onClick={onRetry} icon={<RefreshCw className="size-4" />}>
            Try again
          </Button>
        ) : null
      }
    />
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-overlay px-2 py-1 text-xs text-fg opacity-0 shadow-lg transition-opacity delay-300 group-focus-within/tt:opacity-100 group-hover/tt:opacity-100">
        {label}
      </span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-overlay px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function StatCard({ label, value, icon, hint, tone = 'volt' }: { label: string; value: ReactNode; icon: ReactNode; hint?: ReactNode; tone?: 'volt' | 'magenta' | 'cyan' | 'violet' | 'amber' }) {
  const t = { volt: 'text-volt bg-volt/10', magenta: 'text-magenta bg-magenta/10', cyan: 'text-cyan bg-cyan/10', violet: 'text-violet bg-violet/10', amber: 'text-amber bg-amber/10' }[tone];
  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="label-caps">{label}</span>
        <span className={cx('flex size-8 items-center justify-center rounded-lg [&>svg]:size-4', t)} aria-hidden>
          {icon}
        </span>
      </div>
      <div className="num font-display text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-xs text-subtle">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center p-10 text-muted">
      <RefreshCw className="size-5 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}

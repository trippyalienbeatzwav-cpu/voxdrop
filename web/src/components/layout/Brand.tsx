import { Link } from 'react-router-dom';
import { cx } from '../../lib/format';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx('size-8', className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="#12161A" />
      <g fill="var(--color-volt)">
        <rect x="6" y="13" width="3" height="6" rx="1.5" />
        <rect x="11" y="9" width="3" height="14" rx="1.5" />
        <rect x="16" y="6" width="3" height="20" rx="1.5" />
        <rect x="21" y="11" width="3" height="10" rx="1.5" />
      </g>
    </svg>
  );
}

/** Condensed uppercase wordmark (gaming/esports), with the waveform mark. */
export function Brand({ to = '/', compact, large }: { to?: string; compact?: boolean; large?: boolean }) {
  return (
    <Link to={to} className="flex shrink-0 items-center gap-2 rounded-lg" aria-label="VoxDrop home">
      <Logo className={large ? 'size-9' : undefined} />
      {!compact && <span className={cx('font-esports leading-none text-white', large ? 'text-[32px]' : 'text-2xl')}>VoxDrop</span>}
    </Link>
  );
}

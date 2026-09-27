import { Link } from 'react-router-dom';
import { AlertTriangle, Timer } from 'lucide-react';
import type { Quote } from '../lib/types';
import { fmtPoints } from '../lib/format';
import { Points, Skeleton } from './ui/Feedback';

/** "Balance before purchase" block used on every spend screen. */
export function SpendSummary({ quote, loading, cooldownLeft }: { quote?: Quote; loading?: boolean; cooldownLeft?: number }) {
  if (loading || !quote) return <Skeleton className="h-28 rounded-xl" />;
  const { price } = quote;
  return (
    <div className="rounded-xl border border-line bg-canvas/60 p-4 text-sm" aria-live="polite">
      <dl className="space-y-1.5">
        <Row k="Base price" v={price.base === 0 ? 'Free' : `${fmtPoints(price.base)}`} />
        {price.priority > 0 && <Row k={`Priority${price.tier && price.tier !== 'NORMAL' ? ` (${price.tier.toLowerCase()})` : ''}`} v={`+${fmtPoints(price.priority)}`} />}
        {price.bonus > 0 && <Row k="Bonus points" v={`+${fmtPoints(price.bonus)}`} />}
        <div className="my-2 border-t border-line" />
        <div className="flex items-center justify-between">
          <dt className="font-semibold">Total</dt>
          <dd>
            <Points value={price.total} />
          </dd>
        </div>
        <Row k="Your balance" v={fmtPoints(quote.balance)} />
        <Row k="After sending" v={fmtPoints(Math.max(0, quote.balanceAfter))} strong={quote.affordable} />
      </dl>
      {!quote.affordable && (
        <p className="mt-3 flex items-center gap-2 text-amber" role="alert">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          You need {fmtPoints(price.total - quote.balance)} more points.{' '}
          <Link to="/points" className="font-semibold underline">
            Get points
          </Link>
        </p>
      )}
      {!!cooldownLeft && cooldownLeft > 0 && (
        <p className="mt-3 flex items-center gap-2 text-amber" role="status">
          <Timer className="size-4 shrink-0" aria-hidden /> Cooldown: you can send again in {cooldownLeft}s
        </p>
      )}
      {quote.dailyRemaining != null && <p className="mt-2 text-xs text-subtle">{quote.dailyRemaining} messages left today on this channel.</p>}
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-muted">
      <dt>{k}</dt>
      <dd className={`num ${strong ? 'text-fg' : ''}`}>{v}</dd>
    </div>
  );
}

import { Link } from 'react-router-dom';
import type { Streamer } from '../lib/types';
import { Avatar, LiveBadge } from './ui/Feedback';

export function StreamerMini({ s, children }: { s: Streamer; children?: React.ReactNode }) {
  return (
    <div className="card flex flex-wrap items-center gap-4 p-4">
      <Avatar src={s.avatarUrl} name={s.displayName} size={48} ring={s.isLive ? 'var(--color-magenta)' : undefined} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link to={`/streamer/${s.slug}`} className="truncate font-semibold hover:text-volt">
            {s.displayName}
          </Link>
          <LiveBadge live={s.isLive} />
        </div>
        <p className="text-sm text-subtle">{s.approvalMode === 'AUTO' ? 'Messages go straight to the queue' : 'Messages are reviewed before airing'}</p>
      </div>
      {children}
    </div>
  );
}

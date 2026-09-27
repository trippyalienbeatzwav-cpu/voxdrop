import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MessageSquare, Mic, Music2, Search } from 'lucide-react';
import { get, qs } from '../../lib/api';
import type { Streamer } from '../../lib/types';
import { Avatar, EmptyState, ErrorState, LiveBadge, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Field';
import { fmtPoints } from '../../lib/format';

const COPY = {
  send: { title: 'Send a message', sub: 'Choose a streamer to send a text message to.', icon: MessageSquare, path: (s: string) => `/send/${s}` },
  voice: { title: 'Send a voice message', sub: 'Choose a streamer to record or upload audio for.', icon: Mic, path: (s: string) => `/voice/${s}` },
  sounds: { title: 'Sound library', sub: 'Choose a streamer to open their soundboard.', icon: Music2, path: (s: string) => `/sounds?streamer=${s}` },
};

export function StreamerPickerList({ mode }: { mode: keyof typeof COPY }) {
  const [q, setQ] = useState('');
  const c = COPY[mode];
  const query = useQuery({ queryKey: ['streamers', 'picker', q], queryFn: () => get<{ items: Streamer[] }>(`/api/streamers${qs({ q, sort: 'live', limit: 30 })}`) });
  return (
    <>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search streamers" aria-label="Search streamers" className="pl-10" />
      </div>
      {query.isLoading ? (
        <SkeletonList />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState icon={<Search />} title="No streamers found" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {query.data.items.map((s) => (
            <li key={s.id}>
              <Link to={c.path(s.slug)} className="card flex items-center gap-4 p-4 transition-colors hover:border-line-strong">
                <Avatar src={s.avatarUrl} name={s.displayName} size={44} ring={s.isLive ? 'var(--color-magenta)' : undefined} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold">
                    {s.displayName} <LiveBadge live={s.isLive} />
                  </div>
                  <p className="text-sm text-subtle">
                    {mode === 'voice' ? `Voice from ${fmtPoints(s.priceVoice)} pts` : mode === 'send' ? `Text ${fmtPoints(s.priceText)} pts` : `${s.soundCount ?? 0} sounds`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function StreamerPicker({ mode }: { mode: 'send' | 'voice' }) {
  const c = COPY[mode];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={c.title} subtitle={c.sub} />
      <StreamerPickerList mode={mode} />
    </div>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { LayoutGrid } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx, fmtDuration } from '../../lib/format';
import type { Sound } from '../../lib/types';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../../components/ui/Feedback';
import { ButtonLink } from '../../components/ui/Button';
import { SoundIcon } from '../../components/shared';
import { useErrorToast, useToast } from '../../components/ui/Toast';

/** Streamer/mod soundboard: big tappable buttons that play instantly on stream (free for staff). */
export default function Soundboard() {
  const { channel } = useChannel();
  const toast = useToast();
  const onError = useErrorToast();
  const q = useQuery({ queryKey: ['sounds', channel?.slug, 'board'], enabled: !!channel, queryFn: () => get<{ items: Sound[] }>(`/api/sounds?streamer=${channel!.slug}&sort=custom`) });
  const fire = useMutation({
    mutationFn: (s: Sound) => post(`/api/sounds/${s.id}/trigger`),
    onSuccess: (_r, s) => toast({ title: `▶ ${s.name}`, body: 'Sent to the front of the queue.', tone: 'success', durationMs: 1800 }),
    onError,
  });
  if (!channel) return null;
  return (
    <div>
      <PageHeader title="Soundboard" subtitle="Tap to play on stream. Staff plays are free and jump the queue." actions={channel.access === 'owner' ? <ButtonLink to="/streamer/sounds">Manage sounds</ButtonLink> : undefined} />
      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-2xl" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState icon={<LayoutGrid />} title="No active sounds" action={channel.access === 'owner' ? <ButtonLink to="/streamer/sounds" variant="primary">Add sounds</ButtonLink> : undefined} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {q.data.items.map((s) => (
            <button
              key={s.id}
              onClick={() => fire.mutate(s)}
              disabled={fire.isPending && fire.variables?.id === s.id}
              className={cx('card group flex aspect-square flex-col items-center justify-center gap-3 p-4 text-center transition-[transform,border-color,background-color] duration-150 hover:border-line-strong active:scale-95')}
              style={{ backgroundImage: `radial-gradient(circle at 50% 30%, ${s.color}1a, transparent 70%)` }}
              aria-label={`Play ${s.name} on stream`}
            >
              <SoundIcon icon={s.icon} color={s.color} size={56} />
              <span className="font-semibold">{s.name}</span>
              <span className="num text-xs text-subtle">{fmtDuration(s.durationMs)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

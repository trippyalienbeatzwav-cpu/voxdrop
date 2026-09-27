import { AudioLines, CheckCircle2, CircleSlash, Database, Megaphone, TriangleAlert } from 'lucide-react';
import { useChannel } from '../../lib/channel';
import { qs } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, EmptyState, ErrorState, SkeletonList } from '../../components/ui/Feedback';
import { LoadMore, TypeBadge, usePaged } from '../../components/shared';
import type { MessageType } from '../../lib/types';

interface Row {
  id: string;
  message_id: string;
  viewer_name: string;
  type: MessageType;
  is_donation: boolean;
  phase: 'COMPLETED' | 'SKIPPED' | 'FAILED' | string;
  announcement_status: 'NONE' | 'READY' | 'FAILED' | 'PLAYED' | 'SKIPPED' | 'PENDING';
  announcement_text: string | null;
  announcement_cached: boolean | null;
  message_started_at: string | null;
  message_finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  finished_at: string;
  created_at?: string;
}

const ANN: Record<Row['announcement_status'], { label: string; tone: 'success' | 'amber' | 'danger' | 'neutral' | 'cyan' }> = {
  PLAYED: { label: 'Played', tone: 'success' },
  SKIPPED: { label: 'Skipped', tone: 'amber' },
  FAILED: { label: 'Failed', tone: 'danger' },
  NONE: { label: 'Off', tone: 'neutral' },
  READY: { label: 'Not played', tone: 'amber' },
  PENDING: { label: 'Not played', tone: 'amber' },
};

/** Per-item playback history: viewer, announcement outcome, message outcome, duration, errors. */
export function PlaybackLog() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const q = usePaged<Row>(['playback-log', sid], (cursor) => `/api/channels/${sid}/playback-log${qs({ cursor, limit: 30 })}`, !!sid);
  if (q.isLoading) return <SkeletonList />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.items.length) return <EmptyState icon={<AudioLines />} title="Nothing has played yet" body="Every item that plays (or is skipped) on your overlay is logged here with its announcement." />;
  return (
    <>
      <ul className="grid gap-3 lg:grid-cols-2">
        {q.items.map((r) => {
          const ann = ANN[r.announcement_status] ?? ANN.NONE;
          const messagePlayed = r.phase === 'COMPLETED';
          return (
            <li key={r.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.viewer_name}</span>
                <TypeBadge type={r.type} />
                {r.is_donation && <Badge tone="magenta">Donation</Badge>}
                <span className="ml-auto text-xs text-subtle">{fmtDateTime(r.finished_at)}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="label-caps">Announcement</dt>
                  <dd className="mt-1 flex items-center gap-1">
                    <Badge tone={ann.tone}>
                      <Megaphone className="size-3" aria-hidden /> {ann.label}
                    </Badge>
                    {r.announcement_cached && <Database className="size-3.5 text-subtle" aria-label="Served from cache" />}
                  </dd>
                </div>
                <div>
                  <dt className="label-caps">Message</dt>
                  <dd className="mt-1">
                    <Badge tone={messagePlayed ? 'success' : r.phase === 'FAILED' ? 'danger' : 'amber'}>
                      {messagePlayed ? <CheckCircle2 className="size-3" aria-hidden /> : r.phase === 'FAILED' ? <TriangleAlert className="size-3" aria-hidden /> : <CircleSlash className="size-3" aria-hidden />}
                      {messagePlayed ? 'Played' : r.phase === 'FAILED' ? 'Failed' : 'Skipped'}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="label-caps">Duration</dt>
                  <dd className="num mt-1">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : '—'}</dd>
                </div>
                <div>
                  <dt className="label-caps">Status</dt>
                  <dd className="mt-1 text-sm">{r.phase === 'COMPLETED' ? 'Completed' : r.phase.charAt(0) + r.phase.slice(1).toLowerCase()}</dd>
                </div>
              </dl>
              {r.announcement_text && <p className="mt-3 text-sm text-muted">“{r.announcement_text}”</p>}
              {r.error && (
                <p className="mt-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger" role="note">
                  {r.error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <LoadMore q={q} />
    </>
  );
}

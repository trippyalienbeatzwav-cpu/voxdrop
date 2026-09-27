import { useSearchParams } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtDateTime } from '../../lib/format';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Tabs } from '../../components/ui/Tabs';
import { LoadMore, usePaged } from '../../components/shared';
import { PlaybackLog } from './PlaybackLog';

interface Log {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  actor_username: string | null;
  actor_avatar: string | null;
}

const LABELS: Record<string, string> = {
  'message.approved': 'approved a message',
  'message.rejected': 'rejected a message',
  'message.deleted': 'deleted a message',
  'user.warn': 'warned a user',
  'user.mute': 'muted a user',
  'user.unmute': 'unmuted a user',
  'user.ban': 'banned a user',
  'user.unban': 'unbanned a user',
  'settings.updated': 'changed settings',
  'profile.updated': 'updated the channel profile',
  'overlay.key_rotated': 'rotated the overlay key',
  'sound.created': 'added a sound',
  'sound.updated': 'edited a sound',
  'sound.deleted': 'deleted a sound',
  'points.granted': 'gifted points',
  'donation.completed': 'donated',
  'donation.refund_requested': 'refunded a donation',
  'queue.paused': 'paused the queue',
  'queue.resumed': 'resumed the queue',
  'queue.reordered': 'reordered the queue',
  'moderator.added': 'added a moderator',
  'moderator.removed': 'removed a moderator',
  'kick.events_subscribed': 'connected Kick events',
  'streamer.created': 'created the channel',
};

function describe(l: Log) {
  const m = l.metadata ?? {};
  if (l.action === 'settings.updated' && m.changes && typeof m.changes === 'object') {
    return Object.entries(m.changes as Record<string, { from: unknown; to: unknown }>)
      .slice(0, 4)
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`)
      .join(' · ');
  }
  const bits: string[] = [];
  if (m.reason) bits.push(`“${String(m.reason)}”`);
  if (m.name) bits.push(String(m.name));
  if (m.amount) bits.push(`${m.amount} pts`);
  if (m.minutes) bits.push(`${m.minutes} min`);
  if (m.amountCents) bits.push(`$${(Number(m.amountCents) / 100).toFixed(2)}`);
  return bits.join(' · ');
}

export default function StreamerHistory() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? 'all';
  const q = usePaged<Log>(['channel-history', sid, category], (cursor) => `/api/channels/${sid}/history${qs({ category, cursor, limit: 40 })}`, !!sid && category !== 'playback');
  return (
    <div>
      <PageHeader title="History" subtitle="An immutable audit log of everything that changed on your channel." />
      <Tabs
        label="Log category"
        value={category}
        onChange={(v) => setParams({ category: v }, { replace: true })}
        className="mb-4"
        tabs={[
          { value: 'all', label: 'All' },
          { value: 'playback', label: 'Playback log' },
          { value: 'moderation', label: 'Moderation' },
          { value: 'queue', label: 'Queue' },
          { value: 'donations', label: 'Donations' },
          { value: 'points', label: 'Points' },
          { value: 'sounds', label: 'Sounds' },
          { value: 'settings', label: 'Settings' },
          { value: 'users', label: 'Team' },
        ]}
      />
      {category === 'playback' ? (
        <PlaybackLog />
      ) : q.isLoading ? (
        <SkeletonList />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.items.length ? (
        <EmptyState icon={<ScrollText />} title="Nothing logged yet" />
      ) : (
        <ol className="card divide-y divide-line">
          {q.items.map((l) => (
            <li key={l.id} className="flex items-start gap-3 p-4">
              <Avatar src={l.actor_avatar} name={l.actor_username ?? 'System'} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-semibold">{l.actor_username ?? 'System'}</span> {LABELS[l.action] ?? l.action}
                </p>
                {describe(l) && <p className="break-words text-xs text-muted">{describe(l)}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge className="font-mono text-[10px]">{l.action}</Badge>
                <time className="text-xs text-subtle" dateTime={l.created_at}>
                  {fmtDateTime(l.created_at)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
      <LoadMore q={q} />
    </div>
  );
}

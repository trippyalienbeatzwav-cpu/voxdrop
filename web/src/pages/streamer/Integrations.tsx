import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Eye, EyeOff, FlaskConical, MonitorPlay, RefreshCw, Webhook, XCircle } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtDateTime } from '../../lib/format';
import { Badge, ErrorState, PageHeader, Skeleton } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';

interface Integ {
  kickMode: 'live' | 'mock';
  kick: { username: string; connected: boolean; tokenExpiresAt: string | null; scopes: string[] } | null;
  broadcasterUserId: string | null;
  eventsSubscribedAt: string | null;
  webhookUrl: string;
  overlayConnected: boolean;
  lastEvents: Array<{ event_type: string; status: string; received_at: string; error: string | null }>;
}

export default function Integrations() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const [reveal, setReveal] = useState(false);
  const overlay = useQuery({ queryKey: ['overlay', sid], enabled: !!sid, queryFn: () => get<{ overlayUrl: string; connected: boolean }>(`/api/channels/${sid}/overlay`), refetchInterval: 10_000 });
  const integ = useQuery({ queryKey: ['integrations', sid], enabled: !!sid, queryFn: () => get<Integ>(`/api/channels/${sid}/integrations`) });
  const rotate = useMutation({
    mutationFn: () => post(`/api/channels/${sid}/overlay/rotate`),
    onSuccess: () => {
      toast({ title: 'Overlay URL rotated', body: 'Update the Browser Source in OBS with the new URL.', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['overlay'] });
    },
    onError,
  });
  const subscribe = useMutation({
    mutationFn: () => post<{ subscriptions: number }>(`/api/channels/${sid}/kick/subscribe-events`),
    onSuccess: (r) => {
      toast({ title: `Subscribed to ${r.subscriptions} Kick events`, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError,
  });
  if (!sid) return null;
  if (integ.error) return <ErrorState error={integ.error} onRetry={() => integ.refetch()} />;
  const url = overlay.data?.overlayUrl ?? '';
  const masked = url.replace(/token=.*/, 'token=••••••••••••');
  const i = integ.data;

  return (
    <div className="space-y-6">
      <PageHeader title="Integrations" subtitle="Connect OBS and Kick. Sub, gift-sub and donation alert overlays live under OBS Overlays." />

      <section className="card p-5" aria-labelledby="obs-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="obs-h" className="flex items-center gap-2 text-lg font-semibold">
            <MonitorPlay className="size-5 text-volt" aria-hidden /> OBS Browser Source
          </h2>
          <Badge tone={overlay.data?.connected ? 'success' : 'neutral'} dot={overlay.data?.connected}>
            {overlay.data?.connected ? 'Overlay connected' : 'Not connected'}
          </Badge>
        </div>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>In OBS, add a new <strong className="text-fg">Browser</strong> source.</li>
          <li>Paste the URL below. Set width <span className="num text-fg">1920</span> and height <span className="num text-fg">1080</span>.</li>
          <li>Enable “Control audio via OBS” if you want to mix the volume there.</li>
        </ol>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          {overlay.isLoading ? (
            <Skeleton className="h-11 flex-1" />
          ) : (
            <Input readOnly value={reveal ? url : masked} aria-label="Overlay URL" className="num flex-1 text-sm" onFocus={(e) => e.target.select()} />
          )}
          <div className="flex gap-2">
            <Button icon={reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => setReveal((v) => !v)}>
              {reveal ? 'Hide' : 'Reveal'}
            </Button>
            <Button
              variant="primary"
              icon={<Copy className="size-4" />}
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                toast({ title: 'Overlay URL copied', tone: 'success' });
              }}
            >
              Copy
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber/25 bg-amber/5 p-3 text-sm text-amber">
          <span>Treat this URL like a password — anyone with it can see your overlay.</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className="size-4" />}
            loading={rotate.isPending}
            onClick={async () => {
              if (await confirm({ title: 'Rotate overlay URL?', body: 'The current URL stops working immediately.', confirmLabel: 'Rotate', tone: 'danger' })) rotate.mutate();
            }}
          >
            Rotate
          </Button>
        </div>
      </section>

      <section className="card p-5" aria-labelledby="kick-h">
        <h2 id="kick-h" className="flex items-center gap-2 text-lg font-semibold">
          <Webhook className="size-5 text-cyan" aria-hidden /> Kick events
        </h2>
        {!i ? (
          <Skeleton className="mt-4 h-32" />
        ) : (
          <>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                <dt className="text-muted">Kick API access</dt>
                <dd className="flex items-center gap-1.5 font-medium">{i.kick?.connected ? <><CheckCircle2 className="size-4 text-success" /> Connected</> : <><XCircle className="size-4 text-danger" /> Reconnect needed</>}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                <dt className="text-muted">Event subscriptions</dt>
                <dd className="font-medium">{i.eventsSubscribedAt ? fmtDateTime(i.eventsSubscribedAt) : 'Not subscribed'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 sm:col-span-2">
                <dt className="text-muted">Webhook endpoint (register on your Kick app)</dt>
                <dd className="num truncate text-xs">{i.webhookUrl}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => subscribe.mutate()} loading={subscribe.isPending} disabled={channel?.access !== 'owner'}>
                Re-subscribe to events
              </Button>
            </div>
            {i.kickMode === 'mock' && <p className="mt-3 text-xs text-amber">Development mode: Kick is mocked. Real events require KICK_MODE=live with official Kick app credentials, and a public HTTPS webhook URL.</p>}
            <h3 className="mb-2 mt-6 text-sm font-semibold">Recent deliveries</h3>
            {i.lastEvents.length === 0 ? (
              <p className="text-sm text-subtle">No events received yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {i.lastEvents.map((e, idx) => (
                  <li key={idx} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                    <span className="num flex-1 text-xs">{e.event_type}</span>
                    <Badge tone={e.status === 'PROCESSED' ? 'success' : e.status === 'FAILED' ? 'danger' : 'neutral'}>{e.status.toLowerCase()}</Badge>
                    <span className="text-xs text-subtle">{fmtDateTime(e.received_at)}</span>
                    {e.error && <p className="w-full text-xs text-danger">{e.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {i?.kickMode === 'mock' && channel?.access === 'owner' && <EventSimulator sid={sid} />}
    </div>
  );
}

/** DEV ONLY: sends correctly signed mock Kick webhooks through the real endpoint. */
function EventSimulator({ sid }: { sid: string }) {
  const [type, setType] = useState('channel.subscription.new');
  const [username, setUsername] = useState('');
  const [giftCount, setGiftCount] = useState(5);
  const [last, setLast] = useState<{ messageId: string; response: unknown } | null>(null);
  const qc = useQueryClient();
  const onError = useErrorToast();
  const run = useMutation({
    mutationFn: (replay?: string) => post<{ httpStatus: number; response: unknown; messageId: string }>('/api/dev/kick/simulate', { streamerId: sid, type, username: username || undefined, giftCount, isLive: true, replayMessageId: replay }),
    onSuccess: (r) => {
      setLast({ messageId: r.messageId, response: r.response });
      qc.invalidateQueries({ queryKey: ['integrations'] });
      qc.invalidateQueries({ queryKey: ['channel-subs'] });
    },
    onError,
  });
  return (
    <section className="card border-amber/30 p-5" aria-labelledby="sim-h">
      <h2 id="sim-h" className="flex items-center gap-2 text-lg font-semibold">
        <FlaskConical className="size-5 text-amber" aria-hidden /> Kick event simulator <Badge tone="amber">Dev only</Badge>
      </h2>
      <p className="mt-1 text-sm text-muted">Sends RSA-signed mock webhooks into the real /api/webhooks/kick endpoint — the same verification, idempotency and reward code as production.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field htmlFor="sim-type" label="Event">
          <Select id="sim-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="channel.subscription.new">Subscription</option>
            <option value="channel.subscription.renewal">Resubscription</option>
            <option value="channel.subscription.gifts">Gift subs</option>
            <option value="channel.followed">Follow</option>
            <option value="livestream.status.updated">Go live</option>
          </Select>
        </Field>
        <Field htmlFor="sim-user" label="Kick username" hint="Blank = a viewer who hasn’t joined VoxDrop">
          <Input id="sim-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. pixelpete" />
        </Field>
        {type === 'channel.subscription.gifts' && <NumberField label="Gift count" value={giftCount} onChange={setGiftCount} min={1} max={100} />}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => run.mutate(undefined)} loading={run.isPending && !run.variables}>
          Send event
        </Button>
        {last && (
          <Button onClick={() => run.mutate(last.messageId)} loading={run.isPending && !!run.variables}>
            Replay last (test idempotency)
          </Button>
        )}
      </div>
      {last && <pre className="num mt-4 overflow-x-auto rounded-xl bg-canvas p-3 text-xs text-muted">{JSON.stringify(last, null, 2)}</pre>}
    </section>
  );
}

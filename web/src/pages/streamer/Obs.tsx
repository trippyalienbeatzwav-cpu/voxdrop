import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Copy, Eye, EyeOff, ExternalLink, FlaskConical, Gift, HandCoins, Info, RefreshCw, Sparkles } from 'lucide-react';
import { get, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtRelative } from '../../lib/format';
import { Badge, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';

type OverlayKind = 'audio' | 'subscription' | 'gift_sub' | 'donation';
interface OverlayRow {
  kind: OverlayKind;
  url: string;
  connected: boolean;
  rotatedAt: string | null;
  lastSeenAt: string | null;
}

const META: Record<OverlayKind, { title: string; body: string; icon: typeof Sparkles; tone: string; size: string }> = {
  audio: { title: 'Voice & MP3 messages', body: 'Plays approved voice messages, MP3s and sounds with the viewer-name announcement. Needs audio.', icon: AudioLines, tone: 'text-volt', size: '1920 × 1080' },
  subscription: { title: 'Subscription alerts', body: '“{viewerName} just subscribed!” from verified Kick events.', icon: Sparkles, tone: 'text-cyan', size: '1920 × 1080' },
  gift_sub: { title: 'Gift sub alerts', body: '“{viewerName} gifted {giftCount} subs!” from verified Kick events.', icon: Gift, tone: 'text-violet', size: '1920 × 1080' },
  donation: { title: 'Donation alerts', body: 'Shown only after the payment provider confirms the payment server-side.', icon: HandCoins, tone: 'text-magenta', size: '1920 × 1080' },
};

function OverlayCard({ o, sid }: { o: OverlayRow; sid: string }) {
  const [reveal, setReveal] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const m = META[o.kind];
  const masked = o.url.replace(/token=.*/, 'token=••••••••••••••••');
  const rotate = useMutation({
    mutationFn: () => post<{ url: string }>(`/api/channels/${sid}/overlays/${o.kind}/rotate`),
    onSuccess: () => {
      toast({ title: 'New URL generated', body: 'The old URL stopped working. Paste the new one into OBS.', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['overlays', sid] });
      qc.invalidateQueries({ queryKey: ['overlay'] });
    },
    onError,
  });
  const test = useMutation({
    mutationFn: () =>
      o.kind === 'audio' ? post<{ overlayConnected?: boolean }>(`/api/channels/${sid}/announcements/test`) : post<{ overlayConnected: boolean }>(`/api/channels/${sid}/alerts/${o.kind}/test`),
    onSuccess: (r) =>
      toast(
        o.connected || r?.overlayConnected
          ? { title: 'Test sent', body: 'Check OBS — test items are clearly marked.', tone: 'success' }
          : { title: 'Test sent, but this overlay is offline', body: 'Add the Browser Source in OBS first (or open Preview).', tone: 'danger' },
      ),
    onError,
  });
  const Icon = m.icon;
  const previewUrl = o.kind === 'audio' ? o.url : `${o.url}&preview=1`;
  return (
    <section className="card flex flex-col p-5" aria-labelledby={`ov-${o.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised ring-1 ring-line ${m.tone}`}>
            <Icon className="size-5" aria-hidden />
          </span>
          <div>
            <h2 id={`ov-${o.kind}`} className="font-semibold">{m.title}</h2>
            <p className="text-sm text-muted">{m.body}</p>
          </div>
        </div>
        <Badge tone={o.connected ? 'success' : 'neutral'} dot={o.connected}>
          {o.connected ? 'Connected' : 'Offline'}
        </Badge>
      </div>
      <div className="mt-4 flex gap-2">
        <Input readOnly value={reveal ? o.url : masked} aria-label={`${m.title} overlay URL`} className="num flex-1 text-xs" onFocus={(e) => e.target.select()} />
        <Button variant="ghost" aria-label={reveal ? 'Hide URL' : 'Reveal URL'} icon={reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => setReveal((v) => !v)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button
          variant="primary"
          size="sm"
          icon={<Copy className="size-4" />}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(o.url);
              toast({ title: 'URL copied', body: `Paste it into an OBS Browser Source (${m.size}).`, tone: 'success' });
            } catch {
              setReveal(true);
              toast({ title: 'Copy blocked by the browser', body: 'The URL is revealed — select it and copy manually.', tone: 'danger' });
            }
          }}
        >
          Copy URL
        </Button>
        <Button size="sm" icon={<ExternalLink className="size-4" />} onClick={() => window.open(previewUrl, '_blank', 'noopener')}>
          Preview
        </Button>
        <Button size="sm" icon={<FlaskConical className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>
          Test
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className="size-4" />}
          loading={rotate.isPending}
          onClick={async () => {
            if (await confirm({ title: `Regenerate the ${m.title.toLowerCase()} URL?`, body: 'The current URL stops working immediately. Other overlays are not affected.', confirmLabel: 'Regenerate', tone: 'danger' })) rotate.mutate();
          }}
        >
          Regenerate
        </Button>
      </div>
      <p className="mt-3 text-xs text-subtle">
        {o.lastSeenAt ? `Last seen ${fmtRelative(o.lastSeenAt)}` : 'Never opened'}
        {o.rotatedAt ? ` · regenerated ${fmtRelative(o.rotatedAt)}` : ''}
      </p>
    </section>
  );
}

export default function Obs() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const q = useQuery({ queryKey: ['overlays', sid], enabled: !!sid, queryFn: () => get<{ items: OverlayRow[] }>(`/api/channels/${sid}/overlays`), refetchInterval: 8_000 });
  if (!sid) return null;
  if (channel?.access !== 'owner') return <ErrorState error={new Error('Only the channel owner can view overlay URLs.')} />;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Streaming software" title="OBS overlays" subtitle="Four independent Browser Sources — place, size and mute each one separately in OBS." />
      <div className="flex items-start gap-3 rounded-2xl border border-line bg-raised p-4 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-cyan" aria-hidden />
        <div>
          In OBS: <strong className="text-fg">Sources → + → Browser</strong>, paste a URL, set <span className="num text-fg">1920 × 1080</span>. For the voice overlay tick “Control audio via OBS”. Each URL contains its own secret token —
          treat it like a password. Regenerating one never affects the others.
        </div>
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <SkeletonList rows={4} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {q.data.items.map((o) => (
            <OverlayCard key={o.kind} o={o} sid={sid} />
          ))}
        </div>
      )}
    </div>
  );
}

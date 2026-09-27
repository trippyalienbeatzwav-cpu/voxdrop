import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, FlaskConical, Gift, HandCoins, MonitorPlay, Sparkles } from 'lucide-react';
import { get, patch, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx, fmtRelative } from '../../lib/format';
import type { Sound } from '../../lib/types';
import { Badge, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Select, Switch } from '../../components/ui/Field';
import { Button, ButtonLink } from '../../components/ui/Button';
import { SaveBar } from '../../components/SaveBar';
import { Tabs } from '../../components/ui/Tabs';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { ALERT_KEYFRAMES, AlertCard, sampleAlert, type AlertPayload } from '../AlertOverlay';

type Kind = 'subscription' | 'gift_sub' | 'donation';
interface AlertSettings {
  kind: Kind;
  enabled: boolean;
  template: string;
  custom_message: string;
  show_avatar: boolean;
  show_message: boolean;
  animation: AlertPayload['animation'];
  position: AlertPayload['position'];
  duration_ms: number;
  sound_id: string | null;
  volume: number;
  tts_enabled: boolean;
  tts_read_message: boolean;
  min_amount_cents: number;
  accent_color: string | null;
}
interface AlertEvent {
  id: string;
  kind: Kind;
  is_test: boolean;
  status: 'PENDING' | 'SHOWN' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  error: string | null;
  text: string | null;
  created_at: string;
}

const KINDS: Array<{ value: Kind; label: string; icon: typeof Sparkles }> = [
  { value: 'subscription', label: 'Subscriptions', icon: Sparkles },
  { value: 'gift_sub', label: 'Gift subs', icon: Gift },
  { value: 'donation', label: 'Donations', icon: HandCoins },
];
const PLACEHOLDERS: Record<Kind, string[]> = {
  subscription: ['{viewerName}', '{months}'],
  gift_sub: ['{viewerName}', '{giftCount}'],
  donation: ['{viewerName}', '{amount}'],
};
const POSITIONS: AlertPayload['position'][] = ['top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right'];
const ANIMS: AlertPayload['animation'][] = ['slide', 'pop', 'fade', 'bounce'];
const STATUS_TONE = { PENDING: 'amber', SHOWN: 'cyan', COMPLETED: 'success', FAILED: 'danger', SKIPPED: 'neutral' } as const;

/** Local preview text (the server renders the real one). */
function previewText(kind: Kind, template: string) {
  return template.replaceAll('{viewerName}', 'TrippyAlien').replaceAll('{giftCount}', '5').replaceAll('{amount}', '$10.00').replaceAll('{months}', '3');
}

export default function Alerts() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const isOwner = channel?.access === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [kind, setKind] = useState<Kind>('subscription');
  const [replay, setReplay] = useState(0);
  const q = useQuery({ queryKey: ['alert-settings', sid], enabled: !!sid, queryFn: () => get<{ settings: Record<Kind, AlertSettings> }>(`/api/channels/${sid}/alerts`) });
  const sounds = useQuery({ queryKey: ['sounds', channel?.slug, 'manage'], enabled: !!channel, queryFn: () => get<{ items: Sound[] }>(`/api/sounds?streamer=${channel!.slug}&includeInactive=true&sort=custom`) });
  const events = useQuery({ queryKey: ['alert-events', sid], enabled: !!sid, queryFn: () => get<{ items: AlertEvent[] }>(`/api/channels/${sid}/alert-events?limit=15`), refetchInterval: 10_000 });
  const [draft, setDraft] = useState<Record<Kind, AlertSettings> | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.settings);
  }, [q.data]);

  const cur = draft?.[kind];
  const orig = q.data?.settings[kind];
  const changes = useMemo(() => {
    if (!cur || !orig) return null;
    const out: Partial<AlertSettings> = {};
    for (const k of Object.keys(cur) as Array<keyof AlertSettings>) if (k !== 'kind' && JSON.stringify(cur[k]) !== JSON.stringify(orig[k])) (out as Record<string, unknown>)[k] = cur[k];
    return Object.keys(out).length ? out : null;
  }, [cur, orig]);

  const save = useMutation({
    mutationFn: () => patch<{ settings: AlertSettings }>(`/api/channels/${sid}/alerts/${kind}`, changes),
    onSuccess: (r) => {
      qc.setQueryData<{ settings: Record<Kind, AlertSettings> }>(['alert-settings', sid], (old) => old && { settings: { ...old.settings, [kind]: r.settings } });
      toast({ title: 'Alert saved', tone: 'success' });
    },
    onError,
  });
  const test = useMutation({
    mutationFn: () => post<{ overlayConnected: boolean }>(`/api/channels/${sid}/alerts/${kind}/test`),
    onSuccess: (r) => {
      toast(
        r.overlayConnected
          ? { title: 'Test alert sent', body: 'It is showing in OBS now (marked TEST).', tone: 'success' }
          : { title: 'Test alert sent — overlay offline', body: 'Add this alert’s Browser Source in OBS to see it. It will replay for 2 minutes after connecting.', tone: 'danger' },
      );
      qc.invalidateQueries({ queryKey: ['alert-events'] });
    },
    onError,
  });

  if (!sid) return null;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!draft || !cur) return <SkeletonList rows={5} />;
  const set = <K extends keyof AlertSettings>(k: K, v: AlertSettings[K]) => setDraft((d) => d && { ...d, [kind]: { ...d[kind], [k]: v } });
  const tplErr = !cur.template.trim() ? 'Template cannot be empty' : null;

  const preview: AlertPayload = {
    ...sampleAlert(kind, cur.accent_color),
    text: previewText(kind, cur.template),
    message: cur.show_message && kind === 'donation' ? 'Love the stream!' : null,
    customMessage: cur.custom_message || null,
    animation: cur.animation,
    position: cur.position,
    durationMs: cur.duration_ms,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Stream alerts"
        title="Alerts"
        subtitle="Customise the sub, gift-sub and donation alerts. Each has its own OBS Browser Source."
        actions={<ButtonLink to="/streamer/obs" icon={<MonitorPlay className="size-4" />}>OBS overlays</ButtonLink>}
      />
      <Tabs
        label="Alert type"
        value={kind}
        onChange={(k) => {
          if (changes && !window.confirm('Discard unsaved changes to this alert?')) return;
          if (changes && q.data) setDraft(q.data.settings);
          setKind(k);
        }}
        tabs={KINDS.map((k) => ({ value: k.value, label: k.label, icon: <k.icon className="size-4" /> }))}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset disabled={!isOwner} className="card space-y-4 p-5">
          <legend className="sr-only">{KINDS.find((k) => k.value === kind)!.label} alert settings</legend>
          <Switch checked={cur.enabled} onChange={(v) => set('enabled', v)} label="Show this alert" description={kind === 'donation' ? 'Only fires after the payment provider confirms the payment.' : 'Fires from verified Kick webhook events.'} />
          <Field label="Alert text" htmlFor="tpl" error={tplErr} hint={`Placeholders: ${PLACEHOLDERS[kind].join('  ')}`}>
            <Input id="tpl" value={cur.template} maxLength={120} invalid={!!tplErr} onChange={(e) => set('template', e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-1.5" aria-label="Insert placeholder">
            {PLACEHOLDERS[kind].map((p) => (
              <button key={p} type="button" className="h-8 rounded-lg border border-line px-2.5 font-mono text-xs text-muted hover:border-volt hover:text-volt" onClick={() => set('template', `${cur.template}${cur.template.endsWith(' ') ? '' : ' '}${p}`)}>
                + {p}
              </button>
            ))}
          </div>
          <Field label="Extra line (optional)" htmlFor="cm" hint="Shown under the alert, e.g. “Welcome to the crew!”">
            <Input id="cm" value={cur.custom_message} maxLength={160} onChange={(e) => set('custom_message', e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Position" htmlFor="pos">
              <Select id="pos" value={cur.position} onChange={(e) => set('position', e.target.value as AlertSettings['position'])}>
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {p.replace('-', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Animation" htmlFor="anim">
              <Select id="anim" value={cur.animation} onChange={(e) => set('animation', e.target.value as AlertSettings['animation'])}>
                {ANIMS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Field>
            <NumberField label="Duration" value={cur.duration_ms / 1000} onChange={(v) => set('duration_ms', Math.round(v * 1000))} min={2} max={60} suffix="sec" error={cur.duration_ms < 2000 || cur.duration_ms > 60000 || !Number.isFinite(cur.duration_ms) ? '2–60 seconds' : null} />
            <NumberField label="Volume" value={cur.volume} onChange={(v) => set('volume', v)} min={0} max={100} suffix="%" />
            <Field label="Sound" htmlFor="snd" hint="From your sound library">
              <Select id="snd" value={cur.sound_id ?? ''} onChange={(e) => set('sound_id', e.target.value || null)}>
                <option value="">No sound</option>
                {sounds.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Accent colour" htmlFor="acc">
              <input id="acc" type="color" value={cur.accent_color ?? '#C6FF3D'} onChange={(e) => set('accent_color', e.target.value.toUpperCase())} className="h-11 w-full cursor-pointer rounded-xl border border-line bg-canvas p-1" />
            </Field>
            {kind === 'donation' && (
              <NumberField label="Minimum amount for an alert" value={cur.min_amount_cents / 100} onChange={(v) => set('min_amount_cents', Math.round(v * 100))} min={0} step={0.5} suffix="USD" />
            )}
          </div>
          <div className="divide-y divide-line">
            <Switch checked={cur.show_avatar} onChange={(v) => set('show_avatar', v)} label="Show viewer avatar" />
            <Switch checked={cur.tts_enabled} onChange={(v) => set('tts_enabled', v)} label="Read the alert aloud (TTS)" description="Viewer names are sanitised before being spoken." />
            {kind === 'donation' && (
              <>
                <Switch checked={cur.show_message} onChange={(v) => set('show_message', v)} label="Show the donor’s message" />
                <Switch checked={cur.tts_read_message} onChange={(v) => set('tts_read_message', v)} label="Read the donor’s message aloud" disabled={!cur.tts_enabled} />
              </>
            )}
          </div>
        </fieldset>

        <div className="space-y-6">
          <section className="card overflow-hidden" aria-labelledby="pv-h">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4">
              <h2 id="pv-h" className="font-semibold">Live preview</h2>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setReplay((r) => r + 1)}>
                  Replay
                </Button>
                <Button size="sm" icon={<FlaskConical className="size-4" />} loading={test.isPending} disabled={!!changes || !cur.enabled} onClick={() => test.mutate()} title={changes ? 'Save first' : undefined}>
                  Send test to OBS
                </Button>
              </div>
            </div>
            <div className="relative flex min-h-72 bg-[repeating-conic-gradient(#15171c_0_25%,#101216_0_50%)] bg-[length:24px_24px] p-4" aria-label="Preview on a transparent background">
              <style>{ALERT_KEYFRAMES}</style>
              <div className={cx('flex flex-1', {
                'top-left': 'items-start justify-start', top: 'items-start justify-center', 'top-right': 'items-start justify-end', center: 'items-center justify-center',
                'bottom-left': 'items-end justify-start', bottom: 'items-end justify-center', 'bottom-right': 'items-end justify-end',
              }[cur.position])}>
                <div key={`${replay}-${cur.animation}`} data-alert className="origin-top scale-[.72] sm:scale-90" style={{ animation: { slide: 'alSlide 480ms cubic-bezier(.2,1,.3,1) both', pop: 'alPop 420ms cubic-bezier(.2,1.4,.4,1) both', fade: 'alFade 320ms ease-out both', bounce: 'alBounce 700ms cubic-bezier(.3,1.6,.5,1) both' }[cur.animation] }}>
                  <AlertCard a={{ ...preview, isTest: false }} brand="#C6FF3D" progressKey={replay} />
                </div>
              </div>
            </div>
            {changes && <p className="border-t border-line p-3 text-xs text-subtle">Preview shows unsaved changes. Save to use them in OBS.</p>}
          </section>

          <section className="card p-4" aria-labelledby="ev-h">
            <h2 id="ev-h" className="flex items-center gap-2 font-semibold">
              <Bell className="size-4 text-subtle" aria-hidden /> Recent alerts
            </h2>
            {events.isLoading ? (
              <SkeletonList rows={3} className="mt-3" />
            ) : !events.data?.items.length ? (
              <p className="mt-3 text-sm text-muted">No alerts yet. Send a test to check your overlay.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {events.data.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                    <Badge tone={STATUS_TONE[e.status]}>{e.status.toLowerCase()}</Badge>
                    {e.is_test && <Badge>test</Badge>}
                    <span className="min-w-0 flex-1 truncate">{e.text ?? KINDS.find((k) => k.value === e.kind)?.label}</span>
                    <span className="text-xs text-subtle">{fmtRelative(e.created_at)}</span>
                    {e.error && <p className="w-full text-xs text-amber">{e.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <SaveBar visible={!!changes} saving={save.isPending} invalid={!!tplErr || cur.duration_ms < 2000 || cur.duration_ms > 60000} onSave={() => save.mutate()} onReset={() => q.data && setDraft(q.data.settings)} />
    </div>
  );
}

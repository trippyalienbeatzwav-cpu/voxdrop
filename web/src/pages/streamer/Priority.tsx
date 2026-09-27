import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Calculator, Clock, PlayCircle, Sigma, Trophy } from 'lucide-react';
import { get, patch } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx, fmtPoints } from '../../lib/format';
import { ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Select, Switch } from '../../components/ui/Field';
import { SaveBar } from '../../components/SaveBar';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { TIER_ICONS, TIER_KEYS, TierBadge, type TierKey, type TierRow } from '../../components/priority';

interface PrioritySettings {
  enabled: boolean;
  points_weight: number;
  waiting_weight: number;
  starvation_cap_seconds: number;
  max_messages_per_viewer: number;
  refund_priority_on_reject: boolean;
  allow_vip_interrupt: boolean;
  default_tier: TierKey;
}
interface Playback {
  auto_play: boolean;
  auto_play_delay_seconds: 0 | 2 | 5 | 10;
  queue_limit: number;
  cooldown_seconds: number;
  refund_on_reject: boolean;
}
interface PriorityRes {
  settings: PrioritySettings;
  playback: Playback;
  tiers: TierRow[];
  formula: string;
}
type Draft = Omit<PriorityRes, 'formula'>;

const DELAYS = [0, 2, 5, 10] as const;

/** Mirrors server/services/priority.ts scoreItem (display only — the server computes the real order). */
function score(s: PrioritySettings, t: TierRow, points: number, waitedSec: number) {
  return 10 * t.multiplier + s.points_weight * (points / 100) + s.waiting_weight * (waitedSec / 10);
}

function diff<T extends object>(a: T, b: T) {
  const out: Partial<T> = {};
  for (const k of Object.keys(a) as Array<keyof T>) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = a[k];
  return out;
}

export default function Priority() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const isOwner = channel?.access === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const q = useQuery({ queryKey: ['priority', sid], enabled: !!sid, queryFn: () => get<PriorityRes>(`/api/channels/${sid}/priority`) });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (q.data) setDraft({ settings: q.data.settings, playback: q.data.playback, tiers: q.data.tiers });
  }, [q.data]);

  const changes = useMemo(() => {
    if (!draft || !q.data) return null;
    const settings = diff(draft.settings, q.data.settings);
    const playback = diff(draft.playback, q.data.playback);
    const tiers = draft.tiers
      .map((t) => {
        const orig = q.data!.tiers.find((o) => o.tier === t.tier)!;
        const d = diff(t, orig);
        return Object.keys(d).length ? { ...d, tier: t.tier } : null;
      })
      .filter((x): x is Partial<TierRow> & { tier: TierKey } => !!x);
    const body: Record<string, unknown> = {};
    if (Object.keys(settings).length) body.settings = settings;
    if (Object.keys(playback).length) body.playback = playback;
    if (tiers.length) body.tiers = tiers;
    return Object.keys(body).length ? body : null;
  }, [draft, q.data]);

  // Client-side validation mirrors the server's (the server re-checks everything).
  const tierErrors = useMemo(() => {
    const errs: Partial<Record<TierKey, string>> = {};
    if (!draft) return errs;
    let prev = -1;
    for (const t of draft.tiers) {
      if (!t.name.trim()) errs[t.tier] = 'Name required';
      else if (!Number.isFinite(t.min_points) || t.min_points < 0) errs[t.tier] = 'Enter a price of 0 or more';
      else if (t.min_points < prev) errs[t.tier] = 'Must cost at least as much as the tier below';
      else if (!Number.isFinite(t.multiplier) || t.multiplier < 0.1) errs[t.tier] = 'Multiplier must be 0.1 or more';
      prev = Math.max(prev, t.min_points);
    }
    return errs;
  }, [draft]);
  const invalid = Object.keys(tierErrors).length > 0 || !!(draft && !draft.tiers.find((t) => t.tier === draft.settings.default_tier)?.is_active);

  const save = useMutation({
    mutationFn: () => patch<PriorityRes>(`/api/channels/${sid}/priority`, changes),
    onSuccess: (r) => {
      qc.setQueryData(['priority', sid], r);
      qc.invalidateQueries({ queryKey: ['queue'] });
      toast({ title: 'Priority settings saved', body: 'The live queue was re-ordered with the new rules.', tone: 'success' });
    },
    onError,
  });

  if (!sid) return null;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!draft || !q.data) return <SkeletonList rows={5} />;

  const s = draft.settings;
  const setS = <K extends keyof PrioritySettings>(k: K, v: PrioritySettings[K]) => setDraft((d) => d && { ...d, settings: { ...d.settings, [k]: v } });
  const setP = <K extends keyof Playback>(k: K, v: Playback[K]) => setDraft((d) => d && { ...d, playback: { ...d.playback, [k]: v } });
  const setT = (tier: TierKey, patchT: Partial<TierRow>) => setDraft((d) => d && { ...d, tiers: d.tiers.map((t) => (t.tier === tier ? { ...t, ...patchT } : t)) });
  const tierOf = (k: TierKey) => draft.tiers.find((t) => t.tier === k)!;
  const readOnly = !isOwner;

  // Worked example: fairness preview with the current (draft) settings.
  const examples = [
    { who: 'Viewer A', tier: tierOf('NORMAL'), points: Math.max(100, tierOf('NORMAL').min_points), wait: 30 },
    { who: 'Viewer B', tier: tierOf('HIGH'), points: tierOf('HIGH').min_points, wait: 5 },
    { who: 'Viewer C', tier: tierOf('PRIORITY'), points: tierOf('PRIORITY').min_points, wait: 120 },
    { who: 'Viewer D', tier: tierOf('NORMAL'), points: Math.max(100, tierOf('NORMAL').min_points), wait: Math.min(s.starvation_cap_seconds + 10, 3600) },
  ]
    .map((e) => ({ ...e, starving: e.wait >= s.starvation_cap_seconds, score: score(s, e.tier, e.points, e.wait) }))
    .sort((a, b) => (a.starving !== b.starving ? (a.starving ? -1 : 1) : a.starving ? b.wait - a.wait : b.score - a.score));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Queue"
        title="Priority & auto-play"
        subtitle="Let viewers spend points to move up the queue — fairly. Waiting time always counts, and nobody waits forever."
      />
      {readOnly && <p className="rounded-xl border border-line bg-raised p-3 text-sm text-muted">Only the channel owner can change these settings.</p>}

      <fieldset disabled={readOnly} className="space-y-6">
        {/* Automatic playback */}
        <section className="card p-5" aria-labelledby="ap-h">
          <h2 id="ap-h" className="flex items-center gap-2 text-lg font-semibold">
            <PlayCircle className="size-5 text-volt" aria-hidden /> Automatic playback
          </h2>
          <p className="mt-1 text-sm text-muted">Approved messages play on the OBS audio overlay one after another: name announcement → viewer audio → next. Moderation is never skipped.</p>
          <div className="mt-3 divide-y divide-line">
            <Switch checked={draft.playback.auto_play} onChange={(v) => setP('auto_play', v)} label={draft.playback.auto_play ? 'Automatic playback ON' : 'Automatic playback OFF'} description="When off, messages wait in the queue until you press Play." />
            <div className="py-3">
              <div id="delay-l" className="text-sm font-medium">Delay between messages</div>
              <div className="mt-2 grid max-w-md grid-cols-4 gap-2" role="radiogroup" aria-labelledby="delay-l">
                {DELAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={draft.playback.auto_play_delay_seconds === d}
                    onClick={() => setP('auto_play_delay_seconds', d)}
                    className={cx('h-11 rounded-xl border text-sm font-semibold transition-colors', draft.playback.auto_play_delay_seconds === d ? 'border-volt bg-volt/10 text-volt' : 'border-line text-muted hover:border-line-strong hover:text-fg')}
                  >
                    {d === 0 ? 'None' : `${d}s`}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 py-3 sm:grid-cols-3">
              <NumberField label="Queue limit" value={draft.playback.queue_limit} onChange={(v) => setP('queue_limit', v)} min={1} max={1000} hint="Max waiting messages" />
              <NumberField label="Max per viewer" value={s.max_messages_per_viewer} onChange={(v) => setS('max_messages_per_viewer', v)} min={1} max={100} hint="Waiting at once, per viewer" />
              <NumberField label="Viewer cooldown" value={draft.playback.cooldown_seconds} onChange={(v) => setP('cooldown_seconds', v)} min={0} max={86400} suffix="sec" />
            </div>
          </div>
        </section>

        {/* Priority engine */}
        <section className="card p-5" aria-labelledby="pq-h">
          <h2 id="pq-h" className="flex items-center gap-2 text-lg font-semibold">
            <Trophy className="size-5 text-amber" aria-hidden /> Points-based priority
          </h2>
          <div className="mt-2 divide-y divide-line">
            <Switch checked={s.enabled} onChange={(v) => setS('enabled', v)} label="Enable priority queue" description="Off = first come, first served (tier choice hidden from viewers)." />
            <Switch checked={s.refund_priority_on_reject} onChange={(v) => setS('refund_priority_on_reject', v)} label="Refund priority points on rejection" description="Returns the priority premium when you reject a prioritized message." />
            <Switch checked={draft.playback.refund_on_reject} onChange={(v) => setP('refund_on_reject', v)} label="Refund the normal message price on rejection" />
            <div className="py-2">
              <Switch checked={s.allow_vip_interrupt} onChange={(v) => setS('allow_vip_interrupt', v)} label="Allow VIP messages to interrupt current playback" description="Default off. The interrupted message is re-queued and replays afterwards." />
              {s.allow_vip_interrupt && (
                <p className="mt-1 flex items-start gap-2 rounded-xl border border-amber/30 bg-amber/5 p-3 text-sm text-amber" role="note">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  Viewers hear their message cut off mid-play when a VIP arrives. Most streamers leave this off.
                </p>
              )}
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField label="Points weight" value={s.points_weight} onChange={(v) => setS('points_weight', v)} min={0} max={100} step={0.1} hint="Per 100 points spent" />
            <NumberField label="Waiting weight" value={s.waiting_weight} onChange={(v) => setS('waiting_weight', v)} min={0} max={100} step={0.1} hint="Per 10 seconds waited" />
            <NumberField label="Starvation cap" value={s.starvation_cap_seconds} onChange={(v) => setS('starvation_cap_seconds', v)} min={30} max={86400} suffix="sec" hint="After this, a message plays next regardless of tier" />
            <Field label="Default tier" htmlFor="deftier" hint="Pre-selected for viewers">
              <Select id="deftier" value={s.default_tier} onChange={(e) => setS('default_tier', e.target.value as TierKey)}>
                {draft.tiers.filter((t) => t.is_active).map((t) => (
                  <option key={t.tier} value={t.tier}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        {/* Tiers */}
        <section className="card p-5" aria-labelledby="tiers-h">
          <h2 id="tiers-h" className="text-lg font-semibold">Priority tiers</h2>
          <p className="mt-1 text-sm text-muted">Price is the total a viewer pays for a message at that tier (never less than the normal message price). Prices must rise with each tier.</p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {TIER_KEYS.map((k) => {
              const t = tierOf(k);
              const err = tierErrors[k];
              return (
                <div key={k} className={cx('rounded-2xl border p-4', t.is_active ? 'border-line' : 'border-dashed border-line opacity-70')} style={t.is_active ? { borderColor: `${t.color}55` } : undefined}>
                  <div className="flex items-center justify-between gap-3">
                    <TierBadge tier={k} name={t.name} color={t.color} icon={t.icon} />
                    {k === 'NORMAL' ? <span className="text-xs text-subtle">Always on</span> : (
                      <label className="flex items-center gap-2 text-sm text-muted">
                        <input type="checkbox" className="size-4 accent-[var(--color-volt)]" checked={t.is_active} onChange={(e) => setT(k, { is_active: e.target.checked })} /> Active
                      </label>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field label="Name" htmlFor={`n-${k}`}>
                      <Input id={`n-${k}`} value={t.name} maxLength={24} onChange={(e) => setT(k, { name: e.target.value })} />
                    </Field>
                    <NumberField label="Price" value={t.min_points} onChange={(v) => setT(k, { min_points: v })} min={0} suffix="pts" error={err} />
                    <NumberField label="Multiplier" value={t.multiplier} onChange={(v) => setT(k, { multiplier: v })} min={0.1} max={100} step={0.5} suffix="×" />
                    <Field label="Colour & icon" htmlFor={`c-${k}`}>
                      <div className="flex gap-2">
                        <input id={`c-${k}`} type="color" value={t.color} onChange={(e) => setT(k, { color: e.target.value.toUpperCase() })} className="h-11 w-12 shrink-0 cursor-pointer rounded-xl border border-line bg-canvas p-1" aria-label={`${t.name} colour`} />
                        <Select aria-label={`${t.name} icon`} value={t.icon} onChange={(e) => setT(k, { icon: e.target.value })}>
                          {Object.keys(TIER_ICONS).map((i) => (
                            <option key={i} value={i}>
                              {i}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </Field>
                    <NumberField label="Cooldown" value={t.cooldown_seconds} onChange={(v) => setT(k, { cooldown_seconds: v })} min={0} max={86400} suffix="sec" hint="Per viewer, this tier" />
                    <NumberField label="Daily limit" value={t.daily_limit} onChange={(v) => setT(k, { daily_limit: v })} min={0} max={1000} hint="0 = unlimited" />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </fieldset>

      {/* Formula + fairness preview */}
      <section className="card p-5" aria-labelledby="f-h">
        <h2 id="f-h" className="flex items-center gap-2 text-lg font-semibold">
          <Sigma className="size-5 text-cyan" aria-hidden /> How the order is decided
        </h2>
        <p className="mt-2 rounded-xl bg-canvas p-3 font-mono text-[13px] leading-relaxed text-muted ring-1 ring-line">{q.data.formula}</p>
        <h3 className="mt-5 flex items-center gap-2 text-sm font-semibold">
          <Calculator className="size-4 text-subtle" aria-hidden /> Example with your settings
        </h3>
        <ol className="mt-2 space-y-2">
          {examples.map((e, i) => (
            <li key={e.who} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm">
              <span className="num w-6 text-center font-bold text-subtle">{i + 1}</span>
              <span className="w-20 font-medium">{e.who}</span>
              <TierBadge tier={e.tier.tier} name={e.tier.name} color={e.tier.color} icon={e.tier.icon} />
              <span className="num text-muted">{fmtPoints(e.points)} pts</span>
              <span className="flex items-center gap-1 text-muted">
                <Clock className="size-3.5" aria-hidden /> waited {e.wait >= 60 ? `${Math.floor(e.wait / 60)}m ${e.wait % 60}s` : `${e.wait}s`}
              </span>
              <span className="num ml-auto font-semibold">{e.starving ? 'waited too long → next' : `score ${e.score.toFixed(1)}`}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-subtle">Illustration only — the server computes the live order with the same formula.</p>
      </section>

      <SaveBar
        visible={!!changes}
        saving={save.isPending}
        invalid={invalid}
        onSave={() => save.mutate()}
        onReset={() => q.data && setDraft({ settings: q.data.settings, playback: q.data.playback, tiers: q.data.tiers })}
      />
    </div>
  );
}

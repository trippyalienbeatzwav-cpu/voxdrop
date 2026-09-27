import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Megaphone, Play, Radio, Volume2 } from 'lucide-react';
import { api, ApiError, errorCopy, get, getCsrfToken, patch, post } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx } from '../../lib/format';
import { Badge } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select, Switch } from '../../components/ui/Field';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { player } from '../../components/audio/player';
import type { Settings } from './useSettings';

export const ANNOUNCE_KINDS = [
  { value: 'VOICE', label: 'Voice messages', templateKey: 'announce_template_voice' },
  { value: 'MP3', label: 'MP3 / audio clips', templateKey: 'announce_template_mp3' },
  { value: 'DONATION', label: 'Donations', templateKey: 'announce_template_donation' },
  { value: 'SOUND', label: 'Sound effects', templateKey: 'announce_template_sound' },
] as const;

const LANG_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ja: 'Japanese', ko: 'Korean', nl: 'Dutch', pl: 'Polish', ru: 'Russian', tr: 'Turkish' };
const FALLBACK_LOCALES = ['en-US', 'en-GB', 'en-AU', 'es-ES', 'es-MX', 'fr-FR', 'de-DE', 'pt-BR', 'it-IT', 'ja-JP'];

interface VoicesRes {
  provider: string;
  available: boolean;
  mock: boolean;
  voices: Array<{ id: string; name: string; locale: string; gender?: string }>;
  error: string | null;
}

export function useVoices(sid: string | undefined) {
  return useQuery({ queryKey: ['tts-voices', sid], enabled: !!sid, staleTime: 300_000, queryFn: () => get<VoicesRes>(`/api/channels/${sid}/tts/voices`) });
}

/** Plays WAV bytes returned by the preview endpoint through the shared (non-overlapping) player. */
async function playPreview(sid: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/channels/${sid}/announcements/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() ?? '' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(res.status, j?.error?.code ?? 'TTS_FAILED', j?.error?.message ?? 'Preview failed');
  }
  const url = URL.createObjectURL(await res.blob());
  player.toggle(`ann-preview-${url}`, url);
  return decodeURIComponent(res.headers.get('X-Announcement-Text') ?? '');
}

function VoicePickers({ draft, set, voices }: { draft: Settings; set: (k: string, v: string) => void; voices?: VoicesRes }) {
  const locales = useMemo(() => {
    const fromVoices = [...new Set((voices?.voices ?? []).map((v) => v.locale).filter(Boolean))];
    return fromVoices.length ? fromVoices : FALLBACK_LOCALES;
  }, [voices]);
  const locale = String(draft.announce_locale ?? 'en-US');
  const lang = locale.split('-')[0]!;
  const languages = [...new Set(locales.map((l) => l.split('-')[0]!))];
  const accents = locales.filter((l) => l.startsWith(lang));
  const voiceOptions = (voices?.voices ?? []).filter((v) => !v.locale || v.locale.startsWith(lang));
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field htmlFor="ann-lang" label="Language">
        <Select id="ann-lang" value={lang} onChange={(e) => set('announce_locale', locales.find((l) => l.startsWith(e.target.value)) ?? e.target.value)}>
          {languages.map((l) => (
            <option key={l} value={l}>
              {LANG_NAMES[l] ?? l}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor="ann-accent" label="Accent / locale">
        <Select id="ann-accent" value={locale} onChange={(e) => set('announce_locale', e.target.value)}>
          {(accents.length ? accents : [locale]).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor="ann-voice" label="Voice">
        <Select id="ann-voice" value={String(draft.announce_voice ?? '')} onChange={(e) => set('announce_voice', e.target.value)}>
          <option value="">Default voice</option>
          {voiceOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.gender ? ` · ${v.gender}` : ''}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function Slider({ id, label, value, min, max, step, onChange, format }: { id: string; label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center justify-between text-sm font-medium">
        {label} <span className="num text-muted">{format(value)}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-2 accent-[var(--color-volt)]" aria-valuetext={format(value)} />
    </div>
  );
}

/** Full settings section (Channel settings page). Edits go into the page's draft and are saved with the save bar. */
export function AnnouncementSettingsSection({ draft, set, sid }: { draft: Settings; set: (k: string, v: Settings[string]) => void; sid: string }) {
  const voices = useVoices(sid);
  const onError = useErrorToast();
  const toast = useToast();
  const [kind, setKind] = useState<(typeof ANNOUNCE_KINDS)[number]['value']>('VOICE');
  const [sample, setSample] = useState('TrippyAlien');
  const types = (draft.announce_types as string[]) ?? [];
  const allOn = ANNOUNCE_KINDS.every((k) => types.includes(k.value));
  const preview = useMutation({
    mutationFn: () =>
      playPreview(sid, {
        kind,
        viewerName: sample,
        announce_voice: draft.announce_voice,
        announce_locale: draft.announce_locale,
        announce_speed: Number(draft.announce_speed),
        [ANNOUNCE_KINDS.find((k) => k.value === kind)!.templateKey]: draft[ANNOUNCE_KINDS.find((k) => k.value === kind)!.templateKey],
      }),
    onSuccess: (text) => toast({ title: 'Previewing', body: `“${text}”`, tone: 'info', durationMs: 2500 }),
    onError,
  });
  const test = useMutation({
    mutationFn: () => post<{ text: string; overlayConnected: boolean }>(`/api/channels/${sid}/announcements/test`),
    onSuccess: (r) =>
      toast(r.overlayConnected ? { title: 'Sent to your overlay', body: `“${r.text}” (saved settings)`, tone: 'success' } : { title: 'Overlay is offline', body: 'Open your OBS Browser Source to hear stream tests.', tone: 'warning' }),
    onError,
  });
  const sampleId = useId();

  return (
    <section className="card grid gap-5 p-5 lg:grid-cols-[16rem_1fr]" aria-labelledby="ann-h">
      <div>
        <h2 id="ann-h" className="flex items-center gap-2 font-semibold">
          <Megaphone className="size-4 text-volt" aria-hidden /> Voice announcements
        </h2>
        <p className="mt-1 text-sm text-muted">Before a viewer’s audio plays, the stream hears a short spoken intro with their Kick name.</p>
        {voices.data && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone={voices.data.available ? (voices.data.mock ? 'amber' : 'success') : 'danger'}>
              TTS: {voices.data.provider}
              {voices.data.mock ? ' (dev mock — tones, not words)' : ''}
            </Badge>
          </div>
        )}
      </div>
      <div className="space-y-5">
        <Switch label="Viewer name announcements" description="When off, viewer audio plays immediately without an intro." checked={!!draft.announce_enabled} onChange={(v) => set('announce_enabled', v)} />
        <fieldset disabled={!draft.announce_enabled} className="space-y-5 disabled:opacity-50">
          <div>
            <legend className="mb-2 text-sm font-medium">Announce for</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Announcement types">
              <button type="button" aria-pressed={allOn} onClick={() => set('announce_types', allOn ? [] : ANNOUNCE_KINDS.map((k) => k.value))} className={chip(allOn)}>
                All
              </button>
              {ANNOUNCE_KINDS.map((k) => {
                const on = types.includes(k.value);
                return (
                  <button type="button" key={k.value} aria-pressed={on} onClick={() => set('announce_types', on ? types.filter((t) => t !== k.value) : [...types, k.value])} className={chip(on)}>
                    {k.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {ANNOUNCE_KINDS.map((k) => (
              <Field key={k.value} htmlFor={`tpl-${k.value}`} label={`${k.label} template`} hint="Use {viewerName} where the name goes.">
                <Input id={`tpl-${k.value}`} value={String(draft[k.templateKey] ?? '')} maxLength={120} onChange={(e) => set(k.templateKey, e.target.value)} />
              </Field>
            ))}
          </div>

          <VoicePickers draft={draft} set={(k, v) => set(k, v)} voices={voices.data} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Slider id="ann-speed" label="Speaking speed" value={Number(draft.announce_speed ?? 1)} min={0.5} max={2} step={0.05} onChange={(v) => set('announce_speed', Math.round(v * 100) / 100)} format={(v) => `${v.toFixed(2)}×`} />
            <Slider id="ann-vol" label="Announcement volume" value={Number(draft.announce_volume ?? 90)} min={0} max={100} step={1} onChange={(v) => set('announce_volume', v)} format={(v) => `${v}%`} />
          </div>

          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-canvas/60 p-4">
            <Field htmlFor={sampleId} label="Sample viewer name" className="min-w-40 flex-1">
              <Input id={sampleId} value={sample} maxLength={40} onChange={(e) => setSample(e.target.value)} />
            </Field>
            <Field htmlFor="ann-kind" label="Message type">
              <Select id="ann-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {ANNOUNCE_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="primary" icon={preview.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} disabled={preview.isPending} onClick={() => preview.mutate()}>
              Preview announcement
            </Button>
            <Button icon={<Radio className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>
              Test on stream
            </Button>
          </div>
          <p className="text-xs text-subtle">Preview uses your unsaved changes and plays here. “Test on stream” uses saved settings and plays on your OBS overlay when it’s idle. Names are sanitised; unsafe names are announced as “a viewer”.</p>
        </fieldset>
      </div>
    </section>
  );
}

const chip = (on: boolean) => cx('h-9 rounded-full border px-4 text-sm font-medium transition-colors', on ? 'border-volt bg-volt text-on-volt' : 'border-line text-muted hover:border-line-strong hover:text-fg');

/**
 * Compact live controls on the queue page. Changes apply immediately
 * (debounced), because streamers adjust these mid-stream.
 */
export function AnnouncementQuickControls() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const qc = useQueryClient();
  const onError = useErrorToast();
  const settings = useQuery({ queryKey: ['channel-settings', sid], enabled: !!sid, queryFn: () => get<{ settings: Settings }>(`/api/channels/${sid}/settings`) });
  const voices = useVoices(sid);
  const [local, setLocal] = useState<Settings>({});
  useEffect(() => {
    if (settings.data) setLocal(settings.data.settings);
  }, [settings.data]);
  const pending = useRef<Settings>({});
  const timer = useRef<number>(0);
  const save = useMutation({
    mutationFn: (p: Settings) => patch<{ settings: Settings }>(`/api/channels/${sid}/settings`, p),
    onSuccess: (r) => {
      qc.setQueryData(['channel-settings', sid], r);
      qc.invalidateQueries({ queryKey: ['queue', sid] });
    },
    onError: (err) => {
      onError(err);
      settings.refetch();
    },
  });
  const set = (k: string, v: Settings[string], delay = 500) => {
    setLocal((s) => ({ ...s, [k]: v }));
    pending.current = { ...pending.current, [k]: v };
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const p = pending.current;
      pending.current = {};
      save.mutate(p);
    }, delay);
  };
  const preview = useMutation({ mutationFn: () => playPreview(sid!, { kind: 'VOICE', viewerName: 'TrippyAlien' }), onError });
  if (!sid || channel?.access !== 'owner' || !settings.data) return null;
  const on = !!local.announce_enabled;
  return (
    <section className="card mb-6 p-4" aria-labelledby="qa-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="qa-h" className="flex items-center gap-2 text-sm font-semibold">
          <Volume2 className={cx('size-4', on ? 'text-volt' : 'text-subtle')} aria-hidden /> Name announcements
          <Badge tone={on ? 'volt' : 'neutral'}>{on ? 'ON' : 'OFF'}</Badge>
          {save.isPending && <Loader2 className="size-3.5 animate-spin text-subtle" aria-label="Saving" />}
        </h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<Play className="size-4" />} loading={preview.isPending} onClick={() => preview.mutate()} disabled={!on}>
            Preview
          </Button>
          <button type="button" role="switch" aria-checked={on} aria-label="Name announcements" onClick={() => set('announce_enabled', !on, 0)} className={cx('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors', on ? 'border-volt bg-volt' : 'border-line-strong bg-overlay')}>
            <span className={cx('inline-block size-5 rounded-full transition-transform', on ? 'translate-x-6 bg-on-volt' : 'translate-x-1 bg-muted')} />
          </button>
        </div>
      </div>
      {on && (
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Slider id="qa-vol" label="Volume" value={Number(local.announce_volume ?? 90)} min={0} max={100} step={1} onChange={(v) => set('announce_volume', v)} format={(v) => `${v}%`} />
          <Slider id="qa-speed" label="Speed" value={Number(local.announce_speed ?? 1)} min={0.5} max={2} step={0.05} onChange={(v) => set('announce_speed', Math.round(v * 100) / 100, 800)} format={(v) => `${v.toFixed(2)}×`} />
          <Field htmlFor="qa-tpl" label="Announcement">
            <Input id="qa-tpl" value={String(local.announce_template_voice ?? '')} maxLength={120} onChange={(e) => set('announce_template_voice', e.target.value, 900)} />
          </Field>
          <Field htmlFor="qa-voice" label="Voice">
            <Select id="qa-voice" value={String(local.announce_voice ?? '')} onChange={(e) => set('announce_voice', e.target.value, 0)}>
              <option value="">Default voice</option>
              {(voices.data?.voices ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </section>
  );
}

/** Generates (if needed) and plays one queue item's announcement locally for the streamer. */
export function useItemAnnouncementPreview(sid: string | undefined) {
  const onError = useErrorToast();
  return useMutation({
    mutationFn: async (itemId: string) => {
      const r = await api<{ announcement: { status: string; audioId: string | null; text: string | null } }>('POST', `/api/channels/${sid}/queue/${itemId}/announcement`, {});
      if (!r.announcement.audioId) throw new ApiError(502, 'TTS_FAILED', r.announcement.status === 'FAILED' ? 'The announcement could not be generated — the message will play without it.' : 'No announcement for this message.');
      player.toggle(r.announcement.audioId, `/api/audio/${r.announcement.audioId}/stream`);
      return r.announcement;
    },
    onError: (e) => onError(e instanceof ApiError ? e : new ApiError(500, 'TTS_FAILED', errorCopy(e).body)),
  });
}

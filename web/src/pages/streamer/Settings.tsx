import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { get, patch } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { useConfig } from '../../lib/session';
import type { Streamer } from '../../lib/types';
import { ErrorState, PageHeader, Skeleton } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Select, Switch, Textarea } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { SaveBar } from '../../components/SaveBar';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { useChannelSettings } from './useSettings';
import { AnnouncementSettingsSection } from './AnnouncementControls';

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card grid gap-5 p-5 lg:grid-cols-[16rem_1fr]">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export default function StreamerSettings() {
  const s = useChannelSettings();
  const cfg = useConfig().data;
  const [word, setWord] = useState('');
  const wordId = useId();
  if (s.q.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (s.q.error) return <ErrorState error={s.q.error} onRetry={() => s.q.refetch()} />;
  const words = (s.draft.blocked_words as string[]) ?? [];
  const invalid =
    s.num('max_points_per_message') < s.num('min_points_per_message') || s.num('donation_max_cents') < s.num('donation_min_cents') || Object.values(s.draft).some((v) => typeof v === 'number' && Number.isNaN(v));
  const addWord = () => {
    const w = word.trim().toLowerCase();
    if (w && !words.includes(w)) s.set('blocked_words', [...words, w]);
    setWord('');
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Channel settings" subtitle="Every price, limit and rule here is enforced by the server." />
      <ProfileSection />

      <Section title="Message types" description="Turn features on or off for viewers.">
        <Switch label="Text messages" checked={s.bool('text_enabled')} onChange={(v) => s.set('text_enabled', v)} />
        <Switch label="Voice messages (browser recording)" checked={s.bool('voice_enabled')} onChange={(v) => s.set('voice_enabled', v)} />
        <Switch label="MP3 / audio clip uploads" checked={s.bool('mp3_enabled')} onChange={(v) => s.set('mp3_enabled', v)} />
        <Switch label="Sound effects" checked={s.bool('sounds_enabled')} onChange={(v) => s.set('sounds_enabled', v)} />
        <Switch label="Donations" checked={s.bool('donations_enabled')} onChange={(v) => s.set('donations_enabled', v)} />
      </Section>

      <Section title="Pricing" description="Points charged per message. Sound prices are set per sound.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Text message" value={s.num('price_text')} onChange={(v) => s.set('price_text', v)} min={0} suffix="pts" />
          <NumberField label="Voice message" value={s.num('price_voice')} onChange={(v) => s.set('price_voice', v)} min={0} suffix="pts" />
          <NumberField label="MP3 / audio clip" value={s.num('price_mp3')} onChange={(v) => s.set('price_mp3', v)} min={0} suffix="pts" />
          <NumberField label="Priority boost" value={s.num('price_priority')} onChange={(v) => s.set('price_priority', v)} min={0} suffix="pts" />
          <NumberField label="Default sound price" value={s.num('sound_price_default')} onChange={(v) => s.set('sound_price_default', v)} min={0} suffix="pts" />
          <NumberField label="Free text messages per day" value={s.num('free_text_per_day')} onChange={(v) => s.set('free_text_per_day', v)} min={0} max={100} hint="Per viewer. 0 = none." />
          <NumberField label="Minimum points per message" value={s.num('min_points_per_message')} onChange={(v) => s.set('min_points_per_message', v)} min={0} suffix="pts" />
          <NumberField
            label="Maximum points per message"
            value={s.num('max_points_per_message')}
            onChange={(v) => s.set('max_points_per_message', v)}
            min={1}
            suffix="pts"
            error={s.num('max_points_per_message') < s.num('min_points_per_message') ? 'Must be ≥ the minimum' : null}
          />
        </div>
      </Section>

      <Section title="Audio limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Maximum audio length" value={s.num('max_audio_seconds')} onChange={(v) => s.set('max_audio_seconds', v)} min={3} max={300} suffix="sec" hint="Default is 60 seconds." />
          <NumberField
            label="Maximum file size"
            value={Math.round(s.num('max_file_bytes') / 1048576)}
            onChange={(v) => s.set('max_file_bytes', Math.round(v * 1048576))}
            min={1}
            max={25}
            suffix="MB"
          />
        </div>
      </Section>

      <Section title="Anti-spam" description="Per-viewer limits and a cap on how long the queue can get.">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="Cooldown per viewer" value={s.num('cooldown_seconds')} onChange={(v) => s.set('cooldown_seconds', v)} min={0} suffix="sec" />
          <NumberField label="Daily messages per viewer" value={s.num('daily_message_limit')} onChange={(v) => s.set('daily_message_limit', v)} min={0} hint="0 = unlimited" />
          <NumberField label="Queue limit" value={s.num('queue_limit')} onChange={(v) => s.set('queue_limit', v)} min={1} hint="Waiting + queued messages" />
        </div>
      </Section>

      <Section title="Moderation" description="Decide what needs your approval.">
        <Field htmlFor="approval" label="Approval mode">
          <Select id="approval" value={String(s.draft.approval_mode)} onChange={(e) => s.set('approval_mode', e.target.value)}>
            <option value="MANUAL">Manual — review every message before it airs</option>
            <option value="AUTO">Automatic — approved messages go straight to the queue</option>
          </Select>
        </Field>
        <Switch label="Moderators can approve" checked={s.bool('moderators_can_approve')} onChange={(v) => s.set('moderators_can_approve', v)} />
        <Switch label="Auto-reject blocked words" description="When off, messages with blocked words are flagged for manual review instead." checked={s.bool('auto_reject_blocked_words')} onChange={(v) => s.set('auto_reject_blocked_words', v)} />
        <Switch label="Refund points on reject" checked={s.bool('refund_on_reject')} onChange={(v) => s.set('refund_on_reject', v)} />
        <NumberField label="Expire unreviewed messages after" value={s.num('message_expiry_minutes')} onChange={(v) => s.set('message_expiry_minutes', v)} min={5} max={10080} suffix="min" hint="Expired messages are always refunded." />
        <Field htmlFor={wordId} label="Blocked words" hint="Matching is case-insensitive and catches simple tricks like s.c.a.m or 5c4m.">
          <div className="flex gap-2">
            <Input
              id={wordId}
              value={word}
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addWord();
                }
              }}
              placeholder="Add a word or phrase"
              maxLength={40}
            />
            <Button onClick={addWord} disabled={!word.trim()}>
              Add
            </Button>
          </div>
        </Field>
        {words.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Blocked words">
            {words.map((w) => (
              <li key={w} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-raised pl-3 pr-1 text-sm">
                {w}
                <button onClick={() => s.set('blocked_words', words.filter((x) => x !== w))} className="rounded p-1 text-subtle hover:text-danger" aria-label={`Remove ${w}`}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Playback & alerts" description="How the OBS overlay behaves.">
        <Switch label="Auto-queue approved messages" checked={s.bool('auto_queue_approved')} onChange={(v) => s.set('auto_queue_approved', v)} />
        <Switch label="Auto-play the next item" description="Requires the overlay to be open in OBS." checked={s.bool('auto_play')} onChange={(v) => s.set('auto_play', v)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="Gap between items" value={s.num('playback_gap_ms')} onChange={(v) => s.set('playback_gap_ms', v)} min={0} max={30000} step={250} suffix="ms" />
          <NumberField label="Volume" value={s.num('playback_volume')} onChange={(v) => s.set('playback_volume', v)} min={0} max={100} suffix="%" />
          <NumberField label="Text alert duration" value={s.num('alert_duration_ms')} onChange={(v) => s.set('alert_duration_ms', v)} min={1000} max={30000} step={500} suffix="ms" />
        </div>
        <Field htmlFor="alertstyle" label="Alert animation">
          <Select id="alertstyle" value={String(s.draft.alert_style)} onChange={(e) => s.set('alert_style', e.target.value)}>
            <option value="slide">Slide in</option>
            <option value="pop">Pop</option>
            <option value="minimal">Minimal (fade)</option>
          </Select>
        </Field>
        <Switch label="Show sender avatar" checked={s.bool('overlay_show_avatar')} onChange={(v) => s.set('overlay_show_avatar', v)} />
        <Switch label="Show points spent" checked={s.bool('overlay_show_points')} onChange={(v) => s.set('overlay_show_points', v)} />
      </Section>

      <AnnouncementSettingsSection draft={s.draft} set={s.set} sid={s.sid!} />

      <Section title="Donations" description={`Amounts in ${(cfg?.currency ?? 'usd').toUpperCase()}.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Minimum donation" value={s.num('donation_min_cents') / 100} onChange={(v) => s.set('donation_min_cents', Math.round(v * 100))} min={0.5} step={0.5} />
          <NumberField
            label="Maximum donation"
            value={s.num('donation_max_cents') / 100}
            onChange={(v) => s.set('donation_max_cents', Math.round(v * 100))}
            min={1}
            step={1}
            error={s.num('donation_max_cents') < s.num('donation_min_cents') ? 'Must be ≥ the minimum' : null}
          />
        </div>
        <Switch label="Allow voice notes with donations" checked={s.bool('donation_voice_enabled')} onChange={(v) => s.set('donation_voice_enabled', v)} />
      </Section>

      <SaveBar visible={s.isDirty} saving={s.save.isPending} onSave={() => s.save.mutate()} onReset={s.reset} invalid={invalid} />
    </div>
  );
}

function ProfileSection() {
  const { channel } = useChannel();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const q = useQuery({ queryKey: ['channel', channel?.id], enabled: !!channel, queryFn: () => get<{ channel: Streamer }>(`/api/channels/${channel!.id}`) });
  const [form, setForm] = useState({ display_name: '', bio: '', brand_color: '#C6FF3D' });
  useEffect(() => {
    if (q.data) setForm({ display_name: q.data.channel.displayName, bio: q.data.channel.bio, brand_color: q.data.channel.brandColor });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => patch(`/api/channels/${channel!.id}/profile`, form),
    onSuccess: () => {
      toast({ title: 'Channel profile saved', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['channel', channel?.id] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError,
  });
  return (
    <Section title="Public profile" description="Shown on your VoxDrop page and overlay branding.">
      <Field htmlFor="dn" label="Display name">
        <Input id="dn" value={form.display_name} maxLength={40} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
      </Field>
      <Field htmlFor="bio" label="Description">
        <Textarea id="bio" value={form.bio} maxLength={500} rows={3} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
      </Field>
      <Field htmlFor="bc" label="Brand colour" hint="Used on your profile banner and overlay accents.">
        <div className="flex items-center gap-3">
          <input id="bc" type="color" value={form.brand_color} onChange={(e) => setForm({ ...form, brand_color: e.target.value.toUpperCase() })} className="h-11 w-16 cursor-pointer rounded-lg border border-line bg-canvas" />
          <Input value={form.brand_color} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} className="num w-32" aria-label="Brand colour hex" />
        </div>
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={!/^#[0-9A-Fa-f]{6}$/.test(form.brand_color) || form.display_name.trim().length < 2}>
          Save profile
        </Button>
      </div>
    </Section>
  );
}

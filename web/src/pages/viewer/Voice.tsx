import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, FileAudio, Mic, Pause, Play, Send, Upload } from 'lucide-react';
import { ApiError, errorCopy, post, uploadWithProgress } from '../../lib/api';
import { fmtBytes, fmtDuration, fmtPoints, newIdempotencyKey } from '../../lib/format';
import { useCountdown, useQuote, useStreamer } from '../../lib/hooks';
import type { Message } from '../../lib/types';
import { Recorder } from '../../components/audio/Recorder';
import { Waveform } from '../../components/audio/Waveform';
import { decodeToMono, peaksOf } from '../../components/audio/wav';
import { player, usePlayer } from '../../components/audio/player';
import { ErrorState, PageHeader, Skeleton } from '../../components/ui/Feedback';
import { Field, Textarea } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Tabs } from '../../components/ui/Tabs';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast } from '../../components/ui/Toast';
import { SpendSummary } from '../../components/SpendSummary';
import { StreamerMini } from '../../components/StreamerMini';
import { PriorityPicker, QueuePositionCard, spendConfirmCopy, usePriorityOptions } from '../../components/QueuePriority';
import type { TierKey } from '../../components/priority';

interface AudioRes {
  audio: { id: string; durationMs: number };
}

export default function Voice() {
  const { streamer: slug } = useParams();
  const s = useStreamer(slug);
  const st = s.data?.streamer;
  const voiceOn = !!st?.features?.voice;
  const mp3On = !!st?.features?.mp3;
  const [tab, setTab] = useState<'record' | 'upload'>('record');
  useEffect(() => {
    if (st && !voiceOn && mp3On) setTab('upload');
  }, [st, voiceOn, mp3On]);
  const [caption, setCaption] = useState('');
  const [tier, setTier] = useState<TierKey | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const type = tab === 'record' ? 'VOICE' : 'MP3';
  const prio = usePriorityOptions(slug, { type });
  const priorityTier = prio.data?.enabled ? tier : null;
  const quote = useQuote(slug, { type, priorityTier }, !prio.isLoading);
  const tierOpt = prio.data?.tiers.find((t) => t.tier === priorityTier);
  const cooldown = useCountdown(quote.data?.cooldownRemaining);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const captionId = useId();

  if (s.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (s.error) return <ErrorState error={s.error} onRetry={() => s.refetch()} />;
  if (!voiceOn && !mp3On) return <ErrorState error={new ApiError(403, 'FEATURE_DISABLED', `${st!.displayName} isn’t accepting audio messages right now.`)} />;
  const streamer = st!;
  const maxSeconds = streamer.limits!.maxAudioSeconds;
  const total = quote.data?.price.total ?? 0;
  const blockedReason = !quote.data?.affordable ? 'Not enough points' : cooldown > 0 ? `Cooldown — wait ${cooldown}s` : undefined;

  /** Shared send path: confirm → upload (server validates) → create message. */
  async function sendAudio(file: Blob, filename: string, msgType: 'VOICE' | 'MP3', onProgress: (p: number) => void) {
    const ok = await confirm(spendConfirmCopy(tierOpt, total, msgType === 'VOICE' ? 'voice message' : 'audio clip', streamer.displayName, streamer.approvalMode === 'MANUAL'));
    if (!ok) throw new Error('');
    const form = new FormData();
    form.append('streamerId', streamer.id);
    form.append('purpose', 'MESSAGE');
    form.append('file', file, filename);
    try {
      const up = await uploadWithProgress<AudioRes>('/api/audio/upload', form, onProgress);
      const r = await post<{ message: Message }>('/api/messages', { streamerId: streamer.id, type: msgType, audioFileId: up.audio.id, text: caption, ...(priorityTier ? { priorityTier } : {}) }, { 'Idempotency-Key': newIdempotencyKey() });
      setCaption('');
      setSentId(r.message.id);
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['quote'] });
      qc.invalidateQueries({ queryKey: ['priority-options'] });
      return r.message;
    } catch (err) {
      const c = errorCopy(err);
      throw new Error(`${c.title}: ${c.body}`);
    }
  }

  const extras = (
    <div className="space-y-4">
      <Field htmlFor={captionId} label="Caption (optional)" hint="Shown on the overlay next to your name.">
        <Textarea id={captionId} value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} maxLength={300} placeholder="e.g. Shoutout to the squad!" />
      </Field>
      <PriorityPicker options={prio.data} loading={prio.isLoading} value={tier} onChange={setTier} />
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Send a voice message" subtitle={`Max ${maxSeconds} seconds · plays on ${streamer.displayName}’s stream`} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <StreamerMini s={streamer} />
          <Tabs
            label="Audio source"
            value={tab}
            onChange={setTab}
            tabs={[
              ...(voiceOn ? [{ value: 'record' as const, label: 'Record voice', icon: <Mic className="size-4" /> }] : []),
              ...(mp3On ? [{ value: 'upload' as const, label: 'Upload audio', icon: <Upload className="size-4" /> }] : []),
            ]}
          />
          {tab === 'record' ? (
            <Recorder
              maxSeconds={maxSeconds}
              sendLabel={<>Send voice · <span className="num">{fmtPoints(total)}</span> pts</>}
              sendDisabled={!!blockedReason}
              sendDisabledReason={blockedReason}
              onSend={async (wav, _ms, onProgress) => {
                await sendAudio(wav, 'voice-message.wav', 'VOICE', onProgress);
              }}
              sentContent={
                <div className="w-full max-w-md space-y-3">
                  {sentId && <QueuePositionCard messageId={sentId} />}
                  <p className="text-muted">We’ll notify you when {streamer.displayName} plays it.</p>
                </div>
              }
            >
              {extras}
            </Recorder>
          ) : (
            <UploadPanel maxSeconds={maxSeconds} maxBytes={streamer.limits!.maxFileBytes} total={total} disabledReason={blockedReason} extras={extras} onSend={(f, p) => sendAudio(f, f.name, 'MP3', p)} sentExtra={sentId ? <QueuePositionCard messageId={sentId} className="w-full max-w-md" /> : null} />
          )}
        </div>
        <aside className="space-y-4">
          <SpendSummary quote={quote.data} loading={quote.isLoading} cooldownLeft={cooldown} />
          <div className="card space-y-2 p-4 text-sm text-muted">
            <p className="font-semibold text-fg">Tips for a great message</p>
            <p>Speak close to the mic, keep it short and friendly, and avoid background music (copyrighted audio may be rejected).</p>
            <Link to="/history/messages" className="inline-block font-semibold text-volt hover:underline">
              Track your messages
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function UploadPanel({ maxSeconds, maxBytes, total, disabledReason, extras, onSend, sentExtra }: { maxSeconds: number; maxBytes: number; total: number; disabledReason?: string; extras: ReactNode; onSend: (f: File, onProgress: (p: number) => void) => Promise<Message>; sentExtra?: ReactNode }) {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<{ durationMs: number; peaks: number[]; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [sent, setSent] = useState<Message | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = usePlayer('upload-preview');
  const onError = useErrorToast();
  const accept = useMemo(() => '.mp3,.wav,audio/mpeg,audio/wav,audio/x-wav', []);

  useEffect(() => () => void (info?.url && URL.revokeObjectURL(info.url)), [info]);

  async function choose(f: File | undefined) {
    setError(null);
    setInfo(null);
    setFile(null);
    player.stop();
    if (!f) return;
    // Client checks are UX only — the server re-validates everything.
    const ext = f.name.toLowerCase().split('.').pop();
    if (!['mp3', 'wav'].includes(ext ?? '')) return setError('Only MP3 or WAV files are supported.');
    if (f.size > maxBytes) return setError(`File is ${fmtBytes(f.size)} — the limit is ${fmtBytes(maxBytes)}.`);
    try {
      const d = await decodeToMono(f);
      const durationMs = (d.pcm.length / d.sampleRate) * 1000;
      if (durationMs > maxSeconds * 1000 + 250) return setError(`This clip is ${fmtDuration(durationMs)} — the limit is ${maxSeconds}s. Trim it and try again.`);
      setFile(f);
      setInfo({ durationMs, peaks: peaksOf(d.pcm, 96), url: URL.createObjectURL(f) });
    } catch {
      setError('We couldn’t read this file. Is it a valid MP3 or WAV?');
    }
  }

  if (sent)
    return (
      <div className="card flex flex-col items-center gap-3 p-10 text-center">
        <CheckCircle2 className="size-12 text-success" aria-hidden />
        <h3 className="text-xl font-semibold">Audio clip sent</h3>
        {sentExtra}
        <Button
          onClick={() => {
            setSent(null);
            setFile(null);
            setInfo(null);
          }}
        >
          Send another
        </Button>
      </div>
    );

  return (
    <div className="card space-y-5 p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void choose(e.dataTransfer.files[0]);
        }}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${drag ? 'border-volt bg-volt/5' : 'border-line'}`}
      >
        <FileAudio className="size-10 text-subtle" aria-hidden />
        <div>
          <p className="font-semibold">Drop an MP3 or WAV here</p>
          <p className="text-sm text-subtle">
            Up to {maxSeconds}s · max {fmtBytes(maxBytes)}
          </p>
        </div>
        <Button onClick={() => input.current?.click()} icon={<Upload className="size-4" />}>
          Choose file
        </Button>
        <input ref={input} type="file" accept={accept} className="sr-only" aria-label="Choose an audio file" onChange={(e) => void choose(e.target.files?.[0])} />
      </div>
      {error && (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {file && info && (
        <>
          <div className="flex items-center gap-3 rounded-xl bg-canvas p-3 ring-1 ring-line">
            <button onClick={() => player.toggle('upload-preview', info.url)} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-raised ring-1 ring-line" aria-label={preview.playing ? 'Pause preview' : 'Play preview'}>
              {preview.playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <Waveform peaks={info.peaks} progress={preview.progress} height={28} />
            </div>
            <span className="num text-xs text-muted">{fmtDuration(info.durationMs)}</span>
          </div>
          {extras}
          {pct !== null && (
            <div role="progressbar" aria-label="Upload progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-overlay">
              <div className="h-full bg-volt transition-[width]" style={{ width: `${Math.max(pct, 4)}%` }} />
            </div>
          )}
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!!disabledReason}
            loading={pct !== null}
            icon={<Send className="size-4" />}
            onClick={async () => {
              setPct(0);
              try {
                setSent(await onSend(file, setPct));
              } catch (err) {
                if ((err as Error).message) onError(new ApiError(400, 'UPLOAD_FAILED', (err as Error).message));
              } finally {
                setPct(null);
              }
            }}
          >
            Send clip · <span className="num">{fmtPoints(total)}</span> pts
          </Button>
          {disabledReason && <p className="text-center text-sm text-amber">{disabledReason}</p>}
        </>
      )}
    </div>
  );
}

import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Music2, Pencil, Plus, Power, Trash2, Upload } from 'lucide-react';
import { del, errorCopy, get, patch, post, uploadWithProgress } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx, fmtPoints } from '../../lib/format';
import type { Sound } from '../../lib/types';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Select, Switch } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Modal, useConfirm } from '../../components/ui/Modal';
import { SOUND_ICON_MAP, SoundCard, SoundIcon } from '../../components/shared';
import { useErrorToast, useToast } from '../../components/ui/Toast';

const COLORS = ['#C6FF3D', '#FF3D8B', '#3DD9FF', '#B18CFF', '#FFB23D', '#3DDC84', '#FF5A5F', '#F2F4F8'];

export default function SoundsManage() {
  const { channel } = useChannel();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Sound | 'new' | null>(null);
  const q = useQuery({ queryKey: ['sounds', channel?.slug, 'manage'], enabled: !!channel, queryFn: () => get<{ items: Sound[] }>(`/api/sounds?streamer=${channel!.slug}&includeInactive=true&sort=custom`) });
  const toggle = useMutation({
    mutationFn: (s: Sound) => patch(`/api/sounds/${s.id}`, { isActive: !s.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sounds'] }),
    onError,
  });
  const remove = useMutation({
    mutationFn: (s: Sound) => del(`/api/sounds/${s.id}`),
    onSuccess: () => {
      toast({ title: 'Sound deleted', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['sounds'] });
    },
    onError,
  });
  if (!channel) return null;
  return (
    <div>
      <PageHeader
        title="Sound library"
        subtitle="Create the sound buttons your viewers can buy. Audio is validated and normalised on upload (max 15 seconds)."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add sound
          </Button>
        }
      />
      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-52 rounded-2xl" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState icon={<Music2 />} title="No sounds yet" body="Upload short clips like an air horn or applause — viewers can preview them for free and spend points to play them live." action={<Button variant="primary" onClick={() => setEditing('new')}>Add your first sound</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {q.data.items.map((s) => (
            <SoundCard
              key={s.id}
              s={s}
              extra={
                <div className="flex items-center justify-between border-t border-line pt-3">
                  <span className="num text-sm font-semibold text-volt">{fmtPoints(s.pricePoints)} pts</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Power className="size-4" />} onClick={() => toggle.mutate(s)} aria-label={`${s.isActive ? 'Disable' : 'Enable'} ${s.name}`}>
                      {s.isActive ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${s.name}`}
                      className="text-danger"
                      onClick={async () => {
                        if (await confirm({ title: `Delete “${s.name}”?`, body: 'Viewers can no longer play it. Past plays stay in history.', confirmLabel: 'Delete', tone: 'danger' })) remove.mutate(s);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              }
            />
          ))}
        </div>
      )}
      {editing && <SoundEditor sound={editing === 'new' ? null : editing} streamerId={channel.id} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SoundEditor({ sound, streamerId, onClose }: { sound: Sound | null; streamerId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const cats = useQuery({ queryKey: ['sound-categories'], queryFn: () => get<{ items: Array<{ slug: string; name: string }> }>('/api/sound-categories'), staleTime: Infinity });
  const [f, setF] = useState({
    name: sound?.name ?? '',
    description: sound?.description ?? '',
    categorySlug: sound?.category.slug ?? 'custom',
    icon: sound?.icon ?? 'volume-2',
    color: sound?.color ?? '#C6FF3D',
    pricePoints: sound?.pricePoints ?? 100,
    cooldownSeconds: sound?.cooldownSeconds ?? 30,
    dailyLimit: sound?.dailyLimit ?? 0,
    isActive: sound?.isActive ?? true,
  });
  const [audioId, setAudioId] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const descId = useId();

  async function upload(fl: File | undefined) {
    if (!fl) return;
    setUploadErr(null);
    const form = new FormData();
    form.append('streamerId', streamerId);
    form.append('purpose', 'SOUND');
    form.append('file', fl, fl.name);
    setPct(0);
    try {
      const r = await uploadWithProgress<{ audio: { id: string } }>('/api/audio/upload', form, setPct);
      setAudioId(r.audio.id);
      if (!f.name) setF((x) => ({ ...x, name: fl.name.replace(/\.[^.]+$/, '').slice(0, 40) }));
    } catch (err) {
      const c = errorCopy(err);
      setUploadErr(`${c.title}: ${c.body}`);
    } finally {
      setPct(null);
    }
  }

  const save = useMutation({
    mutationFn: () => (sound ? patch(`/api/sounds/${sound.id}`, f) : post('/api/sounds', { ...f, streamerId, audioFileId: audioId })),
    onSuccess: () => {
      toast({ title: sound ? 'Sound updated' : 'Sound created', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['sounds'] });
      onClose();
    },
    onError,
  });
  const valid = f.name.trim().length > 0 && Number.isFinite(f.pricePoints) && (sound || audioId);

  return (
    <Modal
      open
      onClose={onClose}
      title={sound ? `Edit “${sound.name}”` : 'Add a sound'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {sound ? 'Save' : 'Create sound'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!sound && (
          <div className="rounded-xl border-2 border-dashed border-line p-5 text-center">
            {audioId ? (
              <p className="text-sm text-success">Audio uploaded and validated ✓</p>
            ) : (
              <>
                <p className="text-sm text-muted">MP3 or WAV, up to 15 seconds.</p>
                <Button className="mt-3" icon={<Upload className="size-4" />} loading={pct !== null} onClick={() => file.current?.click()}>
                  {pct !== null ? `Uploading ${pct}%` : 'Choose audio file'}
                </Button>
                <input ref={file} type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" className="sr-only" aria-label="Sound audio file" onChange={(e) => void upload(e.target.files?.[0])} />
              </>
            )}
            {uploadErr && (
              <p className="mt-2 text-sm text-danger" role="alert">
                {uploadErr}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center gap-4">
          <SoundIcon icon={f.icon} color={f.color} size={56} />
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field htmlFor={nameId} label="Name">
              <Input id={nameId} value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field htmlFor="cat" label="Category">
              <Select id="cat" value={f.categorySlug} onChange={(e) => setF({ ...f, categorySlug: e.target.value })}>
                {cats.data?.items.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
        <Field htmlFor={descId} label="Description">
          <Input id={descId} value={f.description} maxLength={200} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Icon</legend>
          <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-12">
            {Object.keys(SOUND_ICON_MAP).map((ic) => {
              const C = SOUND_ICON_MAP[ic]!;
              return (
                <button key={ic} type="button" onClick={() => setF({ ...f, icon: ic })} aria-label={ic} aria-pressed={f.icon === ic} className={cx('flex aspect-square items-center justify-center rounded-lg border transition-colors', f.icon === ic ? 'border-volt bg-volt/10 text-volt' : 'border-line text-muted hover:text-fg')}>
                  <C className="size-4" aria-hidden />
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Colour</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setF({ ...f, color: c })} aria-label={`Colour ${c}`} aria-pressed={f.color === c} className={cx('size-9 rounded-full ring-2 ring-offset-2 ring-offset-surface', f.color === c ? 'ring-fg' : 'ring-transparent')} style={{ background: c }} />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="Price" value={f.pricePoints} onChange={(v) => setF({ ...f, pricePoints: v })} min={0} suffix="pts" />
          <NumberField label="Cooldown" value={f.cooldownSeconds} onChange={(v) => setF({ ...f, cooldownSeconds: v })} min={0} suffix="sec" hint="Channel-wide" />
          <NumberField label="Daily limit" value={f.dailyLimit} onChange={(v) => setF({ ...f, dailyLimit: v })} min={0} hint="0 = unlimited" />
        </div>
        <Switch label="Active" description="Inactive sounds are hidden from viewers." checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
      </div>
    </Modal>
  );
}

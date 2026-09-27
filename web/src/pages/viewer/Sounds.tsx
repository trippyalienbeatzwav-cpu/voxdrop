import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { History as HistoryIcon, Music2, Search } from 'lucide-react';
import { get, post, qs } from '../../lib/api';
import { cx, fmtPoints, newIdempotencyKey } from '../../lib/format';
import type { Sound } from '../../lib/types';
import { useStreamer } from '../../lib/hooks';
import { useMe } from '../../lib/session';
import { EmptyState, ErrorState, PageHeader, Points, Skeleton } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { SoundCard } from '../../components/shared';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { StreamerMini } from '../../components/StreamerMini';
import { StreamerPickerList } from './StreamerPicker';

export default function Sounds() {
  const [params, setParams] = useSearchParams();
  const slug = params.get('streamer') ?? undefined;
  if (!slug)
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Sound library" subtitle="Each streamer has their own soundboard. Pick a channel." />
        <StreamerPickerList mode="sounds" />
      </div>
    );
  return <Library slug={slug} params={params} setParams={setParams} />;
}

function Library({ slug, params, setParams }: { slug: string; params: URLSearchParams; setParams: (p: URLSearchParams, o?: { replace: boolean }) => void }) {
  const s = useStreamer(slug);
  const me = useMe().data;
  const category = params.get('category') ?? '';
  const sort = params.get('sort') ?? 'popular';
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const onError = useErrorToast();

  const cats = useQuery({ queryKey: ['sound-categories'], queryFn: () => get<{ items: Array<{ slug: string; name: string }> }>('/api/sound-categories'), staleTime: Infinity });
  const sounds = useQuery({
    queryKey: ['sounds', slug, category, sort],
    queryFn: () => get<{ items: Sound[] }>(`/api/sounds${qs({ streamer: slug, category, sort })}`),
    refetchInterval: 15_000, // keeps cooldowns fresh
  });
  const recent = useQuery({ queryKey: ['sounds-recent', slug], queryFn: () => get<{ items: Array<{ soundId: string }> }>(`/api/sounds/recent?streamer=${encodeURIComponent(slug)}`) });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (sounds.data?.items ?? []).filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.description.toLowerCase().includes(needle));
  }, [sounds.data, q]);
  const recentSounds = useMemo(() => (recent.data?.items ?? []).map((r) => sounds.data?.items.find((x) => x.id === r.soundId)).filter((x): x is Sound => !!x), [recent.data, sounds.data]);

  const use = useMutation({
    mutationFn: (sound: Sound) => post('/api/messages', { streamerId: s.data!.streamer.id, type: 'SOUND', soundId: sound.id }, { 'Idempotency-Key': newIdempotencyKey() }),
    onSuccess: (_r, sound) => {
      toast({ title: `“${sound.name}” sent`, body: 'It’s in the queue and will play on stream shortly.', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['sounds', slug] });
      qc.invalidateQueries({ queryKey: ['sounds-recent', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError,
  });

  async function onUse(sound: Sound) {
    const balance = me?.points ?? 0;
    const ok = await confirm({
      title: `Spend ${fmtPoints(sound.pricePoints)} points?`,
      body: (
        <>
          Play <strong className="text-fg">{sound.name}</strong> on {s.data?.streamer.displayName}’s stream. Balance: {fmtPoints(balance)} → {fmtPoints(balance - sound.pricePoints)}.
        </>
      ),
      confirmLabel: `Spend ${fmtPoints(sound.pricePoints)}`,
    });
    if (ok) use.mutate(sound);
  }

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  if (s.error) return <ErrorState error={s.error} onRetry={() => s.refetch()} />;
  const disabled = s.data && !s.data.streamer.features?.sounds;

  return (
    <div>
      <PageHeader title="Sound library" subtitle="Preview for free — spend points to play it live." actions={<Points value={me?.points ?? 0} size="lg" />} />
      {s.data && (
        <div className="mb-5">
          <StreamerMini s={s.data.streamer} />
        </div>
      )}
      {disabled ? (
        <EmptyState icon={<Music2 />} title="Sounds are turned off on this channel" />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sounds" aria-label="Search sounds" className="pl-10" />
            </div>
            <Select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort sounds" className="sm:w-48">
              <option value="popular">Popular</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="newest">Newest</option>
              <option value="name">A–Z</option>
            </Select>
          </div>
          <div className="mb-6 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Categories">
            {[{ slug: '', name: 'All' }, ...(cats.data?.items ?? [])].map((c) => (
              <button
                key={c.slug}
                onClick={() => set('category', c.slug)}
                aria-pressed={category === c.slug}
                className={cx('h-9 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors', category === c.slug ? 'border-volt bg-volt text-on-volt' : 'border-line text-muted hover:border-line-strong hover:text-fg')}
              >
                {c.name}
              </button>
            ))}
          </div>

          {recentSounds.length > 0 && !category && !q && (
            <section className="mb-8" aria-labelledby="recent-h">
              <h2 id="recent-h" className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
                <HistoryIcon className="size-4" aria-hidden /> Recently used
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {recentSounds.slice(0, 4).map((x) => (
                  <SoundCard key={x.id} s={x} onUse={() => onUse(x)} busy={use.isPending && use.variables?.id === x.id} disabled={(me?.points ?? 0) < x.pricePoints} />
                ))}
              </div>
            </section>
          )}

          {sounds.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-52 rounded-2xl" />
              ))}
            </div>
          ) : sounds.error ? (
            <ErrorState error={sounds.error} onRetry={() => sounds.refetch()} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={<Music2 />} title="No sounds here" body={q ? 'Try another search.' : 'This category is empty.'} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((x) => (
                <SoundCard key={x.id} s={x} onUse={() => onUse(x)} busy={use.isPending && use.variables?.id === x.id} disabled={(me?.points ?? 0) < x.pricePoints} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

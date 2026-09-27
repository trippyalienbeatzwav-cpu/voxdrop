import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Radio, Search } from 'lucide-react';
import { get, qs } from '../../lib/api';
import type { Streamer } from '../../lib/types';
import { StreamerCard } from '../../components/shared';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { useMe } from '../../lib/session';
import { cx } from '../../lib/format';

export default function Streamers() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const sort = params.get('sort') ?? 'popular';
  const live = params.get('live') === 'true';
  const inShell = !!useMe().data?.user;

  // Debounce search input → URL (deep-linkable filters).
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(params);
      if (q) p.set('q', q);
      else p.delete('q');
      setParams(p, { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = useInfiniteQuery({
    queryKey: ['streamers', params.get('q'), sort, live],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => get<{ items: Streamer[]; nextOffset: number | null }>(`/api/streamers${qs({ q: params.get('q'), sort, live: live || undefined, offset: pageParam, limit: 24 })}`, signal),
    getNextPageParam: (l) => l.nextOffset ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  return (
    <div className={cx(!inShell && 'mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8')}>
      <PageHeader title="Explore streamers" subtitle="Find a channel and send your first voice message." />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or Kick username" aria-label="Search streamers" className="pl-10" />
        </div>
        <Select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort streamers" className="sm:w-44">
          <option value="popular">Most active</option>
          <option value="live">Live first</option>
          <option value="new">Newest</option>
          <option value="name">A–Z</option>
        </Select>
        <Button variant={live ? 'primary' : 'secondary'} aria-pressed={live} onClick={() => set('live', live ? null : 'true')} icon={<Radio className="size-4" />}>
          Live now
        </Button>
      </div>

      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-60 rounded-2xl" />
          ))}
        </div>
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Radio />} title="No streamers found" body={params.get('q') ? 'Try a different search.' : 'No channels match these filters yet.'} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((s) => (
              <StreamerCard key={s.id} s={s} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="mt-8 flex justify-center">
              <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

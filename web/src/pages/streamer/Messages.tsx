import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Search } from 'lucide-react';
import { qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import type { Message } from '../../lib/types';
import { EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { LoadMore, MessageCard, usePaged } from '../../components/shared';

export default function Messages() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const type = params.get('type') ?? '';
  const search = params.get('q') ?? '';
  const list = usePaged<Message>(['channel-messages', sid, 'all', status, type, search], (cursor) => `/api/channels/${sid}/messages${qs({ status, type, q: search, cursor, limit: 25 })}`, !!sid);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  return (
    <div>
      <PageHeader title="Messages" subtitle="Everything viewers have sent to your channel." />
      <form
        className="mb-5 flex flex-col gap-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', q);
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => set('q', q)} placeholder="Search text or username" aria-label="Search messages" className="pl-10" />
        </div>
        <Select value={type} onChange={(e) => set('type', e.target.value)} aria-label="Type" className="sm:w-40">
          <option value="">All types</option>
          <option value="TEXT">Text</option>
          <option value="VOICE">Voice</option>
          <option value="MP3">Audio clip</option>
          <option value="SOUND">Sound</option>
        </Select>
        <Select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status" className="sm:w-40">
          <option value="">All statuses</option>
          {['PENDING', 'APPROVED', 'QUEUED', 'PLAYING', 'PLAYED', 'REJECTED', 'EXPIRED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
      </form>
      {list.isLoading ? (
        <SkeletonList />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.items.length ? (
        <EmptyState icon={<MessageSquare />} title="No messages match" />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {list.items.map((m) => (
            <MessageCard key={m.id} m={m} dense footer={m.moderatedBy ? <p className="text-xs text-subtle">Moderated by {m.moderatedBy}</p> : undefined} />
          ))}
        </div>
      )}
      <LoadMore q={list} />
    </div>
  );
}

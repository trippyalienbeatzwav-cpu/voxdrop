import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Ban, Check, Flag, Keyboard, Play, ShieldCheck, Trash2, X } from 'lucide-react';
import { useChannel } from '../../lib/channel';
import { qs } from '../../lib/api';
import type { Message } from '../../lib/types';
import { EmptyState, ErrorState, Kbd, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Button, IconButton } from '../../components/ui/Button';
import { Tabs } from '../../components/ui/Tabs';
import { LoadMore, MessageCard, usePaged } from '../../components/shared';
import { player, audioUrl } from '../../components/audio/player';
import { useStaffActions } from './staff';

type Tab = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PLAYING' | 'PLAYED' | 'FLAGGED';

export default function Moderation() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'PENDING';
  const a = useStaffActions();
  const statusParam: Partial<Record<Tab, string>> = { PENDING: 'PENDING', APPROVED: 'APPROVED,QUEUED', REJECTED: 'REJECTED', PLAYING: 'PLAYING', PLAYED: 'PLAYED' };
  const q = usePaged<Message>(
    ['channel-messages', sid, tab],
    (cursor) => `/api/channels/${sid}/messages${qs({ status: statusParam[tab], flagged: tab === 'FLAGGED' ? 'true' : undefined, cursor, limit: 25 })}`,
    !!sid,
  );
  const counts = (q.data?.pages[0] as unknown as { counts?: Record<string, number> } | undefined)?.counts;
  const [sel, setSel] = useState(0);
  const [showKeys, setShowKeys] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const items = q.items;
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, items.length - 1))), [items.length]);
  useEffect(() => setSel(0), [tab]);

  // Keyboard shortcuts for fast moderation (ignored while typing in a field or when a dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable], dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const m = items[sel];
      const key = e.key.toLowerCase();
      if (key === 'j' || key === 'arrowdown') {
        e.preventDefault();
        setSel((s) => Math.min(items.length - 1, s + 1));
      } else if (key === 'k' || key === 'arrowup') {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (key === '?') setShowKeys((v) => !v);
      else if (!m) return;
      else if (key === 'a' && m.status === 'PENDING') a.approve.mutate(m.id);
      else if (key === 'r' && ['PENDING', 'APPROVED', 'QUEUED'].includes(m.status)) a.reject.mutate({ id: m.id });
      else if (key === 'p' && m.audio) player.toggle(m.audio.id, audioUrl(m.audio.id));
      else if (key === 'f') a.flag.mutate({ id: m.id, flagged: !m.flagged });
      else if (key === 'b') void a.confirmBan(m);
      else if (key === 'd' || key === 'delete') void a.confirmDelete(m.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, sel, a]);

  useEffect(() => {
    listRef.current?.querySelectorAll('article')[sel]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel]);

  if (!sid) return null;
  return (
    <div>
      <PageHeader
        title="Moderation"
        subtitle="Review what goes on air. Pending messages are shown oldest first."
        actions={
          <Button size="sm" variant="ghost" icon={<Keyboard className="size-4" />} onClick={() => setShowKeys((v) => !v)} aria-expanded={showKeys}>
            Shortcuts
          </Button>
        }
      />
      {showKeys && (
        <div className="card mb-5 grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-4" aria-label="Keyboard shortcuts">
          {[
            ['J / ↓', 'Next'],
            ['K / ↑', 'Previous'],
            ['A', 'Approve'],
            ['R', 'Reject'],
            ['P', 'Preview audio'],
            ['F', 'Flag / unflag'],
            ['B', 'Ban sender'],
            ['D', 'Delete'],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-muted">
              <Kbd>{k}</Kbd> {v}
            </div>
          ))}
        </div>
      )}
      <Tabs
        label="Moderation queues"
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        className="mb-5"
        tabs={[
          { value: 'PENDING', label: 'Pending', count: counts?.PENDING },
          { value: 'APPROVED', label: 'Approved', count: counts ? (counts.QUEUED ?? 0) + (counts.APPROVED ?? 0) : undefined },
          { value: 'PLAYING', label: 'Playing', count: counts?.PLAYING },
          { value: 'PLAYED', label: 'Played' },
          { value: 'REJECTED', label: 'Rejected' },
          { value: 'FLAGGED', label: 'Flagged', count: counts?.FLAGGED },
        ]}
      />
      {q.isLoading ? (
        <SkeletonList />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <EmptyState icon={<ShieldCheck />} title={tab === 'PENDING' ? 'All caught up' : 'Nothing here'} body={tab === 'PENDING' ? 'New messages waiting for review will appear here instantly.' : undefined} />
      ) : (
        <div ref={listRef} className="space-y-3">
          {items.map((m, i) => (
            <MessageCard
              key={m.id}
              m={m}
              selected={i === sel}
              onSelect={() => setSel(i)}
              actions={
                <>
                  {m.status === 'PENDING' && (
                    <Button size="sm" variant="primary" icon={<Check className="size-4" />} onClick={() => a.approve.mutate(m.id)} loading={a.approve.isPending && a.approve.variables === m.id}>
                      Approve
                    </Button>
                  )}
                  {['PENDING', 'APPROVED', 'QUEUED'].includes(m.status) && (
                    <>
                      <Button size="sm" icon={<Play className="size-4" />} onClick={() => a.playNow.mutate(m.id)}>
                        Play now
                      </Button>
                      <Button size="sm" variant="danger" icon={<X className="size-4" />} onClick={() => a.reject.mutate({ id: m.id })}>
                        Reject
                      </Button>
                    </>
                  )}
                  {m.status === 'APPROVED' && (
                    <Button size="sm" onClick={() => a.queueMsg.mutate(m.id)}>
                      Queue
                    </Button>
                  )}
                  <div className="ml-auto flex gap-1">
                    <IconButton label={m.flagged ? 'Unflag' : 'Flag'} size="sm" onClick={() => a.flag.mutate({ id: m.id, flagged: !m.flagged })}>
                      <Flag className="size-4" />
                    </IconButton>
                    <IconButton label={`Ban ${m.sender.displayName}`} size="sm" tone="danger" onClick={() => a.confirmBan(m)} disabled={!m.sender.id}>
                      <Ban className="size-4" />
                    </IconButton>
                    <IconButton label="Delete message" size="sm" tone="danger" onClick={() => a.confirmDelete(m.id)} disabled={m.status === 'PLAYING'}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                </>
              }
              footer={m.moderatedBy ? <p className="text-xs text-subtle">Moderated by {m.moderatedBy}</p> : undefined}
            />
          ))}
        </div>
      )}
      <LoadMore q={q} />
    </div>
  );
}

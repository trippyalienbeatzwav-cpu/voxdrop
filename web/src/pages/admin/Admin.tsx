import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Activity, AlertTriangle, Ban, Coins, FileAudio, Flag, HandCoins, MessageSquare, Radio, RefreshCw, Search, Trash2, Users, Webhook, Wrench } from 'lucide-react';
import { del, get, post, qs } from '../../lib/api';
import { cx, fmtBytes, fmtDateTime, fmtDuration, fmtMoney, fmtPoints } from '../../lib/format';
import type { Message } from '../../lib/types';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, SkeletonList, StatCard } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Modal, useConfirm } from '../../components/ui/Modal';
import { LoadMore, MessageCard, usePaged } from '../../components/shared';
import { useErrorToast, useToast } from '../../components/ui/Toast';

const TITLES: Record<string, string> = {
  overview: 'Admin overview',
  users: 'Users',
  streamers: 'Streamers',
  messages: 'Messages',
  audio: 'Audio files',
  payments: 'Payments',
  donations: 'Donations',
  points: 'Points ledger',
  reports: 'Reports',
  bans: 'Active bans',
  webhooks: 'Webhooks',
  jobs: 'Failed jobs',
  logs: 'System logs',
};

export default function Admin() {
  const { tab = 'overview' } = useParams();
  const body: Record<string, ReactNode> = {
    overview: <Overview />,
    users: <UsersTab />,
    streamers: <StreamersTab />,
    messages: <MessagesTab />,
    audio: <AudioTab />,
    payments: <PaymentsTab />,
    donations: <DonationsTab />,
    points: <PointsTab />,
    reports: <ReportsTab />,
    bans: <BansTab />,
    webhooks: <WebhooksTab />,
    jobs: <JobsTab />,
    logs: <LogsTab />,
  };
  return (
    <div>
      <PageHeader title={TITLES[tab] ?? 'Admin'} eyebrow={<Badge tone="magenta">Admin</Badge>} />
      {body[tab] ?? <EmptyState title="Unknown section" />}
    </div>
  );
}

function useAdminMutation<T>(fn: (a: T) => Promise<unknown>, ok: string, keys: string[]) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast({ title: ok, tone: 'success' });
      keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError,
  });
}

function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  if (empty) return <EmptyState title="Nothing to show" />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-line text-xs uppercase tracking-wider text-subtle">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
const Td = ({ children, className }: { children: ReactNode; className?: string }) => <td className={cx('px-4 py-3 align-middle', className)}>{children}</td>;

function Overview() {
  const q = useQuery({ queryKey: ['admin-overview'], queryFn: () => get<{ counts: Record<string, number | string>; integrations: Record<string, string> }>('/api/admin/overview'), refetchInterval: 30_000 });
  if (q.isLoading) return <SkeletonList />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!.counts;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Users" value={c.users} icon={<Users />} tone="cyan" hint={`${c.suspended_users} suspended`} />
        <StatCard label="Streamers" value={c.streamers} icon={<Radio />} tone="magenta" />
        <StatCard label="Messages (24h)" value={c.messages_24h} icon={<MessageSquare />} />
        <StatCard label="Donations (30d)" value={fmtMoney(Number(c.donations_30d_cents))} icon={<HandCoins />} tone="magenta" />
        <StatCard label="Points outstanding" value={fmtPoints(Number(c.points_outstanding))} icon={<Coins />} />
        <StatCard label="Open reports" value={c.open_reports} icon={<Flag />} tone="amber" />
        <StatCard label="Failed webhooks" value={c.failed_webhooks} icon={<Webhook />} tone="amber" />
        <StatCard label="Failed jobs (7d)" value={c.failed_jobs_7d} icon={<Wrench />} tone="violet" />
      </div>
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">Integrations</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {Object.entries(q.data!.integrations).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-xl border border-line p-3">
              <dt className="capitalize text-muted">{k.replace(/([A-Z])/g, ' $1')}</dt>
              <dd>
                <Badge tone={v === 'mock' || v === 'none' ? 'amber' : 'success'}>{v}</Badge>
              </dd>
            </div>
          ))}
        </dl>
        {Object.values(q.data!.integrations).some((v) => v === 'mock' || v === 'none') && (
          <p className="mt-3 flex items-center gap-2 text-sm text-amber">
            <AlertTriangle className="size-4" aria-hidden /> Some integrations are mocked or disabled — production requires real Kick, payment, storage (and ideally ClamAV) configuration.
          </p>
        )}
      </section>
    </div>
  );
}

interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
  kick_username: string | null;
  points: number;
}

function UsersTab() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const list = usePaged<AdminUser>(['admin-users', applied], (cursor) => `/api/admin/users${qs({ q: applied, cursor, limit: 30 })}`);
  const [adjust, setAdjust] = useState<AdminUser | null>(null);
  const [suspend, setSuspend] = useState<AdminUser | null>(null);
  const unsuspend = useAdminMutation((id: string) => post(`/api/admin/users/${id}/unsuspend`), 'User reinstated', ['admin-users']);
  return (
    <>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q);
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or Kick name" aria-label="Search users" className="pl-10" />
        </div>
        <Button type="submit">Search</Button>
      </form>
      {list.isLoading ? (
        <SkeletonList />
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : (
        <Table head={['User', 'Role', 'Status', 'Points', 'Last login', '']} empty={!list.items.length}>
          {list.items.map((u) => (
            <tr key={u.id}>
              <Td>
                <div className="flex items-center gap-3">
                  <Avatar src={u.avatar_url} name={u.display_name} size={32} />
                  <div>
                    <div className="font-medium">{u.display_name}</div>
                    <div className="text-xs text-subtle">@{u.username} · kick: {u.kick_username ?? '—'}</div>
                  </div>
                </div>
              </Td>
              <Td>
                <Badge>{u.role.toLowerCase()}</Badge>
              </Td>
              <Td>
                <Badge tone={u.status === 'ACTIVE' ? 'success' : 'danger'}>{u.status.toLowerCase()}</Badge>
              </Td>
              <Td className="num">{fmtPoints(u.points)}</Td>
              <Td className="text-subtle">{fmtDateTime(u.last_login_at)}</Td>
              <Td className="text-right">
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setAdjust(u)}>
                    Adjust points
                  </Button>
                  {u.role !== 'ADMIN' &&
                    (u.status === 'ACTIVE' ? (
                      <Button size="sm" variant="danger" onClick={() => setSuspend(u)}>
                        Suspend
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => unsuspend.mutate(u.id)}>
                        Reinstate
                      </Button>
                    ))}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <LoadMore q={list} />
      {adjust && <AdjustModal user={adjust} onClose={() => setAdjust(null)} />}
      {suspend && <ReasonModal title={`Suspend ${suspend.display_name}?`} confirmLabel="Suspend" onClose={() => setSuspend(null)} url={`/api/admin/users/${suspend.id}/suspend`} ok="User suspended" keys={['admin-users']} />}
    </>
  );
}

function AdjustModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const m = useAdminMutation(() => post(`/api/admin/users/${user.id}/points-adjust`, { amount, reason }), 'Points adjusted', ['admin-users']);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Adjust points — ${user.display_name}`}
      description={`Current balance: ${fmtPoints(user.points)}. Recorded as POINTS_ADJUSTED in the ledger and audit log.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!amount || reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: onClose })}>
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <NumberField label="Amount (negative to deduct)" value={amount} onChange={setAmount} step={1} suffix="pts" />
        <Field htmlFor="adj-r" label="Reason">
          <Input id="adj-r" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Support ticket #…" />
        </Field>
      </div>
    </Modal>
  );
}

function ReasonModal({ title, confirmLabel, onClose, url, ok, keys, extra = {} }: { title: string; confirmLabel: string; onClose: () => void; url: string; ok: string; keys: string[]; extra?: Record<string, unknown> }) {
  const [reason, setReason] = useState('');
  const m = useAdminMutation(() => post(url, { reason, ...extra }), ok, keys);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: onClose })}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field htmlFor="rsn" label="Reason (visible in audit log)">
        <Input id="rsn" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}

function StreamersTab() {
  const q = useQuery({ queryKey: ['admin-streamers'], queryFn: () => get<{ items: Array<{ id: string; slug: string; display_name: string; avatar_url: string | null; status: string; is_live: boolean; owner_username: string; messages: number; donations_cents: number; kick_events_subscribed_at: string | null }> }>('/api/admin/streamers') });
  const [target, setTarget] = useState<{ id: string; name: string; suspend: boolean } | null>(null);
  if (q.isLoading) return <SkeletonList />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <>
      <Table head={['Channel', 'Owner', 'Status', 'Messages', 'Donations', 'Kick events', '']} empty={!q.data!.items.length}>
        {q.data!.items.map((s) => (
          <tr key={s.id}>
            <Td>
              <div className="flex items-center gap-3">
                <Avatar src={s.avatar_url} name={s.display_name} size={32} />
                <div>
                  <div className="font-medium">{s.display_name}</div>
                  <div className="text-xs text-subtle">/{s.slug}</div>
                </div>
              </div>
            </Td>
            <Td>@{s.owner_username}</Td>
            <Td>
              <Badge tone={s.status === 'ACTIVE' ? 'success' : 'danger'}>{s.status.toLowerCase()}</Badge>
            </Td>
            <Td className="num">{s.messages}</Td>
            <Td className="num">{fmtMoney(s.donations_cents)}</Td>
            <Td className="text-subtle">{s.kick_events_subscribed_at ? fmtDateTime(s.kick_events_subscribed_at) : '—'}</Td>
            <Td className="text-right">
              <Button size="sm" variant={s.status === 'ACTIVE' ? 'danger' : 'secondary'} onClick={() => setTarget({ id: s.id, name: s.display_name, suspend: s.status === 'ACTIVE' })}>
                {s.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      {target && (
        <ReasonModal
          title={`${target.suspend ? 'Suspend' : 'Reinstate'} ${target.name}?`}
          confirmLabel={target.suspend ? 'Suspend' : 'Reinstate'}
          onClose={() => setTarget(null)}
          url={`/api/admin/streamers/${target.id}/suspend`}
          extra={{ suspended: target.suspend }}
          ok="Channel updated"
          keys={['admin-streamers']}
        />
      )}
    </>
  );
}

function MessagesTab() {
  const [flagged, setFlagged] = useState(false);
  const list = usePaged<Message>(['admin-messages', flagged], (cursor) => `/api/admin/messages${qs({ flagged: flagged ? 'true' : undefined, cursor, limit: 20 })}`);
  const confirm = useConfirm();
  const remove = useAdminMutation((id: string) => del(`/api/admin/messages/${id}`), 'Message deleted', ['admin-messages']);
  return (
    <>
      <div className="mb-4">
        <Button size="sm" variant={flagged ? 'primary' : 'secondary'} aria-pressed={flagged} icon={<Flag className="size-4" />} onClick={() => setFlagged(!flagged)}>
          Flagged only
        </Button>
      </div>
      {list.isLoading ? (
        <SkeletonList />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {list.items.map((m) => (
            <MessageCard
              key={m.id}
              m={m}
              showStreamer
              dense
              actions={
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 className="size-4" />}
                  disabled={m.status === 'PLAYING'}
                  onClick={async () => {
                    if (await confirm({ title: 'Delete this content?', confirmLabel: 'Delete', tone: 'danger' })) remove.mutate(m.id);
                  }}
                >
                  Delete content
                </Button>
              }
            />
          ))}
          {!list.items.length && <EmptyState title="No messages" />}
        </div>
      )}
      <LoadMore q={list} />
    </>
  );
}

function AudioTab() {
  const list = usePaged<{ id: string; purpose: string; container: string; size_bytes: number; duration_ms: number; scan_status: string; original_filename: string; created_at: string; owner_username: string }>(['admin-audio'], (cursor) => `/api/admin/audio${qs({ cursor, limit: 30 })}`);
  const confirm = useConfirm();
  const remove = useAdminMutation((id: string) => del(`/api/admin/audio/${id}`), 'Audio deleted', ['admin-audio']);
  return (
    <>
      <Table head={['File', 'Owner', 'Purpose', 'Size', 'Length', 'AV scan', '']} empty={!list.isLoading && !list.items.length}>
        {list.items.map((a) => (
          <tr key={a.id}>
            <Td>
              <div className="flex items-center gap-2">
                <FileAudio className="size-4 text-muted" aria-hidden />
                <span className="max-w-48 truncate">{a.original_filename}</span>
                <Badge>{a.container}</Badge>
              </div>
            </Td>
            <Td>@{a.owner_username}</Td>
            <Td>{a.purpose.toLowerCase()}</Td>
            <Td className="num">{fmtBytes(a.size_bytes)}</Td>
            <Td className="num">{fmtDuration(a.duration_ms)}</Td>
            <Td>
              <Badge tone={a.scan_status === 'CLEAN' ? 'success' : 'amber'}>{a.scan_status === 'SKIPPED' ? 'not scanned' : 'clean'}</Badge>
            </Td>
            <Td className="text-right">
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                aria-label="Delete audio"
                onClick={async () => {
                  if (await confirm({ title: 'Delete this audio file?', body: 'It is removed from storage.', confirmLabel: 'Delete', tone: 'danger' })) remove.mutate(a.id);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      <LoadMore q={list} />
    </>
  );
}

function PaymentsTab() {
  const list = usePaged<{ id: string; provider: string; purpose: string; amount_cents: number; currency: string; status: string; points_amount: number | null; failure_reason: string | null; created_at: string; username: string }>(['admin-payments'], (cursor) => `/api/admin/payments${qs({ cursor, limit: 30 })}`);
  return (
    <>
      <Table head={['User', 'Purpose', 'Amount', 'Provider', 'Status', 'When']} empty={!list.isLoading && !list.items.length}>
        {list.items.map((p) => (
          <tr key={p.id}>
            <Td>@{p.username}</Td>
            <Td>{p.purpose === 'POINTS_PURCHASE' ? `Points (${fmtPoints(p.points_amount)})` : 'Donation'}</Td>
            <Td className="num">{fmtMoney(p.amount_cents, p.currency)}</Td>
            <Td>
              <Badge tone={p.provider === 'mock' ? 'amber' : 'neutral'}>{p.provider}</Badge>
            </Td>
            <Td>
              <Badge tone={p.status === 'SUCCEEDED' ? 'success' : p.status === 'CREATED' ? 'amber' : p.status === 'REFUNDED' ? 'cyan' : 'danger'}>{p.status.toLowerCase()}</Badge>
            </Td>
            <Td className="text-subtle">{fmtDateTime(p.created_at)}</Td>
          </tr>
        ))}
      </Table>
      <LoadMore q={list} />
    </>
  );
}

function DonationsTab() {
  const list = usePaged<{ id: string; amount_cents: number; currency: string; status: string; message: string; created_at: string; donor: string; streamer: string }>(['admin-donations'], (cursor) => `/api/admin/donations${qs({ cursor, limit: 30 })}`);
  return (
    <>
      <Table head={['Donor', 'Streamer', 'Amount', 'Status', 'Message', 'When']} empty={!list.isLoading && !list.items.length}>
        {list.items.map((d) => (
          <tr key={d.id}>
            <Td>@{d.donor}</Td>
            <Td>/{d.streamer}</Td>
            <Td className="num">{fmtMoney(d.amount_cents, d.currency)}</Td>
            <Td>
              <Badge tone={d.status === 'COMPLETED' ? 'success' : d.status === 'PENDING' ? 'amber' : 'danger'}>{d.status.toLowerCase()}</Badge>
            </Td>
            <Td className="max-w-64 truncate text-muted">{d.message || '—'}</Td>
            <Td className="text-subtle">{fmtDateTime(d.created_at)}</Td>
          </tr>
        ))}
      </Table>
      <LoadMore q={list} />
    </>
  );
}

function PointsTab() {
  const list = usePaged<{ id: string; type: string; amount: number; balance_after: number; description: string; created_at: string; username: string; created_by: string | null }>(['admin-points'], (cursor) => `/api/admin/points${qs({ cursor, limit: 40 })}`);
  return (
    <>
      <Table head={['User', 'Type', 'Amount', 'Balance after', 'Description', 'By', 'When']} empty={!list.isLoading && !list.items.length}>
        {list.items.map((t) => (
          <tr key={t.id}>
            <Td>@{t.username}</Td>
            <Td>
              <Badge>{t.type.replace('POINTS_', '').toLowerCase()}</Badge>
            </Td>
            <Td className={cx('num font-semibold', t.amount > 0 ? 'text-success' : '')}>{t.amount > 0 ? `+${fmtPoints(t.amount)}` : `−${fmtPoints(-t.amount)}`}</Td>
            <Td className="num">{fmtPoints(t.balance_after)}</Td>
            <Td className="max-w-64 truncate">{t.description}</Td>
            <Td className="text-subtle">{t.created_by ? `@${t.created_by}` : 'system'}</Td>
            <Td className="text-subtle">{fmtDateTime(t.created_at)}</Td>
          </tr>
        ))}
      </Table>
      <LoadMore q={list} />
    </>
  );
}

function ReportsTab() {
  const [status, setStatus] = useState('OPEN');
  const q = useQuery({ queryKey: ['admin-reports', status], queryFn: () => get<{ items: Array<{ id: string; target_type: string; target_id: string; reason: string; status: string; resolution: string | null; created_at: string; reporter: string }> }>(`/api/admin/reports?status=${status}`) });
  const resolve = useAdminMutation(({ id, st }: { id: string; st: 'RESOLVED' | 'DISMISSED' }) => post(`/api/admin/reports/${id}/resolve`, { status: st, resolution: st === 'RESOLVED' ? 'Action taken' : 'No violation' }), 'Report updated', ['admin-reports']);
  return (
    <>
      <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Report status" className="mb-4 sm:w-48">
        <option value="OPEN">Open</option>
        <option value="RESOLVED">Resolved</option>
        <option value="DISMISSED">Dismissed</option>
      </Select>
      {q.isLoading ? (
        <SkeletonList />
      ) : !q.data?.items.length ? (
        <EmptyState icon={<Flag />} title="No reports" />
      ) : (
        <ul className="space-y-3">
          {q.data.items.map((r) => (
            <li key={r.id} className="card flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  <Badge className="mr-2">{r.target_type.toLowerCase()}</Badge>
                  {r.reason}
                </p>
                <p className="num mt-1 text-xs text-subtle">
                  by @{r.reporter} · {fmtDateTime(r.created_at)} · target {r.target_id}
                </p>
              </div>
              {r.status === 'OPEN' && (
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => resolve.mutate({ id: r.id, st: 'RESOLVED' })}>
                    Resolve
                  </Button>
                  <Button size="sm" onClick={() => resolve.mutate({ id: r.id, st: 'DISMISSED' })}>
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BansTab() {
  const q = useQuery({ queryKey: ['admin-bans'], queryFn: () => get<{ items: Array<{ id: string; kind: string; reason: string; created_at: string; expires_at: string | null; username: string; streamer: string | null; created_by: string }> }>('/api/admin/bans') });
  if (q.isLoading) return <SkeletonList />;
  return (
    <Table head={['User', 'Type', 'Channel', 'Reason', 'By', 'Expires']} empty={!q.data?.items.length}>
      {q.data?.items.map((b) => (
        <tr key={b.id}>
          <Td>@{b.username}</Td>
          <Td>
            <Badge tone="danger">
              <Ban className="size-3" /> {b.kind.toLowerCase()}
            </Badge>
          </Td>
          <Td>{b.streamer ? `/${b.streamer}` : 'Platform'}</Td>
          <Td className="max-w-64 truncate">{b.reason || '—'}</Td>
          <Td>@{b.created_by}</Td>
          <Td className="text-subtle">{b.expires_at ? fmtDateTime(b.expires_at) : 'Never'}</Td>
        </tr>
      ))}
    </Table>
  );
}

function WebhooksTab() {
  const [status, setStatus] = useState('');
  const list = usePaged<{ id: string; provider: string; event_id: string; event_type: string; status: string; error: string | null; attempts: number; created_at: string; processed_at: string | null }>(['admin-webhooks', status], (cursor) => `/api/admin/webhooks${qs({ status, cursor, limit: 30 })}`);
  const retry = useAdminMutation((id: string) => post(`/api/admin/webhooks/${id}/retry`), 'Retry finished', ['admin-webhooks']);
  return (
    <>
      <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Webhook status" className="mb-4 sm:w-48">
        <option value="">All</option>
        <option value="FAILED">Failed</option>
        <option value="PROCESSED">Processed</option>
        <option value="IGNORED">Ignored</option>
        <option value="RECEIVED">Received</option>
      </Select>
      <Table head={['Provider', 'Event', 'Status', 'Attempts', 'Received', '']} empty={!list.isLoading && !list.items.length}>
        {list.items.map((w) => (
          <tr key={w.id}>
            <Td>
              <Badge>{w.provider}</Badge>
            </Td>
            <Td>
              <div className="num text-xs">{w.event_type}</div>
              <div className="num max-w-56 truncate text-[11px] text-subtle">{w.event_id}</div>
              {w.error && <div className="mt-1 max-w-72 text-xs text-danger">{w.error}</div>}
            </Td>
            <Td>
              <Badge tone={w.status === 'PROCESSED' ? 'success' : w.status === 'FAILED' ? 'danger' : 'neutral'}>{w.status.toLowerCase()}</Badge>
            </Td>
            <Td className="num">{w.attempts}</Td>
            <Td className="text-subtle">{fmtDateTime(w.created_at)}</Td>
            <Td className="text-right">
              {w.status === 'FAILED' && w.provider === 'kick' && (
                <Button size="sm" icon={<RefreshCw className="size-4" />} loading={retry.isPending && retry.variables === w.id} onClick={() => retry.mutate(w.id)}>
                  Retry
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <LoadMore q={list} />
    </>
  );
}

function JobsTab() {
  const [status, setStatus] = useState('FAILED');
  const q = useQuery({ queryKey: ['admin-jobs', status], queryFn: () => get<{ items: Array<{ id: string; kind: string; status: string; error_code: string | null; error: string | null; details: Record<string, unknown>; created_at: string; username: string }> }>(`/api/admin/jobs?status=${status}`) });
  return (
    <>
      <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Job status" className="mb-4 sm:w-48">
        <option value="FAILED">Failed</option>
        <option value="SUCCEEDED">Succeeded</option>
        <option value="RUNNING">Running</option>
      </Select>
      {q.isLoading ? (
        <SkeletonList />
      ) : (
        <Table head={['Job', 'User', 'File', 'Error', 'When']} empty={!q.data?.items.length}>
          {q.data?.items.map((j) => (
            <tr key={j.id}>
              <Td>
                <Badge tone={j.status === 'FAILED' ? 'danger' : 'success'}>{j.kind.toLowerCase().replace(/_/g, ' ')}</Badge>
              </Td>
              <Td>@{j.username}</Td>
              <Td className="max-w-48 truncate">{String(j.details.filename ?? '')}</Td>
              <Td className="max-w-72">
                {j.error_code && <div className="num text-xs text-danger">{j.error_code}</div>}
                <div className="truncate text-xs text-muted">{j.error ?? '—'}</div>
              </Td>
              <Td className="text-subtle">{fmtDateTime(j.created_at)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function LogsTab() {
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const list = usePaged<{ id: string; action: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown>; ip_hash: string | null; created_at: string; actor: string | null; streamer: string | null }>(['admin-logs', applied], (cursor) => `/api/admin/audit-logs${qs({ action: applied, cursor, limit: 40 })}`);
  return (
    <>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(action);
        }}
      >
        <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Filter by action prefix, e.g. admin. or user.ban" aria-label="Filter by action" />
        <Button type="submit" icon={<Activity className="size-4" />}>
          Filter
        </Button>
      </form>
      <Table head={['Action', 'Actor', 'Channel', 'Entity', 'Details', 'IP hash', 'When']} empty={!list.isLoading && !list.items.length}>
        {list.items.map((l) => (
          <tr key={l.id}>
            <Td>
              <span className="num text-xs">{l.action}</span>
            </Td>
            <Td>{l.actor ? `@${l.actor}` : 'system'}</Td>
            <Td>{l.streamer ? `/${l.streamer}` : '—'}</Td>
            <Td className="num text-xs text-subtle">{l.entity_type}</Td>
            <Td className="num max-w-72 truncate text-xs text-muted">{JSON.stringify(l.metadata)}</Td>
            <Td className="num text-xs text-subtle">{l.ip_hash ?? '—'}</Td>
            <Td className="text-subtle">{fmtDateTime(l.created_at)}</Td>
          </tr>
        ))}
      </Table>
      <LoadMore q={list} />
    </>
  );
}

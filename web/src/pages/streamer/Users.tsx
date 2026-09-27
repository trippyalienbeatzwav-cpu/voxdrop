import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Megaphone, MicOff, MoreHorizontal, Search, Shield, ShieldCheck, Trash2, UserPlus, Users as UsersIcon } from 'lucide-react';
import { del, get, post, qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { fmtPoints, fmtRelative } from '../../lib/format';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Field';
import { Button, IconButton } from '../../components/ui/Button';
import { Menu } from '../../components/ui/Menu';
import { Modal, useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { useStaffActions } from './staff';

interface U {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  messages: number;
  points_spent: number;
  last_message_at: string;
  restriction: 'BAN' | 'MUTE' | null;
  restriction_expires_at: string | null;
  is_moderator: boolean;
}

export default function Users() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const isOwner = channel?.access === 'owner';
  const [q, setQ] = useState('');
  const a = useStaffActions();
  const confirm = useConfirm();
  const [warnFor, setWarnFor] = useState<U | null>(null);
  const users = useQuery({ queryKey: ['channel-users', sid, q], enabled: !!sid, queryFn: () => get<{ items: U[] }>(`/api/channels/${sid}/users${qs({ q, limit: 100 })}`) });
  const mods = useQuery({ queryKey: ['channel-mods', sid], enabled: !!sid, queryFn: () => get<{ items: Array<{ id: string; username: string; display_name: string; avatar_url: string | null }> }>(`/api/channels/${sid}/moderators`) });
  const act = (u: U, action: 'mute' | 'unmute' | 'ban' | 'unban', minutes?: number) => a.userAction.mutate({ userId: u.id, action, minutes, reason: `${action} from users list` });

  return (
    <div className="space-y-8">
      <PageHeader title="Users" subtitle="Everyone who has sent something to your channel." />
      {isOwner && sid && <Moderators sid={sid} mods={mods.data?.items ?? []} />}
      <section aria-labelledby="viewers-h">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="viewers-h" className="text-lg font-semibold">
            Viewers
          </h2>
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" aria-label="Search users" className="pl-10" />
          </div>
        </div>
        {users.isLoading ? (
          <SkeletonList />
        ) : users.error ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : !users.data?.items.length ? (
          <EmptyState icon={<UsersIcon />} title="No viewers yet" />
        ) : (
          <div className="card divide-y divide-line">
            {users.data.items.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-3 p-4">
                <Avatar src={u.avatar_url} name={u.display_name} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-semibold">
                    {u.display_name}
                    {u.is_moderator && (
                      <Badge tone="cyan">
                        <Shield className="size-3" /> Mod
                      </Badge>
                    )}
                    {u.restriction && (
                      <Badge tone="danger">
                        {u.restriction === 'BAN' ? 'Banned' : 'Muted'}
                        {u.restriction_expires_at && ` · ends ${fmtRelative(u.restriction_expires_at)}`}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-subtle">
                    @{u.username} · {u.messages} messages · {fmtPoints(u.points_spent)} pts · last {fmtRelative(u.last_message_at)}
                  </p>
                </div>
                <Menu
                  label={`Actions for ${u.display_name}`}
                  trigger={(p) => (
                    <IconButton {...p} label={`Actions for ${u.display_name}`}>
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  )}
                  items={[
                    { label: 'Warn', icon: <Megaphone />, onSelect: () => setWarnFor(u) },
                    u.restriction === 'MUTE' ? { label: 'Unmute', icon: <MicOff />, onSelect: () => act(u, 'unmute') } : { label: 'Mute 10 minutes', icon: <MicOff />, onSelect: () => act(u, 'mute', 10) },
                    { label: 'Mute 1 hour', icon: <MicOff />, onSelect: () => act(u, 'mute', 60) },
                    { label: 'Mute 24 hours', icon: <MicOff />, onSelect: () => act(u, 'mute', 1440) },
                    'divider',
                    u.restriction === 'BAN'
                      ? { label: 'Unban', icon: <ShieldCheck />, onSelect: () => act(u, 'unban') }
                      : {
                          label: 'Ban',
                          icon: <Ban />,
                          tone: 'danger',
                          onSelect: async () => {
                            if (await confirm({ title: `Ban ${u.display_name}?`, confirmLabel: 'Ban', tone: 'danger' })) act(u, 'ban');
                          },
                        },
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </section>
      <WarnModal user={warnFor} onClose={() => setWarnFor(null)} onSend={(reason) => warnFor && a.userAction.mutate({ userId: warnFor.id, action: 'warn', reason })} />
    </div>
  );
}

function WarnModal({ user, onClose, onSend }: { user: U | null; onClose: () => void; onSend: (reason: string) => void }) {
  const [reason, setReason] = useState('Please keep messages on-topic and friendly.');
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Warn ${user?.display_name ?? ''}`}
      description="They receive a notification with this message."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSend(reason);
              onClose();
            }}
          >
            Send warning
          </Button>
        </>
      }
    >
      <label className="sr-only" htmlFor="warn-reason">
        Warning message
      </label>
      <Input id="warn-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
    </Modal>
  );
}

function Moderators({ sid, mods }: { sid: string; mods: Array<{ id: string; username: string; display_name: string; avatar_url: string | null }> }) {
  const [username, setUsername] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const add = useMutation({
    mutationFn: () => post(`/api/channels/${sid}/moderators`, { username }),
    onSuccess: () => {
      toast({ title: `${username} is now a moderator`, tone: 'success' });
      setUsername('');
      qc.invalidateQueries({ queryKey: ['channel-mods'] });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/channels/${sid}/moderators/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channel-mods'] }),
    onError,
  });
  return (
    <section className="card p-5" aria-labelledby="mods-h">
      <h2 id="mods-h" className="text-lg font-semibold">
        Moderators
      </h2>
      <p className="mb-4 text-sm text-muted">Moderators can review messages, run the queue and mute/ban viewers. They can’t change settings or see revenue.</p>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (username.trim()) add.mutate();
        }}
      >
        <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="VoxDrop username" aria-label="Moderator username" />
        <Button type="submit" icon={<UserPlus className="size-4" />} loading={add.isPending} disabled={!username.trim()}>
          Add
        </Button>
      </form>
      {mods.length === 0 ? (
        <p className="text-sm text-subtle">No moderators yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {mods.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded-xl border border-line py-1 pl-1 pr-1.5">
              <Avatar src={m.avatar_url} name={m.display_name} size={28} />
              <span className="text-sm font-medium">{m.display_name}</span>
              <IconButton
                label={`Remove ${m.display_name} as moderator`}
                size="sm"
                tone="danger"
                onClick={async () => {
                  if (await confirm({ title: `Remove ${m.display_name} as moderator?`, confirmLabel: 'Remove', tone: 'danger' })) remove.mutate(m.id);
                }}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

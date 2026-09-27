import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Gift } from 'lucide-react';
import { get, post, qs } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { cx, fmtDateTime, fmtPoints } from '../../lib/format';
import { Avatar, ErrorState, PageHeader, Skeleton, StatCard } from '../../components/ui/Feedback';
import { Field, Input, NumberField, Switch } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { SaveBar } from '../../components/SaveBar';
import { LoadMore, usePaged } from '../../components/shared';
import { useErrorToast, useToast } from '../../components/ui/Toast';
import { useChannelSettings } from './useSettings';

interface Row {
  id: string;
  type: string;
  amount: number;
  description: string;
  created_at: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export default function StreamerPoints() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const s = useChannelSettings();
  const ledger = usePaged<Row>(['channel-points', sid], (cursor) => `/api/channels/${sid}/points${qs({ cursor, limit: 25 })}`, !!sid);
  const totals = (ledger.data?.pages[0] as unknown as { totals?: { spent: number; rewarded: number; refunded: number } })?.totals;
  const [granting, setGranting] = useState(false);

  if (s.q.error) return <ErrorState error={s.q.error} />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Points & rewards"
        subtitle="Configure how viewers earn points on your channel. Values are applied automatically when Kick events arrive."
        actions={
          <Button icon={<Gift className="size-4" />} onClick={() => setGranting(true)}>
            Gift points to a viewer
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Points spent on your channel" value={fmtPoints(totals?.spent)} icon={<Coins />} />
        <StatCard label="Rewards paid out" value={fmtPoints(totals?.rewarded)} icon={<Gift />} tone="magenta" />
        <StatCard label="Refunded" value={fmtPoints(totals?.refunded)} icon={<Coins />} tone="cyan" />
      </div>

      {s.q.isLoading ? (
        <Skeleton className="h-80 rounded-2xl" />
      ) : (
        <section className="card p-5" aria-labelledby="rw-h">
          <h2 id="rw-h" className="text-lg font-semibold">
            Subscription rewards
          </h2>
          <p className="mb-4 text-sm text-muted">Each Kick event pays out at most once (idempotent by Kick’s event id). Viewers who haven’t joined VoxDrop yet receive rewards on first sign-in.</p>
          <Switch label="Rewards enabled" checked={s.bool('rewards_enabled')} onChange={(v) => s.set('rewards_enabled', v)} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField label="New subscription" value={s.num('sub_reward_points')} onChange={(v) => s.set('sub_reward_points', v)} min={0} suffix="pts" />
            <NumberField label="Resubscription" value={s.num('resub_reward_points')} onChange={(v) => s.set('resub_reward_points', v)} min={0} suffix="pts" />
            <NumberField label="Per gifted sub (to gifter)" value={s.num('gift_reward_points')} onChange={(v) => s.set('gift_reward_points', v)} min={0} suffix="pts" />
            <NumberField label="Multi-gift bonus" value={s.num('multi_gift_bonus_points')} onChange={(v) => s.set('multi_gift_bonus_points', v)} min={0} suffix="pts" hint={`When gifting ${s.num('multi_gift_threshold')}+ subs at once`} />
            <NumberField label="Multi-gift threshold" value={s.num('multi_gift_threshold')} onChange={(v) => s.set('multi_gift_threshold', v)} min={2} suffix="subs" />
            <NumberField label="Gift recipient reward" value={s.num('giftee_reward_points')} onChange={(v) => s.set('giftee_reward_points', v)} min={0} suffix="pts" />
            <NumberField label="Follow reward (once ever)" value={s.num('follow_reward_points')} onChange={(v) => s.set('follow_reward_points', v)} min={0} suffix="pts" />
          </div>
          <h3 className="mb-3 mt-8 font-semibold">Anti-abuse limits</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField label="Max reward per viewer per day" value={s.num('reward_daily_cap_per_user')} onChange={(v) => s.set('reward_daily_cap_per_user', v)} min={0} suffix="pts" />
            <NumberField label="Max gifts rewarded per event" value={s.num('max_gifts_rewarded_per_event')} onChange={(v) => s.set('max_gifts_rewarded_per_event', v)} min={1} suffix="subs" />
            <NumberField label="Your daily gifting cap" value={s.num('streamer_grant_daily_cap')} onChange={(v) => s.set('streamer_grant_daily_cap', v)} min={0} suffix="pts" hint="Limits manual gifts to viewers" />
          </div>
          <SaveBar visible={s.isDirty} saving={s.save.isPending} onSave={() => s.save.mutate()} onReset={s.reset} />
        </section>
      )}

      <section aria-labelledby="led-h">
        <h2 id="led-h" className="mb-3 text-lg font-semibold">
          Channel points ledger
        </h2>
        {ledger.isLoading ? (
          <Skeleton className="h-48 rounded-2xl" />
        ) : (
          <div className="card divide-y divide-line">
            {ledger.items.length === 0 && <p className="p-6 text-center text-sm text-muted">No point activity yet.</p>}
            {ledger.items.map((r) => (
              <div key={r.id} className="flex items-center gap-3 p-3.5">
                <Avatar src={r.avatar_url} name={r.display_name} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.description}</p>
                  <p className="text-xs text-subtle">
                    {r.display_name} · {fmtDateTime(r.created_at)}
                  </p>
                </div>
                <span className={cx('num text-sm font-semibold', r.amount > 0 ? 'text-success' : 'text-fg')}>
                  {r.amount > 0 ? '+' : '−'}
                  {fmtPoints(Math.abs(r.amount))}
                </span>
              </div>
            ))}
          </div>
        )}
        <LoadMore q={ledger} />
      </section>
      {sid && <GrantModal open={granting} onClose={() => setGranting(false)} sid={sid} />}
    </div>
  );
}

function GrantModal({ open, onClose, sid }: { open: boolean; onClose: () => void; sid: string }) {
  const [username, setUsername] = useState('');
  const [amount, setAmount] = useState(100);
  const [reason, setReason] = useState('');
  const uid = useId();
  const rid = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const users = useQuery({ queryKey: ['channel-users', sid, username], enabled: open && username.length >= 2, queryFn: () => get<{ items: Array<{ id: string; username: string; display_name: string }> }>(`/api/channels/${sid}/users?q=${encodeURIComponent(username)}&limit=5`) });
  const [target, setTarget] = useState<{ id: string; display_name: string } | null>(null);
  const grant = useMutation({
    mutationFn: () => post(`/api/channels/${sid}/users/${target!.id}/grant-points`, { amount, reason }),
    onSuccess: () => {
      toast({ title: `Sent ${fmtPoints(amount)} points to ${target!.display_name}`, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['channel-points'] });
      onClose();
    },
    onError,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Gift points to a viewer"
      description="Recorded in the ledger and audit log. Limited by your daily gifting cap."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!target || !amount || reason.trim().length < 3} loading={grant.isPending} onClick={() => grant.mutate()}>
            Send points
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field htmlFor={uid} label="Viewer" hint="Search viewers who have messaged your channel.">
          <Input
            id={uid}
            value={target ? target.display_name : username}
            onChange={(e) => {
              setTarget(null);
              setUsername(e.target.value);
            }}
            placeholder="Username"
            autoComplete="off"
          />
        </Field>
        {!target && !!users.data?.items.length && (
          <ul className="rounded-xl border border-line" role="listbox" aria-label="Matching viewers">
            {users.data.items.map((u) => (
              <li key={u.id}>
                <button role="option" aria-selected={false} className="w-full px-3 py-2 text-left text-sm hover:bg-raised" onClick={() => setTarget(u)}>
                  {u.display_name} <span className="text-subtle">@{u.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <NumberField label="Points" value={amount} onChange={setAmount} min={1} max={100000} suffix="pts" />
        <Field htmlFor={rid} label="Reason">
          <Input id={rid} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Won the stream giveaway" />
        </Field>
      </div>
    </Modal>
  );
}

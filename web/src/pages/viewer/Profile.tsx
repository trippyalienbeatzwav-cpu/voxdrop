import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clapperboard, ExternalLink, KeyRound, RefreshCw, ShieldOff } from 'lucide-react';
import { patch, post } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { kickLoginHref, useConfig, useMe } from '../../lib/session';
import { Avatar, Badge, PageHeader } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Button, ButtonLink } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';

export default function Profile() {
  const me = useMe().data!;
  const cfg = useConfig().data;
  const u = me.user!;
  const [displayName, setDisplayName] = useState(u.displayName);
  const [bio, setBio] = useState(u.bio);
  useEffect(() => {
    setDisplayName(u.displayName);
    setBio(u.bio);
  }, [u.displayName, u.bio]);
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const nameId = useId();
  const bioId = useId();

  const save = useMutation({
    mutationFn: () => patch('/api/me', { displayName, bio }),
    onSuccess: () => {
      toast({ title: 'Profile saved', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError,
  });
  const connect = useMutation({ mutationFn: () => post<{ url: string }>('/api/me/connect-channel'), onSuccess: (r) => window.location.assign(r.url), onError });
  const revoke = useMutation({
    mutationFn: () => post('/api/me/kick/revoke-tokens'),
    onSuccess: () => {
      toast({ title: 'Kick access revoked', tone: 'success' });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError,
  });
  const nameError = displayName.trim().length < 2 ? 'At least 2 characters' : null;
  const owns = me.channels?.find((c) => c.access === 'owner');

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Profile" subtitle="How you appear to streamers and on stream." />

      <form
        className="card space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nameError) save.mutate();
        }}
      >
        <div className="flex items-center gap-4">
          <Avatar src={u.avatarUrl} name={u.displayName} size={72} />
          <div>
            <p className="font-semibold">@{u.username}</p>
            <p className="text-sm text-subtle">Avatar is synced from Kick · member since {fmtDateTime(u.createdAt)}</p>
            <div className="mt-1.5">
              <Badge tone={u.role === 'ADMIN' ? 'magenta' : u.role === 'STREAMER' ? 'volt' : u.role === 'MODERATOR' ? 'cyan' : 'neutral'}>{u.role.toLowerCase()}</Badge>
            </div>
          </div>
        </div>
        <Field htmlFor={nameId} label="Display name" error={nameError}>
          <Input id={nameId} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} invalid={!!nameError} autoComplete="nickname" />
        </Field>
        <Field htmlFor={bioId} label="Bio" hint={`${bio.length}/300`}>
          <Textarea id={bioId} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={300} rows={3} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!!nameError}>
            Save changes
          </Button>
        </div>
      </form>

      <section className="card p-5" aria-labelledby="kick-h">
        <h2 id="kick-h" className="text-lg font-semibold">
          Connected Kick account
        </h2>
        {me.kick ? (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Avatar src={me.kick.profilePicture} name={me.kick.username} size={44} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-semibold">
                {me.kick.username} <CheckCircle2 className="size-4 text-success" aria-label="Linked" />
              </p>
              <p className="num text-xs text-subtle">Kick user #{me.kick.userId}</p>
            </div>
            <a href={kickLoginHref('/profile')} className="inline-flex h-9 items-center gap-2 rounded-xl border border-line px-3 text-sm font-semibold hover:bg-raised">
              <RefreshCw className="size-4" aria-hidden /> Refresh from Kick
            </a>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No Kick account linked.</p>
        )}
        <p className="mt-4 text-xs text-subtle">We store only your Kick user id, username and avatar. Your Kick account is your login, so it can’t be unlinked — contact support to delete your account.</p>
      </section>

      <section id="streamer" className="card scroll-mt-24 p-5" aria-labelledby="streamer-h">
        <h2 id="streamer-h" className="flex items-center gap-2 text-lg font-semibold">
          <Clapperboard className="size-5 text-volt" aria-hidden /> Streamer channel
        </h2>
        {owns ? (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Connected: <Link className="font-semibold text-fg hover:text-volt" to={`/streamer/${owns.slug}`}>kick.com/{owns.slug}</Link>
              </p>
              <ButtonLink to="/streamer/dashboard" variant="primary" size="sm">
                Open studio
              </ButtonLink>
            </div>
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-4 text-sm">
              <KeyRound className="size-4 text-muted" aria-hidden />
              <span className="flex-1">
                Kick API access: {me.kick?.channelTokens ? <strong className="text-success">active</strong> : <strong className="text-amber">not connected</strong>} — needed to receive sub & gift events.
              </span>
              {me.kick?.channelTokens ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<ShieldOff className="size-4" />}
                  loading={revoke.isPending}
                  onClick={async () => {
                    if (await confirm({ title: 'Revoke Kick access?', body: 'Sub and gift rewards stop until you reconnect.', confirmLabel: 'Revoke', tone: 'danger' })) revoke.mutate();
                  }}
                >
                  Revoke
                </Button>
              ) : (
                <Button size="sm" onClick={() => connect.mutate()} loading={connect.isPending}>
                  Reconnect
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="text-sm text-muted">Stream on Kick? Connect your channel to get a live queue, moderation tools, a soundboard, sub rewards and an OBS overlay. We’ll ask Kick for permission to read your channel and subscribe to its events.</p>
            <Button variant="primary" onClick={() => connect.mutate()} loading={connect.isPending} icon={<ExternalLink className="size-4" />}>
              Connect Kick channel
            </Button>
            {cfg?.kickMode === 'mock' && <p className="text-xs text-amber">Development mode: this uses the mock Kick consent screen.</p>}
          </div>
        )}
      </section>
    </div>
  );
}

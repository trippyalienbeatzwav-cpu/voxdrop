import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor } from 'lucide-react';
import { get, patch, post } from '../../lib/api';
import { fmtRelative } from '../../lib/format';
import { useLogout, useMe } from '../../lib/session';
import { Badge, PageHeader, SkeletonList } from '../../components/ui/Feedback';
import { Switch } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import { useErrorToast, useToast } from '../../components/ui/Toast';

export default function Settings() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const confirm = useConfirm();
  const logout = useLogout();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ items: Array<{ id: string; user_agent: string; created_at: string; last_seen_at: string; current: boolean }> }>('/api/me/sessions') });

  const motion = useMutation({
    mutationFn: (v: boolean) => patch('/api/me', { reducedMotion: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError,
  });
  const revokeOthers = useMutation({
    mutationFn: () => post<{ revoked: number }>('/api/me/sessions/revoke-others'),
    onSuccess: (r) => {
      toast({ title: `Signed out of ${r.revoked} other session(s)`, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <section className="card p-5" aria-labelledby="pref-h">
        <h2 id="pref-h" className="mb-2 text-lg font-semibold">
          Accessibility
        </h2>
        <Switch
          checked={me.user!.reducedMotion}
          onChange={(v) => motion.mutate(v)}
          disabled={motion.isPending}
          label="Reduce motion"
          description="Turns off animations and transitions everywhere in VoxDrop (your system setting is always respected too)."
        />
      </section>

      <section className="card p-5" aria-labelledby="sess-h">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="sess-h" className="text-lg font-semibold">
            Active sessions
          </h2>
          <Button
            size="sm"
            variant="danger"
            loading={revokeOthers.isPending}
            disabled={(sessions.data?.items.length ?? 0) < 2}
            onClick={async () => {
              if (await confirm({ title: 'Sign out everywhere else?', body: 'All other browsers and devices will need to sign in again.', confirmLabel: 'Sign out others', tone: 'danger' })) revokeOthers.mutate();
            }}
          >
            Sign out other devices
          </Button>
        </div>
        {sessions.isLoading ? (
          <SkeletonList rows={2} />
        ) : (
          <ul className="divide-y divide-line">
            {sessions.data?.items.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-3">
                <Monitor className="size-5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{s.user_agent || 'Unknown device'}</p>
                  <p className="text-xs text-subtle">Last active {fmtRelative(s.last_seen_at)}</p>
                </div>
                {s.current && <Badge tone="success">This device</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="text-lg font-semibold">Sign out</h2>
          <p className="text-sm text-muted">End this session on this device.</p>
        </div>
        <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={logout}>
          Log out
        </Button>
      </section>
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { FlaskConical, ShieldCheck } from 'lucide-react';
import { get, post } from '../../lib/api';
import { Avatar, Badge, ErrorState } from '../../components/ui/Feedback';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';

/**
 * ███ DEVELOPMENT ONLY ███ — stands in for Kick’s OAuth consent screen when
 * KICK_MODE=mock. The code it produces is PKCE-bound to this login attempt and
 * redeemed by the real /auth/kick/callback handler.
 */
export default function MockKick() {
  const [params] = useSearchParams();
  const state = params.get('state') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  const scope = params.get('scope') ?? '';
  const [custom, setCustom] = useState('');
  const ids = useQuery({ queryKey: ['mock-identities'], queryFn: () => get<{ items: Array<{ kick_user_id: string; kick_username: string; role: string; display_name: string; profile_picture: string | null }> }>('/api/dev/mock-kick/identities') });
  const auth = useMutation({
    mutationFn: (username: string) => post<{ redirect: string }>('/api/dev/mock-kick/authorize', { state, codeChallenge: challenge, username }),
    onSuccess: (r) => window.location.assign(r.redirect),
  });
  if (!state || !challenge) return <ErrorState className="m-6" error={new Error('Missing OAuth parameters — start from “Continue with Kick”.')} />;
  return (
    <div className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <div className="card-raised w-full max-w-lg p-6">
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-amber/30 bg-amber/10 p-3 text-sm text-amber">
          <FlaskConical className="size-5 shrink-0" aria-hidden /> Mock Kick sign-in — development only. No real Kick account is used.
        </div>
        <h1 className="text-2xl font-semibold">Authorize VoxDrop</h1>
        <p className="mt-1 text-sm text-muted">
          Requested scopes:{' '}
          {scope.split(' ').map((s) => (
            <Badge key={s} className="mr-1">
              {s}
            </Badge>
          ))}
        </p>
        <h2 className="mb-2 mt-6 text-sm font-semibold">Sign in as a demo account</h2>
        <ul className="max-h-72 space-y-1.5 overflow-y-auto">
          {ids.data?.items.map((i) => (
            <li key={i.kick_user_id}>
              <button onClick={() => auth.mutate(i.kick_username)} disabled={auth.isPending} className="flex w-full items-center gap-3 rounded-xl border border-line p-2.5 text-left transition-colors hover:border-line-strong hover:bg-overlay">
                <Avatar src={i.profile_picture} name={i.kick_username} size={36} />
                <span className="flex-1 font-medium">{i.kick_username}</span>
                <Badge tone={i.role === 'ADMIN' ? 'magenta' : i.role === 'STREAMER' ? 'volt' : i.role === 'MODERATOR' ? 'cyan' : 'neutral'}>{i.role.toLowerCase()}</Badge>
              </button>
            </li>
          ))}
          {ids.data?.items.length === 0 && <li className="text-sm text-subtle">No demo accounts. Run “npm run db:seed”, or create one below.</li>}
        </ul>
        <form
          className="mt-5 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom) auth.mutate(custom);
          }}
        >
          <Field htmlFor="mk-u" label="…or a new Kick username" className="flex-1">
            <Input id="mk-u" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} maxLength={25} placeholder="new_viewer" />
          </Field>
          <Button type="submit" variant="kick" disabled={custom.length < 3} loading={auth.isPending} icon={<ShieldCheck className="size-4" />}>
            Authorize
          </Button>
        </form>
        {auth.error && <p className="mt-3 text-sm text-danger">{(auth.error as Error).message}</p>}
      </div>
    </div>
  );
}

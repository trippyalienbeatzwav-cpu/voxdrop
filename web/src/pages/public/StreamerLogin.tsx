import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, Clapperboard, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { useConfig, useMe } from '../../lib/session';

const ERRORS: Record<string, string> = {
  kick_auth_denied: 'You cancelled the Kick sign-in. Try again whenever you’re ready.',
  kick_auth_failed: 'We couldn’t verify your Kick account. The link may have expired — please try again.',
  account_suspended: 'This account is suspended. Contact support if you think this is a mistake.',
  kick_account_mismatch: 'That Kick account is linked to a different VoxDrop user.',
  kick_no_channel: 'Your Kick account doesn’t have a channel yet. Create one on Kick, then try again.',
  kick_api_error: 'Kick didn’t respond while we fetched your channel. Please try again in a moment.',
};

/** The streamer flow requests channel + event scopes; the server verifies Kick, fetches the channel and creates the studio. */
const STREAMER_AUTH = '/auth/kick/streamer';

export default function StreamerLogin() {
  const [params] = useSearchParams();
  const me = useMe();
  const cfg = useConfig().data;
  const error = params.get('error');
  const isStreamer = (me.data?.channels ?? []).some((c) => c.access === 'owner');
  if (isStreamer && !error) return <Navigate to="/streamer/dashboard" replace />;
  return (
    <div className="grid-bg flex min-h-[calc(100dvh-4rem)] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md animate-rise">
        <div className="card-raised p-8 shadow-[var(--shadow-pop)]">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-volt/10 text-volt ring-1 ring-volt/25">
            <Clapperboard className="size-6" aria-hidden />
          </span>
          <h1 className="mt-6 text-3xl font-semibold">Streamer studio</h1>
          <p className="mt-2 text-muted">
            {me.data?.user ? `Signed in as ${me.data.user.displayName}. Connect your Kick channel to open your studio — your viewer points and history stay the same.` : 'Sign in or create your streamer account with Kick.'}
          </p>

          {error && (
            <div role="alert" className="mt-6 flex gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              <AlertTriangle className="size-5 shrink-0" aria-hidden />
              <span>{ERRORS[error] ?? 'Streamer sign-in failed. Please try again.'}</span>
            </div>
          )}

          <a href={STREAMER_AUTH} className="mt-8 flex h-14 w-full items-center justify-center gap-2.5 rounded-xl bg-kick text-base font-bold text-black shadow-[0_10px_32px_-10px_rgb(83_252_24/0.7)] transition-colors hover:bg-[#6dff3a]">
            <LogIn className="size-5" aria-hidden /> Continue with Kick
          </a>
          <a href={STREAMER_AUTH} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-line-strong text-sm font-semibold transition-colors hover:bg-raised">
            <UserPlus className="size-4" aria-hidden /> Create Streamer Account
          </a>
          <Link to={me.data?.user ? '/home' : '/'} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden /> Back to Viewer
          </Link>

          <ul className="mt-6 space-y-2.5 text-sm text-muted">
            <li className="flex gap-2.5">
              <ShieldCheck className="size-4 shrink-0 text-volt" aria-hidden /> Kick’s official OAuth — we never see your password.
            </li>
            <li className="flex gap-2.5">
              <Check className="size-4 shrink-0 text-volt" aria-hidden /> Asks for your channel and event permissions so subs and gift subs can reward viewers.
            </li>
          </ul>
          {cfg?.kickMode === 'mock' && (
            <p className="mt-6 rounded-lg border border-amber/30 bg-amber/10 p-3 text-xs text-amber">
              Development mode: this opens a <strong>mock</strong> Kick consent screen. Real streamer sign-up needs KICK_CLIENT_ID / KICK_CLIENT_SECRET and KICK_MODE=live.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

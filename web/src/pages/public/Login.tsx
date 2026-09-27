import { Navigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, LogIn, ShieldCheck } from 'lucide-react';
import { kickLoginHref, useConfig, useMe } from '../../lib/session';
import { Logo } from '../../components/layout/Brand';

const ERRORS: Record<string, string> = {
  kick_auth_denied: 'You cancelled the Kick sign-in. No problem — try again whenever you’re ready.',
  kick_auth_failed: 'We couldn’t verify your Kick account. The sign-in link may have expired — please try again.',
  account_suspended: 'This account is suspended. Contact support if you think this is a mistake.',
  kick_account_mismatch: 'That Kick account is linked to a different VoxDrop user.',
  kick_no_channel: 'Your Kick account doesn’t have a channel yet.',
  unauthorized: 'Please sign in first.',
};

export default function Login() {
  const [params] = useSearchParams();
  const me = useMe();
  const cfg = useConfig().data;
  const next = params.get('next') ?? '/home';
  const error = params.get('error');
  if (me.data?.user && !error) return <Navigate to={next.startsWith('/') ? next : '/home'} replace />;
  return (
    <div className="grid-bg flex min-h-[calc(100dvh-4rem)] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md animate-rise">
        <div className="card-raised p-8 shadow-[var(--shadow-pop)]">
          <Logo className="size-12" />
          <h1 className="mt-6 text-3xl font-semibold">Welcome to VoxDrop</h1>
          <p className="mt-2 text-muted">Sign in with your Kick account to send voice messages, sounds and support to your favourite streamers.</p>

          {error && (
            <div role="alert" className="mt-6 flex gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              <AlertTriangle className="size-5 shrink-0" aria-hidden />
              <span>{ERRORS[error] ?? 'Sign-in failed. Please try again.'}</span>
            </div>
          )}

          <a href={kickLoginHref(next)} className="mt-8 flex h-14 w-full items-center justify-center gap-2.5 rounded-xl bg-kick text-base font-bold text-black shadow-[0_10px_32px_-10px_rgb(83_252_24/0.7)] transition-colors hover:bg-[#6dff3a]">
            <LogIn className="size-5" aria-hidden /> Continue with Kick
          </a>

          <ul className="mt-6 space-y-2.5 text-sm text-muted">
            <li className="flex gap-2.5">
              <ShieldCheck className="size-4 shrink-0 text-volt" aria-hidden /> Uses Kick’s official OAuth — we never see your password.
            </li>
            <li className="flex gap-2.5">
              <Check className="size-4 shrink-0 text-volt" aria-hidden /> We only read your Kick username and avatar.
            </li>
          </ul>
          {cfg?.kickMode === 'mock' && (
            <p className="mt-6 rounded-lg border border-amber/30 bg-amber/10 p-3 text-xs text-amber">
              Development mode: this button opens a <strong>mock</strong> Kick consent screen. Real Kick sign-in needs KICK_CLIENT_ID / KICK_CLIENT_SECRET and KICK_MODE=live.
            </p>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-subtle">By continuing you agree that points have no cash value. VoxDrop is not affiliated with Kick.</p>
      </div>
    </div>
  );
}

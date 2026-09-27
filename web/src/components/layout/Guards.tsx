import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Clapperboard, ShieldOff } from 'lucide-react';
import { useMe } from '../../lib/session';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../ui/Feedback';
import { ButtonLink } from '../ui/Button';

/**
 * Client-side guards are UX only (they choose which screen to show). Every
 * protected API call is authorised again on the server.
 */
/** Skeleton of the signed-in layout shown while the account loads. */
export function ShellSkeleton() {
  return (
    <div className="min-h-dvh" aria-busy="true" aria-label="Loading your account">
      <div className="vx-backdrop" aria-hidden />
      <div className="flex gap-6 p-4 lg:p-6">
        <div className="hidden w-[270px] shrink-0 space-y-3 lg:block">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-40 rounded-[22px]" />
          <Skeleton className="h-56 rounded-[22px]" />
        </div>
        <div className="min-w-0 flex-1 space-y-8 pt-16">
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-10 w-56" />
          </div>
          <Skeleton className="h-[260px] rounded-[24px]" />
          <div className="grid gap-4 pt-6 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[132px] rounded-[22px]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children?: ReactNode }) {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <ShellSkeleton />;
  if (me.error) return <ErrorState error={me.error} onRetry={() => me.refetch()} className="m-6" />;
  if (!me.data?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return children ?? <Outlet />;
}

export function RequireStaff() {
  const me = useMe();
  if (!me.data?.channels?.length && me.data?.user?.role !== 'ADMIN')
    return (
      <EmptyState
        className="mt-6"
        icon={<Clapperboard />}
        title="Connect your Kick channel to open the studio"
        body="Streamer tools (live queue, moderation, sound library, rewards) unlock once your Kick channel is connected — or once a streamer adds you as a moderator."
        action={<ButtonLink to="/streamer/login" variant="primary">Become a Streamer</ButtonLink>}
      />
    );
  if (!me.data?.channels?.length) return <Navigate to="/admin" replace />;
  return <Outlet />;
}

export function RequireAdmin() {
  const me = useMe();
  if (me.data?.user?.role !== 'ADMIN') return <Forbidden />;
  return <Outlet />;
}

export function Forbidden() {
  return <EmptyState className="m-6" icon={<ShieldOff />} title="You don’t have access to this page" body="If you think this is a mistake, ask the channel owner or an admin." action={<ButtonLink to="/home">Back to home</ButtonLink>} />;
}

export function FullSpinner() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center">
      <Spinner />
    </div>
  );
}

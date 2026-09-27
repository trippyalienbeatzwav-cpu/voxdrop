import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { kickLoginHref, useMe } from '../../lib/session';
import { cx } from '../../lib/format';
import { Avatar, Points } from '../ui/Feedback';
import { Brand } from './Brand';
import { DevModeBanner, OfflineBanner } from './Banners';

export function PublicLayout() {
  const me = useMe().data;
  const loc = useLocation();
  useEffect(() => {
    if (!loc.hash) window.scrollTo(0, 0);
    else document.getElementById(loc.hash.slice(1))?.scrollIntoView();
  }, [loc.pathname, loc.hash]);
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only z-[200] rounded-lg bg-volt px-4 py-2 font-semibold text-on-volt focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      <OfflineBanner />
      <DevModeBanner />
      <header className="glass sticky top-0 z-40 border-b border-line">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
          <Brand />
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {[
              ['/streamers', 'Streamers'],
              ['/#how', 'How it works'],
              ['/become-streamer', 'For streamers'],
              ['/#faq', 'FAQ'],
            ].map(([to, label]) => (
              <NavLink key={to} to={to!} className={({ isActive }) => cx('rounded-lg px-3 py-2 text-sm font-medium transition-colors', isActive && to === '/streamers' ? 'text-fg' : 'text-muted hover:text-fg')}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {me?.user ? (
              <>
                <Link to="/points" className="hidden h-10 items-center rounded-xl border border-volt/20 bg-volt/5 px-3 sm:flex">
                  <Points value={me.points ?? 0} />
                </Link>
                <Link to="/home" className="flex items-center gap-2 rounded-xl p-1 pr-3 text-sm font-medium hover:bg-raised">
                  <Avatar src={me.user.avatarUrl} name={me.user.displayName} size={32} />
                  <span className="hidden sm:inline">Dashboard</span>
                </Link>
              </>
            ) : (
              <>
              <Link to="/become-streamer" className="hidden h-10 items-center rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:text-fg sm:inline-flex">
                Become a Streamer
              </Link>
              <a href={kickLoginHref('/home')} className="inline-flex h-10 items-center gap-2 rounded-xl bg-kick px-4 text-sm font-semibold text-black transition-colors hover:bg-[#6dff3a]">
                <LogIn className="size-4" aria-hidden /> Continue with Kick
              </a>
              </>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-10 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Brand />
            <span>Voice, sounds & support for Kick streams.</span>
          </div>
          <p className="max-w-md text-xs">VoxDrop is an independent product and is not affiliated with or endorsed by Kick. Points have no cash value.</p>
        </div>
      </footer>
    </div>
  );
}

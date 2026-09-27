import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AudioLines, Bell, BarChart3, Ban, BookOpen, Cable, Coins, CreditCard, FileAudio, Gauge, Gift, HandCoins, History, Home, LayoutGrid,
  ListMusic, LogOut, Menu as MenuIcon, MessageSquare, Mic, Music2, Radio, Receipt, ScrollText, Settings, Shield, ShieldAlert, Sparkles, User, Users,
  Webhook, Wrench, X, Flag, Clapperboard, Trophy, BellRing, MonitorPlay, UserCog, Crown, Star, Languages, Volume2, VolumeX, Check, ExternalLink, Search,
} from 'lucide-react';
import { get, post, qs } from '../../lib/api';
import { useConfig, useLogout, useMe } from '../../lib/session';
import { useChannel } from '../../lib/channel';
import { useRealtime } from '../../lib/realtime';
import { cx, fmtPoints, fmtRelative } from '../../lib/format';
import type { Notification, Page, Streamer } from '../../lib/types';
import { Avatar, LiveBadge, Tooltip } from '../ui/Feedback';
import { Menu } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Field';
import { setMasterVolume, useMasterVolume } from '../audio/player';
import { BuddyHead } from '../art/Mascots';
import { Brand } from './Brand';
import { DevModeBanner, OfflineBanner } from './Banners';

export type Area = 'viewer' | 'streamer' | 'admin';
interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  ownerOnly?: boolean;
  end?: boolean;
}

const I = (C: typeof Home) => <C className="size-[19px] shrink-0" aria-hidden />;

export const NAV: Record<Area, Array<{ section?: string; items: NavItem[] }>> = {
  viewer: [
    {
      items: [
        { to: '/home', label: 'Home', icon: I(Home), end: true },
        { to: '/subscriptions', label: 'My Plan', icon: I(Crown) },
        { to: '/profile', label: 'Profile', icon: I(User) },
      ],
    },
    {
      section: 'Explore',
      items: [
        { to: '/streamers', label: 'Streamers', icon: I(Radio) },
        { to: '/voice', label: 'Voice Message', icon: I(Mic) },
        { to: '/send', label: 'Text Message', icon: I(MessageSquare) },
        { to: '/messages', label: 'My Messages', icon: I(ListMusic) },
        { to: '/sounds', label: 'Sounds', icon: I(Music2) },
      ],
    },
    {
      section: 'Wallet',
      items: [
        { to: '/points', label: 'Points', icon: I(Coins) },
        { to: '/donations', label: 'Donations', icon: I(HandCoins) },
        { to: '/history', label: 'History', icon: I(Receipt), end: true },
        { to: '/settings', label: 'Settings', icon: I(Settings) },
      ],
    },
  ],
  streamer: [
    {
      items: [
        { to: '/streamer/dashboard', label: 'Overview', icon: I(Gauge) },
        { to: '/streamer/queue', label: 'Live Queue', icon: I(AudioLines) },
        { to: '/streamer/messages', label: 'Messages', icon: I(MessageSquare) },
      ],
    },
    {
      section: 'Sounds',
      items: [
        { to: '/streamer/sounds', label: 'Sound Library', icon: I(FileAudio), ownerOnly: true },
        { to: '/streamer/soundboard', label: 'Soundboard', icon: I(LayoutGrid) },
      ],
    },
    {
      section: 'Economy',
      items: [
        { to: '/streamer/points', label: 'Points', icon: I(Coins), ownerOnly: true },
        { to: '/streamer/priority', label: 'Priority', icon: I(Trophy) },
        { to: '/streamer/subscribers', label: 'Subscribers', icon: I(Users) },
        { to: '/streamer/gift-subs', label: 'Gift Subs', icon: I(Gift) },
        { to: '/streamer/donations', label: 'Donations', icon: I(HandCoins), ownerOnly: true },
      ],
    },
    {
      section: 'On stream',
      items: [
        { to: '/streamer/alerts', label: 'Alerts', icon: I(BellRing) },
        { to: '/streamer/obs', label: 'OBS Overlays', icon: I(MonitorPlay), ownerOnly: true },
      ],
    },
    {
      section: 'Channel',
      items: [
        { to: '/streamer/moderation', label: 'Moderation', icon: I(ShieldAlert) },
        { to: '/streamer/users', label: 'Viewers', icon: I(UserCog) },
        { to: '/streamer/analytics', label: 'Analytics', icon: I(BarChart3), ownerOnly: true },
        { to: '/streamer/history', label: 'History', icon: I(History) },
        { to: '/streamer/settings', label: 'Settings', icon: I(Settings), ownerOnly: true },
        { to: '/streamer/integrations', label: 'Integrations', icon: I(Cable), ownerOnly: true },
      ],
    },
  ],
  admin: [
    {
      items: [
        { to: '/admin', label: 'Overview', icon: I(Activity), end: true },
        { to: '/admin/users', label: 'Users', icon: I(Users) },
        { to: '/admin/streamers', label: 'Streamers', icon: I(Radio) },
        { to: '/admin/messages', label: 'Messages', icon: I(MessageSquare) },
        { to: '/admin/audio', label: 'Audio', icon: I(FileAudio) },
      ],
    },
    {
      section: 'Money & points',
      items: [
        { to: '/admin/payments', label: 'Payments', icon: I(CreditCard) },
        { to: '/admin/donations', label: 'Donations', icon: I(HandCoins) },
        { to: '/admin/points', label: 'Points ledger', icon: I(Coins) },
      ],
    },
    {
      section: 'Trust & safety',
      items: [
        { to: '/admin/reports', label: 'Reports', icon: I(Flag) },
        { to: '/admin/bans', label: 'Bans', icon: I(Ban) },
        { to: '/admin/webhooks', label: 'Webhooks', icon: I(Webhook) },
        { to: '/admin/jobs', label: 'Failed jobs', icon: I(Wrench) },
        { to: '/admin/logs', label: 'System logs', icon: I(ScrollText) },
      ],
    },
  ],
};

const MOBILE: Record<Area, NavItem[]> = {
  viewer: [
    { to: '/home', label: 'Home', icon: I(Home), end: true },
    { to: '/streamers', label: 'Streamers', icon: I(Radio) },
    { to: '/messages', label: 'Messages', icon: I(ListMusic) },
    { to: '/points', label: 'Points', icon: I(Coins) },
    { to: '/profile', label: 'Profile', icon: I(User) },
  ],
  streamer: [
    { to: '/streamer/dashboard', label: 'Home', icon: I(Gauge) },
    { to: '/streamer/queue', label: 'Queue', icon: I(AudioLines) },
    { to: '/streamer/moderation', label: 'Review', icon: I(ShieldAlert) },
    { to: '/streamer/alerts', label: 'Alerts', icon: I(BellRing) },
  ],
  admin: [
    { to: '/admin', label: 'Overview', icon: I(Activity), end: true },
    { to: '/admin/users', label: 'Users', icon: I(Users) },
    { to: '/admin/reports', label: 'Reports', icon: I(Flag) },
    { to: '/admin/webhooks', label: 'Webhooks', icon: I(Webhook) },
  ],
};

export const homeFor = (area: Area) => (area === 'streamer' ? '/streamer/dashboard' : area === 'admin' ? '/admin' : '/home');

/** `rail` = tablet icon-only sidebar (labels stay available to screen readers and as tooltips). */
function SideNav({ area, onNavigate, rail }: { area: Area; onNavigate?: () => void; rail?: boolean }) {
  const { channel } = useChannel();
  const isOwner = area !== 'streamer' || channel?.access === 'owner';
  return (
    <nav aria-label={`${area} navigation`} className="flex flex-col gap-3">
      {NAV[area].map((group, gi) => (
        <div key={gi} className="panel p-2">
          {group.section && <div className={cx('label-caps mb-1 px-3 pt-1 text-white/45', rail && 'lg:block hidden')}>{group.section}</div>}
          <ul className="flex flex-col gap-1">
            {group.items
              .filter((i) => !i.ownerOnly || isOwner)
              .map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    title={rail ? item.label : undefined}
                    className={({ isActive }) =>
                      cx(
                        'group flex h-11 items-center gap-3 rounded-2xl px-3 font-display text-[17px] font-bold tracking-[0.02em] transition-[background-color,color,box-shadow] duration-200',
                        rail && 'justify-center lg:justify-start',
                        isActive ? 'bg-volt text-on-volt shadow-[0_6px_24px_-8px_rgb(255_212_59/0.7)]' : 'text-white/80 hover:bg-white/[0.07] hover:text-white',
                      )
                    }
                  >
                    {item.icon}
                    <span className={cx(rail && 'sr-only lg:not-sr-only')}>{item.label}</span>
                  </NavLink>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The one account can switch between viewer, studio and admin views (no duplicate accounts). */
function AreaSwitch({ area }: { area: Area }) {
  const me = useMe().data;
  const hasChannels = (me?.channels?.length ?? 0) > 0;
  const isAdmin = me?.user?.role === 'ADMIN';
  if (!hasChannels && !isAdmin) return null;
  const opts: Array<[Area, string, string]> = [['viewer', 'Viewer', '/home']];
  if (hasChannels) opts.push(['streamer', 'Streamer', '/streamer/dashboard']);
  if (isAdmin) opts.push(['admin', 'Admin', '/admin']);
  return (
    <div className="panel grid p-1" style={{ gridTemplateColumns: `repeat(${opts.length}, 1fr)` }} role="group" aria-label="Switch mode">
      {opts.map(([a, label, to]) => (
        <Link key={a} to={to} aria-current={a === area ? 'page' : undefined} className={cx('rounded-xl py-2 text-center font-display text-sm font-bold uppercase tracking-wide transition-colors', a === area ? 'bg-white/10 text-white' : 'text-white/55 hover:text-white')}>
          {label}
        </Link>
      ))}
    </div>
  );
}

function ChannelSwitcher() {
  const { channel, channels, select } = useChannel();
  if (!channel) return null;
  if (channels.length < 2)
    return (
      <div className="panel flex items-center gap-2.5 p-2.5">
        <Avatar src={channel.avatar_url} name={channel.display_name} size={32} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{channel.display_name}</div>
          <div className="text-xs text-white/55">{channel.access === 'owner' ? 'Your channel' : 'Moderator'}</div>
        </div>
      </div>
    );
  return (
    <label className="block">
      <span className="sr-only">Channel</span>
      <select value={channel.id} onChange={(e) => select(e.target.value)} className="panel h-11 w-full px-3 text-sm font-semibold">
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.display_name} {c.access === 'owner' ? '(yours)' : '(mod)'}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Shown only when DISCORD_INVITE_URL is configured — never a placeholder link. */
function JoinDiscord({ className }: { className?: string }) {
  const url = useConfig().data?.discordUrl;
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cx('inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-volt pl-1 pr-3.5 font-display text-sm font-extrabold uppercase tracking-wide text-on-volt transition-transform duration-200 hover:-translate-y-0.5', className)}>
      <BuddyHead className="size-8" />
      Join Discord
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function NotificationsBell() {
  const me = useMe().data;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const q = useQuery({ queryKey: ['notifications', 'bell'], queryFn: () => get<Page<Notification>>('/api/notifications?limit=8'), enabled: open });
  const readAll = useMutation({
    mutationFn: () => post('/api/notifications/read', { all: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const unread = me?.unreadNotifications ?? 0;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative flex size-11 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && <span className="num absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-magenta px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] animate-rise rounded-2xl border border-line bg-raised shadow-[var(--shadow-pop)]" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="font-semibold">Notifications</span>
            <button className="text-xs font-medium text-volt hover:underline disabled:opacity-50" onClick={() => readAll.mutate()} disabled={!unread}>
              Mark all read
            </button>
          </div>
          <ul className="max-h-96 overflow-y-auto p-1.5">
            {q.isLoading && <li className="p-4 text-sm text-muted">Loading…</li>}
            {q.data?.items.length === 0 && <li className="p-6 text-center text-sm text-muted">You’re all caught up.</li>}
            {q.data?.items.map((n) => (
              <li key={n.id} className={cx('flex gap-3 rounded-xl p-3', !n.read_at && 'bg-overlay/60')}>
                <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-volt')} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body && <p className="line-clamp-2 text-xs text-muted">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-subtle">{fmtRelative(n.created_at)}</p>
                </div>
              </li>
            ))}
          </ul>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-3 text-center text-sm font-medium text-muted hover:text-fg">
            View all
          </Link>
        </div>
      )}
    </div>
  );
}

/** Points are not money — star icon, "points" wording, links to the points page. */
export function PointsPill({ className }: { className?: string }) {
  const me = useMe().data;
  const n = me?.points ?? 0;
  return (
    <Tooltip label="Your Points Balance">
      <Link to="/points" className={cx('flex h-11 items-center gap-1.5 rounded-full border border-volt/30 bg-black/45 px-3.5 transition-colors hover:border-volt/60 hover:bg-volt/10', className)} aria-label={`Your points balance: ${fmtPoints(n)} points`}>
        <Star className="size-4 fill-volt text-volt" aria-hidden />
        <span className="num text-sm font-semibold text-white">{fmtPoints(n)}</span>
      </Link>
    </Tooltip>
  );
}

/** Live / offline comes from Kick (verified livestream webhooks + channel API), never guessed. */
export function StreamerModeButton({ compact }: { compact?: boolean }) {
  const me = useMe().data;
  const own = me?.channels?.find((c) => c.access === 'owner');
  if (!own) return null;
  const live = !!own.is_live;
  return (
    <Link to="/streamer/dashboard" className="group flex h-11 items-center gap-2 rounded-full border border-white/12 bg-black/45 px-3.5 font-display text-sm font-extrabold uppercase tracking-wide text-white transition-colors hover:border-volt/60" aria-label={`Streamer mode — your channel is ${live ? 'live' : 'offline'}`}>
      <Clapperboard className="size-4 text-volt" aria-hidden />
      {!compact && <span>Streamer mode</span>}
      <span className={cx('flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]', live ? 'bg-danger text-white' : 'bg-white/10 text-white/70')}>
        <span className={cx('size-1.5 rounded-full', live ? 'animate-pulse-dot bg-white' : 'bg-white/60')} aria-hidden />
        {live ? 'Live' : 'Offline'}
      </span>
    </Link>
  );
}

/** Kick subscriptions are bought on Kick. We link there honestly; gifts made on Kick earn points here via verified events. */
export function GiftSubDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['streamers', 'gift', q], enabled: open, queryFn: () => get<{ items: Streamer[] }>(`/api/streamers${qs({ q: q || undefined, sort: 'live', limit: 12 })}`) });
  return (
    <Modal open={open} onClose={onClose} title="Gift a subscription" description="Subscriptions are purchased on Kick. Pick a channel to open it on Kick, then use Kick’s Gift Subs button.">
      <label className="relative block">
        <span className="sr-only">Search streamers</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search streamers" className="pl-9" />
      </label>
      <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
        {list.isLoading && <li className="p-3 text-sm text-muted">Loading…</li>}
        {list.data?.items.length === 0 && <li className="p-3 text-sm text-muted">No streamers found.</li>}
        {list.data?.items.map((s) => (
          <li key={s.id}>
            <a href={`https://kick.com/${encodeURIComponent(s.slug)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-white/5">
              <Avatar src={s.avatarUrl} name={s.displayName} size={36} />
              <span className="min-w-0 flex-1 truncate font-medium">{s.displayName}</span>
              <LiveBadge live={s.isLive} />
              <span className="flex items-center gap-1 text-sm font-semibold text-volt">
                Gift on Kick <ExternalLink className="size-3.5" aria-hidden />
                <span className="sr-only">(opens kick.com in a new tab)</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex items-start gap-2 rounded-xl border border-volt/20 bg-volt/5 p-3 text-sm text-muted">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-volt" aria-hidden />
        When the streamer uses VoxDrop, gift subs you make on Kick are verified through Kick’s events and reward you with points here.
      </p>
    </Modal>
  );
}

/** English only for now — Arabic is listed but disabled until translations exist (no half-translated UI). */
function LanguageMenu({ inline }: { inline?: boolean }) {
  return (
    <Menu
      label="Language"
      items={[
        { label: 'English', icon: <Check />, onSelect: () => undefined },
        { label: 'العربية — coming soon', icon: <Languages />, onSelect: () => undefined, disabled: true },
      ]}
      trigger={(p) => (
        <button {...p} className={cx('flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-white/85 transition-colors hover:bg-white/10', inline && 'h-11 w-full justify-start')} aria-label="Language: English">
          <Languages className="size-4" aria-hidden /> EN
        </button>
      )}
    />
  );
}

/** Controls the volume of in-app audio previews (messages, sounds, announcement previews). */
function VolumeControl({ inline }: { inline?: boolean }) {
  const v = useMasterVolume();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const pct = Math.round(v.volume * 100);
  const slider = (
    <div className="flex items-center gap-3">
      <button type="button" onClick={() => setMasterVolume({ muted: !v.muted })} className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/15" aria-label={v.muted ? 'Unmute previews' : 'Mute previews'} aria-pressed={v.muted}>
        {v.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      <input type="range" min={0} max={100} value={pct} onChange={(e) => setMasterVolume({ volume: Number(e.target.value) / 100, muted: false })} className="h-2 w-36 cursor-pointer accent-[var(--color-volt)]" aria-label="Preview volume" aria-valuetext={`${pct}%`} />
      <span className="num w-9 text-right text-xs text-white/70">{v.muted ? 'off' : `${pct}%`}</span>
    </div>
  );
  if (inline)
    return (
      <div className="px-1">
        <p className="label-caps mb-2 text-white/45">Preview volume</p>
        {slider}
      </div>
    );
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Preview volume ${v.muted ? 'muted' : `${pct}%`}`} className="flex size-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10">
        {v.muted || pct === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 animate-rise rounded-2xl border border-line bg-raised p-3 shadow-[var(--shadow-pop)]" role="dialog" aria-label="Preview volume">
          <p className="mb-2 text-xs text-muted">Volume for previews you play in VoxDrop</p>
          {slider}
        </div>
      )}
    </div>
  );
}

function TopBar({ area, onMenu }: { area: Area; onMenu: () => void }) {
  const me = useMe().data;
  const logout = useLogout();
  const nav = useNavigate();
  const rt = useRealtime();
  const [gift, setGift] = useState(false);
  if (!me?.user) return null;
  const u = me.user;
  const isStreamer = (me.channels ?? []).some((c) => c.access === 'owner');
  return (
    <header className="sticky top-0 z-40 flex h-[76px] items-center gap-2 bg-gradient-to-b from-[#040807]/95 via-[#040807]/70 to-transparent px-4 backdrop-blur-[2px] sm:px-6 lg:px-8">
      <button className="flex size-11 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/80 md:hidden" onClick={onMenu} aria-label="Open navigation">
        <MenuIcon className="size-5" />
      </button>
      <div className="md:hidden">
        <Brand to={homeFor(area)} compact />
      </div>
      <div className="ml-auto flex items-center gap-2">
        {area === 'viewer' && isStreamer && (
          <span className="hidden xl:block">
            <StreamerModeButton />
          </span>
        )}
        {area === 'viewer' && !isStreamer && (
          <Link to="/become-streamer" className="hidden h-11 items-center gap-2 rounded-full border border-white/12 bg-black/45 px-4 font-display text-sm font-extrabold uppercase tracking-wide text-white transition-colors hover:border-volt/60 lg:flex">
            <Clapperboard className="size-4 text-volt" aria-hidden /> Become a Streamer
          </Link>
        )}
        <PointsPill className="hidden sm:flex" />
        <button onClick={() => setGift(true)} className="flex h-11 items-center gap-2 rounded-full bg-volt px-3.5 font-display text-[15px] font-extrabold uppercase tracking-wide text-on-volt shadow-[0_8px_24px_-10px_rgb(255_212_59/0.8)] transition-transform duration-200 hover:-translate-y-0.5 sm:px-4" aria-label="Gift a subscription">
          <Gift className="size-[18px]" aria-hidden />
          <span className="hidden sm:inline">Gift a subscription</span>
        </button>
        <div className="hidden h-11 items-center gap-0.5 rounded-full border border-white/10 bg-black/45 px-1 sm:flex">
          <LanguageMenu />
          <VolumeControl />
        </div>
        <NotificationsBell />
        <Menu
          label="Profile menu"
          trigger={(p) => (
            <button {...p} className="relative rounded-full ring-2 ring-white/10 transition-shadow hover:ring-volt/60" aria-label={`Open profile menu. Real-time ${rt.status === 'open' ? 'connected' : rt.status}`}>
              <Avatar src={u.avatarUrl} name={u.displayName} size={44} />
              <span className={cx('absolute bottom-0 right-0 size-3 rounded-full ring-2 ring-[#050908]', rt.status === 'open' ? 'bg-success' : rt.status === 'connecting' ? 'bg-amber' : 'bg-line-strong')} aria-hidden />
            </button>
          )}
          items={[
            { label: 'Profile', icon: <User />, onSelect: () => nav('/profile') },
            { label: 'Settings', icon: <Settings />, onSelect: () => nav('/settings') },
            ...(area === 'viewer'
              ? isStreamer || (me.channels?.length ?? 0) > 0
                ? [{ label: 'Switch to Streamer', icon: <Clapperboard />, onSelect: () => nav('/streamer/dashboard') }]
                : [{ label: 'Become a Streamer', icon: <Sparkles />, onSelect: () => nav('/become-streamer') }]
              : [{ label: 'Switch to Viewer', icon: <Home />, onSelect: () => nav('/home') }]),
            ...(u.role === 'ADMIN' ? [{ label: 'Admin panel', icon: <Shield />, onSelect: () => nav('/admin') }] : []),
            { label: 'Help & FAQ', icon: <BookOpen />, onSelect: () => nav('/#faq') },
            'divider' as const,
            { label: 'Log out', icon: <LogOut />, onSelect: logout, tone: 'danger' as const },
          ]}
        />
      </div>
      <GiftSubDialog open={gift} onClose={() => setGift(false)} />
    </header>
  );
}

/** Fixed, decorative cinematic background (CSS only; never blocks rendering). */
export function Backdrop() {
  return <div className="vx-backdrop" aria-hidden />;
}

export function AppShell({ area }: { area: Area }) {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setDrawer(false);
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  useEffect(() => {
    document.body.style.overflow = drawer ? 'hidden' : '';
  }, [drawer]);

  const mobile = MOBILE[area];
  return (
    <div className="min-h-dvh">
      <Backdrop />
      <a href="#main" className="sr-only z-[200] rounded-lg bg-volt px-4 py-2 font-semibold text-on-volt focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      <OfflineBanner />
      <DevModeBanner />
      <div className="flex">
        {/* Desktop: full sidebar · tablet: icon rail */}
        <aside className="sticky top-0 hidden h-dvh shrink-0 flex-col gap-3 overflow-y-auto py-4 pl-4 md:flex md:w-[92px] lg:w-[290px]">
          <div className="flex items-center justify-between gap-2 px-1 pb-1 lg:justify-start">
            <span className="hidden lg:block">
              <Brand to={homeFor(area)} large />
            </span>
            <span className="mx-auto lg:hidden">
              <Brand to={homeFor(area)} compact />
            </span>
            <JoinDiscord className="ml-auto hidden lg:inline-flex" />
          </div>
          <div className="hidden lg:block">
            <AreaSwitch area={area} />
          </div>
          {area === 'streamer' && (
            <div className="hidden lg:block">
              <ChannelSwitcher />
            </div>
          )}
          <SideNav area={area} rail />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button className="absolute inset-0 bg-black/75" onClick={() => setDrawer(false)} aria-label="Close navigation" />
            <div className="absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] animate-rise flex-col gap-3 overflow-y-auto border-r border-white/10 bg-[#070c0b]/95 p-4 backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <Brand to={homeFor(area)} />
                <button className="flex size-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10" onClick={() => setDrawer(false)} aria-label="Close navigation">
                  <X className="size-5" />
                </button>
              </div>
              <JoinDiscord className="self-start" />
              <div className="flex flex-wrap gap-2">
                <PointsPill />
                <StreamerModeButton compact />
              </div>
              <AreaSwitch area={area} />
              {area === 'streamer' && <ChannelSwitcher />}
              <SideNav area={area} onNavigate={() => setDrawer(false)} />
              <div className="panel space-y-3 p-3">
                <LanguageMenu inline />
                <VolumeControl inline />
              </div>
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar area={area} onMenu={() => setDrawer(true)} />
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-28 pt-2 outline-none sm:px-6 md:pb-12 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Mobile bottom navigation */}
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#050908]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        <ul className="grid" style={{ gridTemplateColumns: `repeat(${mobile.length + 1}, minmax(0, 1fr))` }}>
          {mobile.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className={({ isActive }) => cx('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold', isActive ? 'text-volt' : 'text-white/60')}>
                {({ isActive }) => (
                  <>
                    <span className={cx('flex h-7 w-10 items-center justify-center rounded-full transition-colors', isActive && 'bg-volt text-on-volt')}>{item.icon}</span>
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
          <li>
            <button onClick={() => setDrawer(true)} className="flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-semibold text-white/60" aria-label="Menu — more navigation">
              <span className="flex h-7 w-10 items-center justify-center">
                <MenuIcon className="size-[19px]" aria-hidden />
              </span>
              Menu
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}

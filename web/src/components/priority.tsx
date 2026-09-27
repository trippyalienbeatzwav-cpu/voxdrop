import { Circle, Crown, Flame, Gem, Rocket, Star, Trophy, Zap, type LucideIcon } from 'lucide-react';
import { cx } from '../lib/format';

export type TierKey = 'NORMAL' | 'PRIORITY' | 'HIGH' | 'VIP';
export const TIER_KEYS: TierKey[] = ['NORMAL', 'PRIORITY', 'HIGH', 'VIP'];
export const TIER_ICONS: Record<string, LucideIcon> = { circle: Circle, zap: Zap, flame: Flame, crown: Crown, star: Star, rocket: Rocket, gem: Gem, trophy: Trophy };

export interface TierRow {
  tier: TierKey;
  name: string;
  min_points: number;
  multiplier: number;
  color: string;
  icon: string;
  cooldown_seconds: number;
  daily_limit: number;
  is_active: boolean;
}

/** Tier label: icon + name + tinted border. Color is never the only signal (icon and text too). */
export function TierBadge({ tier, name, color, icon, className }: { tier: TierKey; name?: string; color?: string; icon?: string; className?: string }) {
  const Icon = TIER_ICONS[icon ?? ''] ?? (tier === 'VIP' ? Crown : tier === 'HIGH' ? Flame : tier === 'PRIORITY' ? Zap : Circle);
  const c = color ?? '#A3ACBB';
  return (
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-bold uppercase tracking-wide', className)} style={{ color: c, borderColor: `${c}55`, background: `${c}14` }}>
      <Icon className="size-3.5" aria-hidden />
      {name ?? tier}
    </span>
  );
}

import { z } from 'zod';
import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';

/**
 * Points-based priority queue.
 *
 *   priorityScore = basePriority + pointsBonus + waitingBonus
 *     basePriority = 10 × tier multiplier
 *     pointsBonus  = pointsWeight  × pointsSpent / 100
 *     waitingBonus = waitingWeight × secondsWaited / 10
 *
 * Scores are recomputed every time the queue is read, so waiting time keeps
 * raising older items. On top of that, anything that has waited longer than the
 * starvation cap jumps ahead of every scored item (oldest first) — a hard
 * guarantee that big spenders can never block anyone indefinitely.
 * Items the streamer pinned manually (drag-and-drop / Play now) always come first.
 */

export const TIERS = ['NORMAL', 'PRIORITY', 'HIGH', 'VIP'] as const;
export type TierKey = (typeof TIERS)[number];

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

export interface PrioritySettings {
  enabled: boolean;
  points_weight: number;
  waiting_weight: number;
  starvation_cap_seconds: number;
  max_messages_per_viewer: number;
  refund_priority_on_reject: boolean;
  allow_vip_interrupt: boolean;
  default_tier: TierKey;
}

export const DEFAULT_TIERS: Omit<TierRow, 'is_active'>[] = [
  { tier: 'NORMAL', name: 'Normal', min_points: 0, multiplier: 1, color: '#A3ACBB', icon: 'circle', cooldown_seconds: 0, daily_limit: 0 },
  { tier: 'PRIORITY', name: 'Priority', min_points: 500, multiplier: 2, color: '#3DD9FF', icon: 'zap', cooldown_seconds: 0, daily_limit: 0 },
  { tier: 'HIGH', name: 'High Priority', min_points: 1000, multiplier: 3, color: '#FFB23D', icon: 'flame', cooldown_seconds: 0, daily_limit: 0 },
  { tier: 'VIP', name: 'VIP', min_points: 2500, multiplier: 5, color: '#FF3D8B', icon: 'crown', cooldown_seconds: 300, daily_limit: 5 },
];

export interface QueueCandidate {
  id: string;
  tier: TierKey;
  pointsSpent: number;
  enqueuedAt: Date;
  pinnedRank: number | null;
  /** Legacy FIFO fields used when the priority queue is disabled. */
  isPriority: boolean;
  position: number;
}

export interface ScoreBreakdown {
  score: number;
  base: number;
  points: number;
  waiting: number;
  waitedSeconds: number;
  starving: boolean;
}

export function scoreItem(item: QueueCandidate, s: PrioritySettings, tiers: Map<TierKey, TierRow>, now: Date): ScoreBreakdown {
  const waitedSeconds = Math.max(0, (now.getTime() - item.enqueuedAt.getTime()) / 1000);
  const multiplier = tiers.get(item.tier)?.multiplier ?? 1;
  const base = 10 * multiplier;
  const points = (s.points_weight * Math.max(0, item.pointsSpent)) / 100;
  const waiting = (s.waiting_weight * waitedSeconds) / 10;
  return { score: round2(base + points + waiting), base: round2(base), points: round2(points), waiting: round2(waiting), waitedSeconds, starving: waitedSeconds >= s.starvation_cap_seconds };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Deterministic playback order for the queued items of one channel. */
export function orderQueue<T extends QueueCandidate>(items: T[], s: PrioritySettings, tiers: Map<TierKey, TierRow>, now = new Date()): Array<T & { priority: ScoreBreakdown }> {
  const scored = items.map((i) => ({ ...i, priority: scoreItem(i, s, tiers, now) }));
  return scored.sort((a, b) => {
    // 1. Manual pins (streamer decisions) first.
    if ((a.pinnedRank !== null) !== (b.pinnedRank !== null)) return a.pinnedRank !== null ? -1 : 1;
    if (a.pinnedRank !== null && b.pinnedRank !== null && a.pinnedRank !== b.pinnedRank) return a.pinnedRank - b.pinnedRank;
    if (!s.enabled) {
      // Priority queue off: the original FIFO (priority flag, then arrival position).
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      return a.position - b.position;
    }
    // 2. Anti-starvation: anything past the cap goes next, oldest first.
    if (a.priority.starving !== b.priority.starving) return a.priority.starving ? -1 : 1;
    if (a.priority.starving && b.priority.starving) return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
    // 3. Dynamic score, then arrival time, then id for total determinism.
    if (b.priority.score !== a.priority.score) return b.priority.score - a.priority.score;
    const t = a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
}

/** Total cost for a message at a tier: the tier's minimum, but never below the normal price. */
export function tierPrice(basePrice: number, tier: Pick<TierRow, 'min_points'>) {
  return Math.max(basePrice, tier.min_points);
}

// ── Persistence ──────────────────────────────────────────────────────────────

export async function ensurePriorityDefaults(db: Db, streamerId: string) {
  await db.query('INSERT INTO priority_settings (streamer_id) VALUES ($1) ON CONFLICT DO NOTHING', [streamerId]);
  for (const t of DEFAULT_TIERS) {
    await db.query(
      `INSERT INTO priority_tiers (streamer_id, tier, name, min_points, multiplier, color, icon, cooldown_seconds, daily_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (streamer_id, tier) DO NOTHING`,
      [streamerId, t.tier, t.name, t.min_points, t.multiplier, t.color, t.icon, t.cooldown_seconds, t.daily_limit],
    );
  }
}

export async function getPriorityConfig(db: Db, streamerId: string) {
  let settings = await one<PrioritySettings>(db, 'SELECT * FROM priority_settings WHERE streamer_id = $1', [streamerId]);
  let tiers = await many<TierRow>(db, 'SELECT * FROM priority_tiers WHERE streamer_id = $1', [streamerId]);
  if (!settings || tiers.length < TIERS.length) {
    await ensurePriorityDefaults(db, streamerId);
    settings = await one<PrioritySettings>(db, 'SELECT * FROM priority_settings WHERE streamer_id = $1', [streamerId]);
    tiers = await many<TierRow>(db, 'SELECT * FROM priority_tiers WHERE streamer_id = $1', [streamerId]);
  }
  tiers.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  return { settings: settings!, tiers, tierMap: new Map(tiers.map((t) => [t.tier, t])) };
}

export const prioritySettingsSchema = z
  .object({
    enabled: z.boolean(),
    points_weight: z.number().min(0).max(100),
    waiting_weight: z.number().min(0).max(100),
    starvation_cap_seconds: z.number().int().min(30).max(86400),
    max_messages_per_viewer: z.number().int().min(1).max(100),
    refund_priority_on_reject: z.boolean(),
    allow_vip_interrupt: z.boolean(),
    default_tier: z.enum(TIERS),
  })
  .partial()
  .strict();

export const tierPatchSchema = z
  .object({
    tier: z.enum(TIERS),
    name: z.string().trim().min(1).max(24),
    min_points: z.number().int().min(0).max(10_000_000),
    multiplier: z.number().min(0.1).max(100),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    icon: z.enum(['circle', 'zap', 'flame', 'crown', 'star', 'rocket', 'gem', 'trophy']),
    cooldown_seconds: z.number().int().min(0).max(86400),
    daily_limit: z.number().int().min(0).max(1000),
    is_active: z.boolean(),
  })
  .partial()
  .required({ tier: true })
  .strict();

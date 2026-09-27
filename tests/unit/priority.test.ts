import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, orderQueue, scoreItem, tierPrice, type PrioritySettings, type QueueCandidate, type TierKey, type TierRow } from '../../server/services/priority.js';

const settings: PrioritySettings = {
  enabled: true,
  points_weight: 1,
  waiting_weight: 1.5,
  starvation_cap_seconds: 600,
  max_messages_per_viewer: 3,
  refund_priority_on_reject: true,
  allow_vip_interrupt: false,
  default_tier: 'NORMAL',
};
const tiers = new Map<TierKey, TierRow>(DEFAULT_TIERS.map((t) => [t.tier, { ...t, is_active: true }]));
const NOW = new Date('2026-09-27T12:00:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
let seq = 0;
const item = (id: string, tier: TierKey, points: number, waitedSeconds: number, extra: Partial<QueueCandidate> = {}): QueueCandidate => ({
  id,
  tier,
  pointsSpent: points,
  enqueuedAt: ago(waitedSeconds),
  pinnedRank: null,
  isPriority: false,
  position: ++seq,
  ...extra,
});
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe('priority score', () => {
  it('is base + points + waiting, all configurable', () => {
    const s = scoreItem(item('x', 'HIGH', 1000, 20), settings, tiers, NOW);
    expect(s).toMatchObject({ base: 30, points: 10, waiting: 3, score: 43, starving: false });
    const heavierWaiting = scoreItem(item('x', 'HIGH', 1000, 20), { ...settings, waiting_weight: 3 }, tiers, NOW);
    expect(heavierWaiting.waiting).toBe(6);
  });

  it('orders fresh 100 / 500 / 1,000 / 2,500-point messages by tier and spend', () => {
    const q = [item('normal-100', 'NORMAL', 100, 0), item('prio-500', 'PRIORITY', 500, 0), item('high-1000', 'HIGH', 1000, 0), item('vip-2500', 'VIP', 2500, 0)];
    expect(ids(orderQueue(q, settings, tiers, NOW))).toEqual(['vip-2500', 'high-1000', 'prio-500', 'normal-100']);
  });

  it('spec example: waiting time matters — not simply sorted by points', () => {
    const q = [item('A-100pts-30s', 'NORMAL', 100, 30), item('B-1000pts-5s', 'HIGH', 1000, 5), item('C-500pts-120s', 'PRIORITY', 500, 120)];
    // A = 10+1+4.5 = 15.5, B = 30+10+0.75 = 40.75, C = 20+5+18 = 43
    expect(ids(orderQueue(q, settings, tiers, NOW))).toEqual(['C-500pts-120s', 'B-1000pts-5s', 'A-100pts-30s']);
  });

  it('a waiting normal message eventually overtakes fresh VIP messages (score alone)', () => {
    const fresh = item('vip-fresh', 'VIP', 2500, 0); // 50 + 25 = 75
    expect(ids(orderQueue([item('normal-5min', 'NORMAL', 100, 300), fresh], settings, tiers, NOW))[0]).toBe('vip-fresh'); // 10+1+45 = 56
    expect(ids(orderQueue([item('normal-8min', 'NORMAL', 100, 480), fresh], settings, tiers, NOW))[0]).toBe('normal-8min'); // 10+1+72 = 83
  });

  it('anti-starvation cap: past the cap, an item beats any score', () => {
    const noWaitWeight = { ...settings, waiting_weight: 0 };
    const q = [item('vip', 'VIP', 1_000_000, 1), item('starving', 'NORMAL', 0, 601)];
    expect(ids(orderQueue(q, noWaitWeight, tiers, NOW))).toEqual(['starving', 'vip']);
  });

  it('a steady stream of VIP messages cannot block a normal message forever', () => {
    // Simulate: every 30s a new VIP arrives and one item plays. The normal message must play within the cap.
    let queue = [item('normal', 'NORMAL', 100, 0)];
    let played = -1;
    for (let tick = 0; tick < 40 && played < 0; tick++) {
      const now = new Date(NOW.getTime() + tick * 30_000);
      queue.push({ ...item(`vip-${tick}`, 'VIP', 2500, 0), enqueuedAt: now });
      const next = orderQueue(queue, settings, tiers, now)[0]!;
      if (next.id === 'normal') played = tick;
      queue = queue.filter((q) => q.id !== next.id);
    }
    expect(played).toBeGreaterThanOrEqual(0);
    expect(played * 30).toBeLessThanOrEqual(600);
  });

  it('ties break by arrival time', () => {
    const q = [item('later', 'NORMAL', 100, 10), item('earlier', 'NORMAL', 100, 10, { enqueuedAt: ago(10.001) })];
    expect(ids(orderQueue(q, settings, tiers, NOW))).toEqual(['earlier', 'later']);
  });

  it('streamer pins always win', () => {
    const q = [item('vip', 'VIP', 2500, 100), item('pinned', 'NORMAL', 0, 0, { pinnedRank: -1 })];
    expect(ids(orderQueue(q, settings, tiers, NOW))).toEqual(['pinned', 'vip']);
  });

  it('priority queue disabled falls back to FIFO', () => {
    const q = [item('first', 'NORMAL', 0, 0, { position: 1 }), item('vip', 'VIP', 2500, 0, { position: 2 })];
    expect(ids(orderQueue(q, { ...settings, enabled: false }, tiers, NOW))).toEqual(['first', 'vip']);
  });

  it('tier price is the tier minimum but never below the normal price', () => {
    expect(tierPrice(150, { min_points: 1000 })).toBe(1000);
    expect(tierPrice(1500, { min_points: 1000 })).toBe(1500);
    expect(tierPrice(150, { min_points: 0 })).toBe(150);
  });
});

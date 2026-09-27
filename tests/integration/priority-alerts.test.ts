import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../server/events/bus.js';
import { Topic } from '../../server/events/bus.js';
import { getBalance } from '../../server/services/points.js';
import { pendingAlerts } from '../../server/services/alerts.js';
import { MockTtsService } from '../../server/integrations/tts/TTSService.js';
import { cookieFrom, grant, login, makeTestEnv, nextIp, Client, type TestEnv } from '../helpers/setup.js';
import { tone } from '../helpers/audio.js';

let env: TestEnv;
let streamer: Client;
let sid: string;
const BROADCASTER = 640000001;

/** Full one-step streamer sign-up through the (mock) Kick OAuth flow — no prior viewer login. */
async function streamerSignup(username: string, kickUserId: string) {
  const remoteAddress = nextIp();
  const start = await env.app.inject({ method: 'GET', url: '/auth/kick/streamer', remoteAddress });
  expect(start.statusCode).toBe(302);
  const url = new URL(start.headers.location as string);
  expect(url.searchParams.get('scope')).toContain('events:subscribe');
  const nonce = cookieFrom(start, 'vx_oauth')!;
  const auth = await env.app.inject({ method: 'POST', url: '/api/dev/mock-kick/authorize', payload: { state: url.searchParams.get('state'), codeChallenge: url.searchParams.get('code_challenge'), username, kickUserId } });
  const cb = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${nonce}` }, remoteAddress });
  const session = cookieFrom(cb, 'vx_session')!;
  const me = (await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vx_session=${session}` } })).json();
  return { client: new Client(env.app, `vx_session=${session}`, me.csrfToken, me.user.id, me.user.username), location: cb.headers.location, channelId: me.channels.find((c: { access: string }) => c.access === 'owner')?.id as string };
}

beforeAll(async () => {
  env = await makeTestEnv();
  const r = await streamerSignup('prio_streamer', String(BROADCASTER));
  streamer = r.client;
  sid = r.channelId;
  await streamer.patch(`/api/channels/${sid}/settings`, { cooldown_seconds: 0, approval_mode: 'AUTO', playback_gap_ms: 0, daily_message_limit: 0, announce_enabled: false });
});
afterAll(() => env.close());

let n = 0;
async function viewer(points = 10_000) {
  const v = await login(env, `pv_${++n}_${Math.random().toString(36).slice(2, 7)}`);
  if (points) await grant(env, v.userId, points);
  return v;
}
async function sendVoice(v: Client, priorityTier?: string, headers?: Record<string, string>) {
  const up = await v.upload(tone(1), 'r.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
  return v.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: up.json().audio.id, priorityTier }, headers);
}
const clearQueue = () => env.db.query(`UPDATE playback_queue SET status = 'REMOVED' WHERE streamer_id = $1 AND status IN ('QUEUED','PLAYING')`, [sid]);
const queue = async () => (await streamer.get(`/api/channels/${sid}/queue`)).json();
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('streamer onboarding', () => {
  it('one-step Kick sign-up creates profile, settings, alerts, priority tiers and OBS tokens, then opens the studio', async () => {
    const r = await streamerSignup('fresh_streamer', '640000099');
    expect(r.location).toBe('/streamer/dashboard');
    const q = async (sql: string) => (await env.db.query<{ n: number }>(sql, [r.channelId])).rows[0]!.n;
    expect(await q('SELECT COUNT(*)::int AS n FROM streamer_settings WHERE streamer_id = $1')).toBe(1);
    expect(await q('SELECT COUNT(*)::int AS n FROM priority_settings WHERE streamer_id = $1')).toBe(1);
    expect(await q('SELECT COUNT(*)::int AS n FROM priority_tiers WHERE streamer_id = $1')).toBe(4);
    expect(await q('SELECT COUNT(*)::int AS n FROM streamer_alert_settings WHERE streamer_id = $1')).toBe(3);
    expect(await q('SELECT COUNT(*)::int AS n FROM overlay_tokens WHERE streamer_id = $1')).toBe(4);
    // Signing up again with the same Kick account never duplicates anything.
    const again = await streamerSignup('fresh_streamer', '640000099');
    expect(again.client.userId).toBe(r.client.userId);
    expect(again.channelId).toBe(r.channelId);
    expect((await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM kick_accounts WHERE kick_user_id = '640000099'`)).rows[0]!.n).toBe(1);
  });

  it('a viewer who later becomes a streamer keeps one identity (VIEWER + STREAMER)', async () => {
    const v = await login(env, 'viewer_to_streamer', '640000077');
    await grant(env, v.userId, 42);
    const r = await streamerSignup('viewer_to_streamer', '640000077');
    expect(r.client.userId).toBe(v.userId);
    expect(await getBalance(env.db, v.userId)).toBe(42);
  });
});

describe('permissions (server-side)', () => {
  it('viewers cannot touch priority settings, overlays, alerts or another channel', async () => {
    const v = await viewer(0);
    expect((await v.patch(`/api/channels/${sid}/priority`, { tiers: [{ tier: 'VIP', min_points: 1 }] })).statusCode).toBe(403);
    expect((await v.get(`/api/channels/${sid}/overlays`)).statusCode).toBe(403);
    expect((await v.post(`/api/channels/${sid}/alerts/donation/test`, {})).statusCode).toBe(403);
    expect((await v.get(`/api/channels/${sid}/queue`)).statusCode).toBe(403);
    const other = await streamerSignup('other_prio', '640000055');
    expect((await other.client.get(`/api/channels/${sid}/queue`)).statusCode).toBe(403);
    expect((await other.client.patch(`/api/channels/${sid}/priority`, { settings: { enabled: false } })).statusCode).toBe(403);
  });

  it('moderators can read priority settings but not change them or see overlay secrets', async () => {
    const mod = await login(env, 'prio_mod');
    await streamer.post(`/api/channels/${sid}/moderators`, { username: 'prio_mod' });
    expect((await mod.get(`/api/channels/${sid}/priority`)).statusCode).toBe(200);
    expect((await mod.patch(`/api/channels/${sid}/priority`, { settings: { waiting_weight: 0 } })).statusCode).toBe(403);
    expect((await mod.get(`/api/channels/${sid}/overlays`)).statusCode).toBe(403);
  });
});

describe('priority purchases', () => {
  it('prices come from the channel configuration; the premium is its own ledger entry', async () => {
    await clearQueue();
    const v = await viewer();
    const r = await sendVoice(v, 'HIGH');
    expect(r.statusCode).toBe(201);
    expect(r.json().message).toMatchObject({ pointsSpent: 1000, priorityTier: 'HIGH', priorityPoints: 850 });
    const tx = (await env.db.query<{ type: string; amount: number; priority_tier: string | null }>(`SELECT type, amount, priority_tier FROM points_transactions WHERE user_id = $1 AND amount < 0 ORDER BY type`, [v.userId])).rows;
    expect(tx).toEqual([
      { type: 'POINTS_SPENT', amount: -150, priority_tier: null },
      { type: 'POINTS_SPENT_PRIORITY', amount: -850, priority_tier: 'HIGH' },
    ]);
    expect(await getBalance(env.db, v.userId)).toBe(9000);
  });

  it('ignores client-supplied prices and rejects unknown/disabled tiers', async () => {
    const v = await viewer();
    const up = await v.upload(tone(1), 'r.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
    const forged = await v.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: up.json().audio.id, priorityTier: 'VIP', pointsSpent: 1, price: 1 });
    expect(forged.json().message.pointsSpent).toBe(2500);
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'x', priorityTier: 'GOD' })).statusCode).toBe(422);
    await streamer.patch(`/api/channels/${sid}/priority`, { tiers: [{ tier: 'HIGH', is_active: false }] });
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'x', priorityTier: 'HIGH' })).json().error.code).toBe('VALIDATION_FAILED');
    await streamer.patch(`/api/channels/${sid}/priority`, { tiers: [{ tier: 'HIGH', is_active: true }] });
  });

  it('insufficient points for a tier charges nothing', async () => {
    const v = await viewer(600);
    const r = await sendVoice(v, 'HIGH');
    expect(r.statusCode).toBe(402);
    expect(await getBalance(env.db, v.userId)).toBe(600);
  });

  it('tier cooldown and daily limit are enforced (VIP defaults: 5 min cooldown)', async () => {
    const v = await viewer();
    expect((await sendVoice(v, 'VIP')).statusCode).toBe(201);
    const second = await sendVoice(v, 'VIP');
    expect(second.json().error.code).toBe('COOLDOWN_ACTIVE');
    expect((await sendVoice(v, 'HIGH')).statusCode).toBe(201); // other tiers unaffected
  });

  it('streamer can change tier prices and settings (validated: prices must rise with the tier)', async () => {
    const bad = await streamer.patch(`/api/channels/${sid}/priority`, { tiers: [{ tier: 'PRIORITY', min_points: 5000 }] });
    expect(bad.statusCode).toBe(422);
    const ok = await streamer.patch(`/api/channels/${sid}/priority`, { tiers: [{ tier: 'PRIORITY', min_points: 600, name: 'Boost' }], playback: { auto_play_delay_seconds: 2 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tiers.find((t: { tier: string }) => t.tier === 'PRIORITY')).toMatchObject({ min_points: 600, name: 'Boost' });
    expect(ok.json().playback.auto_play_delay_seconds).toBe(2);
    const v = await viewer();
    expect((await sendVoice(v, 'PRIORITY')).json().message.pointsSpent).toBe(600);
    await streamer.patch(`/api/channels/${sid}/priority`, { tiers: [{ tier: 'PRIORITY', min_points: 500, name: 'Priority' }], playback: { auto_play_delay_seconds: 0 } });
  });
});

describe('refunds on rejection', () => {
  it('normal price and priority premium have independent refund switches', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { approval_mode: 'MANUAL' });
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { refund_priority_on_reject: false }, playback: { refund_on_reject: true } });
    const v = await viewer();
    const m = (await sendVoice(v, 'HIGH')).json().message;
    await streamer.post(`/api/messages/${m.id}/reject`, { reason: 'no' });
    expect(await getBalance(env.db, v.userId)).toBe(10_000 - 850); // base refunded, premium kept

    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { refund_priority_on_reject: true }, playback: { refund_on_reject: false } });
    const v2 = await viewer();
    const m2 = (await sendVoice(v2, 'HIGH')).json().message;
    await streamer.post(`/api/messages/${m2.id}/reject`, { reason: 'no' });
    expect(await getBalance(env.db, v2.userId)).toBe(10_000 - 150); // premium refunded, base kept
    const refunds = (await env.db.query<{ type: string; amount: number; priority_tier: string }>(`SELECT type, amount, priority_tier FROM points_transactions WHERE user_id = $1 AND type = 'POINTS_REFUNDED'`, [v2.userId])).rows;
    expect(refunds).toEqual([{ type: 'POINTS_REFUNDED', amount: 850, priority_tier: 'HIGH' }]);

    await streamer.patch(`/api/channels/${sid}/priority`, { playback: { refund_on_reject: true } });
    await streamer.patch(`/api/channels/${sid}/settings`, { approval_mode: 'AUTO' });
  });
});

describe('queue ordering', () => {
  it('100 / 500 / 1,000 / 2,500-point messages are ordered by priority, and waiting time keeps it fair', async () => {
    await clearQueue();
    await streamer.patch(`/api/channels/${sid}/settings`, { price_text: 100 });
    const vs = await Promise.all([viewer(), viewer(), viewer(), viewer()]);
    const normal = (await vs[0]!.post('/api/messages', { streamerId: sid, type: 'TEXT', text: '100', priorityTier: 'NORMAL' })).json().message;
    const prio = (await vs[1]!.post('/api/messages', { streamerId: sid, type: 'TEXT', text: '500', priorityTier: 'PRIORITY' })).json().message;
    const high = (await vs[2]!.post('/api/messages', { streamerId: sid, type: 'TEXT', text: '1000', priorityTier: 'HIGH' })).json().message;
    const vip = (await vs[3]!.post('/api/messages', { streamerId: sid, type: 'TEXT', text: '2500', priorityTier: 'VIP' })).json().message;
    expect([normal, prio, high, vip].map((m) => m.pointsSpent)).toEqual([100, 500, 1000, 2500]);
    const order = async () => (await queue()).items.map((i: { id: string }) => i.id);
    expect(await order()).toEqual([vip.id, high.id, prio.id, normal.id]);

    // The 100-point message has waited 8 minutes: its waiting bonus now beats a fresh VIP.
    await env.db.query(`UPDATE playback_queue SET enqueued_at = now() - interval '8 minutes' WHERE message_id = $1`, [normal.id]);
    expect((await order())[0]).toBe(normal.id);
    // Even with waiting weight off, the starvation cap (10 min) guarantees it goes next.
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { waiting_weight: 0 } });
    await env.db.query(`UPDATE playback_queue SET enqueued_at = now() - interval '11 minutes' WHERE message_id = $1`, [normal.id]);
    expect((await order())[0]).toBe(normal.id);
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { waiting_weight: 1.5 } });
    const q = await queue();
    expect(q.items[0].priorityScore.starving).toBe(true);
    expect(q.items.map((i: { queuePosition: number }) => i.queuePosition)).toEqual([1, 2, 3, 4]);
  });

  it('streamer pins (drag-and-drop) override the automatic order until reset', async () => {
    const before = (await queue()).items.map((i: { queue: { itemId: string } }) => i.queue.itemId);
    const reversed = [...before].reverse();
    await streamer.post(`/api/channels/${sid}/queue/reorder`, { itemIds: reversed });
    expect((await queue()).items.map((i: { queue: { itemId: string } }) => i.queue.itemId)).toEqual(reversed);
    expect((await streamer.post(`/api/channels/${sid}/queue/reset-order`)).json().cleared).toBe(reversed.length);
    expect((await queue()).items.map((i: { queue: { itemId: string } }) => i.queue.itemId)).toEqual(before);
  });

  it('priority queue disabled → first come, first served', async () => {
    await clearQueue();
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { enabled: false } });
    const a = (await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'first' })).json().message;
    const b = (await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'second', priorityTier: 'VIP' })).json().message;
    expect(b.priorityTier).toBe('NORMAL'); // tiers ignored while disabled
    expect((await queue()).items.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { enabled: true } });
  });

  it('many viewers submitting at once: every message queued once, positions consistent, ledger balanced', async () => {
    await clearQueue();
    const vs = await Promise.all(Array.from({ length: 8 }, () => viewer()));
    const tiers = ['NORMAL', 'PRIORITY', 'HIGH', 'NORMAL', 'PRIORITY', 'HIGH', 'NORMAL', 'VIP'];
    const results = await Promise.all(vs.map((v, i) => v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: `m${i}`, priorityTier: tiers[i] })));
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(201));
    const q = await queue();
    expect(q.items).toHaveLength(8);
    expect(new Set(q.items.map((i: { queuePosition: number }) => i.queuePosition)).size).toBe(8);
    expect(q.items[0].priorityTier).toBe('VIP');
    const inv = await env.db.query<{ ok: boolean }>(
      `SELECT bool_and(a.balance = COALESCE(t.sum, 0)) AS ok FROM points_accounts a LEFT JOIN (SELECT user_id, SUM(amount)::int AS sum FROM points_transactions GROUP BY user_id) t ON t.user_id = a.user_id`,
    );
    expect(inv.rows[0]!.ok).toBe(true);
  });

  it('one viewer racing parallel submissions cannot exceed the per-viewer cap or double spend', async () => {
    await clearQueue();
    const v = await viewer(10_000);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: `r${i}` }, { 'idempotency-key': `race-key-${i}-abcdef` })));
    const ok = rs.filter((r) => r.statusCode === 201);
    expect(ok).toHaveLength(3); // max_messages_per_viewer default
    expect(await getBalance(env.db, v.userId)).toBe(10_000 - 3 * 100);
  });
});

describe('automatic playback', () => {
  it('approved messages play automatically in priority order, one at a time', async () => {
    await clearQueue();
    const plays: string[] = [];
    const vA = await viewer();
    const vB = await viewer();
    const a = (await vA.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'normal' })).json().message;
    const b = (await vB.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'vip', priorityTier: 'VIP' })).json().message;
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), (e: BusEvent) => e.type === 'overlay.play' && plays.push((e.data as { message: { id: string } }).message.id));
    // An overlay coming online triggers auto-play (the route does this on SSE connect).
    const { tryAdvance } = await import('../../server/services/queue.js');
    await tryAdvance(env.ctx, sid);
    await settle();
    expect(plays).toEqual([b.id]);
    const token = new URL((await streamer.get(`/api/channels/${sid}/overlay`)).json().overlayUrl).searchParams.get('token')!;
    const item = (await queue()).nowPlaying.queue.itemId;
    await env.app.inject({ method: 'POST', url: `/api/overlay/${sid}/audio/playback?token=${token}`, payload: { itemId: item, event: 'ended' } });
    await settle();
    expect(plays).toEqual([b.id, a.id]);
    unsub();
  });

  it('automatic playback OFF: messages wait until the streamer presses play', async () => {
    await clearQueue();
    await streamer.patch(`/api/channels/${sid}/priority`, { playback: { auto_play: false } });
    const plays: string[] = [];
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), (e: BusEvent) => e.type === 'overlay.play' && plays.push('x'));
    await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'waits' });
    await settle();
    expect(plays).toHaveLength(0);
    expect((await streamer.post(`/api/channels/${sid}/queue/play-next`, {})).statusCode).toBe(200);
    expect(plays).toHaveLength(1);
    unsub();
    await streamer.patch(`/api/channels/${sid}/priority`, { playback: { auto_play: true } });
  });

  it('VIP interruption is OFF by default: a VIP message waits for the current one to finish', async () => {
    await clearQueue();
    const events: string[] = [];
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), (e: BusEvent) => events.push(e.type));
    await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'playing now' });
    await settle();
    await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'vip', priorityTier: 'VIP' });
    await settle();
    unsub();
    expect(events.filter((e) => e === 'overlay.stop')).toHaveLength(0);
    expect((await queue()).nowPlaying.text).toBe('playing now');
  });

  it('VIP interruption ON: VIP cuts in, and the interrupted message replays afterwards (not lost)', async () => {
    await clearQueue();
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { allow_vip_interrupt: true } });
    const plays: string[] = [];
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), (e: BusEvent) => e.type === 'overlay.play' && plays.push((e.data as { message: { text: string } }).message.text));
    await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'normal' });
    await settle();
    await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'vip', priorityTier: 'VIP' });
    await settle();
    expect(plays).toEqual(['normal', 'vip']);
    const token = new URL((await streamer.get(`/api/channels/${sid}/overlay`)).json().overlayUrl).searchParams.get('token')!;
    await env.app.inject({ method: 'POST', url: `/api/overlay/${sid}/audio/playback?token=${token}`, payload: { itemId: (await queue()).nowPlaying.queue.itemId, event: 'ended' } });
    await settle();
    expect(plays).toEqual(['normal', 'vip', 'normal']);
    unsub();
    await streamer.patch(`/api/channels/${sid}/priority`, { settings: { allow_vip_interrupt: false } });
  });
});

describe('viewer queue position (real time)', () => {
  it('viewers get their position/ETA and live updates when someone outbids them', async () => {
    await clearQueue();
    await streamer.patch(`/api/channels/${sid}/priority`, { playback: { auto_play: false } });
    const v = await viewer();
    const mine = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'mine' })).json().message;
    const pos1 = (await v.get(`/api/messages/${mine.id}/position`)).json();
    expect(pos1.position).toMatchObject({ position: 1, ahead: 0, tier: 'NORMAL' });
    const updates: Array<{ position: number }> = [];
    const unsub = env.ctx.bus.subscribe(Topic.user(v.userId), (e: BusEvent) => e.type === 'queue.position_changed' && updates.push(e.data as { position: number }));
    await (await viewer()).post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'vip', priorityTier: 'VIP' });
    await settle(400);
    unsub();
    expect(updates.at(-1)?.position).toBe(2);
    expect((await v.get(`/api/messages/${mine.id}/position`)).json().position.ahead).toBe(1);
    // Someone else cannot read my position.
    expect((await (await viewer()).get(`/api/messages/${mine.id}/position`)).statusCode).toBe(404);
    // Pre-purchase estimates per tier.
    const opts = (await v.get(`/api/streamers/prio_streamer/priority?type=VOICE`)).json();
    expect(opts.tiers.map((t: { tier: string; price: number }) => [t.tier, t.price])).toEqual([['NORMAL', 150], ['PRIORITY', 500], ['HIGH', 1000], ['VIP', 2500]]);
    expect(opts.tiers.find((t: { tier: string }) => t.tier === 'VIP').estimatedPosition).toBeLessThanOrEqual(opts.tiers.find((t: { tier: string }) => t.tier === 'NORMAL').estimatedPosition);
    await streamer.patch(`/api/channels/${sid}/priority`, { playback: { auto_play: true } });
  });
});

describe('alerts', () => {
  const bc = { is_anonymous: false, user_id: BROADCASTER, username: 'prio_streamer', channel_slug: 'prio_streamer' };
  const deliver = (type: string, payload: unknown, messageId?: string) => {
    const s = env.ctx.mockKick!.signEvent(type, payload, { messageId });
    return env.app.inject({ method: 'POST', url: '/api/webhooks/kick', headers: s.headers, payload: s.body });
  };
  const collect = (kind: string) => {
    const got: Array<{ text: string; isTest: boolean }> = [];
    const un = env.ctx.bus.subscribe(Topic.alerts(sid, kind), (e: BusEvent) => e.type === 'alert.show' && got.push(e.data as { text: string; isTest: boolean }));
    return { got, un };
  };

  it('subscription → points reward AND a subscription alert; duplicates create neither twice', async () => {
    const v = await login(env, 'SubAlertFan', '650000001');
    const c = collect('subscription');
    const payload = { broadcaster: bc, subscriber: { is_anonymous: false, user_id: 650000001, username: 'SubAlertFan' }, duration: 1 };
    await deliver('channel.subscription.new', payload, '01ALERTSUB000000000000001');
    await deliver('channel.subscription.new', payload, '01ALERTSUB000000000000001');
    c.un();
    expect(c.got.map((a) => a.text)).toEqual(['SubAlertFan just subscribed!']);
    expect(await getBalance(env.db, v.userId)).toBe(500);
    expect((await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM alert_events WHERE kind = 'subscription' AND NOT is_test`)).rows[0]!.n).toBe(1);
  });

  it('gift subs → gift alert with the count', async () => {
    const c = collect('gift_sub');
    await deliver('channel.subscription.gifts', { broadcaster: bc, gifter: { is_anonymous: false, user_id: 650000002, username: 'TrippyAlien' }, giftees: [1, 2, 3, 4, 5].map((i) => ({ user_id: 660000000 + i, username: `g${i}` })) });
    c.un();
    expect(c.got.map((a) => a.text)).toEqual(['TrippyAlien gifted 5 subs!']);
  });

  it('donation alerts fire only from the verified payment webhook, once', async () => {
    const c = collect('donation');
    const donor = await login(env, 'DonorAlert');
    const { donationId, checkoutUrl } = (await donor.post('/api/donations', { streamerId: sid, amountCents: 1000, message: 'gg' })).json();
    await settle();
    expect(c.got).toHaveLength(0); // creating a checkout is not a donation
    const sessionId = checkoutUrl.split('/').pop()!;
    const signed = env.ctx.mockPayments!.simulate(sessionId, 'paid');
    await env.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: signed.headers, payload: signed.body });
    await env.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: signed.headers, payload: signed.body });
    c.un();
    expect(c.got.map((a) => a.text)).toEqual(['DonorAlert donated $10.00!']);
    expect(donationId).toBeTruthy();
  });

  it('test alerts are staff-only and clearly flagged', async () => {
    const c = collect('subscription');
    const r = await streamer.post(`/api/channels/${sid}/alerts/subscription/test`, {});
    c.un();
    expect(r.statusCode).toBe(200);
    expect(c.got[0]).toMatchObject({ isTest: true, text: 'TrippyAlien just subscribed!' });
  });

  it('custom templates, disabled alerts and minimum donation', async () => {
    await streamer.patch(`/api/channels/${sid}/alerts/subscription`, { template: 'Welcome {viewerName} ({months} months)!' });
    const c = collect('subscription');
    await deliver('channel.subscription.renewal', { broadcaster: bc, subscriber: { user_id: 650000009, username: 'Resubber' }, duration: 6 });
    await streamer.patch(`/api/channels/${sid}/alerts/subscription`, { enabled: false });
    await deliver('channel.subscription.new', { broadcaster: bc, subscriber: { user_id: 650000010, username: 'Muted' }, duration: 1 });
    c.un();
    expect(c.got.map((a) => a.text)).toEqual(['Welcome Resubber (6 months)!']);
    const skipped = (await env.db.query<{ status: string }>(`SELECT status FROM alert_events WHERE payload ->> 'viewerName' = 'Muted'`)).rows[0];
    expect(skipped?.status).toBe('SKIPPED');
    await streamer.patch(`/api/channels/${sid}/alerts/subscription`, { enabled: true, template: '{viewerName} just subscribed!' });
  });

  it('TTS failure still shows the alert (error recorded)', async () => {
    await streamer.patch(`/api/channels/${sid}/alerts/gift_sub`, { tts_enabled: true });
    (env.ctx.tts as MockTtsService).failAlways = true;
    const c = collect('gift_sub');
    await deliver('channel.subscription.gifts', { broadcaster: bc, gifter: { user_id: 650000020, username: 'TtsGifter' }, giftees: [{ user_id: 670000001, username: 'x' }] });
    c.un();
    (env.ctx.tts as MockTtsService).failAlways = false;
    expect(c.got).toHaveLength(1);
    const row = (await env.db.query<{ error: string }>(`SELECT error FROM alert_events WHERE payload ->> 'viewerName' = 'TtsGifter'`)).rows[0]!;
    expect(row.error).toMatch(/TTS/);
  });

  it('overlays: each has its own token; tokens are not interchangeable; rotation revokes; acks update status', async () => {
    const overlays = (await streamer.get(`/api/channels/${sid}/overlays`)).json().items as Array<{ kind: string; url: string }>;
    expect(overlays.map((o) => o.kind)).toEqual(['audio', 'subscription', 'gift_sub', 'donation']);
    const tok = (kind: string) => new URL(overlays.find((o) => o.kind === kind)!.url).searchParams.get('token')!;
    expect(overlays.find((o) => o.kind === 'gift_sub')!.url).toContain(`/overlay/${sid}/gift-sub?token=`);
    expect((await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/subscription?token=${tok('subscription')}` })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/subscription?token=${tok('audio')}` })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/donation?token=${tok('donation')}` })).json().alert.position).toBe('top');

    const test = (await streamer.post(`/api/channels/${sid}/alerts/donation/test`, {})).json();
    const pend = await pendingAlerts(env.db, sid, 'donation');
    expect(pend.some((p) => p.payload.alertId === test.id)).toBe(true);
    const ack = (event: string) => env.app.inject({ method: 'POST', url: `/api/overlay/${sid}/donation/ack?token=${tok('donation')}`, payload: { alertId: test.id, event } });
    expect((await ack('shown')).json().updated).toBe(true);
    expect((await ack('shown')).json().updated).toBe(false);
    expect((await ack('completed')).json().updated).toBe(true);

    const rotated = (await streamer.post(`/api/channels/${sid}/overlays/donation/rotate`)).json().url as string;
    expect((await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/donation?token=${tok('donation')}` })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/donation?token=${new URL(rotated).searchParams.get('token')}` })).statusCode).toBe(200);
    // Overlay URLs never contain server secrets.
    for (const o of overlays) expect(o.url).not.toMatch(/secret|client|password/i);
  });

  it('an alert failure never prevents the points reward', async () => {
    const v = await login(env, 'RewardSurvives', '650000030');
    await env.db.exec('ALTER TABLE alert_events RENAME TO alert_events_broken');
    try {
      const r = await deliver('channel.subscription.new', { broadcaster: bc, subscriber: { user_id: 650000030, username: 'RewardSurvives' } });
      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe('processed');
    } finally {
      await env.db.exec('ALTER TABLE alert_events_broken RENAME TO alert_events');
    }
    expect(await getBalance(env.db, v.userId)).toBe(500);
  });
});

describe('state machine', () => {
  it('the database rejects invalid message/queue state transitions', async () => {
    const m = await env.db.query<{ id: string }>(`SELECT id FROM messages WHERE status = 'PLAYED' LIMIT 1`);
    await expect(env.db.query(`UPDATE messages SET status = 'PENDING' WHERE id = $1`, [m.rows[0]!.id])).rejects.toThrow(/invalid message state transition PLAYED -> PENDING/);
    const qi = await env.db.query<{ id: string }>(`SELECT id FROM playback_queue WHERE status = 'PLAYED' LIMIT 1`);
    await expect(env.db.query(`UPDATE playback_queue SET status = 'QUEUED' WHERE id = $1`, [qi.rows[0]!.id])).rejects.toThrow(/invalid queue state transition/);
  });
});

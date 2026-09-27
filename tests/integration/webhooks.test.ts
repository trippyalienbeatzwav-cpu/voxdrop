import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBalance } from '../../server/services/points.js';
import { becomeStreamer, login, makeTestEnv, type Client, type TestEnv } from '../helpers/setup.js';

let env: TestEnv;
let streamer: Client;
let channelId: string;
const BROADCASTER = 700000001;

beforeAll(async () => {
  env = await makeTestEnv();
  streamer = await login(env, 'webhook_streamer', String(BROADCASTER));
  channelId = await becomeStreamer(env, streamer, String(BROADCASTER));
});
afterAll(() => env.close());

const bc = { is_anonymous: false, user_id: BROADCASTER, username: 'webhook_streamer', channel_slug: 'webhook_streamer' };
const kickUser = (id: number, username: string) => ({ is_anonymous: false, user_id: id, username, channel_slug: username });

function deliver(type: string, payload: unknown, messageId?: string) {
  const signed = env.ctx.mockKick!.signEvent(type, payload, { messageId });
  return env.app.inject({ method: 'POST', url: '/api/webhooks/kick', headers: signed.headers, payload: signed.body });
}

describe('Kick subscription rewards', () => {
  it('awards the configured subscription reward to the linked viewer', async () => {
    const v = await login(env, 'sub_viewer', '810000001');
    const res = await deliver('channel.subscription.new', { broadcaster: bc, subscriber: kickUser(810000001, 'sub_viewer'), duration: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processed');
    expect(await getBalance(env.db, v.userId)).toBe(500);
    const notes = (await v.get('/api/notifications')).json().items;
    expect(notes[0].type).toBe('subscription.reward');
  });

  it('uses the streamer-configured values (not hard-coded)', async () => {
    await streamer.patch(`/api/channels/${channelId}/settings`, { sub_reward_points: 1234, resub_reward_points: 321 });
    const v = await login(env, 'custom_viewer', '810000002');
    await deliver('channel.subscription.renewal', { broadcaster: bc, subscriber: kickUser(810000002, 'custom_viewer'), duration: 5 });
    expect(await getBalance(env.db, v.userId)).toBe(321);
    await deliver('channel.subscription.new', { broadcaster: bc, subscriber: kickUser(810000002, 'custom_viewer'), duration: 1 });
    expect(await getBalance(env.db, v.userId)).toBe(321 + 1234);
    await streamer.patch(`/api/channels/${channelId}/settings`, { sub_reward_points: 500, resub_reward_points: 300 });
  });

  it('duplicate deliveries of the same event never pay twice', async () => {
    const v = await login(env, 'dupe_viewer', '810000003');
    const payload = { broadcaster: bc, subscriber: kickUser(810000003, 'dupe_viewer'), duration: 1 };
    const first = await deliver('channel.subscription.new', payload, '01DUPLICATEEVENT0000000001');
    const results = await Promise.all([1, 2, 3].map(() => deliver('channel.subscription.new', payload, '01DUPLICATEEVENT0000000001')));
    expect(first.json().status).toBe('processed');
    expect(results.map((r) => r.json().status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(await getBalance(env.db, v.userId)).toBe(500);
    const subs = await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE kick_user_id = '810000003'`);
    expect(subs.rows[0]!.n).toBe(1);
  });

  it('rejects unsigned / forged webhooks', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/webhooks/kick',
      headers: {
        'content-type': 'application/json',
        'kick-event-message-id': 'x1',
        'kick-event-message-timestamp': new Date().toISOString(),
        'kick-event-signature': Buffer.from('nope').toString('base64'),
        'kick-event-type': 'channel.subscription.new',
      },
      payload: { broadcaster: bc, subscriber: kickUser(1, 'x') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('holds rewards for viewers who have not joined yet and pays them on first login', async () => {
    await deliver('channel.subscription.new', { broadcaster: bc, subscriber: kickUser(810000004, 'late_joiner'), duration: 1 });
    const pending = await env.db.query<{ reward_status: string }>(`SELECT reward_status FROM subscriptions WHERE kick_user_id = '810000004'`);
    expect(pending.rows[0]!.reward_status).toBe('PENDING_LINK');
    const v = await login(env, 'late_joiner', '810000004');
    expect(await getBalance(env.db, v.userId)).toBe(500);
    // A second login does not claim again
    await login(env, 'late_joiner', '810000004');
    expect(await getBalance(env.db, v.userId)).toBe(500);
  });

  it('applies the per-user daily reward cap (anti-abuse)', async () => {
    await streamer.patch(`/api/channels/${channelId}/settings`, { reward_daily_cap_per_user: 700 });
    const v = await login(env, 'capped_viewer', '810000005');
    await deliver('channel.subscription.new', { broadcaster: bc, subscriber: kickUser(810000005, 'capped_viewer') });
    await deliver('channel.subscription.renewal', { broadcaster: bc, subscriber: kickUser(810000005, 'capped_viewer') });
    await deliver('channel.subscription.renewal', { broadcaster: bc, subscriber: kickUser(810000005, 'capped_viewer') });
    expect(await getBalance(env.db, v.userId)).toBe(700);
    const statuses = (await env.db.query<{ reward_status: string }>(`SELECT reward_status FROM subscriptions WHERE kick_user_id = '810000005' ORDER BY created_at`)).rows.map((r) => r.reward_status);
    expect(statuses).toEqual(['AWARDED', 'CAPPED', 'CAPPED']);
    await streamer.patch(`/api/channels/${channelId}/settings`, { reward_daily_cap_per_user: 20000 });
  });

  it('respects rewards being disabled by the streamer', async () => {
    await streamer.patch(`/api/channels/${channelId}/settings`, { rewards_enabled: false });
    const v = await login(env, 'disabled_viewer', '810000006');
    await deliver('channel.subscription.new', { broadcaster: bc, subscriber: kickUser(810000006, 'disabled_viewer') });
    expect(await getBalance(env.db, v.userId)).toBe(0);
    await streamer.patch(`/api/channels/${channelId}/settings`, { rewards_enabled: true });
  });
});

describe('Kick gift-sub rewards', () => {
  it('rewards the gifter per gift + multi-gift bonus, and each linked giftee', async () => {
    const gifter = await login(env, 'big_gifter', '820000001');
    const giftee = await login(env, 'lucky_giftee', '820000002');
    const giftees = [kickUser(820000002, 'lucky_giftee'), ...[3, 4, 5, 6].map((i) => kickUser(820000000 + i, `anon_${i}`))];
    const res = await deliver('channel.subscription.gifts', { broadcaster: bc, gifter: kickUser(820000001, 'big_gifter'), giftees });
    expect(res.json().status).toBe('processed');
    // default: 750 per gift × 5 + multi-gift bonus 1000 (threshold 5)
    expect(await getBalance(env.db, gifter.userId)).toBe(750 * 5 + 1000);
    expect(await getBalance(env.db, giftee.userId)).toBe(100);
    const unlinked = await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE kind = 'GIFTED' AND reward_status = 'PENDING_LINK'`);
    expect(unlinked.rows[0]!.n).toBe(4);
  });

  it('caps the number of gifts rewarded per event', async () => {
    await streamer.patch(`/api/channels/${channelId}/settings`, { max_gifts_rewarded_per_event: 2, multi_gift_bonus_points: 0, giftee_reward_points: 0 });
    const gifter = await login(env, 'mass_gifter', '830000001');
    const giftees = Array.from({ length: 20 }, (_, i) => kickUser(830000100 + i, `g${i}`));
    await deliver('channel.subscription.gifts', { broadcaster: bc, gifter: kickUser(830000001, 'mass_gifter'), giftees });
    expect(await getBalance(env.db, gifter.userId)).toBe(750 * 2);
  });

  it('anonymous gifters earn nothing (no identity to credit)', async () => {
    const res = await deliver('channel.subscription.gifts', { broadcaster: bc, gifter: { is_anonymous: true, user_id: null, username: null }, giftees: [kickUser(840000001, 'x')] });
    expect(res.json().status).toBe('processed');
    const g = await env.db.query<{ reward_status: string; gifter_username: string }>(`SELECT reward_status, gifter_username FROM gift_subscriptions ORDER BY created_at DESC LIMIT 1`);
    expect(g.rows[0]).toEqual({ reward_status: 'NONE', gifter_username: 'Anonymous' });
  });

  it('duplicate gift deliveries never double-pay', async () => {
    await streamer.patch(`/api/channels/${channelId}/settings`, { max_gifts_rewarded_per_event: 50, multi_gift_bonus_points: 1000, giftee_reward_points: 100 });
    const gifter = await login(env, 'gifter_twice', '850000001');
    const p = { broadcaster: bc, gifter: kickUser(850000001, 'gifter_twice'), giftees: [kickUser(850000002, 'a')] };
    await deliver('channel.subscription.gifts', p, '01GIFTDUP0000000000000001');
    await deliver('channel.subscription.gifts', p, '01GIFTDUP0000000000000001');
    expect(await getBalance(env.db, gifter.userId)).toBe(750);
  });
});

describe('other Kick events', () => {
  it('ignores events for channels not on VoxDrop', async () => {
    const res = await deliver('channel.subscription.new', { broadcaster: { user_id: 1, username: 'x' }, subscriber: kickUser(2, 'y') });
    expect(res.json().status).toBe('ignored');
  });

  it('updates live status from livestream.status.updated', async () => {
    await deliver('livestream.status.updated', { broadcaster: bc, is_live: true, title: 'Now live!' });
    const s = await env.db.query<{ is_live: boolean; live_title: string }>('SELECT is_live, live_title FROM streamers WHERE id = $1', [channelId]);
    expect(s.rows[0]).toEqual({ is_live: true, live_title: 'Now live!' });
  });

  it('records malformed payloads as FAILED (visible to admins) and returns 500 for retry', async () => {
    const res = await deliver('channel.subscription.new', { broadcaster: 'not-an-object' });
    expect(res.statusCode).toBe(500);
    const w = await env.db.query<{ status: string; error: string }>(`SELECT status, error FROM webhook_events ORDER BY received_at DESC LIMIT 1`);
    expect(w.rows[0]!.status).toBe('FAILED');
  });
});

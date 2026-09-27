import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../server/events/bus.js';
import { Topic } from '../../server/events/bus.js';
import { becomeStreamer, grant, login, makeTestEnv, type Client, type TestEnv } from '../helpers/setup.js';

let env: TestEnv;
let streamer: Client;
let mod: Client;
let sid: string;

beforeAll(async () => {
  env = await makeTestEnv();
  streamer = await login(env, 'rt_streamer', '620000001');
  sid = await becomeStreamer(env, streamer, '620000001');
  await streamer.patch(`/api/channels/${sid}/settings`, { cooldown_seconds: 0, auto_queue_approved: false });
  mod = await login(env, 'rt_mod');
  await streamer.post(`/api/channels/${sid}/moderators`, { username: 'rt_mod' });
});
afterAll(() => env.close());

describe('real-time events', () => {
  it('publishes message + points events to the right topics after commit', async () => {
    const v = await login(env, 'rt_viewer');
    await grant(env, v.userId, 500);
    const seen: Array<{ topic: string; type: string }> = [];
    const unsubs = [
      env.ctx.bus.subscribe(Topic.channel(sid), (e: BusEvent) => seen.push({ topic: 'channel', type: e.type })),
      env.ctx.bus.subscribe(Topic.user(v.userId), (e: BusEvent) => seen.push({ topic: 'user', type: e.type })),
    ];
    const m = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'hello live' })).json().message;
    await mod.post(`/api/messages/${m.id}/approve`);
    unsubs.forEach((u) => u());
    expect(seen).toEqual(
      expect.arrayContaining([
        { topic: 'channel', type: 'message.created' },
        { topic: 'user', type: 'points.updated' },
        { topic: 'channel', type: 'message.approved' },
        { topic: 'user', type: 'message.approved' },
        { topic: 'user', type: 'notification.created' },
      ]),
    );
  });

  it('does not publish events for a transaction that rolled back', async () => {
    const v = await login(env, 'rt_poor');
    const seen: string[] = [];
    const un = env.ctx.bus.subscribe(Topic.channel(sid), (e: BusEvent) => seen.push(e.type));
    const r = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'no points' });
    un();
    expect(r.json().error.code).toBe('INSUFFICIENT_POINTS');
    expect(seen).toEqual([]);
  });

  it('SSE endpoints require auth or the overlay key', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/realtime' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/audio/events?token=wrong-key-000000` })).statusCode).toBe(404);
  });
});

describe('staff views', () => {
  it('the Approved tab can filter several statuses at once (APPROVED + QUEUED)', async () => {
    const v = await login(env, 'rt_multi');
    await grant(env, v.userId, 500);
    const m = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'approve me' })).json().message;
    await mod.post(`/api/messages/${m.id}/approve`); // auto-queue is off → stays APPROVED
    const res = await mod.get(`/api/channels/${sid}/messages?status=APPROVED,QUEUED`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((x: { id: string }) => x.id)).toContain(m.id);
    expect((await mod.get(`/api/channels/${sid}/messages?status=NOPE`)).statusCode).toBe(422);
  });

  it('moderators get the dashboard without revenue figures', async () => {
    const d = (await mod.get(`/api/channels/${sid}/dashboard`)).json();
    expect(d.cards.todayDonations).toEqual([]);
    expect(d.recentDonations).toEqual([]);
    expect((await mod.get(`/api/channels/${sid}/analytics`)).statusCode).toBe(403);
    expect((await streamer.get(`/api/channels/${sid}/analytics?range=30d`)).statusCode).toBe(200);
  });
});

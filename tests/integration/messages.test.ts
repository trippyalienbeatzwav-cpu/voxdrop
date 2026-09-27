import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBalance } from '../../server/services/points.js';
import { Topic } from '../../server/events/bus.js';
import { becomeStreamer, grant, login, makeTestEnv, type Client, type TestEnv } from '../helpers/setup.js';
import { tone } from '../helpers/audio.js';

let env: TestEnv;
let streamer: Client;
let mod: Client;
let sid: string;

beforeAll(async () => {
  env = await makeTestEnv();
  streamer = await login(env, 'msg_streamer', '600000001');
  sid = await becomeStreamer(env, streamer, '600000001');
  await streamer.patch(`/api/channels/${sid}/settings`, { cooldown_seconds: 0, daily_message_limit: 0, free_text_per_day: 0, blocked_words: ['badword'] });
  mod = await login(env, 'msg_mod');
  expect((await streamer.post(`/api/channels/${sid}/moderators`, { username: 'msg_mod' })).statusCode).toBe(200);
});
afterAll(() => env.close());

async function viewer(name: string, points = 1000) {
  const v = await login(env, name);
  if (points) await grant(env, v.userId, points);
  return v;
}

describe('message creation — server-side pricing and rules', () => {
  it('charges the streamer-configured price and ignores any client-sent price', async () => {
    const v = await viewer('pricey');
    const res = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'hello!', points: 1, price: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.pointsSpent).toBe(50);
    expect(res.json().message.status).toBe('PENDING');
    expect(await getBalance(env.db, v.userId)).toBe(950);
  });

  it('adds priority and bonus points server-side (legacy priority flag = PRIORITY tier)', async () => {
    const v = await viewer('booster');
    const res = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'priority!', priority: true, bonusPoints: 25 });
    // PRIORITY tier minimum (500) replaces the 50-point text price; bonus is added on top.
    expect(res.json().message.pointsSpent).toBe(500 + 25);
    expect(res.json().message.priorityTier).toBe('PRIORITY');
  });

  it('returns 402 INSUFFICIENT_POINTS without charging', async () => {
    const v = await viewer('broke', 10);
    const res = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'hi' });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('INSUFFICIENT_POINTS');
    expect(await getBalance(env.db, v.userId)).toBe(10);
  });

  it('enforces per-user cooldowns', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { cooldown_seconds: 60 });
    const v = await viewer('speedy');
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'one' })).statusCode).toBe(201);
    const second = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'two' });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('COOLDOWN_ACTIVE');
    expect(second.headers['retry-after']).toBeDefined();
    await streamer.patch(`/api/channels/${sid}/settings`, { cooldown_seconds: 0 });
  });

  it('enforces daily message limits', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { daily_message_limit: 2 });
    const v = await viewer('chatty');
    await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'a' });
    await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'b' });
    const third = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'c' });
    expect(third.json().error.code).toBe('LIMIT_REACHED');
    await streamer.patch(`/api/channels/${sid}/settings`, { daily_message_limit: 0 });
  });

  it('auto-rejects blocked words without charging, and records the attempt', async () => {
    const v = await viewer('potty');
    const res = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'you are a b.a.d.w.o.r.d' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('MESSAGE_BLOCKED');
    expect(await getBalance(env.db, v.userId)).toBe(1000);
    const rejected = (await streamer.get(`/api/channels/${sid}/messages?status=REJECTED`)).json().items;
    expect(rejected.some((m: { sender: { username: string } }) => m.sender.username === 'potty')).toBe(true);
  });

  it('rejects disabled message types', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { text_enabled: false });
    const v = await viewer('nope');
    const res = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'hi' });
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    await streamer.patch(`/api/channels/${sid}/settings`, { text_enabled: true });
  });

  it('enforces min/max points per message', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { min_points_per_message: 100, max_points_per_message: 300 });
    const v = await viewer('bounded');
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'cheap' })).json().error.code).toBe('VALIDATION_FAILED');
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'ok', bonusPoints: 50 })).statusCode).toBe(201);
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'big', bonusPoints: 500 })).json().error.code).toBe('VALIDATION_FAILED');
    await streamer.patch(`/api/channels/${sid}/settings`, { min_points_per_message: 0, max_points_per_message: 100000 });
  });

  it('Idempotency-Key makes retries safe (one message, one charge)', async () => {
    const v = await viewer('retrier');
    const h = { 'idempotency-key': 'retry-key-123456' };
    const a = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'once' }, h);
    const b = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'once' }, h);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().replayed).toBe(true);
    expect(b.json().message.id).toBe(a.json().message.id);
    expect(await getBalance(env.db, v.userId)).toBe(950);
  });

  it('free daily text allowance', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { free_text_per_day: 1 });
    const v = await viewer('freebie', 0);
    const first = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'free one' });
    expect(first.json().message.pointsSpent).toBe(0);
    const second = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'paid one' });
    expect(second.json().error.code).toBe('INSUFFICIENT_POINTS');
    await streamer.patch(`/api/channels/${sid}/settings`, { free_text_per_day: 0 });
  });
});

describe('voice messages', () => {
  it('uploads a recording and sends it as a voice message', async () => {
    const v = await viewer('voicey');
    const up = await v.upload(tone(3), 'recording.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
    expect(up.statusCode).toBe(201);
    const audio = up.json().audio;
    expect(audio.durationMs).toBe(3000);
    const res = await v.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: audio.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.pointsSpent).toBe(150);
    // The same recording cannot be sent twice
    const again = await v.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: audio.id });
    expect(again.json().error.code).toBe('AUDIO_ALREADY_USED');
  });

  it("cannot send someone else's audio", async () => {
    const owner = await viewer('audio_owner');
    const thief = await viewer('audio_thief');
    const up = await owner.upload(tone(2), 'mine.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
    const res = await thief.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: up.json().audio.id });
    expect(res.statusCode).toBe(404);
  });

  it('re-checks the channel duration limit at send time', async () => {
    const v = await viewer('longtalker');
    const up = await v.upload(tone(10), 'long.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
    await streamer.patch(`/api/channels/${sid}/settings`, { max_audio_seconds: 5 });
    const res = await v.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: up.json().audio.id });
    expect(res.json().error.code).toBe('AUDIO_TOO_LONG');
    await streamer.patch(`/api/channels/${sid}/settings`, { max_audio_seconds: 60 });
  });
});

describe('moderation', () => {
  it('viewers cannot approve messages (403)', async () => {
    const v = await viewer('sneaky');
    const m = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'approve me' })).json().message;
    const res = await v.post(`/api/messages/${m.id}/approve`);
    expect(res.statusCode).toBe(403);
  });

  it('moderators can approve → message is queued; sender is notified', async () => {
    const v = await viewer('approved_one');
    const m = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'pls' })).json().message;
    const res = await mod.post(`/api/messages/${m.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json().message.status).toBe('QUEUED');
    const notes = (await v.get('/api/notifications')).json().items;
    expect(notes[0].type).toBe('message.approved');
  });

  it('moderators cannot change channel settings', async () => {
    const res = await mod.patch(`/api/channels/${sid}/settings`, { price_text: 1 });
    expect(res.statusCode).toBe(403);
  });

  it('rejecting refunds the sender (per channel policy)', async () => {
    const v = await viewer('rejected_one');
    const m = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'meh' })).json().message;
    expect(await getBalance(env.db, v.userId)).toBe(950);
    await mod.post(`/api/messages/${m.id}/reject`, { reason: 'Not now' });
    expect(await getBalance(env.db, v.userId)).toBe(1000);
    const tx = (await v.get('/api/points/transactions')).json().items;
    expect(tx[0].type).toBe('POINTS_REFUNDED');
    // A second reject is refused and cannot refund twice
    const again = await mod.post(`/api/messages/${m.id}/reject`, {});
    expect(again.statusCode).toBe(409);
    expect(await getBalance(env.db, v.userId)).toBe(1000);
  });

  it('banning a user blocks sending and rejects their pending messages', async () => {
    const v = await viewer('troll');
    await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'spam 1' });
    const ban = await mod.post(`/api/channels/${sid}/users/${v.userId}/ban`, { reason: 'spam' });
    expect(ban.statusCode).toBe(200);
    expect(ban.json().cancelledMessages).toBe(1);
    expect(await getBalance(env.db, v.userId)).toBe(1000);
    const blocked = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'spam 2' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('BANNED');
    await mod.post(`/api/channels/${sid}/users/${v.userId}/unban`);
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'sorry' })).statusCode).toBe(201);
  });

  it('mutes expire and carry a duration', async () => {
    const v = await viewer('muted_one');
    await mod.post(`/api/channels/${sid}/users/${v.userId}/mute`, { minutes: 10, reason: 'cool down' });
    const r = await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'hi' });
    expect(r.json().error.code).toBe('BANNED');
    expect(r.json().error.details.kind).toBe('MUTE');
    await env.db.query(`UPDATE bans SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [v.userId]);
    expect((await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'back' })).statusCode).toBe(201);
  });

  it('the channel owner cannot be moderated by their moderators', async () => {
    const res = await mod.post(`/api/channels/${sid}/users/${streamer.userId}/ban`, { reason: 'coup' });
    expect(res.statusCode).toBe(403);
  });

  it('viewers can cancel their own pending message for a refund', async () => {
    const v = await viewer('changed_mind');
    const m = (await v.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'oops' })).json().message;
    expect((await v.post(`/api/messages/${m.id}/cancel`)).json().message.status).toBe('CANCELLED');
    expect(await getBalance(env.db, v.userId)).toBe(1000);
  });
});

describe('playback queue', () => {
  it('never plays two items at once; overlay "ended" advances to the next', async () => {
    // Reset: clear anything already queued in this channel.
    await env.db.query(`UPDATE playback_queue SET status = 'REMOVED' WHERE streamer_id = $1 AND status IN ('QUEUED','PLAYING')`, [sid]);
    await streamer.patch(`/api/channels/${sid}/settings`, { approval_mode: 'AUTO', playback_gap_ms: 0 });
    const v1 = await viewer('queue_one');
    const v2 = await viewer('queue_two');
    const a = (await v1.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'first' })).json().message;
    const b = (await v2.post('/api/messages', { streamerId: sid, type: 'TEXT', text: 'second' })).json().message;
    expect(a.status).toBe('QUEUED');

    // Simulate an OBS overlay connecting.
    const plays: string[] = [];
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), (e) => {
      if (e.type === 'overlay.play') plays.push((e.data as { message: { id: string } }).message.id);
    });
    const r1 = await streamer.post(`/api/channels/${sid}/queue/play-next`, {});
    expect(r1.statusCode).toBe(200);
    const r2 = await streamer.post(`/api/channels/${sid}/queue/play-next`, {});
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('ALREADY_PLAYING');
    const playing = await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM playback_queue WHERE streamer_id = $1 AND status = 'PLAYING'`, [sid]);
    expect(playing.rows[0]!.n).toBe(1);

    const overlayUrl = (await streamer.get(`/api/channels/${sid}/overlay`)).json().overlayUrl as string;
    const key = new URL(overlayUrl).searchParams.get('token')!;
    const itemId = r1.json().playing.itemId;
    const ended = await env.app.inject({ method: 'POST', url: `/api/overlay/${sid}/audio/playback?token=${key}`, payload: { itemId, event: 'ended' } });
    expect(ended.json().finished).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(plays).toEqual([a.id, b.id]);
    const aNow = (await v1.get(`/api/messages/${a.id}`)).json().message;
    expect(aNow.status).toBe('PLAYED');
    unsub();
    await streamer.patch(`/api/channels/${sid}/settings`, { approval_mode: 'MANUAL' });
  });

  it('overlay endpoints require the secret overlay key', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/overlay/${sid}/audio?token=wrong-key-123456` });
    expect(res.statusCode).toBe(404);
  });

  it('queue reorder rejects stale orderings', async () => {
    const res = await streamer.post(`/api/channels/${sid}/queue/reorder`, { itemIds: ['00000000-0000-0000-0000-000000000000'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('QUEUE_CHANGED');
  });
});

describe('sound effects', () => {
  it('streamer uploads a sound; viewer plays it; cooldown applies', async () => {
    const up = await streamer.upload(tone(1, 880), 'horn.wav', 'audio/wav', { streamerId: sid, purpose: 'SOUND' });
    expect(up.statusCode).toBe(201);
    const created = await streamer.post('/api/sounds', { streamerId: sid, audioFileId: up.json().audio.id, name: 'Air Horn', categorySlug: 'memes', pricePoints: 100, cooldownSeconds: 60 });
    expect(created.statusCode).toBe(201);
    const soundId = created.json().sound.id;
    const list = (await env.app.inject({ method: 'GET', url: '/api/sounds?streamer=msg_streamer' })).json().items;
    expect(list.map((s: { name: string }) => s.name)).toContain('Air Horn');

    const v = await viewer('honker');
    const play = await v.post('/api/messages', { streamerId: sid, type: 'SOUND', soundId });
    expect(play.statusCode).toBe(201);
    expect(play.json().message.pointsSpent).toBe(100);
    expect(play.json().message.status).toBe('QUEUED'); // sounds are pre-approved content
    const v2 = await viewer('honker2');
    const again = await v2.post('/api/messages', { streamerId: sid, type: 'SOUND', soundId });
    expect(again.json().error.code).toBe('COOLDOWN_ACTIVE');
  });

  it('viewers cannot upload sounds to a channel library', async () => {
    const v = await viewer('fake_streamer');
    const res = await v.upload(tone(1), 'x.wav', 'audio/wav', { streamerId: sid, purpose: 'SOUND' });
    expect(res.statusCode).toBe(403);
  });
});

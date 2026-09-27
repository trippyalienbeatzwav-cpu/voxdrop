import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../server/events/bus.js';
import { Topic } from '../../server/events/bus.js';
import { MockTtsService } from '../../server/integrations/tts/TTSService.js';
import { getBalance } from '../../server/services/points.js';
import { becomeStreamer, grant, login, makeTestEnv, type Client, type TestEnv } from '../helpers/setup.js';
import { fakeMp3, tone } from '../helpers/audio.js';

let env: TestEnv;
let streamer: Client;
let sid: string;
let key: string;
let tts: MockTtsService;

interface PlayPayload {
  itemId: string;
  message: { id: string; sender: { username: string } };
  announcement: { audioId: string; text: string } | null;
}

beforeAll(async () => {
  env = await makeTestEnv();
  tts = env.ctx.tts as MockTtsService;
  streamer = await login(env, 'ann_streamer', '630000001');
  sid = await becomeStreamer(env, streamer, '630000001');
  await streamer.patch(`/api/channels/${sid}/settings`, { cooldown_seconds: 0, approval_mode: 'AUTO', playback_gap_ms: 0 });
  await streamer.patch(`/api/channels/${sid}/priority`, { settings: { max_messages_per_viewer: 50 } });
  key = new URL((await streamer.get(`/api/channels/${sid}/overlay`)).json().overlayUrl).searchParams.get('token')!;
});
afterAll(() => env.close());

/** Simulated OBS overlay: records plays and channel events in order. */
let plays: PlayPayload[] = [];
let events: Array<{ type: string; itemId?: string }> = [];
let unsubs: Array<() => void> = [];
beforeEach(async () => {
  await env.db.query(`UPDATE playback_queue SET status = 'REMOVED' WHERE streamer_id = $1 AND status IN ('QUEUED','PLAYING')`, [sid]);
  plays = [];
  events = [];
  tts.failAlways = false;
  tts.failNext = 0;
  unsubs = [
    env.ctx.bus.subscribe(Topic.overlay(sid), (e: BusEvent) => {
      if (e.type === 'overlay.play') plays.push(e.data as PlayPayload);
      events.push({ type: e.type, itemId: (e.data as { itemId?: string }).itemId });
    }),
    env.ctx.bus.subscribe(Topic.channel(sid), (e: BusEvent) => {
      if (e.type.startsWith('announcement.') || e.type.startsWith('message.audio.')) events.push({ type: e.type, itemId: (e.data as { itemId: string }).itemId });
    }),
  ];
});
afterEach(() => unsubs.forEach((u) => u()));

const settle = () => new Promise((r) => setTimeout(r, 60));
const report = (itemId: string, event: string, detail?: string) =>
  env.app.inject({ method: 'POST', url: `/api/overlay/${sid}/audio/playback?token=${key}`, payload: { itemId, event, detail } });

async function viewer(name: string) {
  const v = await login(env, name);
  await grant(env, v.userId, 5000);
  return v;
}
async function sendVoice(v: Client) {
  const up = await v.upload(tone(1.5), 'rec.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
  const r = await v.post('/api/messages', { streamerId: sid, type: 'VOICE', audioFileId: up.json().audio.id });
  expect(r.statusCode).toBe(201);
  return r.json().message;
}
/** Plays one item exactly like the overlay: announcement → ended → viewer audio → ended. */
async function playThrough(p: PlayPayload) {
  if (p.announcement) {
    expect((await report(p.itemId, 'announcement_started')).statusCode).toBe(200);
    expect((await report(p.itemId, 'announcement_ended')).statusCode).toBe(200);
  }
  expect((await report(p.itemId, 'message_started')).statusCode).toBe(200);
  const r = await report(p.itemId, 'ended');
  expect(r.json().finished).toBe(true);
  await settle();
}

describe('announcement + viewer audio are one queue item', () => {
  it('plays A-announcement, A-audio, B-announcement, B-audio, C-announcement, C-audio — in that order', async () => {
    const a = await viewer('Alpha_Viewer');
    const b = await viewer('BravoViewer');
    const c = await viewer('charlie_v');
    // The first message auto-starts (the simulated overlay is online); the rest wait their turn.
    for (const v of [a, b, c]) await sendVoice(v);
    const unsubOverlay = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined); // overlay online
    await streamer.post(`/api/channels/${sid}/queue/play-next`, {});
    await settle();
    for (let i = 0; i < 3; i++) {
      expect(plays[i], `item ${i} should have started`).toBeTruthy();
      await playThrough(plays[i]!);
    }
    unsubOverlay();
    expect(plays.map((p) => p.announcement?.text)).toEqual(['Voice message from Alpha Viewer', 'Voice message from Bravo Viewer', 'Voice message from charlie v']);
    // Server-side event order: every item finishes completely before the next starts.
    const seq = events.filter((e) => e.type !== 'overlay.stop').map((e) => `${e.type}#${plays.findIndex((p) => p.itemId === e.itemId)}`);
    expect(seq).toEqual([
      'overlay.play#0', 'announcement.started#0', 'announcement.completed#0', 'message.audio.started#0', 'message.audio.completed#0',
      'overlay.play#1', 'announcement.started#1', 'announcement.completed#1', 'message.audio.started#1', 'message.audio.completed#1',
      'overlay.play#2', 'announcement.started#2', 'announcement.completed#2', 'message.audio.started#2', 'message.audio.completed#2',
    ]);
    const logRes = await streamer.get(`/api/channels/${sid}/playback-log`);
    const log = logRes.json().items;
    expect(log[0]).toMatchObject({ viewer_name: 'charlie v', phase: 'COMPLETED', announcement_status: 'PLAYED' });
    expect(typeof log[0].duration_ms).toBe('number');
  });

  it('refuses viewer audio before its announcement has finished (409) and never skips ahead', async () => {
    const v = await viewer('OrderCheck');
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    const p = plays.at(-1)!;
    expect(p.announcement).not.toBeNull();
    expect((await report(p.itemId, 'message_started')).statusCode).toBe(409);
    expect((await report(p.itemId, 'ended')).statusCode).toBe(409);
    await report(p.itemId, 'announcement_started');
    expect((await report(p.itemId, 'message_started')).statusCode).toBe(409); // still announcing
    await report(p.itemId, 'announcement_ended');
    await playThrough({ ...p, announcement: null });
  });

  it('duplicate / stale overlay events are harmless', async () => {
    const v1 = await viewer('DupeOne');
    const v2 = await viewer('DupeTwo');
    await sendVoice(v1);
    await sendVoice(v2);
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await streamer.post(`/api/channels/${sid}/queue/play-next`, {});
    await settle();
    const p = plays[0]!;
    for (const ev of ['announcement_started', 'announcement_started', 'announcement_ended', 'announcement_ended', 'message_started', 'message_started']) {
      expect((await report(p.itemId, ev)).statusCode).toBe(200);
    }
    const [e1, e2] = await Promise.all([report(p.itemId, "ended"), report(p.itemId, "ended")]);
    expect([e1.json().finished, e2.json().finished].filter(Boolean)).toHaveLength(1);
    await settle();
    expect((await report(p.itemId, 'ended')).json().ignored).toBe('not_current');
    unsub();
    expect(plays).toHaveLength(2); // the next item started exactly once
    expect(events.filter((e) => e.type === 'announcement.completed' && e.itemId === p.itemId)).toHaveLength(1);
  });

  it('skipping during the announcement stops both parts and moves on to the next item with its own announcement', async () => {
    const v1 = await viewer('SkipMe');
    const v2 = await viewer('AfterSkip');
    await sendVoice(v1);
    await sendVoice(v2);
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await streamer.post(`/api/channels/${sid}/queue/play-next`, {});
    await settle();
    const first = plays[0]!;
    await report(first.itemId, 'announcement_started');
    await streamer.post(`/api/channels/${sid}/queue/skip`, { itemId: first.itemId });
    await settle();
    unsub();
    expect(events.some((e) => e.type === 'overlay.stop' && e.itemId === first.itemId)).toBe(true);
    const row = (await env.db.query<{ phase: string; announcement_status: string }>('SELECT phase, announcement_status FROM playback_queue WHERE id = $1', [first.itemId])).rows[0];
    expect(row).toEqual({ phase: 'SKIPPED', announcement_status: 'SKIPPED' });
    // Late events from the skipped item are ignored.
    expect((await report(first.itemId, 'announcement_ended')).json().ignored).toBe('not_current');
    expect(plays[1]!.announcement!.text).toBe('Voice message from After Skip');
    await playThrough(plays[1]!);
  });
});

describe('failures', () => {
  it('failed TTS: the viewer audio still plays, without an announcement, and the error is logged', async () => {
    tts.failAlways = true;
    const v = await viewer('TtsBroken');
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    const p = plays.at(-1)!;
    expect(p.announcement).toBeNull();
    expect(events.some((e) => e.type === 'announcement.failed')).toBe(true);
    await playThrough(p);
    const log = (await streamer.get(`/api/channels/${sid}/playback-log`)).json().items[0];
    expect(log).toMatchObject({ announcement_status: 'FAILED', phase: 'COMPLETED' });
    expect(log.error).toMatch(/Mock TTS failure/);
  });

  it('announcement audio failing to load in OBS falls through to the viewer audio', async () => {
    const v = await viewer('LoadFail');
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    const p = plays.at(-1)!;
    expect((await report(p.itemId, 'announcement_error', 'MEDIA_ERR_NETWORK')).statusCode).toBe(200);
    expect(events.some((e) => e.type === 'announcement.failed' && e.itemId === p.itemId)).toBe(true);
    await playThrough({ ...p, announcement: null });
  });

  it('viewer audio failing to load marks the item FAILED and refunds the viewer', async () => {
    const v = await viewer('AudioFail');
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    const before = await getBalance(env.db, v.userId);
    const p = plays.at(-1)!;
    await report(p.itemId, 'announcement_started');
    await report(p.itemId, 'announcement_ended');
    await report(p.itemId, 'message_started');
    const r = await report(p.itemId, 'error', 'MEDIA_ERR_DECODE');
    expect(r.json().finished).toBe(true);
    expect(await getBalance(env.db, v.userId)).toBe(before + 150);
    const log = (await streamer.get(`/api/channels/${sid}/playback-log`)).json().items[0];
    expect(log.phase).toBe('FAILED');
  });
});

describe('settings, caching and names', () => {
  it('disabled announcements play the viewer audio immediately (no TTS)', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { announce_enabled: false });
    const calls = tts.calls.length;
    const v = await viewer('NoAnnounce');
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    expect(plays.at(-1)!.announcement).toBeNull();
    expect(tts.calls.length).toBe(calls);
    await playThrough(plays.at(-1)!);
    await streamer.patch(`/api/channels/${sid}/settings`, { announce_enabled: true });
  });

  it('announcement types: MP3 uses its own template; excluded types are not announced', async () => {
    const v = await viewer('ClipSender');
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    const up = await v.upload(fakeMp3(60), 'clip.mp3', 'audio/mpeg', { streamerId: sid, purpose: 'MESSAGE' });
    await v.post('/api/messages', { streamerId: sid, type: 'MP3', audioFileId: up.json().audio.id });
    await settle();
    expect(plays.at(-1)!.announcement!.text).toBe('Audio message from Clip Sender');
    await playThrough(plays.at(-1)!);
    await streamer.patch(`/api/channels/${sid}/settings`, { announce_types: ['VOICE'] });
    const up2 = await v.upload(fakeMp3(60), 'clip.mp3', 'audio/mpeg', { streamerId: sid, purpose: 'MESSAGE' });
    await v.post('/api/messages', { streamerId: sid, type: 'MP3', audioFileId: up2.json().audio.id });
    await settle();
    unsub();
    expect(plays.at(-1)!.announcement).toBeNull();
    await playThrough(plays.at(-1)!);
    await streamer.patch(`/api/channels/${sid}/settings`, { announce_types: ['VOICE', 'MP3', 'DONATION'] });
  });

  it('caches identical announcements and invalidates the cache when settings change', async () => {
    const v = await viewer('CacheViewer');
    const countFor = (text: string) => tts.calls.filter((c) => c.text === text).length;
    await sendVoice(v);
    await sendVoice(v);
    await settle();
    await env.db.query(`UPDATE playback_queue SET status = 'REMOVED' WHERE streamer_id = $1 AND status IN ('QUEUED','PLAYING')`, [sid]);
    expect(countFor('Voice message from Cache Viewer')).toBe(1);
    const cached = await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM announcement_cache WHERE streamer_id = $1 AND spoken_text = 'Voice message from Cache Viewer'`, [sid]);
    expect(cached.rows[0]!.n).toBe(1);

    await streamer.patch(`/api/channels/${sid}/settings`, { announce_speed: 1.25 });
    const after = await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM announcement_cache WHERE streamer_id = $1`, [sid]);
    expect(after.rows[0]!.n).toBe(0);
    await sendVoice(v);
    await settle();
    expect(countFor('Voice message from Cache Viewer')).toBe(2);
    expect(tts.calls.at(-1)!.speed).toBe(1.25);

    await streamer.patch(`/api/channels/${sid}/settings`, { announce_template_voice: 'Next message from {viewerName}', announce_speed: 1 });
    await sendVoice(v);
    await settle();
    expect(countFor('Next message from Cache Viewer')).toBe(1);
    await streamer.patch(`/api/channels/${sid}/settings`, { announce_template_voice: 'Voice message from {viewerName}' });
  });

  it('malicious Kick usernames are sanitised before reaching the TTS engine', async () => {
    const v = await viewer('mal_viewer');
    await env.db.query(`UPDATE kick_accounts SET kick_username = $2 WHERE user_id = $1`, [v.userId, '<speak><break time="60s"/><audio src="https://evil/x.mp3"/></speak>']);
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    const p = plays.at(-1)!;
    expect(p.announcement!.text).toBe('Voice message from a viewer'); // contains a URL → fallback
    expect(tts.calls.at(-1)!.text).not.toMatch(/[<>"=/]/);
    await playThrough(p);

    await env.db.query(`UPDATE kick_accounts SET kick_username = $2 WHERE user_id = $1`, [v.userId, 'Nice<script>Name</script>']);
    const unsub2 = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub2();
    expect(plays.at(-1)!.announcement!.text).toBe('Voice message from Nice script Name script');
    await playThrough(plays.at(-1)!);
  });

  it('uses the Kick username, not the editable VoxDrop display name', async () => {
    const v = await viewer('RealKickName');
    await v.patch('/api/me', { displayName: 'Pretend Admin' });
    const unsub = env.ctx.bus.subscribe(Topic.overlay(sid), () => undefined);
    await sendVoice(v);
    await settle();
    unsub();
    expect(plays.at(-1)!.announcement!.text).toBe('Voice message from Real Kick Name');
    await playThrough(plays.at(-1)!);
  });

  it('rejects templates with no speakable text', async () => {
    const r = await streamer.patch(`/api/channels/${sid}/settings`, { announce_template_voice: '<<<>>>' });
    expect(r.statusCode).toBe(422);
  });

  it('preview returns WAV audio (owner only); queue preview generates on demand', async () => {
    const r = await streamer.post(`/api/channels/${sid}/announcements/preview`, { announce_template_voice: '{viewerName} sent a voice message', viewerName: 'TrippyAlien' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/wav');
    expect(decodeURIComponent(String(r.headers['x-announcement-text']))).toBe('Trippy Alien sent a voice message');
    const mod = await login(env, 'ann_mod');
    await streamer.post(`/api/channels/${sid}/moderators`, { username: 'ann_mod' });
    expect((await mod.post(`/api/channels/${sid}/announcements/preview`, {})).statusCode).toBe(403);

    const v = await viewer('QueuePreview');
    await sendVoice(v); // no overlay → stays queued
    const q = (await streamer.get(`/api/channels/${sid}/queue`)).json();
    const item = [q.nowPlaying, ...q.items].find((i: { viewerName: string } | null) => i?.viewerName === 'QueuePreview');
    expect(item.announcementEnabled).toBe(true);
    const gen = (await mod.post(`/api/channels/${sid}/queue/${item.queue.itemId}/announcement`)).json().announcement;
    expect(gen).toMatchObject({ status: 'READY', text: 'Voice message from Queue Preview' });
    expect((await mod.get(`/api/audio/${gen.audioId}/stream`)).statusCode).toBe(200);
    expect((await v.get(`/api/audio/${gen.audioId}/stream`)).statusCode).toBe(404); // viewers can't fetch channel TTS
  });
});

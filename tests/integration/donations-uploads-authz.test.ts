import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBalance } from '../../server/services/points.js';
import { becomeStreamer, login, makeTestEnv, type Client, type TestEnv } from '../helpers/setup.js';
import { fakeMp3, tone } from '../helpers/audio.js';

let env: TestEnv;
let streamer: Client;
let sid: string;
let otherStreamer: Client;
let otherSid: string;

beforeAll(async () => {
  env = await makeTestEnv();
  streamer = await login(env, 'money_streamer', '610000001');
  sid = await becomeStreamer(env, streamer, '610000001');
  otherStreamer = await login(env, 'other_streamer', '610000002');
  otherSid = await becomeStreamer(env, otherStreamer, '610000002');
});
afterAll(() => env.close());

async function payMock(checkoutUrl: string, client: Client, outcome: 'pay' | 'decline' = 'pay') {
  const sessionId = checkoutUrl.split('/').pop()!;
  return client.post(`/api/dev/mock-checkout/${sessionId}/${outcome}`);
}

describe('donations (money is separate from points)', () => {
  it('pending → paid via verified webhook → completed, with message queued for review', async () => {
    const donor = await login(env, 'donor_1');
    const start = await donor.post('/api/donations', { streamerId: sid, amountCents: 500, message: 'Great stream!' });
    expect(start.statusCode).toBe(201);
    const { donationId, checkoutUrl } = start.json();
    expect((await donor.get(`/api/donations/${donationId}`)).json().donation.status).toBe('PENDING');

    const paid = await payMock(checkoutUrl, donor);
    expect(paid.json().webhook.httpStatus).toBe(200);
    const d = (await donor.get(`/api/donations/${donationId}`)).json().donation;
    expect(d.status).toBe('COMPLETED');
    // Money never touches points
    expect(await getBalance(env.db, donor.userId)).toBe(0);
    const pending = (await streamer.get(`/api/channels/${sid}/messages?status=PENDING`)).json().items;
    expect(pending[0].donation.amountCents).toBe(500);
    expect(pending[0].text).toBe('Great stream!');
    const feed = (await streamer.get(`/api/channels/${sid}/donations`)).json();
    expect(feed.items[0].status).toBe('COMPLETED');
  });

  it('declined payments mark the donation FAILED', async () => {
    const donor = await login(env, 'donor_2');
    const { donationId, checkoutUrl } = (await donor.post('/api/donations', { streamerId: sid, amountCents: 300 })).json();
    await payMock(checkoutUrl, donor, 'decline');
    expect((await donor.get(`/api/donations/${donationId}`)).json().donation.status).toBe('FAILED');
  });

  it('enforces the streamer donation min/max', async () => {
    const donor = await login(env, 'donor_3');
    const res = await donor.post('/api/donations', { streamerId: sid, amountCents: 10 });
    expect(res.statusCode).toBe(422);
  });

  it('a payment whose amount does not match the provider record is NOT fulfilled', async () => {
    const donor = await login(env, 'donor_4');
    const { donationId, checkoutUrl } = (await donor.post('/api/donations', { streamerId: sid, amountCents: 1000 })).json();
    // Tamper with our record so it disagrees with the provider (e.g. a bug or attack)
    await env.db.query(`UPDATE payments SET amount_cents = 100 WHERE id = (SELECT payment_id FROM donations WHERE id = $1)`, [donationId]);
    const r = await payMock(checkoutUrl, donor);
    expect(r.json().webhook.httpStatus).toBe(500);
    expect((await donor.get(`/api/donations/${donationId}`)).json().donation.status).toBe('PENDING');
  });

  it('duplicate payment webhooks do not double-fulfil', async () => {
    const buyer = await login(env, 'points_buyer');
    const pkg = (await env.app.inject({ method: 'GET', url: '/api/points/packages' })).json().items[0];
    const { checkoutUrl } = (await buyer.post('/api/points/purchase', { packageId: pkg.id })).json();
    const sessionId = checkoutUrl.split('/').pop()!;
    env.ctx.mockPayments!.simulate(sessionId, 'paid');
    const signed = env.ctx.mockPayments!.signedWebhook({ id: 'evt_dup_1', type: 'checkout.completed', sessionId });
    const a = await env.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: signed.headers, payload: signed.body });
    const b = await env.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: signed.headers, payload: signed.body });
    // Different event id, same session: state guard prevents re-fulfilment
    const c2 = env.ctx.mockPayments!.signedWebhook({ id: 'evt_dup_2', type: 'checkout.completed', sessionId });
    await env.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: c2.headers, payload: c2.body });
    expect(a.json().status).toBe('processed');
    expect(b.json().status).toBe('duplicate');
    expect(await getBalance(env.db, buyer.userId)).toBe(pkg.points);
    const tx = (await buyer.get('/api/points/transactions')).json().items;
    expect(tx).toHaveLength(1);
    expect(tx[0].type).toBe('POINTS_PURCHASED');
  });

  it('forged payment webhooks are rejected', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: { 'content-type': 'application/json', 'x-mock-signature': 't=1,v1=' + 'a'.repeat(64) }, payload: { id: 'x', type: 'checkout.completed', sessionId: 'y' } });
    expect(res.statusCode).toBe(401);
  });

  it('owner can refund a completed donation; moderators cannot', async () => {
    const donor = await login(env, 'donor_refund');
    const { donationId, checkoutUrl } = (await donor.post('/api/donations', { streamerId: sid, amountCents: 700 })).json();
    await payMock(checkoutUrl, donor);
    const mod = await login(env, 'money_mod');
    await streamer.post(`/api/channels/${sid}/moderators`, { username: 'money_mod' });
    expect((await mod.post(`/api/channels/${sid}/donations/${donationId}/refund`, {})).statusCode).toBe(403);
    const r = await streamer.post(`/api/channels/${sid}/donations/${donationId}/refund`, { reason: 'Test' });
    expect(r.statusCode).toBe(200);
    expect((await donor.get(`/api/donations/${donationId}`)).json().donation.status).toBe('REFUNDED');
    const notes = (await donor.get('/api/notifications')).json().items;
    expect(notes.some((n: { type: string }) => n.type === 'donation.refunded')).toBe(true);
  });
});

describe('audio upload security', () => {
  it('accepts a valid MP3 and stores only the audio frames', async () => {
    const v = await login(env, 'mp3_user');
    const res = await v.upload(fakeMp3(120, 180, { id3: true }), 'clip.mp3', 'audio/mpeg', { streamerId: sid, purpose: 'MESSAGE' });
    expect(res.statusCode).toBe(201);
    const stored = [...env.storage.objects.values()].pop()!;
    expect(stored.body.length).toBe(120 * 417);
    expect(stored.contentType).toBe('audio/mpeg');
  });

  it('rejects a renamed non-audio file', async () => {
    const v = await login(env, 'evil_uploader');
    const res = await v.upload(Buffer.from('MZ' + 'x'.repeat(5000)), 'song.mp3', 'audio/mpeg', { streamerId: sid, purpose: 'MESSAGE' });
    expect(res.statusCode).toBe(415);
    const jobs = await env.db.query<{ status: string; error_code: string }>(`SELECT status, error_code FROM audio_processing_jobs ORDER BY created_at DESC LIMIT 1`);
    expect(jobs.rows[0]).toEqual({ status: 'FAILED', error_code: 'UNSUPPORTED_MEDIA' });
  });

  it('enforces the channel file size limit', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { max_file_bytes: 65536 });
    const v = await login(env, 'big_uploader');
    const res = await v.upload(tone(5, 440, 0.5, 44100), 'big.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    await streamer.patch(`/api/channels/${sid}/settings`, { max_file_bytes: 8388608 });
  });

  it('enforces the channel duration limit', async () => {
    await streamer.patch(`/api/channels/${sid}/settings`, { max_audio_seconds: 5 });
    const v = await login(env, 'long_uploader');
    const res = await v.upload(tone(8), 'long.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' });
    expect(res.json().error.code).toBe('AUDIO_TOO_LONG');
    await streamer.patch(`/api/channels/${sid}/settings`, { max_audio_seconds: 60 });
  });

  it('requires authentication to upload', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/audio/upload', headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--' });
    expect(res.statusCode).toBe(401);
  });

  it('only the owner / channel staff can stream a message recording', async () => {
    const owner = await login(env, 'rec_owner');
    const up = (await owner.upload(tone(2), 'r.wav', 'audio/wav', { streamerId: sid, purpose: 'MESSAGE' })).json().audio;
    expect((await owner.get(`/api/audio/${up.id}/stream`)).statusCode).toBe(200);
    expect((await streamer.get(`/api/audio/${up.id}/stream`)).statusCode).toBe(200);
    const stranger = await login(env, 'stranger');
    expect((await stranger.get(`/api/audio/${up.id}/stream`)).statusCode).toBe(404);
    expect((await otherStreamer.get(`/api/audio/${up.id}/stream`)).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: `/api/audio/${up.id}/stream` })).statusCode).toBe(404);
    const ranged = await env.app.inject({ method: 'GET', url: `/api/audio/${up.id}/stream`, headers: { cookie: owner.cookie, range: 'bytes=0-99' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.length).toBe(100);
  });
});

describe('role-based authorization (enforced server-side)', () => {
  it('a streamer cannot manage another streamer’s channel', async () => {
    expect((await otherStreamer.patch(`/api/channels/${sid}/settings`, { price_text: 1 })).statusCode).toBe(403);
    expect((await otherStreamer.get(`/api/channels/${sid}/messages`)).statusCode).toBe(403);
    expect((await otherStreamer.get(`/api/channels/${sid}/donations`)).statusCode).toBe(403);
    expect((await streamer.get(`/api/channels/${otherSid}/queue`)).statusCode).toBe(403);
  });

  it('viewers cannot reach streamer or admin endpoints', async () => {
    const v = await login(env, 'plain_viewer');
    expect((await v.get(`/api/channels/${sid}/dashboard`)).statusCode).toBe(403);
    expect((await v.get('/api/streamer/dashboard')).statusCode).toBe(403);
    expect((await v.get('/api/admin/overview')).statusCode).toBe(403);
    expect((await v.post(`/api/admin/users/${v.userId}/suspend`, { reason: 'x' })).statusCode).toBe(403);
  });

  it('admins can suspend users, adjust points (ledgered) and see webhooks', async () => {
    const admin = await login(env, 'the_admin');
    await env.db.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.userId]);
    const target = await login(env, 'adjust_me');
    const adj = await admin.post(`/api/admin/users/${target.userId}/points-adjust`, { amount: 250, reason: 'Support ticket #1' });
    expect(adj.statusCode).toBe(200);
    expect(await getBalance(env.db, target.userId)).toBe(250);
    const tx = (await target.get('/api/points/transactions')).json().items[0];
    expect(tx.type).toBe('POINTS_ADJUSTED');
    expect((await admin.get('/api/admin/webhooks')).statusCode).toBe(200);
    expect((await admin.post(`/api/admin/users/${target.userId}/suspend`, { reason: 'abuse' })).statusCode).toBe(200);
    expect((await target.get('/api/me')).json().user).toBeNull(); // sessions revoked
    const logs = (await admin.get('/api/admin/audit-logs?action=admin.')).json().items;
    expect(logs.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['admin.points_adjusted', 'admin.user_suspended']));
  });

  it('audit logs are immutable', async () => {
    await expect(env.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });
});

import { describe, expect, it } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { cleanText, findBlockedWord } from '../../server/lib/text.js';
import { Secrets } from '../../server/lib/crypto.js';
import { safeRedirect } from '../../server/auth/oauth.js';
import { KICK_DOCUMENTED_PUBLIC_KEY, KickWebhookService } from '../../server/integrations/kick/KickWebhookService.js';
import { MockKickService } from '../../server/integrations/kick/MockKickService.js';
import { MockPaymentService } from '../../server/integrations/payments/PaymentService.js';
import { loadConfig } from '../../server/config.js';

describe('Kick webhook signature verification', () => {
  const mock = new MockKickService('http://localhost:5173');
  const svc = new KickWebhookService(async () => mock.publicKeyPem);

  it('accepts a correctly signed delivery', async () => {
    const s = mock.signEvent('channel.subscription.new', { hello: 'world' });
    const v = await svc.verify(s.headers, s.body);
    expect(v.type).toBe('channel.subscription.new');
    expect(v.payload).toEqual({ hello: 'world' });
  });

  it('rejects a tampered body', async () => {
    const s = mock.signEvent('channel.subscription.new', { points: 1 });
    await expect(svc.verify(s.headers, Buffer.from(JSON.stringify({ points: 1_000_000 })))).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('rejects a signature from a different key', async () => {
    const other = new MockKickService('http://localhost:5173');
    const s = other.signEvent('channel.followed', {});
    await expect(svc.verify(s.headers, s.body)).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('rejects stale timestamps (replay window)', async () => {
    const s = mock.signEvent('channel.followed', {}, { timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await expect(svc.verify(s.headers, s.body)).rejects.toMatchObject({ code: 'WEBHOOK_STALE' });
  });

  it('rejects missing headers', async () => {
    await expect(svc.verify({}, Buffer.from('{}'))).rejects.toMatchObject({ code: 'WEBHOOK_INVALID' });
  });

  it('ships a parseable copy of Kick’s documented public key', () => {
    expect(createPublicKey(KICK_DOCUMENTED_PUBLIC_KEY).asymmetricKeyType).toBe('rsa');
  });
});

describe('mock payment webhook signatures', () => {
  it('verifies HMAC signatures and rejects forgeries', () => {
    const p = new MockPaymentService('http://localhost', 'secret-a');
    const signed = p.signedWebhook({ id: 'evt_1', type: 'checkout.completed', sessionId: 'cs_1' });
    expect(p.parseWebhook(signed.body, signed.headers)).toMatchObject({ kind: 'checkout.completed', sessionId: 'cs_1' });
    const forged = new MockPaymentService('http://localhost', 'secret-b').signedWebhook({ id: 'evt_1', type: 'checkout.completed', sessionId: 'cs_1' });
    expect(() => p.parseWebhook(forged.body, forged.headers)).toThrow(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID' }));
  });
});

describe('text sanitisation & blocked words', () => {
  it('strips control and bidi-override characters', () => {
    expect(cleanText('hi\u202Eevil\u0000 there\u200B', 100)).toBe('hievil there');
  });
  it('matches blocked words including simple obfuscation', () => {
    expect(findBlockedWord('this is a SCAM', ['scam'])).toBe('scam');
    expect(findBlockedWord('free v-bucks here', ['free vbucks'])).toBe('free vbucks');
    expect(findBlockedWord('5c4m alert', ['scam'])).toBe('scam');
    expect(findBlockedWord('scampi is tasty', ['scam'])).toBeNull();
  });
});

describe('crypto helpers', () => {
  it('encrypts tokens with authenticated encryption', () => {
    const s = new Secrets('x'.repeat(40));
    const c = s.encrypt('kick-access-token');
    expect(c).not.toContain('kick-access-token');
    expect(s.decrypt(c)).toBe('kick-access-token');
    const tampered = c.slice(0, -2) + (c.endsWith('A') ? 'BB' : 'AA');
    expect(() => s.decrypt(tampered)).toThrow();
  });
  it('hashes IPs with a keyed hash (no raw IP storage)', () => {
    const s = new Secrets('x'.repeat(40));
    expect(s.hashIp('203.0.113.9')).toMatch(/^[0-9a-f]{24}$/);
    expect(s.hashIp('203.0.113.9')).not.toBe(new Secrets('y'.repeat(40)).hashIp('203.0.113.9'));
  });
});

describe('open-redirect protection', () => {
  it('only allows same-origin relative paths', () => {
    expect(safeRedirect('/streamers')).toBe('/streamers');
    expect(safeRedirect('https://evil.com')).toBe('/home');
    expect(safeRedirect('//evil.com')).toBe('/home');
    expect(safeRedirect('/\\evil.com')).toBe('/home');
  });
});

describe('production config guard', () => {
  it('refuses to start production with any mock service', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'z'.repeat(40), APP_URL: 'https://voxdrop.example', DATABASE_URL: 'postgres://x', KICK_MODE: 'mock', PAYMENT_PROVIDER: 'mock', STORAGE_PROVIDER: 'mock' }),
    ).toThrow(/MockKickService.*development-only/s);
  });
});

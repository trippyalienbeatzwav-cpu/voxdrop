import { createVerify } from 'node:crypto';
import { AppError } from '../../lib/errors.js';
import type { VerifiedKickEvent } from './types.js';

/** Published at https://docs.kick.com/events/webhook-security (used if the key endpoint is unreachable). */
export const KICK_DOCUMENTED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

export type PublicKeyProvider = () => Promise<string>;

/** Fetches Kick's webhook public key and caches it for an hour. */
export function livePublicKeyProvider(override: string, fetchImpl: typeof fetch = fetch): PublicKeyProvider {
  let cached: { pem: string; at: number } | null = override ? { pem: override, at: Infinity } : null;
  return async () => {
    if (cached && Date.now() - cached.at < 3600_000) return cached.pem;
    try {
      const res = await fetchImpl('https://api.kick.com/public/v1/public-key', { signal: AbortSignal.timeout(5000) });
      const j = (await res.json()) as { data?: { public_key?: string } };
      const pem = j.data?.public_key;
      if (res.ok && pem?.includes('BEGIN PUBLIC KEY')) {
        cached = { pem, at: Date.now() };
        return pem;
      }
    } catch {
      /* fall back */
    }
    return cached?.pem ?? KICK_DOCUMENTED_PUBLIC_KEY;
  };
}

const MAX_SKEW_MS = 10 * 60 * 1000;

/**
 * Verifies Kick webhook deliveries: RSA-SHA256 (PKCS#1 v1.5) signature over
 * `${Kick-Event-Message-Id}.${Kick-Event-Message-Timestamp}.${rawBody}`, plus a
 * timestamp freshness window to limit replay. Idempotency on the message id is
 * enforced separately by the unique (provider, event_id) constraint.
 */
export class KickWebhookService {
  constructor(
    private readonly getPublicKey: PublicKeyProvider,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<VerifiedKickEvent> {
    const h = (name: string) => {
      const v = headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const messageId = h('kick-event-message-id');
    const timestamp = h('kick-event-message-timestamp');
    const signature = h('kick-event-signature');
    const type = h('kick-event-type');
    const version = h('kick-event-version') ?? '1';
    if (!messageId || !timestamp || !signature || !type) throw new AppError(400, 'WEBHOOK_INVALID', 'Missing Kick webhook headers');
    if (messageId.length > 100 || type.length > 100) throw new AppError(400, 'WEBHOOK_INVALID', 'Malformed webhook headers');

    const ts = Date.parse(timestamp);
    if (Number.isNaN(ts) || Math.abs(this.now() - ts) > MAX_SKEW_MS) throw new AppError(401, 'WEBHOOK_STALE', 'Webhook timestamp outside allowed window');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${messageId}.${timestamp}.`);
    verifier.update(rawBody);
    let ok = false;
    try {
      ok = verifier.verify(await this.getPublicKey(), Buffer.from(signature, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid Kick webhook signature');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError(400, 'WEBHOOK_INVALID', 'Webhook body is not JSON');
    }
    return { messageId, subscriptionId: h('kick-event-subscription-id') ?? null, type, version, timestamp, payload };
  }
}

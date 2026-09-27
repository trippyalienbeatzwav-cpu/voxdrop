import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** PKCE (RFC 7636) S256 pair. */
export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Secrets derived from SESSION_SECRET via HKDF so each purpose gets an
 * independent key. Token encryption uses AES-256-GCM.
 */
export class Secrets {
  private readonly encKey: Buffer;
  private readonly ipPepper: Buffer;

  constructor(sessionSecret: string) {
    this.encKey = Buffer.from(hkdfSync('sha256', sessionSecret, 'voxdrop', 'token-encryption-v1', 32));
    this.ipPepper = Buffer.from(hkdfSync('sha256', sessionSecret, 'voxdrop', 'ip-hash-v1', 32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /**
   * Keyed, truncated hash of the client IP: lets us correlate abuse from one
   * address without storing the raw IP (privacy by default).
   */
  hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHmac('sha256', this.ipPepper).update(ip).digest('hex').slice(0, 24);
  }
}

/**
 * ███ DEVELOPMENT ONLY ███
 * MockKickService stands in for Kick's OAuth server and webhook sender so the
 * whole platform can be exercised without Kick credentials. config.ts refuses
 * to start with KICK_MODE=mock when NODE_ENV=production.
 *
 * It deliberately runs through the SAME code paths as live mode:
 *  - PKCE is really verified (the S256 challenge travels inside the mock code),
 *  - webhooks are really RSA-signed and verified by KickWebhookService.
 */
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { AppError, Errors } from '../../lib/errors.js';
import type { KickApiService, KickAuthService, KickChannel, KickIdentity, KickTokens } from './types.js';

interface MockCodePayload {
  kickUserId: string;
  username: string;
  profilePicture: string | null;
  challenge: string;
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = <T>(s: string): T => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;

export class MockKickService implements KickAuthService, KickApiService {
  readonly mode = 'mock' as const;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly publicKeyPem = this.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  constructor(private readonly appUrl: string) {}

  buildAuthorizeUrl({ state, codeChallenge, scopes }: { state: string; codeChallenge: string; scopes: string[] }) {
    const u = new URL('/dev/mock-kick', this.appUrl);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('scope', scopes.join(' '));
    return u.toString();
  }

  /** Called by the dev-only mock consent page to mint an authorization code. */
  issueCode(identity: { kickUserId: string; username: string; profilePicture?: string | null }, codeChallenge: string) {
    if (!/^[A-Za-z0-9_]{3,25}$/.test(identity.username)) throw Errors.validation('Username must be 3–25 letters, digits or _');
    return 'mock_' + enc({ ...identity, profilePicture: identity.profilePicture ?? null, challenge: codeChallenge } satisfies MockCodePayload);
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<KickTokens> {
    if (!code.startsWith('mock_')) throw new AppError(400, 'KICK_AUTH_FAILED', 'Invalid authorization code');
    let p: MockCodePayload;
    try {
      p = dec<MockCodePayload>(code.slice(5));
    } catch {
      throw new AppError(400, 'KICK_AUTH_FAILED', 'Invalid authorization code');
    }
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (challenge !== p.challenge) throw new AppError(400, 'KICK_AUTH_FAILED', 'PKCE verification failed');
    const identity: KickIdentity = { kickUserId: p.kickUserId, username: p.username, profilePicture: p.profilePicture };
    return { accessToken: 'mockat_' + enc(identity), refreshToken: 'mockrt_' + enc(identity), expiresIn: 3600, scope: 'user:read channel:read events:subscribe' };
  }

  async refresh(refreshToken: string): Promise<KickTokens> {
    if (!refreshToken.startsWith('mockrt_')) throw Errors.unauthorized('Kick authorization expired');
    const identity = refreshToken.slice(7);
    return { accessToken: 'mockat_' + identity, refreshToken, expiresIn: 3600, scope: 'user:read channel:read events:subscribe' };
  }

  async revoke() {}

  async getCurrentUser(accessToken: string): Promise<KickIdentity> {
    if (!accessToken.startsWith('mockat_')) throw Errors.unauthorized('Kick authorization expired or was revoked');
    return dec<KickIdentity>(accessToken.slice(7));
  }

  async getOwnChannel(accessToken: string): Promise<KickChannel> {
    const me = await this.getCurrentUser(accessToken);
    return {
      broadcasterUserId: me.kickUserId,
      slug: me.username.toLowerCase(),
      description: `${me.username}'s channel (mock Kick data)`,
      bannerPicture: null,
      isLive: false,
      streamTitle: null,
    };
  }

  async subscribeToEvents(_token: string, events: readonly string[]) {
    return events.map((e) => `mock_sub_${e}`);
  }

  /** Builds a correctly signed Kick webhook delivery (headers + raw body). */
  signEvent(type: string, payload: unknown, opts: { messageId?: string; timestamp?: string } = {}) {
    const messageId = opts.messageId ?? `01MOCK${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
    const timestamp = opts.timestamp ?? new Date().toISOString();
    const body = Buffer.from(JSON.stringify(payload));
    const signer = createSign('RSA-SHA256');
    signer.update(`${messageId}.${timestamp}.`);
    signer.update(body);
    const signature = signer.sign(this.keys.privateKey).toString('base64');
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'kick-event-message-id': messageId,
        'kick-event-subscription-id': 'mock_subscription',
        'kick-event-signature': signature,
        'kick-event-message-timestamp': timestamp,
        'kick-event-type': type,
        'kick-event-version': '1',
      },
    };
  }
}

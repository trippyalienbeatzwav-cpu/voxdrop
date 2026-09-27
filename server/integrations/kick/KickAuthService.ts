import { Errors } from '../../lib/errors.js';
import type { KickApiService, KickAuthService, KickChannel, KickIdentity, KickTokens } from './types.js';

const ID_BASE = 'https://id.kick.com';
const API_BASE = 'https://api.kick.com';

/**
 * Official Kick OAuth 2.1 (Authorization Code + PKCE S256).
 * Docs: https://docs.kick.com/getting-started/generating-tokens-oauth2-flow
 * REQUIRES real KICK_CLIENT_ID / KICK_CLIENT_SECRET / KICK_REDIRECT_URI.
 */
export class LiveKickAuthService implements KickAuthService {
  readonly mode = 'live' as const;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildAuthorizeUrl({ state, codeChallenge, scopes }: { state: string; codeChallenge: string; scopes: string[] }) {
    const u = new URL('/oauth/authorize', ID_BASE);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('scope', scopes.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  private async tokenRequest(body: Record<string, string>): Promise<KickTokens> {
    const res = await this.fetchImpl(`${ID_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...body }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Errors.upstream(`Kick token endpoint returned ${res.status}`);
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number | string; scope?: string };
    if (!j.access_token) throw Errors.upstream('Kick token response missing access_token');
    return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresIn: Number(j.expires_in ?? 3600), scope: j.scope ?? '' };
  }

  exchangeCode(code: string, codeVerifier: string) {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: codeVerifier });
  }

  refresh(refreshToken: string) {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string, hint: 'access_token' | 'refresh_token') {
    const u = new URL('/oauth/revoke', ID_BASE);
    u.searchParams.set('token', token);
    u.searchParams.set('token_hint_type', hint);
    await this.fetchImpl(u, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => undefined);
  }
}

/**
 * Official Kick public API client. Docs: https://docs.kick.com/apis
 * REQUIRES a real user access token.
 */
export class LiveKickApiService implements KickApiService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get<T>(path: string, token: string): Promise<T> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) throw Errors.unauthorized('Kick authorization expired or was revoked');
    if (!res.ok) throw Errors.upstream(`Kick API ${path} returned ${res.status}`);
    return (await res.json()) as T;
  }

  async getCurrentUser(token: string): Promise<KickIdentity> {
    const j = await this.get<{ data?: Array<{ user_id: number; name: string; profile_picture?: string }> }>('/public/v1/users', token);
    const u = j.data?.[0];
    if (!u?.user_id || !u.name) throw Errors.upstream('Kick did not return a user');
    return { kickUserId: String(u.user_id), username: u.name, profilePicture: u.profile_picture || null };
  }

  async getOwnChannel(token: string): Promise<KickChannel | null> {
    const j = await this.get<{
      data?: Array<{
        broadcaster_user_id: number;
        slug: string;
        channel_description?: string;
        banner_picture?: string;
        stream_title?: string;
        stream?: { is_live?: boolean };
      }>;
    }>('/public/v1/channels', token);
    const c = j.data?.[0];
    if (!c) return null;
    return {
      broadcasterUserId: String(c.broadcaster_user_id),
      slug: c.slug,
      description: c.channel_description ?? '',
      bannerPicture: c.banner_picture || null,
      isLive: !!c.stream?.is_live,
      streamTitle: c.stream_title || null,
    };
  }

  async subscribeToEvents(token: string, events: readonly string[]): Promise<string[]> {
    const res = await this.fetchImpl(`${API_BASE}/public/v1/events/subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ events: events.map((name) => ({ name, version: 1 })), method: 'webhook' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Errors.upstream(`Kick event subscription failed (${res.status})`);
    const j = (await res.json()) as { data?: Array<{ subscription_id?: string; error?: string }> };
    return (j.data ?? []).map((d) => d.subscription_id).filter((x): x is string => !!x);
  }
}

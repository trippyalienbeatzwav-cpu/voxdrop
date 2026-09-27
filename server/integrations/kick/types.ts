export interface KickTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}

export interface KickIdentity {
  kickUserId: string;
  username: string;
  profilePicture: string | null;
}

export interface KickChannel {
  broadcasterUserId: string;
  slug: string;
  description: string;
  bannerPicture: string | null;
  isLive: boolean;
  streamTitle: string | null;
}

/** Scopes documented at https://docs.kick.com/getting-started/scopes */
export const LOGIN_SCOPES = ['user:read'];
export const STREAMER_SCOPES = ['user:read', 'channel:read', 'events:subscribe'];

/** Events VoxDrop consumes from Kick's official webhook system. */
export const KICK_EVENTS = [
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
  'channel.followed',
  'livestream.status.updated',
] as const;

export interface KickAuthService {
  readonly mode: 'live' | 'mock';
  buildAuthorizeUrl(opts: { state: string; codeChallenge: string; scopes: string[] }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<KickTokens>;
  refresh(refreshToken: string): Promise<KickTokens>;
  revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void>;
}

export interface KickApiService {
  getCurrentUser(accessToken: string): Promise<KickIdentity>;
  getOwnChannel(accessToken: string): Promise<KickChannel | null>;
  subscribeToEvents(accessToken: string, events: readonly string[]): Promise<string[]>;
}

/** Kick's user object as it appears in webhook payloads. */
export interface KickEventUser {
  is_anonymous?: boolean;
  user_id: number | string | null;
  username: string | null;
  profile_picture?: string | null;
  channel_slug?: string | null;
}

export interface VerifiedKickEvent {
  messageId: string;
  subscriptionId: string | null;
  type: string;
  version: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

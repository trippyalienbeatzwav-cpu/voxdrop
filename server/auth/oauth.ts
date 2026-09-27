import type { AppContext } from '../context.js';
import { isUniqueViolation, one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { pkcePair, randomToken, sha256 } from '../lib/crypto.js';
import { cleanText } from '../lib/text.js';
import { Outbox } from '../events/bus.js';
import { LOGIN_SCOPES, STREAMER_SCOPES, KICK_EVENTS } from '../integrations/kick/types.js';
import type { KickIdentity, KickTokens } from '../integrations/kick/types.js';
import { claimPendingRewards } from '../services/rewards.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { applyPoints } from '../services/points.js';
import { upsertStreamerFromKick } from '../services/streamers.js';
import { ensureStreamerDefaults } from '../services/onboarding.js';
import { createSession } from './sessions.js';
import type { SessionUser } from '../services/types.js';

/** login = viewer sign-in; connect_channel = signed-in viewer adds a channel; streamer_signup = one-step streamer sign-in/up. */
export type OAuthIntent = 'login' | 'connect_channel' | 'streamer_signup';

/** Only same-origin relative paths are accepted as post-login redirects (no open redirects). */
export function safeRedirect(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.length > 300) return '/home';
  if (/[\r\n]/.test(next)) return '/home';
  return next;
}

/**
 * Begins the Kick OAuth 2.1 + PKCE flow. The `state` is single-use, expires in
 * 10 minutes and is bound to this browser via a random cookie nonce (login-CSRF
 * protection): the callback must present both.
 */
export async function startOAuth(ctx: AppContext, intent: OAuthIntent, next: string) {
  const state = randomToken(24);
  const browserNonce = randomToken(24);
  const { verifier, challenge } = pkcePair();
  await ctx.db.query(
    `INSERT INTO oauth_states (state_hash, browser_hash, code_verifier, intent, redirect_after, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')`,
    [sha256(state), sha256(browserNonce), ctx.secrets.encrypt(verifier), intent, safeRedirect(next)],
  );
  await ctx.db.query(`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`);
  const url = ctx.kickAuth.buildAuthorizeUrl({ state, codeChallenge: challenge, scopes: intent === 'login' ? LOGIN_SCOPES : STREAMER_SCOPES });
  return { url, browserNonce };
}

export interface CallbackResult {
  user: SessionUser;
  sessionToken: string;
  redirectTo: string;
  isNewUser: boolean;
}

export async function completeOAuth(
  ctx: AppContext,
  p: { code?: string; state?: string; error?: string; browserNonce?: string; ipHash: string | null; userAgent: string | null; currentUser: SessionUser | null },
): Promise<CallbackResult> {
  if (p.error) throw new AppError(400, 'KICK_AUTH_DENIED', 'Kick sign-in was cancelled');
  if (!p.code || !p.state || p.code.length > 4096 || p.state.length > 200) throw new AppError(400, 'KICK_AUTH_FAILED', 'Missing authorization response');
  if (!p.browserNonce) throw new AppError(400, 'KICK_AUTH_FAILED', 'Sign-in session expired — please try again');

  // Atomically consume the state (single use).
  const st = await one<{ browser_hash: string; code_verifier: string; intent: OAuthIntent; redirect_after: string }>(
    ctx.db,
    `UPDATE oauth_states SET consumed_at = now()
      WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING browser_hash, code_verifier, intent, redirect_after`,
    [sha256(p.state)],
  );
  if (!st || st.browser_hash !== sha256(p.browserNonce)) throw new AppError(400, 'KICK_AUTH_FAILED', 'Sign-in session expired or invalid — please try again');
  try {
    return await finishOAuth(ctx, p, st);
  } catch (err) {
    // Lets the callback send streamer sign-ups back to the streamer sign-in page.
    if (err && typeof err === 'object') (err as { intent?: OAuthIntent }).intent = st.intent;
    throw err;
  }
}

async function finishOAuth(
  ctx: AppContext,
  p: { code?: string; state?: string; ipHash: string | null; userAgent: string | null; currentUser: SessionUser | null },
  st: { code_verifier: string; intent: OAuthIntent; redirect_after: string },
): Promise<CallbackResult> {
  if (st.intent === 'connect_channel' && !p.currentUser) throw new AppError(401, 'UNAUTHORIZED', 'Sign in before connecting a channel');

  let tokens: KickTokens;
  let identity: KickIdentity;
  try {
    tokens = await ctx.kickAuth.exchangeCode(p.code!, ctx.secrets.decrypt(st.code_verifier));
    identity = await ctx.kickApi.getCurrentUser(tokens.accessToken);
  } catch (err) {
    ctx.log.warn({ err }, 'kick oauth exchange failed');
    if (err instanceof AppError && err.code === 'KICK_AUTH_FAILED') throw err;
    throw new AppError(502, 'KICK_AUTH_FAILED', 'Could not verify your Kick account — please try again');
  }

  const outbox = new Outbox();
  const { user, isNewUser } = await upsertUser(ctx, identity, outbox);
  if (user.status !== 'ACTIVE') throw Errors.suspended();
  if (st.intent === 'connect_channel' && p.currentUser && p.currentUser.id !== user.id) {
    throw new AppError(409, 'KICK_ACCOUNT_MISMATCH', 'That Kick account belongs to a different VoxDrop user');
  }

  if (st.intent === 'connect_channel' || st.intent === 'streamer_signup') {
    await connectChannel(ctx, user, identity, tokens);
  } else if (ctx.kickAuth.mode === 'live') {
    // Viewers: we only needed the identity. Don't keep tokens we don't need.
    void ctx.kickAuth.revoke(tokens.accessToken, 'access_token');
  }

  const { token } = await createSession(ctx.db, user.id, { ipHash: p.ipHash, userAgent: p.userAgent });
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await claimPendingRewards(q, outbox, user.id, identity.kickUserId);
    await audit(q, { actorUserId: user.id, action: st.intent === 'login' ? 'auth.login' : st.intent === 'streamer_signup' ? 'auth.streamer_signup' : 'auth.channel_connected', entityType: 'user', entityId: user.id, ipHash: p.ipHash });
  });
  outbox.flush(ctx.bus);
  return { user, sessionToken: token, redirectTo: st.intent === 'login' ? st.redirect_after : '/streamer/dashboard', isNewUser };
}

/** Links a Kick identity to exactly one local user (unique kick_user_id prevents duplicates). */
async function upsertUser(ctx: AppContext, identity: KickIdentity, outbox: Outbox, attempt = 0): Promise<{ user: SessionUser; isNewUser: boolean }> {
  const avatar = identity.profilePicture && /^https:\/\//.test(identity.profilePicture) ? identity.profilePicture : null;
  const username = cleanText(identity.username, 40);
  try {
    return await ctx.db.tx(async (q) => {
      const existing = await one<SessionUser>(
        q,
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.role, u.status, u.reduced_motion
           FROM kick_accounts k JOIN users u ON u.id = k.user_id WHERE k.kick_user_id = $1 FOR UPDATE OF k`,
        [identity.kickUserId],
      );
      if (existing) {
        await q.query('UPDATE kick_accounts SET kick_username = $2, profile_picture = $3, updated_at = now() WHERE kick_user_id = $1', [identity.kickUserId, username, avatar]);
        const u = await one<SessionUser>(
          q,
          `UPDATE users SET avatar_url = COALESCE($2, avatar_url), updated_at = now() WHERE id = $1
           RETURNING id, username, display_name, avatar_url, role, status, reduced_motion`,
          [existing.id, avatar],
        );
        return { user: u!, isNewUser: false };
      }
      // Kick usernames are unique on Kick, but a previous holder may still exist here.
      let local = username;
      if (await one(q, 'SELECT 1 FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [local])) local = `${username}_${randomToken(3).toLowerCase()}`;
      const u = await one<SessionUser>(
        q,
        `INSERT INTO users (username, display_name, avatar_url, last_login_at) VALUES ($1,$2,$3, now())
         RETURNING id, username, display_name, avatar_url, role, status, reduced_motion`,
        [local, username, avatar],
      );
      await q.query('INSERT INTO kick_accounts (user_id, kick_user_id, kick_username, profile_picture) VALUES ($1,$2,$3,$4)', [u!.id, identity.kickUserId, username, avatar]);
      await q.query('INSERT INTO points_accounts (user_id) VALUES ($1)', [u!.id]);
      if (ctx.config.STARTING_POINTS > 0) {
        await applyPoints(q, { userId: u!.id, type: 'POINTS_EARNED', amount: ctx.config.STARTING_POINTS, description: 'Welcome bonus', idempotencyKey: `welcome:${u!.id}` }, outbox);
      }
      await audit(q, { actorUserId: u!.id, action: 'user.created', entityType: 'user', entityId: u!.id, metadata: { kickUserId: identity.kickUserId } });
      return { user: u!, isNewUser: true };
    });
  } catch (err) {
    // Two simultaneous first logins: the loser retries and finds the winner's row.
    if (isUniqueViolation(err) && attempt < 2) return upsertUser(ctx, identity, outbox, attempt + 1);
    throw err;
  }
}

async function connectChannel(ctx: AppContext, user: SessionUser, identity: KickIdentity, tokens: KickTokens) {
  const channel = await ctx.kickApi.getOwnChannel(tokens.accessToken);
  if (!channel) throw new AppError(422, 'KICK_NO_CHANNEL', 'Your Kick account does not have a channel yet');
  await ctx.db.query(
    `UPDATE kick_accounts SET access_token_enc = $2, refresh_token_enc = $3, token_expires_at = now() + make_interval(secs => $4), scopes = $5,
            tokens_revoked_at = NULL, updated_at = now() WHERE user_id = $1`,
    [user.id, ctx.secrets.encrypt(tokens.accessToken), tokens.refreshToken ? ctx.secrets.encrypt(tokens.refreshToken) : null, tokens.expiresIn, tokens.scope],
  );
  const streamer = await upsertStreamerFromKick(ctx.db, user, channel, identity.profilePicture);
  await ensureStreamerDefaults(ctx, streamer.id);
  try {
    const subs = await ctx.kickApi.subscribeToEvents(tokens.accessToken, KICK_EVENTS);
    await ctx.db.query('UPDATE streamers SET kick_events_subscribed_at = now() WHERE id = $1', [streamer.id]);
    await audit(ctx.db, { actorUserId: user.id, streamerId: streamer.id, action: 'kick.events_subscribed', entityType: 'streamer', entityId: streamer.id, metadata: { subscriptions: subs.length } });
  } catch (err) {
    ctx.log.warn({ err }, 'kick event subscription failed');
  }
  const outbox = new Outbox();
  await notify(ctx.db, outbox, user.id, 'security', 'Kick channel connected', `VoxDrop is now linked to kick.com/${channel.slug}`, { streamerId: streamer.id });
  outbox.flush(ctx.bus);
}

/** Returns a valid access token for a streamer, refreshing it when close to expiry. */
export async function streamerAccessToken(ctx: AppContext, userId: string): Promise<string> {
  const k = await one<{ access_token_enc: string | null; refresh_token_enc: string | null; token_expires_at: Date | null; tokens_revoked_at: Date | null }>(
    ctx.db,
    'SELECT access_token_enc, refresh_token_enc, token_expires_at, tokens_revoked_at FROM kick_accounts WHERE user_id = $1',
    [userId],
  );
  if (!k?.access_token_enc || k.tokens_revoked_at) throw new AppError(409, 'KICK_RECONNECT_REQUIRED', 'Reconnect your Kick channel to continue');
  if (k.token_expires_at && k.token_expires_at.getTime() - Date.now() > 60_000) return ctx.secrets.decrypt(k.access_token_enc);
  if (!k.refresh_token_enc) throw new AppError(409, 'KICK_RECONNECT_REQUIRED', 'Kick authorization expired — reconnect your channel');
  try {
    const t = await ctx.kickAuth.refresh(ctx.secrets.decrypt(k.refresh_token_enc));
    await ctx.db.query(
      `UPDATE kick_accounts SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), token_expires_at = now() + make_interval(secs => $4), updated_at = now() WHERE user_id = $1`,
      [userId, ctx.secrets.encrypt(t.accessToken), t.refreshToken ? ctx.secrets.encrypt(t.refreshToken) : null, t.expiresIn],
    );
    return t.accessToken;
  } catch {
    await ctx.db.query('UPDATE kick_accounts SET tokens_revoked_at = now() WHERE user_id = $1', [userId]);
    throw new AppError(409, 'KICK_RECONNECT_REQUIRED', 'Kick authorization was revoked — reconnect your channel');
  }
}

export async function revokeKickTokens(ctx: AppContext, userId: string) {
  const k = await one<{ access_token_enc: string | null; refresh_token_enc: string | null }>(ctx.db, 'SELECT access_token_enc, refresh_token_enc FROM kick_accounts WHERE user_id = $1', [userId]);
  if (k?.refresh_token_enc) await ctx.kickAuth.revoke(ctx.secrets.decrypt(k.refresh_token_enc), 'refresh_token').catch(() => undefined);
  if (k?.access_token_enc) await ctx.kickAuth.revoke(ctx.secrets.decrypt(k.access_token_enc), 'access_token').catch(() => undefined);
  await ctx.db.query('UPDATE kick_accounts SET access_token_enc = NULL, refresh_token_enc = NULL, tokens_revoked_at = now(), updated_at = now() WHERE user_id = $1', [userId]);
  await audit(ctx.db, { actorUserId: userId, action: 'kick.tokens_revoked', entityType: 'user', entityId: userId });
}

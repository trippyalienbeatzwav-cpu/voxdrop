import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { Topic } from '../events/bus.js';
import { audit } from './audit.js';
import type { SessionUser } from './types.js';

/**
 * Each OBS Browser Source gets its own secret token, so a streamer can add
 * (and revoke) the subscription, gift-sub, donation and voice/MP3 overlays
 * independently. Tokens are stored as SHA-256 (for lookup) plus AES-GCM
 * ciphertext (so the owner can copy the URL again later). URLs contain only
 * the channel id and this token — never any server secret.
 */
export const OVERLAY_KINDS = ['audio', 'subscription', 'gift_sub', 'donation'] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const PATH_OF: Record<OverlayKind, string> = { audio: 'audio', subscription: 'subscription', gift_sub: 'gift-sub', donation: 'donation' };
export const KIND_OF_PATH: Record<string, OverlayKind> = { audio: 'audio', subscription: 'subscription', 'gift-sub': 'gift_sub', donation: 'donation' };

export const topicFor = (streamerId: string, kind: OverlayKind) => (kind === 'audio' ? Topic.overlay(streamerId) : Topic.alerts(streamerId, kind));

export async function ensureOverlayTokens(ctx: AppContext, streamerId: string) {
  const have = new Set((await many<{ kind: OverlayKind }>(ctx.db, 'SELECT kind FROM overlay_tokens WHERE streamer_id = $1', [streamerId])).map((r) => r.kind));
  for (const kind of OVERLAY_KINDS) {
    if (have.has(kind)) continue;
    // The voice/MP3 overlay inherits the channel's previous single overlay key so existing OBS URLs keep working.
    let token = randomToken(24);
    if (kind === 'audio') {
      const legacy = await one<{ overlay_key: string }>(ctx.db, 'SELECT overlay_key FROM streamers WHERE id = $1', [streamerId]);
      if (legacy?.overlay_key) token = legacy.overlay_key;
    }
    await ctx.db.query('INSERT INTO overlay_tokens (streamer_id, kind, token_hash, token_enc) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
      streamerId,
      kind,
      sha256(token),
      ctx.secrets.encrypt(token),
    ]);
  }
}

export function overlayUrl(ctx: AppContext, streamerId: string, kind: OverlayKind, token: string) {
  return `${ctx.config.APP_URL}/overlay/${streamerId}/${PATH_OF[kind]}?token=${encodeURIComponent(token)}`;
}

export async function listOverlays(ctx: AppContext, streamerId: string) {
  await ensureOverlayTokens(ctx, streamerId);
  const rows = await many<{ kind: OverlayKind; token_enc: string; created_at: Date; rotated_at: Date | null; last_seen_at: Date | null }>(
    ctx.db,
    'SELECT kind, token_enc, created_at, rotated_at, last_seen_at FROM overlay_tokens WHERE streamer_id = $1',
    [streamerId],
  );
  return OVERLAY_KINDS.map((kind) => {
    const r = rows.find((x) => x.kind === kind)!;
    return {
      kind,
      url: overlayUrl(ctx, streamerId, kind, ctx.secrets.decrypt(r.token_enc)),
      connected: ctx.bus.listenerCount(topicFor(streamerId, kind)) > 0,
      rotatedAt: r.rotated_at,
      lastSeenAt: r.last_seen_at,
    };
  });
}

export async function rotateOverlayToken(ctx: AppContext, actor: SessionUser, streamerId: string, kind: OverlayKind) {
  await ensureOverlayTokens(ctx, streamerId);
  const token = randomToken(24);
  await ctx.db.query('UPDATE overlay_tokens SET token_hash = $3, token_enc = $4, rotated_at = now() WHERE streamer_id = $1 AND kind = $2', [
    streamerId,
    kind,
    sha256(token),
    ctx.secrets.encrypt(token),
  ]);
  if (kind === 'audio') await ctx.db.query('UPDATE streamers SET overlay_key = $2 WHERE id = $1', [streamerId, randomToken(24)]); // retire legacy key
  await audit(ctx.db, { actorUserId: actor.id, streamerId, action: 'overlay.token_rotated', entityType: 'overlay_token', entityId: kind });
  // Disconnect anything using the old token.
  ctx.bus.publish(topicFor(streamerId, kind), 'overlay.stop', { rotated: true });
  return overlayUrl(ctx, streamerId, kind, token);
}

/** Verifies a token for exactly one overlay kind of one channel (constant-time compare on the hash). */
export async function verifyOverlayToken(db: Db, streamerId: string, kind: OverlayKind, token: string | undefined) {
  if (!token || token.length < 10 || token.length > 100) throw Errors.notFound('Overlay');
  const r = await one<{ token_hash: string; last_seen_at: Date | null }>(db, 'SELECT token_hash, last_seen_at FROM overlay_tokens WHERE streamer_id = $1 AND kind = $2', [streamerId, kind]);
  if (!r || !safeEqual(r.token_hash, sha256(token))) throw Errors.notFound('Overlay');
  if (!r.last_seen_at || Date.now() - new Date(r.last_seen_at).getTime() > 60_000) {
    await db.query('UPDATE overlay_tokens SET last_seen_at = now() WHERE streamer_id = $1 AND kind = $2', [streamerId, kind]);
  }
}

/** Any valid overlay token of the channel (used to authorise audio/alert media streams). */
export async function overlayTokenMatchesChannel(db: Db, streamerId: string, token: string | null | undefined) {
  if (!token || token.length > 100) return false;
  const r = await one(db, 'SELECT 1 FROM overlay_tokens WHERE streamer_id = $1 AND token_hash = $2', [streamerId, sha256(token)]);
  return !!r;
}

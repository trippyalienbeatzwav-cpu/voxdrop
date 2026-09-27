import type { AppContext } from '../context.js';
import { ensureAlertSettings } from './alerts.js';
import { ensureOverlayTokens } from './overlays.js';
import { ensurePriorityDefaults } from './priority.js';

/**
 * Everything a new streamer profile needs, created idempotently:
 * streamer_settings (by upsertStreamerFromKick), priority settings + tiers,
 * alert settings for subs / gift subs / donations, and one secret OBS token
 * per overlay. Safe to call on every login.
 */
export async function ensureStreamerDefaults(ctx: AppContext, streamerId: string) {
  await ensurePriorityDefaults(ctx.db, streamerId);
  await ensureAlertSettings(ctx.db, streamerId);
  await ensureOverlayTokens(ctx, streamerId);
}

import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { isUniqueViolation, many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { Outbox, Topic } from '../events/bus.js';
import { audit } from './audit.js';
import { requireChannel } from './streamers.js';
import { enqueue, tryAdvance } from './queue.js';
import type { SessionUser } from './types.js';
import type { AudioFileRow } from './audio.js';

/** Icons the UI can render (lucide names). Anything else is rejected. */
export const SOUND_ICONS = [
  'volume-2', 'megaphone', 'party-popper', 'laugh', 'skull', 'flame', 'zap', 'heart', 'star', 'bell', 'drum', 'music',
  'siren', 'trophy', 'ghost', 'sparkles', 'swords', 'gamepad-2', 'thumbs-up', 'hand-metal', 'rocket', 'bomb', 'crown', 'target',
] as const;

export const soundCreateSchema = z.object({
  streamerId: z.string().uuid(),
  audioFileId: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
  description: z.string().max(200).optional().default(''),
  categorySlug: z.string().max(40),
  icon: z.enum(SOUND_ICONS).optional().default('volume-2'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().default('#C6FF3D'),
  pricePoints: z.number().int().min(0).max(1_000_000),
  cooldownSeconds: z.number().int().min(0).max(86400).optional().default(30),
  dailyLimit: z.number().int().min(0).max(10000).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export const soundUpdateSchema = soundCreateSchema.omit({ streamerId: true, audioFileId: true }).partial().extend({ sortOrder: z.number().int().min(0).max(10000).optional() }).strict();

export const SOUND_SQL = `
  SELECT so.id, so.streamer_id, so.name, so.description, so.icon, so.color, so.duration_ms, so.price_points, so.cooldown_seconds,
         so.daily_limit, so.is_active, so.sort_order, so.created_at, so.updated_at, so.audio_file_id,
         c.slug AS category_slug, c.name AS category_name, u.username AS created_by_username, a.waveform,
         (SELECT COUNT(*)::int FROM sound_usage su WHERE su.sound_id = so.id AND su.created_at > now() - interval '30 days') AS uses_30d,
         (SELECT GREATEST(0, so.cooldown_seconds - EXTRACT(EPOCH FROM (now() - MAX(su.created_at)))::int) FROM sound_usage su WHERE su.sound_id = so.id) AS cooldown_remaining,
         (SELECT COUNT(*)::int FROM sound_usage su WHERE su.sound_id = so.id AND su.created_at >= date_trunc('day', now())) AS uses_today
    FROM sounds so
    JOIN sound_categories c ON c.id = so.category_id
    JOIN users u ON u.id = so.created_by
    JOIN audio_files a ON a.id = so.audio_file_id`;

export interface SoundViewRow {
  id: string;
  streamer_id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  duration_ms: number;
  price_points: number;
  cooldown_seconds: number;
  daily_limit: number;
  is_active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  audio_file_id: string;
  category_slug: string;
  category_name: string;
  created_by_username: string;
  waveform: number[];
  uses_30d: number;
  cooldown_remaining: number | null;
  uses_today: number;
}

export function toSoundView(r: SoundViewRow) {
  return {
    id: r.id,
    streamerId: r.streamer_id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    color: r.color,
    durationMs: r.duration_ms,
    pricePoints: r.price_points,
    cooldownSeconds: r.cooldown_seconds,
    cooldownRemaining: r.cooldown_remaining ?? 0,
    dailyLimit: r.daily_limit,
    usesToday: r.uses_today,
    available: r.is_active && (r.cooldown_remaining ?? 0) <= 0 && (r.daily_limit === 0 || r.uses_today < r.daily_limit),
    isActive: r.is_active,
    sortOrder: r.sort_order,
    category: { slug: r.category_slug, name: r.category_name },
    audioFileId: r.audio_file_id,
    waveform: r.waveform,
    uses30d: r.uses_30d,
    createdBy: r.created_by_username,
    createdAt: r.created_at,
  };
}

export async function listSounds(
  db: Db,
  opts: { streamerId: string; includeInactive?: boolean; category?: string; q?: string; sort?: 'popular' | 'price_asc' | 'price_desc' | 'newest' | 'name' | 'custom' },
) {
  const params: unknown[] = [opts.streamerId];
  let where = 'so.streamer_id = $1 AND so.deleted_at IS NULL';
  if (!opts.includeInactive) where += ' AND so.is_active';
  if (opts.category) {
    params.push(opts.category);
    where += ` AND c.slug = $${params.length}`;
  }
  if (opts.q) {
    params.push(`%${opts.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    where += ` AND (so.name ILIKE $${params.length} OR so.description ILIKE $${params.length})`;
  }
  const order = {
    popular: 'uses_30d DESC, so.name ASC',
    price_asc: 'so.price_points ASC, so.name ASC',
    price_desc: 'so.price_points DESC, so.name ASC',
    newest: 'so.created_at DESC',
    name: 'so.name ASC',
    custom: 'so.sort_order ASC, so.name ASC',
  }[opts.sort ?? 'custom'];
  const rows = await many<SoundViewRow>(db, `${SOUND_SQL} WHERE ${where} ORDER BY ${order} LIMIT 300`, params);
  return rows.map(toSoundView);
}

export async function createSound(ctx: AppContext, actor: SessionUser, input: z.infer<typeof soundCreateSchema>) {
  await requireChannel(ctx.db, actor, input.streamerId, 'manage');
  const audio = await one<AudioFileRow>(ctx.db, 'SELECT * FROM audio_files WHERE id = $1', [input.audioFileId]);
  if (!audio || audio.deleted_at || audio.purpose !== 'SOUND' || audio.streamer_id !== input.streamerId) throw Errors.notFound('Sound audio');
  const cat = await one<{ id: string }>(ctx.db, 'SELECT id FROM sound_categories WHERE slug = $1', [input.categorySlug]);
  if (!cat) throw Errors.validation('Unknown category');
  try {
    const row = await ctx.db.tx(async (q) => {
      const s = await one<{ id: string }>(
        q,
        `INSERT INTO sounds (streamer_id, category_id, audio_file_id, name, description, icon, color, duration_ms, price_points, cooldown_seconds, daily_limit, is_active, created_by,
                             sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, (SELECT COALESCE(MAX(sort_order),0)+1 FROM sounds WHERE streamer_id = $1)) RETURNING id`,
        [
          input.streamerId,
          cat.id,
          audio.id,
          cleanText(input.name, 40),
          cleanText(input.description, 200),
          input.icon,
          input.color,
          audio.duration_ms,
          input.pricePoints,
          input.cooldownSeconds,
          input.dailyLimit,
          input.isActive,
          actor.id,
        ],
      );
      await q.query('UPDATE audio_files SET attached_at = now() WHERE id = $1', [audio.id]);
      await audit(q, { actorUserId: actor.id, streamerId: input.streamerId, action: 'sound.created', entityType: 'sound', entityId: s!.id, metadata: { name: input.name, price: input.pricePoints } });
      return s!;
    });
    return getSound(ctx.db, row.id);
  } catch (err) {
    if (isUniqueViolation(err, 'sounds_name_uq')) throw Errors.conflict('A sound with this name already exists');
    throw err;
  }
}

export async function getSound(db: Db, id: string) {
  const r = await one<SoundViewRow>(db, `${SOUND_SQL} WHERE so.id = $1 AND so.deleted_at IS NULL`, [id]);
  if (!r) throw Errors.notFound('Sound');
  return toSoundView(r);
}

export async function updateSound(ctx: AppContext, actor: SessionUser, soundId: string, patch: z.infer<typeof soundUpdateSchema>) {
  const s = await one<{ streamer_id: string; name: string }>(ctx.db, 'SELECT streamer_id, name FROM sounds WHERE id = $1 AND deleted_at IS NULL', [soundId]);
  if (!s) throw Errors.notFound('Sound');
  await requireChannel(ctx.db, actor, s.streamer_id, 'manage');
  let categoryId: string | null = null;
  if (patch.categorySlug) {
    const c = await one<{ id: string }>(ctx.db, 'SELECT id FROM sound_categories WHERE slug = $1', [patch.categorySlug]);
    if (!c) throw Errors.validation('Unknown category');
    categoryId = c.id;
  }
  try {
    await ctx.db.query(
      `UPDATE sounds SET name = COALESCE($2, name), description = COALESCE($3, description), category_id = COALESCE($4, category_id),
              icon = COALESCE($5, icon), color = COALESCE($6, color), price_points = COALESCE($7, price_points),
              cooldown_seconds = COALESCE($8, cooldown_seconds), daily_limit = COALESCE($9, daily_limit), is_active = COALESCE($10, is_active),
              sort_order = COALESCE($11, sort_order), updated_at = now()
        WHERE id = $1`,
      [
        soundId,
        patch.name !== undefined ? cleanText(patch.name, 40) : null,
        patch.description !== undefined ? cleanText(patch.description, 200) : null,
        categoryId,
        patch.icon ?? null,
        patch.color ?? null,
        patch.pricePoints ?? null,
        patch.cooldownSeconds ?? null,
        patch.dailyLimit ?? null,
        patch.isActive ?? null,
        patch.sortOrder ?? null,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err, 'sounds_name_uq')) throw Errors.conflict('A sound with this name already exists');
    throw err;
  }
  await audit(ctx.db, { actorUserId: actor.id, streamerId: s.streamer_id, action: 'sound.updated', entityType: 'sound', entityId: soundId, metadata: { fields: Object.keys(patch), name: s.name } });
  return getSound(ctx.db, soundId);
}

export async function deleteSound(ctx: AppContext, actor: SessionUser, soundId: string) {
  const s = await one<{ streamer_id: string; name: string }>(ctx.db, 'SELECT streamer_id, name FROM sounds WHERE id = $1 AND deleted_at IS NULL', [soundId]);
  if (!s) throw Errors.notFound('Sound');
  await requireChannel(ctx.db, actor, s.streamer_id, 'manage');
  await ctx.db.query('UPDATE sounds SET deleted_at = now(), is_active = false, updated_at = now() WHERE id = $1', [soundId]);
  await audit(ctx.db, { actorUserId: actor.id, streamerId: s.streamer_id, action: 'sound.deleted', entityType: 'sound', entityId: soundId, metadata: { name: s.name } });
  return { id: soundId, deleted: true };
}

/** Streamer soundboard: staff trigger their own sounds for free; goes to the front of the queue. */
export async function triggerSoundAsStaff(ctx: AppContext, actor: SessionUser, soundId: string) {
  const s = await one<{ id: string; streamer_id: string; name: string; deleted_at: Date | null }>(ctx.db, 'SELECT id, streamer_id, name, deleted_at FROM sounds WHERE id = $1', [soundId]);
  if (!s || s.deleted_at) throw Errors.notFound('Sound');
  await requireChannel(ctx.db, actor, s.streamer_id, 'moderate');
  const outbox = new Outbox();
  const id = await ctx.db.tx(async (q) => {
    const m = await one<{ id: string; streamer_id: string; sender_id: string; is_priority: boolean }>(
      q,
      `INSERT INTO messages (streamer_id, sender_id, type, sound_id, points_spent, is_priority, status, moderated_by, moderated_at)
       VALUES ($1,$2,'SOUND',$3,0,true,'APPROVED',$2,now()) RETURNING id, streamer_id, sender_id, is_priority`,
      [s.streamer_id, actor.id, s.id],
    );
    await q.query('INSERT INTO sound_usage (sound_id, streamer_id, user_id, message_id, points_spent) VALUES ($1,$2,$3,$4,0)', [s.id, s.streamer_id, actor.id, m!.id]);
    await enqueue(q, outbox, m!);
    return m!.id;
  });
  outbox.flush(ctx.bus);
  ctx.bus.publish(Topic.channel(s.streamer_id), 'sound.played', { soundId: s.id, by: actor.username, messageId: id });
  await tryAdvance(ctx, s.streamer_id);
  return { messageId: id };
}

export async function listCategories(db: Db) {
  return many<{ slug: string; name: string }>(db, 'SELECT slug, name FROM sound_categories ORDER BY sort_order, name');
}

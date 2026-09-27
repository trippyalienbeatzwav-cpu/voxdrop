import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { decodeCursor, keyset, pageOf, pageQuery } from '../lib/pagination.js';
import { Outbox } from '../events/bus.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { applyPoints } from '../services/points.js';
import { deleteMessage } from '../services/messages.js';
import { getMessageViews, toMessageView } from '../services/messageView.js';
import { processStoredKickEvent } from '../services/rewards.js';
import { idParam, parse, requireAdmin } from '../http.js';

const like = (s: string) => `%${s.replace(/[%_\\]/g, (m) => '\\' + m)}%`;

/** Platform administration. Every route requires role ADMIN (checked server-side). */
export const adminRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const ipHash = (req: FastifyRequest) => ctx.secrets.hashIp(req.ip);

    app.get('/api/admin/overview', async (req) => {
      requireAdmin(req);
      const c = await one(
        ctx.db,
        `SELECT (SELECT COUNT(*)::int FROM users WHERE deleted_at IS NULL) AS users,
                (SELECT COUNT(*)::int FROM users WHERE status = 'SUSPENDED') AS suspended_users,
                (SELECT COUNT(*)::int FROM streamers WHERE deleted_at IS NULL) AS streamers,
                (SELECT COUNT(*)::int FROM messages WHERE created_at > now() - interval '24 hours') AS messages_24h,
                (SELECT COUNT(*)::int FROM audio_files WHERE deleted_at IS NULL) AS audio_files,
                (SELECT COALESCE(SUM(amount_cents),0)::int FROM donations WHERE status = 'COMPLETED' AND completed_at > now() - interval '30 days') AS donations_30d_cents,
                (SELECT COALESCE(SUM(balance),0)::bigint::text FROM points_accounts) AS points_outstanding,
                (SELECT COUNT(*)::int FROM reports WHERE status = 'OPEN') AS open_reports,
                (SELECT COUNT(*)::int FROM webhook_events WHERE status = 'FAILED') AS failed_webhooks,
                (SELECT COUNT(*)::int FROM audio_processing_jobs WHERE status = 'FAILED' AND created_at > now() - interval '7 days') AS failed_jobs_7d,
                (SELECT COUNT(*)::int FROM bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active_bans`,
      );
      return {
        counts: c,
        integrations: {
          kick: ctx.config.KICK_MODE,
          payments: ctx.payments.name,
          storage: ctx.storage.name,
          malwareScanner: ctx.scanner.name,
          realtime: 'in-process SSE (single instance)',
        },
      };
    });

    app.get('/api/admin/users', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery.extend({ q: z.string().max(60).optional(), role: z.enum(['VIEWER', 'STREAMER', 'MODERATOR', 'ADMIN']).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() }), req.query);
      const params: unknown[] = [];
      let where = 'u.deleted_at IS NULL';
      if (q.q) {
        params.push(like(q.q));
        where += ` AND (u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR k.kick_username ILIKE $${params.length})`;
      }
      if (q.role) {
        params.push(q.role);
        where += ` AND u.role = $${params.length}`;
      }
      if (q.status) {
        params.push(q.status);
        where += ` AND u.status = $${params.length}`;
      }
      where += keyset('u', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.role, u.status, u.suspended_reason, u.created_at, u.last_login_at,
                k.kick_username, k.kick_user_id, COALESCE(p.balance,0) AS points
           FROM users u LEFT JOIN kick_accounts k ON k.user_id = u.id LEFT JOIN points_accounts p ON p.user_id = u.id
          WHERE ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.post('/api/admin/users/:id/suspend', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
      if (id === admin.id) throw Errors.badRequest('You cannot suspend yourself');
      const r = await ctx.db.query(`UPDATE users SET status = 'SUSPENDED', suspended_reason = $2, updated_at = now() WHERE id = $1 AND role <> 'ADMIN' RETURNING id`, [id, cleanText(b.reason, 300)]);
      if (!r.rowCount) throw Errors.notFound('User (admins cannot be suspended here)');
      await revokeAllSessions(ctx.db, id);
      await audit(ctx.db, { actorUserId: admin.id, action: 'admin.user_suspended', entityType: 'user', entityId: id, metadata: { reason: b.reason }, ipHash: ipHash(req) });
      return { ok: true };
    });
    app.post('/api/admin/users/:id/unsuspend', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      await ctx.db.query(`UPDATE users SET status = 'ACTIVE', suspended_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
      await audit(ctx.db, { actorUserId: admin.id, action: 'admin.user_unsuspended', entityType: 'user', entityId: id, ipHash: ipHash(req) });
      return { ok: true };
    });

    /** Manual points adjustment — the only way an admin changes a balance; always ledgered + audited. */
    app.post('/api/admin/users/:id/points-adjust', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ amount: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Amount cannot be 0'), reason: z.string().trim().min(3).max(200) }), req.body);
      if (id === admin.id) throw Errors.forbidden('Admins cannot adjust their own points');
      const outbox = new Outbox();
      const r = await ctx.db.tx(async (q) => {
        const tx = await applyPoints(q, { userId: id, type: 'POINTS_ADJUSTED', amount: b.amount, description: `Adjustment: ${cleanText(b.reason, 150)}`, referenceType: 'admin', referenceId: admin.id, createdBy: admin.id }, outbox);
        await notify(q, outbox, id, 'points.received', `${b.amount > 0 ? '+' : ''}${b.amount} points (adjustment)`, cleanText(b.reason, 200));
        await audit(q, { actorUserId: admin.id, action: 'admin.points_adjusted', entityType: 'user', entityId: id, metadata: { amount: b.amount, reason: b.reason }, ipHash: ipHash(req) });
        return tx;
      });
      outbox.flush(ctx.bus);
      return { balance: r.balance };
    });

    app.get('/api/admin/streamers', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ q: z.string().max(60).optional() }), req.query);
      const params: unknown[] = [];
      let where = 's.deleted_at IS NULL';
      if (q.q) {
        params.push(like(q.q));
        where += ` AND (s.slug ILIKE $1 OR s.display_name ILIKE $1)`;
      }
      return {
        items: await many(
          ctx.db,
          `SELECT s.id, s.slug, s.display_name, s.avatar_url, s.status, s.suspended_reason, s.is_live, s.created_at, s.kick_events_subscribed_at,
                  u.username AS owner_username,
                  (SELECT COUNT(*)::int FROM messages m WHERE m.streamer_id = s.id) AS messages,
                  (SELECT COALESCE(SUM(amount_cents),0)::int FROM donations d WHERE d.streamer_id = s.id AND d.status = 'COMPLETED') AS donations_cents
             FROM streamers s JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`,
          params,
        ),
      };
    });
    app.post('/api/admin/streamers/:id/suspend', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ reason: z.string().trim().min(3).max(300), suspended: z.boolean().default(true) }), req.body);
      const r = await ctx.db.query(`UPDATE streamers SET status = $2, suspended_reason = $3, updated_at = now() WHERE id = $1`, [id, b.suspended ? 'SUSPENDED' : 'ACTIVE', b.suspended ? cleanText(b.reason, 300) : null]);
      if (!r.rowCount) throw Errors.notFound('Streamer');
      await audit(ctx.db, { actorUserId: admin.id, streamerId: id, action: b.suspended ? 'admin.streamer_suspended' : 'admin.streamer_unsuspended', entityType: 'streamer', entityId: id, metadata: { reason: b.reason }, ipHash: ipHash(req) });
      return { ok: true };
    });

    app.get('/api/admin/messages', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery.extend({ status: z.string().max(20).optional(), flagged: z.enum(['true', 'false']).optional() }), req.query);
      const params: unknown[] = [];
      let where = 'm.deleted_at IS NULL';
      if (q.status) {
        params.push(q.status);
        where += ` AND m.status = $${params.length}::message_status`;
      }
      if (q.flagged === 'true') where += ' AND m.flagged';
      where += keyset('m', decodeCursor(q.cursor), params);
      const rows = await getMessageViews(ctx.db, where, params, `ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit + 1}`);
      const page = pageOf(rows, q.limit);
      return { items: page.items.map(toMessageView), nextCursor: page.nextCursor };
    });
    app.delete('/api/admin/messages/:id', async (req) => deleteMessage(ctx, requireAdmin(req), parse(idParam, req.params).id, ipHash(req)));

    app.get('/api/admin/audio', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [];
      const where = 'a.deleted_at IS NULL' + keyset('a', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT a.id, a.purpose, a.container, a.size_bytes, a.duration_ms, a.scan_status, a.original_filename, a.created_at, u.username AS owner_username
           FROM audio_files a JOIN users u ON u.id = a.owner_id WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });
    app.delete('/api/admin/audio/:id', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      const a = await one<{ storage_key: string }>(ctx.db, 'UPDATE audio_files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING storage_key', [id]);
      if (!a) throw Errors.notFound('Audio');
      await ctx.storage.delete(a.storage_key).catch(() => undefined);
      await audit(ctx.db, { actorUserId: admin.id, action: 'admin.audio_deleted', entityType: 'audio_file', entityId: id, ipHash: ipHash(req) });
      return { ok: true };
    });

    app.get('/api/admin/payments', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery.extend({ purpose: z.enum(['DONATION', 'POINTS_PURCHASE']).optional() }), req.query);
      const params: unknown[] = [];
      let where = 'true';
      if (q.purpose) {
        params.push(q.purpose);
        where += ` AND p.purpose = $${params.length}`;
      }
      where += keyset('p', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT p.id, p.provider, p.purpose, p.amount_cents, p.currency, p.status, p.points_amount, p.failure_reason, p.created_at, u.username
           FROM payments p JOIN users u ON u.id = p.user_id WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/admin/donations', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [];
      const where = 'true' + keyset('d', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT d.id, d.amount_cents, d.currency, d.status, d.message, d.created_at, u.username AS donor, s.slug AS streamer
           FROM donations d JOIN users u ON u.id = d.donor_id JOIN streamers s ON s.id = d.streamer_id
          WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/admin/points', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery.extend({ user: z.string().uuid().optional() }), req.query);
      const params: unknown[] = [];
      let where = 'true';
      if (q.user) {
        params.push(q.user);
        where += ` AND t.user_id = $${params.length}`;
      }
      where += keyset('t', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT t.id, t.type, t.amount, t.balance_before, t.balance_after, t.description, t.created_at, u.username, cb.username AS created_by
           FROM points_transactions t JOIN users u ON u.id = t.user_id LEFT JOIN users cb ON cb.id = t.created_by
          WHERE ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/admin/reports', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).default('OPEN') }), req.query);
      return {
        items: await many(
          ctx.db,
          `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.resolution, r.created_at, r.resolved_at, u.username AS reporter
             FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`,
          [q.status],
        ),
      };
    });
    app.post('/api/admin/reports/:id/resolve', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ status: z.enum(['RESOLVED', 'DISMISSED']), resolution: z.string().max(300).default('') }), req.body);
      const r = await ctx.db.query(`UPDATE reports SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now() WHERE id = $1 AND status = 'OPEN'`, [
        id,
        b.status,
        cleanText(b.resolution, 300),
        admin.id,
      ]);
      if (!r.rowCount) throw Errors.notFound('Open report');
      await audit(ctx.db, { actorUserId: admin.id, action: `admin.report_${b.status.toLowerCase()}`, entityType: 'report', entityId: id, ipHash: ipHash(req) });
      return { ok: true };
    });

    app.get('/api/admin/bans', async (req) => {
      requireAdmin(req);
      return {
        items: await many(
          ctx.db,
          `SELECT b.id, b.kind, b.reason, b.created_at, b.expires_at, u.username, s.slug AS streamer, a.username AS created_by
             FROM bans b JOIN users u ON u.id = b.user_id LEFT JOIN streamers s ON s.id = b.streamer_id JOIN users a ON a.id = b.created_by
            WHERE b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now()) ORDER BY b.created_at DESC LIMIT 300`,
        ),
      };
    });

    app.get('/api/admin/webhooks', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery.extend({ status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED']).optional(), provider: z.enum(['kick', 'stripe', 'mock']).optional() }), req.query);
      const params: unknown[] = [];
      let where = 'true';
      if (q.status) {
        params.push(q.status);
        where += ` AND w.status = $${params.length}`;
      }
      if (q.provider) {
        params.push(q.provider);
        where += ` AND w.provider = $${params.length}`;
      }
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        params.push(cursor.t, cursor.id);
        where += ` AND (w.received_at, w.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      const rows = await many<{ id: string; received_at: Date }>(
        ctx.db,
        `SELECT w.id, w.provider, w.event_id, w.event_type, w.status, w.error, w.attempts, w.received_at, w.processed_at
           FROM webhook_events w WHERE ${where} ORDER BY w.received_at DESC, w.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows.map((r) => ({ ...r, created_at: r.received_at })), q.limit);
    });
    app.post('/api/admin/webhooks/:id/retry', async (req) => {
      const admin = requireAdmin(req);
      const { id } = parse(idParam, req.params);
      const w = await one<{ id: string; provider: string; event_type: string; payload: unknown }>(
        ctx.db,
        `UPDATE webhook_events SET status = 'RECEIVED', attempts = attempts + 1 WHERE id = $1 AND status = 'FAILED' RETURNING id, provider, event_type, payload`,
        [id],
      );
      if (!w) throw Errors.conflict('Only failed webhook events can be retried');
      if (w.provider !== 'kick') {
        await ctx.db.query(`UPDATE webhook_events SET status = 'FAILED' WHERE id = $1`, [id]);
        throw Errors.badRequest('Payment events are retried by the provider (re-send from its dashboard)');
      }
      const r = await processStoredKickEvent(ctx, w.id, w.event_type, w.payload);
      await audit(ctx.db, { actorUserId: admin.id, action: 'admin.webhook_retried', entityType: 'webhook_event', entityId: id, metadata: { result: r.status } });
      return r;
    });

    app.get('/api/admin/jobs', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']).default('FAILED') }), req.query);
      return {
        items: await many(
          ctx.db,
          `SELECT j.id, j.kind, j.status, j.error_code, j.error, j.details, j.created_at, j.finished_at, u.username
             FROM audio_processing_jobs j JOIN users u ON u.id = j.owner_id WHERE j.status = $1 ORDER BY j.created_at DESC LIMIT 200`,
          [q.status],
        ),
      };
    });

    app.get('/api/admin/audit-logs', async (req) => {
      requireAdmin(req);
      const q = parse(pageQuery.extend({ action: z.string().max(60).optional() }), req.query);
      const params: unknown[] = [];
      let where = 'true';
      if (q.action) {
        params.push(`${q.action.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
        where += ` AND a.action LIKE $${params.length}`;
      }
      where += keyset('a', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip_hash, a.created_at, u.username AS actor, s.slug AS streamer
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN streamers s ON s.id = a.streamer_id
          WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });
  };

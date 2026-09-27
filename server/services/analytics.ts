import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';

export interface Range {
  from: Date;
  to: Date;
}

export function parseRange(range?: string, from?: string, to?: string): Range {
  const now = new Date();
  if (range === 'custom') {
    const f = from ? new Date(from) : null;
    const t = to ? new Date(to) : now;
    if (!f || Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f > t) throw Errors.validation('Invalid custom date range');
    if (t.getTime() - f.getTime() > 366 * 86400_000) throw Errors.validation('Custom range is limited to one year');
    return { from: f, to: new Date(t.getTime() + 86400_000 - 1) };
  }
  if (range === 'today') {
    const f = new Date(now);
    f.setUTCHours(0, 0, 0, 0);
    return { from: f, to: now };
  }
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  return { from: new Date(now.getTime() - days * 86400_000), to: now };
}

export async function channelDashboard(db: Db, streamerId: string) {
  const today = await one<{
    messages: number;
    points_spent: number;
    active_users: number;
    queue_length: number;
    pending: number;
  }>(
    db,
    `SELECT
       (SELECT COUNT(*)::int FROM messages WHERE streamer_id = $1 AND created_at >= date_trunc('day', now())) AS messages,
       (SELECT COALESCE(SUM(points_spent), 0)::int FROM messages WHERE streamer_id = $1 AND created_at >= date_trunc('day', now()) AND status NOT IN ('REJECTED','CANCELLED','EXPIRED')) AS points_spent,
       (SELECT COUNT(DISTINCT sender_id)::int FROM messages WHERE streamer_id = $1 AND created_at >= now() - interval '24 hours') AS active_users,
       (SELECT COUNT(*)::int FROM playback_queue WHERE streamer_id = $1 AND status = 'QUEUED') AS queue_length,
       (SELECT COUNT(*)::int FROM messages WHERE streamer_id = $1 AND status = 'PENDING' AND deleted_at IS NULL) AS pending`,
    [streamerId],
  );
  const money = await many<{ currency: string; total: number; n: number }>(
    db,
    `SELECT currency, COALESCE(SUM(amount_cents),0)::int AS total, COUNT(*)::int AS n FROM donations
      WHERE streamer_id = $1 AND status = 'COMPLETED' AND completed_at >= date_trunc('day', now()) GROUP BY currency`,
    [streamerId],
  );
  const subs = await one<{ subs: number; gifts: number }>(
    db,
    `SELECT (SELECT COUNT(*)::int FROM subscriptions WHERE streamer_id = $1 AND kind IN ('NEW','RENEWAL') AND created_at >= date_trunc('day', now())) AS subs,
            (SELECT COALESCE(SUM(gift_count),0)::int FROM gift_subscriptions WHERE streamer_id = $1 AND created_at >= date_trunc('day', now())) AS gifts`,
    [streamerId],
  );
  const recentDonations = await many(
    db,
    `SELECT d.id, d.amount_cents, d.currency, d.message, d.status, d.is_anonymous, d.created_at, u.display_name, u.avatar_url
       FROM donations d JOIN users u ON u.id = d.donor_id WHERE d.streamer_id = $1 AND d.status IN ('COMPLETED','REFUNDED') ORDER BY d.created_at DESC LIMIT 6`,
    [streamerId],
  );
  const topSupporters = await topSupportersFor(db, streamerId, new Date(Date.now() - 30 * 86400_000), new Date(), 5);
  const pointsActivity = await many<{ day: string; spent: number; messages: number }>(
    db,
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(SUM(m.points_spent),0)::int AS spent, COUNT(m.id)::int AS messages
       FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') AS d(day)
       LEFT JOIN messages m ON m.streamer_id = $1 AND date_trunc('day', m.created_at) = d.day AND m.status NOT IN ('REJECTED','CANCELLED','EXPIRED')
      GROUP BY d.day ORDER BY d.day`,
    [streamerId],
  );
  return {
    cards: {
      todayMessages: today!.messages,
      todayDonations: money.map((m) => ({ currency: m.currency, totalCents: m.total, count: m.n })),
      pointsSpentToday: today!.points_spent,
      subscriptionsToday: subs!.subs,
      giftSubsToday: subs!.gifts,
      queueLength: today!.queue_length,
      pendingReview: today!.pending,
      activeUsers24h: today!.active_users,
    },
    recentDonations,
    topSupporters,
    pointsActivity,
  };
}

async function topSupportersFor(db: Db, streamerId: string, from: Date, to: Date, limit: number) {
  return many<{ id: string; username: string; display_name: string; avatar_url: string | null; points: number; messages: number; donated_cents: number }>(
    db,
    `WITH pts AS (
       SELECT sender_id AS user_id, SUM(points_spent)::int AS points, COUNT(*)::int AS messages
         FROM messages WHERE streamer_id = $1 AND created_at BETWEEN $2 AND $3 AND status NOT IN ('REJECTED','CANCELLED','EXPIRED') AND donation_id IS NULL
        GROUP BY sender_id),
     don AS (
       SELECT donor_id AS user_id, SUM(amount_cents)::int AS donated_cents
         FROM donations WHERE streamer_id = $1 AND status = 'COMPLETED' AND NOT is_anonymous AND completed_at BETWEEN $2 AND $3
        GROUP BY donor_id)
     SELECT u.id, u.username, u.display_name, u.avatar_url,
            COALESCE(pts.points,0) AS points, COALESCE(pts.messages,0) AS messages, COALESCE(don.donated_cents,0) AS donated_cents
       FROM users u LEFT JOIN pts ON pts.user_id = u.id LEFT JOIN don ON don.user_id = u.id
      WHERE pts.user_id IS NOT NULL OR don.user_id IS NOT NULL
      ORDER BY COALESCE(don.donated_cents,0) * 10 + COALESCE(pts.points,0) DESC
      LIMIT ${limit}`,
    [streamerId, from, to],
  );
}

export async function channelAnalytics(db: Db, streamerId: string, r: Range) {
  const p = [streamerId, r.from, r.to];
  const daily = await many<{ day: string; text: number; voice: number; mp3: number; sound: number; points: number; donations_cents: number; subs: number; gifts: number }>(
    db,
    `WITH days AS (SELECT generate_series(date_trunc('day', $2::timestamptz), date_trunc('day', $3::timestamptz), interval '1 day') AS day)
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            (SELECT COUNT(*)::int FROM messages m WHERE m.streamer_id = $1 AND m.type = 'TEXT' AND date_trunc('day', m.created_at) = days.day) AS text,
            (SELECT COUNT(*)::int FROM messages m WHERE m.streamer_id = $1 AND m.type = 'VOICE' AND date_trunc('day', m.created_at) = days.day) AS voice,
            (SELECT COUNT(*)::int FROM messages m WHERE m.streamer_id = $1 AND m.type = 'MP3' AND date_trunc('day', m.created_at) = days.day) AS mp3,
            (SELECT COUNT(*)::int FROM messages m WHERE m.streamer_id = $1 AND m.type = 'SOUND' AND date_trunc('day', m.created_at) = days.day) AS sound,
            (SELECT COALESCE(SUM(points_spent),0)::int FROM messages m WHERE m.streamer_id = $1 AND date_trunc('day', m.created_at) = days.day AND m.status NOT IN ('REJECTED','CANCELLED','EXPIRED')) AS points,
            (SELECT COALESCE(SUM(amount_cents),0)::int FROM donations d WHERE d.streamer_id = $1 AND d.status = 'COMPLETED' AND date_trunc('day', d.completed_at) = days.day) AS donations_cents,
            (SELECT COUNT(*)::int FROM subscriptions s WHERE s.streamer_id = $1 AND s.kind IN ('NEW','RENEWAL') AND date_trunc('day', s.created_at) = days.day) AS subs,
            (SELECT COALESCE(SUM(gift_count),0)::int FROM gift_subscriptions g WHERE g.streamer_id = $1 AND date_trunc('day', g.created_at) = days.day) AS gifts
       FROM days ORDER BY days.day`,
    p,
  );
  const totals = daily.reduce(
    (a, d) => ({
      text: a.text + d.text,
      voice: a.voice + d.voice,
      mp3: a.mp3 + d.mp3,
      sound: a.sound + d.sound,
      points: a.points + d.points,
      donationsCents: a.donationsCents + d.donations_cents,
      subs: a.subs + d.subs,
      gifts: a.gifts + d.gifts,
    }),
    { text: 0, voice: 0, mp3: 0, sound: 0, points: 0, donationsCents: 0, subs: 0, gifts: 0 },
  );
  const pointsEarned = await one<{ n: number }>(
    db,
    `SELECT COALESCE(SUM(amount),0)::int AS n FROM points_transactions WHERE streamer_id = $1 AND amount > 0 AND type IN ('POINTS_REWARDED','POINTS_EARNED') AND created_at BETWEEN $2 AND $3`,
    p,
  );
  const topSounds = await many(
    db,
    `SELECT so.id, so.name, so.icon, so.color, COUNT(su.id)::int AS uses, COALESCE(SUM(su.points_spent),0)::int AS points
       FROM sound_usage su JOIN sounds so ON so.id = su.sound_id
      WHERE su.streamer_id = $1 AND su.created_at BETWEEN $2 AND $3 GROUP BY so.id ORDER BY uses DESC LIMIT 8`,
    p,
  );
  const peakHours = await many<{ hour: number; n: number }>(
    db,
    `SELECT h.hour, COUNT(m.id)::int AS n
       FROM generate_series(0, 23) AS h(hour)
       LEFT JOIN messages m ON m.streamer_id = $1 AND m.created_at BETWEEN $2 AND $3 AND EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'UTC')::int = h.hour
      GROUP BY h.hour ORDER BY h.hour`,
    p,
  );
  return {
    range: { from: r.from, to: r.to },
    daily,
    totals: { ...totals, pointsEarned: pointsEarned!.n },
    topSupporters: await topSupportersFor(db, streamerId, r.from, r.to, 10),
    topSounds,
    peakHours,
  };
}

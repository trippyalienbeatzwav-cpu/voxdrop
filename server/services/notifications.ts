import type { Db } from '../db/client.js';
import { one } from '../db/client.js';
import type { Outbox } from '../events/bus.js';
import { Topic } from '../events/bus.js';

export type NotificationType =
  | 'message.approved'
  | 'message.rejected'
  | 'message.played'
  | 'message.expired'
  | 'points.received'
  | 'subscription.reward'
  | 'gift_sub.reward'
  | 'donation.completed'
  | 'donation.received'
  | 'donation.refunded'
  | 'refund'
  | 'moderation.warning'
  | 'moderation.banned'
  | 'security';

export async function notify(
  db: Db,
  outbox: Outbox | undefined,
  userId: string,
  type: NotificationType,
  title: string,
  body = '',
  data: Record<string, unknown> = {},
) {
  const row = await one<{ id: string; created_at: Date }>(
    db,
    `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [userId, type, title.slice(0, 120), body.slice(0, 400), JSON.stringify(data)],
  );
  outbox?.push(Topic.user(userId), 'notification.created', { id: row!.id, type, title, body, data, created_at: row!.created_at, read_at: null });
  return row!;
}

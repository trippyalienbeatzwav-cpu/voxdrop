import type { Db } from '../db/client.js';
import { one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import type { Outbox } from '../events/bus.js';
import { Topic } from '../events/bus.js';

export type PointsTxType =
  | 'POINTS_EARNED'
  | 'POINTS_SPENT'
  | 'POINTS_PURCHASED'
  | 'POINTS_REWARDED'
  | 'POINTS_REFUNDED'
  | 'POINTS_ADJUSTED'
  | 'POINTS_EXPIRED'
  | 'POINTS_SPENT_PRIORITY';

/** Which direction each type may move a balance. ADJUSTED may go either way. */
const SIGN: Record<PointsTxType, 1 | -1 | 0> = {
  POINTS_EARNED: 1,
  POINTS_PURCHASED: 1,
  POINTS_REWARDED: 1,
  POINTS_REFUNDED: 1,
  POINTS_SPENT: -1,
  POINTS_EXPIRED: -1,
  POINTS_SPENT_PRIORITY: -1,
  POINTS_ADJUSTED: 0,
};

export interface PointsTxInput {
  userId: string;
  type: PointsTxType;
  /** Signed amount. Must match the direction of `type`. */
  amount: number;
  description: string;
  streamerId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  /** Guarantees at-most-once application (e.g. `kick:<event>:<user>`). */
  idempotencyKey?: string | null;
  createdBy?: string | null;
  /** Set for POINTS_SPENT_PRIORITY and priority refunds. */
  priorityTier?: string | null;
}

export interface PointsTxRow {
  id: string;
  user_id: string;
  streamer_id: string | null;
  type: PointsTxType;
  amount: number;
  balance_before: number;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  description: string;
  created_at: Date;
}

export interface PointsResult {
  tx: PointsTxRow;
  /** false when the idempotency key had already been applied (no-op). */
  applied: boolean;
  balance: number;
}

/**
 * The ONLY way a points balance changes. Runs inside a DB transaction, locks
 * the account row (`SELECT … FOR UPDATE`) so concurrent spends serialize, and
 * writes an immutable ledger row whose balance_before/after are checked by a
 * table constraint. Balances can never go negative (CHECK + explicit guard).
 */
export async function applyPoints(db: Db, input: PointsTxInput, outbox?: Outbox): Promise<PointsResult> {
  if (!Number.isInteger(input.amount) || input.amount === 0) throw Errors.badRequest('Points amount must be a non-zero integer');
  const sign = SIGN[input.type];
  if (sign !== 0 && Math.sign(input.amount) !== sign) throw Errors.badRequest(`${input.type} must be ${sign > 0 ? 'positive' : 'negative'}`);

  return db.tx(async (q) => {
    await q.query('INSERT INTO points_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [input.userId]);
    const acct = await one<{ balance: number }>(q, 'SELECT balance FROM points_accounts WHERE user_id = $1 FOR UPDATE', [input.userId]);
    if (!acct) throw Errors.notFound('Points account');

    // Idempotency check happens AFTER taking the row lock, so two concurrent
    // deliveries of the same event cannot both pass it.
    if (input.idempotencyKey) {
      const existing = await one<PointsTxRow>(q, 'SELECT * FROM points_transactions WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (existing) return { tx: existing, applied: false, balance: acct.balance };
    }

    const before = acct.balance;
    const after = before + input.amount;
    if (after < 0) throw Errors.insufficientPoints(-input.amount, before);

    await q.query(
      `UPDATE points_accounts
          SET balance = $2,
              lifetime_earned = lifetime_earned + GREATEST($3::int, 0),
              lifetime_spent  = lifetime_spent  + GREATEST(-$3::int, 0),
              updated_at = now()
        WHERE user_id = $1`,
      [input.userId, after, input.amount],
    );
    const tx = await one<PointsTxRow>(
      q,
      `INSERT INTO points_transactions
         (user_id, streamer_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, idempotency_key, created_by, priority_tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.userId,
        input.streamerId ?? null,
        input.type,
        input.amount,
        before,
        after,
        input.referenceType ?? null,
        input.referenceId ?? null,
        input.description.slice(0, 200),
        input.idempotencyKey ?? null,
        input.createdBy ?? null,
        input.priorityTier ?? null,
      ],
    );
    outbox?.push(Topic.user(input.userId), 'points.updated', { balance: after, delta: input.amount, type: input.type, description: tx!.description });
    return { tx: tx!, applied: true, balance: after };
  });
}

export async function getBalance(db: Db, userId: string): Promise<number> {
  const row = await one<{ balance: number }>(db, 'SELECT balance FROM points_accounts WHERE user_id = $1', [userId]);
  return row?.balance ?? 0;
}

/** Sum of positive reward transactions for a user today (UTC) — used by anti-abuse caps. */
export async function rewardedToday(db: Db, userId: string, streamerId: string): Promise<number> {
  const row = await one<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(amount), 0)::int AS total FROM points_transactions
      WHERE user_id = $1 AND streamer_id = $2 AND type = 'POINTS_REWARDED' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [userId, streamerId],
  );
  return row?.total ?? 0;
}

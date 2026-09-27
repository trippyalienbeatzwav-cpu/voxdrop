import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPoints, getBalance } from '../../server/services/points.js';
import { login, makeTestEnv, type TestEnv } from '../helpers/setup.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
});
afterAll(() => env.close());

describe('points ledger', () => {
  it('every change writes an immutable transaction with before/after balances', async () => {
    const c = await login(env, 'ledger_user');
    await applyPoints(env.db, { userId: c.userId, type: 'POINTS_REWARDED', amount: 500, description: 'sub' });
    await applyPoints(env.db, { userId: c.userId, type: 'POINTS_SPENT', amount: -150, description: 'voice' });
    const rows = (await env.db.query<{ amount: number; balance_before: number; balance_after: number }>('SELECT amount, balance_before, balance_after FROM points_transactions WHERE user_id = $1 ORDER BY created_at', [c.userId])).rows;
    expect(rows).toEqual([
      { amount: 500, balance_before: 0, balance_after: 500 },
      { amount: -150, balance_before: 500, balance_after: 350 },
    ]);
    expect(await getBalance(env.db, c.userId)).toBe(350);
  });

  it('balance equals the sum of the ledger', async () => {
    const r = await env.db.query<{ ok: boolean }>(
      `SELECT bool_and(a.balance = COALESCE(t.sum, 0)) AS ok FROM points_accounts a
         LEFT JOIN (SELECT user_id, SUM(amount)::int AS sum FROM points_transactions GROUP BY user_id) t ON t.user_id = a.user_id`,
    );
    expect(r.rows[0]!.ok).toBe(true);
  });

  it('refuses to overdraw and leaves no partial writes', async () => {
    const c = await login(env, 'poor_user');
    await applyPoints(env.db, { userId: c.userId, type: 'POINTS_EARNED', amount: 100, description: 'x' });
    await expect(applyPoints(env.db, { userId: c.userId, type: 'POINTS_SPENT', amount: -101, description: 'too much' })).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS' });
    expect(await getBalance(env.db, c.userId)).toBe(100);
    const n = await env.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM points_transactions WHERE user_id = $1', [c.userId]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('rejects amounts whose sign contradicts the type', async () => {
    const c = await login(env, 'sign_user');
    await expect(applyPoints(env.db, { userId: c.userId, type: 'POINTS_SPENT', amount: 50, description: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(applyPoints(env.db, { userId: c.userId, type: 'POINTS_REWARDED', amount: -50, description: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('concurrent spends cannot exceed the balance (row lock serialises them)', async () => {
    const c = await login(env, 'race_user');
    await applyPoints(env.db, { userId: c.userId, type: 'POINTS_EARNED', amount: 500, description: 'x' });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => applyPoints(env.db, { userId: c.userId, type: 'POINTS_SPENT', amount: -100, description: 'race' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await getBalance(env.db, c.userId)).toBe(0);
  });

  it('idempotency keys apply a credit at most once', async () => {
    const c = await login(env, 'idem_user');
    const a = await applyPoints(env.db, { userId: c.userId, type: 'POINTS_REWARDED', amount: 750, description: 'gift', idempotencyKey: 'kick:evt-1:u' });
    const b = await applyPoints(env.db, { userId: c.userId, type: 'POINTS_REWARDED', amount: 750, description: 'gift', idempotencyKey: 'kick:evt-1:u' });
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(false);
    expect(await getBalance(env.db, c.userId)).toBe(750);
  });

  it('the ledger is append-only at the database level', async () => {
    await expect(env.db.query(`UPDATE points_transactions SET amount = 999999`)).rejects.toThrow(/append-only/);
    await expect(env.db.query(`DELETE FROM points_transactions`)).rejects.toThrow(/append-only/);
  });

  it('users cannot change their own balance through the API', async () => {
    const c = await login(env, 'cheater');
    const r1 = await c.patch('/api/me', { points: 1_000_000 });
    expect(r1.statusCode).toBe(422); // strict schema rejects unknown fields
    const r2 = await c.post(`/api/admin/users/${c.userId}/points-adjust`, { amount: 1000, reason: 'please' });
    expect(r2.statusCode).toBe(403);
    expect(await getBalance(env.db, c.userId)).toBe(0);
  });
});

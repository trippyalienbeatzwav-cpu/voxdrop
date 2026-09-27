import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../../server/db/seed.js';
import { makeTestEnv, type TestEnv } from '../helpers/setup.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
});
afterAll(() => env.close());

describe('demo seed', () => {
  it('builds a consistent demo world through the real services', async () => {
    const r = await seedDemo(env.ctx);
    expect(r.skipped).toBe(false);
    const q = async (sql: string) => (await env.db.query<Record<string, number>>(sql)).rows[0]!;
    expect(await q(`SELECT COUNT(*)::int AS n FROM streamers`)).toEqual({ n: 3 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM sounds`)).n).toBe(12);
    expect((await q(`SELECT COUNT(*)::int AS n FROM donations WHERE status = 'COMPLETED'`)).n).toBe(3);
    expect((await q(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE reward_status = 'PENDING_LINK'`)).n).toBeGreaterThan(0);
    // Ledger invariant holds for every account
    const inv = await env.db.query<{ ok: boolean }>(
      `SELECT bool_and(a.balance = COALESCE(t.sum, 0)) AS ok FROM points_accounts a
         LEFT JOIN (SELECT user_id, SUM(amount)::int AS sum FROM points_transactions GROUP BY user_id) t ON t.user_id = a.user_id`,
    );
    expect(inv.rows[0]!.ok).toBe(true);
    expect((await seedDemo(env.ctx)).skipped).toBe(true);
  });
});

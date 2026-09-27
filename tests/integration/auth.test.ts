import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieFrom, login, makeTestEnv, type TestEnv } from '../helpers/setup.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
});
afterAll(() => env.close());

async function startFlow() {
  const start = await env.app.inject({ method: 'GET', url: '/auth/kick?next=/streamers' });
  const url = new URL(start.headers.location as string);
  return { start, url, nonce: cookieFrom(start, 'vx_oauth')!, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! };
}

describe('Kick OAuth (PKCE + state) flow', () => {
  it('redirects to the provider with S256 PKCE and a browser-bound state', async () => {
    const f = await startFlow();
    expect(f.start.statusCode).toBe(302);
    expect(f.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.state.length).toBeGreaterThan(20);
    expect(f.start.headers['set-cookie']).toMatch(/vx_oauth=.*HttpOnly/i);
  });

  it('creates a user + session and redirects to the requested page', async () => {
    const f = await startFlow();
    const auth = await env.app.inject({ method: 'POST', url: '/api/dev/mock-kick/authorize', payload: { state: f.state, codeChallenge: f.challenge, username: 'alice_k' } });
    const cb = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${f.nonce}` } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/streamers');
    const sessionCookie = (Array.isArray(cb.headers['set-cookie']) ? cb.headers['set-cookie'] : [cb.headers['set-cookie']]).find((c) => c?.startsWith('vx_session='))!;
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  it('state is single-use (replayed callback fails)', async () => {
    const f = await startFlow();
    const auth = await env.app.inject({ method: 'POST', url: '/api/dev/mock-kick/authorize', payload: { state: f.state, codeChallenge: f.challenge, username: 'bob_k' } });
    const first = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${f.nonce}` } });
    expect(cookieFrom(first, 'vx_session')).toBeTruthy();
    const replay = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${f.nonce}` } });
    expect(replay.headers.location).toBe('/login?error=kick_auth_failed');
    expect(cookieFrom(replay, 'vx_session')).toBeNull();
  });

  it('rejects a callback from a different browser (login CSRF)', async () => {
    const f = await startFlow();
    const auth = await env.app.inject({ method: 'POST', url: '/api/dev/mock-kick/authorize', payload: { state: f.state, codeChallenge: f.challenge, username: 'carol_k' } });
    const cb = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: 'vx_oauth=someone-elses-nonce' } });
    expect(cb.headers.location).toBe('/login?error=kick_auth_failed');
  });

  it('rejects a code issued for a different PKCE challenge', async () => {
    const f = await startFlow();
    const auth = await env.app.inject({ method: 'POST', url: '/api/dev/mock-kick/authorize', payload: { state: f.state, codeChallenge: 'A'.repeat(43), username: 'dave_k' } });
    const cb = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${f.nonce}` } });
    expect(cb.headers.location).toBe('/login?error=kick_auth_failed');
  });

  it('surfaces a cancelled Kick consent as a friendly error', async () => {
    const f = await startFlow();
    const cb = await env.app.inject({ method: 'GET', url: `/auth/kick/callback?error=access_denied&state=${f.state}`, headers: { cookie: `vx_oauth=${f.nonce}` } });
    expect(cb.headers.location).toBe('/login?error=kick_auth_denied');
  });

  it('never duplicates accounts: the same Kick id always maps to one user', async () => {
    const a = await login(env, 'erin_k', '4242');
    const b = await login(env, 'erin_k', '4242');
    expect(a.userId).toBe(b.userId);
    const count = await env.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM kick_accounts WHERE kick_user_id = '4242'`);
    expect(count.rows[0]!.n).toBe(1);
  });

  it('stores no Kick tokens for viewers (data minimisation)', async () => {
    const c = await login(env, 'frank_k');
    const r = await env.db.query<{ access_token_enc: string | null }>('SELECT access_token_enc FROM kick_accounts WHERE user_id = $1', [c.userId]);
    expect(r.rows[0]!.access_token_enc).toBeNull();
  });
});

describe('sessions, CSRF and logout', () => {
  it('rejects state-changing requests without the CSRF header', async () => {
    const c = await login(env, 'gina_k');
    const res = await env.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie: c.cookie }, payload: { displayName: 'Hacked' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_FAILED');
    const ok = await c.patch('/api/me', { displayName: 'Gina' });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects cross-origin requests even with a valid token', async () => {
    const c = await login(env, 'hank_k');
    const res = await env.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: 'https://evil.example' }, payload: { displayName: 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('logout revokes the session server-side', async () => {
    const c = await login(env, 'ivy_k');
    expect((await c.get('/api/me')).json().user).not.toBeNull();
    await c.post('/auth/logout');
    expect((await c.get('/api/me')).json().user).toBeNull();
  });

  it('suspended users lose access immediately', async () => {
    const c = await login(env, 'jack_k');
    await env.db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [c.userId]);
    const res = await c.get('/api/points');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('unauthenticated API calls get 401', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/points' });
    expect(res.statusCode).toBe(401);
  });

  it('daily bonus can be claimed once per day and is ledgered', async () => {
    const c = await login(env, 'kim_k');
    const first = await c.post('/api/me/daily-bonus');
    expect(first.statusCode).toBe(200);
    expect(first.json().balance).toBe(25);
    const again = await c.post('/api/me/daily-bonus');
    expect(again.statusCode).toBe(409);
    const tx = (await c.get('/api/points/transactions')).json();
    expect(tx.items).toHaveLength(1);
    expect(tx.items[0]).toMatchObject({ type: 'POINTS_EARNED', amount: 25, balance_before: 0, balance_after: 25 });
  });
});

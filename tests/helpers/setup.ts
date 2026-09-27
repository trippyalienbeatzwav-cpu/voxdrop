import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../../server/config.js';
import { createDb, type Db } from '../../server/db/client.js';
import { migrate } from '../../server/db/migrate.js';
import { seedBaseline } from '../../server/db/seed.js';
import { buildContext, type AppContext } from '../../server/context.js';
import { buildApp } from '../../server/app.js';
import { MemoryStorageService } from '../../server/integrations/storage/StorageService.js';
import { clearQueueTimers } from '../../server/services/queue.js';
import { applyPoints } from '../../server/services/points.js';

const silent = { info() {}, warn() {}, error() {} };

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  storage: MemoryStorageService;
  close(): Promise<void>;
}

export async function makeTestEnv(overrides: Record<string, string | number> = {}): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    KICK_MODE: 'mock',
    PAYMENT_PROVIDER: 'mock',
    STORAGE_PROVIDER: 'mock',
    APP_URL: 'http://localhost:5173',
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop',
    DAILY_BONUS_POINTS: 25,
    STARTING_POINTS: 0,
    CLAMAV_HOST: '',
    ...overrides,
  });
  const db = await createDb('pglite://memory');
  await migrate(db);
  await seedBaseline(db);
  const storage = new MemoryStorageService();
  const ctx = buildContext(config, db, { storage, log: silent });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    db,
    storage,
    async close() {
      clearQueueTimers();
      await app.close();
      await db.close();
    },
  };
}

/** A signed-in browser: carries the session cookie and CSRF token like the real frontend. */
export class Client {
  constructor(
    private readonly app: FastifyInstance,
    public cookie: string,
    public csrf: string,
    public userId: string,
    public username: string,
  ) {}

  private req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.app.inject({
      method,
      url,
      headers: { cookie: this.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': this.csrf }), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.req('POST', url, body, headers);
  }
  patch(url: string, body: unknown) {
    return this.req('PATCH', url, body);
  }
  del(url: string) {
    return this.req('DELETE', url);
  }
  upload(file: Buffer, filename: string, mime: string, fields: Record<string, string>) {
    const { body, contentType } = multipart(fields, { name: 'file', filename, mime, data: file });
    return this.app.inject({ method: 'POST', url: '/api/audio/upload', headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, 'content-type': contentType }, payload: body });
  }
}

export function cookieFrom(res: LightMyRequestResponse, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

/** Runs the complete (mock-provider) Kick OAuth + PKCE flow and returns a signed-in client. */
let ipSeq = 0;
/** A distinct client IP per simulated sign-in so the per-IP auth rate limit models real, separate users. */
export const nextIp = () => `10.${(++ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;

export async function login(env: TestEnv, username: string, kickUserId?: string): Promise<Client> {
  const remoteAddress = nextIp();
  const start = await env.app.inject({ method: 'GET', url: '/auth/kick?next=/dashboard', remoteAddress });
  if (start.statusCode !== 302) throw new Error(`auth start ${start.statusCode}`);
  const authorizeUrl = new URL(start.headers.location as string);
  const nonce = cookieFrom(start, 'vx_oauth')!;
  const auth = await env.app.inject({
    method: 'POST',
    url: '/api/dev/mock-kick/authorize',
    payload: { state: authorizeUrl.searchParams.get('state'), codeChallenge: authorizeUrl.searchParams.get('code_challenge'), username, kickUserId },
  });
  if (auth.statusCode !== 200) throw new Error(`mock authorize ${auth.statusCode} ${auth.body}`);
  const cb = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${nonce}` }, remoteAddress });
  const session = cookieFrom(cb, 'vx_session');
  if (!session) throw new Error(`callback failed: ${cb.statusCode} ${cb.headers.location}`);
  const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vx_session=${session}` } });
  const j = me.json();
  return new Client(env.app, `vx_session=${session}`, j.csrfToken, j.user.id, j.user.username);
}

/** Turns a signed-in user into a streamer through the real connect-channel OAuth flow. */
export async function becomeStreamer(env: TestEnv, client: Client, kickUserId: string): Promise<string> {
  const start = await client.post('/api/me/connect-channel');
  const url = new URL(start.json().url);
  const nonce = cookieFrom(start, 'vx_oauth')!;
  const auth = await env.app.inject({
    method: 'POST',
    url: '/api/dev/mock-kick/authorize',
    payload: { state: url.searchParams.get('state'), codeChallenge: url.searchParams.get('code_challenge'), username: client.username, kickUserId },
  });
  const cb = await env.app.inject({ method: 'GET', url: auth.json().redirect, headers: { cookie: `vx_oauth=${nonce}; ${client.cookie}` } });
  const session = cookieFrom(cb, 'vx_session');
  if (!session) throw new Error(`connect failed: ${cb.headers.location}`);
  client.cookie = `vx_session=${session}`;
  const me = (await client.get('/api/me')).json();
  client.csrf = me.csrfToken;
  return me.channels.find((c: { access: string }) => c.access === 'owner').id;
}

export async function grant(env: TestEnv, userId: string, amount: number) {
  await applyPoints(env.db, { userId, type: 'POINTS_ADJUSTED', amount, description: 'test grant' });
}

export function multipart(fields: Record<string, string>, file: { name: string; filename: string; mime: string; data: Buffer }) {
  const boundary = '----voxdroptest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

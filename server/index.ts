import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { buildContext } from './context.js';
import { buildApp } from './app.js';
import { clearQueueTimers, sweep } from './services/queue.js';
import { seedBaseline } from './db/seed.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = await createDb(config.DATABASE_URL);
const ran = await migrate(db);
if (ran.length) console.log(`[db] applied migrations: ${ran.join(', ')}`);
await seedBaseline(db);

const ctx = buildContext(config, db);
const app = await buildApp(ctx);

if (config.usesMocks) {
  const mocks = [
    config.KICK_MODE === 'mock' && 'MockKickService',
    config.PAYMENT_PROVIDER === 'mock' && 'MockPaymentService',
    config.STORAGE_PROVIDER === 'mock' && 'MockStorageService',
  ].filter(Boolean);
  console.warn(`\n  ⚠  DEVELOPMENT MOCKS ACTIVE: ${mocks.join(', ')}\n     Nothing here talks to Kick, moves real money, or uses cloud storage.\n`);
}
if (ctx.scanner.name === 'none') console.warn('  ⚠  No CLAMAV_HOST configured: uploads are validated and re-encoded but not antivirus-scanned.\n');

const sweeper = setInterval(() => {
  sweep(ctx).catch((err) => ctx.log.error({ err }, 'sweep failed'));
}, 30_000);

await app.listen({ port: config.PORT, host: config.isProd ? '0.0.0.0' : '127.0.0.1' });
console.log(`[api] VoxDrop API listening on :${config.PORT} (app: ${config.APP_URL})`);

const shutdown = async () => {
  clearInterval(sweeper);
  clearQueueTimers();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

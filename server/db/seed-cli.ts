import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';
import { migrate } from './migrate.js';
import { seedBaseline, seedDemo } from './seed.js';
import { buildContext } from '../context.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
if (config.isProd) {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
const db = await createDb(config.DATABASE_URL);
await migrate(db);
await seedBaseline(db);
const ctx = buildContext(config, db);
const r = await seedDemo(ctx);
console.log(r.skipped ? 'Demo data already present — skipped.' : `Seeded demo data (${r.users} users).`);
await db.close();

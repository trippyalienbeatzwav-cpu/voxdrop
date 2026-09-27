import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';
import { migrate } from './migrate.js';
import { seedBaseline } from './seed.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const db = await createDb(config.DATABASE_URL);
const ran = await migrate(db);
await seedBaseline(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await db.close();

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locates SQL migrations both from source (tsx) and from the compiled dist tree. */
function migrationsDir(): string {
  const candidates = [path.join(here, 'migrations'), path.resolve(here, '../../../server/db/migrations')];
  for (const c of candidates) {
    try {
      if (readdirSync(c).some((f) => f.endsWith('.sql'))) return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not locate SQL migrations directory');
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    // Multi-statement scripts are sent as one simple-query message (no params),
    // which both node-postgres and PGlite execute atomically inside the tx.
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}

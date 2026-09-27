import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { PGlite as PGliteType } from '@electric-sql/pglite';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal database surface every service depends on. Implemented by a real
 * PostgreSQL pool (production) and by PGlite (in-process PostgreSQL for
 * development and tests). All SQL is plain parameterised PostgreSQL.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Executes a multi-statement script without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  readonly inTransaction: boolean;
  close(): Promise<void>;
}

/** Shorthand used by services: first row or null. */
export async function one<T>(db: Db, sql: string, params?: unknown[]): Promise<T | null> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T>(db: Db, sql: string, params?: unknown[]): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

type Runner = {
  query: <T>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
  exec: (sql: string) => Promise<void>;
};

class TxScope implements Db {
  readonly inTransaction = true;
  constructor(private readonly runner: Runner) {}
  query<T>(sql: string, params?: unknown[]) {
    return this.runner.query<T>(sql, params);
  }
  exec(sql: string) {
    return this.runner.exec(sql);
  }
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close() {}
}

class PgDb implements Db {
  readonly inTransaction = false;
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async exec(sql: string) {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (q: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scope = new TxScope({
        query: async <R>(sql: string, params: unknown[] = []) => {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
        exec: async (sql: string) => {
          await client.query(sql);
        },
      });
      const out = await fn(scope);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly inTransaction = false;
  constructor(private readonly db: PGliteType) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.db.query<T>(sql, params as unknown[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }

  async exec(sql: string) {
    await this.db.exec(sql);
  }

  async tx<T>(fn: (q: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(async (t) => {
      const scope = new TxScope({
        query: async <R>(sql: string, params: unknown[] = []) => {
          const r = await t.query<R>(sql, params as unknown[]);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
        exec: async (sql: string) => {
          await t.exec(sql);
        },
      });
      return fn(scope);
    }) as Promise<T>;
  }

  close() {
    return this.db.close();
  }
}

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const target = url.slice('pglite://'.length);
    if (target === 'memory') return new PgliteDb(new PGlite());
    const dir = path.resolve(target);
    mkdirSync(dir, { recursive: true });
    return new PgliteDb(new PGlite(dir));
  }
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return new PgDb(pool);
}

/** Maps PostgreSQL unique-violation errors (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== '23505') return false;
  if (!constraint) return true;
  return e.constraint === constraint || (e.message ?? '').includes(constraint);
}

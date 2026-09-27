import { z } from 'zod';

/**
 * Keyset pagination on (created_at, id) — stable under concurrent inserts and
 * cheap at any depth, unlike OFFSET.
 */
export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(row: { created_at: Date | string; id: string }): string {
  const t = new Date(row.created_at).toISOString();
  return Buffer.from(JSON.stringify({ t, id: row.id })).toString('base64url');
}

export function decodeCursor(cursor?: string): Cursor | null {
  if (!cursor) return null;
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof c.t === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.t)) && /^[0-9a-f-]{36}$/i.test(c.id)) {
      return { t: c.t, id: c.id };
    }
  } catch {
    /* invalid cursor → first page */
  }
  return null;
}

/** Appends a keyset predicate for `alias`, pushing its params. */
export function keyset(alias: string, cursor: Cursor | null, params: unknown[]): string {
  if (!cursor) return '';
  params.push(cursor.t, cursor.id);
  return ` AND (${alias}.created_at, ${alias}.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
}

export function pageOf<T extends { created_at: Date | string; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(items[items.length - 1]!) : null };
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, Errors } from './lib/errors.js';
import type { SessionUser } from './services/types.js';
import type { SessionRow } from './auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    session: SessionRow | null;
    rawBody?: Buffer;
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw Errors.unauthorized();
  if (req.user.status !== 'ACTIVE') throw Errors.suspended();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'ADMIN') throw Errors.forbidden('Admins only');
  return u;
}

/** Validates input with zod and converts failures to a 422 with field details. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw new AppError(422, 'VALIDATION_FAILED', 'Some fields are invalid', { fields });
  }
  return r.data;
}

export const idParam = z.object({ id: z.string().uuid() });
export const sidParam = z.object({ sid: z.string().uuid() });

export function noStore(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
}

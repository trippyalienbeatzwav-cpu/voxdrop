/**
 * Typed application errors. Every error that reaches the HTTP layer is mapped to
 * `{ error: { code, message, details? } }` with a stable machine-readable code
 * the frontend uses to pick the right error state.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message: string, details?: Record<string, unknown>) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (message: string, details?: Record<string, unknown>) => new AppError(422, 'VALIDATION_FAILED', message, details),
  unauthorized: (message = 'Sign in to continue') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'You do not have permission to do that') => new AppError(403, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (message: string, code = 'CONFLICT') => new AppError(409, code, message),
  insufficientPoints: (needed: number, balance: number) =>
    new AppError(402, 'INSUFFICIENT_POINTS', `You need ${needed.toLocaleString('en-US')} points but have ${balance.toLocaleString('en-US')}`, { needed, balance }),
  cooldown: (retryAfterSeconds: number, what = 'message') =>
    new AppError(429, 'COOLDOWN_ACTIVE', `Cooldown active — you can send another ${what} in ${retryAfterSeconds}s`, { retryAfterSeconds }),
  limitReached: (message: string, details?: Record<string, unknown>) => new AppError(429, 'LIMIT_REACHED', message, details),
  fileTooLarge: (maxBytes: number) =>
    new AppError(413, 'FILE_TOO_LARGE', `File is larger than the ${(maxBytes / 1048576).toFixed(1)} MB limit`, { maxBytes }),
  audioTooLong: (durationMs: number, maxSeconds: number) =>
    new AppError(422, 'AUDIO_TOO_LONG', `Audio is ${(durationMs / 1000).toFixed(1)}s — the limit is ${maxSeconds}s`, { durationMs, maxSeconds }),
  unsupportedMedia: (message: string) => new AppError(415, 'UNSUPPORTED_MEDIA', message),
  featureDisabled: (message: string) => new AppError(403, 'FEATURE_DISABLED', message),
  banned: (message: string, details?: Record<string, unknown>) => new AppError(403, 'BANNED', message, details),
  suspended: () => new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended'),
  payment: (message: string) => new AppError(402, 'PAYMENT_FAILED', message),
  upstream: (message: string) => new AppError(502, 'UPSTREAM_ERROR', message),
};

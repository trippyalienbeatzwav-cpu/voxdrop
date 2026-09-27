import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Overrides PORT (useful when a process manager injects PORT for the web dev server). */
  API_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('pglite://./data/pglite'),
  SESSION_SECRET: z.string().default(''),

  KICK_MODE: z.enum(['live', 'mock']).default('mock'),
  KICK_CLIENT_ID: z.string().default(''),
  KICK_CLIENT_SECRET: z.string().default(''),
  KICK_REDIRECT_URI: z.string().default(''),
  KICK_WEBHOOK_PUBLIC_KEY: z.string().default(''),

  STORAGE_PROVIDER: z.enum(['s3', 'mock']).default('mock'),
  STORAGE_BUCKET: z.string().default(''),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_ENDPOINT: z.string().default(''),
  STORAGE_ACCESS_KEY: z.string().default(''),
  STORAGE_SECRET_KEY: z.string().default(''),
  UPLOAD_DIR: z.string().default('./data/uploads'),

  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  PAYMENT_PROVIDER: z.enum(['stripe', 'mock']).default('mock'),
  PAYMENT_SECRET_KEY: z.string().default(''),
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  PAYMENT_CURRENCY: z.string().length(3).default('usd'),

  TTS_PROVIDER: z.enum(['mock', 'sapi', 'espeak', 'google', 'none']).default('mock'),
  TTS_GOOGLE_API_KEY: z.string().default(''),
  TTS_ESPEAK_BIN: z.string().default('espeak-ng'),

  DAILY_BONUS_POINTS: z.coerce.number().int().min(0).default(25),
  /** Optional community invite shown as "Join Discord" in the app. Hidden when unset (never a placeholder link). */
  DISCORD_INVITE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().startsWith('https://').optional()),
  STARTING_POINTS: z.coerce.number().int().min(0).default(0),
});

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  isDev: boolean;
  isTest: boolean;
  /** true when ANY mock integration is active — surfaced loudly in the UI. */
  usesMocks: boolean;
};

const DEV_SECRET = 'dev-only-insecure-session-secret-change-me-0123456789';

export function loadConfig(overrides: Partial<Record<keyof z.infer<typeof schema>, string | number>> = {}): Config {
  const raw = { ...process.env, ...overrides };
  const parsed = schema.parse(raw);
  const isProd = parsed.NODE_ENV === 'production';

  if (isProd) {
    const problems: string[] = [];
    if (parsed.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
    if (parsed.KICK_MODE === 'mock') problems.push('KICK_MODE=mock (MockKickService) is development-only');
    if (parsed.PAYMENT_PROVIDER === 'mock') problems.push('PAYMENT_PROVIDER=mock (MockPaymentService) is development-only');
    if (parsed.STORAGE_PROVIDER === 'mock') problems.push('STORAGE_PROVIDER=mock (MockStorageService) is development-only');
    if (parsed.TTS_PROVIDER === 'mock') problems.push('TTS_PROVIDER=mock (MockTtsService) is development-only — use espeak, google, sapi or none');
    if (parsed.DATABASE_URL.startsWith('pglite:')) problems.push('DATABASE_URL must point at a real PostgreSQL server in production');
    if (!parsed.APP_URL.startsWith('https://')) problems.push('APP_URL must be https in production');
    if (problems.length) throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
  }
  if (parsed.KICK_MODE === 'live' && (!parsed.KICK_CLIENT_ID || !parsed.KICK_CLIENT_SECRET || !parsed.KICK_REDIRECT_URI)) {
    throw new Error('KICK_MODE=live requires KICK_CLIENT_ID, KICK_CLIENT_SECRET and KICK_REDIRECT_URI');
  }
  if (parsed.PAYMENT_PROVIDER === 'stripe' && (!parsed.PAYMENT_SECRET_KEY || !parsed.PAYMENT_WEBHOOK_SECRET)) {
    throw new Error('PAYMENT_PROVIDER=stripe requires PAYMENT_SECRET_KEY and PAYMENT_WEBHOOK_SECRET');
  }
  if (parsed.TTS_PROVIDER === 'google' && !parsed.TTS_GOOGLE_API_KEY) throw new Error('TTS_PROVIDER=google requires TTS_GOOGLE_API_KEY');
  if (parsed.STORAGE_PROVIDER === 's3' && (!parsed.STORAGE_BUCKET || !parsed.STORAGE_ACCESS_KEY || !parsed.STORAGE_SECRET_KEY)) {
    throw new Error('STORAGE_PROVIDER=s3 requires STORAGE_BUCKET, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY');
  }

  return {
    ...parsed,
    PORT: parsed.API_PORT ?? parsed.PORT,
    SESSION_SECRET: parsed.SESSION_SECRET || DEV_SECRET,
    isProd,
    isDev: parsed.NODE_ENV === 'development',
    isTest: parsed.NODE_ENV === 'test',
    usesMocks: parsed.KICK_MODE === 'mock' || parsed.PAYMENT_PROVIDER === 'mock' || parsed.STORAGE_PROVIDER === 'mock',
  };
}

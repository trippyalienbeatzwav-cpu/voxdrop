import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { EventBus } from './events/bus.js';
import { Secrets } from './lib/crypto.js';
import type { KickApiService, KickAuthService } from './integrations/kick/types.js';
import { LiveKickApiService, LiveKickAuthService } from './integrations/kick/KickAuthService.js';
import { KickWebhookService, livePublicKeyProvider } from './integrations/kick/KickWebhookService.js';
import { MockKickService } from './integrations/kick/MockKickService.js';
import type { PaymentService } from './integrations/payments/PaymentService.js';
import { MockPaymentService, StripePaymentService } from './integrations/payments/PaymentService.js';
import type { StorageService } from './integrations/storage/StorageService.js';
import { MockStorageService, S3StorageService } from './integrations/storage/StorageService.js';
import type { MalwareScanner } from './integrations/scanner/MalwareScanner.js';
import { ClamAvScanner, NoopScanner } from './integrations/scanner/MalwareScanner.js';
import type { TTSService } from './integrations/tts/TTSService.js';
import { EspeakTtsService, GoogleTtsService, MockTtsService, NoTtsService, SapiTtsService } from './integrations/tts/TTSService.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything a service needs. Built once at startup (or per test). */
export interface AppContext {
  config: Config;
  db: Db;
  bus: EventBus;
  secrets: Secrets;
  kickAuth: KickAuthService;
  kickApi: KickApiService;
  kickWebhooks: KickWebhookService;
  /** Present only in KICK_MODE=mock (development). */
  mockKick: MockKickService | null;
  payments: PaymentService;
  /** Present only in PAYMENT_PROVIDER=mock (development). */
  mockPayments: MockPaymentService | null;
  storage: StorageService;
  scanner: MalwareScanner;
  tts: TTSService;
  log: Logger;
}

export function buildContext(config: Config, db: Db, overrides: Partial<AppContext> = {}): AppContext {
  const secrets = new Secrets(config.SESSION_SECRET);

  let kickAuth: KickAuthService;
  let kickApi: KickApiService;
  let kickWebhooks: KickWebhookService;
  let mockKick: MockKickService | null = null;
  if (config.KICK_MODE === 'mock') {
    mockKick = new MockKickService(config.APP_URL);
    kickAuth = mockKick;
    kickApi = mockKick;
    const pem = mockKick.publicKeyPem;
    kickWebhooks = new KickWebhookService(async () => pem);
  } else {
    kickAuth = new LiveKickAuthService(config.KICK_CLIENT_ID, config.KICK_CLIENT_SECRET, config.KICK_REDIRECT_URI);
    kickApi = new LiveKickApiService();
    kickWebhooks = new KickWebhookService(livePublicKeyProvider(config.KICK_WEBHOOK_PUBLIC_KEY));
  }

  let payments: PaymentService;
  let mockPayments: MockPaymentService | null = null;
  if (config.PAYMENT_PROVIDER === 'mock') {
    mockPayments = new MockPaymentService(config.APP_URL, `${config.SESSION_SECRET}:mock-payments`);
    payments = mockPayments;
  } else {
    payments = new StripePaymentService(config.PAYMENT_SECRET_KEY, config.PAYMENT_WEBHOOK_SECRET);
  }

  const storage: StorageService =
    config.STORAGE_PROVIDER === 'mock'
      ? new MockStorageService(config.UPLOAD_DIR)
      : new S3StorageService(config.STORAGE_BUCKET, {
          region: config.STORAGE_REGION,
          endpoint: config.STORAGE_ENDPOINT,
          accessKeyId: config.STORAGE_ACCESS_KEY,
          secretAccessKey: config.STORAGE_SECRET_KEY,
        });

  const scanner: MalwareScanner = config.CLAMAV_HOST ? new ClamAvScanner(config.CLAMAV_HOST, config.CLAMAV_PORT) : new NoopScanner();

  const tts: TTSService =
    config.TTS_PROVIDER === 'sapi'
      ? new SapiTtsService()
      : config.TTS_PROVIDER === 'espeak'
        ? new EspeakTtsService(config.TTS_ESPEAK_BIN)
        : config.TTS_PROVIDER === 'google'
          ? new GoogleTtsService(config.TTS_GOOGLE_API_KEY)
          : config.TTS_PROVIDER === 'none'
            ? new NoTtsService()
            : new MockTtsService();

  return {
    config,
    db,
    bus: new EventBus(),
    secrets,
    kickAuth,
    kickApi,
    kickWebhooks,
    mockKick,
    payments,
    mockPayments,
    storage,
    scanner,
    tts,
    log: console,
    ...overrides,
  };
}

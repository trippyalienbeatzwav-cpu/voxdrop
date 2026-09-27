import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Provider-agnostic object storage used for all audio. */
export interface StorageService {
  readonly name: 'mock' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/**
 * ⚠️ DEVELOPMENT ONLY — MockStorageService writes to the local disk.
 * It is refused at startup when NODE_ENV=production (see config.ts).
 */
export class MockStorageService implements StorageService {
  readonly name = 'mock' as const;
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root))) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, body: Buffer) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async get(key: string) {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

/** In-memory variant used by the automated tests. */
export class MemoryStorageService implements StorageService {
  readonly name = 'mock' as const;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO …).
 * REQUIRES real bucket credentials — not exercised by the automated tests.
 * Objects are private; audio is streamed through the API with authorization.
 */
export class S3StorageService implements StorageService {
  readonly name = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    opts: { region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      forcePathStyle: !!opts.endpoint,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }),
    );
  }

  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

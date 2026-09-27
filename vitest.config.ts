import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each integration file boots its own in-process PostgreSQL (PGlite, WASM). Four at once
    // crashed workers on this Windows box while the dev server was also running; two is stable.
    maxWorkers: 2,
  },
});

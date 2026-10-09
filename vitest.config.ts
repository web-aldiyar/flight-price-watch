import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each test starts its own in-memory PGlite (Postgres in WASM), which takes a few seconds.
  test: { testTimeout: 30_000 },
});

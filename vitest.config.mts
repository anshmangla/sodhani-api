import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    setupFiles: ['./test/setup-env.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});

import { defineConfig } from 'vitest/config';
import { resolveDevHttpsConfig } from './scripts/httpsCert';

export default defineConfig(({ command }) => {
  const enableHttps =
    command === 'serve' && !process.env.VITEST && process.env.DISABLE_HTTPS !== '1';
  const https = enableHttps ? resolveDevHttpsConfig() : undefined;

  return {
    base: '/skigame/',
    optimizeDeps: {
      exclude: ['jolt-physics'],
    },
    ...(https
      ? {
          server: { https, host: true },
          preview: { https, host: true },
        }
      : {}),
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
      setupFiles: ['./src/test/joltSetup.ts'],
    },
  };
});

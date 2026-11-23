import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/skigame/',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

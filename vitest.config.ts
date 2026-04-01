import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/electron/test-setup.ts'],
    include: ['src/electron/**/*.test.ts', 'src/ui/**/*.test.ts'],
    exclude: ['src/electron/**/*.integration.test.ts'],
    deps: {
      inline: [/electron/]
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/electron/**/*.ts'],
      exclude: ['src/electron/**/*.test.ts', 'src/electron/**/*.d.ts']
    }
  }
});

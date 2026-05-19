import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/__tests__/**/*.test.ts', 'packages/spatial-war-room/test/**/*.spec.ts'],
        // Each test file runs in its own worker so timers / intervals don't bleed.
        pool: 'forks',
        testTimeout: 30000,
    },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    // The @vitejs/plugin-react transform is needed so .tsx component test
    // files (which import React JSX from spatial-war-room) compile under
    // vitest the same way they do under the cockpit's vite build.
    plugins: [react()],
    test: {
        globals: false,
        // Default environment is node for the orchestrator + the cockpit's
        // build-and-curl smoke test. Component tests opt into happy-dom via
        // a per-file `// @vitest-environment happy-dom` directive so React
        // testing-library has a DOM to render into without paying the
        // setup cost on every backend test.
        environment: 'node',
        include: [
            'src/__tests__/**/*.test.ts',
            'packages/spatial-war-room/test/**/*.spec.ts',
            'packages/spatial-war-room/test/**/*.spec.tsx',
        ],
        // Each test file runs in its own worker so timers / intervals don't
        // bleed AND so the happy-dom global state from one component test
        // can't poison a sibling file.
        pool: 'forks',
    },
});

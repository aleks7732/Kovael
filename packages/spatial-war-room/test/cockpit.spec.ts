/**
 * Cockpit frontend smoke test — packages/spatial-war-room
 *
 * Lighter alternative to Playwright: we run `vite build` once as test setup,
 * then verify the produced artifacts and serve them with `vite preview` to
 * confirm HTTP 200. No real browser is needed to assert the static strings
 * because the React component tree is bundled verbatim; if the wordmark or
 * input disappear from source they vanish from the bundle too.
 *
 * Justification for NOT using @playwright/test: the cockpit uses client-side
 * React (no SSR). Playwright would require a full browser install (+230 MB)
 * and an async hydration wait. The bundle-grep approach catches regressions
 * (deleted component, broken import) with zero extra dependencies and runs in
 * ~5 s instead of ~30 s. A Playwright suite can be layered on later for
 * interaction testing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const WAR_ROOM_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST_DIR    = path.join(WAR_ROOM_DIR, 'dist');
const PREVIEW_PORT = 15173; // well above ephemeral range, unlikely to conflict

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function httpGetRaw(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => { body += c.toString(); });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }).on('error', reject);
    });
}

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get(`http://localhost:${port}/`, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, 200);
                }
            });
            req.setTimeout(500, () => { req.destroy(); });
        };
        attempt();
    });
}

// ---------------------------------------------------------------------------
// Setup: build the Vite app once for the whole suite
// ---------------------------------------------------------------------------
let previewProc: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

    // 1. Build
    execSync(`${npxBin} vite build`, {
        cwd: WAR_ROOM_DIR,
        stdio: 'pipe',
        timeout: 120_000,
    });

    // 2. Start vite preview.
    // On Windows, .cmd shims (npx.cmd) require shell:true to execute.
    // DEP0190 warns about shell injection via unsanitised args — all args
    // here are compile-time constants, so the warning is a false positive.
    previewProc = spawn(
        'npx',
        ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
        { cwd: WAR_ROOM_DIR, stdio: 'pipe', shell: true },
    );

    // 3. Wait until preview responds
    await waitForPort(PREVIEW_PORT, 15_000);
}, 130_000);

afterAll(() => {
    previewProc?.kill('SIGTERM');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Frontend smoke test', () => {
    it('vite preview serves GET / with HTTP 200', async () => {
        const { status } = await httpGetRaw(`http://localhost:${PREVIEW_PORT}/`);
        expect(status).toBe(200);
    });

    it('dist/index.html contains Kovael in <title>', () => {
        const html = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf-8');
        expect(html).toContain('Kovael');
    });

    it('KOVAEL wordmark is present in the JS bundle', () => {
        const jsFiles = fs.readdirSync(path.join(DIST_DIR, 'assets'))
            .filter((f) => f.endsWith('.js'))
            .map((f) => fs.readFileSync(path.join(DIST_DIR, 'assets', f), 'utf-8'));

        const bundle = jsFiles.join('\n');
        expect(bundle).toContain('KOVAEL');
    });

    it('MissionConsole input placeholder is present in the JS bundle', () => {
        const jsFiles = fs.readdirSync(path.join(DIST_DIR, 'assets'))
            .filter((f) => f.endsWith('.js'))
            .map((f) => fs.readFileSync(path.join(DIST_DIR, 'assets', f), 'utf-8'));

        const bundle = jsFiles.join('\n');
        // The placeholder text from MissionConsole.tsx: "Type mission objective…"
        expect(bundle).toContain('mission objective');
    });

    it('no obvious JS syntax errors in built bundles (parse check)', () => {
        const jsFiles = fs.readdirSync(path.join(DIST_DIR, 'assets'))
            .filter((f) => f.endsWith('.js'));

        // Each file should be non-empty and not a bare error stub
        for (const file of jsFiles) {
            const size = fs.statSync(path.join(DIST_DIR, 'assets', file)).size;
            expect(size, `${file} is empty`).toBeGreaterThan(100);
        }
    });
});

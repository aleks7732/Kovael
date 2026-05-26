import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import process from 'node:process';

describe('real-runtime-smoke script behavior', () => {
    const ROOT = path.resolve(import.meta.dirname, '..', '..');
    const SCRIPT_PATH = path.join(ROOT, 'scripts', 'real-runtime-smoke.mjs');

    it('prints help text and exits cleanly with 0 on --help', () => {
        const result = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
            cwd: ROOT,
            encoding: 'utf8',
            windowsHide: true,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Manual Real-Runtime Smoke Gate for Kovael Chair Adapters');
        expect(result.stdout).toContain('--require-real');
        expect(result.stdout).toContain('--agents');
    });

    it('prints help text and exits cleanly with 0 on -h', () => {
        const result = spawnSync(process.execPath, [SCRIPT_PATH, '-h'], {
            cwd: ROOT,
            encoding: 'utf8',
            windowsHide: true,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Manual Real-Runtime Smoke Gate for Kovael Chair Adapters');
    });

    it('fails with exit code 1 under --require-real when an unsupported agent is requested', () => {
        const result = spawnSync(process.execPath, [
            SCRIPT_PATH,
            '--agents', 'invalid-agent-xyz',
            '--require-real'
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            windowsHide: true,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('FAIL --require-real/KOVAEL_REQUIRE_LIVE_CHAIRS forbids skipped requested agents');
        expect(result.stdout).toContain('invalid-agent-xyz (unsupported_safe_runtime)');
        expect(result.stdout).toContain('=== REAL-RUNTIME SMOKE SUMMARY ===');
        expect(result.stdout).toContain('Overall Result:   FAIL');
    });

    it('fails with exit code 1 under --require-real when a supported agent is missing its local CLI binary', () => {
        // Force the check to look for a non-existent binary by poisoning the environment
        const result = spawnSync(process.execPath, [
            SCRIPT_PATH,
            '--agents', 'shaev',
            '--require-real'
        ], {
            cwd: ROOT,
            env: {
                ...process.env,
                KOVAEL_CLAUDE_BIN: 'non-existent-binary-12345.exe',
            },
            encoding: 'utf8',
            windowsHide: true,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('FAIL --require-real/KOVAEL_REQUIRE_LIVE_CHAIRS forbids skipped requested agents');
        expect(result.stdout).toContain('shaev (missing non-existent-binary-12345.exe)');
        expect(result.stdout).toContain('=== REAL-RUNTIME SMOKE SUMMARY ===');
        expect(result.stdout).toContain('Overall Result:   FAIL');
    });
});

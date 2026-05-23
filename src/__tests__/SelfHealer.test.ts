import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SelfHealer, extractRepairPatch, validateRepairPatch } from '../services/SelfHealer.js';
import type { VerificationReceipt } from '../MevBridge.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SelfHealer', () => {
    function repo(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-self-heal-'));
        dirs.push(dir);
        execFileSync('git', ['init'], { cwd: dir });
        execFileSync('git', ['checkout', '-b', 'stage4/autonomic-swarm'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'target.txt'), 'old\n');
        execFileSync('git', ['add', 'target.txt'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-m', 'init'], { cwd: dir });
        return dir;
    }

    function receipt(patch: string, status: 'verified' | 'failed' = 'failed'): VerificationReceipt {
        return {
            id: 'r1',
            cycleId: 'c1',
            timestamp: Date.now(),
            architectId: 'a',
            operatorId: 'o',
            verifierId: 'v',
            taskHash: 'h1',
            status,
            evidence: JSON.stringify({ repairPatch: patch }),
            routing: { architectAgent: 'a', rationale: 'test', vramFreeMb: 1 },
            phaseTrail: [],
        };
    }

    it('extracts only bounded unified diff patches', () => {
        expect(extractRepairPatch(receipt('not a patch'))).toBeNull();
        const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
        expect(extractRepairPatch(receipt(patch))).toBe(patch);
    });

    it('defaults to no auto-apply until explicitly enabled', async () => {
        const dir = repo();
        const patch = '--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n';
        const healer = new SelfHealer({
            repoRoot: dir,
            branchName: 'stage4/autonomic-swarm',
            testCommand: ['git', 'diff', '--check'],
        });

        const result = await healer.repairFromReceipt(receipt(patch));

        expect(result.status).toBe('skipped');
        expect(result.reason).toBe('auto_apply_disabled');
        expect(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('old\n');
    });

    it('applies patch and runs test command on non-main branches', async () => {
        const dir = repo();
        const patch = '--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n';
        const healer = new SelfHealer({
            repoRoot: dir,
            branchName: 'stage4/autonomic-swarm',
            testCommand: ['git', 'diff', '--check'],
            autoApply: true,
        });

        const result = await healer.repairFromReceipt(receipt(patch));

        expect(result.status).toBe('applied');
        expect(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('new\n');
        const latest = execFileSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' });
        expect(latest).toContain('chore(self-heal): apply verifier repair');
    });

    it('reverts patch when verification command fails', async () => {
        const dir = repo();
        const patch = '--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n';
        const healer = new SelfHealer({
            repoRoot: dir,
            branchName: 'stage4/autonomic-swarm',
            testCommand: ['git', 'not-a-command'],
            maxAttempts: 1,
            autoApply: true,
        });

        const result = await healer.repairFromReceipt(receipt(patch));

        expect(result.status).toBe('reverted');
        expect(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('old\n');
    });

    it('does not attempt rollback when patch check fails before apply', async () => {
        const dir = repo();
        const badPatch = '--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-old\n+new\n';
        const healer = new SelfHealer({
            repoRoot: dir,
            branchName: 'stage4/autonomic-swarm',
            testCommand: ['git', 'diff', '--check'],
            autoApply: true,
        });

        const result = await healer.repairFromReceipt(receipt(badPatch));

        expect(result.status).toBe('failed');
        expect(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('old\n');
    });

    it('skips unsafe main branch', async () => {
        const dir = repo();
        const healer = new SelfHealer({ repoRoot: dir, branchName: 'main', autoApply: true });
        const result = await healer.repairFromReceipt(receipt('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'));

        expect(result.status).toBe('skipped');
        expect(result.reason).toContain('unsafe_branch');
    });

    it('rejects protected execution and secret paths', () => {
        expect(validateRepairPatch('--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{}\n')).toEqual({
            ok: false,
            reason: 'protected_path:package.json',
        });
        expect(validateRepairPatch('--- a/scripts/run.js\n+++ b/scripts/run.js\n@@ -1 +1 @@\n-a\n+b\n')).toEqual({
            ok: false,
            reason: 'protected_path:scripts/run.js',
        });
        expect(validateRepairPatch('--- a/src/safe.ts\n+++ b/src/safe.ts\n@@ -1 +1 @@\n-a\n+b\n')).toEqual({ ok: true });
    });

    it('refuses to run on a dirty worktree', async () => {
        const dir = repo();
        fs.writeFileSync(path.join(dir, 'target.txt'), 'user edit\n');
        const patch = '--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n';
        const healer = new SelfHealer({
            repoRoot: dir,
            branchName: 'stage4/autonomic-swarm',
            testCommand: ['git', 'diff', '--check'],
            autoApply: true,
        });

        const result = await healer.repairFromReceipt(receipt(patch));

        expect(result.status).toBe('skipped');
        expect(result.reason).toBe('dirty_worktree');
        expect(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('user edit\n');
    });

    it('redacts sensitive paths and bearer tokens in emitted reasons', async () => {
        const dir = repo();
        const patch = '--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n';
        const healer = new SelfHealer({
            repoRoot: dir,
            branchName: 'stage4/autonomic-swarm',
            testCommand: ['node', '-e', 'console.error("Bearer secret-token C:\\\\Users\\\\maver\\\\secret"); process.exit(1)'],
            maxAttempts: 1,
            autoApply: true,
        });
        const events: any[] = [];
        healer.on('self_heal_event', (event) => events.push(event));

        const result = await healer.repairFromReceipt(receipt(patch));

        expect(result.status).toBe('reverted');
        const reason = events.map((event) => event.reason).filter(Boolean).join('\n');
        expect(reason).toContain('Bearer [redacted]');
        expect(reason).toContain('[redacted-path]');
        expect(reason).not.toContain('secret-token');
        expect(reason).not.toContain('C:\\Users\\maver');
    });
});

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { VerificationReceipt } from '../MevBridge.js';

const execFileAsync = promisify(execFile);

export interface SelfHealerOptions {
    repoRoot?: string;
    maxAttempts?: number;
    testCommand?: readonly string[];
    branchName?: string;
    autoApply?: boolean;
    commitOnGreen?: boolean;
    allowedBranchPrefixes?: readonly string[];
}

export interface SelfHealEvent {
    type: 'self_heal.skipped' | 'self_heal.patch_applied' | 'self_heal.patch_reverted' | 'self_heal.failed';
    cycleId: string;
    taskHash: string;
    attempt: number;
    reason?: string;
    timestamp: number;
}

export interface SelfHealResult {
    status: 'skipped' | 'applied' | 'reverted' | 'failed';
    attempts: number;
    reason?: string;
}

export class SelfHealer extends EventEmitter {
    private readonly repoRoot: string;
    private readonly maxAttempts: number;
    private readonly testCommand: readonly string[];
    private readonly branchName?: string;
    private readonly autoApply: boolean;
    private readonly commitOnGreen: boolean;
    private readonly allowedBranchPrefixes: readonly string[];

    constructor(options: SelfHealerOptions = {}) {
        super();
        this.repoRoot = path.resolve(options.repoRoot ?? process.cwd());
        this.maxAttempts = options.maxAttempts ?? 2;
        this.testCommand = options.testCommand ?? ['npm', 'run', 'build'];
        this.branchName = options.branchName;
        this.autoApply = options.autoApply ?? false;
        this.commitOnGreen = options.commitOnGreen ?? true;
        this.allowedBranchPrefixes = options.allowedBranchPrefixes ?? ['stage4/', 'self-heal/'];
    }

    public async repairFromReceipt(receipt: VerificationReceipt): Promise<SelfHealResult> {
        if (receipt.status !== 'failed') return this.skip(receipt, 'receipt_not_failed');
        if (!this.autoApply) return this.skip(receipt, 'auto_apply_disabled');
        if (this.testCommand.length === 0) return this.skip(receipt, 'missing_test_command');
        const branch = this.branchName ?? await this.currentBranch();
        if (!this.isBranchAllowed(branch)) {
            return this.skip(receipt, `unsafe_branch:${branch || 'detached'}`);
        }
        const patch = extractRepairPatch(receipt);
        if (!patch) return this.skip(receipt, 'no_repair_patch_available');
        const patchGuard = validateRepairPatch(patch);
        if (!patchGuard.ok) return this.skip(receipt, patchGuard.reason);
        const status = await this.gitStatus();
        if (status.length > 0) return this.skip(receipt, 'dirty_worktree');

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            let applied = false;
            try {
                await this.gitApply(['--check'], patch);
                await this.gitApply([], patch);
                applied = true;
                this.emitEvent('self_heal.patch_applied', receipt, attempt);
                await execFileAsync(this.testCommand[0], this.testCommand.slice(1), {
                    cwd: this.repoRoot,
                    timeout: 120_000,
                    windowsHide: true,
                });
                if (this.commitOnGreen) await this.commitRepair(receipt);
                return { status: 'applied', attempts: attempt };
            } catch (err) {
                const reason = redactReason((err as Error).message);
                if (!applied) {
                    this.emitEvent('self_heal.failed', receipt, attempt, reason);
                    return { status: 'failed', attempts: attempt, reason };
                }
                try {
                    await this.gitApply(['--reverse'], patch);
                    this.emitEvent('self_heal.patch_reverted', receipt, attempt, reason);
                } catch {
                    this.emitEvent('self_heal.failed', receipt, attempt, 'rollback_failed');
                    return { status: 'failed', attempts: attempt, reason: 'rollback_failed' };
                }
                if (attempt === this.maxAttempts) {
                    this.emitEvent('self_heal.failed', receipt, attempt, reason);
                    return { status: 'reverted', attempts: attempt, reason };
                }
            }
        }
        return { status: 'failed', attempts: this.maxAttempts, reason: 'unreachable' };
    }

    private async currentBranch(): Promise<string> {
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
            cwd: this.repoRoot,
            timeout: 10_000,
            windowsHide: true,
        });
        return stdout.trim();
    }

    private isBranchAllowed(branch: string): boolean {
        return Boolean(branch) && this.allowedBranchPrefixes.some((prefix) => branch.startsWith(prefix));
    }

    private async gitStatus(): Promise<string> {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
            cwd: this.repoRoot,
            timeout: 10_000,
            windowsHide: true,
        });
        return stdout.trim();
    }

    private async gitApply(args: string[], patch: string): Promise<void> {
        const child = execFile('git', ['apply', ...args, '-'], {
            cwd: this.repoRoot,
            timeout: 30_000,
            windowsHide: true,
        });
        child.stdin?.end(patch, 'utf8');
        await new Promise<void>((resolve, reject) => {
            let stderr = '';
            child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(stderr.trim() || `git apply exited ${code}`));
            });
        });
    }

    private async commitRepair(receipt: VerificationReceipt): Promise<void> {
        await execFileAsync('git', ['add', '-A'], {
            cwd: this.repoRoot,
            timeout: 30_000,
            windowsHide: true,
        });
        await execFileAsync(
            'git',
            [
                '-c',
                'user.email=kovael-self-healer.local',
                '-c',
                'user.name=Kovael Self-Healer',
                'commit',
                '-m',
                `chore(self-heal): apply verifier repair ${receipt.taskHash.slice(0, 12)}`,
            ],
            {
                cwd: this.repoRoot,
                timeout: 60_000,
                windowsHide: true,
            },
        );
    }

    private skip(receipt: VerificationReceipt, reason: string): SelfHealResult {
        const redacted = redactReason(reason);
        this.emitEvent('self_heal.skipped', receipt, 0, redacted);
        return { status: 'skipped', attempts: 0, reason: redacted };
    }

    private emitEvent(type: SelfHealEvent['type'], receipt: VerificationReceipt, attempt: number, reason?: string): void {
        this.emit('self_heal_event', {
            type,
            cycleId: receipt.cycleId,
            taskHash: receipt.taskHash,
            attempt,
            reason: reason ? redactReason(reason) : undefined,
            timestamp: Date.now(),
        } satisfies SelfHealEvent);
    }
}

export function extractRepairPatch(receipt: VerificationReceipt): string | null {
    try {
        const evidence = JSON.parse(receipt.evidence) as { repairPatch?: unknown; patch?: unknown };
        const patch = typeof evidence.repairPatch === 'string'
            ? evidence.repairPatch
            : typeof evidence.patch === 'string'
                ? evidence.patch
                : null;
        if (!patch || patch.length > 512_000) return null;
        if (!patch.startsWith('--- ') && !patch.includes('\n--- ')) return null;
        if (!patch.includes('\n+++ ')) return null;
        return patch;
    } catch {
        return null;
    }
}

export function validateRepairPatch(patch: string): { ok: true } | { ok: false; reason: string } {
    const paths = extractPatchPaths(patch);
    if (paths.length === 0) return { ok: false, reason: 'no_patch_paths' };
    for (const filePath of paths) {
        const normalized = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');
        if (!normalized || normalized === '/dev/null') continue;
        if (isProtectedPath(normalized)) return { ok: false, reason: `protected_path:${normalized}` };
    }
    return { ok: true };
}

function extractPatchPaths(patch: string): string[] {
    const paths = new Set<string>();
    for (const line of patch.split(/\r?\n/)) {
        const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (git) {
            paths.add(stripPatchPath(git[1]));
            paths.add(stripPatchPath(git[2]));
            continue;
        }
        const marker = /^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/.exec(line);
        if (marker) {
            paths.add(stripPatchPath(marker[1]));
            continue;
        }
        const rename = /^rename (?:from|to) (.+)$/.exec(line);
        if (rename) paths.add(stripPatchPath(rename[1]));
    }
    return Array.from(paths);
}

function stripPatchPath(value: string): string {
    return value.replace(/\t.*$/, '').trim();
}

function isProtectedPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    const root = lower.split('/')[0];
    if (lower === 'package.json' || lower.endsWith('/package.json')) return true;
    if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(lower)) return true;
    if (lower.startsWith('scripts/') || lower.startsWith('.github/') || lower.startsWith('.git/')) return true;
    if (root.startsWith('.') || lower.includes('/.')) return true;
    if (/(^|\/)\.env($|[.\/])/.test(lower)) return true;
    if (/\.(pem|key|pfx|p12|crt)$/i.test(lower)) return true;
    return false;
}

function redactReason(reason: string): string {
    return reason
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-token]')
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/token=([^&\s]+)/gi, 'token=[redacted]')
        .replace(/[A-Za-z]:\\[^\r\n\t ]+/g, '[redacted-path]')
        .replace(/\/(?:Users|home)\/[^\r\n\t ]+/g, '[redacted-path]')
        .slice(0, 240);
}

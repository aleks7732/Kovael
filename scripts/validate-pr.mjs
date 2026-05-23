#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const cockpit = path.join(root, 'packages', 'spatial-war-room');
const npmCommand = resolveNpmCommand();

const binaryExtensions = new Set([
    '.avif',
    '.bmp',
    '.gif',
    '.ico',
    '.jpeg',
    '.jpg',
    '.pdf',
    '.png',
    '.webp',
    '.zip',
]);

const secretPatterns = [
    { name: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
    { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
    { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    { name: 'private key marker', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const steps = [
    { name: 'root build', ...npmStep(['run', 'build'], root) },
    { name: 'root tests', ...npmStep(['test'], root) },
    { name: 'cockpit typecheck', ...npmStep(['run', 'typecheck'], cockpit) },
    { name: 'cockpit test typecheck', ...npmStep(['run', 'typecheck:tests'], cockpit) },
    { name: 'cockpit build', ...npmStep(['run', 'build'], cockpit) },
    { name: 'changed-file secret scan', run: scanChangedFiles },
];

if (process.env.KOVAEL_VALIDATE_ALL_CHAIRS === 'true') {
    steps.push({
        name: 'all chairs validation',
        cmd: 'node',
        args: ['scripts/validate-all-chairs.mjs'],
        cwd: root,
    });
}

for (const step of steps) {
    process.stdout.write(`\n=== ${step.name} ===\n`);
    const result = step.run
        ? step.run()
        : spawnSync(step.cmd, step.args, {
            cwd: step.cwd,
            env: process.env,
            shell: false,
            stdio: 'inherit',
        });

    const status = typeof result === 'number' ? result : result.status;
    if (typeof result === 'object' && result.error) {
        process.stderr.write(`[validate-pr] ${result.error.message}\n`);
    }

    if (status !== 0) {
        process.stderr.write(`[validate-pr] ${step.name} failed\n`);
        process.exit(status ?? 1);
    }
}

process.stdout.write('\n[validate-pr] all checks passed\n');

function scanChangedFiles() {
    const diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        shell: false,
    });

    if (diff.status !== 0) {
        process.stderr.write(diff.stderr || '[validate-pr] failed to list changed files\n');
        return diff.status ?? 1;
    }

    const findings = [];
    for (const rel of diff.stdout.split(/\r?\n/).filter(Boolean)) {
        const file = path.join(root, rel);
        if (!existsSync(file) || !statSync(file).isFile() || isLikelyBinary(file)) {
            continue;
        }

        const body = readFileSync(file, 'utf8');
        const lines = body.split(/\r?\n/);
        for (const [lineIndex, line] of lines.entries()) {
            const hit = secretPatterns.find(({ pattern }) => pattern.test(line));
            if (hit) {
                findings.push(`${rel}:${lineIndex + 1} matched ${hit.name}`);
            }
        }
    }

    if (findings.length > 0) {
        process.stderr.write('[validate-pr] possible secrets in changed files:\n');
        for (const finding of findings) {
            process.stderr.write(`- ${finding}\n`);
        }
        return 1;
    }

    process.stdout.write('[validate-pr] no high-confidence secret patterns in changed files\n');
    return 0;
}

function npmStep(args, cwd) {
    return {
        cmd: npmCommand.cmd,
        args: [...npmCommand.prefixArgs, ...args],
        cwd,
    };
}

function resolveNpmCommand() {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return { cmd: process.execPath, prefixArgs: [candidate] };
        }
    }

    return {
        cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        prefixArgs: [],
    };
}

function isLikelyBinary(file) {
    const ext = path.extname(file).toLowerCase();
    if (binaryExtensions.has(ext)) {
        return true;
    }

    const sample = readFileSync(file).subarray(0, 4096);
    return sample.includes(0);
}

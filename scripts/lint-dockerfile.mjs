#!/usr/bin/env node
// Daemon-free Dockerfile + .dockerignore lint. Asserts the invariants
// from .claude/notes/2026-05-20-loop-01-distroless-orchestrator.md so
// the build stays distroless, multi-stage, non-root, and pruned.
//
// Run: node scripts/lint-dockerfile.mjs
//
// Exits 0 on pass, 1 on fail. Stdout lists each check.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const dockerfile = readFileSync(resolve(repo, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(resolve(repo, '.dockerignore'), 'utf8');

const checks = [
    {
        name: 'Builder stage is Node 22 official image',
        pass: /^FROM\s+node:22-[\w-]+\s+AS\s+builder/m.test(dockerfile),
    },
    {
        name: 'Runtime stage is distroless Node 22 nonroot pinned by digest',
        pass: /FROM\s+gcr\.io\/distroless\/nodejs22-debian12:nonroot@sha256:[a-f0-9]{64}\s+AS\s+runtime/.test(dockerfile),
    },
    {
        name: 'npm ci is used (deterministic install, never npm install)',
        pass: /\bnpm\s+ci\b/.test(dockerfile) && !/\bnpm\s+install\b/.test(dockerfile),
    },
    {
        name: 'devDependencies pruned before runtime stage',
        pass: /npm\s+prune\s+--omit=dev/.test(dockerfile),
    },
    {
        name: 'Runtime stage runs as nonroot',
        pass: /^USER\s+nonroot/m.test(dockerfile),
    },
    {
        name: 'Orchestrator port 8080 is exposed',
        pass: /^EXPOSE\s+8080/m.test(dockerfile),
    },
    {
        name: 'HEALTHCHECK present (exec form, no shell required)',
        pass: /^HEALTHCHECK[\s\S]*CMD\s*\[/m.test(dockerfile),
    },
    {
        name: 'Runtime copies dist from builder stage',
        pass: /COPY\s+--from=builder[^\n]*\/app\/dist/.test(dockerfile),
    },
    {
        name: 'Runtime copies node_modules from builder stage',
        pass: /COPY\s+--from=builder[^\n]*\/app\/node_modules/.test(dockerfile),
    },
    {
        name: 'Runtime copies personas/ for PersonaLoader',
        pass: /COPY[^\n]*\bpersonas\b/.test(dockerfile),
    },
    {
        name: 'Runtime copies WORKFLOW.md for WorkflowLoader',
        pass: /COPY[^\n]*\bWORKFLOW\.md\b/.test(dockerfile),
    },
    {
        name: 'CMD points at dist/boot-mesh.js',
        pass: /CMD\s*\[\s*"dist\/boot-mesh\.js"\s*\]/.test(dockerfile),
    },
    {
        name: '.dockerignore excludes node_modules',
        pass: /^node_modules$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes .git',
        pass: /^\.git$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes dist',
        pass: /^dist$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes .claude',
        pass: /^\.claude$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes test fixtures',
        pass: /^\*\*\/fixtures$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes .env files',
        pass: /^\.env$/m.test(dockerignore) && /^\.env\.\*$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes packages/ (cockpit not in orchestrator image)',
        pass: /^packages$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes nyx_vault and storage',
        pass: /^nyx_vault$/m.test(dockerignore) && /^storage$/m.test(dockerignore),
    },
    {
        name: '.dockerignore excludes scratch dbs',
        pass: /^\*\.db$/m.test(dockerignore) && /^\*\.sqlite$/m.test(dockerignore),
    },
];

let failed = 0;
for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    process.stdout.write(`[${tag}] ${c.name}\n`);
    if (!c.pass) failed += 1;
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
if (failed > 0) {
    process.exit(1);
}

const dockerVersion = spawnSync('docker', ['version'], { stdio: 'pipe', encoding: 'utf8' });
if (dockerVersion.status !== 0) {
    process.stdout.write('[SKIP] Docker smoke test skipped (docker not available)\n');
    process.exit(0);
}

const imageTag = `kovael-docker-lint-smoke:${Date.now()}`;
const build = spawnSync('docker', ['build', '-f', 'Dockerfile', '-t', imageTag, '.'], {
    cwd: repo,
    stdio: 'pipe',
    encoding: 'utf8',
});
if (build.status !== 0) {
    process.stdout.write('[FAIL] Docker smoke test build failed\n');
    if (build.stdout) process.stdout.write(build.stdout);
    if (build.stderr) process.stdout.write(build.stderr);
    process.exit(1);
}

const containerName = `kovael-smoke-${Date.now()}`;
const run = spawnSync('docker', ['run', '--rm', '-d', '--name', containerName, imageTag], {
    stdio: 'pipe',
    encoding: 'utf8',
});
if (run.status !== 0) {
    process.stdout.write('[FAIL] Docker smoke test run failed\n');
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stdout.write(run.stderr);
    spawnSync('docker', ['rmi', '-f', imageTag], { stdio: 'pipe' });
    process.exit(1);
}

const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
    stdio: 'pipe',
    encoding: 'utf8',
});
const running = inspect.status === 0 && inspect.stdout.trim() === 'true';

spawnSync('docker', ['stop', containerName], { stdio: 'pipe' });
spawnSync('docker', ['rmi', '-f', imageTag], { stdio: 'pipe' });

if (!running) {
    process.stdout.write('[FAIL] Docker smoke test container failed to stay up long enough to inspect\n');
    process.exit(1);
}

process.stdout.write('[PASS] Docker smoke test (build + run --rm) passed\n');
process.exit(0);

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
        name: 'Runtime stage is distroless Node 22 nonroot',
        pass: /FROM\s+gcr\.io\/distroless\/nodejs22-debian12:nonroot/.test(dockerfile),
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
process.exit(failed === 0 ? 0 : 1);

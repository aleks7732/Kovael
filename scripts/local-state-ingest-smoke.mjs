#!/usr/bin/env node
/**
 * Manual smoke: prove local agent state stays out of semantic memory, logs,
 * and the public orchestrator state snapshot.
 *
 * Requires: npm run build
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ORCHESTRATOR = path.join(ROOT, 'dist', 'MeshOrchestrator.js');
const SENTINEL = `KOVAEL_LOCAL_STATE_SENTINEL_${crypto.randomUUID()}`;

if (!existsSync(DIST_ORCHESTRATOR)) {
    fail('dist/MeshOrchestrator.js is missing; run npm run build first');
}

const originalCwd = process.cwd();
const originalDbPath = process.env.KOVAEL_DB_PATH;
const originalLogFile = process.env.KOVAEL_LOG_FILE;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'kovael-local-state-smoke-'));
const dbPath = path.join(tempRoot, '.kovael-test', 'orchestrator.db');
const logPath = path.join(tempRoot, 'kovael.ndjson');
let orchestrator = null;
let exitCode = 0;

try {
    seedLocalState(tempRoot);
    process.env.KOVAEL_DB_PATH = dbPath;
    process.env.KOVAEL_LOG_FILE = logPath;
    process.chdir(tempRoot);

    const { MeshOrchestrator } = await import(pathToFileURL(DIST_ORCHESTRATOR).href);
    orchestrator = new MeshOrchestrator(0, {
        agentRuntimes: { enabled: false, agents: [] },
        resourceMode: { enabled: false },
    });
    const port = await orchestrator.ready();
    await waitForIngest(dbPath);

    const rows = readSemanticRows(dbPath);
    assert(!rows.some((row) => row.content.includes(SENTINEL)), 'sentinel content was ingested into semantic_anchors');
    assert(!rows.some((row) => /\.claude|\.gemini|\.codex|\.env|\.local\.md/i.test(row.file_path)), 'protected local path was indexed');
    assert(rows.some((row) => row.content.includes('public project smoke note')), 'public project note was not indexed');

    const stateText = await readStateSnapshot(port);
    assert(!stateText.includes(SENTINEL), 'sentinel content was exposed by /api/v1/state');

    const logs = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    assert(!logs.includes(SENTINEL), 'sentinel content was written to logs');

    process.stdout.write('[local-state-smoke] PASS protected local agent state was not ingested, logged, or state-exposed\n');
} catch (err) {
    exitCode = 1;
    process.stderr.write(`[local-state-smoke] FAIL ${err instanceof Error ? err.message : String(err)}\n`);
} finally {
    if (orchestrator) orchestrator.close();
    process.chdir(originalCwd);
    restoreEnv('KOVAEL_DB_PATH', originalDbPath);
    restoreEnv('KOVAEL_LOG_FILE', originalLogFile);
    await sleep(50);
    rmSync(tempRoot, { recursive: true, force: true });
}

process.exit(exitCode);

function seedLocalState(root) {
    const protectedFiles = [
        path.join(root, '.claude', 'notes', 'private.md'),
        path.join(root, '.gemini', 'GEMINI.local.md'),
        path.join(root, '.codex', 'local', 'AGENTS.md'),
        path.join(root, 'CLAUDE.local.md'),
        path.join(root, 'GEMINI.local.md'),
        path.join(root, 'AGENTS.local.md'),
        path.join(root, '.env.local'),
    ];
    for (const file of protectedFiles) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `private local state ${SENTINEL}\n`, 'utf8');
    }

    writeFileSync(path.join(root, 'README.md'), '# public project smoke note\n', 'utf8');
}

async function waitForIngest(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(file)) {
            const rows = readSemanticRows(file);
            if (rows.length > 0) return;
        }
        await sleep(50);
    }
    fail('timed out waiting for semantic ingest rows');
}

function readSemanticRows(file) {
    const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
    try {
        return db.prepare('SELECT file_path, content FROM semantic_anchors ORDER BY file_path').all();
    } finally {
        db.close();
    }
}

async function readStateSnapshot(port) {
    const headers = {};
    if (process.env.KOVAEL_API_TOKEN) {
        headers.authorization = `Bearer ${process.env.KOVAEL_API_TOKEN}`;
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`, { headers });
    const text = await res.text();
    assert(res.status === 200, `/api/v1/state returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function assert(condition, message) {
    if (!condition) fail(message);
}

function fail(message) {
    throw new Error(message);
}

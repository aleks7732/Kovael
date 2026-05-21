#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const IMAGE_TAG = 'kovael:local';
const CONTAINER_NAME = 'kovael-smoke';
const HOST_PORT = process.env.KOVAEL_SMOKE_PORT ?? '8081';
const CONTAINER_PORT = '8080';
const LIVEZ_POLL_TIMEOUT_MS = 30_000;
const LIVEZ_POLL_INTERVAL_MS = 500;
const RSS_SETTLE_MS = 60_000;

function log(msg) {
    process.stdout.write(`${msg}\n`);
}

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 600_000,
        ...opts,
    });
}

function dockerAvailable() {
    const version = run('docker', ['version']);
    return version.status === 0;
}

function ensureContainerStopped() {
    run('docker', ['rm', '-f', CONTAINER_NAME]);
}

function ensureImageRemoved() {
    run('docker', ['rmi', '-f', IMAGE_TAG]);
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function pollLivez() {
    const deadline = Date.now() + LIVEZ_POLL_TIMEOUT_MS;
    const start = Date.now();
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${HOST_PORT}/livez`);
            if (res.status === 200) {
                return Date.now() - start;
            }
        } catch {
            // not up yet
        }
        await sleep(LIVEZ_POLL_INTERVAL_MS);
    }
    return null;
}

function imageSize() {
    const r = run('docker', ['images', IMAGE_TAG, '--format', '{{.Size}}']);
    return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function rssSample() {
    const r = run('docker', [
        'stats',
        CONTAINER_NAME,
        '--no-stream',
        '--format',
        '{{.MemUsage}}',
    ]);
    return r.status === 0 ? r.stdout.trim() : 'unknown';
}

async function main() {
    if (!dockerAvailable()) {
        log('[SKIP] docker not available (daemon unreachable or not installed)');
        log('[SKIP] Run this script from a host with a working Docker daemon');
        process.exit(0);
    }

    log('[step] cleaning any prior smoke artifacts');
    ensureContainerStopped();
    ensureImageRemoved();

    log(`[step] docker build -t ${IMAGE_TAG} -f Dockerfile .`);
    const buildStart = Date.now();
    const build = run('docker', ['build', '-t', IMAGE_TAG, '-f', 'Dockerfile', '.'], {
        stdio: 'inherit',
    });
    const buildSeconds = ((Date.now() - buildStart) / 1000).toFixed(1);
    if (build.status !== 0) {
        log('[FAIL] docker build failed');
        process.exit(1);
    }

    const size = imageSize();
    log(`[ok] build complete in ${buildSeconds}s, image size ${size}`);

    log(`[step] docker run --rm -d --name ${CONTAINER_NAME} -p ${HOST_PORT}:${CONTAINER_PORT} ${IMAGE_TAG}`);
    const runRes = run('docker', [
        'run',
        '--rm',
        '-d',
        '--name',
        CONTAINER_NAME,
        '-p',
        `${HOST_PORT}:${CONTAINER_PORT}`,
        IMAGE_TAG,
    ]);
    if (runRes.status !== 0) {
        log('[FAIL] docker run failed');
        if (runRes.stderr) log(runRes.stderr);
        ensureImageRemoved();
        process.exit(1);
    }

    log('[step] polling /livez until 200 (timeout 30s)');
    const coldStartMs = await pollLivez();
    if (coldStartMs === null) {
        log('[FAIL] /livez never returned 200 within 30s');
        run('docker', ['logs', CONTAINER_NAME], { stdio: 'inherit' });
        ensureContainerStopped();
        ensureImageRemoved();
        process.exit(1);
    }
    log(`[ok] /livez reached 200 in ${coldStartMs}ms`);

    log(`[step] waiting ${RSS_SETTLE_MS / 1000}s for steady-state RSS`);
    await sleep(RSS_SETTLE_MS);
    const mem = rssSample();
    log(`[ok] steady-state mem: ${mem}`);

    log('[step] tearing down smoke container + image');
    ensureContainerStopped();
    ensureImageRemoved();

    log('');
    log('| metric | value |');
    log('| --- | --- |');
    log(`| image size | ${size} |`);
    log(`| build time | ${buildSeconds}s |`);
    log(`| cold start to /livez 200 | ${coldStartMs}ms |`);
    log(`| RSS after ${RSS_SETTLE_MS / 1000}s | ${mem} |`);
}

main().catch((err) => {
    log(`[FAIL] unexpected error: ${err?.stack ?? err}`);
    ensureContainerStopped();
    ensureImageRemoved();
    process.exit(1);
});

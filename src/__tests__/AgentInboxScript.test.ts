import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CHAIR_DISPATCH_SECRET_ENV,
    openChairDispatchBody,
    secureChairDispatchBody,
} from '../services/ChairDispatchSecurity.js';

describe('kovael-agent-inbox hub persistence', () => {
    const tempDirs: string[] = [];
    const servers: http.Server[] = [];
    const children: ChildProcess[] = [];
    const originalDispatchSecret = process.env[CHAIR_DISPATCH_SECRET_ENV];

    afterEach(async () => {
        await Promise.all(children.splice(0).map((child) => stopChild(child)));
        await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        if (originalDispatchSecret === undefined) {
            delete process.env[CHAIR_DISPATCH_SECRET_ENV];
        } else {
            process.env[CHAIR_DISPATCH_SECRET_ENV] = originalDispatchSecret;
        }
    });

    function tempPath(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-agent-inbox-'));
        tempDirs.push(dir);
        return path.join(dir, 'hub-probe', 'agent-hub.sqlite');
    }

    async function startFakeOrchestrator(): Promise<string> {
        const server = http.createServer((req, res) => {
            req.resume();
            if (req.method === 'POST' && req.url === '/api/v1/chairs/claim') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    sessionId: 'session-probe',
                    ttlMs: 30_000,
                    heartbeatIntervalMs: 15_000,
                }));
                return;
            }
            if (req.method === 'POST' && req.url === '/api/v1/chairs/release') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ released: true }));
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fake orchestrator did not bind');
        return `http://127.0.0.1:${address.port}`;
    }

    async function startDispatchOrchestrator() {
        let claimedInboxUrl: string | null = null;
        let resolveClaim!: (inboxUrl: string) => void;
        let resolveReply!: (reply: Record<string, unknown>) => void;
        const claimed = new Promise<string>((resolve) => {
            resolveClaim = resolve;
        });
        const replied = new Promise<Record<string, unknown>>((resolve) => {
            resolveReply = resolve;
        });

        const server = http.createServer(async (req, res) => {
            const body = await readJson(req);
            if (req.method === 'POST' && req.url === '/api/v1/chairs/claim') {
                claimedInboxUrl = typeof body.inboxUrl === 'string' ? body.inboxUrl : null;
                if (claimedInboxUrl) resolveClaim(claimedInboxUrl);
                writeJson(res, 200, {
                    sessionId: 'session-dispatch',
                    ttlMs: 30_000,
                    heartbeatIntervalMs: 15_000,
                });
                return;
            }
            if (req.method === 'POST' && req.url === '/api/v1/chairs/heartbeat') {
                writeJson(res, 200, { status: 'online', lastBeaconAt: Date.now() });
                return;
            }
            if (req.method === 'POST' && req.url === '/api/v1/chairs/release') {
                writeJson(res, 200, { released: true });
                return;
            }
            if (req.method === 'POST' && req.url === '/api/v1/chairs/reply') {
                const opened = openChairDispatchBody(body);
                resolveReply(opened);
                writeJson(res, 200, { success: true });
                return;
            }
            writeJson(res, 404, { error: 'not_found' });
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fake orchestrator did not bind');
        const host = `http://127.0.0.1:${address.port}`;
        return {
            host,
            waitForClaim: () => withTimeout(claimed, 5000, 'claim timeout'),
            waitForReply: () => withTimeout(replied, 5000, 'reply timeout'),
        };
    }

    it('creates a non-destructive per-agent SQLite hub during probe startup', async () => {
        const hubPath = tempPath();
        const host = await startFakeOrchestrator();
        const child = spawn(process.execPath, [
            'scripts/kovael-agent-inbox.mjs',
            '--id', 'hub-probe',
            '--provider', 'vitest',
            '--runtime', 'codex',
            '--host', host,
            '--hub-path', hubPath,
            '--probe',
        ], {
            cwd: process.cwd(),
            windowsHide: true,
        });

        const stderr: Buffer[] = [];
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

        expect(code, Buffer.concat(stderr).toString('utf8')).toBe(0);
        expect(fs.existsSync(hubPath)).toBe(true);

        const db = new DatabaseSync(hubPath);
        try {
            const tables = db.prepare(`
                SELECT name FROM sqlite_master
                WHERE type = 'table'
                ORDER BY name
            `).all() as Array<{ name: string }>;
            expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
                'agent_dispatches',
                'agent_hub_meta',
                'agent_memory',
            ]));
        } finally {
            db.close();
        }
    }, 10_000);

    it('runs fake-deterministic dispatches through the real encrypted inbox adapter and hub lifecycle', async () => {
        process.env[CHAIR_DISPATCH_SECRET_ENV] = 'vitest-fake-runtime-secret-0123456789';

        const hubPath = tempPath();
        const orchestrator = await startDispatchOrchestrator();
        const child = spawn(process.execPath, [
            'scripts/kovael-agent-inbox.mjs',
            '--id', 'hub-probe',
            '--provider', 'vitest',
            '--runtime', 'fake-deterministic',
            '--host', orchestrator.host,
            '--hub-path', hubPath,
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                [CHAIR_DISPATCH_SECRET_ENV]: process.env[CHAIR_DISPATCH_SECRET_ENV],
            },
            windowsHide: true,
        });
        children.push(child);

        const stderr: Buffer[] = [];
        child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

        const inboxUrl = await orchestrator.waitForClaim();
        const requestId = 'req-fake-deterministic-1';
        const topicId = 'topic-fake-deterministic';
        const secured = secureChairDispatchBody({
            requestId,
            topicId,
            agentId: 'hub-probe',
            claimSessionId: 'session-dispatch',
            replyProofSecret: 'reply-proof-secret-0123456789abcdef',
            replyUrl: `${orchestrator.host}/api/v1/chairs/reply`,
            messages: [{ role: 'user', content: 'prove deterministic adapter path' }],
        }, requestId);

        const dispatch = await fetch(inboxUrl, {
            method: 'POST',
            headers: secured.headers,
            body: secured.body,
        });
        expect(dispatch.status, await dispatch.text()).toBe(202);

        const reply = await orchestrator.waitForReply();
        expect(reply).toMatchObject({
            requestId,
            topicId,
            agentId: 'hub-probe',
            claimSessionId: 'session-dispatch',
            status: 'succeeded',
        });
        expect(typeof reply.replyProof).toBe('string');
        expect(String(reply.content)).toContain('FAKE_RUNTIME_REPLY agent=hub-probe request=req-fake-deterministic-1 topic=topic-fake-deterministic');

        const record = await waitForDispatchRecord(hubPath, requestId, 'succeeded');
        expect(record).toMatchObject({
            status: 'succeeded',
            reply_content: reply.content,
        });
        expect(record.started_at).toBeGreaterThanOrEqual(record.received_at);
        expect(record.completed_at).toBeGreaterThanOrEqual(record.started_at);
        expect(JSON.parse(record.payload_json)).toMatchObject({ requestId, topicId, agentId: 'hub-probe' });

        expect(Buffer.concat(stderr).toString('utf8')).not.toContain('dispatch failed');
    }, 10_000);
});

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return;
    child.kill('SIGTERM');
    await withTimeout(new Promise<void>((resolve) => child.once('exit', () => resolve())), 3000, 'child exit timeout');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function waitForDispatchRecord(
    hubPath: string,
    requestId: string,
    status: 'accepted' | 'running' | 'succeeded' | 'failed',
): Promise<any> {
    const deadline = Date.now() + 5000;
    let last: any = null;
    while (Date.now() < deadline) {
        if (fs.existsSync(hubPath)) {
            const db = new DatabaseSync(hubPath);
            try {
                last = db.prepare(`
                    SELECT request_id, topic_id, agent_id, status, received_at, started_at,
                           completed_at, payload_json, reply_content, error
                    FROM agent_dispatches
                    WHERE request_id = ?
                `).get(requestId) as any;
                if (last?.status === status) return last;
            } finally {
                db.close();
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`dispatch ${requestId} did not reach ${status}; last=${JSON.stringify(last)}`);
}

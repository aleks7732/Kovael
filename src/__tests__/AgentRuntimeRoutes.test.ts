import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MeshOrchestrator } from '../MeshOrchestrator.js';

class FakeChild extends EventEmitter {
    public stdout = null;
    public stderr = null;
    public signals: NodeJS.Signals[] = [];

    constructor(
        public pid: number,
        private readonly exitOnKill = true,
    ) {
        super();
    }

    public kill(signal?: NodeJS.Signals): boolean {
        if (signal) this.signals.push(signal);
        if (this.exitOnKill) {
            this.emit('exit', 0, signal ?? null);
        }
        return true;
    }
}

describe('Agent runtime control routes', () => {
    const tempDirs: string[] = [];
    let orchestrator: MeshOrchestrator | null = null;

    afterEach(() => {
        orchestrator?.close();
        orchestrator = null;
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function tempDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-agent-runtime-routes-'));
        tempDirs.push(dir);
        return dir;
    }

    async function startOrchestrator(spawned: FakeChild[], exitOnKill = true): Promise<{ port: number; hubDir: string }> {
        const hubDir = tempDir();
        orchestrator = new MeshOrchestrator(0, {
            dbPath: ':memory:',
            agentRuntimes: {
                enabled: true,
                hubDir,
                agents: [{
                    agentId: 'shaev',
                    provider: 'VantagePoint Local · Hermes 3',
                    runtime: 'claude-shaev',
                }],
                spawn: () => {
                    const child = new FakeChild(9000 + spawned.length, exitOnKill);
                    spawned.push(child);
                    return child;
                },
            },
        });
        return { port: await orchestrator.ready(), hubDir };
    }

    it('lists runtimes and supports stop then start for one configured agent', async () => {
        const spawned: FakeChild[] = [];
        const { port } = await startOrchestrator(spawned);
        const api = (suffix = '') => `http://127.0.0.1:${port}/api/v1/agent-runtimes${suffix}`;

        const list = await fetch(api());
        expect(list.status).toBe(200);
        expect(await list.json()).toMatchObject({
            enabled: true,
            configured: 1,
            running: 1,
            agents: [expect.objectContaining({
                agentId: 'shaev',
                state: 'running',
                desiredState: 'running',
                pid: 9000,
            })],
        });

        const stop = await fetch(api('/shaev/stop'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'route_test_stop' }),
        });
        expect(stop.status).toBe(202);
        expect(await stop.json()).toMatchObject({
            action: 'stop',
            accepted: true,
            changed: true,
            agent: expect.objectContaining({
                agentId: 'shaev',
                state: 'stopped',
                desiredState: 'stopped',
                pid: null,
            }),
        });

        const start = await fetch(api('/shaev/start'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'route_test_start' }),
        });
        expect(start.status).toBe(202);
        expect(await start.json()).toMatchObject({
            action: 'start',
            accepted: true,
            changed: true,
            agent: expect.objectContaining({
                agentId: 'shaev',
                state: 'running',
                desiredState: 'running',
                pid: 9001,
            }),
        });
    });

    it('returns 409 for busy runtime stop unless force is set', async () => {
        const spawned: FakeChild[] = [];
        const { port, hubDir } = await startOrchestrator(spawned, false);
        const api = (suffix = '') => `http://127.0.0.1:${port}/api/v1/agent-runtimes${suffix}`;
        const hubPath = path.join(hubDir, 'shaev', 'agent-hub.sqlite');
        fs.mkdirSync(path.dirname(hubPath), { recursive: true });
        const db = new DatabaseSync(hubPath);
        try {
            db.exec(`
                CREATE TABLE agent_dispatches (
                    request_id TEXT PRIMARY KEY,
                    topic_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    received_at INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
            `);
            db.prepare(`
                INSERT INTO agent_dispatches (
                    request_id, topic_id, agent_id, status, received_at, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?)
            `).run('req-1', 'topic-1', 'shaev', 'accepted', 1, '{}');
        } finally {
            db.close();
        }

        const blocked = await fetch(api('/shaev/stop'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'route_busy_stop' }),
        });
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toMatchObject({
            error: 'agent_runtime_busy',
            busy: { accepted: 1, running: 0 },
        });
        expect(spawned[0].signals).toEqual([]);

        const forced = await fetch(api('/shaev/stop'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'route_force_stop', force: true }),
        });
        expect(forced.status).toBe(202);
        expect(await forced.json()).toMatchObject({
            accepted: true,
            changed: true,
        });
        expect(spawned[0].signals).toEqual(['SIGTERM']);
    });

    it('handles one-runtime lookup, unknown agents, and method errors', async () => {
        const spawned: FakeChild[] = [];
        const { port } = await startOrchestrator(spawned);
        const api = (suffix = '') => `http://127.0.0.1:${port}/api/v1/agent-runtimes${suffix}`;

        const one = await fetch(api('/shaev'));
        expect(one.status).toBe(200);
        expect(await one.json()).toMatchObject({
            agentId: 'shaev',
            state: 'running',
        });

        const unknown = await fetch(api('/missing-agent'));
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toEqual({
            error: 'unknown_agent_runtime',
            agentId: 'missing-agent',
        });

        const badMethod = await fetch(api('/shaev/start'));
        expect(badMethod.status).toBe(405);
        expect(await badMethod.json()).toEqual({ error: 'method_not_allowed' });
    });
});

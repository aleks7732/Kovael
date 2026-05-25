import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

describe('kovael-agent-inbox hub persistence', () => {
    const tempDirs: string[] = [];
    const servers: http.Server[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
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
});

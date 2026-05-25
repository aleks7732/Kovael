import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentHubStore } from '../services/AgentHubStore.js';

describe('AgentHubStore', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function tempDbPath(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-agent-hub-'));
        tempDirs.push(dir);
        return path.join(dir, 'shaev', 'agent-hub.sqlite');
    }

    it('persists dispatch state across store reopen without deleting memory', () => {
        const dbPath = tempDbPath();
        const payload = {
            requestId: 'req-1',
            topicId: 'topic-1',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
            messages: [{ role: 'user', content: 'hold this thought' }],
        };

        const first = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 100 });
        expect(first.recordInboundDispatch(payload).duplicate).toBe(false);
        first.markDispatchRunning('req-1');
        first.markDispatchSucceeded('req-1', 'remembered reply');
        first.upsertMemory('last-topic', { topicId: 'topic-1' });
        first.close();

        const reopened = new AgentHubStore({ agentId: 'shaev', dbPath, now: () => 200 });
        expect(reopened.getDispatch('req-1')).toMatchObject({
            requestId: 'req-1',
            topicId: 'topic-1',
            agentId: 'shaev',
            status: 'succeeded',
            replyContent: 'remembered reply',
        });
        expect(reopened.getMemory('last-topic')).toEqual({ topicId: 'topic-1' });
        reopened.close();
    });

    it('deduplicates request ids so ChairBridge retries do not double-run runtimes', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath });
        const payload = {
            requestId: 'req-duplicate',
            topicId: 'topic-duplicate',
            agentId: 'shaev',
            replyUrl: 'http://127.0.0.1:8080/api/v1/chairs/reply',
        };

        expect(hub.recordInboundDispatch(payload).duplicate).toBe(false);
        expect(hub.recordInboundDispatch(payload).duplicate).toBe(true);
        expect(hub.stats().dispatches).toBe(1);
        hub.close();
    });

    it('rejects dispatch payloads for a different agent hub', () => {
        const dbPath = tempDbPath();
        const hub = new AgentHubStore({ agentId: 'shaev', dbPath });

        expect(() => hub.recordInboundDispatch({
            requestId: 'req-wrong-agent',
            topicId: 'topic-wrong-agent',
            agentId: 'nyx-codex',
        })).toThrow(/wrong agent/i);

        hub.close();
    });
});

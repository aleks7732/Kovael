import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeSupervisor } from '../services/AgentRuntimeSupervisor.js';
import { Logger } from '../services/Logger.js';

class FakeChild extends EventEmitter {
    public pid = 4242;
    public killedWith: NodeJS.Signals | undefined;
    public stdout = null;
    public stderr = null;

    public kill(signal?: NodeJS.Signals): boolean {
        this.killedWith = signal;
        this.emit('exit', 0, signal ?? null);
        return true;
    }
}

describe('AgentRuntimeSupervisor', () => {
    const tempDirs: string[] = [];
    const logger = new Logger({ service: 'agent-runtime-test', sink: () => undefined });

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function tempDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-agent-runtime-'));
        tempDirs.push(dir);
        return dir;
    }

    it('starts configured agent inboxes with persistent hub paths and stops them on app shutdown', () => {
        const hubDir = tempDir();
        const spawned: Array<{ command: string; args: string[]; child: FakeChild }> = [];
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir,
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
                capabilities: ['visual-synthesis'],
                trustTier: 3,
            }],
            logger,
            spawn: (command, args) => {
                const child = new FakeChild();
                spawned.push({ command, args, child });
                return child;
            },
        });

        supervisor.start(18080, 'test_start');

        expect(spawned).toHaveLength(1);
        expect(spawned[0].command).toBe(process.execPath);
        expect(spawned[0].args).toContain('--id');
        expect(spawned[0].args).toContain('shaev');
        expect(spawned[0].args).toContain('--runtime');
        expect(spawned[0].args).toContain('claude-shaev');
        expect(spawned[0].args).toContain('--host');
        expect(spawned[0].args).toContain('http://127.0.0.1:18080');
        expect(spawned[0].args).toContain('--hub-path');
        expect(spawned[0].args).toContain(path.join(hubDir, 'shaev', 'agent-hub.sqlite'));

        supervisor.stop('app_shutdown');

        expect(spawned[0].child.killedWith).toBe('SIGTERM');
        expect(supervisor.snapshot()).toMatchObject({
            enabled: true,
            running: 0,
            configured: 1,
        });
    });

    it('does not spawn openclaw in the default local lifecycle profile', () => {
        const spawned: unknown[] = [];
        const supervisor = AgentRuntimeSupervisor.fromEnvironment({
            env: { KOVAEL_AGENT_RUNTIMES_ENABLED: 'true' },
            cwd: 'I:\\Kovael',
            logger,
            spawn: (command, args) => {
                spawned.push({ command, args });
                return new FakeChild();
            },
        });

        supervisor.start(18080, 'test_start');

        const snapshot = supervisor.snapshot();
        expect(snapshot.agents.map((agent) => agent.agentId).sort()).toEqual(['nyx-codex', 'shaev']);
        expect(snapshot.agents.some((agent) => agent.agentId === 'nyx-openclaw')).toBe(false);
        expect(spawned).toHaveLength(2);

        supervisor.stop('cleanup');
    });
});

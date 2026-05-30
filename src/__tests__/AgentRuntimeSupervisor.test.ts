import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeSupervisor } from '../services/AgentRuntimeSupervisor.js';
import { Logger } from '../services/Logger.js';
import { buildAgentRuntimeEnv } from '../services/RuntimeSecurity.js';

class FakeChild extends EventEmitter {
    public pid: number;
    public killedWith: NodeJS.Signals | undefined;
    public signals: NodeJS.Signals[] = [];
    public stdout: NodeJS.ReadableStream | null = null;
    public stderr: NodeJS.ReadableStream | null = null;

    constructor(
        pid = 4242,
        private readonly exitOnKill = true,
    ) {
        super();
        this.pid = pid;
    }

    public kill(signal?: NodeJS.Signals): boolean {
        this.killedWith = signal;
        if (signal) this.signals.push(signal);
        if (this.exitOnKill) {
            this.emit('exit', 0, signal ?? null);
        }
        return true;
    }

    public exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
        this.emit('exit', code, signal);
    }
}

describe('AgentRuntimeSupervisor', () => {
    const tempDirs: string[] = [];
    const hubSecret = '0123456789abcdef0123456789abcdef';
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

    function secureEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
        return {
            KOVAEL_AGENT_HUB_SECRET: hubSecret,
            ...extra,
        };
    }

    it('starts configured agent inboxes with persistent hub paths and stops them on app shutdown', () => {
        const hubDir = tempDir();
        const spawned: Array<{ command: string; args: string[]; child: FakeChild }> = [];
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir,
            env: secureEnv(),
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
            env: secureEnv({ KOVAEL_AGENT_RUNTIMES_ENABLED: 'true' }),
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

    it('requires explicit elevated opt-in before supervising openclaw', () => {
        const denied = AgentRuntimeSupervisor.fromEnvironment({
            env: secureEnv({
                KOVAEL_AGENT_RUNTIMES_ENABLED: 'true',
                KOVAEL_AGENT_RUNTIME_IDS: 'nyx-openclaw',
            }),
            cwd: 'I:\\Kovael',
            logger,
            spawn: () => new FakeChild(),
        });

        expect(denied.snapshot()).toMatchObject({
            configured: 0,
            agents: [],
        });

        const spawned: Array<{ args: string[] }> = [];
        const allowed = AgentRuntimeSupervisor.fromEnvironment({
            env: secureEnv({
                KOVAEL_AGENT_RUNTIMES_ENABLED: 'true',
                KOVAEL_AGENT_RUNTIME_IDS: 'nyx-openclaw',
                KOVAEL_ENABLE_ELEVATED_RUNTIMES: 'true',
            }),
            cwd: 'I:\\Kovael',
            logger,
            spawn: (_command, args) => {
                spawned.push({ args });
                return new FakeChild();
            },
        });

        allowed.start(18080, 'test_start');

        expect(allowed.snapshot().agents.map((agent) => agent.agentId)).toEqual(['nyx-openclaw']);
        expect(spawned[0].args).toContain('codex-openclaw');

        allowed.stop('cleanup');
    });

    it('places default managed hubs outside the workspace', () => {
        const cwd = tempDir();
        const supervisor = AgentRuntimeSupervisor.fromEnvironment({
            env: secureEnv({ KOVAEL_AGENT_RUNTIMES_ENABLED: 'true' }),
            cwd,
            logger,
            spawn: () => new FakeChild(),
        });

        const hubPath = supervisor.snapshot().agents[0].hubPath;
        expect(path.isAbsolute(hubPath)).toBe(true);
        expect(path.resolve(hubPath).toLowerCase().startsWith(path.resolve(cwd).toLowerCase())).toBe(false);
    });

    it('requires a hub encryption secret before managed runtime startup', () => {
        const spawned: unknown[] = [];
        const supervisor = AgentRuntimeSupervisor.fromEnvironment({
            env: { KOVAEL_AGENT_RUNTIMES_ENABLED: 'true' },
            cwd: tempDir(),
            logger,
            spawn: () => {
                spawned.push(true);
                return new FakeChild();
            },
        });

        supervisor.start(18080, 'test_start');
        expect(spawned).toHaveLength(0);
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'failed',
            lastError: expect.stringContaining('KOVAEL_AGENT_HUB_SECRET'),
        });
        expect(supervisor.startAgent('shaev', 18080)).toMatchObject({
            accepted: false,
            statusCode: 409,
            error: 'agent_hub_encryption_required',
        });
    });

    it('rejects unsafe network-style hub directories', () => {
        const supervisor = AgentRuntimeSupervisor.fromEnvironment({
            env: secureEnv({
                KOVAEL_AGENT_RUNTIMES_ENABLED: 'true',
                KOVAEL_AGENT_HUB_DIR: '\\\\server\\share\\kovael-agents',
            }),
            cwd: tempDir(),
            logger,
            spawn: () => new FakeChild(),
        });

        expect(supervisor.startAgent('shaev', 18080)).toMatchObject({
            accepted: false,
            statusCode: 409,
            error: 'unsafe_agent_hub_dir',
        });
    });

    it('passes only allowlisted environment values to adapter processes', () => {
        let adapterEnv: NodeJS.ProcessEnv | undefined;
        const supervisor = AgentRuntimeSupervisor.fromEnvironment({
            env: secureEnv({
                KOVAEL_AGENT_RUNTIMES_ENABLED: 'true',
                KOVAEL_API_TOKEN: 'api-token-for-adapter',
                KOVAEL_CHAIR_DISPATCH_SECRET: 'dispatch-secret-0123456789abcdef',
                KOVAEL_CODEX_BIN: 'codex-test-bin',
                KOVAEL_SECRET_CANARY: 'must-not-pass',
                HTTPS_PROXY: 'http://proxy.example:8443',
                no_proxy: '127.0.0.1,localhost',
                OPENAI_API_KEY: 'must-not-pass-openai',
            }),
            cwd: tempDir(),
            logger,
            spawn: (_command, _args, options) => {
                adapterEnv = options.env as NodeJS.ProcessEnv;
                return new FakeChild();
            },
        });

        supervisor.start(18080, 'test_start');

        expect(adapterEnv?.KOVAEL_TOKEN).toBe('api-token-for-adapter');
        expect(adapterEnv?.KOVAEL_API_TOKEN).toBeUndefined();
        expect(adapterEnv?.KOVAEL_AGENT_HUB_SECRET).toBe(hubSecret);
        expect(adapterEnv?.KOVAEL_AGENT_HUB_ENCRYPTION).toBe('required');
        expect(adapterEnv?.KOVAEL_CHAIR_DISPATCH_SECRET).toBe('dispatch-secret-0123456789abcdef');
        expect(adapterEnv?.KOVAEL_CODEX_BIN).toBe('codex-test-bin');
        expect(adapterEnv?.HTTPS_PROXY).toBe('http://proxy.example:8443');
        expect(adapterEnv?.no_proxy).toBe('127.0.0.1,localhost');
        expect(adapterEnv?.KOVAEL_SECRET_CANARY).toBeUndefined();
        expect(adapterEnv?.OPENAI_API_KEY).toBeUndefined();

        supervisor.stop('cleanup');
    });

    it('forwards the command allow-list and manifest allowEnv to a command inbox, never secrets', () => {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: tempDir(),
            hubDir: tempDir(),
            env: secureEnv({
                KOVAEL_COMMAND_ADAPTER_ALLOW: 'node',
                KOVAEL_HOST: 'http://127.0.0.1:8080',
                KOVAEL_API_TOKEN: 'must-not-pass-via-allowenv',
            }),
            agents: [{
                agentId: 'nyx-cmd',
                provider: 'Local · Example',
                runtime: 'command',
                command: 'node',
                args: ['-e', 'process.stdout.write("hi")'],
                allowEnv: ['KOVAEL_HOST', 'KOVAEL_API_TOKEN'],
            }],
            logger,
            spawn: (_command, _args, options) => {
                capturedEnv = options.env as NodeJS.ProcessEnv;
                return new FakeChild();
            },
        });

        supervisor.startAgent('nyx-cmd', 18080, { reason: 'command_env_test' });

        expect(capturedEnv?.KOVAEL_COMMAND_ADAPTER_ALLOW).toBe('node');
        expect(capturedEnv?.KOVAEL_HOST).toBe('http://127.0.0.1:8080');
        // a denylisted secret name is never forwarded via allowEnv
        expect(capturedEnv?.KOVAEL_API_TOKEN).toBeUndefined();

        supervisor.stop('cleanup');
    });

    it('does not leak the command allow-list to non-command inboxes', () => {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: tempDir(),
            hubDir: tempDir(),
            env: secureEnv({ KOVAEL_COMMAND_ADAPTER_ALLOW: 'node' }),
            agents: [{ agentId: 'nyx-codex', provider: 'OpenAI · Codex CLI', runtime: 'codex' }],
            logger,
            spawn: (_command, _args, options) => {
                capturedEnv = options.env as NodeJS.ProcessEnv;
                return new FakeChild();
            },
        });

        supervisor.startAgent('nyx-codex', 18080, { reason: 'codex_env_test' });

        expect(capturedEnv?.KOVAEL_COMMAND_ADAPTER_ALLOW).toBeUndefined();

        supervisor.stop('cleanup');
    });

    it('reports runtime preflight status without protected config contents', () => {
        const cwd = tempDir();
        const secretText = 'protected-local-secret-should-not-appear';
        const codexConfigDir = path.join(cwd, '.codex');
        fs.mkdirSync(codexConfigDir, { recursive: true });
        fs.writeFileSync(path.join(codexConfigDir, 'config.json'), secretText);
        let spawnCwd: string | undefined;
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd,
            hubDir: tempDir(),
            env: secureEnv(),
            agents: [{
                agentId: 'nyx-codex',
                provider: 'OpenAI · Codex CLI',
                runtime: 'codex',
            }],
            logger,
            spawn: (_command, _args, options) => {
                spawnCwd = options.cwd?.toString();
                return new FakeChild();
            },
        });

        supervisor.startAgent('nyx-codex', 18080, { reason: 'preflight_status' });

        const status = supervisor.getAgentStatus('nyx-codex');
        expect(status?.preflight).toMatchObject({
            executablePath: process.execPath,
            cwd,
            sandboxMode: 'read-only',
            permissionMode: null,
            hubEncryptionActive: true,
            environment: 'stripped',
        });
        expect(status?.preflight.protectedLocalConfigPaths).toContainEqual({
            label: 'workspace:.codex',
            exists: true,
        });
        expect(JSON.stringify(status)).not.toContain(codexConfigDir);
        expect(JSON.stringify(status)).not.toContain(secretText);
        expect(spawnCwd).toBe(cwd);
    });

    it('reports Claude launch preflight with empty tools and no session persistence', () => {
        const cwd = tempDir();
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd,
            hubDir: tempDir(),
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => new FakeChild(),
        });

        const status = supervisor.getAgentStatus('shaev');

        expect(status?.preflight).toMatchObject({
            executablePath: process.execPath,
            cwd,
            sandboxMode: null,
            permissionMode: 'dontAsk',
            allowedTools: [],
            sessionPersistence: false,
            hubEncryptionActive: true,
            environment: 'stripped',
        });
    });

    it('redacts adapter stderr before logging', () => {
        const lines: string[] = [];
        const stderr = new PassThrough();
        const child = new FakeChild(4700, false);
        child.stderr = stderr;
        const redactingLogger = new Logger({
            service: 'agent-runtime-test',
            sink: (line) => lines.push(line),
        });
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: tempDir(),
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger: redactingLogger,
            spawn: () => child,
        });

        supervisor.startAgent('shaev', 18080, { reason: 'stderr_redaction' });
        stderr.write('KOVAEL_SECRET_CANARY=super-secret-value bearer abcdefghijklmnopqrstuvwxyz0123456789abcdef\n');

        const stderrRecord = lines.map((line) => JSON.parse(line) as { msg: string; line?: string })
            .find((line) => line.msg === 'agent_runtime_stderr');
        expect(stderrRecord?.line).toContain('KOVAEL_SECRET_CANARY=[REDACTED]');
        expect(stderrRecord?.line).not.toContain('super-secret-value');
        expect(stderrRecord?.line).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789abcdef');
    });

    it('strips KOVAEL secrets from real runtime child environments', () => {
        const runtimeEnv = buildAgentRuntimeEnv({
            PATH: process.env.PATH,
            KOVAEL_API_TOKEN: 'api-token-must-not-pass',
            KOVAEL_TOKEN: 'token-must-not-pass',
            KOVAEL_AGENT_HUB_SECRET: hubSecret,
            KOVAEL_CHAIR_DISPATCH_SECRET: 'dispatch-secret-must-not-pass',
            KOVAEL_SECRET_CANARY: 'canary-must-not-pass',
            KOVAEL_CODEX_BIN: 'codex-locator-must-not-pass-runtime',
            OPENAI_API_KEY: 'openai-key-must-not-pass',
            HTTPS_PROXY: 'http://proxy.example:8443',
        });

        expect(Object.keys(runtimeEnv).filter((key) => key.startsWith('KOVAEL_'))).toEqual([]);
        expect(runtimeEnv.OPENAI_API_KEY).toBeUndefined();
        expect(runtimeEnv.HTTPS_PROXY).toBe('http://proxy.example:8443');
    });

    it('reports disabled, exited, and failed lifecycle states', () => {
        const disabled = new AgentRuntimeSupervisor({
            enabled: false,
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => new FakeChild(),
        });
        expect(disabled.getAgentStatus('shaev')).toMatchObject({
            state: 'disabled',
            desiredState: 'stopped',
            running: false,
        });
        expect(disabled.startAgent('shaev', 18080)).toMatchObject({
            accepted: false,
            statusCode: 409,
            error: 'agent_runtime_disabled',
        });

        const exitingChild = new FakeChild(4300, false);
        const exited = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir: tempDir(),
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => exitingChild,
        });
        exited.startAgent('shaev', 18080, { reason: 'exit_state_test' });
        exitingChild.exit(17, null);
        expect(exited.getAgentStatus('shaev')).toMatchObject({
            state: 'exited',
            desiredState: 'running',
            running: false,
            exitCode: 17,
        });

        const failingChild = new FakeChild(4400, false);
        const failed = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir: tempDir(),
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => failingChild,
        });
        failed.startAgent('shaev', 18080, { reason: 'failed_state_test' });
        failingChild.emit('error', new Error('spawn failed'));
        expect(failed.getAgentStatus('shaev')).toMatchObject({
            state: 'failed',
            desiredState: 'running',
            running: false,
            lastError: 'spawn failed',
        });
    });

    it('keeps manual stop sticky but restarts runtimes parked by idle mode', () => {
        const hubDir = tempDir();
        const spawned: FakeChild[] = [];
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir,
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => {
                const child = new FakeChild(5000 + spawned.length);
                spawned.push(child);
                return child;
            },
        });

        supervisor.start(18080, 'boot');
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'running',
            desiredState: 'running',
            pid: 5000,
        });

        supervisor.stopAgent('shaev', { reason: 'operator_stop' });
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'stopped',
            desiredState: 'stopped',
            pid: null,
        });

        supervisor.start(18080, 'resource_active');
        expect(spawned).toHaveLength(1);
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'stopped',
            desiredState: 'stopped',
        });

        supervisor.startAgent('shaev', 18080, { reason: 'operator_start' });
        expect(spawned).toHaveLength(2);
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'running',
            desiredState: 'running',
            pid: 5001,
        });

        supervisor.stop('resource_idle');
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'stopped',
            desiredState: 'running',
            pid: null,
        });

        supervisor.start(18080, 'resource_active');
        expect(spawned).toHaveLength(3);
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'running',
            desiredState: 'running',
            pid: 5002,
        });
    });

    it('ignores stale process exits after a restart spawns a new generation', () => {
        const hubDir = tempDir();
        const spawned: FakeChild[] = [];
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir,
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => {
                const child = new FakeChild(6000 + spawned.length, false);
                spawned.push(child);
                return child;
            },
        });

        supervisor.startAgent('shaev', 18080, { reason: 'initial' });
        const oldChild = spawned[0];
        supervisor.restartAgent('shaev', 18080, { reason: 'restart', force: true });

        expect(spawned).toHaveLength(2);
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'running',
            pid: 6001,
        });

        oldChild.exit(0, 'SIGTERM');

        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'running',
            pid: 6001,
        });
    });

    it('escalates from SIGTERM to SIGKILL when a process does not exit', () => {
        vi.useFakeTimers();
        try {
            const hubDir = tempDir();
            const child = new FakeChild(7000, false);
            const supervisor = new AgentRuntimeSupervisor({
                enabled: true,
                cwd: 'I:\\Kovael',
                hubDir,
                env: secureEnv(),
                agents: [{
                    agentId: 'shaev',
                    provider: 'VantagePoint Local · Hermes 3',
                    runtime: 'claude-shaev',
                }],
                logger,
                spawn: () => child,
            });

            supervisor.startAgent('shaev', 18080, { reason: 'initial' });
            supervisor.stopAgent('shaev', { reason: 'operator_stop', timeoutMs: 1000 });

            expect(supervisor.getAgentStatus('shaev')).toMatchObject({
                state: 'stopping',
                desiredState: 'stopped',
                pid: 7000,
            });
            expect(child.signals).toEqual(['SIGTERM']);

            vi.advanceTimersByTime(1000);

            expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);

            child.exit(null, 'SIGKILL');
            expect(supervisor.getAgentStatus('shaev')).toMatchObject({
                state: 'stopped',
                pid: null,
                exitSignal: 'SIGKILL',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('blocks stop while the hub has accepted or running dispatches unless forced', () => {
        const hubDir = tempDir();
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
            `).run('req-1', 'topic-1', 'shaev', 'running', 1, '{}');
        } finally {
            db.close();
        }

        const child = new FakeChild(8000, false);
        const supervisor = new AgentRuntimeSupervisor({
            enabled: true,
            cwd: 'I:\\Kovael',
            hubDir,
            env: secureEnv(),
            agents: [{
                agentId: 'shaev',
                provider: 'VantagePoint Local · Hermes 3',
                runtime: 'claude-shaev',
            }],
            logger,
            spawn: () => child,
        });

        supervisor.startAgent('shaev', 18080, { reason: 'initial' });
        const blocked = supervisor.stopAgent('shaev', { reason: 'operator_stop' });

        expect(blocked).toMatchObject({
            accepted: false,
            statusCode: 409,
            error: 'agent_runtime_busy',
            busy: { accepted: 0, running: 1 },
        });
        expect(child.signals).toEqual([]);
        expect(supervisor.getAgentStatus('shaev')).toMatchObject({
            state: 'running',
            desiredState: 'running',
        });

        const forced = supervisor.stopAgent('shaev', { reason: 'operator_stop', force: true });

        expect(forced).toMatchObject({
            accepted: true,
            changed: true,
            statusCode: 202,
        });
        expect(child.signals).toEqual(['SIGTERM']);
    });
});

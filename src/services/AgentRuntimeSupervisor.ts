import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';
import { AgentCards } from '../AgentCards.js';
import { Logger, rootLogger } from './Logger.js';

export interface AgentRuntimeSpec {
    agentId: string;
    provider: string;
    runtime: 'codex' | 'codex-openclaw' | 'claude-shaev';
    capabilities?: string[];
    trustTier?: number;
    cwd?: string;
    model?: string;
    enabled?: boolean;
}

export interface AgentRuntimeSnapshot {
    enabled: boolean;
    parkOnIdle: boolean;
    configured: number;
    running: number;
    agents: Array<{
        agentId: string;
        runtime: string;
        running: boolean;
        pid: number | null;
        hubPath: string;
    }>;
}

export interface AgentRuntimeProcess extends EventEmitter {
    pid?: number;
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
    kill(signal?: NodeJS.Signals): boolean;
}

export type AgentRuntimeSpawn = (
    command: string,
    args: string[],
    options: SpawnOptions,
) => AgentRuntimeProcess;

export interface AgentRuntimeSupervisorConfig {
    enabled?: boolean;
    parkOnIdle?: boolean;
    cwd?: string;
    hubDir?: string;
    nodeBin?: string;
    scriptPath?: string;
    host?: string;
    agents?: AgentRuntimeSpec[];
    env?: NodeJS.ProcessEnv;
    logger?: Logger;
    spawn?: AgentRuntimeSpawn;
}

export interface AgentRuntimeEnvironmentOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    logger?: Logger;
    spawn?: AgentRuntimeSpawn;
}

interface ManagedRuntime {
    spec: AgentRuntimeSpec;
    hubPath: string;
    child: AgentRuntimeProcess;
}

const DEFAULT_AGENT_IDS = ['shaev', 'nyx-codex'] as const;

export class AgentRuntimeSupervisor {
    private readonly enabled: boolean;
    private readonly parkOnIdleFlag: boolean;
    private readonly cwd: string;
    private readonly hubDir: string;
    private readonly nodeBin: string;
    private readonly scriptPath: string;
    private readonly hostOverride?: string;
    private readonly agents: AgentRuntimeSpec[];
    private readonly env: NodeJS.ProcessEnv;
    private readonly log: Logger;
    private readonly spawn: AgentRuntimeSpawn;
    private readonly running: Map<string, ManagedRuntime> = new Map();

    constructor(config: AgentRuntimeSupervisorConfig = {}) {
        this.enabled = config.enabled ?? false;
        this.parkOnIdleFlag = config.parkOnIdle ?? true;
        this.cwd = config.cwd ?? process.cwd();
        this.hubDir = config.hubDir ?? path.join(this.cwd, '.kovael', 'agents');
        this.nodeBin = config.nodeBin ?? process.execPath;
        this.scriptPath = config.scriptPath ?? path.join(this.cwd, 'scripts', 'kovael-agent-inbox.mjs');
        this.hostOverride = config.host;
        this.agents = (config.agents ?? defaultAgentRuntimeSpecs()).filter((agent) => agent.enabled !== false);
        this.env = config.env ?? process.env;
        this.log = config.logger ?? rootLogger;
        this.spawn = config.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
    }

    public static fromEnvironment(options: AgentRuntimeEnvironmentOptions = {}): AgentRuntimeSupervisor {
        const env = options.env ?? process.env;
        const cwd = options.cwd ?? process.cwd();
        const enabled = readBoolean(env.KOVAEL_AGENT_RUNTIMES_ENABLED, false);
        const parkOnIdle = readBoolean(env.KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE, true);
        const ids = parseAgentIds(env.KOVAEL_AGENT_RUNTIME_IDS);
        const agents = defaultAgentRuntimeSpecs(ids);
        return new AgentRuntimeSupervisor({
            enabled,
            parkOnIdle,
            cwd,
            hubDir: env.KOVAEL_AGENT_HUB_DIR || undefined,
            host: env.KOVAEL_HOST || undefined,
            agents,
            env,
            logger: options.logger,
            spawn: options.spawn,
        });
    }

    public start(orchestratorPort: number, reason = 'start'): void {
        if (!this.enabled) return;
        const host = this.hostOverride ?? `http://127.0.0.1:${orchestratorPort}`;
        for (const spec of this.agents) {
            if (this.running.has(spec.agentId)) continue;
            const hubPath = this.hubPathFor(spec.agentId);
            const args = this.argsFor(spec, host, hubPath);
            const child = this.spawn(this.nodeBin, args, {
                cwd: spec.cwd ?? this.cwd,
                env: this.childEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            const managed = { spec, hubPath, child };
            this.running.set(spec.agentId, managed);
            child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
                if (this.running.get(spec.agentId)?.child === child) {
                    this.running.delete(spec.agentId);
                }
                this.log.info('agent_runtime_exited', {
                    agent_id: spec.agentId,
                    code,
                    signal,
                });
            });
            child.once('error', (err: Error) => {
                if (this.running.get(spec.agentId)?.child === child) {
                    this.running.delete(spec.agentId);
                }
                this.log.warn('agent_runtime_spawn_failed', {
                    agent_id: spec.agentId,
                    error: err.message,
                });
            });
            child.stderr?.on('data', (chunk: Buffer | string) => {
                const line = chunk.toString().trim();
                if (line) {
                    this.log.info('agent_runtime_stderr', {
                        agent_id: spec.agentId,
                        line: line.slice(0, 500),
                    });
                }
            });
            this.log.info('agent_runtime_started', {
                agent_id: spec.agentId,
                pid: child.pid ?? null,
                reason,
                hub_path: hubPath,
            });
        }
    }

    public stop(reason = 'stop'): void {
        for (const managed of Array.from(this.running.values())) {
            this.log.info('agent_runtime_stopping', {
                agent_id: managed.spec.agentId,
                pid: managed.child.pid ?? null,
                reason,
            });
            managed.child.kill('SIGTERM');
            this.running.delete(managed.spec.agentId);
        }
    }

    public parkOnIdle(): boolean {
        return this.enabled && this.parkOnIdleFlag;
    }

    public snapshot(): AgentRuntimeSnapshot {
        return {
            enabled: this.enabled,
            parkOnIdle: this.parkOnIdleFlag,
            configured: this.agents.length,
            running: this.running.size,
            agents: this.agents.map((spec) => {
                const running = this.running.get(spec.agentId);
                return {
                    agentId: spec.agentId,
                    runtime: spec.runtime,
                    running: Boolean(running),
                    pid: running?.child.pid ?? null,
                    hubPath: running?.hubPath ?? this.hubPathFor(spec.agentId),
                };
            }),
        };
    }

    private argsFor(spec: AgentRuntimeSpec, host: string, hubPath: string): string[] {
        const args = [
            this.scriptPath,
            '--id', spec.agentId,
            '--provider', spec.provider,
            '--runtime', spec.runtime,
            '--host', host,
            '--cwd', spec.cwd ?? this.cwd,
            '--hub-path', hubPath,
        ];
        if (spec.capabilities?.length) {
            args.push('--capabilities', spec.capabilities.join(','));
        }
        if (typeof spec.trustTier === 'number') {
            args.push('--trust', String(spec.trustTier));
        }
        if (spec.model) {
            args.push('--model', spec.model);
        }
        if (this.env.KOVAEL_API_TOKEN || this.env.KOVAEL_TOKEN) {
            args.push('--with-token');
        }
        return args;
    }

    private hubPathFor(agentId: string): string {
        return path.join(this.hubDir, safePathSegment(agentId), 'agent-hub.sqlite');
    }

    private childEnv(): NodeJS.ProcessEnv {
        const env = { ...this.env };
        if (!env.KOVAEL_TOKEN && env.KOVAEL_API_TOKEN) {
            env.KOVAEL_TOKEN = env.KOVAEL_API_TOKEN;
        }
        return env;
    }
}

function defaultAgentRuntimeSpecs(ids: readonly string[] = DEFAULT_AGENT_IDS): AgentRuntimeSpec[] {
    const byId: Record<string, AgentRuntimeSpec> = {
        shaev: {
            agentId: 'shaev',
            provider: AgentCards.shaev.provider,
            runtime: 'claude-shaev',
            capabilities: AgentCards.shaev.mcp_capabilities,
            trustTier: AgentCards.shaev.trust_tier,
        },
        'nyx-codex': {
            agentId: 'nyx-codex',
            provider: AgentCards['nyx-codex'].provider,
            runtime: 'codex',
            capabilities: AgentCards['nyx-codex'].mcp_capabilities,
            trustTier: AgentCards['nyx-codex'].trust_tier,
        },
    };
    return ids.map((id) => byId[id]).filter((spec): spec is AgentRuntimeSpec => spec !== undefined);
}

function parseAgentIds(value: string | undefined): string[] {
    if (!value?.trim()) return [...DEFAULT_AGENT_IDS];
    return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
    const normalized = value?.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
    return fallback;
}

function safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

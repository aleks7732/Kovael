import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
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

export type AgentRuntimeLifecycleState =
    | 'disabled'
    | 'stopped'
    | 'starting'
    | 'running'
    | 'stopping'
    | 'exited'
    | 'failed';

export type AgentRuntimeDesiredState = 'running' | 'stopped';

export interface AgentRuntimeHubSnapshot {
    exists: boolean;
    schemaVersion: string | null;
    dispatches: number;
    accepted: number;
    running: number;
    succeeded: number;
    failed: number;
    memories: number;
    error?: string;
}

export interface AgentRuntimeAgentStatus {
    agentId: string;
    provider: string;
    runtime: string;
    enabled: boolean;
    state: AgentRuntimeLifecycleState;
    desiredState: AgentRuntimeDesiredState;
    running: boolean;
    pid: number | null;
    hubPath: string;
    startedAt: number | null;
    stoppingAt: number | null;
    exitedAt: number | null;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    lastError: string | null;
    lastReason: string | null;
    hub: AgentRuntimeHubSnapshot;
}

export interface AgentRuntimeSnapshot {
    enabled: boolean;
    parkOnIdle: boolean;
    configured: number;
    running: number;
    agents: AgentRuntimeAgentStatus[];
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

export interface AgentRuntimeControlOptions {
    reason?: string;
    force?: boolean;
    timeoutMs?: number;
    sticky?: boolean;
}

export type AgentRuntimeControlAction = 'start' | 'stop' | 'restart';

export interface AgentRuntimeControlResult {
    action: AgentRuntimeControlAction;
    accepted: boolean;
    changed: boolean;
    statusCode: 200 | 202 | 404 | 409;
    agent: AgentRuntimeAgentStatus | null;
    error?: 'agent_runtime_disabled' | 'unknown_agent_runtime' | 'agent_runtime_busy';
    busy?: {
        accepted: number;
        running: number;
    };
}

export interface AgentRuntimeEnvironmentOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    logger?: Logger;
    spawn?: AgentRuntimeSpawn;
}

interface ManagedRuntime {
    child: AgentRuntimeProcess;
    generation: number;
}

interface RuntimeRecord {
    spec: AgentRuntimeSpec;
    hubPath: string;
    desiredState: AgentRuntimeDesiredState;
    state: AgentRuntimeLifecycleState;
    managed: ManagedRuntime | null;
    generation: number;
    startedAt: number | null;
    stoppingAt: number | null;
    exitedAt: number | null;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    lastError: string | null;
    lastReason: string | null;
    stopTimer: NodeJS.Timeout | null;
}

const DEFAULT_AGENT_IDS = ['shaev', 'nyx-codex'] as const;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

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
    private readonly records: Map<string, RuntimeRecord> = new Map();
    private orchestratorPort: number | null = null;

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
        for (const spec of this.agents) {
            const hubPath = this.hubPathFor(spec.agentId);
            this.records.set(spec.agentId, {
                spec,
                hubPath,
                desiredState: this.enabled ? 'running' : 'stopped',
                state: this.enabled ? 'stopped' : 'disabled',
                managed: null,
                generation: 0,
                startedAt: null,
                stoppingAt: null,
                exitedAt: null,
                exitCode: null,
                exitSignal: null,
                lastError: null,
                lastReason: null,
                stopTimer: null,
            });
        }
    }

    public static fromEnvironment(options: AgentRuntimeEnvironmentOptions = {}): AgentRuntimeSupervisor {
        const env = options.env ?? process.env;
        const cwd = options.cwd ?? process.cwd();
        const enabled = readBoolean(env.KOVAEL_AGENT_RUNTIMES_ENABLED, false);
        const parkOnIdle = readBoolean(env.KOVAEL_AGENT_RUNTIMES_PARK_ON_IDLE, true);
        const ids = parseAgentIds(env.KOVAEL_AGENT_RUNTIME_IDS);
        const enableElevated = readBoolean(env.KOVAEL_ENABLE_ELEVATED_RUNTIMES, false);
        const agents = defaultAgentRuntimeSpecs(ids, { enableElevated });
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
        this.orchestratorPort = orchestratorPort;
        if (!this.enabled) return;
        for (const record of this.records.values()) {
            if (record.desiredState !== 'running') continue;
            this.spawnRecord(record, orchestratorPort, reason);
        }
    }

    public stop(reason = 'stop'): void {
        const sticky = reason !== 'resource_idle';
        for (const record of this.records.values()) {
            this.stopRecord(record, {
                reason,
                force: true,
                sticky,
            });
        }
    }

    public startAgent(
        agentId: string,
        orchestratorPort?: number,
        options: Pick<AgentRuntimeControlOptions, 'reason'> = {},
    ): AgentRuntimeControlResult {
        const record = this.records.get(agentId);
        if (!record) return this.controlError('start', 'unknown_agent_runtime', 404, null);
        if (!this.enabled) return this.controlError('start', 'agent_runtime_disabled', 409, record);

        const port = orchestratorPort ?? this.orchestratorPort;
        if (port !== null && port !== undefined) this.orchestratorPort = port;
        record.desiredState = 'running';

        if (record.managed) {
            return {
                action: 'start',
                accepted: true,
                changed: false,
                statusCode: 200,
                agent: this.statusFor(record),
            };
        }

        this.spawnRecord(record, port ?? 0, options.reason ?? 'manual_start');
        return {
            action: 'start',
            accepted: true,
            changed: true,
            statusCode: 202,
            agent: this.statusFor(record),
        };
    }

    public stopAgent(agentId: string, options: AgentRuntimeControlOptions = {}): AgentRuntimeControlResult {
        const record = this.records.get(agentId);
        if (!record) return this.controlError('stop', 'unknown_agent_runtime', 404, null);
        if (!this.enabled) return this.controlError('stop', 'agent_runtime_disabled', 409, record);

        const busy = this.busyWork(record);
        if (record.managed && !options.force && (busy.accepted > 0 || busy.running > 0)) {
            return {
                action: 'stop',
                accepted: false,
                changed: false,
                statusCode: 409,
                error: 'agent_runtime_busy',
                busy,
                agent: this.statusFor(record),
            };
        }

        const changed = this.stopRecord(record, {
            ...options,
            reason: options.reason ?? 'manual_stop',
            sticky: options.sticky ?? true,
        });

        return {
            action: 'stop',
            accepted: true,
            changed,
            statusCode: changed ? 202 : 200,
            agent: this.statusFor(record),
        };
    }

    public restartAgent(
        agentId: string,
        orchestratorPort?: number,
        options: AgentRuntimeControlOptions = {},
    ): AgentRuntimeControlResult {
        const record = this.records.get(agentId);
        if (!record) return this.controlError('restart', 'unknown_agent_runtime', 404, null);
        if (!this.enabled) return this.controlError('restart', 'agent_runtime_disabled', 409, record);

        const busy = this.busyWork(record);
        if (record.managed && !options.force && (busy.accepted > 0 || busy.running > 0)) {
            return {
                action: 'restart',
                accepted: false,
                changed: false,
                statusCode: 409,
                error: 'agent_runtime_busy',
                busy,
                agent: this.statusFor(record),
            };
        }

        const port = orchestratorPort ?? this.orchestratorPort;
        if (port !== null && port !== undefined) this.orchestratorPort = port;
        record.desiredState = 'running';

        if (record.managed) {
            this.detachAndTerminate(record, options.reason ?? 'manual_restart', positiveTimeout(options.timeoutMs));
        }
        this.spawnRecord(record, port ?? 0, options.reason ?? 'manual_restart');

        return {
            action: 'restart',
            accepted: true,
            changed: true,
            statusCode: 202,
            agent: this.statusFor(record),
        };
    }

    public getAgentStatus(agentId: string): AgentRuntimeAgentStatus | null {
        const record = this.records.get(agentId);
        return record ? this.statusFor(record) : null;
    }

    public parkOnIdle(): boolean {
        return this.enabled && this.parkOnIdleFlag;
    }

    public snapshot(): AgentRuntimeSnapshot {
        return {
            enabled: this.enabled,
            parkOnIdle: this.parkOnIdleFlag,
            configured: this.agents.length,
            running: Array.from(this.records.values()).filter((record) => Boolean(record.managed)).length,
            agents: Array.from(this.records.values()).map((record) => this.statusFor(record)),
        };
    }

    private spawnRecord(record: RuntimeRecord, orchestratorPort: number, reason: string): boolean {
        if (!this.enabled || record.managed) return false;

        const host = this.hostOverride ?? `http://127.0.0.1:${orchestratorPort}`;
        const generation = record.generation + 1;
        record.generation = generation;
        record.state = 'starting';
        record.startedAt = null;
        record.stoppingAt = null;
        record.exitedAt = null;
        record.exitCode = null;
        record.exitSignal = null;
        record.lastError = null;
        record.lastReason = reason;
        this.clearStopTimer(record);

        const spec = record.spec;
        try {
            const args = this.argsFor(spec, host, record.hubPath);
            const child = this.spawn(this.nodeBin, args, {
                cwd: spec.cwd ?? this.cwd,
                env: this.childEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            record.managed = { child, generation };
            record.state = 'running';
            record.startedAt = Date.now();
            child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
                this.handleExit(record, child, generation, code, signal);
            });
            child.once('error', (err: Error) => {
                this.handleError(record, child, generation, err);
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
                generation,
                hub_path: record.hubPath,
            });
            return true;
        } catch (err) {
            record.managed = null;
            record.state = 'failed';
            record.exitedAt = Date.now();
            record.lastError = err instanceof Error ? err.message : String(err);
            this.log.warn('agent_runtime_spawn_failed', {
                agent_id: spec.agentId,
                error: record.lastError,
            });
            return false;
        }
    }

    private stopRecord(record: RuntimeRecord, options: AgentRuntimeControlOptions): boolean {
        const sticky = options.sticky ?? true;
        if (sticky) record.desiredState = 'stopped';

        const managed = record.managed;
        if (!managed) {
            if (record.state !== 'disabled' && sticky) {
                record.state = 'stopped';
            }
            record.lastReason = options.reason ?? record.lastReason;
            return false;
        }

        record.state = 'stopping';
        record.stoppingAt = Date.now();
        record.lastReason = options.reason ?? 'stop';
        this.log.info('agent_runtime_stopping', {
            agent_id: record.spec.agentId,
            pid: managed.child.pid ?? null,
            reason: record.lastReason,
            generation: managed.generation,
        });
        managed.child.kill('SIGTERM');
        if (record.managed?.generation === managed.generation) {
            this.armStopTimer(record, managed, positiveTimeout(options.timeoutMs));
        }
        return true;
    }

    private detachAndTerminate(record: RuntimeRecord, reason: string, timeoutMs: number): void {
        const managed = record.managed;
        if (!managed) return;
        this.clearStopTimer(record);
        record.managed = null;
        record.stoppingAt = Date.now();
        this.log.info('agent_runtime_stopping', {
            agent_id: record.spec.agentId,
            pid: managed.child.pid ?? null,
            reason,
            generation: managed.generation,
        });
        managed.child.kill('SIGTERM');
        const timer = setTimeout(() => {
            managed.child.kill('SIGKILL');
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        managed.child.once('exit', () => clearTimeout(timer));
    }

    private handleExit(
        record: RuntimeRecord,
        child: AgentRuntimeProcess,
        generation: number,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (record.managed?.child !== child || record.managed.generation !== generation) return;
        this.clearStopTimer(record);
        record.managed = null;
        record.exitedAt = Date.now();
        record.exitCode = code;
        record.exitSignal = signal;
        record.state = record.desiredState === 'stopped' || record.state === 'stopping'
            ? 'stopped'
            : 'exited';
        this.log.info('agent_runtime_exited', {
            agent_id: record.spec.agentId,
            code,
            signal,
            generation,
        });
    }

    private handleError(
        record: RuntimeRecord,
        child: AgentRuntimeProcess,
        generation: number,
        err: Error,
    ): void {
        if (record.managed?.child !== child || record.managed.generation !== generation) return;
        this.clearStopTimer(record);
        record.managed = null;
        record.exitedAt = Date.now();
        record.exitCode = null;
        record.exitSignal = null;
        record.state = 'failed';
        record.lastError = err.message;
        this.log.warn('agent_runtime_spawn_failed', {
            agent_id: record.spec.agentId,
            error: err.message,
            generation,
        });
    }

    private armStopTimer(record: RuntimeRecord, managed: ManagedRuntime, timeoutMs: number): void {
        this.clearStopTimer(record);
        const timer = setTimeout(() => {
            if (record.managed?.child !== managed.child || record.managed.generation !== managed.generation) return;
            managed.child.kill('SIGKILL');
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        record.stopTimer = timer;
    }

    private clearStopTimer(record: RuntimeRecord): void {
        if (!record.stopTimer) return;
        clearTimeout(record.stopTimer);
        record.stopTimer = null;
    }

    private controlError(
        action: AgentRuntimeControlAction,
        error: NonNullable<AgentRuntimeControlResult['error']>,
        statusCode: 404 | 409,
        record: RuntimeRecord | null,
    ): AgentRuntimeControlResult {
        return {
            action,
            accepted: false,
            changed: false,
            statusCode,
            error,
            agent: record ? this.statusFor(record) : null,
        };
    }

    private statusFor(record: RuntimeRecord): AgentRuntimeAgentStatus {
        return {
            agentId: record.spec.agentId,
            provider: record.spec.provider,
            runtime: record.spec.runtime,
            enabled: this.enabled,
            state: this.enabled ? record.state : 'disabled',
            desiredState: record.desiredState,
            running: Boolean(record.managed),
            pid: record.managed?.child.pid ?? null,
            hubPath: record.hubPath,
            startedAt: record.startedAt,
            stoppingAt: record.stoppingAt,
            exitedAt: record.exitedAt,
            exitCode: record.exitCode,
            exitSignal: record.exitSignal,
            lastError: record.lastError,
            lastReason: record.lastReason,
            hub: inspectHub(record.hubPath),
        };
    }

    private busyWork(record: RuntimeRecord): { accepted: number; running: number } {
        const hub = inspectHub(record.hubPath);
        return {
            accepted: hub.accepted,
            running: hub.running,
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

function defaultAgentRuntimeSpecs(
    ids: readonly string[] = DEFAULT_AGENT_IDS,
    options: { enableElevated?: boolean } = {},
): AgentRuntimeSpec[] {
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
    if (options.enableElevated) {
        byId['nyx-openclaw'] = {
            agentId: 'nyx-openclaw',
            provider: AgentCards['nyx-openclaw'].provider,
            runtime: 'codex-openclaw',
            capabilities: AgentCards['nyx-openclaw'].mcp_capabilities,
            trustTier: AgentCards['nyx-openclaw'].trust_tier,
        };
    }
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

function positiveTimeout(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : DEFAULT_STOP_TIMEOUT_MS;
}

function inspectHub(hubPath: string): AgentRuntimeHubSnapshot {
    const empty = {
        exists: false,
        schemaVersion: null,
        dispatches: 0,
        accepted: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        memories: 0,
    };
    if (!fs.existsSync(hubPath)) return empty;

    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(hubPath, { readOnly: true, timeout: 100 });
        return {
            exists: true,
            schemaVersion: readMeta(db, 'schema_version'),
            dispatches: countTable(db, 'agent_dispatches'),
            accepted: countStatus(db, 'accepted'),
            running: countStatus(db, 'running'),
            succeeded: countStatus(db, 'succeeded'),
            failed: countStatus(db, 'failed'),
            memories: countTable(db, 'agent_memory'),
        };
    } catch (err) {
        return {
            ...empty,
            exists: true,
            error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        };
    } finally {
        db?.close();
    }
}

function readMeta(db: DatabaseSync, key: string): string | null {
    if (!tableExists(db, 'agent_hub_meta')) return null;
    const row = db.prepare('SELECT value FROM agent_hub_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

function countTable(db: DatabaseSync, table: 'agent_dispatches' | 'agent_memory'): number {
    if (!tableExists(db, table)) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
}

function countStatus(db: DatabaseSync, status: string): number {
    if (!tableExists(db, 'agent_dispatches')) return 0;
    const row = db.prepare('SELECT COUNT(*) AS count FROM agent_dispatches WHERE status = ?').get(status) as { count: number };
    return row.count;
}

function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = ?
    `).get(table) as { name: string } | undefined;
    return Boolean(row);
}

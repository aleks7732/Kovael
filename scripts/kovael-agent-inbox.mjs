#!/usr/bin/env node
/**
 * kovael-agent-inbox — secure chair inbox + real runtime adapter.
 *
 * Starts a loopback-only HTTP inbox, claims one Kovael chair with that inboxUrl,
 * heartbeats the claim, runs the configured runtime for each dispatch, then
 * posts the real runtime response back to /api/v1/chairs/reply.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SECURITY_VERSION = 'kovael-chair-v1';
const ENCRYPTION_ALG = 'A256GCM';
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_INBOX_BYTES = 512 * 1024;
const DEFAULT_RUNTIME_TIMEOUT_MS = 180_000;
const DEFAULT_REPLY_TIMEOUT_MS = 15_000;
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
const DEFAULT_OUTBOX_LEASE_MS = 30_000;
const DEFAULT_OUTBOX_DRAIN_INTERVAL_MS = 100;
const RETRYABLE_REPLY_STATUS = new Set([429, 502, 503, 504]);
const PERMANENT_REPLY_STATUS = new Set([400, 401, 403, 404, 409]);
const AGENT_HUB_SECRET_ENV = 'KOVAEL_AGENT_HUB_SECRET';
const AGENT_HUB_ENCRYPTION_ENV = 'KOVAEL_AGENT_HUB_ENCRYPTION';

function parseArgs(argv) {
    const args = { capabilities: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        const takesValue = next !== undefined && !next.startsWith('--');
        if (key === 'probe') {
            args.probe = true;
            continue;
        }
        if (key === 'with-token') {
            args.withToken = true;
            continue;
        }
        if (key === 'require-hub-encryption') {
            args.requireHubEncryption = true;
            continue;
        }
        if (!takesValue) continue;
        i += 1;
        if (key === 'capabilities') {
            args.capabilities = next.split(',').map((s) => s.trim()).filter(Boolean);
        } else if (key === 'trust') {
            const n = Number.parseInt(next, 10);
            if (!Number.isNaN(n)) args.trust = n;
        } else if (key === 'port') {
            const n = Number.parseInt(next, 10);
            if (!Number.isNaN(n)) args.port = n;
        } else if (key === 'timeout-ms') {
            const n = Number.parseInt(next, 10);
            if (!Number.isNaN(n)) args.timeoutMs = n;
        } else {
            args[key] = next;
        }
    }
    return args;
}

function usageAndExit(reason) {
    if (reason) console.error(`kovael-agent-inbox: ${reason}`);
    console.error('Usage: node scripts/kovael-agent-inbox.mjs --id <agent-id> --provider "<provider>" --runtime codex|codex-openclaw|claude-shaev|fake-deterministic [--host http://127.0.0.1:8080] [--port 0] [--cwd I:\\Kovael] [--hub-path .kovael/agents/<id>/agent-hub.sqlite] [--model sonnet]');
    process.exit(2);
}

function bearerToken(args) {
    if (typeof args.token === 'string' && args.token.length > 0) return args.token;
    if (!args.withToken) return null;
    const token = process.env.KOVAEL_TOKEN;
    if (token) return token;
    usageAndExit('--with-token set but KOVAEL_TOKEN is empty');
}

function dispatchSecret() {
    const secret = process.env.KOVAEL_CHAIR_DISPATCH_SECRET?.trim();
    return secret && secret.length >= 32 ? secret : null;
}

function hubEncryptionRequired(args = {}) {
    return args.requireHubEncryption ||
        process.env[AGENT_HUB_ENCRYPTION_ENV]?.trim().toLowerCase() === 'required';
}

function keyFor(secret) {
    return crypto
        .createHash('sha256')
        .update(`${SECURITY_VERSION}:payload:`)
        .update(secret)
        .digest();
}

function aadFor(requestId, timestamp) {
    return Buffer.from(`${SECURITY_VERSION}\n${requestId}\n${timestamp}`, 'utf8');
}

function b64(value) {
    return value.toString('base64url');
}

function fromB64(value, field) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`invalid encrypted envelope: ${field} is required`);
    }
    return Buffer.from(value, 'base64url');
}

function encryptPayload(payload, requestId) {
    const secret = dispatchSecret();
    if (!secret) {
        return {
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' },
        };
    }
    const timestamp = Date.now();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
    cipher.setAAD(aadFor(requestId, timestamp));
    const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
        cipher.final(),
    ]);
    const body = JSON.stringify({
        version: SECURITY_VERSION,
        encrypted: true,
        alg: ENCRYPTION_ALG,
        requestId,
        timestamp,
        iv: b64(iv),
        ciphertext: b64(ciphertext),
        tag: b64(cipher.getAuthTag()),
    });
    return {
        body,
        headers: {
            'content-type': 'application/json',
            'x-kovael-chair-security': SECURITY_VERSION,
            'x-kovael-request-id': requestId,
        },
    };
}

function decryptPayload(body) {
    const secret = dispatchSecret();
    if (!secret) return body;
    if (!body || typeof body !== 'object' || body.encrypted !== true) {
        throw new Error('encrypted chair dispatch payload is required');
    }
    if (
        body.version !== SECURITY_VERSION ||
        body.alg !== ENCRYPTION_ALG ||
        typeof body.requestId !== 'string' ||
        typeof body.timestamp !== 'number'
    ) {
        throw new Error('encrypted chair dispatch envelope is malformed');
    }
    if (Math.abs(Date.now() - body.timestamp) > MAX_CLOCK_SKEW_MS) {
        throw new Error('encrypted chair dispatch envelope is stale');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), fromB64(body.iv, 'iv'));
    decipher.setAAD(aadFor(body.requestId, body.timestamp));
    decipher.setAuthTag(fromB64(body.tag, 'tag'));
    const plaintext = Buffer.concat([
        decipher.update(fromB64(body.ciphertext, 'ciphertext')),
        decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('decrypted chair dispatch payload is not an object');
    }
    return parsed;
}

async function readJson(req) {
    return await new Promise((resolve, reject) => {
        let received = 0;
        const chunks = [];
        const timer = setTimeout(() => {
            req.destroy(new Error('body_read_timeout'));
            reject(new Error('body_read_timeout'));
        }, 15_000);
        timer.unref();

        req.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_INBOX_BYTES) {
                clearTimeout(timer);
                req.destroy(new Error('payload_too_large'));
                reject(new Error('payload_too_large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(new Error('invalid_json'));
            }
        });
        req.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function postJson(hostOrUrl, pathOrBody, bodyOrToken, maybeToken) {
    const absolute = typeof pathOrBody === 'string';
    const url = absolute ? new URL(pathOrBody, hostOrUrl) : new URL(hostOrUrl);
    const body = absolute ? bodyOrToken : pathOrBody;
    const token = absolute ? maybeToken : bodyOrToken;
    const payload = JSON.stringify(body);
    const headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: 'POST', headers, body: payload });
    const text = await res.text();
    let parsed = null;
    if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    return { status: res.status, body: parsed };
}

class SharedAgentHub {
    constructor(store) {
        this.store = store;
    }

    recordInbound(payload) {
        return this.store.recordInboundDispatch(payload);
    }

    markRunning(requestId) {
        this.store.markDispatchRunning(requestId);
    }

    markSucceeded(requestId, replyContent, payload) {
        return this.store.markDispatchSucceeded(requestId, replyContent, {
            claimSessionId: payload?.claimSessionId,
            replyProofSecret: payload?.replyProofSecret,
        });
    }

    markFailed(requestId, error, payload) {
        return this.store.markDispatchFailed(requestId, error, {
            claimSessionId: payload?.claimSessionId,
            replyProofSecret: payload?.replyProofSecret,
        });
    }

    claimDueOutbox(limit, leaseMs) {
        return this.store.claimDueOutbox(limit, leaseMs);
    }

    markOutboxSent(id) {
        this.store.markOutboxSent(id);
    }

    markOutboxDeliveryFailed(id, error, retryAt, maxAttempts) {
        this.store.markOutboxDeliveryFailed(id, error, retryAt, maxAttempts);
    }

    close() {
        this.store.close();
    }
}

async function createAgentHub(cfg) {
    const mod = await loadDistService(cfg, 'AgentHubStore.js', 'AgentHubStore');
    if (typeof mod.AgentHubStore !== 'function') {
        throw new Error('AgentHubStore build artifact does not export AgentHubStore');
    }
    return new SharedAgentHub(new mod.AgentHubStore({
        agentId: cfg.id,
        dbPath: cfg.hubPath,
        encryptionRequired: cfg.requireHubEncryption,
    }));
}

async function loadRuntimeSecurity(cfg) {
    const mod = await loadDistService(cfg, 'RuntimeSecurity.js', 'RuntimeSecurity');
    const required = ['buildAgentRuntimeEnv', 'redactSensitiveText', 'safeRuntimeFailureMessage'];
    for (const name of required) {
        if (typeof mod[name] !== 'function') {
            throw new Error(`RuntimeSecurity build artifact does not export ${name}`);
        }
    }
    return {
        buildAgentRuntimeEnv: mod.buildAgentRuntimeEnv,
        redactSensitiveText: mod.redactSensitiveText,
        safeRuntimeFailureMessage: mod.safeRuntimeFailureMessage,
    };
}

async function loadDistService(cfg, fileName, label) {
    const candidates = [
        path.join(cfg.cwd, 'dist', 'services', fileName),
        path.join(process.cwd(), 'dist', 'services', fileName),
    ];
    const failures = [];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
            return await import(pathToFileURL(candidate).href);
        } catch (err) {
            failures.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const searched = candidates.join(', ');
    const details = failures.length > 0 ? ` Details: ${failures.join('; ')}` : '';
    throw new Error(`${label} build artifact is required before starting kovael-agent-inbox. Run npm run build first. Searched: ${searched}.${details}`);
}

function spawnCapture(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            windowsHide: true,
        });
        child.stdin?.end();
        let stdout = '';
        let stderr = '';
        const limit = options.maxOutputBytes ?? 1024 * 1024;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`runtime timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        timer.unref();

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (Buffer.byteLength(stdout) > limit) stdout = stdout.slice(-limit);
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
            if (Buffer.byteLength(stderr) > limit) stderr = stderr.slice(-limit);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function compactMessages(messages) {
    if (!Array.isArray(messages)) return '';
    const lines = [];
    for (const msg of messages.slice(-12)) {
        if (!msg || typeof msg !== 'object') continue;
        const role = typeof msg.role === 'string' ? msg.role : 'message';
        const name = typeof msg.name === 'string' ? `${msg.name}: ` : '';
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.trim()) lines.push(`${role} ${name}${content.trim()}`);
    }
    return lines.join('\n').slice(-20_000);
}

function promptFor(agentId, payload) {
    const history = compactMessages(payload.messages);
    return [
        `Kovael chair: ${agentId}.`,
        'Return one concise, concrete answer for the live round-table. Do not invent tool results or claim actions not performed.',
        history ? `Conversation so far:\n${history}` : '',
    ].filter(Boolean).join('\n\n');
}

async function runCodex(payload, cfg, sandbox) {
    const outPath = path.join(os.tmpdir(), `kovael-${cfg.id}-${Date.now()}-${crypto.randomUUID()}.txt`);
    const invocation = resolveCodexInvocation(cfg);
    const args = [
        ...invocation.argsPrefix,
        'exec',
        '-C',
        cfg.cwd,
        '--sandbox',
        sandbox,
        '--output-last-message',
        outPath,
        promptFor(cfg.id, payload),
    ];
    const result = await spawnCapture(invocation.command, args, {
        cwd: cfg.cwd,
        env: cfg.runtimeSecurity.buildAgentRuntimeEnv(process.env),
        timeoutMs: cfg.timeoutMs,
    });
    let text = '';
    try {
        text = fs.readFileSync(outPath, 'utf8').trim();
    } catch {
        text = result.stdout.trim();
    } finally {
        fs.rmSync(outPath, { force: true });
    }
    if (result.code !== 0) {
        throw new Error(`codex exited ${result.code}: ${result.stderr || result.stdout}`);
    }
    if (!text) throw new Error('codex returned an empty response');
    return text;
}

function resolveCodexInvocation(cfg) {
    const configured = cfg.codexBin || process.env.KOVAEL_CODEX_BIN;
    if (configured) {
        return configured.endsWith('.js')
            ? { command: process.execPath, argsPrefix: [configured] }
            : { command: configured, argsPrefix: [] };
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const script = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(script)) {
            return { command: process.execPath, argsPrefix: [script] };
        }
    }

    return { command: 'codex', argsPrefix: [] };
}

async function runClaudeShaev(payload, cfg) {
    const command = cfg.claudeBin || process.env.KOVAEL_CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude');
    const args = [
        '-p',
        promptFor(cfg.id, payload),
        '--model',
        cfg.model || 'sonnet',
        '--output-format',
        'json',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        '',
        '--no-session-persistence',
    ];
    const result = await spawnCapture(command, args, {
        cwd: cfg.cwd,
        env: cfg.runtimeSecurity.buildAgentRuntimeEnv(process.env),
        timeoutMs: cfg.timeoutMs,
    });
    const raw = result.stdout.trim() || result.stderr.trim();
    if (result.code !== 0) {
        throw new Error(`claude exited ${result.code}: ${raw}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`claude returned non-json output: ${raw.slice(0, 300)}`);
    }
    if (parsed.is_error) {
        throw new Error(String(parsed.result || 'claude returned an error'));
    }
    const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    if (!text) throw new Error('claude returned an empty response');
    return text;
}

async function runFakeDeterministic(payload, cfg) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : 'missing-request';
    const topicId = typeof payload.topicId === 'string' ? payload.topicId : 'missing-topic';
    const inputHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({
            agentId: cfg.id,
            topicId,
            requestId,
            system: payload.system ?? '',
            messages: Array.isArray(payload.messages) ? payload.messages : [],
        }))
        .digest('hex')
        .slice(0, 16);
    return `FAKE_RUNTIME_REPLY agent=${cfg.id} request=${requestId} topic=${topicId} hash=${inputHash}`;
}

function safePathSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function defaultAgentHubRoot() {
    if (process.env.KOVAEL_AGENT_HUB_DIR) return process.env.KOVAEL_AGENT_HUB_DIR;
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'Kovael', 'agents');
    }
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'kovael', 'agents');
}

// Env vars that must NEVER be forwarded to a generic command child, even if an
// operator lists them in a manifest allowEnv. Dispatch/hub/token secrets stay
// stripped regardless.
const COMMAND_ENV_DENYLIST = new Set([
    'KOVAEL_AGENT_HUB_SECRET',
    'KOVAEL_CHAIR_DISPATCH_SECRET',
    'KOVAEL_API_TOKEN',
    'KOVAEL_TOKEN',
    'KOVAEL_AGENT_HUB_ENCRYPTION',
]);

function parseCsvArg(value) {
    if (typeof value !== 'string') return [];
    return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseCommandArgsArg(value) {
    if (typeof value !== 'string' || value.length === 0) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function buildCommandEnv(cfg) {
    // Minimal, secret-free base (PATH/proxy only); then add back ONLY the
    // operator-allow-listed, non-secret vars the child explicitly needs.
    const env = cfg.runtimeSecurity.buildAgentRuntimeEnv(process.env);
    for (const name of cfg.allowEnv || []) {
        if (COMMAND_ENV_DENYLIST.has(name)) continue;
        const value = process.env[name];
        if (typeof value === 'string') env[name] = value;
    }
    return env;
}

async function runCommand(payload, cfg) {
    const command = cfg.command;
    if (!command) throw new Error('command runtime requires --command');
    // Hard gate: the binary must be on the operator's allow-list. Unset/empty
    // ⇒ disabled. This is the spawn-point check; the supervisor also drops
    // non-allow-listed command chairs before they ever reach here.
    const allow = parseCsvArg(process.env.KOVAEL_COMMAND_ADAPTER_ALLOW);
    if (!allow.includes(command)) {
        throw new Error(`command_adapter_blocked: '${command}' is not in KOVAEL_COMMAND_ADAPTER_ALLOW`);
    }
    const baseArgs = Array.isArray(cfg.commandArgs) ? cfg.commandArgs : [];
    const args = [...baseArgs, promptFor(cfg.id, payload)];
    const result = await spawnCapture(command, args, {
        cwd: cfg.cwd,
        env: buildCommandEnv(cfg),
        timeoutMs: cfg.timeoutMs,
    });
    const text = result.stdout.trim();
    if (result.code !== 0) {
        throw new Error(`command exited ${result.code}: ${result.stderr || result.stdout}`);
    }
    if (!text) throw new Error('command returned an empty response');
    return text;
}

async function runRuntime(payload, cfg) {
    if (cfg.runtime === 'fake-deterministic') return await runFakeDeterministic(payload, cfg);
    if (cfg.runtime === 'codex') return await runCodex(payload, cfg, 'read-only');
    if (cfg.runtime === 'codex-openclaw') return await runCodex(payload, cfg, 'danger-full-access');
    if (cfg.runtime === 'claude-shaev') return await runClaudeShaev(payload, cfg);
    if (cfg.runtime === 'command') return await runCommand(payload, cfg);
    throw new Error(`unknown runtime: ${cfg.runtime}`);
}

async function sendOutboxReply(row, cfg) {
    if (!row || row.kind !== 'reply') return;
    if (!row.targetUrl) throw new Error('outbox reply did not include targetUrl');
    const requestId = typeof row.payload?.requestId === 'string' ? row.payload.requestId : row.requestId;
    const secured = encryptPayload(row.payload, requestId);
    const headers = {
        ...secured.headers,
        'content-length': String(Buffer.byteLength(secured.body)),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.replyTimeoutMs);
    timer.unref();
    let res;
    try {
        res = await fetch(row.targetUrl, {
            method: 'POST',
            headers,
            body: secured.body,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`reply webhook HTTP ${res.status}: ${text}`);
        error.status = res.status;
        throw error;
    }
}

async function drainOutboxOnce(hub, cfg) {
    const rows = hub.claimDueOutbox(10, cfg.outboxLeaseMs);
    for (const row of rows) {
        try {
            await sendOutboxReply(row, cfg);
            hub.markOutboxSent(row.id);
        } catch (err) {
            const { retryAt, message } = classifyOutboxDeliveryFailure(row, err, cfg);
            hub.markOutboxDeliveryFailed(row.id, message, retryAt, cfg.outboxMaxAttempts);
            if (retryAt === null) {
                console.error(`kovael-agent-inbox: ${cfg.id} reply outbox ${row.id} dead: ${cfg.runtimeSecurity.redactSensitiveText(message)}`);
            } else {
                console.error(`kovael-agent-inbox: ${cfg.id} reply outbox ${row.id} retry: ${cfg.runtimeSecurity.redactSensitiveText(message)}`);
            }
        }
    }
}

function classifyOutboxDeliveryFailure(row, err, cfg) {
    const status = Number.isInteger(err?.status) ? err.status : null;
    const message = cfg.runtimeSecurity.redactSensitiveText(err);
    if (status !== null && PERMANENT_REPLY_STATUS.has(status)) {
        return { retryAt: null, message };
    }
    if (row.attempts >= cfg.outboxMaxAttempts) {
        return { retryAt: null, message };
    }
    if (status === null || RETRYABLE_REPLY_STATUS.has(status)) {
        const delay = Math.min(5_000, cfg.replyRetryBaseMs * Math.max(1, row.attempts));
        return { retryAt: Date.now() + delay, message };
    }
    return { retryAt: null, message };
}

function startOutboxDrain(hub, cfg) {
    let active = false;
    const tick = async () => {
        if (active) return;
        active = true;
        try {
            await drainOutboxOnce(hub, cfg);
        } catch (err) {
            console.error(`kovael-agent-inbox: ${cfg.id} outbox drain failed: ${cfg.runtimeSecurity.redactSensitiveText(err)}`);
        } finally {
            active = false;
        }
    };
    const timer = setInterval(tick, cfg.outboxDrainIntervalMs);
    timer.unref();
    void tick();
    return {
        poke: () => void tick(),
        stop: () => clearInterval(timer),
    };
}

function writeJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
}

async function startInbox(cfg, hub, outboxDrain) {
    const inFlight = new Set();
    const server = http.createServer(async (req, res) => {
        if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
            writeJson(res, 403, { error: 'loopback_only' });
            return;
        }
        if (req.method !== 'POST' || req.url !== '/inbox') {
            writeJson(res, 404, { error: 'not_found' });
            return;
        }

        let payload;
        try {
            payload = decryptPayload(await readJson(req));
        } catch (err) {
            writeJson(res, 400, { error: err.message });
            return;
        }

        if (payload.agentId !== cfg.id) {
            writeJson(res, 409, { error: 'wrong_agent', expected: cfg.id, got: payload.agentId });
            return;
        }
        if (
            typeof payload.topicId !== 'string' ||
            typeof payload.replyUrl !== 'string' ||
            typeof payload.claimSessionId !== 'string' ||
            typeof payload.replyProofSecret !== 'string'
        ) {
            writeJson(res, 400, { error: 'missing_required_fields' });
            return;
        }

        const requestId = typeof payload.requestId === 'string' ? payload.requestId : crypto.randomUUID();
        payload.requestId = requestId;
        const recorded = hub.recordInbound(payload);
        if (recorded.duplicate) {
            writeJson(res, 202, { accepted: true, duplicate: true, requestId });
            return;
        }
        if (inFlight.has(requestId)) {
            writeJson(res, 202, { accepted: true, duplicate: true });
            return;
        }
        inFlight.add(requestId);
        writeJson(res, 202, { accepted: true, requestId });

        hub.markRunning(requestId);
        runRuntime(payload, cfg)
            .then(async (content) => {
                hub.markSucceeded(requestId, content, payload);
                outboxDrain.poke();
            })
            .catch(async (err) => {
                const safeError = cfg.runtimeSecurity.safeRuntimeFailureMessage(cfg.id, err);
                hub.markFailed(requestId, safeError, payload);
                console.error(`kovael-agent-inbox: ${cfg.id} dispatch failed: ${safeError}`);
                outboxDrain.poke();
            })
            .finally(() => {
                inFlight.delete(requestId);
            });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    return server;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.id) usageAndExit('--id is required');
    if (!args.provider) usageAndExit('--provider is required');
    if (!args.runtime) usageAndExit('--runtime is required');

    const cfg = {
        id: args.id,
        provider: args.provider,
        runtime: args.runtime,
        host: args.host || process.env.KOVAEL_HOST || 'http://127.0.0.1:8080',
        port: args.port ?? 0,
        cwd: args.cwd || process.cwd(),
        model: args.model,
        command: args.command,
        commandArgs: parseCommandArgsArg(args['command-args']),
        allowEnv: parseCsvArg(args['allow-env']),
        codexBin: args['codex-bin'],
        claudeBin: args['claude-bin'],
        timeoutMs: args.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS,
        replyTimeoutMs: readPositiveInt(process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS),
        replyRetryBaseMs: readPositiveInt(process.env.KOVAEL_CHAIR_REPLY_RETRY_BASE_MS, 100),
        outboxMaxAttempts: readPositiveInt(process.env.KOVAEL_AGENT_OUTBOX_MAX_ATTEMPTS, DEFAULT_OUTBOX_MAX_ATTEMPTS),
        outboxLeaseMs: readPositiveInt(process.env.KOVAEL_AGENT_OUTBOX_LEASE_MS, DEFAULT_OUTBOX_LEASE_MS),
        outboxDrainIntervalMs: readPositiveInt(process.env.KOVAEL_AGENT_OUTBOX_DRAIN_INTERVAL_MS, DEFAULT_OUTBOX_DRAIN_INTERVAL_MS),
        capabilities: args.capabilities,
        trust: args.trust,
        note: args.note,
        hubPath: args['hub-path'] || path.join(defaultAgentHubRoot(), safePathSegment(args.id), 'agent-hub.sqlite'),
        requireHubEncryption: hubEncryptionRequired(args),
    };
    if (cfg.requireHubEncryption && (!process.env[AGENT_HUB_SECRET_ENV] || process.env[AGENT_HUB_SECRET_ENV].trim().length < 32)) {
        throw new Error(`${AGENT_HUB_SECRET_ENV} must be at least 32 characters when hub encryption is required`);
    }
    cfg.runtimeSecurity = await loadRuntimeSecurity(cfg);
    const token = bearerToken(args);
    const hub = await createAgentHub(cfg);
    const outboxDrain = startOutboxDrain(hub, cfg);
    const server = await startInbox(cfg, hub, outboxDrain);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind inbox');
    const inboxUrl = `http://127.0.0.1:${address.port}/inbox`;

    const claimBody = {
        agentId: cfg.id,
        provider: cfg.provider,
        capabilities: cfg.capabilities,
        inboxUrl,
    };
    if (cfg.trust !== undefined) claimBody.trustTier = cfg.trust;
    if (cfg.note) claimBody.note = cfg.note;

    const claim = await postJson(cfg.host, '/api/v1/chairs/claim', claimBody, token);
    if (claim.status !== 200 || !claim.body?.sessionId) {
        throw new Error(`claim rejected HTTP ${claim.status}: ${JSON.stringify(claim.body)}`);
    }
    const { sessionId, heartbeatIntervalMs, ttlMs } = claim.body;
    console.error(`kovael-agent-inbox: ${cfg.id} claimed with inbox ${inboxUrl} (session=${sessionId.slice(0, 8)}, ttl=${ttlMs}ms)`);

    if (args.probe) {
        await postJson(cfg.host, '/api/v1/chairs/release', { agentId: cfg.id, sessionId }, token).catch(() => null);
        outboxDrain.stop();
        hub.close();
        server.close();
        return;
    }

    let stopping = false;
    const release = async (reason) => {
        if (stopping) return;
        stopping = true;
        try {
            await postJson(cfg.host, '/api/v1/chairs/release', { agentId: cfg.id, sessionId }, token);
            console.error(`kovael-agent-inbox: ${cfg.id} released (${reason})`);
        } catch (err) {
            console.error(`kovael-agent-inbox: ${cfg.id} release failed (${reason}): ${err.message}`);
        } finally {
            outboxDrain.stop();
            server.close(() => {
                hub.close();
                process.exit(0);
            });
        }
    };
    process.on('SIGINT', () => release('SIGINT'));
    process.on('SIGTERM', () => release('SIGTERM'));
    process.on('SIGHUP', () => release('SIGHUP'));

    const intervalMs = Math.max(1000, heartbeatIntervalMs || 7500);
    setInterval(async () => {
        try {
            const heartbeat = await postJson(cfg.host, '/api/v1/chairs/heartbeat', { agentId: cfg.id, sessionId }, token);
            if (heartbeat.status === 409) {
                console.error(`kovael-agent-inbox: ${cfg.id} session superseded`);
                process.exit(0);
            }
            if (heartbeat.status !== 200) {
                console.error(`kovael-agent-inbox: ${cfg.id} heartbeat HTTP ${heartbeat.status}: ${JSON.stringify(heartbeat.body)}`);
            }
        } catch (err) {
            console.error(`kovael-agent-inbox: ${cfg.id} heartbeat failed: ${err.message}`);
        }
    }, intervalMs);
}

main().catch((err) => {
    console.error(`kovael-agent-inbox: fatal: ${err.message}`);
    process.exit(1);
});

function readPositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

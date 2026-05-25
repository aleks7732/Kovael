import crypto from 'node:crypto';

export const AGENT_HUB_SECRET_ENV = 'KOVAEL_AGENT_HUB_SECRET';
export const AGENT_HUB_ENCRYPTION_ENV = 'KOVAEL_AGENT_HUB_ENCRYPTION';
export const REQUIRED_HUB_ENCRYPTION = 'required';

const PLATFORM_ENV_ALLOWLIST = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'SHELL',
    'COMSPEC',
] as const;

const PROXY_ENV_ALLOWLIST = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
] as const;

const RUNTIME_LOCATOR_ENV_ALLOWLIST = [
    'KOVAEL_CODEX_BIN',
    'KOVAEL_CLAUDE_BIN',
] as const;

export function isValidAgentHubSecret(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length >= 32;
}

export function isHubEncryptionRequired(env: NodeJS.ProcessEnv): boolean {
    return env[AGENT_HUB_ENCRYPTION_ENV]?.trim().toLowerCase() === REQUIRED_HUB_ENCRYPTION;
}

export function buildAgentAdapterEnv(
    source: NodeJS.ProcessEnv,
    options: { requireHubEncryption: boolean },
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    copyAllowlisted(source, env, PLATFORM_ENV_ALLOWLIST);
    copyAllowlisted(source, env, PROXY_ENV_ALLOWLIST);
    copyAllowlisted(source, env, RUNTIME_LOCATOR_ENV_ALLOWLIST);

    const token = source.KOVAEL_TOKEN ?? source.KOVAEL_API_TOKEN;
    if (token) env.KOVAEL_TOKEN = token;
    if (source.KOVAEL_CHAIR_DISPATCH_SECRET) {
        env.KOVAEL_CHAIR_DISPATCH_SECRET = source.KOVAEL_CHAIR_DISPATCH_SECRET;
    }
    if (source[AGENT_HUB_SECRET_ENV]) {
        env[AGENT_HUB_SECRET_ENV] = source[AGENT_HUB_SECRET_ENV];
    }
    if (options.requireHubEncryption) {
        env[AGENT_HUB_ENCRYPTION_ENV] = REQUIRED_HUB_ENCRYPTION;
    }
    return env;
}

export function buildAgentRuntimeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    copyAllowlisted(source, env, PLATFORM_ENV_ALLOWLIST);
    copyAllowlisted(source, env, PROXY_ENV_ALLOWLIST);
    return env;
}

export function redactSensitiveText(value: unknown): string {
    let text = value instanceof Error ? value.message : String(value ?? '');
    text = text.replace(/\b(KOVAEL_[A-Z0-9_]*\s*=\s*)[^\s"'`]+/gi, '$1[REDACTED]');
    text = text.replace(/\b(authorization:\s*bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]');
    text = text.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g, 'sk-[REDACTED]');
    text = text.replace(/\b[A-Fa-f0-9]{48,}\b/g, '[REDACTED_HEX]');
    text = text.replace(/\b[A-Za-z0-9+/_-]{64,}={0,2}\b/g, '[REDACTED_TOKEN]');
    return text.slice(0, 1_000);
}

export function safeRuntimeFailureMessage(agentId: string, err: unknown): string {
    const redacted = redactSensitiveText(err);
    const digest = crypto.createHash('sha256').update(redacted).digest('hex').slice(0, 12);
    return `Runtime error from ${agentId}: redacted failure ${digest}`;
}

function copyAllowlisted(
    source: NodeJS.ProcessEnv,
    target: NodeJS.ProcessEnv,
    names: readonly string[],
): void {
    for (const name of names) {
        if (source[name] !== undefined) {
            target[name] = source[name];
        }
    }
}

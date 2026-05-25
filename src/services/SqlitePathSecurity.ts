import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type SqlitePathSafetyCode = 'unsafe_agent_hub_dir';

export interface SqlitePathSafetyResult {
    ok: boolean;
    code?: SqlitePathSafetyCode;
    reason?: string;
}

const CLOUD_SYNC_SEGMENTS = [
    'onedrive',
    'dropbox',
    'google drive',
    'icloud drive',
    'icloudDrive',
];

export function defaultAgentHubDir(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'Kovael', 'agents');
    }
    const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'kovael', 'agents');
}

export function safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function validateLocalSqlitePath(dbPath: string): SqlitePathSafetyResult {
    if (dbPath === ':memory:') return { ok: true };
    if (isUncPath(dbPath)) {
        return {
            ok: false,
            code: 'unsafe_agent_hub_dir',
            reason: 'agent hub SQLite files must not live on UNC or network paths',
        };
    }
    const resolved = path.resolve(dbPath);
    if (isUncPath(resolved)) {
        return {
            ok: false,
            code: 'unsafe_agent_hub_dir',
            reason: 'agent hub SQLite files must not live on UNC or network paths',
        };
    }
    if (looksCloudSynced(resolved)) {
        return {
            ok: false,
            code: 'unsafe_agent_hub_dir',
            reason: 'agent hub SQLite files must not live under cloud-synced folders',
        };
    }
    return { ok: true };
}

export function prepareLocalSqliteFile(dbPath: string, label: string): void {
    const check = validateLocalSqlitePath(dbPath);
    if (!check.ok) {
        throw new Error(`${label} path is unsafe: ${check.reason}`);
    }
    if (dbPath === ':memory:') return;

    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodLocalPathBestEffort(dir, 0o700);
    const dirMode = fs.statSync(dir).mode & 0o777;
    if (process.platform !== 'win32' && dirMode !== 0o700) {
        throw new Error(`${label} parent dir ${dir} has mode 0o${dirMode.toString(8)}, expected 0o700`);
    }

    if (!fs.existsSync(dbPath)) {
        const fd = fs.openSync(dbPath, 'a', 0o600);
        fs.closeSync(fd);
    } else {
        chmodLocalPathBestEffort(dbPath, 0o600);
    }
    const fileMode = fs.statSync(dbPath).mode & 0o777;
    if (process.platform !== 'win32' && fileMode !== 0o600) {
        throw new Error(`${label} file ${dbPath} has mode 0o${fileMode.toString(8)}, expected 0o600`);
    }
}

function isUncPath(value: string): boolean {
    const normalized = value.replace(/\//g, '\\');
    return normalized.startsWith('\\\\');
}

function looksCloudSynced(value: string): boolean {
    const parts = value.toLowerCase().split(/[\\/]+/);
    return CLOUD_SYNC_SEGMENTS.some((segment) => parts.includes(segment.toLowerCase()));
}

export function chmodLocalPathBestEffort(
    target: string,
    mode: number,
    chmod: (path: string, mode: number) => void = fs.chmodSync,
): void {
    try {
        chmod(target, mode);
    } catch {
        // ACL-backed filesystems, especially on Windows, can reject POSIX chmod
        // even when the local path is otherwise safe. The mode checks below
        // still enforce permissions on platforms where mode bits are reliable.
    }
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PROTECTED_AGENT_DIRECTORY_NAME_LIST = [
    '.claude',
    '.gemini',
    '.codex',
    'secrets',
] as const;

const PROTECTED_AGENT_FILE_NAME_LIST = [
    'CLAUDE.local.md',
    'GEMINI.local.md',
    'AGENTS.local.md',
    '.env',
] as const;

const PROTECTED_AGENT_DIRECTORY_NAMES: ReadonlySet<string> = new Set(PROTECTED_AGENT_DIRECTORY_NAME_LIST);
const PROTECTED_AGENT_FILE_NAMES: ReadonlySet<string> = new Set(
    PROTECTED_AGENT_FILE_NAME_LIST.map((name) => name.toLowerCase()),
);

export interface ProtectedAgentPathPresence {
    present: boolean;
    entries: string[];
}

export interface ProtectedLocalConfigPathStatus {
    label: string;
    exists: boolean;
}

export function isProtectedAgentDirectoryName(name: string): boolean {
    return PROTECTED_AGENT_DIRECTORY_NAMES.has(name.toLowerCase());
}

export function isProtectedAgentFileName(name: string): boolean {
    const normalized = name.toLowerCase();
    return PROTECTED_AGENT_FILE_NAMES.has(normalized) || normalized.startsWith('.env.');
}

export function isProtectedAgentPath(candidatePath: string, rootPath = process.cwd()): boolean {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedCandidate = path.resolve(candidatePath);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    const segments = relative
        .split(path.sep)
        .filter((segment) => segment.length > 0 && segment !== '..')
        .map((segment) => segment.toLowerCase());

    if (segments.some((segment) => PROTECTED_AGENT_DIRECTORY_NAMES.has(segment))) {
        return true;
    }

    return isProtectedAgentFileName(path.basename(resolvedCandidate));
}

export function findProtectedAgentPathPresence(rootPath: string): ProtectedAgentPathPresence {
    const root = path.resolve(rootPath);
    const entries: string[] = [];

    for (const name of PROTECTED_AGENT_DIRECTORY_NAME_LIST) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) {
            entries.push(`${name}/`);
        }
    }

    for (const name of PROTECTED_AGENT_FILE_NAME_LIST) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) {
            entries.push(name);
        }
    }

    try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.toLowerCase().startsWith('.env.')) {
                entries.push(entry.name);
            }
        }
    } catch {
        return {
            present: entries.length > 0,
            entries: entries.sort(),
        };
    }

    return {
        present: entries.length > 0,
        entries: Array.from(new Set(entries)).sort(),
    };
}

export function inspectProtectedLocalConfigPaths(
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
): ProtectedLocalConfigPathStatus[] {
    const statuses: ProtectedLocalConfigPathStatus[] = [];
    const seen = new Set<string>();
    const add = (label: string, filePath: string): void => {
        const key = path.resolve(filePath).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        statuses.push({
            label,
            exists: pathExists(filePath),
        });
    };

    for (const name of PROTECTED_AGENT_DIRECTORY_NAME_LIST) {
        add(`workspace:${name}`, path.join(cwd, name));
    }
    for (const name of PROTECTED_AGENT_FILE_NAME_LIST) {
        add(`workspace:${name}`, path.join(cwd, name));
    }
    add('workspace:.env.*', path.join(cwd, '.env.*'));

    const homeDir = env.USERPROFILE || env.HOME || os.homedir();
    if (homeDir) {
        for (const name of ['.claude', '.gemini', '.codex']) {
            add(`home:${name}`, path.join(homeDir, name));
        }
    }

    if (env.APPDATA) {
        add('appdata:Claude', path.join(env.APPDATA, 'Claude'));
        add('appdata:Codex', path.join(env.APPDATA, 'Codex'));
    }

    return statuses;
}

function pathExists(filePath: string): boolean {
    if (filePath.endsWith(`${path.sep}.env.*`) || filePath.endsWith('/.env.*')) {
        const dir = path.dirname(filePath);
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .some((entry) => entry.isFile() && entry.name.toLowerCase().startsWith('.env.'));
        } catch {
            return false;
        }
    }

    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

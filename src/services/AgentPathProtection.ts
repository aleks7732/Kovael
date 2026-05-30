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

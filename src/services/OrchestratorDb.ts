import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Migrator, ORCHESTRATOR_MIGRATIONS } from './Migrator.js';

export const DEFAULT_DB_PATH = '.kovael/orchestrator.db';

export function resolveDbPath(override?: string): string {
    if (override && override.length > 0) return override;
    const envPath = process.env.KOVAEL_DB_PATH;
    if (envPath && envPath.length > 0) return envPath;
    return DEFAULT_DB_PATH;
}

export interface OpenOrchestratorDbOptions {
    /** Explicit path; overrides env var. Pass ':memory:' for tests. */
    path?: string;
}

export function openOrchestratorDb(opts: OpenOrchestratorDbOptions = {}): {
    db: DatabaseSync;
    path: string;
} {
    const resolved = resolveDbPath(opts.path);
    const isMemory = resolved === ':memory:';

    if (!isMemory) {
        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // mkdirSync only honors `mode` when the directory is freshly created;
        // an existing loose dir would silently retain its old perms. Chmod and
        // verify — secrets live in this dir, so a world-readable parent must
        // surface as a hard failure, not a swallowed best-effort warning.
        fs.chmodSync(dir, 0o700);
        const dirMode = fs.statSync(dir).mode & 0o777;
        if (dirMode !== 0o700) {
            throw new Error(`orchestrator db parent dir ${dir} has mode 0o${dirMode.toString(8)}, expected 0o700`);
        }

        if (!fs.existsSync(resolved)) {
            const fd = fs.openSync(resolved, 'a', 0o600);
            fs.closeSync(fd);
        } else {
            fs.chmodSync(resolved, 0o600);
        }
        const fileMode = fs.statSync(resolved).mode & 0o777;
        if (fileMode !== 0o600) {
            throw new Error(`orchestrator db file ${resolved} has mode 0o${fileMode.toString(8)}, expected 0o600`);
        }
    }

    const db = new DatabaseSync(resolved);

    if (!isMemory) {
        db.exec('PRAGMA journal_mode=WAL');
        db.exec('PRAGMA synchronous=NORMAL');
    }
    db.exec('PRAGMA foreign_keys=ON');

    new Migrator(db).apply(ORCHESTRATOR_MIGRATIONS);
    return { db, path: resolved };
}

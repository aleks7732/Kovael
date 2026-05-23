import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDbPath, openOrchestratorDb, DEFAULT_DB_PATH } from '../services/OrchestratorDb.js';

// -------------------------------------------------------------------------
// resolveDbPath
// -------------------------------------------------------------------------

describe('resolveDbPath', () => {
    const ORIG_ENV = process.env.KOVAEL_DB_PATH;

    afterEach(() => {
        // Restore env state after each test.
        if (ORIG_ENV === undefined) {
            delete process.env.KOVAEL_DB_PATH;
        } else {
            process.env.KOVAEL_DB_PATH = ORIG_ENV;
        }
    });

    it('returns the explicit override when provided', () => {
        process.env.KOVAEL_DB_PATH = '/env/value.db';
        expect(resolveDbPath('/explicit/override.db')).toBe('/explicit/override.db');
    });

    it('returns the env var when no explicit override', () => {
        process.env.KOVAEL_DB_PATH = '/from/env.db';
        expect(resolveDbPath()).toBe('/from/env.db');
    });

    it('returns DEFAULT_DB_PATH when override and env var are both absent', () => {
        delete process.env.KOVAEL_DB_PATH;
        expect(resolveDbPath()).toBe(DEFAULT_DB_PATH);
    });

    it('treats empty-string override as absent', () => {
        process.env.KOVAEL_DB_PATH = '/from/env.db';
        expect(resolveDbPath('')).toBe('/from/env.db');
    });

    it('treats empty-string env var as absent', () => {
        process.env.KOVAEL_DB_PATH = '';
        expect(resolveDbPath()).toBe(DEFAULT_DB_PATH);
    });
});

// -------------------------------------------------------------------------
// openOrchestratorDb — in-memory path (runs everywhere, no filesystem)
// -------------------------------------------------------------------------

describe('openOrchestratorDb — :memory:', () => {
    it('returns a DatabaseSync instance at path ":memory:"', () => {
        const { db, path: p } = openOrchestratorDb({ path: ':memory:' });
        expect(p).toBe(':memory:');
        expect(typeof db.exec).toBe('function');
        db.close();
    });

    it('runs all ORCHESTRATOR_MIGRATIONS so key tables exist', () => {
        const { db } = openOrchestratorDb({ path: ':memory:' });

        const tables = (
            db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
        ).map((r) => r.name);

        for (const t of ['conversation_topics', 'chair_claims', 'cycle_events', 'episodic_memories']) {
            expect(tables, `expected table ${t}`).toContain(t);
        }
        db.close();
    });

    it('enforces foreign keys (FK pragma is ON)', () => {
        const { db } = openOrchestratorDb({ path: ':memory:' });
        const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
        expect(row.foreign_keys).toBe(1);
        db.close();
    });

    it('is idempotent — opening twice does not throw or double-apply migrations', () => {
        const { db: a } = openOrchestratorDb({ path: ':memory:' });
        // A second in-memory db is always fresh — just ensure no throws.
        expect(() => openOrchestratorDb({ path: ':memory:' })).not.toThrow();
        a.close();
    });
});

// -------------------------------------------------------------------------
// openOrchestratorDb — file-backed (Unix permission enforcement skipped on Win)
// -------------------------------------------------------------------------

describe('openOrchestratorDb — file-backed', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-odb-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates the db file and parent directories', () => {
        const dbPath = path.join(tmpDir, 'subdir', 'orchestrator.db');
        const { db } = openOrchestratorDb({ path: dbPath });
        db.close();

        expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('WAL journal mode is set on file-backed db', () => {
        const dbPath = path.join(tmpDir, 'wal.db');
        const { db } = openOrchestratorDb({ path: dbPath });

        const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
        db.close();

        expect(row.journal_mode).toBe('wal');
    });

    it.skipIf(process.platform === 'win32')(
        'parent directory is created with mode 0o700',
        () => {
            const dbPath = path.join(tmpDir, 'secure', 'orchestrator.db');
            const { db } = openOrchestratorDb({ path: dbPath });
            db.close();

            const dirMode = fs.statSync(path.dirname(dbPath)).mode & 0o777;
            expect(dirMode).toBe(0o700);
        },
    );

    it.skipIf(process.platform === 'win32')(
        'db file is created with mode 0o600',
        () => {
            const dbPath = path.join(tmpDir, 'secure2', 'orchestrator.db');
            const { db } = openOrchestratorDb({ path: dbPath });
            db.close();

            const fileMode = fs.statSync(dbPath).mode & 0o777;
            expect(fileMode).toBe(0o600);
        },
    );

    it('opening an existing file-backed db re-applies migrations idempotently', () => {
        const dbPath = path.join(tmpDir, 'reopen.db');

        const first = openOrchestratorDb({ path: dbPath });
        const versionFirst = first.db
            .prepare('SELECT MAX(version) as v FROM schema_migrations')
            .get() as { v: number };
        first.db.close();

        const second = openOrchestratorDb({ path: dbPath });
        const versionSecond = second.db
            .prepare('SELECT MAX(version) as v FROM schema_migrations')
            .get() as { v: number };
        second.db.close();

        expect(versionFirst.v).toBe(versionSecond.v);
    });
});

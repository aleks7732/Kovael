import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Migrator, ORCHESTRATOR_MIGRATIONS } from '../services/Migrator.js';
import type { Migration } from '../services/Migrator.js';

// Helpers ------------------------------------------------------------------

function freshDb(): DatabaseSync {
    return new DatabaseSync(':memory:');
}

function tableExists(db: DatabaseSync, name: string): boolean {
    const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(name) as { name: string } | undefined;
    return row !== undefined;
}

// Fixtures -----------------------------------------------------------------

const mk = (version: number, name = `migration_${version}`): Migration => ({
    version,
    name,
    up: (db) => {
        db.exec(
            `CREATE TABLE IF NOT EXISTS test_${version} (id INTEGER PRIMARY KEY) STRICT`,
        );
    },
});

const failing: Migration = {
    version: 99,
    name: 'always_fails',
    up: () => {
        throw new Error('intentional failure');
    },
};

// Tests --------------------------------------------------------------------

describe('Migrator', () => {
    let db: DatabaseSync;
    let migrator: Migrator;

    beforeEach(() => {
        db = freshDb();
        migrator = new Migrator(db);
    });

    afterEach(() => {
        db.close();
    });

    it('creates the schema_migrations tracking table on first apply()', () => {
        migrator.apply([]);
        expect(tableExists(db, 'schema_migrations')).toBe(true);
    });

    it('applies a single migration and records it', () => {
        const { applied, skipped } = migrator.apply([mk(1)]);

        expect(applied).toEqual([1]);
        expect(skipped).toEqual([]);
        expect(tableExists(db, 'test_1')).toBe(true);
        expect(migrator.currentVersion()).toBe(1);
    });

    it('applies migrations in ascending version order regardless of input order', () => {
        const order: number[] = [];
        const migrations: Migration[] = [3, 1, 2].map((v) => ({
            version: v,
            name: `m${v}`,
            up: (db) => {
                order.push(v);
                db.exec(
                    `CREATE TABLE IF NOT EXISTS ordered_${v} (id INTEGER PRIMARY KEY) STRICT`,
                );
            },
        }));

        migrator.apply(migrations);

        expect(order).toEqual([1, 2, 3]);
    });

    it('skips already-applied migrations on subsequent runs', () => {
        migrator.apply([mk(1), mk(2)]);

        const second = new Migrator(db);
        const { applied, skipped } = second.apply([mk(1), mk(2), mk(3)]);

        expect(applied).toEqual([3]);
        expect(skipped).toEqual([1, 2]);
    });

    it('throws and rolls back on a failing migration', () => {
        expect(() => migrator.apply([failing])).toThrow(
            /migration 99 "always_fails" failed/,
        );
        // Table must NOT exist — rollback worked
        expect(tableExists(db, 'schema_migrations')).toBe(true); // tracking table was committed before
        const row = db
            .prepare('SELECT version FROM schema_migrations WHERE version = 99')
            .get();
        expect(row).toBeUndefined();
    });

    it('throws on duplicate version numbers within a single batch', () => {
        expect(() => migrator.apply([mk(1), mk(1)])).toThrow(
            /duplicate migration version 1/,
        );
    });

    it('currentVersion() returns 0 when no migrations have run', () => {
        expect(migrator.currentVersion()).toBe(0);
    });

    it('currentVersion() returns the highest applied version', () => {
        migrator.apply([mk(1), mk(3), mk(2)]);
        expect(migrator.currentVersion()).toBe(3);
    });

    it('currentVersion() returns 0 when schema_migrations table is absent', () => {
        // A brand-new db with no table at all
        const bare = freshDb();
        const m = new Migrator(bare);
        expect(m.currentVersion()).toBe(0);
        bare.close();
    });

    it('is idempotent — calling apply() twice with the same list is safe', () => {
        migrator.apply([mk(1), mk(2)]);
        const { applied, skipped } = migrator.apply([mk(1), mk(2)]);

        expect(applied).toEqual([]);
        expect(skipped).toEqual([1, 2]);
    });
});

describe('ORCHESTRATOR_MIGRATIONS', () => {
    it('applies all built-in migrations to a fresh :memory: db without error', () => {
        const db = freshDb();
        const migrator = new Migrator(db);

        let result: { applied: number[]; skipped: number[] };
        expect(() => {
            result = migrator.apply(ORCHESTRATOR_MIGRATIONS);
        }).not.toThrow();

        // All versions applied in order
        expect(result!.applied).toEqual(
            [...ORCHESTRATOR_MIGRATIONS].sort((a, b) => a.version - b.version).map((m) => m.version),
        );
        expect(result!.skipped).toHaveLength(0);

        // Key tables created by the migrations must exist
        for (const table of [
            'conversation_topics',
            'conversation_messages',
            'chair_claims',
            'cycle_events',
            'episodic_memories',
        ]) {
            expect(tableExists(db, table), `table ${table} should exist`).toBe(true);
        }

        db.close();
    });

    it('versions are monotonically increasing with no duplicates', () => {
        const versions = ORCHESTRATOR_MIGRATIONS.map((m) => m.version);
        const sorted = [...versions].sort((a, b) => a - b);
        expect(versions).toEqual(sorted);
        expect(new Set(versions).size).toBe(versions.length);
    });
});

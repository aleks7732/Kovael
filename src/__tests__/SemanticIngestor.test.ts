import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SemanticIngestor } from '../services/SemanticIngestor.js';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function freshDb(): DatabaseSync {
    return new DatabaseSync(':memory:');
}

function countRows(db: DatabaseSync): number {
    const row = db
        .prepare('SELECT COUNT(*) as n FROM semantic_anchors')
        .get() as { n: number };
    return row.n;
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('SemanticIngestor — initialization', () => {
    it('creates the semantic_anchors table on construction', () => {
        const db = freshDb();
        new SemanticIngestor(db);

        const row = db
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_anchors'`)
            .get() as { name: string } | undefined;

        expect(row?.name).toBe('semantic_anchors');
        db.close();
    });

    it('is idempotent — constructing a second ingestor on the same DB does not throw', () => {
        const db = freshDb();
        expect(() => {
            new SemanticIngestor(db);
            new SemanticIngestor(db);
        }).not.toThrow();
        db.close();
    });
});

describe('SemanticIngestor — ingest()', () => {
    let tmpDir: string;
    let db: DatabaseSync;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-ingest-'));
        db = freshDb();
    });

    afterEach(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('indexes .md files in the target directory', async () => {
        fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello mesh');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        expect(countRows(db)).toBe(1);
    });

    it('indexes .ts and .json files in addition to .md', async () => {
        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const x = 1;');
        fs.writeFileSync(path.join(tmpDir, 'config.json'), '{"key":"value"}');
        fs.writeFileSync(path.join(tmpDir, 'notes.md'), '# notes');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        expect(countRows(db)).toBe(3);
    });

    it('skips files with unsupported extensions', async () => {
        fs.writeFileSync(path.join(tmpDir, 'image.png'), 'not-real-png');
        fs.writeFileSync(path.join(tmpDir, 'data.csv'), 'a,b,c');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        expect(countRows(db)).toBe(0);
    });

    it('skips node_modules directories', async () => {
        const nmDir = path.join(tmpDir, 'node_modules', 'some-pkg');
        fs.mkdirSync(nmDir, { recursive: true });
        fs.writeFileSync(path.join(nmDir, 'index.ts'), 'export {}');
        fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const a = 1;');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        // Only app.ts should be indexed — node_modules is skipped
        expect(countRows(db)).toBe(1);
    });

    it('skips .git directories', async () => {
        const gitDir = path.join(tmpDir, '.git');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        expect(countRows(db)).toBe(0);
    });

    it('does not throw when the target directory does not exist', async () => {
        const ingestor = new SemanticIngestor(db);
        const nonExistent = path.join(tmpDir, 'does-not-exist');
        await expect(ingestor.ingest(nonExistent)).resolves.not.toThrow();
    });

    it('stores only relative paths (not absolute) in the database', async () => {
        fs.writeFileSync(path.join(tmpDir, 'check.md'), '# check');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        const row = db
            .prepare('SELECT file_path FROM semantic_anchors LIMIT 1')
            .get() as { file_path: string };

        // Path must start with './' not with an absolute drive/root letter
        expect(row.file_path).toMatch(/^\.\//);
    });

    it('recursively indexes files in subdirectories', async () => {
        const sub = path.join(tmpDir, 'docs', 'api');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, 'overview.md'), '# API overview');
        const ingestor = new SemanticIngestor(db);

        await ingestor.ingest(tmpDir);

        expect(countRows(db)).toBe(1);
    });
});

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SemanticIngestor: Recursive crawler for indexing project knowledge.
 * Reads .md, .json, and .ts files into the orchestrator's memory.
 */
export class SemanticIngestor {
    constructor(private db: DatabaseSync) {
        this.initializeTable();
    }

    private initializeTable() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS semantic_anchors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT,
                content TEXT,
                extension TEXT,
                last_indexed INTEGER
            ) STRICT
        `);
    }

    /**
     * Ingests files from the specified root directory.
     */
    public async ingest(rootPath: string) {
        const sanitizedRoot = this.sanitizePath(rootPath);
        console.log(`[SemanticIngestor] Starting ingest from: ${sanitizedRoot}`);
        
        try {
            this.crawl(rootPath);
            console.log(`[SemanticIngestor] Ingest complete.`);
        } catch (error: any) {
            console.error(`[SemanticIngestor] Ingest failed: ${error.message}`);
        }
    }

    /**
     * Directories the crawler MUST NOT enter. These either explode the
     * indexed corpus (node_modules) or contain PII / agent internals that
     * must not bleed into runtime memory (.notes is the local agent plan;
     * .kovael is the per-cycle workspace; .tsupgrader holds tooling KB).
     */
    private static readonly SKIP_DIRS: ReadonlySet<string> = new Set([
        'node_modules', '.git', 'dist', '.notes', '.kovael', '.tsupgrader',
        '.next', 'build', 'coverage',
    ]);

    private crawl(dir: string) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (SemanticIngestor.SKIP_DIRS.has(entry.name)) continue;
                this.crawl(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (['.md', '.json', '.ts'].includes(ext)) {
                    this.indexFile(fullPath, ext);
                }
            }
        }
    }

    private indexFile(filePath: string, ext: string) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const sanitizedPath = this.sanitizePath(filePath);
            
            const stmt = this.db.prepare(`
                INSERT INTO semantic_anchors (file_path, content, extension, last_indexed)
                VALUES (?, ?, ?, ?)
            `);
            
            stmt.run(sanitizedPath, content, ext, Date.now());
            console.log(`[SemanticIngestor] Indexed: ${sanitizedPath}`);
        } catch (error: any) {
            // Silently fail for individual files to keep the crawl moving, but log sanitized error
            console.error(`[SemanticIngestor] Failed to index ${this.sanitizePath(filePath)}: ${error.message}`);
        }
    }

    /**
     * Sanitizes absolute paths to relative ones to protect system privacy in logs and DB.
     * Uses path.relative() from process.cwd() so the result is portable regardless of
     * the parent directory name.
     */
    private sanitizePath(filePath: string): string {
        const rel = path.relative(process.cwd(), filePath);
        if (rel && !rel.startsWith('..')) {
            return './' + rel.replace(/\\/g, '/');
        }
        return path.basename(filePath);
    }
}

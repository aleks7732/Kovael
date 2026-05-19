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

    private crawl(dir: string) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                // Skip common large/irrelevant directories
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
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
     */
    private sanitizePath(filePath: string): string {
        // Find 'VantagePoint' in the path to create a clean relative root
        const vpMarker = 'VantagePoint';
        const vpIndex = filePath.indexOf(vpMarker);
        
        if (vpIndex !== -1) {
            // Return path starting from VantagePoint
            return './' + filePath.substring(vpIndex + vpMarker.length).replace(/\\/g, '/').replace(/^\//, '');
        }
        
        // Fallback: use basename or a simple replacement if marker not found
        return path.basename(filePath);
    }
}

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LearningMatrixEntry {
    cycleId: string;
    taskHash: string;
    status: 'verified' | 'failed';
    latencyMs: number;
    tokenTotal: number;
    confidence: number;
    retryCount: number;
    recipeIds: string[];
    timestamp: number;
}

export interface LearningMatrixFile {
    version: 1;
    entries: LearningMatrixEntry[];
}

export class LearningMatrix {
    constructor(
        private readonly filePath = path.resolve(process.cwd(), '.kovael/learning_matrix.json'),
        private readonly maxEntries = 1000,
    ) {}

    public record(entry: LearningMatrixEntry): LearningMatrixFile {
        const current = this.read();
        const sanitized = sanitizeEntry(entry);
        const entries = [sanitized, ...current.entries].slice(0, this.maxEntries);
        const next: LearningMatrixFile = { version: 1, entries };
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
            fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch {
            return current;
        }
        return next;
    }

    public read(): LearningMatrixFile {
        try {
            if (!fs.existsSync(this.filePath)) return { version: 1, entries: [] };
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<LearningMatrixFile>;
            if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
            return {
                version: 1,
                entries: parsed.entries.map(sanitizeEntry).slice(0, this.maxEntries),
            };
        } catch {
            return { version: 1, entries: [] };
        }
    }

    public stats(): { path: string; entries: number; latestAt: number | null } {
        const file = this.read();
        return {
            path: this.filePath,
            entries: file.entries.length,
            latestAt: file.entries[0]?.timestamp ?? null,
        };
    }
}

function sanitizeEntry(entry: LearningMatrixEntry): LearningMatrixEntry {
    return {
        cycleId: String(entry.cycleId).slice(0, 128),
        taskHash: String(entry.taskHash).slice(0, 128),
        status: entry.status === 'verified' ? 'verified' : 'failed',
        latencyMs: safeInt(entry.latencyMs, 0, 86_400_000),
        tokenTotal: safeInt(entry.tokenTotal, 0, 50_000_000),
        confidence: safeFloat(entry.confidence, 0, 1),
        retryCount: safeInt(entry.retryCount, 0, 100),
        recipeIds: Array.isArray(entry.recipeIds)
            ? entry.recipeIds.map((id) => String(id).replace(/[\r\n\t]/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 16)
            : [],
        timestamp: safeInt(entry.timestamp, 0, Number.MAX_SAFE_INTEGER),
    };
}

function safeInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}

function safeFloat(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

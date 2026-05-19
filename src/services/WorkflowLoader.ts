import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

export interface WorkflowFrontMatter {
    version: number;
    tracker?: { source?: string; poll_interval_ms?: number };
    workspace?: { root?: string; hooks?: { timeout_ms?: number } };
    routing?: {
        vram_floor_mb?: number;
        fallback_agent?: string;
        primary_architect?: string;
        operator?: string;
        verifier?: string;
    };
    sharding?: { keep_recent_turns?: number; pin_system_prompt?: boolean; pin_anx_manifest?: boolean };
    retry?: { max_attempts?: number; backoff_base_ms?: number; backoff_factor?: number };
    observability?: { snapshot_endpoint?: string; emit_phase_events?: boolean; log_context_fields?: string[] };
}

export interface WorkflowDocument {
    frontMatter: WorkflowFrontMatter;
    promptTemplate: string;
    loadedAt: number;
    sourcePath: string;
}

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

/**
 * WorkflowLoader — Symphony SPEC §5 (Apache-2.0,
 * github.com/openai/symphony).
 *
 * Loads WORKFLOW.md (front matter + Jinja-like body) and emits a typed
 * config + prompt template. Watches the file for changes and reloads
 * without orchestrator restart per §5 "Dynamic reload is REQUIRED".
 * When a reload fails validation, the LAST KNOWN GOOD config is kept
 * and the operator gets a structured error event.
 *
 * The YAML front matter is parsed by a minimal in-house parser to avoid
 * pulling a dependency for a fixed-shape document. It supports the
 * subset Kovael uses today: scalars, integers, booleans, nested maps,
 * single-line lists, and # comments. Anything richer (e.g. flow-style
 * lists, anchors) is intentionally rejected — keep the contract tight.
 */
export class WorkflowLoader extends EventEmitter {
    private current: WorkflowDocument | null = null;
    private lastError: string | null = null;
    private watching: boolean = false;
    private readonly sourcePath: string;
    private reloadDebounce: NodeJS.Timeout | null = null;

    constructor(sourcePath: string = path.resolve(process.cwd(), 'WORKFLOW.md')) {
        super();
        this.sourcePath = sourcePath;
    }

    public start(): void {
        this.reload();
        if (!this.watching) {
            try {
                fs.watchFile(this.sourcePath, { interval: 1000 }, () => this.scheduleReload());
                this.watching = true;
            } catch (err) {
                console.warn(`[WorkflowLoader] fs.watchFile failed (${(err as Error).message}); hot reload disabled.`);
            }
        }
    }

    public stop(): void {
        if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
        this.reloadDebounce = null;
        if (this.watching) {
            try {
                fs.unwatchFile(this.sourcePath);
            } catch (err) {
                console.warn(`[WorkflowLoader] fs.unwatchFile failed (${(err as Error).message}).`);
            }
            this.watching = false;
        }
    }

    public document(): WorkflowDocument | null { return this.current; }

    public lastErrorMessage(): string | null { return this.lastError; }

    private scheduleReload(): void {
        if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
        this.reloadDebounce = setTimeout(() => this.reload(), 150);
    }

    private reload(): void {
        try {
            const raw = fs.readFileSync(this.sourcePath, 'utf-8');
            const m = FRONT_MATTER_RE.exec(raw);
            if (!m) throw new Error('No front matter delimited by --- found');
            const front = this.parseYamlSubset(m[1]);
            this.assertFrontMatter(front);
            const next: WorkflowDocument = {
                frontMatter: front,
                promptTemplate: m[2].trim(),
                loadedAt: Date.now(),
                sourcePath: this.sourcePath,
            };
            const isFirst = this.current === null;
            this.current = next;
            this.lastError = null;
            this.emit('workflow_loaded', { document: next, firstLoad: isFirst });
        } catch (err) {
            const msg = (err as Error).message;
            this.lastError = msg;
            console.warn(`[WorkflowLoader] reload failed: ${msg}; keeping last known good.`);
            this.emit('workflow_error', { error: msg, keptKnownGood: this.current !== null });
        }
    }

    private assertFrontMatter(f: any): asserts f is WorkflowFrontMatter {
        if (typeof f !== 'object' || f === null) throw new Error('Front matter must be a mapping');
        if (typeof f.version !== 'number') throw new Error('Front matter requires numeric `version`');
        if (f.version < 1) throw new Error(`Unsupported front-matter version ${f.version}`);
    }

    /**
     * Minimal YAML subset parser. Supports nested maps (2-space indent),
     * scalars, integers, booleans, single-line `[a, b]` lists, multi-line
     * `- item` lists, and `# comments`. Strings may be bare or single-quoted.
     */
    private parseYamlSubset(src: string): any {
        // Normalise CRLF → LF so the parser works on both Windows-authored and
        // Unix-authored WORKFLOW.md files without \r contaminating keys/values.
        const lines = src.replace(/\r/g, '').split('\n');
        const stack: Array<{ indent: number; obj: any; key?: string }> = [{ indent: -1, obj: {} }];
        let pendingList: { indent: number; arr: any[] } | null = null;

        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const raw = lines[lineNo];
            const stripped = raw.replace(/\s+#.*$/, '');
            // Skip blank lines and standalone comment lines (e.g. "# Title").
            // In YAML, `#` introduces a comment only when preceded by whitespace
            // or at the start of the line.
            if (!stripped.trim() || stripped.trim().startsWith('#')) continue;

            const indent = stripped.match(/^( *)/)?.[1].length ?? 0;
            const content = stripped.slice(indent);

            // Multi-line list item
            if (content.startsWith('- ')) {
                const value = this.parseScalar(content.slice(2).trim());
                if (!pendingList || pendingList.indent !== indent) {
                    throw new Error(`Unexpected list item at line ${lineNo + 1}`);
                }
                pendingList.arr.push(value);
                continue;
            }
            pendingList = null;

            // Pop stack to current indent
            while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
                stack.pop();
            }
            const parent = stack[stack.length - 1];
            if (!parent) throw new Error(`Indent stack underflow at line ${lineNo + 1}`);

            const colon = content.indexOf(':');
            if (colon === -1) throw new Error(`Expected key: value at line ${lineNo + 1} (${content})`);
            const key = content.slice(0, colon).trim();
            const rest = content.slice(colon + 1).trim();

            if (rest === '') {
                // Either map-start or list-start (decided by next line)
                const child = {};
                parent.obj[key] = child;
                stack.push({ indent, obj: child });
                const nextNonBlank = this.peekNext(lines, lineNo + 1);
                if (nextNonBlank && /^\s*- /.test(nextNonBlank)) {
                    const arr: any[] = [];
                    parent.obj[key] = arr;
                    stack.pop();
                    pendingList = { indent: nextNonBlank.match(/^( *)/)![1].length, arr };
                }
                continue;
            }

            if (rest.startsWith('[') && rest.endsWith(']')) {
                parent.obj[key] = rest.slice(1, -1).split(',').map(s => this.parseScalar(s.trim())).filter(v => v !== '');
                continue;
            }

            parent.obj[key] = this.parseScalar(rest);
        }

        return stack[0].obj;
    }

    private peekNext(lines: string[], from: number): string | null {
        for (let i = from; i < lines.length; i++) {
            if (lines[i].replace(/\s+#.*$/, '').trim()) return lines[i];
        }
        return null;
    }

    private parseScalar(s: string): any {
        if (s === '' || s === '~' || s === 'null') return null;
        if (s === 'true') return true;
        if (s === 'false') return false;
        if (/^-?\d+$/.test(s)) return parseInt(s, 10);
        if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
            return s.slice(1, -1);
        }
        return s;
    }
}

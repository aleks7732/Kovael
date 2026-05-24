import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Logger, rootLogger } from './Logger.js';

export interface PersonaVoice {
    pronouns: string;
    register: string;
    catchphrases: string[];
    forbidden: string[];
}

export interface PersonaExpertise {
    primary: string[];
    secondary: string[];
}

export interface PersonaDisposition {
    ally_with: string[];
    spar_with: string[];
    defer_to: string[];
}

export interface PersonaFrontMatter {
    agent_id: string;
    display_name: string;
    provider: string;
    voice: PersonaVoice;
    expertise: PersonaExpertise;
    disposition: PersonaDisposition;
}

export interface PersonaDocument {
    frontMatter: PersonaFrontMatter;
    lore: string;
    loadedAt: number;
    sourcePath: string;
}

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export class PersonaLoader extends EventEmitter {
    private readonly log: Logger = rootLogger;
    private cache: Map<string, PersonaDocument> = new Map();
    private directoryPath: string;
    private watcher: fs.FSWatcher | null = null;
    private reloadDebounce: Map<string, NodeJS.Timeout> = new Map();

    constructor(directoryPath: string = path.resolve(process.cwd(), 'personas')) {
        super();
        this.directoryPath = directoryPath;
    }

    public start(): void {
        this.loadAll();
        this.startWatching();
    }

    public stop(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        for (const timeout of this.reloadDebounce.values()) {
            clearTimeout(timeout);
        }
        this.reloadDebounce.clear();
    }

    public getPersona(agentId: string): PersonaDocument | null {
        return this.cache.get(agentId) || null;
    }

    public getAllPersonas(): PersonaDocument[] {
        return Array.from(this.cache.values());
    }

    public compileSystemPrompt(agentId: string): string {
        const doc = this.getPersona(agentId);
        if (!doc) {
            return 'You are Nyx, the Sovereign Intelligence.';
        }
        const { display_name, provider, voice, expertise, disposition } = doc.frontMatter;
        return `You are ${display_name}, a ${voice.register} agent running on ${provider}.

Your voice guidelines:
- Pronouns: ${voice.pronouns}
- Catchphrases to use naturally: ${voice.catchphrases.map(c => `"${c}"`).join(', ')}
- FORBIDDEN PHRASING (never say these): ${voice.forbidden.map(f => `"${f}"`).join(', ')}

Your expertise:
- Primary: ${expertise.primary.join(', ')}
- Secondary: ${expertise.secondary.join(', ')}

Your disposition in the mesh:
- Allies: ${disposition.ally_with.join(', ')}
- Spars with: ${disposition.spar_with.join(', ')}
- Defer to: ${disposition.defer_to.join(', ')}

## Lore
${doc.lore}`;
    }

    private loadAll(): void {
        try {
            if (!fs.existsSync(this.directoryPath)) {
                fs.mkdirSync(this.directoryPath, { recursive: true });
            }
            const files = fs.readdirSync(this.directoryPath);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    this.loadFile(path.join(this.directoryPath, file));
                }
            }
        } catch (err) {
            this.log.error('load_all_failed', { error: (err as Error).message });
        }
    }

    private loadFile(filePath: string): void {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const m = FRONT_MATTER_RE.exec(raw);
            if (!m) {
                throw new Error(`No front matter delimited by --- found in ${path.basename(filePath)}`);
            }
            const front = this.parseYamlSubset(m[1]);
            this.assertFrontMatter(front);
            const doc: PersonaDocument = {
                frontMatter: front,
                lore: m[2].trim(),
                loadedAt: Date.now(),
                sourcePath: filePath,
            };
            this.cache.set(front.agent_id, doc);
            this.emit('persona_loaded', { agentId: front.agent_id, document: doc });
        } catch (err) {
            const msg = (err as Error).message;
            this.log.warn('file_load_failed', { file: path.basename(filePath), error: msg });
            this.emit('persona_error', { filePath, error: msg });
        }
    }

    private startWatching(): void {
        if (this.watcher) return;
        try {
            this.watcher = fs.watch(this.directoryPath, (eventType, filename) => {
                if (filename && filename.endsWith('.md')) {
                    const filePath = path.join(this.directoryPath, filename);
                    const debounceKey = filePath;
                    if (this.reloadDebounce.has(debounceKey)) {
                        clearTimeout(this.reloadDebounce.get(debounceKey));
                    }
                    this.reloadDebounce.set(debounceKey, setTimeout(() => {
                        this.reloadDebounce.delete(debounceKey);
                        if (fs.existsSync(filePath)) {
                            this.loadFile(filePath);
                        } else {
                            // File was deleted
                            for (const [agentId, doc] of this.cache.entries()) {
                                if (doc.sourcePath === filePath) {
                                    this.cache.delete(agentId);
                                    this.emit('persona_deleted', { agentId, filePath });
                                }
                            }
                        }
                    }, 150));
                }
            });
        } catch (err) {
            this.log.warn('hot_reload_disabled', { error: (err as Error).message });
        }
    }

    private assertFrontMatter(f: any): asserts f is PersonaFrontMatter {
        if (typeof f !== 'object' || f === null) throw new Error('Front matter must be a mapping');
        if (typeof f.agent_id !== 'string') throw new Error('Front matter requires string `agent_id`');
        if (typeof f.display_name !== 'string') throw new Error('Front matter requires string `display_name`');
        if (typeof f.provider !== 'string') throw new Error('Front matter requires string `provider`');
        
        if (typeof f.voice !== 'object' || f.voice === null) throw new Error('Front matter requires `voice` mapping');
        if (typeof f.voice.pronouns !== 'string') throw new Error('`voice.pronouns` must be a string');
        if (typeof f.voice.register !== 'string') throw new Error('`voice.register` must be a string');
        if (!Array.isArray(f.voice.catchphrases)) throw new Error('`voice.catchphrases` must be an array');
        if (!Array.isArray(f.voice.forbidden)) throw new Error('`voice.forbidden` must be an array');

        if (typeof f.expertise !== 'object' || f.expertise === null) throw new Error('Front matter requires `expertise` mapping');
        if (!Array.isArray(f.expertise.primary)) throw new Error('`expertise.primary` must be an array');
        if (!Array.isArray(f.expertise.secondary)) throw new Error('`expertise.secondary` must be an array');

        if (typeof f.disposition !== 'object' || f.disposition === null) throw new Error('Front matter requires `disposition` mapping');
        if (!Array.isArray(f.disposition.ally_with)) throw new Error('`disposition.ally_with` must be an array');
        if (!Array.isArray(f.disposition.spar_with)) throw new Error('`disposition.spar_with` must be an array');
        if (!Array.isArray(f.disposition.defer_to)) throw new Error('`disposition.defer_to` must be an array');
    }

    private parseYamlSubset(src: string): any {
        const lines = src.replace(/\r/g, '').split('\n');
        const stack: Array<{ indent: number; obj: any; key?: string }> = [{ indent: -1, obj: {} }];
        let pendingList: { indent: number; arr: any[] } | null = null;

        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const raw = lines[lineNo];
            const stripped = raw.replace(/\s+#.*$/, '');
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

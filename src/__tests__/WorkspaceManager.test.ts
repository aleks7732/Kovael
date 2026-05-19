import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceManager, WorkspaceError } from '../services/WorkspaceManager.js';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-ws-test-'));
}

describe('WorkspaceManager', () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const r of roots) {
            try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        roots.length = 0;
    });

    it('acquire creates the per-cycle directory and returns its absolute path', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root });
        const p = wm.acquire('cycle-abc123');
        expect(fs.existsSync(p)).toBe(true);
        expect(p).toBe(path.join(root, 'cycle-abc123'));
        expect(wm.activeCount()).toBe(1);
    });

    it('acquire rejects unsafe cycle ids (path traversal)', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root });
        expect(() => wm.acquire('../evil')).toThrow(WorkspaceError);
        expect(() => wm.acquire('cycle/../evil')).toThrow(WorkspaceError);
    });

    it('validateCwd accepts a path that is inside the workspace', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root });
        const ws = wm.acquire('safe-cycle');
        const sub = path.join(ws, 'subdir');
        fs.mkdirSync(sub, { recursive: true });
        // Should not throw
        expect(() => wm.validateCwd('safe-cycle', sub)).not.toThrow();
    });

    it('validateCwd rejects a path escaping the workspace (.. traversal)', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root });
        wm.acquire('escape-cycle');
        // Escape via ..
        expect(() => wm.validateCwd('escape-cycle', path.join(root, '..', 'etc'))).toThrow(WorkspaceError);
    });

    it('validateCwd throws no_workspace when cycle has no active workspace', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root });
        expect(() => wm.validateCwd('ghost-cycle', root)).toThrow(WorkspaceError);
    });

    it('release removes the dir when cleanupOnRelease=true', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root, cleanupOnRelease: true });
        const ws = wm.acquire('cleanup-cycle');
        expect(fs.existsSync(ws)).toBe(true);
        wm.release('cleanup-cycle');
        expect(fs.existsSync(ws)).toBe(false);
        expect(wm.activeCount()).toBe(0);
    });

    it('release does nothing when cycle id is unknown', () => {
        const root = tmpRoot();
        roots.push(root);
        const wm = new WorkspaceManager({ root });
        // Must not throw
        expect(() => wm.release('no-such-cycle')).not.toThrow();
    });
});

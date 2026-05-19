import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { WorkflowLoader } from '../services/WorkflowLoader.js';

const REPO_WORKFLOW = path.resolve(process.cwd(), 'WORKFLOW.md');

describe('WorkflowLoader', () => {
    it('parses the real WORKFLOW.md in repo root', () => {
        const loader = new WorkflowLoader(REPO_WORKFLOW);
        loader.start();
        const doc = loader.document();
        loader.stop();

        expect(doc).not.toBeNull();
        expect(doc!.frontMatter.version).toBe(2);
        expect(doc!.frontMatter.routing?.vram_floor_mb).toBe(8192);
        expect(doc!.promptTemplate.length).toBeGreaterThan(0);
    });

    it('last-known-good config is preserved when reload encounters invalid YAML', () => {
        // Create a temp file with valid YAML first
        const tmp = path.join(os.tmpdir(), `kovael-wf-${Date.now()}.md`);
        const validContent = `---\nversion: 1\n---\n\nHello\n`;
        fs.writeFileSync(tmp, validContent, 'utf-8');

        const loader = new WorkflowLoader(tmp);
        loader.start();
        expect(loader.document()).not.toBeNull();
        const firstVersion = loader.document()!.frontMatter.version;

        // Overwrite with invalid content and force reload via internal method
        fs.writeFileSync(tmp, `---\nnot_yaml_at_all\n---\n\nBody\n`, 'utf-8');
        (loader as any).reload(); // trigger reload on corrupted file

        // Known-good must survive
        expect(loader.document()).not.toBeNull();
        expect(loader.document()!.frontMatter.version).toBe(firstVersion);
        expect(loader.lastErrorMessage()).not.toBeNull();

        loader.stop();
        fs.unlinkSync(tmp);
    });

    it('emits workflow_loaded event on successful parse', () => {
        const tmp = path.join(os.tmpdir(), `kovael-wf2-${Date.now()}.md`);
        fs.writeFileSync(tmp, `---\nversion: 2\n---\n\nBody\n`, 'utf-8');

        const events: any[] = [];
        const loader = new WorkflowLoader(tmp);
        loader.on('workflow_loaded', e => events.push(e));
        loader.start();
        loader.stop();
        fs.unlinkSync(tmp);

        expect(events).toHaveLength(1);
        expect(events[0].document.frontMatter.version).toBe(2);
        expect(events[0].firstLoad).toBe(true);
    });

    it('emits workflow_error when front matter is absent', () => {
        const tmp = path.join(os.tmpdir(), `kovael-wf3-${Date.now()}.md`);
        fs.writeFileSync(tmp, `No front matter here at all`, 'utf-8');

        const errors: any[] = [];
        const loader = new WorkflowLoader(tmp);
        loader.on('workflow_error', e => errors.push(e));
        loader.start();
        loader.stop();
        fs.unlinkSync(tmp);

        expect(errors).toHaveLength(1);
        expect(errors[0].keptKnownGood).toBe(false); // no prior good config
    });
});

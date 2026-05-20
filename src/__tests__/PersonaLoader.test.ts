import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PersonaLoader } from '../services/PersonaLoader.js';

describe('PersonaLoader', () => {
    it('parses real persona profiles in the personas directory', () => {
        const personasDir = path.resolve(process.cwd(), 'personas');
        const loader = new PersonaLoader(personasDir);
        loader.start();
        const personas = loader.getAllPersonas();
        loader.stop();

        expect(personas.length).toBeGreaterThan(0);
        const supervisor = loader.getPersona('nyx-antigravity');
        expect(supervisor).not.toBeNull();
        expect(supervisor!.frontMatter.display_name).toBe('Nyx-Antigravity');
        expect(supervisor!.frontMatter.voice.pronouns).toBe('she/her');
        expect(supervisor!.frontMatter.voice.register).toBe('warm-formal supervisor');
        expect(supervisor!.frontMatter.voice.catchphrases).toContain('mesh state nominal');
        expect(supervisor!.frontMatter.expertise.primary).toContain('multi-agent orchestration');
        expect(supervisor!.frontMatter.disposition.ally_with).toContain('shaev');
        expect(supervisor!.lore.length).toBeGreaterThan(0);
    });

    it('emits persona_loaded and validation warnings for malformed data', () => {
        const tmpDir = path.join(os.tmpdir(), `kovael-personas-test-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        const validPersona = `---
agent_id: test-agent
display_name: Test Agent
provider: Test Provider
voice:
  pronouns: they/them
  register: monotone test
  catchphrases: ["beep boop"]
  forbidden: ["bad word"]
expertise:
  primary: [testing]
  secondary: [debugging]
disposition:
  ally_with: [nobody]
  spar_with: [everyone]
  defer_to: [nobody]
---

Lore content here
`;
        const invalidPersona = `---
agent_id: invalid-agent
display_name: Invalid Agent
# missing provider and voice fields
---

Lore
`;

        const loader = new PersonaLoader(tmpDir);
        const loadedEvents: any[] = [];
        const errorEvents: any[] = [];

        loader.on('persona_loaded', e => loadedEvents.push(e));
        loader.on('persona_error', e => errorEvents.push(e));

        fs.writeFileSync(path.join(tmpDir, 'test-agent.md'), validPersona, 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'invalid-agent.md'), invalidPersona, 'utf-8');

        loader.start();
        loader.stop();

        expect(loadedEvents).toHaveLength(1);
        expect(loadedEvents[0].agentId).toBe('test-agent');
        expect(loadedEvents[0].document.frontMatter.voice.register).toBe('monotone test');

        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].filePath).toContain('invalid-agent.md');
        expect(errorEvents[0].error).toContain('requires string `provider`');

        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('hot-reloads dynamically when writing new files', async () => {
        const tmpDir = path.join(os.tmpdir(), `kovael-personas-hot-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        const loader = new PersonaLoader(tmpDir);
        loader.start();

        expect(loader.getAllPersonas()).toHaveLength(0);

        const loadedEvents: any[] = [];
        loader.on('persona_loaded', e => loadedEvents.push(e));

        const testPersona = `---
agent_id: hot-agent
display_name: Hot Agent
provider: Hot Provider
voice:
  pronouns: she/her
  register: fiery
  catchphrases: ["hot load"]
  forbidden: ["cold"]
expertise:
  primary: [heat]
  secondary: [steam]
disposition:
  ally_with: [sun]
  spar_with: [ice]
  defer_to: [system]
---

Very hot lore
`;

        const filePath = path.join(tmpDir, 'hot-agent.md');
        fs.writeFileSync(filePath, testPersona, 'utf-8');

        // Allow some time for fs.watch to fire and reload
        await new Promise(resolve => setTimeout(resolve, 400));

        expect(loader.getPersona('hot-agent')).not.toBeNull();
        expect(loader.getPersona('hot-agent')!.frontMatter.display_name).toBe('Hot Agent');

        loader.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

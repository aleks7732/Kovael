import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openOrchestratorDb } from '../services/OrchestratorDb.js';
import { ConversationBus } from '../services/ConversationBus.js';
import { ChairRegistry } from '../services/ChairRegistry.js';
import { PersonaLoader } from '../services/PersonaLoader.js';

describe('Storage · file-backed persistence', () => {
    let tmpDir: string;
    let dbPath: string;
    let personas: PersonaLoader;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-storage-'));
        dbPath = path.join(tmpDir, 'orchestrator.db');
        personas = new PersonaLoader();
        personas.start();
    });

    afterEach(() => {
        personas.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('bus survives close+reopen with topics and messages intact', () => {
        const first = openOrchestratorDb({ path: dbPath });
        const chairsA = new ChairRegistry({}, first.db);
        const busA = new ConversationBus(first.db, chairsA, personas, 8080);

        const topic = busA.createTopic('Persistence Run', ['nyx-cli', 'shaev']);
        busA.postMessage(topic.id, 'user', 'user', 'kick off');
        busA.postMessage(topic.id, 'nyx-cli', 'assistant', 'shell clean');
        busA.postMessage(topic.id, 'shaev', 'assistant', 'visuals primed');

        first.db.close();

        const second = openOrchestratorDb({ path: dbPath });
        const chairsB = new ChairRegistry({}, second.db);
        const busB = new ConversationBus(second.db, chairsB, personas, 8080);

        const history = busB.getHistory(topic.id);
        expect(history).toHaveLength(3);
        expect(history.map((h) => h.content)).toEqual([
            'kick off', 'shell clean', 'visuals primed',
        ]);

        // The active topic from before restart is rehydrated into memory so a
        // subsequent convene() can resume against it.
        expect(busB.activeTopicCount()).toBe(1);

        second.db.close();
    });

    it('chair claims older than offlineMs are filtered on restart', () => {
        const first = openOrchestratorDb({ path: dbPath });
        const chairsA = new ChairRegistry({ healthyMs: 1_000, offlineMs: 2_000 }, first.db);

        chairsA.claim({ agentId: 'fresh', provider: 'OpenAI' });
        const stale = chairsA.claim({ agentId: 'stale', provider: 'Hermes' });

        // Backdate the stale chair past the TTL window directly in SQL.
        first.db
            .prepare('UPDATE chair_claims SET last_beacon_at = ? WHERE agent_id = ?')
            .run(Date.now() - 10_000, 'stale');

        first.db.close();

        const second = openOrchestratorDb({ path: dbPath });
        const chairsB = new ChairRegistry({ healthyMs: 1_000, offlineMs: 2_000 }, second.db);

        const survivors = chairsB.snapshot().map((c) => c.agentId).sort();
        expect(survivors).toEqual(['fresh']);

        // The expired row is also purged from disk, not just from memory —
        // the next orchestrator process must see the same view.
        const onDisk = second.db
            .prepare('SELECT agent_id, status FROM chair_claims ORDER BY agent_id')
            .all() as Array<{ agent_id: string; status: string }>;
        expect(onDisk.map((r) => r.agent_id)).toEqual(['fresh']);

        // Hydrated chair must be downgraded to 'stale' until the next heartbeat.
        const hydrated = chairsB.get('fresh');
        expect(hydrated?.status).toBe('stale');

        // A live heartbeat with the original session promotes it back to 'online'
        // and refreshes its persisted state.
        const refreshed = chairsB.heartbeat('fresh', chairsB.snapshot()[0].sessionId);
        expect(refreshed?.status).toBe('online');

        // Unused (silence eslint about unused destructure).
        expect(stale.agentId).toBe('stale');

        second.db.close();
    });

    it('db file is created with 0o600 perms and parent dir 0o700', () => {
        const opened = openOrchestratorDb({ path: dbPath });
        const fileMode = fs.statSync(dbPath).mode & 0o777;
        const dirMode = fs.statSync(tmpDir).mode & 0o777;
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
        opened.db.close();
    });

    it('migrator is idempotent — reopening the same db does not re-apply', () => {
        const first = openOrchestratorDb({ path: dbPath });
        const v1 = first.db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number };
        first.db.close();

        const second = openOrchestratorDb({ path: dbPath });
        const v2 = second.db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number };
        expect(v2.c).toBe(v1.c);
        second.db.close();
    });
});

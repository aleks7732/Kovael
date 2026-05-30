import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentCards, type AgentCard } from '../../AgentCards.js';
import { parseManifest, type ChairManifest } from './ChairManifest.js';

export interface ManifestLoadResult {
  source: 'manifests' | 'fallback';
  cards: AgentCard[];
  manifests: ChairManifest[];
  errors: string[];
}

function manifestToCard(m: ChairManifest): AgentCard {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    description: '',
    mcp_capabilities: m.capabilities,
    vram_requirements: m.vram,
    trust_tier: m.trustTier,
    portrait_url: m.portrait ? `/agents/${m.portrait}` : undefined,
  };
}

export function loadChairManifests(cardsDir: string): ManifestLoadResult {
  const errors: string[] = [];
  const manifests: ChairManifest[] = [];
  if (fs.existsSync(cardsDir)) {
    for (const f of fs.readdirSync(cardsDir).filter((x) => x.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf-8'));
        const parsed = parseManifest(raw);
        if (parsed.ok) manifests.push(parsed.manifest);
        else errors.push(`${f}: ${parsed.error}`);
      } catch (e) {
        errors.push(`${f}: ${(e as Error).message}`);
      }
    }
  }
  if (manifests.length > 0) {
    return { source: 'manifests', cards: manifests.map(manifestToCard), manifests, errors };
  }
  return { source: 'fallback', cards: Object.values(AgentCards), manifests: [], errors };
}

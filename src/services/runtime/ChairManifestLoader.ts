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
  const card: AgentCard = {
    id: m.id,
    name: m.name,
    provider: m.provider,
    description: m.description ?? '',
    mcp_capabilities: m.capabilities,
    vram_requirements: m.vram,
    trust_tier: m.trustTier,
  };
  if (m.beaconHint !== undefined) card.beacon_hint = m.beaconHint;
  if (m.portrait !== undefined) card.portrait_url = `/agents/${m.portrait}`;
  if (m.accentHex !== undefined) card.accent_hex = m.accentHex;
  if (m.runtime !== undefined) card.runtime = m.runtime;
  return card;
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

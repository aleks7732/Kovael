import { memo, useMemo } from 'react';

/**
 * ANXDisplay (Module C):
 * High-density renderer for ANX (Agent-Native XML) SOPs. Parses the three
 * canonical tags — <mission_manifest>, <provenance>, <adversarial_critique>
 * — and renders each in its own Obsidian Ember glass card. Pure component:
 * memoized, no side effects, no global state reads.
 */

interface ParsedANX {
  manifest: Record<string, string | string[]>;
  provenance: Record<string, string | string[]>;
  critique: Record<string, string | string[]>;
  raw: string;
}

const TAG_CAPTURE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
const ITEM_CAPTURE = /<(item|metric|mode|plan|source|threshold)[^>]*>([\\s\\S]*?)<\/\\1>/gi;

function unwrap(block: string | undefined): Record<string, string | string[]> {
  if (!block) return {};
  const out: Record<string, string | string[]> = {};
  const childTag = /<([a-zA-Z_][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = childTag.exec(block)) !== null) {
    const [, name, inner] = match;
    const trimmed = inner.trim();
    const items: string[] = [];
    let itemMatch: RegExpExecArray | null;
    const itemRe = new RegExp(ITEM_CAPTURE.source, 'gi');
    while ((itemMatch = itemRe.exec(trimmed)) !== null) {
      items.push(itemMatch[2].trim());
    }
    out[name] = items.length > 0 ? items : trimmed;
  }
  return out;
}

function parseANX(raw: string): ParsedANX {
  const manifestRaw = raw.match(TAG_CAPTURE('mission_manifest'))?.[1];
  const provenanceRaw = raw.match(TAG_CAPTURE('provenance'))?.[1];
  const critiqueRaw = raw.match(TAG_CAPTURE('adversarial_critique'))?.[1];

  return {
    manifest: unwrap(manifestRaw),
    provenance: unwrap(provenanceRaw),
    critique: unwrap(critiqueRaw),
    raw,
  };
}

const Section = memo(({ eyebrow, title, accent }: { eyebrow: string; title: string; accent?: string }) => (
  <div className="flex items-center gap-2 mb-2">
    <div className="t-eyebrow font-bold">{eyebrow}</div>
    <div className="h-[1px] flex-1 bg-white/5" />
    {accent && (
      <div className="t-mono text-[9px] text-command-accent font-bold px-1.5 py-0.5 bg-command-accent/10 rounded">
        {accent}
      </div>
    )}
    <span className="sr-only">{title}</span>
  </div>
));
Section.displayName = 'ANXDisplay.Section';

const FieldList = memo(({ entries }: { entries: Array<[string, string | string[]]> }) => (
  <div className="space-y-2">
    {entries.map(([key, value]) => (
      <div key={key} className="flex flex-col gap-0.5">
        <div className="t-eyebrow !text-[7px]">{key.replace(/_/g, ' ')}</div>
        {Array.isArray(value) ? (
          <ul className="t-mono text-[10px] text-command-warm-white/80 space-y-0.5">
            {value.map((v, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-command-accent/60 mt-0.5">›</span>
                <span>{v || '—'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="t-mono text-[10px] text-command-warm-white/80 leading-relaxed">{value || '—'}</div>
        )}
      </div>
    ))}
  </div>
));
FieldList.displayName = 'ANXDisplay.FieldList';

export interface ANXDisplayProps {
  raw: string;
  compact?: boolean;
}

export const ANXDisplay = memo(({ raw, compact = false }: ANXDisplayProps) => {
  const parsed = useMemo(() => parseANX(raw), [raw]);

  const manifestEntries = Object.entries(parsed.manifest);
  const provenanceEntries = Object.entries(parsed.provenance);
  const critiqueEntries = Object.entries(parsed.critique);

  const empty = manifestEntries.length === 0 && provenanceEntries.length === 0 && critiqueEntries.length === 0;

  if (empty) {
    return (
      <div className="glass-panel p-4 min-w-[300px]">
        <Section eyebrow="ANX_BRIEFING" title="ANX" />
        <div className="t-mono text-[10px] text-white/30 italic text-center py-3 border border-dashed border-white/5 rounded-lg">
          NO_ANX_TAGS_DETECTED
        </div>
      </div>
    );
  }

  const widthCls = compact ? 'min-w-[300px] max-w-[360px]' : 'min-w-[360px] max-w-[480px]';

  return (
    <div className={`glass-panel p-4 ${widthCls} space-y-4`}>
      {manifestEntries.length > 0 && (
        <div>
          <Section eyebrow="MISSION_MANIFEST" title="Mission Manifest" accent={`${manifestEntries.length}`} />
          <FieldList entries={manifestEntries} />
        </div>
      )}

      {provenanceEntries.length > 0 && (
        <div className="border-t border-white/5 pt-3">
          <Section eyebrow="PROVENANCE" title="Provenance" accent={`${provenanceEntries.length}`} />
          <FieldList entries={provenanceEntries} />
        </div>
      )}

      {critiqueEntries.length > 0 && (
        <div className="border-t border-white/5 pt-3">
          <Section eyebrow="ADVERSARIAL_CRITIQUE" title="Adversarial Critique" accent={`${critiqueEntries.length}`} />
          <FieldList entries={critiqueEntries} />
        </div>
      )}
    </div>
  );
});
ANXDisplay.displayName = 'ANXDisplay';

export default ANXDisplay;

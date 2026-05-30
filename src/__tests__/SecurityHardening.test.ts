import { describe, it, expect } from 'vitest';
import { isDeniedCommandEnvName } from '../services/runtime/CommandAdapter.js';
import { safePathSegment } from '../services/SqlitePathSecurity.js';

describe('isDeniedCommandEnvName (case-insensitive — Windows env)', () => {
  it('denies secret names in any case', () => {
    for (const n of ['KOVAEL_TOKEN', 'kovael_token', 'Kovael_Token', 'KOVAEL_API_TOKEN',
      'kovael_chair_dispatch_secret', 'KOVAEL_AGENT_HUB_SECRET', 'kovael_agent_hub_encryption']) {
      expect(isDeniedCommandEnvName(n), n).toBe(true);
    }
  });

  it('allows non-secret operator vars', () => {
    expect(isDeniedCommandEnvName('KOVAEL_HOST')).toBe(false);
    expect(isDeniedCommandEnvName('PATH')).toBe(false);
  });
});

describe('safePathSegment (traversal-safe)', () => {
  it('neutralizes path-significant segments', () => {
    for (const seg of ['', '.', '..', '...']) {
      expect(safePathSegment(seg), seg).toBe('_');
    }
  });

  it('strips separators and never yields a traversal segment', () => {
    const out = safePathSegment('../../etc');
    expect(out).not.toMatch(/[/\\]/);
    expect(out).not.toBe('..');
  });

  it('leaves normal agent ids unchanged', () => {
    expect(safePathSegment('nyx-codex')).toBe('nyx-codex');
    expect(safePathSegment('shaev')).toBe('shaev');
    expect(safePathSegment('nyx_adk.v2')).toBe('nyx_adk.v2');
  });
});

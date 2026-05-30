import { describe, it, expect } from 'vitest';
import { isDeniedCommandEnvName } from '../services/runtime/CommandAdapter.js';
import { safePathSegment } from '../services/SqlitePathSecurity.js';
import { redactSensitiveText } from '../services/RuntimeSecurity.js';

describe('redactSensitiveText (value-aware)', () => {
  it('redacts an exact secret value in the 32–47-char band the shape rules miss', () => {
    const secret = 'a'.repeat(40); // alphanumeric, <48 hex, <64 token → shape rules skip it
    const env = { KOVAEL_API_TOKEN: secret } as NodeJS.ProcessEnv;
    const out = redactSensitiveText(`dispatch failed: token=${secret} bad`, env);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('leaves ordinary text intact', () => {
    expect(redactSensitiveText('hello world', {} as NodeJS.ProcessEnv)).toBe('hello world');
  });
});

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

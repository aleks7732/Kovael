import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * SSRF egress guard for chair dispatch URLs. Chair inboxes are loopback-by-design,
 * so loopback is NOT blocked; instead this rejects the ranges that are never a
 * legitimate chair: link-local (169.254.0.0/16 — including the 169.254.169.254
 * cloud-metadata IP — and fe80::/10) and the unspecified address (0.0.0.0 / ::).
 * Hostnames are resolved and every answer is checked, re-validating post-DNS to
 * blunt rebinding. `blockPrivate` additionally rejects RFC1918 / ULA for stricter
 * deployments.
 */

export interface EgressGuardOptions {
  blockPrivate?: boolean;
}

export function isBlockedEgressIp(ip: string, opts: EgressGuardOptions = {}): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4 = mapped ? mapped[1] : (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr) ? addr : null);
  if (v4) {
    const o = v4.split('.').map(Number);
    if (o[0] === 169 && o[1] === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (v4 === '0.0.0.0') return true; // unspecified
    if (opts.blockPrivate) {
      if (o[0] === 10) return true;
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
      if (o[0] === 192 && o[1] === 168) return true;
    }
    return false;
  }
  // IPv6
  if (addr === '::' || addr === '::0') return true; // unspecified
  if (addr.startsWith('fe80:')) return true; // link-local
  if (opts.blockPrivate && (addr.startsWith('fc') || addr.startsWith('fd'))) return true; // ULA
  return false;
}

type LookupFn = (host: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/**
 * Throws if `urlString` is not http(s), or if its host (literal or every resolved
 * address) falls in a blocked egress range. `lookup` is injectable for tests.
 */
export async function assertSafeChairUrl(
  urlString: string,
  opts: EgressGuardOptions = {},
  lookup: LookupFn = defaultLookup,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url uses disallowed protocol "${url.protocol}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(':');
  const addresses = isIpLiteral ? [host] : (await lookup(host)).map((r) => r.address);
  for (const ip of addresses) {
    if (isBlockedEgressIp(ip, opts)) {
      throw new Error(`url resolves to a blocked address (${ip})`);
    }
  }
}

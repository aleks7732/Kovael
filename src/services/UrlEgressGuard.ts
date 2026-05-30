import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF egress guard for chair dispatch URLs. Chair inboxes are loopback-by-design,
 * so loopback is NOT blocked; this rejects the ranges that are never a legitimate
 * chair: link-local (169.254.0.0/16 — including the 169.254.169.254 cloud-metadata
 * IP — and fe80::/10) and the unspecified address (0.0.0.0 / ::). IP families are
 * classified with net.isIP (not hand-rolled regexes) so alternate renderings —
 * IPv4-mapped IPv6 (::ffff:a9fe:a9fe) and decimal/octal/hex IPv4 (WHATWG-normalized
 * in url.hostname) — cannot slip past. `blockPrivate` also rejects RFC1918 / ULA.
 */

export interface EgressGuardOptions {
  blockPrivate?: boolean;
}

function isBlockedV4(v4: string, opts: EgressGuardOptions): boolean {
  const o = v4.split('.').map(Number);
  if (o[0] === 169 && o[1] === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (v4 === '0.0.0.0') return true; // unspecified
  if (opts.blockPrivate) {
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
  }
  return false; // loopback (127/8) and public are allowed
}

export function isBlockedEgressIp(ip: string, opts: EgressGuardOptions = {}): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const fam = isIP(addr);
  if (fam === 4) return isBlockedV4(addr, opts);
  if (fam === 6) {
    // IPv4-mapped IPv6 (::ffff:0:0/96): check the embedded v4 in either rendering
    // (dotted ::ffff:1.2.3.4 or hex ::ffff:a9fe:a9fe).
    const m = addr.match(/^::ffff:(.+)$/);
    if (m) {
      const e = m[1];
      if (isIP(e) === 4) return isBlockedV4(e, opts);
      const hex = e.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        const v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
        return isBlockedV4(v4, opts);
      }
    }
    if (addr === '::' || addr === '::0') return true; // unspecified
    if (addr.startsWith('fe80:')) return true; // link-local
    if (opts.blockPrivate && (addr.startsWith('fc') || addr.startsWith('fd'))) return true; // ULA
    return false;
  }
  return false; // not an IP literal — resolved + checked by the caller
}

type LookupFn = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/**
 * Validates an outbound chair URL and returns the URL to actually fetch. http(s)
 * only; the literal host, or every resolved DNS answer, must be outside the
 * blocked ranges. For an http hostname the URL is rewritten to the validated IP
 * so fetch connects to exactly the address the guard checked — closing the
 * DNS-rebind TOCTOU between validation and connection. IP literals and https keep
 * their host (https keeps SNI; its rebind residual is tracked). `lookup` is
 * injectable for tests.
 */
export async function resolveSafeChairUrl(
  urlString: string,
  opts: EgressGuardOptions = {},
  lookup: LookupFn = defaultLookup,
): Promise<string> {
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
  if (isIP(host) !== 0) {
    if (isBlockedEgressIp(host, opts)) throw new Error(`url targets a blocked address (${host})`);
    return urlString;
  }
  const addresses = (await lookup(host)).map((r) => r.address);
  if (addresses.length === 0) throw new Error(`url host "${host}" did not resolve`);
  for (const ip of addresses) {
    if (isBlockedEgressIp(ip, opts)) throw new Error(`url resolves to a blocked address (${ip})`);
  }
  if (url.protocol === 'http:') {
    const ip = addresses[0];
    url.hostname = isIP(ip) === 6 ? `[${ip}]` : ip; // pin to a validated address
    return url.href;
  }
  return urlString;
}

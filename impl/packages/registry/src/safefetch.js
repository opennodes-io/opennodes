// SSRF-guarded fetch for probe/card traffic (DS-NFR-03): the registry fetches
// operator-supplied URLs, so private/reserved targets are denied unless explicitly
// allowed (dev/e2e). Also caps response size and time.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BODY = 5_000_000;

function ipIsPrivate(ip) {
  if (ip.includes(':')) { // IPv6
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd')
      || low.startsWith('fe80') || low.startsWith('::ffff:127.') || low.startsWith('::ffff:10.')
      || low.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

export function makeSafeFetch({ allowPrivate = false } = {}) {
  return async function safeFetch(url, opts = {}, timeoutMs = 15_000) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`ssrf-blocked: scheme ${parsed.protocol}`);
    if (!allowPrivate) {
      const host = parsed.hostname;
      const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
      const blocked = ips.find(ipIsPrivate);
      if (blocked || host === 'localhost') throw new Error(`ssrf-blocked: ${host} resolves to private range`);
    }
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BODY) throw new Error('response too large');
    return res;
  };
}

export async function fetchJsonCapped(safeFetch, url, opts = {}, timeoutMs) {
  const res = await safeFetch(url, opts, timeoutMs);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('response too large');
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, headers: res.headers, body };
}

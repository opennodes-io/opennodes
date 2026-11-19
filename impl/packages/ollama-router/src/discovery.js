// LAN discovery: static peers (Ollama servers or ONP nodes, auto-detected by probing) plus, with
// --mdns, browsing for `_onp._tcp` services advertised by the Node Kit (`onp-node serve --mdns`).
//
// Who counts as the user's own network (ONP-3 §5b): a peer is used only when the user added it
// (--peer, POST /router/peers) or when its card is signed by a key the user pinned (--pin). Only a
// pinned peer is the user's own network for auto-private, auto-<jurisdiction> and sensitive requests.
import { validateCard, verifyCardSignature, keyFromJwk, jwkThumbprint } from '@opennodes/core';

const PROBE_TIMEOUT = 4_000;

/** A pin as the user writes it: the RFC 7638 thumbprint, optionally prefixed `sha256:`. */
export const normalizePin = (pin) => String(pin ?? '').trim().replace(/^sha256:/i, '');

/**
 * The key that signs a card, and whether the signature holds: { key: thumbprint, jwk } or null when
 * the card is unsigned, the JWKS has no matching key, or the signature does not verify.
 */
export async function cardKey(base, card) {
  const sig = card?.signatures?.[0];
  if (!sig) return null;
  try {
    const res = await fetch(`${base}/.well-known/jwks.json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    if (!res.ok) return null;
    const keys = (await res.json())?.keys ?? [];
    const jwk = (sig.kid ? keys.find((k) => k.kid === sig.kid) : null) ?? (keys.length === 1 ? keys[0] : null);
    if (!jwk) return null;
    verifyCardSignature(card, keyFromJwk(jwk));
    return { key: jwkThumbprint(jwk), jwk };
  } catch { return null; }
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/**
 * Probe an origin: ONP node (has a card) or plain Ollama (has /api/tags). An ONP node is `pinned` when
 * its card is signed by a key in `pins`; `key` is that key's thumbprint whether pinned or not, so the
 * user can check it and pin it. A plain Ollama server has no key and is never pinned.
 *
 * A signed card can be copied: a signature proves who wrote the card, not who serves it. So the pin
 * holds only when the origin reached is the one the signed card names in `endpoints.openai`, however the
 * peer was added; a pinned card served from anywhere else is `replayed` and not pinned.
 */
export async function probePeer(origin, { pins = new Set() } = {}) {
  const base = String(origin).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/.well-known/open-node.json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    if (res.ok) {
      const card = await res.json();
      if (!validateCard(card).length) {
        const signed = await cardKey(base, card);
        const keyPinned = Boolean(signed && pins.has(signed.key));
        const atCardOrigin = originOf(card.endpoints?.openai) === originOf(base);
        return {
          kind: 'onp', origin: base, name: peerName(card.node?.id ?? base), card, key: signed?.key ?? null, jwk: signed?.jwk ?? null,
          atCardOrigin, pinned: keyPinned && atCardOrigin, replayed: keyPinned && !atCardOrigin,
        };
      }
    }
  } catch { /* not an ONP node */ }
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    if (res.ok) return { kind: 'ollama', origin: base, name: peerName(new URL(base).hostname), key: null, pinned: false };
  } catch { /* not reachable */ }
  return null;
}

/** org.example.gpubox -> gpubox; 192.168.1.20 -> 192-168-1-20 */
export function peerName(id) {
  const last = String(id).includes('.') && !/^\d+(\.\d+){3}$/.test(id) ? String(id).split('.').pop() : String(id);
  return last.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'peer';
}

/** Loopback, private (RFC 1918, IPv6 ULA) and link-local addresses: where an mDNS answer can come from. */
export function isLanAddress(address) {
  const a = String(address ?? '').toLowerCase().replace(/^::ffff:/, '');
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254);
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

const SERVICE = '_onp._tcp.local';
const urlHost = (address) => (String(address).includes(':') ? `[${address}]` : address);

/**
 * Origins advertised in one mDNS response, for the host that sent it (`rinfo.address`). An answer from
 * outside the LAN is ignored. A TXT `origin` is used only when it names the advertising host; any other
 * (an internet host, another machine) is ignored in favour of that host and the SRV port.
 */
export function mdnsOrigins(resp, rinfo = {}) {
  const sender = String(rinfo.address ?? '').replace(/^::ffff:/i, '');
  if (!isLanAddress(sender)) return [];
  const records = [...(resp?.answers ?? []), ...(resp?.additionals ?? [])];
  const ptrs = records.filter((r) => r.type === 'PTR' && r.name === SERVICE).map((r) => r.data);
  const origins = [];
  for (const instance of ptrs) {
    const srv = records.find((r) => r.type === 'SRV' && r.name === instance);
    const txt = records.find((r) => r.type === 'TXT' && r.name === instance);
    const props = Object.fromEntries((txt?.data ?? []).map((b) => String(b)).map((kv) => { const i = kv.indexOf('='); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, '']; }));
    let origin = null;
    if (props.origin) {
      try {
        const u = new URL(props.origin);
        const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if ((u.protocol === 'http:' || u.protocol === 'https:') && host === sender.toLowerCase()) origin = u.origin;
      } catch { /* not a URL: ignored */ }
    }
    if (!origin && srv?.data?.port) origin = `http://${urlHost(sender)}:${srv.data.port}`;
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Browse mDNS for _onp._tcp services. Calls onFound(origin) for each discovered node. Returns a
 * stop() function. Silently inactive if multicast-dns is unavailable or the network forbids multicast.
 */
export async function browseMdns(onFound, { intervalMs = 60_000 } = {}) {
  let mdns;
  try { mdns = (await import('multicast-dns')).default(); } catch { return () => {}; }
  const seen = new Set();
  mdns.on('response', (resp, rinfo) => {
    for (const origin of mdnsOrigins(resp, rinfo)) if (!seen.has(origin)) { seen.add(origin); onFound(origin); }
  });
  const query = () => { try { mdns.query({ questions: [{ name: SERVICE, type: 'PTR' }] }); } catch { /* ignore */ } };
  query();
  const timer = setInterval(query, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); try { mdns.destroy(); } catch { /* ignore */ } };
}

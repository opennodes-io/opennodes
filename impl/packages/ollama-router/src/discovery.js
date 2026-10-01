// LAN discovery: static peers (Ollama servers or ONP nodes, auto-detected by probing) plus
// mDNS browsing for `_onp._tcp` services advertised by the Node Kit (`onp-node serve --mdns`).
import { validateCard } from '@opennodes/core';

const PROBE_TIMEOUT = 4_000;

/** Probe an origin: ONP node (has a card) or plain Ollama (has /api/tags). */
export async function probePeer(origin) {
  const base = origin.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/.well-known/open-node.json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    if (res.ok) {
      const card = await res.json();
      if (!validateCard(card).length) {
        return { kind: 'onp', origin: base, name: peerName(card.node?.id ?? base), card };
      }
    }
  } catch { /* not an ONP node */ }
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    if (res.ok) return { kind: 'ollama', origin: base, name: peerName(new URL(base).hostname) };
  } catch { /* not reachable */ }
  return null;
}

/** org.example.gpubox -> gpubox; 192.168.1.20 -> 192-168-1-20 */
export function peerName(id) {
  const last = String(id).includes('.') && !/^\d+(\.\d+){3}$/.test(id) ? String(id).split('.').pop() : String(id);
  return last.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'peer';
}

/**
 * Browse mDNS for _onp._tcp services. Calls onFound(origin) for each discovered node.
 * Returns a stop() function. Silently inactive if multicast-dns is unavailable or the
 * network forbids multicast.
 */
export async function browseMdns(onFound, { intervalMs = 60_000 } = {}) {
  let mdns;
  try { mdns = (await import('multicast-dns')).default(); } catch { return () => {}; }
  const seen = new Set();
  const SERVICE = '_onp._tcp.local';
  mdns.on('response', (resp) => {
    const records = [...(resp.answers ?? []), ...(resp.additionals ?? [])];
    const ptrs = records.filter((r) => r.type === 'PTR' && r.name === SERVICE).map((r) => r.data);
    for (const instance of ptrs) {
      const srv = records.find((r) => r.type === 'SRV' && r.name === instance);
      const txt = records.find((r) => r.type === 'TXT' && r.name === instance);
      const props = Object.fromEntries((txt?.data ?? []).map((b) => String(b)).map((kv) => { const i = kv.indexOf('='); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, '']; }));
      let origin = props.origin;
      if (!origin && srv) {
        const a = records.find((r) => (r.type === 'A' || r.type === 'AAAA') && r.name === srv.data.target);
        const hostIp = a ? (r => r.type === 'AAAA' ? `[${r.data}]` : r.data)(a) : srv.data.target.replace(/\.$/, '');
        origin = `http://${hostIp}:${srv.data.port}`;
      }
      if (origin && !seen.has(origin)) { seen.add(origin); onFound(origin); }
    }
  });
  const query = () => { try { mdns.query({ questions: [{ name: SERVICE, type: 'PTR' }] }); } catch { /* ignore */ } };
  query();
  const timer = setInterval(query, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); try { mdns.destroy(); } catch { /* ignore */ } };
}

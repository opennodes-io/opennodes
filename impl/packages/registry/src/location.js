// Server-location checks (ONP-1 §6 threat 5, ONP-3 §6.5): where a node's API host actually is,
// compared with the operator's declared country. Two signals, both evidence rather than proof:
//  (a) IP geolocation + network owner of the endpoint host (RIPE NCC RIPEstat, no key needed);
//      CDN / anycast networks are reported as such, never as a location.
//  (b) TCP connect round-trip times from the registry's own probe sites. Light in fibre covers
//      about 100 km per millisecond of round trip, so a reply faster than physics allows for the
//      geolocated point means that point is wrong; one far slower than expected from every site
//      is a soft warning (congestion or a forwarding hop can also cause it).
// A front server that forwards requests elsewhere still defeats both; attested residency
// (an auditor's credential) is the strong guarantee, planned for Draft 0.2.
import net from 'node:net';
import dns from 'node:dns/promises';
import { EEA_COUNTRIES } from '@opennodes/core';
import { isPrivateHost } from './namespace.js';

const RIPESTAT = 'https://stat.ripe.net/data';
const LOOKUP_TIMEOUT_MS = 30_000;
const KM_PER_MS_RTT = 100;   // ~2/3 c in fibre, out and back

/** Networks whose addresses are anycast / CDN edges: their IP says nothing about where inference runs. */
export const CDN_ASNS = new Map([
  [13335, 'Cloudflare'], [209242, 'Cloudflare'], [54113, 'Fastly'], [20940, 'Akamai'], [16625, 'Akamai'],
  [16702, 'Akamai'], [32787, 'Akamai'], [60068, 'CDN77'], [22822, 'Edgio'], [15133, 'Edgecast'],
]);

const EEA = new Set(EEA_COUNTRIES);

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Judge measured RTTs against a claimed point. vantages: [{site, lat, lon, rtt_ms}].
 * 'too_fast'  — some site measured less than physics allows for that point: the point is wrong.
 * 'too_slow'  — every site measured far more than the point would explain: likely farther away.
 * 'consistent' otherwise; 'unknown' without a point or measurements.
 */
export function assessLatency(vantages, point) {
  const measured = vantages.filter((v) => Number.isFinite(v.rtt_ms));
  if (!point || !measured.length) return { verdict: 'unknown', sites: measured };
  const sites = measured.map((v) => {
    const km = Math.round(haversineKm(v, point));
    const min_rtt_ms = Math.round((km / KM_PER_MS_RTT) * 10) / 10;
    return { site: v.site, rtt_ms: v.rtt_ms, distance_km: km, min_rtt_ms, max_distance_km: Math.round(v.rtt_ms * KM_PER_MS_RTT) };
  });
  if (sites.some((s) => s.rtt_ms < s.min_rtt_ms * 0.9 - 1)) return { verdict: 'too_fast', sites };
  if (sites.every((s) => s.rtt_ms > s.min_rtt_ms * 2.5 + 25)) return { verdict: 'too_slow', sites };
  return { verdict: 'consistent', sites };
}

/** match | same_region (both in the EEA) | mismatch | cdn | unknown */
export function countryVerdict(declared, server) {
  if (server?.cdn) return 'cdn';
  if (!declared || !server?.country) return 'unknown';
  if (server.country === declared) return 'match';
  if (EEA.has(server.country) && EEA.has(declared)) return 'same_region';
  return 'mismatch';
}

async function ripestat(fetchImpl, path, resource) {
  const url = `${RIPESTAT}/${path}/data.json?resource=${encodeURIComponent(resource)}&sourceapp=opennodes-registry`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ripestat ${path} ${res.status}`);
  return (await res.json()).data ?? {};
}

/** Country, city, coordinates and network of one IP address. */
export async function lookupIp(ip, { fetchImpl = fetch, asHolders = new Map() } = {}) {
  const [geo, netinfo] = await Promise.all([
    ripestat(fetchImpl, 'maxmind-geo-lite', ip).catch(() => ({})),
    ripestat(fetchImpl, 'network-info', ip).catch(() => ({})),
  ]);
  const loc = (geo.located_resources ?? []).flatMap((r) => r.locations ?? [])
    .sort((a, b) => (b.covered_percentage ?? 0) - (a.covered_percentage ?? 0))[0];
  const asn = Number((netinfo.asns ?? [])[0]) || null;
  let holder = asn ? (CDN_ASNS.get(asn) ?? asHolders.get(asn)) : null;
  if (asn && !holder) {
    holder = (await ripestat(fetchImpl, 'as-overview', `AS${asn}`).catch(() => ({}))).holder ?? null;
    if (holder) asHolders.set(asn, holder);
  }
  return {
    ip,
    country: loc?.country ? String(loc.country).toUpperCase() : null,
    city: loc?.city || null,
    lat: Number.isFinite(loc?.latitude) ? loc.latitude : null,
    lon: Number.isFinite(loc?.longitude) ? loc.longitude : null,
    asn, network: holder, prefix: netinfo.prefix ?? null,
    cdn: asn ? CDN_ASNS.has(asn) : false,
  };
}

/** Median TCP connect time (ms) to host:443 from here. */
export async function measureRtt(host, { port = 443, attempts = 3, timeoutMs = 5000 } = {}) {
  const times = [];
  for (let i = 0; i < attempts; i++) {
    const t = await new Promise((resolve) => {
      const t0 = performance.now();
      const socket = net.connect({ host, port, timeout: timeoutMs });
      const done = (v) => { socket.destroy(); resolve(v); };
      socket.once('connect', () => done(performance.now() - t0));
      socket.once('timeout', () => done(null));
      socket.once('error', () => done(null));
    });
    if (t !== null) times.push(t);
  }
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)] * 10) / 10;
}

/** Ask a remote probe agent (deploy/reference-node/probe-agent) for its RTT to host. */
export async function remoteRtt(agent, host, fetchImpl = fetch) {
  const res = await fetchImpl(`${agent.url.replace(/\/$/, '')}/rtt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(agent.token ? { authorization: `Bearer ${agent.token}` } : {}) },
    body: JSON.stringify({ host }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`probe agent ${res.status}`);
  const body = await res.json();
  return { site: body.site ?? agent.site, lat: body.lat ?? agent.lat, lon: body.lon ?? agent.lon, rtt_ms: body.rtt_ms ?? null };
}

/**
 * Check one node: resolve its API host, geolocate the first public IPv4, measure RTT from every
 * probe site, and compare with the declared country.
 * opts: { selfSite: {site, lat, lon}, agents: [{site, lat, lon, url, token}], fetchImpl, resolve, rtt }
 */
export async function checkNodeLocation(card, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let host = null;
  try { host = new URL(card?.endpoints?.openai).hostname; } catch { /* listing without an API */ }
  const declared = card?.node?.operator?.country ? String(card.node.operator.country).toUpperCase() : null;
  const out = { host, declared, checked_at: new Date().toISOString() };
  if (!host) return { ...out, verdict: 'unknown', reason: 'no API endpoint' };

  const ips = net.isIP(host) ? [host] : await (opts.resolve ?? ((h) => dns.resolve4(h)))(host).catch(() => []);
  const ip = ips.find((a) => !isPrivateHost(a));
  if (!ip) return { ...out, ips, verdict: 'unknown', reason: 'no public IPv4 address' };

  const server = await lookupIp(ip, { fetchImpl, asHolders: opts.asHolders });
  const vantages = [];
  const rtt = opts.rtt ?? measureRtt;
  if (opts.selfSite) vantages.push({ ...opts.selfSite, rtt_ms: await rtt(ip).catch(() => null) });
  for (const agent of opts.agents ?? []) {
    vantages.push(await remoteRtt(agent, ip, fetchImpl).catch(() => ({ site: agent.site, lat: agent.lat, lon: agent.lon, rtt_ms: null })));
  }
  // The point to test: the geolocated position unless it's a CDN edge.
  const point = !server.cdn && server.lat !== null ? { lat: server.lat, lon: server.lon } : null;
  const latency = assessLatency(vantages, point);
  let verdict = countryVerdict(declared, server);
  if (latency.verdict === 'too_fast' && verdict !== 'cdn') verdict = 'inconsistent';   // the geolocation itself is wrong
  return {
    ...out, ips,
    server: { country: server.country, city: server.city, asn: server.asn, network: server.network, cdn: server.cdn },
    verdict,
    latency,
  };
}

/** Parse "FI Helsinki 60.17 24.93 https://host/onp-probe" (agents) or "DE Nuremberg 49.45 11.08" (self). */
export function parseSite(spec) {
  if (!spec) return null;
  const parts = String(spec).trim().split(/\s+/);
  const [country, city, lat, lon, url] = parts;
  const site = { site: `${country}-${city}`, lat: Number(lat), lon: Number(lon) };
  if (!Number.isFinite(site.lat) || !Number.isFinite(site.lon)) return null;
  return url ? { ...site, url } : site;
}

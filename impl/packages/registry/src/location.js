// Server-location checks (ONP-1 §6 threat 5, ONP-3 §6.4): where a node's API host actually is,
// compared with the operator's declared country. Two signals, both evidence rather than proof:
//  (a) IP geolocation + network owner of the endpoint host (RIPE NCC RIPEstat, no key needed);
//      CDN / anycast networks are reported as such, never as a location.
//  (b) TCP connect round-trip times from the registry's own probe sites. Light in fibre covers
//      about 100 km per millisecond of round trip, so a reply faster than physics allows for the
//      geolocated point means that point is wrong; one far slower than expected from every site
//      is a soft warning (congestion or a forwarding hop can also cause it).
// A front server that forwards requests elsewhere still defeats both; attested residency
// (an auditor's credential) is the strong guarantee, planned for Draft 0.2.
// Behind a CDN the front says nothing, so an operator may declare in its signed card the origin
// addresses that serve the API (ONP-2 §4 `endpoints.origin_addresses`): each one must present a
// publicly trusted certificate for the API host, answer the API's model list exactly as the API
// does through the CDN, and is then located the same way. Unsigned cards' origins count for nothing.
import net from 'node:net';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EEA_COUNTRIES, SERVER_CHECK_PASSES, distanceKm } from '@opennodes/core';
import { isPrivateHost } from './namespace.js';

const RIPESTAT = 'https://stat.ripe.net/data';
const LOOKUP_TIMEOUT_MS = 30_000;
const KM_PER_MS_RTT = 100;   // ~2/3 c in fibre, out and back
/** At most this many declared origin addresses are checked; a card that declares more fails the origin check. */
export const MAX_ORIGIN_ADDRESSES = 4;

// Addresses an operator-declared origin may never be: the registry must not be steered into its own
// network. (Documentation ranges stay allowed: they are not routable, and tests use them.)
const NON_PUBLIC = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) NON_PUBLIC.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) NON_PUBLIC.addSubnet(a, p, 'ipv6');

/** A public unicast IP literal (v4 or v6)? An IPv4-mapped IPv6 address is judged by its IPv4 part. */
export function isPublicAddress(ip) {
  const text = String(ip).toLowerCase();
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = net.isIP(text);
  if (family === 6 && text.startsWith('::ffff:')) return false;   // mapped, in hex form: refuse rather than decode
  return family !== 0 && !NON_PUBLIC.check(text, family === 6 ? 'ipv6' : 'ipv4');
}

/** Networks whose addresses are anycast / CDN edges: their IP says nothing about where inference runs. */
export const CDN_ASNS = new Map([
  [13335, 'Cloudflare'], [209242, 'Cloudflare'], [54113, 'Fastly'], [20940, 'Akamai'], [16625, 'Akamai'],
  [16702, 'Akamai'], [32787, 'Akamai'], [60068, 'CDN77'], [22822, 'Edgio'], [15133, 'Edgecast'],
]);

const EEA = new Set(EEA_COUNTRIES);

/** Great-circle distance in km; one implementation, shared with /v0/locations (core geo.js). */
export const haversineKm = distanceKm;

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

/** Geolocate one address, measure RTT to it from every probe site, and compare with the declared country. */
async function locateAddress(ip, declared, opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
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
    server: { country: server.country, city: server.city, asn: server.asn, network: server.network, cdn: server.cdn },
    verdict,
    latency,
  };
}

/** The most of a model list an origin check reads; a longer answer counts as no list. */
const MAX_LIST_BYTES = 1_000_000;

/** The model ids of an OpenAI-style list (`{"data": [{"id": …}]}`), unique and sorted; null when the body is not one. */
export function modelIds(body) {
  try {
    const data = JSON.parse(body)?.data;
    if (!Array.isArray(data)) return null;
    return [...new Set(data.map((m) => m?.id).filter((id) => typeof id === 'string' && id))].sort();
  } catch { return null; }
}

/**
 * Ask the server at `ip` for the API, as the API host: it must complete a TLS handshake for `host` (SNI)
 * with a certificate valid for that name under the public CA roots, then answer GET `path` with Host:
 * `host` (and `headers`, such as the registry's probe credential, sent only after the certificate is
 * accepted). Connects to the address itself on port 443: no DNS, no redirects. `ok` when the handshake
 * completes and the status is below 500; `models` is the model list when the answer is 200 with an
 * OpenAI-style list, else null. Used for the CDN front and for each declared origin alike. (`ca` replaces
 * the public roots in tests only.)
 */
export function probeOrigin(ip, host, { path = '/', headers = {}, timeoutMs = 10_000, port = 443, ca } = {}) {
  return new Promise((resolve) => {
    // One deadline for the whole exchange: the socket's idle timeout alone would let a server that
    // drips its answer hold the check (and the daily sweep behind it) open.
    let deadline = null;
    const settle = (result) => { clearTimeout(deadline); resolve(result); };
    const req = https.request({
      host: ip, port, servername: host, path, method: 'GET', agent: false, timeout: timeoutMs, ...(ca ? { ca } : {}),
      headers: { ...headers, host, accept: 'application/json', 'user-agent': 'opennodes-registry (origin check)' },
    }, (res) => {
      const status = res.statusCode;
      const chunks = [];
      let size = 0;
      const done = () => {
        const models = status === 200 && size <= MAX_LIST_BYTES ? modelIds(Buffer.concat(chunks).toString('utf8')) : null;
        settle(status < 500 ? { ok: true, status, models } : { ok: false, status, models: null, reason: `HTTP ${status} for ${path}` });
      };
      res.on('data', (chunk) => { size += chunk.length; if (size > MAX_LIST_BYTES) res.destroy(); else chunks.push(chunk); });
      res.on('end', done);
      res.on('close', done);   // also after a destroy: an over-long answer has no list
    });
    deadline = setTimeout(() => { settle({ ok: false, reason: 'timed out' }); req.destroy(); }, timeoutMs);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'timed out' })));
    req.on('error', (err) => settle({ ok: false, reason: err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? `certificate not valid for ${host}` : String(err.code ?? err.message) }));
    req.end();
  });
}

/** What an origin check requests, from the front and from each origin: the API's model list, `{api path}/models`. */
function originProbePath(card) {
  const api = new URL(card.endpoints.openai);
  return `${api.pathname.replace(/\/$/, '')}/models`;
}

/** How two model lists differ, in words; null when they hold the same ids. */
function listDifference(origin, front) {
  const have = new Set(origin), want = new Set(front);
  const missing = front.filter((id) => !have.has(id)).length, extra = origin.filter((id) => !want.has(id)).length;
  return missing || extra ? `lists other models than the API through the CDN (${missing} missing, ${extra} more)` : null;
}

/**
 * Behind a CDN: check every origin address the card declares (`endpoints.origin_addresses`, ONP-2 §4).
 * The declaration counts only in a signed card (`opts.signed`): it is the operator's signed statement of
 * where the API runs. The registry first asks the API for its model list through the CDN (the front
 * address `opts.frontIp`, with the key it probes with, `opts.key`); with no list there is nothing to
 * compare, and the check fails. Each origin must then be (or resolve to) a public address, answer the
 * same request as the API host with the same model list (probeOrigin), and be located with match or
 * same_region; one that sits on a CDN network itself is `cdn`, not an origin. The result's verdict is
 * `match` or `same_region` only when every declared address passes. Null when none is declared.
 */
export async function checkOrigins(card, host, declared, opts = {}) {
  const listed = declaredOrigins(card);
  if (!listed.length) return null;
  const signed = opts.signed !== false;
  const fail = (reason, extra = {}) => ({ declared: listed, signed, verdict: 'unknown', reason, ...extra, addresses: [] });
  if (!signed) return fail('origin addresses count only in a signed card (ONP-2 §8)');
  if (listed.length > MAX_ORIGIN_ADDRESSES) return fail(`more than ${MAX_ORIGIN_ADDRESSES} origin addresses declared`);
  const probe = opts.probeOrigin ?? probeOrigin;
  const target = { path: originProbePath(card), headers: opts.key ? { authorization: `Bearer ${opts.key}` } : {} };
  const asked = (ip) => probe(ip, host, target).catch((err) => ({ ok: false, reason: String(err.message) }));
  // What the API answers through the CDN: every origin must give the same answer.
  const front = opts.frontIp ? await asked(opts.frontIp) : { ok: false, reason: 'no front address' };
  if (!front.models?.length) {
    const why = front.models ? 'an empty list' : front.status ? `HTTP ${front.status}` : front.reason;
    return fail(`the API gives the registry no model list through the CDN (${why}), so no origin can be compared with it`,
      { front: { status: front.status ?? null, models: 0 } });
  }
  const addresses = [];
  for (const address of listed) {
    const ips = net.isIP(address) ? [address] : await (opts.resolve ?? ((h) => dns.resolve4(h)))(address).catch(() => []);
    const ip = ips.find(isPublicAddress);
    if (!ip) { addresses.push({ address, verdict: 'unknown', reason: ips.length ? 'not a public address' : 'does not resolve' }); continue; }
    const serves = await asked(ip);
    if (!serves.ok) { addresses.push({ address, ip, verdict: 'unknown', reason: `does not serve ${host}: ${serves.reason}` }); continue; }
    const differs = serves.models ? listDifference(serves.models, front.models)
      : `does not answer like the API through the CDN (HTTP ${serves.status}${serves.status === 200 ? ', no model list' : ''})`;
    if (differs) { addresses.push({ address, ip, verdict: 'unknown', reason: differs }); continue; }
    const located = await locateAddress(ip, declared, opts);
    addresses.push({ address, ip, serves: true, server_country: located.server.country, ...located });
  }
  const failed = addresses.find((a) => !SERVER_CHECK_PASSES.includes(a.verdict));
  return {
    declared: listed,
    signed,
    front: { status: front.status, models: front.models.length },
    verdict: failed ? failed.verdict : addresses.every((a) => a.verdict === 'match') ? 'match' : 'same_region',
    addresses,
  };
}

/** The card's `endpoints.origin_addresses`, normalised (trimmed, IPv6 brackets removed); [] when none. */
export function declaredOrigins(card) {
  const listed = card?.endpoints?.origin_addresses;
  return Array.isArray(listed) ? listed.map((a) => String(a).trim().replace(/^\[|\]$/g, '')).filter(Boolean) : [];
}

/**
 * Check one node: resolve its API host, geolocate the first public IPv4, measure RTT from every
 * probe site, and compare with the declared country. Behind a CDN, also check the origin addresses
 * the card declares (`origin`).
 * opts: { selfSite: {site, lat, lon}, agents: [{site, lat, lon, url, token}], fetchImpl, resolve, rtt, probeOrigin,
 *         key (the credential the registry probes the node with), signed (whether its card's signature verified) }
 */
export async function checkNodeLocation(card, opts = {}) {
  let host = null;
  try { host = new URL(card?.endpoints?.openai).hostname; } catch { /* listing without an API */ }
  const declared = card?.node?.operator?.country ? String(card.node.operator.country).toUpperCase() : null;
  const out = { host, declared, checked_at: new Date().toISOString() };
  if (!host) return { ...out, verdict: 'unknown', reason: 'no API endpoint' };

  const ips = net.isIP(host) ? [host] : await (opts.resolve ?? ((h) => dns.resolve4(h)))(host).catch(() => []);
  const ip = ips.find((a) => !isPrivateHost(a));
  if (!ip) return { ...out, ips, verdict: 'unknown', reason: 'no public IPv4 address' };

  const front = await locateAddress(ip, declared, opts);
  const origin = front.verdict === 'cdn' ? await checkOrigins(card, host, declared, { ...opts, frontIp: ip }) : null;
  return { ...out, ips, ...front, ...(origin ? { origin } : {}) };
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

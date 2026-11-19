// Server-location checks: latency physics, country verdicts, and the registry wiring (no network:
// RIPEstat, DNS and RTT are injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry } from '@opennodes/registry';
import { inJurisdiction, serverCheckOf, validateCard } from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { locationSummary } from '../packages/registry/src/search.js';
import { passServerCheck } from './server-check.js';
import http from 'node:http';
import { assessLatency, countryVerdict, haversineKm, checkNodeLocation, parseSite, probeOrigin } from '../packages/registry/src/location.js';

const NUREMBERG = { site: 'DE-Nuremberg', lat: 49.4527, lon: 11.0783 };
const HELSINKI = { site: 'FI-Helsinki', lat: 60.1719, lon: 24.9347 };
const MOSCOW = { lat: 55.7558, lon: 37.6173 };

test('latency physics: consistent, too fast, too slow', () => {
  assert.ok(Math.abs(haversineKm(NUREMBERG, HELSINKI) - 1480) < 30);
  // Helsinki node measured from both sites: plausible
  assert.equal(assessLatency([{ ...NUREMBERG, rtt_ms: 24 }, { ...HELSINKI, rtt_ms: 0.8 }], HELSINKI).verdict, 'consistent');
  // claims Moscow but answers Nuremberg in 2 ms: physically impossible (Moscow is ~1,900 km away)
  assert.equal(assessLatency([{ ...NUREMBERG, rtt_ms: 2 }], MOSCOW).verdict, 'too_fast');
  // claims Nuremberg but is far slower than distance explains from every site
  assert.equal(assessLatency([{ ...NUREMBERG, rtt_ms: 140 }, { ...HELSINKI, rtt_ms: 160 }], NUREMBERG).verdict, 'too_slow');
  assert.equal(assessLatency([], NUREMBERG).verdict, 'unknown');
  assert.deepEqual(parseSite('FI Helsinki 60.17 24.93 https://h.example/onp-probe'), { site: 'FI-Helsinki', lat: 60.17, lon: 24.93, url: 'https://h.example/onp-probe' });
});

test('country verdicts', () => {
  assert.equal(countryVerdict('DE', { country: 'DE' }), 'match');
  assert.equal(countryVerdict('DE', { country: 'FI' }), 'same_region');
  assert.equal(countryVerdict('DE', { country: 'RU' }), 'mismatch');
  assert.equal(countryVerdict('DE', { country: 'US', cdn: true }), 'cdn');
  assert.equal(countryVerdict(null, { country: 'DE' }), 'unknown');
});

/** A fake RIPEstat keyed by IP: { ip: { country, lat, lon, asn } } */
function fakeRipestat(table) {
  return async (url) => {
    const u = new URL(url);
    const resource = u.searchParams.get('resource');
    const row = table[resource];
    const json = (data) => ({ ok: true, json: async () => ({ data }) });
    if (u.pathname.includes('maxmind-geo-lite')) {
      return json(row ? { located_resources: [{ locations: [{ country: row.country, city: row.city ?? '', latitude: row.lat, longitude: row.lon, covered_percentage: 100 }] }] } : {});
    }
    if (u.pathname.includes('network-info')) return json(row ? { asns: [String(row.asn)], prefix: `${resource}/24` } : {});
    if (u.pathname.includes('as-overview')) return json({ holder: 'Example Hosting' });
    return { ok: false, status: 404 };
  };
}

test('checkNodeLocation: a node declared German but served from Moscow is a mismatch', async () => {
  const card = { node: { operator: { country: 'DE' } }, endpoints: { openai: 'https://api.eu-ai.example/v1' } };
  const result = await checkNodeLocation(card, {
    resolve: async () => ['198.51.100.7'],
    fetchImpl: fakeRipestat({ '198.51.100.7': { country: 'RU', ...MOSCOW, asn: 64500 } }),
    selfSite: NUREMBERG, rtt: async () => 48,
  });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.server.country, 'RU');
  assert.equal(result.latency.verdict, 'consistent', 'RTT fits the geolocated point');

  // behind Cloudflare: no location claim either way
  const cdn = await checkNodeLocation(card, {
    resolve: async () => ['198.51.100.8'],
    fetchImpl: fakeRipestat({ '198.51.100.8': { country: 'US', lat: 37.75, lon: -97.82, asn: 13335 } }),
  });
  assert.equal(cdn.verdict, 'cdn');
  assert.equal(cdn.server.network, 'Cloudflare');
});

test('registry: location check is stored, shown, and excludes a mislocated node from the EEA filter', async (t) => {
  const registry = await startRegistry({
    allowPrivateTargets: true,
    location: {
      firstDelayMs: 3_600_000,   // no automatic sweep during the test
      resolve: async (host) => (host === 'api.berget.ai' ? ['198.51.100.20'] : ['198.51.100.21']),
      fetchImpl: fakeRipestat({
        '198.51.100.20': { country: 'SE', lat: 59.33, lon: 18.06, asn: 64501 },
        '198.51.100.21': { country: 'RU', ...MOSCOW, asn: 64502 },
      }),
      selfSite: NUREMBERG, rtt: async () => 30,
    },
  });
  t.after(() => registry.close());
  const post = (path, body) => fetch(`${registry.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const model = { m: { id: 'm', name: 'M', cost: { input: 0.1, output: 0.2 } } };
  await post('/v0/import/models-dev', { catalog: {
    berget: { id: 'berget', name: 'Berget AI', api: 'https://api.berget.ai/v1', models: model },
    scaleway: { id: 'scaleway', name: 'Scaleway', api: 'https://api.scaleway.ai/v1', models: model },
  } });
  const ids = async (qs) => (await (await fetch(`${registry.origin}/v0/offerings?${qs}`)).json()).offerings.map((o) => o.node_id).sort();
  assert.deepEqual(await ids('jurisdiction=eea'), ['import.modelsdev.berget', 'import.modelsdev.scaleway']);

  const located = await (await post('/v0/admin/nodes/import.modelsdev.berget/locate')).json();
  assert.equal(located.verdict, 'match');
  const mis = await (await post('/v0/admin/nodes/import.modelsdev.scaleway/locate')).json();
  assert.equal(mis.verdict, 'mismatch');

  // the check is visible in node detail and search, and the EEA filter now drops the mislocated one
  const detail = await (await fetch(`${registry.origin}/v0/nodes/import.modelsdev.scaleway`)).json();
  assert.equal(detail.location.server.country, 'RU');
  assert.deepEqual(await ids('jurisdiction=eea'), ['import.modelsdev.berget']);
  const berget = (await (await fetch(`${registry.origin}/v0/offerings?q=berget`)).json()).offerings[0];
  assert.equal(berget.jurisdiction.location.verdict, 'match');
  assert.equal(inJurisdiction(berget, 'eea'), true);
});

test('declared origin addresses: behind a CDN, each declared origin must serve the API host and is located instead', async () => {
  const CF = { country: 'US', lat: 37.75, lon: -97.82, asn: 13335 };
  const table = {
    '198.51.100.8': CF,                                                      // the CDN front
    '198.51.100.30': { country: 'FR', lat: 48.86, lon: 2.35, asn: 64510 },   // Paris
    '198.51.100.31': { country: 'DE', lat: 50.11, lon: 8.68, asn: 64511 },   // Frankfurt
    '198.51.100.32': { country: 'RU', ...MOSCOW, asn: 64512 },
    '198.51.100.33': CF,                                                     // an "origin" that is a CDN edge itself
  };
  const calls = [];
  const opts = (extra = {}) => ({
    resolve: async (h) => ({ 'api.lab.example': ['198.51.100.8'], 'api.plain.example': ['198.51.100.30'],
      'origin-de.lab.example': ['198.51.100.31'], 'inside.lab.example': ['10.1.2.3'] }[h] ?? []),
    fetchImpl: fakeRipestat(table), selfSite: NUREMBERG,
    rtt: async (ip) => (ip === '198.51.100.32' ? 45 : 12),
    probeOrigin: async (ip, host, target) => { calls.push({ ip, host, ...target }); return { ok: true, status: 200 }; },
    ...extra,
  });
  const card = (origins, { api = 'https://api.lab.example/v1', health = 'https://api.lab.example/onp/health' } = {}) =>
    ({ node: { operator: { country: 'FR' } }, endpoints: { openai: api, health, ...(origins ? { origin_addresses: origins } : {}) } });

  const ok = await checkNodeLocation(card(['198.51.100.30', 'origin-de.lab.example']), opts());
  assert.equal(ok.verdict, 'cdn', 'the front keeps its own verdict');
  assert.equal(ok.origin.verdict, 'same_region', 'FR matches the declared country, DE is in the EEA with it');
  assert.deepEqual(ok.origin.declared, ['198.51.100.30', 'origin-de.lab.example']);
  assert.deepEqual(ok.origin.addresses.map((a) => [a.address, a.ip, a.serves, a.verdict]),
    [['198.51.100.30', '198.51.100.30', true, 'match'], ['origin-de.lab.example', '198.51.100.31', true, 'same_region']]);
  assert.deepEqual(calls[0], { ip: '198.51.100.30', host: 'api.lab.example', path: '/onp/health' }, 'asked for the API host, at the address itself');
  assert.equal(serverCheckOf({ jurisdiction: { location: locationSummary(ok, card(['198.51.100.30', 'origin-de.lab.example'])) } }), 'passed_origin');

  // health on another host: the API path is asked instead
  calls.length = 0;
  await checkNodeLocation(card(['198.51.100.30'], { health: 'https://status.lab.example/health' }), opts());
  assert.deepEqual(calls[0], { ip: '198.51.100.30', host: 'api.lab.example', path: '/v1/models' });
  // a card-only listing's health is often {openai}/models, which answers 401 without a key: the certificate binds, not the status
  const keyed = await checkNodeLocation(card(['198.51.100.30'], { health: 'https://api.lab.example/v1/models' }), opts({
    probeOrigin: async (ip, host, target) => { calls.push({ ip, host, ...target }); return { ok: true, status: 401 }; } }));
  assert.equal(keyed.origin.verdict, 'match');
  assert.equal(calls.at(-1).path, '/v1/models');

  // an address that does not serve the API host (e.g. no certificate for it) fails, and so does the whole check
  const noCert = await checkNodeLocation(card(['198.51.100.30', 'origin-de.lab.example']), opts({
    probeOrigin: async (ip) => (ip === '198.51.100.31' ? { ok: false, reason: 'certificate not valid for api.lab.example' } : { ok: true, status: 200 }) }));
  assert.equal(noCert.origin.verdict, 'unknown');
  assert.match(noCert.origin.addresses[1].reason, /does not serve api\.lab\.example: certificate not valid/);

  // an origin on a CDN network says nothing either; one located outside is a mismatch
  assert.equal((await checkNodeLocation(card(['198.51.100.33']), opts())).origin.verdict, 'cdn');
  const moscow = await checkNodeLocation(card(['198.51.100.32']), opts());
  assert.equal(moscow.origin.verdict, 'mismatch');
  assert.equal(moscow.origin.addresses[0].server_country, 'RU');

  // private addresses are never contacted
  calls.length = 0;
  const inside = await checkNodeLocation(card(['inside.lab.example', '10.0.0.5', '::1', '169.254.169.254']), opts());
  assert.deepEqual(inside.origin.addresses.map((a) => a.reason), Array(4).fill('not a public address'));
  assert.equal(calls.length, 0);
  assert.equal((await checkNodeLocation(card(['nowhere.lab.example']), opts())).origin.addresses[0].reason, 'does not resolve');

  // at most four addresses; and origins are checked only behind a CDN
  const many = await checkNodeLocation(card(['198.51.100.30', '198.51.100.31', '198.51.100.34', '198.51.100.35', '198.51.100.36']), opts());
  assert.equal(many.origin.verdict, 'unknown');
  assert.match(many.origin.reason, /more than 4/);
  const plain = await checkNodeLocation(card(['198.51.100.31'], { api: 'https://api.plain.example/v1' }), opts());
  assert.equal(plain.verdict, 'match');
  assert.equal(plain.origin, undefined, 'a located front needs no origin');
  assert.equal((await checkNodeLocation(card(null), opts())).origin, undefined, 'no origin declared: none checked');
});

test('a server check applies only to the card it was made for: same API host, declared country and origin addresses', async (t) => {
  const card = (patch = {}) => ({ node: { operator: { country: patch.country ?? 'DE' } },
    endpoints: { openai: patch.api ?? 'https://api.a.example/v1', ...(patch.origins === null ? {} : { origin_addresses: patch.origins ?? ['198.51.100.30'] }) } });
  const stored = {
    host: 'api.a.example', declared: 'DE', checked_at: '2026-11-19T00:00:00.000Z', verdict: 'cdn',
    server: { country: 'US', cdn: true, network: 'Cloudflare' }, latency: { verdict: 'unknown' },
    origin: { declared: ['198.51.100.30'], verdict: 'match', addresses: [{ address: '198.51.100.30', verdict: 'match', server_country: 'DE', server: { network: 'Example' }, latency: { verdict: 'consistent' } }] },
  };
  const level = (c) => serverCheckOf({ jurisdiction: { location: locationSummary(stored, c) } });
  assert.equal(level(card()), 'passed_origin');
  assert.deepEqual(locationSummary(stored, card()).origin.addresses, [{ address: '198.51.100.30', verdict: 'match', server_country: 'DE', network: 'Example', latency: 'consistent' }]);
  assert.equal(level(card({ api: 'https://api.elsewhere.example/v1' })), 'unchecked');
  assert.equal(locationSummary(stored, card({ api: 'https://api.elsewhere.example/v1' })).reason, 'the API host changed since this check');
  assert.equal(level(card({ country: 'FR' })), 'unchecked', 'the verdict compared another declared country');
  assert.equal(level(card({ origins: ['198.51.100.99'] })), 'cdn', 'new origin addresses are not checked yet');
  assert.equal(locationSummary(stored, card({ origins: ['198.51.100.99'] })).origin.reason, 'the declared origin addresses changed since this check');
  assert.equal(level(card({ origins: null })), 'cdn', 'origins no longer declared: the old result does not count');

  // the registry: a check made for another host does not count, and a refresh checks the new host at once
  const node = await startFixtureNode({ lineage: ['FR'] });
  const registry = await startRegistry({ allowPrivateTargets: true, location: { firstDelayMs: 3_600_000, fetchImpl: fakeRipestat({}), rtt: async () => null } });
  t.after(async () => { await node.close(); await registry.close(); });
  const FIXTURE = 'org.opennodes.fixture';
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }) })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  const current = async () => (await registry.store.getObservations(FIXTURE, '_node')).location;
  const until = async (ok) => { for (let i = 0; i < 100 && !ok(await current()); i++) await new Promise((r) => setTimeout(r, 20)); return current(); };
  assert.equal((await until((l) => l)).reason, 'no public IPv4 address', 'checked after registration (loopback cannot be located)');
  const offering = async () => (await (await fetch(`${registry.origin}/v0/offerings?q=echo`)).json()).offerings[0];

  await passServerCheck(registry, FIXTURE);
  assert.equal((await offering()).jurisdiction.server_check, 'passed');
  assert.equal((await (await fetch(`${registry.origin}/v0/nodes/${FIXTURE}`)).json()).server_check, 'passed');
  await registry.store.setObservation(FIXTURE, '_node', 'location', { ...(await current()), host: 'old-api.example' });
  assert.equal((await offering()).jurisdiction.server_check, 'unchecked');
  assert.equal((await offering()).jurisdiction.location.reason, 'the API host changed since this check');
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  assert.equal((await until((l) => l.host !== 'old-api.example')).host, '127.0.0.1', 'the refresh checked the current host');

  // a refresh with nothing changed does not check again
  await passServerCheck(registry, FIXTURE);
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await current()).verdict, 'match');
});

test('probeOrigin: only a TLS server that answers for the API host counts', async (t) => {
  // nothing listening
  const closed = await probeOrigin('127.0.0.1', 'api.lab.example', { port: 9, timeoutMs: 2000 });
  assert.equal(closed.ok, false);
  // a plain HTTP server: no TLS handshake, so no certificate for the host
  const plain = http.createServer((req, res) => res.end('{"status":"ok"}'));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  t.after(() => plain.close());
  const result = await probeOrigin('127.0.0.1', 'api.lab.example', { port: plain.address().port, path: '/onp/health', timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('card schema: endpoints.origin_addresses and the dated data-policy link are optional, and bounded', () => {
  const card = (endpoints = {}, dataPolicy = {}) => ({
    onp: '0.1', revision: '2026-11-19T00:00:00Z',
    node: { id: 'ai.example.lab', name: 'Lab', operator: { name: 'Lab', country: 'FR' } },
    endpoints: { openai: 'https://api.example.ai/v1', health: 'https://api.example.ai/onp/health', ...endpoints },
    offerings: [{ offering_id: 'm', modality: 'text', model: { name: 'M', artifact: 'hf:example/m' },
      binding: { profile: 'onp.openai.chat/v1', model_id: 'm' }, serving: { context_window: 8192, supports: ['streaming'] },
      pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 2, schemes: ['prepaid'] },
      data_policy: { retention: 'none', training_on_inputs: false, ...dataPolicy } }],
    payment: { schemes: [{ scheme: 'prepaid' }] },
  });
  assert.deepEqual(validateCard(card()), []);
  assert.deepEqual(validateCard(card({ origin_addresses: ['203.0.113.10', 'origin.example.ai'] },
    { source: 'https://example.ai/privacy', checked: '2026-11-19' })), []);
  assert.notDeepEqual(validateCard(card({ origin_addresses: ['a', 'b', 'c', 'd', 'e'] })), [], 'at most four origins');
  assert.notDeepEqual(validateCard(card({ origin_addresses: [] })), [], 'an empty list declares nothing');
  assert.notDeepEqual(validateCard(card({}, { checked: 'last week' })), [], 'checked is a date');
});

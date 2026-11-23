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
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { assessLatency, countryVerdict, haversineKm, checkNodeLocation, parseSite, probeOrigin, modelIds } from '../packages/registry/src/location.js';

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

test('declared origin addresses: behind a CDN, each declared origin must answer the API like the CDN and is located instead', async () => {
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
    probeOrigin: async (ip, host, target) => { calls.push({ ip, host, ...target }); return { ok: true, status: 200, models: LIST }; },
    ...extra,
  });
  const LIST = ['bielik-1.5b', 'llama3.2:1b'];
  const card = (origins, { api = 'https://api.lab.example/v1', health = 'https://api.lab.example/onp/health' } = {}) =>
    ({ node: { operator: { country: 'FR' } }, endpoints: { openai: api, health, ...(origins ? { origin_addresses: origins } : {}) } });

  const ok = await checkNodeLocation(card(['198.51.100.30', 'origin-de.lab.example']), opts());
  assert.equal(ok.verdict, 'cdn', 'the front keeps its own verdict');
  assert.equal(ok.origin.verdict, 'same_region', 'FR matches the declared country, DE is in the EEA with it');
  assert.deepEqual(ok.origin.declared, ['198.51.100.30', 'origin-de.lab.example']);
  assert.deepEqual(ok.origin.addresses.map((a) => [a.address, a.ip, a.serves, a.verdict]),
    [['198.51.100.30', '198.51.100.30', true, 'match'], ['origin-de.lab.example', '198.51.100.31', true, 'same_region']]);
  assert.deepEqual(calls.slice(0, 2), [
    { ip: '198.51.100.8', host: 'api.lab.example', path: '/v1/models', headers: {} },
    { ip: '198.51.100.30', host: 'api.lab.example', path: '/v1/models', headers: {} },
  ], 'the model list through the CDN first, then the same request at each address itself');
  assert.deepEqual(ok.origin.front, { status: 200, models: 2 });
  assert.equal(ok.origin.signed, true);
  assert.equal(serverCheckOf({ jurisdiction: { location: locationSummary(ok, card(['198.51.100.30', 'origin-de.lab.example'])) } }), 'passed_origin');

  // the declaration counts only in a signed card: nothing is contacted for an unsigned one
  calls.length = 0;
  const unsigned = await checkNodeLocation(card(['198.51.100.30']), opts({ signed: false }));
  assert.equal(unsigned.origin.verdict, 'unknown');
  assert.match(unsigned.origin.reason, /only in a signed card/);
  assert.equal(calls.length, 0);
  assert.equal(serverCheckOf({ jurisdiction: { location: locationSummary(unsigned, card(['198.51.100.30'])) } }), 'cdn');

  // a keyed API: with no list through the CDN there is nothing to compare, so the check fails;
  // with the key the registry probes with, the same request carries it to the front and to each origin
  const keyedApi = async (ip, host, target) => {
    calls.push({ ip, host, ...target });
    return target.headers.authorization === 'Bearer k-123' ? { ok: true, status: 200, models: LIST } : { ok: true, status: 401, models: null };
  };
  const noKey = await checkNodeLocation(card(['198.51.100.30']), opts({ probeOrigin: keyedApi }));
  assert.equal(noKey.origin.verdict, 'unknown');
  assert.match(noKey.origin.reason, /no model list through the CDN \(HTTP 401\)/);
  calls.length = 0;
  const keyed = await checkNodeLocation(card(['198.51.100.30']), opts({ probeOrigin: keyedApi, key: 'k-123' }));
  assert.equal(keyed.origin.verdict, 'match');
  assert.deepEqual(calls.map((c) => [c.ip, c.headers.authorization]), [['198.51.100.8', 'Bearer k-123'], ['198.51.100.30', 'Bearer k-123']]);
  assert.equal(JSON.stringify(keyed).includes('k-123'), false, 'the key is never stored with the result');

  // an origin that holds a certificate for the host but does not answer the API (a 401 or 404, or a page
  // that is no model list), or lists other models, fails, and so does the whole check
  const answering = (byIp) => async (ip) => byIp[ip] ?? { ok: true, status: 200, models: LIST };
  for (const [answer, reason] of [
    [{ ok: true, status: 404, models: null }, /does not answer like the API through the CDN \(HTTP 404\)/],
    [{ ok: true, status: 401, models: null }, /HTTP 401/],
    [{ ok: true, status: 200, models: null }, /HTTP 200, no model list/],
    [{ ok: true, status: 200, models: ['llama3.2:1b'] }, /lists other models than the API through the CDN \(1 missing, 0 more\)/],
    [{ ok: true, status: 200, models: [...LIST, 'gpt-4o'] }, /\(0 missing, 1 more\)/],
  ]) {
    const decoy = await checkNodeLocation(card(['198.51.100.30', 'origin-de.lab.example']), opts({ probeOrigin: answering({ '198.51.100.31': answer }) }));
    assert.equal(decoy.origin.verdict, 'unknown');
    assert.equal(decoy.origin.addresses[0].verdict, 'match');
    assert.match(decoy.origin.addresses[1].reason, reason);
    assert.equal(decoy.origin.addresses[1].server, undefined, 'not located: it does not serve the API');
  }
  // the front's own answer decides what counts: an empty list is nothing to compare with
  assert.match((await checkNodeLocation(card(['198.51.100.30']), opts({ probeOrigin: answering({ '198.51.100.8': { ok: true, status: 200, models: [] } }) }))).origin.reason, /an empty list/);

  // an address that does not serve the API host (e.g. no certificate for it) fails, and so does the whole check
  const noCert = await checkNodeLocation(card(['198.51.100.30', 'origin-de.lab.example']), opts({
    probeOrigin: answering({ '198.51.100.31': { ok: false, reason: 'certificate not valid for api.lab.example' } }) }));
  assert.equal(noCert.origin.verdict, 'unknown');
  assert.match(noCert.origin.addresses[1].reason, /does not serve api\.lab\.example: certificate not valid/);

  // an origin on a CDN network says nothing either; one located outside is a mismatch
  assert.equal((await checkNodeLocation(card(['198.51.100.33']), opts())).origin.verdict, 'cdn');
  const moscow = await checkNodeLocation(card(['198.51.100.32']), opts());
  assert.equal(moscow.origin.verdict, 'mismatch');
  assert.equal(moscow.origin.addresses[0].server_country, 'RU');

  // private addresses are never contacted (only the front is asked)
  calls.length = 0;
  const inside = await checkNodeLocation(card(['inside.lab.example', '10.0.0.5', '::1', '169.254.169.254']), opts());
  assert.deepEqual(inside.origin.addresses.map((a) => a.reason), Array(4).fill('not a public address'));
  assert.deepEqual(calls.map((c) => c.ip), ['198.51.100.8']);
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

test('modelIds: the ids of an OpenAI-style model list, or null', () => {
  assert.deepEqual(modelIds('{"object":"list","data":[{"id":"b"},{"id":"a"},{"id":"b"},{"id":""},{"name":"x"}]}'), ['a', 'b']);
  assert.deepEqual(modelIds('{"data":[]}'), []);
  assert.equal(modelIds('{"status":"ok"}'), null);
  assert.equal(modelIds('<html>not found</html>'), null);
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

const OPENSSL = spawnSync('openssl', ['version']).status === 0;
test('probeOrigin over TLS: the certificate, the credential and the model list', { skip: !OPENSSL && 'needs openssl to make a test certificate' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onp-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const certFor = (name) => {
    const key = path.join(dir, `${name}.key`), crt = path.join(dir, `${name}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-keyout', key, '-out', crt, '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  };
  const api = certFor('api.lab.example'), other = certFor('other.example');
  const serve = async (creds, handler) => {
    const server = https.createServer(creds, handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    return server.address().port;
  };
  const seen = [];
  const port = await serve(api, (req, res) => {
    seen.push({ host: req.headers.host, auth: req.headers.authorization ?? null, path: req.url });
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer k-1') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm2' }, { id: 'm1' }] }));
    if (req.url === '/v1/models') { res.writeHead(401); return res.end('{"error":"a key is needed"}'); }
    if (req.url === '/big') return res.end(`{"data":[${'{"id":"x"},'.repeat(120_000)}{"id":"y"}]}`);
    if (req.url === '/drip') {   // headers at once, then a byte every 100 ms: never idle, never done
      res.writeHead(200, { 'content-type': 'application/json' });
      const drip = setInterval(() => res.write(' '), 100);
      return res.on('close', () => clearInterval(drip));
    }
    res.writeHead(404); res.end('not found');
  });
  const ask = (p, extra = {}) => probeOrigin('127.0.0.1', 'api.lab.example', { port, path: p, ca: api.cert, timeoutMs: 5000, ...extra });
  assert.deepEqual(await ask('/v1/models', { headers: { authorization: 'Bearer k-1' } }), { ok: true, status: 200, models: ['m1', 'm2'] });
  assert.deepEqual(seen.at(-1), { host: 'api.lab.example', auth: 'Bearer k-1', path: '/v1/models' }, 'asked as the API host, with the credential');
  assert.deepEqual(await ask('/v1/models'), { ok: true, status: 401, models: null });
  assert.deepEqual(await ask('/nothing'), { ok: true, status: 404, models: null });
  assert.equal((await ask('/big')).models, null, 'an over-long answer is no list');
  const started = Date.now();
  assert.deepEqual(await ask('/drip', { timeoutMs: 600 }), { ok: false, reason: 'timed out' });
  assert.ok(Date.now() - started < 3000, 'a dripping answer is cut off at the deadline');

  // a certificate for another name fails before anything is sent, so the credential never leaves
  const sent = [];
  const otherPort = await serve(other, (req, res) => { sent.push(req.headers.authorization); res.end('{"data":[]}'); });
  const wrong = await probeOrigin('127.0.0.1', 'api.lab.example', { port: otherPort, path: '/v1/models', ca: other.cert, headers: { authorization: 'Bearer k-1' }, timeoutMs: 5000 });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'certificate not valid for api.lab.example');
  assert.deepEqual(sent, []);
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

test('declared origins must also reply to a private identity prompt as the API does through the CDN', async () => {
  const CF = { country: 'US', lat: 37.75, lon: -97.82, asn: 13335 };
  const table = { '198.51.100.8': CF, '198.51.100.30': { country: 'FR', lat: 48.86, lon: 2.35, asn: 64510 } };
  const LIST = ['bielik-1.5b', 'llama3.2:1b'];
  const PROMPT = 'Which metal is liquid at room temperature?';
  const card = (origins) => ({
    node: { operator: { country: 'FR' } },
    endpoints: { openai: 'https://api.lab.example/v1', health: 'https://api.lab.example/onp/health', origin_addresses: origins },
    offerings: [{ offering_id: 'small', binding: { model_id: 'llama3.2:1b' } }],
  });
  const calls = [];
  const api = (replies) => async (ip, host, target) => {
    calls.push({ ip, post: Boolean(target.body), path: target.path, body: target.body ?? null });
    if (!target.body) return { ok: true, status: 200, models: LIST };
    const reply = replies[ip];
    return { ok: true, status: 200, models: null, text: typeof reply === 'function' ? reply() : reply };
  };
  const opts = (probeOrigin, extra = {}) => ({
    resolve: async (h) => ({ 'api.lab.example': ['198.51.100.8'] }[h] ?? []),
    fetchImpl: fakeRipestat(table), selfSite: NUREMBERG, rtt: async () => 12, probeOrigin, identityPrompt: PROMPT, ...extra,
  });

  // the same reply through the CDN and at the origin: passes, each asked once, like Stage B
  const same = await checkNodeLocation(card(['198.51.100.30']), opts(api({ '198.51.100.8': 'Mercury.', '198.51.100.30': 'Mercury.' })));
  assert.equal(same.origin.verdict, 'match');
  assert.equal(same.origin.identity, 'compared');
  assert.deepEqual(same.origin.addresses[0].identity, { same: true, retried: false });
  const posts = calls.filter((c) => c.post);
  assert.deepEqual(posts.map((c) => c.ip), ['198.51.100.8', '198.51.100.30'], 'through the CDN first, then at the origin');
  assert.equal(posts[0].path, '/v1/chat/completions');
  assert.equal(posts[0].body.model, 'llama3.2:1b', "the card's offering that the API lists");
  assert.equal(posts[0].body.temperature, 0);
  assert.equal(posts[0].body.messages[0].content, PROMPT);
  const stored = JSON.stringify(same);
  assert.equal(stored.includes(PROMPT) || stored.includes('Mercury'), false, 'neither the prompt nor the replies are kept');

  // a decoy that copies the model list but runs another model fails, and is not located
  const decoy = await checkNodeLocation(card(['198.51.100.30']), opts(api({ '198.51.100.8': 'Mercury.', '198.51.100.30': 'The metal is mercury.' })));
  assert.equal(decoy.origin.verdict, 'unknown');
  assert.match(decoy.origin.addresses[0].reason, /replies to a private identity prompt differently from the API through the CDN/);
  assert.deepEqual(decoy.origin.addresses[0].identity, { same: false, retried: true });
  assert.equal(decoy.origin.addresses[0].server, undefined);

  // a one-off difference (two servers can differ now and then at temperature 0) is asked once more and passes
  let asked = 0;
  const flaky = await checkNodeLocation(card(['198.51.100.30']), opts(api({ '198.51.100.8': 'Mercury.', '198.51.100.30': () => (asked++ === 0 ? 'Mercury!' : 'Mercury.') })));
  assert.equal(flaky.origin.verdict, 'match');
  assert.deepEqual(flaky.origin.addresses[0].identity, { same: true, retried: true });

  // no reply through the CDN: nothing to compare with, so the check fails before any origin is asked
  calls.length = 0;
  const noFront = await checkNodeLocation(card(['198.51.100.30']), opts(api({ '198.51.100.8': null, '198.51.100.30': 'Mercury.' })));
  assert.equal(noFront.origin.verdict, 'unknown');
  assert.match(noFront.origin.reason, /no reply through the CDN/);
  assert.equal(calls.some((c) => c.ip === '198.51.100.30'), false);

  // an origin that does not reply to a chat request fails
  const silent = await checkNodeLocation(card(['198.51.100.30']), opts(api({ '198.51.100.8': 'Mercury.', '198.51.100.30': null })));
  assert.match(silent.origin.addresses[0].reason, /does not reply to a chat request like the API through the CDN/);

  // without a prompt (a registry with no corpus at hand) only the model list is compared, as before
  const listOnly = await checkNodeLocation(card(['198.51.100.30']), opts(api({}), { identityPrompt: undefined }));
  assert.equal(listOnly.origin.verdict, 'match');
  assert.equal(listOnly.origin.identity, 'not compared');
});

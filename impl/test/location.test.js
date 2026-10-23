// Server-location checks: latency physics, country verdicts, and the registry wiring (no network:
// RIPEstat, DNS and RTT are injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry } from '@opennodes/registry';
import { inJurisdiction } from '@opennodes/core';
import { assessLatency, countryVerdict, haversineKm, checkNodeLocation, parseSite } from '../packages/registry/src/location.js';

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

// Where models run (ONP-2 §3a, ONP-3 §5c): location fields with an evidence basis, the curated
// seed, the per-provider OpenRouter importer, residency search over serving sites, and the
// /v0/locations report (JSON, CSV, GeoJSON, MCP), map points and distance queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCard, servingLocations, residencyCodes, basisRank, pointFor, distanceKm, parsePoint,
} from '@opennodes/core';
import { startRegistry } from '@opennodes/registry';

const card = (over = {}, offeringOver = {}) => ({
  onp: '0.1',
  revision: '2026-11-02T00:00:00Z',
  node: { id: 'ca.example.node', name: 'Example', operator: { name: 'Example Inc.', country: 'CA' } },
  endpoints: { openai: 'https://node.example.ca/v1', health: 'https://node.example.ca/onp/health' },
  offerings: [{
    offering_id: 'm1', modality: 'text',
    model: { name: 'M1', artifact: 'hf:example/m1' },
    serving: {},
    binding: { profile: 'onp.openai.chat/v1', model_id: 'm1' },
    pricing: { currency: 'CAD', schemes: ['prepaid'] },
    ...offeringOver,
  }],
  payment: { schemes: [{ scheme: 'prepaid' }] },
  ...over,
});
const site = (over = {}) => ({ region: 'CA-QC', site: 'Montréal', basis: 'documented', source: 'https://example.ca/dc', checked: '2026-11-02', ...over });

const get = async (origin, path) => (await fetch(`${origin}${path}`)).json();
const post = async (origin, path, body) => (await fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

test('location fields validate; documented needs a source and a date; lineage is ISO alpha-2', () => {
  assert.deepEqual(validateCard(card({ node: { ...card().node, locations: [site(), site({ region: 'CA-ON', status: 'planned', basis: 'claimed', source: undefined, checked: undefined })] } })), []);
  assert.ok(validateCard(card({ node: { ...card().node, locations: [site({ source: undefined })] } })).some((e) => /source/.test(e)));
  assert.ok(validateCard(card({ node: { ...card().node, locations: [{ site: 'Rimouski', basis: 'claimed' }] } })).some((e) => /region/.test(e)));
  assert.deepEqual(validateCard(card({}, { model: { name: 'M1', artifact: 'hf:example/m1', lineage_origins: ['US', 'FR'] } })), []);
  assert.ok(validateCard(card({}, { model: { name: 'M1', artifact: 'hf:example/m1', lineage_origins: ['china'] } })).length > 0);
});

test('serving locations: offering overrides node, empty list is unknown, planned and unknown status excluded', () => {
  const c = card({ node: { ...card().node, regions: ['CA'], locations: [site(), site({ region: 'CA-BC', status: 'planned' })] } });
  const o = c.offerings[0];
  assert.deepEqual(servingLocations(o, c).map((l) => l.region), ['CA-QC']);
  assert.deepEqual(servingLocations({ ...o, locations: [site({ region: 'US' })] }, c).map((l) => l.region), ['US']);
  assert.deepEqual(servingLocations({ ...o, locations: [] }, c), []);
  assert.deepEqual(servingLocations({ ...o, locations: [site({ status: 'retired' })] }, c), []);
  // residency covers pins and live sites; falls back to node regions only when both are absent
  assert.deepEqual(residencyCodes({ ...o, data_policy: { region_pinning: ['CA'] } }, c), ['CA', 'CA-QC']);
  assert.deepEqual(residencyCodes({ ...o, locations: [] }, c), ['CA']);
  assert.ok(basisRank('attested') > basisRank('measured') && basisRank('measured') > basisRank('documented'));
  assert.equal(basisRank('rumour'), basisRank('claimed'));
});

test('curated seed: /v0/locations by country, evidence, status, model and lineage; CSV', async (t) => {
  const registry = await startRegistry({ locationSeeds: true });
  t.after(() => registry.close());

  const ca = await get(registry.origin, '/v0/locations?country=CA');
  assert.ok(ca.sites.length >= 15);
  assert.ok(ca.sites.every((s) => s.country === 'CA'));
  const bedrock = ca.sites.find((s) => s.node_id === 'import.seed.ca.aws-bedrock' && s.region === 'CA-QC');
  assert.equal(bedrock.basis, 'documented');
  assert.ok(bedrock.models.some((m) => m.name === 'Claude 3 Haiku'));
  const calgary = ca.sites.find((s) => s.node_id === 'import.seed.ca.aws-bedrock' && s.region === 'CA-AB');
  assert.deepEqual(calgary.models, []);                       // a site with no in-region model
  const telus = ca.sites.filter((s) => s.provider === 'TELUS Sovereign AI Factory');
  assert.equal(telus.length, 3);                              // site-only seed entry, no card
  assert.equal(telus[0].source, 'seed');
  assert.match(telus[0].models_note, /not published/);
  assert.ok(!ca.sites.some((s) => s.region === 'US'));        // Cohere's US API site is not in Canada

  const live = await get(registry.origin, '/v0/locations?country=CA&status=planned');
  assert.ok(live.sites.length >= 3 && live.sites.every((s) => s.status === 'planned'));
  const documented = await get(registry.origin, '/v0/locations?country=CA&basis=documented');
  assert.ok(documented.sites.every((s) => ['documented', 'measured', 'attested'].includes(s.basis)));
  assert.ok(!documented.sites.some((s) => s.provider.startsWith('Azure')));   // Azure is claimed

  const qwen = (r) => r.sites.flatMap((s) => s.models).filter((m) => /qwen/i.test(m.name));
  assert.ok(qwen(ca).length > 0);
  assert.equal(qwen(await get(registry.origin, '/v0/locations?country=CA&exclude_lineage=CN')).length, 0);
  const gptoss = await get(registry.origin, '/v0/locations?model=gpt-oss');
  assert.ok(gptoss.sites.length > 0 && gptoss.sites.every((s) => s.models.every((m) => /gpt-oss/.test(m.name))));
  assert.equal(ca.countries[0].country, 'CA');
  assert.ok(ca.summary.located_offerings > 0);

  const csv = await (await fetch(`${registry.origin}/v0/locations?country=CA&format=csv`)).text();
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^country,region,site,status,basis,provider/);
  assert.ok(lines.some((l) => l.includes('Claude 3 Haiku')));
  assert.ok(lines.some((l) => l.includes('TELUS') && l.includes('not published')));
});

test('search: region= covers serving sites; location_basis= and exclude_lineage= filters', async (t) => {
  const registry = await startRegistry({ locationSeeds: true });
  t.after(() => registry.close());

  const inCanada = (await get(registry.origin, '/v0/offerings?region=CA&limit=200')).offerings;
  const nodes = new Set(inCanada.map((o) => o.node_id));
  assert.ok(nodes.has('import.seed.ca.aws-bedrock'));
  assert.ok(!nodes.has('import.seed.ca.denvr-dataworks'));    // listed for Canadian and US sites
  assert.ok(!nodes.has('import.seed.ca.cohere'));             // hosted API in the US
  assert.ok(inCanada.every((o) => o.locations.length && o.residency.every((r) => r.startsWith('CA'))));

  const documented = (await get(registry.origin, '/v0/offerings?region=CA&location_basis=documented&limit=200')).offerings;
  assert.ok(documented.length > 0 && !documented.some((o) => o.node_id === 'import.seed.ca.azure-openai'));

  const all = (await get(registry.origin, '/v0/offerings?limit=200')).offerings;
  const noCn = (await get(registry.origin, '/v0/offerings?exclude_lineage=cn&limit=200')).offerings;
  assert.ok(all.some((o) => o.model.lineage_origins?.includes('CN')));
  assert.ok(!noCn.some((o) => o.model.lineage_origins?.includes('CN')));
  assert.ok(noCn.some((o) => o.model.name === 'North Mini Code'));   // undeclared lineage is kept
});

test('OpenRouter providers importer: declared datacenters, region tags, unlocated endpoints', async (t) => {
  const registry = await startRegistry();
  t.after(() => registry.close());

  const providers = [
    { name: 'Amazon Bedrock', slug: 'amazon-bedrock', headquarters: 'US', datacenters: ['US'] },
    { name: 'Nebius', slug: 'nebius', headquarters: 'NL', datacenters: ['FI', 'NL'] },
    { name: 'Google', slug: 'google-vertex', headquarters: null, datacenters: null },
    { name: 'Cohere', slug: 'cohere', headquarters: null, datacenters: [] },
  ];
  const models = [
    { id: 'openai/gpt-oss-120b', name: 'OpenAI: gpt-oss-120b', hugging_face_id: 'openai/gpt-oss-120b',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
    { id: 'cohere/command-a', name: 'Cohere: Command A', hugging_face_id: null,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ];
  const ep = (provider_name, tag, extra = {}) => ({ provider_name, tag, context_length: 131072, pricing: { prompt: '0.00000015', completion: '0.0000006' }, ...extra });
  const endpoints = {
    'openai/gpt-oss-120b': [
      ep('Amazon Bedrock', 'amazon-bedrock/eu-west-1'),
      ep('Amazon Bedrock', 'amazon-bedrock'),
      ep('Google', 'google-vertex/global'),
      ep('Nebius', 'nebius/fp4', { quantization: 'fp4' }),
    ],
    'cohere/command-a': [ep('Cohere', 'cohere')],
  };
  const result = await post(registry.origin, '/v0/import/openrouter-providers', { providers, models, endpoints });
  assert.deepEqual({ providers: result.providers, offerings: result.offerings, unlocated: result.unlocated }, { providers: 2, offerings: 3, unlocated: 2 });

  const bedrock = (await get(registry.origin, '/v0/nodes/import.openrouter.p.amazon-bedrock')).card;
  assert.equal(bedrock.node.operator.country, 'US');
  assert.deepEqual(bedrock.node.locations.map((l) => [l.region, l.basis]), [['US', 'claimed']]);
  assert.ok(!bedrock.endpoints.openai);                        // listing only
  const eu = bedrock.offerings.find((o) => o.offering_id.endsWith('eu-west-1'));
  assert.deepEqual(eu.locations.map((l) => l.region), ['IE']);

  const ie = await get(registry.origin, '/v0/locations?country=IE');
  assert.equal(ie.sites.length, 1);
  assert.equal(ie.sites[0].models[0].artifact, 'hf:openai/gpt-oss-120b');
  const nebius = (await get(registry.origin, '/v0/offerings?q=nebius')).offerings[0];
  assert.deepEqual(nebius.residency, ['FI', 'NL']);
  assert.equal(nebius.model.quantization, 'fp4');
  assert.equal((await get(registry.origin, '/v0/offerings?region=US&q=amazon-bedrock')).offerings.length, 1);
});

test('MCP find_locations serves the same report', async (t) => {
  const registry = await startRegistry({ locationSeeds: true });
  t.after(() => registry.close());
  const body = await post(registry.origin, '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'find_locations', arguments: { country: 'CA', model: 'cohere', basis: 'documented' } },
  });
  const report = body.result.structuredContent;
  assert.equal(body.result.isError, false);
  // Documented Cohere models in Canada: Embed and Rerank on Bedrock in Montréal, not Command.
  assert.deepEqual([...new Set(report.sites.map((s) => s.node_id))], ['import.seed.ca.aws-bedrock']);
  assert.ok(report.sites.every((s) => s.country === 'CA' && s.models.every((m) => /cohere/i.test(m.name))));
});

const MONTREAL = { lat: 45.5019, lon: -73.5674 };

test('geo: declared points win, region and country points are derived; distance and parsing', () => {
  assert.deepEqual(pointFor({ region: 'CA-QC', geo: { ...MONTREAL, precision: 'city' } }), { ...MONTREAL, precision: 'city', derived: false });
  assert.deepEqual(pointFor({ region: 'CA-QC' }), { lat: 52.94, lon: -73.55, precision: 'region', derived: true });
  assert.equal(pointFor({ region: 'CA-XX' }).precision, 'country');     // unknown subdivision: its country
  assert.equal(pointFor({ region: 'ZZ' }), null);
  assert.equal(pointFor({ region: 'CA', geo: { ...MONTREAL, precision: 'street' } }).precision, 'country');
  const toronto = { lat: 43.6532, lon: -79.3832 };
  assert.ok(Math.abs(distanceKm(MONTREAL, toronto) - 504) < 5);
  assert.deepEqual(parsePoint('45.5,-73.57'), { lat: 45.5, lon: -73.57 });
  assert.equal(parsePoint('91,0'), null);
  assert.equal(parsePoint('montreal'), null);
  assert.deepEqual(validateCard(card({ node: { ...card().node, locations: [site({ geo: { ...MONTREAL, precision: 'city' } })] } })), []);
  assert.ok(validateCard(card({ node: { ...card().node, locations: [site({ geo: { lat: 120, lon: 0, precision: 'city' } })] } })).length > 0);
});

test('/v0/locations: near + within_km, GeoJSON (RFC 7946 order), and the map setting', async (t) => {
  const registry = await startRegistry({ locationSeeds: true });
  t.after(() => registry.close());

  const near = await get(registry.origin, '/v0/locations?near=45.5019,-73.5674&within_km=300');
  const regions = near.sites.map((s) => s.region);
  assert.ok(near.sites.length >= 6 && regions.every((r) => r === 'CA-QC'));   // Montréal, Saint-Jérôme, Beauharnois, Québec City, Lévis
  assert.ok(near.sites[0].distance_km <= 1);
  assert.ok(near.sites.every((s, i) => i === 0 || near.sites[i - 1].distance_km <= s.distance_km));
  assert.ok(!near.sites.some((s) => s.geo.precision === 'country'));          // ThinkOn's "CA" is not 0 km away
  const sorted = await get(registry.origin, '/v0/locations?country=CA&near=49.28,-123.12');
  assert.equal(sorted.sites[0].site, 'Vancouver');
  assert.equal((await fetch(`${registry.origin}/v0/locations?near=north`)).status, 400);
  assert.equal((await fetch(`${registry.origin}/v0/locations?within_km=50`)).status, 400);

  const res = await fetch(`${registry.origin}/v0/locations?country=CA&format=geojson`);
  assert.match(res.headers.get('content-type'), /^application\/geo\+json/);
  const fc = await res.json();
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.unmapped, 0);
  const mtl = fc.features.find((f) => f.properties.provider.startsWith('Amazon Bedrock') && f.properties.region === 'CA-QC');
  assert.deepEqual(mtl.geometry, { type: 'Point', coordinates: [-73.5674, 45.5019] });   // [lon, lat]
  assert.equal(mtl.properties.precision, 'city');
  assert.match(mtl.properties.models, /Claude 3 Haiku; /);
  const thinkon = fc.features.find((f) => f.properties.provider === 'ThinkOn');
  assert.deepEqual([thinkon.properties.precision, thinkon.properties.derived], ['country', true]);

  const csv = await (await fetch(`${registry.origin}/v0/locations?country=CA&format=csv`)).text();
  assert.match(csv.split('\n')[0], /,lat,lon,precision,derived,distance_km$/);

  assert.match((await get(registry.origin, '/v0/health')).map.tiles, /openstreetmap/);
  const noMap = await startRegistry({ mapTiles: null });
  t.after(() => noMap.close());
  assert.equal((await get(noMap.origin, '/v0/health')).map, null);
});

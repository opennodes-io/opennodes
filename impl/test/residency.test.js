// Residency commitments (ONP-2 §3b, ONP-3 §5c-5d): the card field, EU/EEA scopes, seed entries
// that describe existing nodes, residency on each site, and the /v0/residency report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, residencyAt, residencyMeets, scopeCovers, commitmentRank } from '@opennodes/core';
import { startRegistry } from '@opennodes/registry';
import { seedNodeSites, nodeServes, seedPlacements, loadLocationSeeds } from '@opennodes/registry/src/locations.js';

const post = async (origin, path, body) => (await fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();
const get = async (origin, path) => (await fetch(`${origin}${path}`)).json();

const catalog = {
  hostco: { id: 'hostco', name: 'HostCo', api: 'https://api.hostco.example/v1',
    models: { m1: { id: 'm1', name: 'Model One', cost: { input: 0.1, output: 0.2 } }, m2: { id: 'm2', name: 'Model Two', cost: { input: 0.1, output: 0.2 } } } },
  relay: { id: 'relay', name: 'Relay', api: 'https://relay.example/v1',
    models: { m3: { id: 'm3', name: 'Model Three', cost: { input: 0.1, output: 0.2 } } } },
};
const src = { source: 'https://hostco.example/residency', checked: '2026-11-03' };
const world = {
  seed: 'world', title: 'Test', checked: '2026-11-03',
  providers: [
    { id: 'hostco', name: 'HostCo Inference', kind: 'inference', nodes: ['import.modelsdev.hostco'], placement: 'all',
      operator: { name: 'HostCo GmbH', country: 'DE' },
      sites: [{ id: 'fra', region: 'DE-HE', site: 'Frankfurt', status: 'live', basis: 'documented', ...src }],
      residency: [
        { commitment: 'processing', scope: ['EU'], availability: 'default', statement: 'Processed and stored in the EU.', ...src },
        { commitment: 'storage', scope: ['US'], availability: 'enterprise', statement: 'US storage on contract.', ...src },
      ] },
    { id: 'relay', name: 'Relay', kind: 'router', nodes: ['import.modelsdev.relay'], sites: [],
      residency: [{ commitment: 'none', scope: [], availability: 'default', statement: 'Upstreams anywhere.', ...src }] },
  ],
};
const us = {
  seed: 'us', title: 'Test US', checked: '2026-11-03',
  providers: [
    // HostCo's Ohio site, recorded in another seed: same company, so it points at the world entry.
    { id: 'hostco-us', name: 'HostCo (Ohio)', residency_of: 'world:hostco', models: [],
      models_note: 'Not published.', sites: [{ id: 'cmh', region: 'US-OH', site: 'Columbus', basis: 'claimed' }] },
  ],
};

test('residency on a card: processing and storage need a scope; EU and EEA cover member states', () => {
  const card = (residency) => ({
    onp: '0.1', revision: '2026-11-03T00:00:00Z',
    node: { id: 'de.example.node', name: 'Example', operator: { name: 'Example GmbH', country: 'DE' }, residency },
    endpoints: { openai: 'https://node.example.de/v1', health: 'https://node.example.de/onp/health' },
    offerings: [{ offering_id: 'm1', modality: 'text', model: { name: 'M1', artifact: 'hf:example/m1' }, serving: {},
      binding: { profile: 'onp.openai.chat/v1', model_id: 'm1' }, pricing: { currency: 'EUR', schemes: ['prepaid'] } }],
    payment: { schemes: [{ scheme: 'prepaid' }] },
  });
  assert.deepEqual(validateCard(card([{ commitment: 'processing', scope: ['DE'], availability: 'default' }, { commitment: 'none' }])), []);
  assert.ok(validateCard(card([{ commitment: 'processing' }])).length > 0);
  assert.ok(validateCard(card([{ commitment: 'storage', scope: [] }])).length > 0);
  assert.ok(scopeCovers('EU', 'DE-HE') && scopeCovers('EEA', 'NO-18') && !scopeCovers('EU', 'NO-18') && !scopeCovers('EU', 'GB'));
  assert.ok(scopeCovers('UK', 'GB-LND') && scopeCovers('US', 'US-VA') && !scopeCovers('US-VA', 'US'));
  const r = world.providers[0].residency;
  assert.deepEqual(residencyAt(r, 'FR-IDF').map((x) => x.commitment), ['processing']);
  assert.deepEqual(residencyAt(r, 'US-OH').map((x) => x.commitment), ['storage']);
  assert.ok(residencyMeets(residencyAt(r, 'US-OH'), 'storage') && !residencyMeets(residencyAt(r, 'US-OH'), 'storage', 'opt_in'));
  assert.equal(commitmentRank('maybe'), commitmentRank('unstated'));
});

test('seed entries attach sites and residency to existing nodes; /v0/residency lists every provider', async (t) => {
  const registry = await startRegistry();
  t.after(() => registry.close());
  await post(registry.origin, '/v0/import/models-dev', { catalog });
  await post(registry.origin, '/v0/import/locations', { seed: world });
  await post(registry.origin, '/v0/import/locations', { seed: us });

  // No duplicate listing: the seed describes import.modelsdev.hostco, whose offerings run in Frankfurt.
  assert.equal((await get(registry.origin, '/v0/offerings')).total, 3);
  const de = await get(registry.origin, '/v0/locations?country=DE');
  assert.equal(de.sites.length, 1);
  const fra = de.sites[0];
  assert.equal(fra.node_id, 'import.modelsdev.hostco');
  assert.equal(fra.provider, 'HostCo Inference');
  assert.deepEqual(fra.models.map((m) => m.name).sort(), ['Model One', 'Model Two']);
  assert.deepEqual(fra.residency.map((r) => r.commitment), ['processing']);
  assert.equal(de.summary.located_offerings, 2);

  // The Ohio site gets the company's commitments that cover Ohio, not its EU promise.
  const oh = (await get(registry.origin, '/v0/locations?country=US')).sites[0];
  assert.equal(oh.node_id, 'import.seed.us.hostco-us');
  assert.deepEqual(oh.residency.map((r) => `${r.commitment} ${r.scope}`), ['storage US']);
  assert.deepEqual((await get(registry.origin, '/v0/locations?residency=processing')).sites.map((s) => s.region), ['DE-HE']);
  assert.deepEqual((await get(registry.origin, '/v0/locations?residency=storage&availability=default')).sites.map((s) => s.region), ['DE-HE']);
  assert.equal((await get(registry.origin, '/v0/locations?residency=storage')).sites.length, 2);
  assert.equal((await fetch(`${registry.origin}/v0/locations?residency=maybe`)).status, 400);
  assert.match((await (await fetch(`${registry.origin}/v0/locations?country=DE&format=csv`)).text()).split('\n')[1], /,processing EU$/);

  const all = await get(registry.origin, '/v0/residency');
  assert.deepEqual(all.providers.map((p) => [p.id, p.kind, p.sites, p.strongest]), [
    ['world:hostco', 'inference', 2, 'processing'],
    ['world:relay', 'router', 0, 'none'],
  ]);
  assert.deepEqual(all.providers[0].node_ids.sort(), ['import.modelsdev.hostco', 'import.seed.us.hostco-us', 'import.seed.world.hostco']);
  assert.deepEqual(all.summary.by_strongest_commitment, { processing: 1, storage: 0, none: 1, unstated: 0 });
  assert.deepEqual((await get(registry.origin, '/v0/residency?scope=EU')).providers.map((p) => p.id), ['world:hostco']);
  assert.deepEqual((await get(registry.origin, '/v0/residency?scope=US&availability=opt_in')).providers, []);
  assert.deepEqual((await get(registry.origin, '/v0/residency?kind=router')).providers.map((p) => p.id), ['world:relay']);
  // One area vs separate choices: EEA+CH is not a promise to stay in Switzerland; "US or CH" is.
  await post(registry.origin, '/v0/import/locations', { seed: { ...us, seed: 'more', providers: [
    { id: 'zone', name: 'Zone', kind: 'cloud', nodes: [], sites: [], residency: [{ commitment: 'processing', scope: ['EEA', 'CH'], ...src }] },
    { id: 'pick', name: 'Pick', kind: 'cloud', nodes: [], sites: [], residency: [{ commitment: 'processing', scope: ['US', 'CH'], per_region: true, ...src }] },
  ] } });
  assert.deepEqual((await get(registry.origin, '/v0/residency?scope=CH')).providers.map((p) => p.id), ['more:pick']);
  assert.deepEqual((await get(registry.origin, '/v0/residency?scope=EU')).providers.map((p) => p.id), ['world:hostco']);
  assert.ok((await get(registry.origin, '/v0/residency?scope=EEA')).providers.some((p) => p.id === 'more:zone') === false, 'EEA+CH is wider than the EEA');
  const csv = (await (await fetch(`${registry.origin}/v0/residency?format=csv`)).text()).trim().split('\n');
  assert.equal(csv[0], 'provider,kind,operator,operator_country,node_ids,sites,commitment,scope,availability,programme,statement,source,checked');
  assert.equal(csv.length, 6);

  const body = await post(registry.origin, '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_residency', arguments: { scope: 'DE' } },
  });
  assert.equal(body.result.isError, false);
  assert.deepEqual(body.result.structuredContent.providers, [], 'an EU-wide promise is not a promise to stay in Germany');
});

test('bundled seeds: every entry well formed, references resolve, residency attaches per site', async (t) => {
  const { loadLocationSeeds } = await import('../packages/registry/src/locations.js');
  const seeds = loadLocationSeeds();
  const world = seeds.find((s) => s.seed === 'world');
  assert.ok(world.providers.length >= 200);
  const ids = new Set(seeds.flatMap((s) => s.providers.map((p) => `${s.seed}:${p.id}`)));
  const nodes = new Set();
  for (const seed of seeds) {
    for (const p of seed.providers) {
      if (p.residency_of) assert.ok(ids.has(p.residency_of), `${seed.seed}:${p.id} -> ${p.residency_of}`);
      else assert.ok(Array.isArray(p.residency), `${seed.seed}:${p.id} has residency`);
      if (p.serves_from) assert.ok(ids.has(p.serves_from) && p.nodes?.length && !p.sites?.length, `${seed.seed}:${p.id} serves_from ${p.serves_from}`);
      for (const r of p.residency ?? []) {
        assert.ok(['processing', 'storage', 'none', 'unstated'].includes(r.commitment), `${p.id}: ${r.commitment}`);
        assert.equal(['processing', 'storage'].includes(r.commitment), r.scope.length > 0, `${p.id}: scope`);
        if (r.commitment !== 'unstated') assert.ok(r.source && r.checked, `${p.id}: ${r.commitment} needs a source`);
      }
      for (const id of p.nodes ?? []) { assert.ok(!nodes.has(id), `${id} described twice`); nodes.add(id); }
    }
  }
  const registry = await startRegistry({ locationSeeds: true });
  t.after(() => registry.close());
  // Bedrock Frankfurt: in-region and geographic profiles apply; the sovereign partition does not.
  const fra = (await get(registry.origin, '/v0/locations?region=DE-HE')).sites.find((s) => s.node_id === 'import.seed.eu.aws-bedrock');
  assert.ok(fra.residency.some((r) => r.commitment === 'processing' && r.per_region));
  assert.ok(!fra.residency.some((r) => /Sovereign/.test(r.programme ?? '')));
  const de = (await get(registry.origin, '/v0/residency?scope=DE&commitment=processing')).providers.map((p) => p.id);
  assert.ok(de.includes('world:stackit') && de.includes('eu:ionos') && !de.includes('world:mistral'));
});

test('a listed node no seed covers appears as unstated', async (t) => {
  const registry = await startRegistry();
  t.after(() => registry.close());
  await post(registry.origin, '/v0/import/models-dev', { catalog });
  const report = await get(registry.origin, '/v0/residency');
  assert.deepEqual(report.providers.map((p) => [p.id, p.source, p.strongest]), [
    ['import.modelsdev.hostco', 'none', 'unstated'], ['import.modelsdev.relay', 'none', 'unstated'],
  ]);
});

test('the node directory reports where each node serves from, card first, then the seeds', async (t) => {
  const registry = await startRegistry({ locationSeeds: true });
  t.after(() => registry.close());
  const seeds = [{ seed: 'x', providers: [
    { id: 'hub', name: 'Hub', kind: 'cloud', nodes: ['n.hub', 'n.sibling'], sites: [{ id: 'a', region: 'US-CA', status: 'live', basis: 'documented' }] },
    { id: 'eu', name: 'Hub EU', residency_of: 'x:hub', sites: [{ id: 'b', region: 'DE-HE', status: 'live', basis: 'documented' }, { id: 'c', region: 'NO', status: 'planned', basis: 'claimed' }] },
    { id: 'via', name: 'Via', kind: 'inference', nodes: ['n.via'], serves_from: 'x:far' },
    { id: 'far', name: 'Far', residency_of: 'x:via', sites: [{ id: 'd', region: 'FR-IDF', status: 'live', basis: 'claimed' }] },
    { id: 'app', name: 'App', kind: 'local', nodes: ['n.app'] },
    { id: 'mix', name: 'Mix', kind: 'router', nodes: ['n.mix'] },
    { id: 'quiet', name: 'Quiet', kind: 'lab', nodes: ['n.quiet'] },
  ] }];
  const known = seedNodeSites(seeds);
  const serves = (id, card) => nodeServes({ source: 'import' }, card, known.get(id));
  assert.deepEqual(serves('n.sibling'), { places: ['DE', 'US'], planned: ['NO'], source: 'seed', label: null });
  assert.deepEqual(serves('n.via').places, ['FR']);
  assert.equal(serves('n.app').label, 'local');
  assert.equal(serves('n.mix').label, 'router');
  assert.equal(serves('n.quiet').label, 'not_published');
  assert.equal(serves('n.none').label, 'unknown');
  const loopback = { endpoints: { openai: 'http://127.0.0.1:11434/v1' } };
  assert.equal(serves('n.none', loopback).label, 'local');
  assert.equal(serves('n.quiet', loopback).label, 'not_published');   // a client-side proxy to a hosted service
  assert.equal(nodeServes({ source: 'registration' }, {}, undefined).label, 'not_declared');
  // A card that declares a location wins over the seeds.
  const card = { node: { locations: [{ region: 'CA-QC', basis: 'claimed' }] }, offerings: [] };
  assert.deepEqual(serves('n.hub', card), { places: ['CA'], planned: [], source: 'card', label: null });

  const { nodes } = await (await fetch(`${registry.origin}/v0/nodes`)).json();
  assert.ok(nodes.every((n) => n.serves && Array.isArray(n.serves.places)));

  // The reference nodes are on the map and the Nodes page, but never placed into region search:
  // free, verified and tiny, they would outrank every hosted provider in a recommend shortlist.
  const bundled = loadLocationSeeds();
  assert.deepEqual(nodeServes({ source: 'registration' }, {}, seedNodeSites(bundled).get('io.opennodes.helsinki')).places, ['FI']);
  assert.ok(![...seedPlacements(bundled).keys()].some((id) => id.startsWith('io.opennodes.')));
});

test('search and recommend use seed placements: placement "all" and serves_from; never through a router', async (t) => {
  const registry = await startRegistry();
  t.after(() => registry.close());
  await post(registry.origin, '/v0/import/models-dev', { catalog });
  await post(registry.origin, '/v0/import/huggingface', { router: { data: [{ id: 'org/m4', providers: [{ provider: 'hostco', status: 'live' }] }] }, hub: [] });
  const seed = {
    seed: 'eu', title: 'Test', checked: '2026-11-03',
    providers: [
      // The provider's own seed card: every model in Paris.
      { id: 'parisco', name: 'ParisCo', models: [{ name: 'Model Three', artifact: 'hf:x/m3', sites: ['par'] }],
        sites: [{ id: 'par', region: 'FR-IDF', site: 'Paris', status: 'live', basis: 'documented', ...src }] },
      // The relay's own API runs at ParisCo's site; HostCo serves everything from Frankfurt (and Ohio, planned).
      { id: 'relay', name: 'Relay', nodes: ['import.modelsdev.relay'], serves_from: 'eu:parisco', sites: [] },
      { id: 'hostco', name: 'HostCo', nodes: ['import.modelsdev.hostco', 'import.hf.hostco'], placement: 'all',
        sites: [{ id: 'fra', region: 'DE-HE', status: 'live', basis: 'documented', ...src }, { id: 'cmh', region: 'US-OH', status: 'planned', basis: 'claimed' }] },
    ],
  };
  await post(registry.origin, '/v0/import/locations', { seed });
  const search = async (qs) => (await get(registry.origin, `/v0/offerings?${qs}&limit=50`)).offerings;
  const inEu = await search('region=EU');
  assert.deepEqual([...new Set(inEu.map((o) => o.node_id))].sort(), ['import.modelsdev.hostco', 'import.modelsdev.relay', 'import.seed.eu.parisco']);
  const relay = inEu.find((o) => o.node_id === 'import.modelsdev.relay');
  assert.deepEqual(relay.residency, ['FR-IDF']);
  assert.equal(relay.locations[0].via, 'seed');
  assert.equal(relay.locations[0].basis, 'documented');
  assert.deepEqual((await search('region=DE')).map((o) => o.node_id), ['import.modelsdev.hostco', 'import.modelsdev.hostco'], 'planned Ohio is not a serving site');
  assert.ok(!(await search('region=EU')).some((o) => o.node_id === 'import.hf.hostco'), 'the HF router sits in between');
  assert.equal((await search('region=EU&location_basis=measured')).length, 0);
  const rec = await (await fetch(`${registry.origin}/v0/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Summarize this memo.', policy: { region: 'EU' } }) })).json();
  assert.ok(rec.recommendations.length > 0);
  assert.ok(rec.recommendations.every((x) => ['import.modelsdev.hostco', 'import.modelsdev.relay'].includes(x.node_id)), JSON.stringify(rec.recommendations.map((x) => x.node_id)));
});

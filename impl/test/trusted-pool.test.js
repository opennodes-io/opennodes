// Trusted and open pools (ONP-3 §5e): data-policy and strict-lineage filters, trust=trusted, pool
// labels, configurable trusted jurisdictions, and the client-side `sensitive` setting in the gateway,
// the Ollama router and the stdio MCP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  createApp, listen, closeApp, sendJson, readJson,
  meetsDataPolicy, lineageAllowed, trustedView, inTrustedPool, trustGaps, poolOf, recommend, extractFeatures,
  parseAutoModel, AUTO_MODEL_NAMES, sensitiveHeader, trustedJurisdictionsFrom, retentionRank,
} from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';
import { createStdioMcp } from '@opennodes/cli/src/mcpserver.js';
import { startOllamaRouter } from '@opennodes/ollama-router';

const FIXTURE = 'org.opennodes.fixture';
const ACME = 'import.modelsdev.acmecloud';
const CATALOG = { acmecloud: { id: 'acmecloud', name: 'Acme Cloud', api: 'https://api.acmecloud.example/v1',
  models: { 'acme-small': { id: 'acme-small', name: 'Acme Small', cost: { input: 0.05, output: 0.2 } } } } };

// A hosted offering that meets every condition of the default trusted view (EU, CA).
const TRUSTED = Object.freeze({
  node_id: 'io.lab.eu', offering_id: 'm', tier: 'verified', modality: 'text',
  model: { name: 'Lab M', params_b: 8, lineage_origins: ['FR'] },
  jurisdiction: { country: 'DE', basis: 'declared', location: null },
  data_policy: { retention: 'none', training_on_inputs: false },
  serving: { context_window: 32_000, supports: [] }, binding: { model_id: 'm' },
  pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 2, schemes: ['prepaid'] },
  endpoints: { openai: 'https://lab.example/v1' }, observed: { probe_success: 1 }, card_revision: 'r1',
});
const variant = (patch) => ({ ...TRUSTED, ...patch });

async function registerAndVerify(registry, node) {
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  return (await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json());
}

/** A registry with the fixture node (lineage FR, operator DE) registered and, unless told not to, verified; plus an import. */
async function network(t, { lineage = ['FR'], admit = true, registryOptions = {} } = {}) {
  const node = await startFixtureNode({ lineage });
  const registry = await startRegistry({ allowPrivateTargets: true, ...registryOptions });
  t.after(async () => { await node.close(); await registry.close(); });
  const post = (path, body) => fetch(`${registry.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  await post('/v0/import/models-dev', { catalog: CATALOG });
  await registerAndVerify(registry, node);
  if (admit) assert.equal((await (await post(`/v0/nodes/${FIXTURE}/admit`)).json()).state, 'verified');
  const get = async (path) => (await fetch(`${registry.origin}${path}`)).json();
  const tool = async (name, args) => (await (await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result;
  return { node, registry, post, get, tool };
}

test('trust rules: data policy, lineage, the trusted view and why an offering is open', () => {
  // data policy: at most this retention, no training; no data_policy or a missing field fails
  assert.ok(meetsDataPolicy(TRUSTED, { retention: 'none', no_training: true }));
  assert.ok(meetsDataPolicy(variant({ data_policy: { retention: 'ephemeral', retention_max_seconds: 60 } }), { retention: 'ephemeral' }));
  assert.ok(!meetsDataPolicy(variant({ data_policy: { retention: 'ephemeral', retention_max_seconds: 60 } }), { retention: 'none' }));
  assert.ok(!meetsDataPolicy(variant({ data_policy: null }), { retention: 'logged' }), 'no data_policy fails whenever a filter is used');
  assert.ok(meetsDataPolicy(variant({ data_policy: null }), {}), 'no filter, no requirement');
  assert.ok(!meetsDataPolicy(variant({ data_policy: { training_on_inputs: false } }), { retention: 'logged' }), 'retention unstated');
  assert.ok(!meetsDataPolicy(variant({ data_policy: { retention: 'none' } }), { no_training: true }), 'training unstated');
  assert.equal(retentionRank('forever'), retentionRank('logged'), 'an unknown retention counts as logged');

  // lineage: exclude declared origins; `declared` drops unknown lineage too
  assert.ok(lineageAllowed(variant({ model: { name: 'x' } }), { exclude: ['CN'] }), 'unknown lineage kept by default');
  assert.ok(!lineageAllowed(variant({ model: { name: 'x' } }), { exclude: ['CN'], declared: true }));
  assert.ok(!lineageAllowed(variant({ model: { name: 'x', lineage_origins: [] } }), { declared: true }), 'an empty list declares nothing');
  assert.ok(!lineageAllowed(variant({ model: { name: 'x', lineage_origins: ['US', 'cn'] } }), { exclude: [' CN'] }));

  // the trusted view and its gaps
  assert.deepEqual(trustedView().exclude_lineage, ['CN']);
  assert.ok(inTrustedPool(TRUSTED));
  assert.equal(poolOf(TRUSTED), 'trusted');
  assert.deepEqual(trustGaps(variant({ model: { name: 'x' } })), ['model lineage not declared']);
  assert.deepEqual(trustGaps(variant({ model: { name: 'x', lineage_origins: ['CN'] } })), ['model lineage includes CN']);
  assert.deepEqual(trustGaps(variant({ tier: 'community' })), ['tier community below verified']);
  assert.match(trustGaps(variant({ jurisdiction: { country: 'US' } }))[0], /operator country US, outside EU,CA/);
  assert.match(trustGaps(variant({ jurisdiction: { country: 'DE', location: { server_country: 'US', cdn: false, verdict: 'mismatch' } } }))[0], /server in US/);
  assert.deepEqual(trustGaps(variant({ data_policy: null })), ['no data_policy']);
  assert.match(trustGaps(variant({ data_policy: { retention: 'logged', training_on_inputs: true } }))[0], /retention logged, training_on_inputs true/);
  assert.ok(inTrustedPool(variant({ jurisdiction: { country: 'NO' } })), 'EU means the EEA in jurisdiction filters');
  assert.ok(!inTrustedPool(variant({ jurisdiction: { country: 'CH' } })));
  assert.ok(inTrustedPool(variant({ jurisdiction: { country: 'CH' } }), trustedView('EU,CA,CH')), 'the trusted set is configurable');
  assert.ok(inTrustedPool(variant({ jurisdiction: { country: 'GB' } }), trustedView('EU,CA,UK')), 'UK means GB');
  assert.ok(!inTrustedPool(TRUSTED, trustedView('')), 'no trusted country: no hosted offering is trusted');

  // the user's own machine or LAN: nothing reaches an operator, but the lineage rule still applies
  const local = { node_id: 'local', offering_id: 'tiny', tier: 'local', model: { name: 'tiny' }, data_policy: null };
  assert.deepEqual(trustGaps(local), ['model lineage not declared']);
  assert.ok(inTrustedPool({ ...local, model: { name: 'tiny', lineage_origins: ['US'] } }, trustedView('')));
  assert.ok(inTrustedPool({ ...local, tier: 'lan', model: { name: 'x', lineage_origins: ['FR'] } }));

  assert.equal(trustedJurisdictionsFrom({}), 'EU,CA');
  assert.equal(trustedJurisdictionsFrom({ ONP_TRUSTED_JURISDICTIONS: ' EU,CA,CH ' }), 'EU,CA,CH');
  assert.deepEqual(parseAutoModel('onp/auto-sensitive', 'onp/'), { preset: null, jurisdiction: null, sensitive: true });
  assert.ok(AUTO_MODEL_NAMES.includes('auto-sensitive'));
  assert.equal(sensitiveHeader({ 'onp-sensitive': 'True' }), true);
  assert.equal(sensitiveHeader({ 'onp-sensitive': '0' }), false);
  assert.equal(sensitiveHeader({}), false);
});

test('recommend: sensitive keeps only the trusted pool and labels every candidate', () => {
  const open = variant({ node_id: 'com.cheap.us', jurisdiction: { country: 'US' }, pricing: { ...TRUSTED.pricing, input_per_mtok: 0.01 } });
  const features = extractFeatures('Summarise this quarterly report in five bullet points');
  const both = recommend([TRUSTED, open], features, { limit: 5 });
  assert.deepEqual(both.recommendations.map((r) => [r.node_id, r.pool]).sort(), [['com.cheap.us', 'open'], ['io.lab.eu', 'trusted']]);
  assert.equal(both.trusted_view, undefined);

  const safe = recommend([TRUSTED, open], features, { sensitive: true, limit: 5 });
  assert.deepEqual(safe.recommendations.map((r) => r.node_id), ['io.lab.eu']);
  assert.equal(safe.rejected.trust, 1);
  assert.equal(safe.query.trust, 'trusted');
  assert.equal(safe.trusted_view.jurisdictions, 'EU,CA');
  assert.deepEqual(recommend([TRUSTED, open], features, { trust: 'trusted', limit: 5 }).recommendations.map((r) => r.node_id), ['io.lab.eu']);
  assert.equal(recommend([TRUSTED], features, { sensitive: true, trusted: trustedView('CA') }).recommendations.length, 0, 'the host view decides');
  assert.throws(() => recommend([TRUSTED], features, { trust: 'strict' }), (err) => err.status === 400);
});

test('registry search: data policy, strict lineage and trust filters, pool labels, 400 on bad values', async (t) => {
  const { get, post, tool, registry } = await network(t, { admit: false });
  const ids = async (qs) => (await get(`/v0/offerings?${qs}`)).offerings.map((o) => o.node_id).sort();
  const pools = async () => Object.fromEntries((await get('/v0/offerings')).offerings.map((o) => [o.node_id, o.pool]));

  assert.deepEqual(await pools(), { [ACME]: 'open', [FIXTURE]: 'open' }, 'community is below the trusted tier');
  assert.deepEqual(await ids('trust=trusted'), []);
  assert.equal((await post(`/v0/nodes/${FIXTURE}/admit`)).status, 200);
  assert.deepEqual(await pools(), { [ACME]: 'open', [FIXTURE]: 'trusted' });
  assert.deepEqual(await ids('trust=trusted'), [FIXTURE]);
  assert.deepEqual(await ids('trust=open'), [ACME, FIXTURE], 'open is both pools');

  // data policy: the import declares none, so it fails every data-policy filter
  assert.deepEqual(await ids('retention=none'), [FIXTURE]);
  assert.deepEqual(await ids('retention=logged'), [FIXTURE]);
  assert.deepEqual(await ids('no_training=true'), [FIXTURE]);
  assert.deepEqual(await ids('no_training=false'), [ACME, FIXTURE]);

  // lineage: unknown is kept by exclude_lineage alone, dropped with lineage=declared
  assert.deepEqual(await ids('exclude_lineage=FR'), [ACME]);
  assert.deepEqual(await ids('lineage=declared'), [FIXTURE]);
  assert.deepEqual(await ids('lineage=declared&exclude_lineage=CN'), [FIXTURE]);
  assert.deepEqual(await ids('lineage=declared&exclude_lineage=fr'), []);

  // a typo must not widen a sensitive search: unknown values are refused
  for (const qs of ['trust=yes', 'retention=forever', 'lineage=strict', 'no_training=maybe']) {
    const bad = await fetch(`${registry.origin}/v0/offerings?${qs}`);
    assert.equal(bad.status, 400, qs);
    assert.equal((await bad.json()).title, 'bad-query');
  }
  const est = await post('/v0/estimate', { steps: [{ select: { trust: 'yes' }, est_input_tokens: 10, est_output_tokens: 10 }] });
  assert.equal(est.status, 400);

  // the trusted view is published
  const { trust } = await get('/v0/health');
  assert.equal(trust.trusted.jurisdictions, 'EU,CA');
  assert.ok(trust.trusted.countries.includes('DE') && trust.trusted.countries.includes('CA') && !trust.trusted.countries.includes('CH'));
  assert.deepEqual([trust.trusted.exclude_lineage, trust.trusted.lineage, trust.trusted.min_tier, trust.trusted.retention, trust.trusted.no_training],
    [['CN'], 'declared', 'verified', 'none', true]);

  // MCP search_offerings takes the same filters
  const viaMcp = (await tool('search_offerings', { trust: 'trusted' })).structuredContent.offerings;
  assert.deepEqual(viaMcp.map((o) => [o.node_id, o.pool]), [[FIXTURE, 'trusted']]);
  assert.equal((await tool('search_offerings', { retention: 'forever' })).isError, true);
});

test('registry recommend: sensitive applies the registry\'s trusted view, which a client cannot replace', async (t) => {
  const { post, tool } = await network(t);
  const advise = async (policy) => (await post('/v0/recommend', { task: 'Summarise this report', policy })).json();
  const open = await advise({});
  assert.ok(open.recommendations.some((r) => r.node_id === ACME), 'the open pool includes the import');
  const safe = await advise({ sensitive: true });
  assert.ok(safe.recommendations.length > 0);
  assert.ok(safe.recommendations.every((r) => r.node_id === FIXTURE && r.pool === 'trusted'));
  assert.equal(safe.trusted_view.jurisdictions, 'EU,CA');
  const forged = await advise({ sensitive: true, trusted: { ...safe.trusted_view, countries: ['US'], min_tier: 'unverified', lineage: 'any', exclude_lineage: [] } });
  assert.equal(forged.trusted_view.jurisdictions, 'EU,CA', 'the registry keeps its own view');
  assert.ok(forged.recommendations.every((r) => r.node_id === FIXTURE));
  const bad = await post('/v0/recommend', { task: 'x', policy: { trust: 'strict' } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).title, 'bad-policy');

  const viaMcp = (await tool('recommend', { task: 'Summarise this report', policy: { sensitive: true } })).structuredContent;
  assert.equal(viaMcp.trusted_view.jurisdictions, 'EU,CA');
  assert.ok(viaMcp.recommendations.every((r) => r.pool === 'trusted'));
});

test('registry: the trusted jurisdictions are configurable', async (t) => {
  const ca = await network(t, { registryOptions: { trustedJurisdictions: 'CA' } });
  assert.equal((await ca.get('/v0/health')).trust.trusted.jurisdictions, 'CA');
  assert.deepEqual((await ca.get('/v0/offerings?trust=trusted')).offerings, [], 'a DE operator is outside CA');
  assert.equal((await ca.get('/v0/offerings')).offerings.find((o) => o.node_id === FIXTURE).pool, 'open');
  assert.equal((await (await ca.post('/v0/recommend', { task: 'Summarise this report', policy: { sensitive: true } })).json()).recommendations.length, 0);
});

test('locations: lineage=declared drops models without a declared lineage, in REST and MCP', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const site = { id: 'yul', region: 'CA-QC', site: 'Montréal', status: 'live', basis: 'documented', source: 'https://example.test/sites', checked: '2026-11-09' };
  const seed = { seed: 'test', checked: '2026-11-09', providers: [{
    id: 'mapleai', name: 'Maple AI', operator: { name: 'Maple AI', country: 'CA' }, sites: [site],
    models: [
      { name: 'Declared FR', family: 'mistral', lineage_origins: ['FR'], sites: ['yul'] },
      { name: 'Declared CN', family: 'qwen', lineage_origins: ['CN'], sites: ['yul'] },
      { name: 'Undeclared', family: 'mystery', sites: ['yul'] },
    ],
  }] };
  const imported = await fetch(`${registry.origin}/v0/import/locations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed }) });
  assert.equal(imported.status, 200);
  const names = async (qs) => (await (await fetch(`${registry.origin}/v0/locations?country=CA&${qs}`)).json()).sites.flatMap((s) => s.models.map((m) => m.name)).sort();
  assert.deepEqual(await names(''), ['Declared CN', 'Declared FR', 'Undeclared']);
  assert.deepEqual(await names('exclude_lineage=CN'), ['Declared FR', 'Undeclared'], 'unknown lineage kept by default');
  assert.deepEqual(await names('lineage=declared'), ['Declared CN', 'Declared FR']);
  assert.deepEqual(await names('lineage=declared&exclude_lineage=CN'), ['Declared FR']);
  assert.equal((await fetch(`${registry.origin}/v0/locations?lineage=strict`)).status, 400);

  const viaMcp = (await (await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_locations', arguments: { country: 'CA', lineage: 'declared', exclude_lineage: 'CN' } } }),
  })).json()).result.structuredContent;
  assert.deepEqual(viaMcp.sites.flatMap((s) => s.models.map((m) => m.name)), ['Declared FR']);

  // the same rule in search: the seed's listing-only offerings
  const search = async (qs) => (await (await fetch(`${registry.origin}/v0/offerings?q=mapleai&${qs}`)).json()).offerings.map((o) => o.model.name).sort();
  assert.deepEqual(await search('lineage=declared&exclude_lineage=CN'), ['Declared FR']);
});

test('gateway: a sensitive request is routed and sent only inside the trusted pool', async (t) => {
  const { registry, post } = await network(t, { admit: false });
  const opts = { port: 0, registry: registry.origin, env: {}, checksPath: null, ollama: null };
  const chat = (gw, model, headers = {}) => fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 16 }),
  });
  const before = await startGateway(opts);
  t.after(() => before.close());
  assert.equal((await chat(before, 'onp/auto')).status, 200, 'open pool: a community node');
  const refused = await chat(before, 'onp/auto', { 'onp-sensitive': '1' });
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).title, 'no-trusted-offerings');
  assert.equal((await chat(before, 'onp/auto-sensitive')).status, 404);
  const named = await chat(before, `${FIXTURE}/echo-1`, { 'onp-sensitive': 'yes' });
  assert.equal(named.status, 403, 'a named open-pool offering is refused too');
  assert.match((await named.json()).detail, /open pool and the request is sensitive \(tier community below verified\)/);

  assert.equal((await post(`/v0/nodes/${FIXTURE}/admit`)).status, 200);
  const after = await startGateway(opts);   // a fresh pool cache
  t.after(() => after.close());
  assert.equal((await chat(after, 'onp/auto', { 'onp-sensitive': '1' })).status, 200);
  assert.equal((await chat(after, 'onp/auto-sensitive')).status, 200);
  const advice = await (await fetch(`${after.origin}/gateway/advice`)).json();
  assert.equal(advice.sensitive, true);
  assert.equal(advice.recommendations[0].offering, `${FIXTURE}/echo-1`);

  // --sensitive with this user's own trusted set (CA only): the DE node is outside it
  const caOnly = await startGateway({ ...opts, policy: { sensitive: true, trusted_jurisdictions: 'CA' } });
  t.after(() => caOnly.close());
  assert.equal(caOnly.trusted.jurisdictions, 'CA');
  assert.equal((await chat(caOnly, 'onp/auto')).status, 404, 'every request is sensitive');
  assert.equal((await chat(caOnly, `${FIXTURE}/echo-1`)).status, 403);
});

/** Minimal Ollama look-alike with one local model (no declared lineage). */
async function startFakeOllama(t) {
  const app = createApp([
    ['GET', '/api/tags', (req, res) => sendJson(res, 200, { models: [{ name: 'tiny:latest', model: 'tiny:latest', details: { family: 'tiny', parameter_size: '1.0B' } }] })],
    ['POST', '/api/show', (req, res) => sendJson(res, 200, { details: { family: 'tiny' }, model_info: {}, capabilities: ['completion'] })],
    ['POST', '/api/chat', async (req, res) => { const b = await readJson(req); sendJson(res, 200, { model: b.model, message: { role: 'assistant', content: 'local' }, done: true, prompt_eval_count: 1, eval_count: 1 }); }],
  ]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  return `http://127.0.0.1:${port}`;
}

test('ollama router: a sensitive request skips open-pool models, local ones included', async (t) => {
  const { registry } = await network(t);
  const ollama = await startFakeOllama(t);
  const start = async (extra = {}) => {
    const r = await startOllamaRouter({ port: 0, ollama, registry: registry.origin, mdns: false, log: () => {}, ...extra });
    t.after(() => r.close());
    return r;
  };
  const chat = (router, model, headers = {}) => fetch(`${router.origin}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], stream: false }),
  });
  const router = await start();
  assert.equal((await chat(router, 'tiny:latest')).status, 200);
  const refused = await chat(router, 'tiny:latest', { 'onp-sensitive': '1' });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /open pool, the request is sensitive \(model lineage not declared\)/);
  assert.equal((await chat(router, 'auto-sensitive')).status, 200);
  const advice = await (await fetch(`${router.origin}/router/advice`)).json();
  assert.equal(advice.sensitive, true);
  assert.deepEqual(advice.recommendations.map((r) => r.offering), [`${FIXTURE}/echo-1`], 'the local model without lineage is left out');
  const catalog = await (await fetch(`${router.origin}/router/catalog`)).json();
  assert.equal(catalog.models.find((m) => m.name === 'tiny:latest').pool, 'open');

  const caOnly = await start({ trustedJurisdictions: 'CA', policy: { sensitive: true } });
  const none = await chat(caOnly, 'auto');
  assert.equal(none.status, 404);
  assert.match((await none.json()).error, /trusted pool/);
});

/** A stdio MCP session over in-memory streams. */
function session(registry, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const mcp = createStdioMcp({ registry, input, output, ...opts });
  let buffer = '';
  const waiting = new Map();
  output.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const call = (name, args) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, (msg) => resolve(msg.result));
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  return { call, close: () => mcp.close() };
}

test('stdio MCP: sensitive search and recommend stay in the trusted pool, and refuse a registry that ignores them', async (t) => {
  const { registry } = await network(t);
  const mcp = session(registry.origin, { sensitive: true });
  t.after(mcp.close);
  const found = (await mcp.call('search_offerings', {})).structuredContent;
  assert.deepEqual(found.offerings.map((o) => o.node_id), [FIXTURE]);
  assert.equal(found.sensitive.trusted_view.jurisdictions, 'EU,CA');
  const advice = (await mcp.call('recommend', { task: 'Summarise this report' })).structuredContent;
  assert.ok(advice.trusted_view);
  assert.ok(advice.recommendations.every((r) => r.pool === 'trusted'));

  // an agent can mark one task sensitive on a normal session
  const plain = session(registry.origin);
  t.after(plain.close);
  assert.ok((await plain.call('recommend', { task: 'Summarise this report' })).structuredContent.recommendations.some((r) => r.node_id === ACME));
  assert.ok((await plain.call('recommend', { task: 'Summarise this report', policy: { sensitive: true } })).structuredContent.recommendations.every((r) => r.node_id === FIXTURE));

  // a registry that predates trusted pools ignores `sensitive` and `trust`
  const open = { ...TRUSTED, node_id: 'com.cheap.us', jurisdiction: { country: 'US' } };
  const app = createApp([
    ['POST', '/v0/recommend', (req, res) => sendJson(res, 200, { recommendations: [{ offering: 'com.cheap.us/m', node_id: 'com.cheap.us' }] })],
    ['GET', '/v0/offerings', (req, res) => sendJson(res, 200, { offerings: [open], total: 1 })],
  ]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  const old = session(`http://127.0.0.1:${port}`, { sensitive: true });
  t.after(old.close);
  const refused = await old.call('recommend', { task: 'Summarise this report' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /does not apply a trusted view/);
  const filtered = (await old.call('search_offerings', {})).structuredContent;
  assert.deepEqual(filtered.offerings, []);
  assert.equal(filtered.sensitive.removed_by_client, 1);
});

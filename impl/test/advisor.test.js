// Advisor (ONP-3 §5b): feature extraction, deterministic ranking with explanations,
// the registry endpoint, the stdio-MCP privacy path, and gateway onp/auto routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures, recommend, detectLanguage, inJurisdiction, jurisdictionCountries, parseAutoModel, responseBudgetMs, fetchWithin } from '@opennodes/core';
import http from 'node:http';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';

const offering = (over) => ({
  node_id: 'org.example.a', offering_id: 'm', tier: 'verified', source: 'registration', card_revision: 'r1',
  modality: 'text', model: { name: 'M', artifact: 'hf:x/m', params_b: 70 },
  serving: { context_window: 128000, supports: ['streaming', 'tool_calls', 'json_mode'], languages: [{ lang: 'en', grade: 'native' }, { lang: 'pl', grade: 'strong' }] },
  binding: { profile: 'onp.openai.chat/v1', model_id: 'm' },
  pricing: { currency: 'USD', input_per_mtok: 1.0, output_per_mtok: 3.0, schemes: ['prepaid'] },
  data_policy: { retention: 'none', training_on_inputs: false },
  observed: { probe_success: 1, probes: 4, ttft_ms: { p50: 300 }, tps: 80, availability: null },
  endpoints: { openai: 'https://a.example/v1' },
  ...over,
});

test('extractFeatures: task class, language, needs, sizes — never the text', () => {
  const f = extractFeatures('Extract all invoice line items from this PDF as JSON with a strict schema.', { attachments: [{ chars: 40000 }] });
  assert.equal(f.task_class, 'extraction');
  assert.equal(f.needs.json, true);
  assert.equal(f.language, 'en');
  assert.ok(f.est_input_tokens > 10000);
  assert.ok(!JSON.stringify(f).includes('invoice line items'));

  const pl = extractFeatures('Proszę przetłumaczyć ten dokument i nie zmieniać formatowania, czy to jest możliwe?');
  assert.equal(pl.language, 'pl');
  assert.equal(detectLanguage('Будь ласка, перекладіть цей текст'), 'uk');

  const hard = extractFeatures('Prove that the algorithm is O(n log n) and derive the recurrence step by step.');
  assert.equal(hard.needs.reasoning, 'high');
  const agent = extractFeatures('Open the website https://example.org, click login and fill in the form, then run the tests.');
  assert.equal(agent.task_class, 'agentic');
  assert.ok(agent.needs.tool_categories.includes('browser'));
  const sensitive = extractFeatures('Summarize this patient medical record: john.doe@example.com');
  assert.equal(sensitive.privacy, 'sensitive');
});

test('recommend: hard filters reject, weights explain, cheap wins on extraction, strong wins on reasoning', () => {
  const strong = offering({ node_id: 'org.example.strong', model: { name: 'Strong', artifact: 'hf:x/strong', params_b: 400 }, pricing: { currency: 'USD', input_per_mtok: 5, output_per_mtok: 15, schemes: ['prepaid'] } });
  const cheap = offering({ node_id: 'org.example.cheap', model: { name: 'Cheap', artifact: 'hf:x/cheap', params_b: 8 }, pricing: { currency: 'USD', input_per_mtok: 0.1, output_per_mtok: 0.3, schemes: ['prepaid'] } });
  const noTools = offering({ node_id: 'org.example.notools', serving: { context_window: 128000, supports: ['streaming'] } });
  const tiny = offering({ node_id: 'org.example.tiny', serving: { context_window: 4096, supports: ['streaming', 'tool_calls', 'json_mode'] } });
  const leaky = offering({ node_id: 'org.example.leaky', data_policy: { retention: '30d', training_on_inputs: true } });
  const all = [strong, cheap, noTools, tiny, leaky];

  const ext = recommend(all, extractFeatures('Classify these 500 support tickets by category, output as JSON.', { attachments: [{ chars: 60000 }] }), { limit: 5 });
  assert.equal(ext.rejected.capabilities, 1, 'no json_mode → rejected');
  assert.equal(ext.rejected.context, 1, '4k window → rejected');
  assert.equal(ext.recommendations[0].node_id, 'org.example.cheap');
  assert.ok(ext.recommendations[0].reasons.some((r) => /price-led/.test(r)));
  assert.ok(ext.recommendations[0].estimate.max > 0 && ext.recommendations[0].card_revision === 'r1');

  const hard = recommend(all, extractFeatures('Prove the theorem rigorously, step by step, and derive the bound.'), { limit: 5 });
  assert.equal(hard.recommendations[0].node_id, 'org.example.strong');
  assert.ok(hard.scenario && hard.scenario.name === 'triage-then-expert');

  const priv = recommend(all, extractFeatures('Summarize this confidential patient record.'), { limit: 5 });
  assert.equal(priv.rejected.data_policy, 1);
  assert.ok(!priv.recommendations.some((r) => r.node_id === 'org.example.leaky'));

  // determinism: same inputs → identical output
  assert.deepEqual(recommend(all, hard.features, { limit: 5 }), hard);
});

test('registry /v0/recommend, MCP recommend, and gateway onp/auto route to the fixture', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });

  // task text path
  const r1 = await (await fetch(`${registry.origin}/v0/recommend`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Reply with a short greeting as JSON.', policy: { limit: 3 } }),
  })).json();
  assert.equal(r1.recommendations[0].offering, 'org.opennodes.fixture/echo-1');
  assert.equal(r1.recommendations[0].hardware.accelerators[0].type, 'CPU');
  assert.ok(r1.recommendations[0].estimate.max > 0);

  // features-only path (what the stdio MCP server sends — no prompt)
  const features = extractFeatures('Reply with a short greeting as JSON.');
  const r2 = await (await fetch(`${registry.origin}/v0/recommend`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ features }),
  })).json();
  assert.equal(r2.recommendations[0].offering, 'org.opennodes.fixture/echo-1');

  // MCP tool
  const mcp = await (await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recommend', arguments: { task: 'say hi' } } }),
  })).json();
  assert.equal(mcp.result.structuredContent.recommendations[0].node_id, 'org.opennodes.fixture');

  // gateway: onp/auto is listed and routes by advice, with the decision inspectable
  const gw = await startGateway({ port: 0, registry: registry.origin });
  t.after(() => gw.close());
  const ids = (await (await fetch(`${gw.origin}/v1/models`)).json()).data.map((m) => m.id);
  assert.ok(ids.includes('onp/auto') && ids.includes('onp/auto-cheap'));
  const chat = await (await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp/auto-cheap', messages: [{ role: 'user', content: 'ping' }] }),
  })).json();
  assert.match(chat.choices[0].message.content, /^echo: ping/);
  assert.equal(chat.model, 'onp/auto-cheap');
  const advice = await (await fetch(`${gw.origin}/gateway/advice`)).json();
  assert.equal(advice.recommendations[0].offering, 'org.opennodes.fixture/echo-1');
  assert.ok(!JSON.stringify(advice.features).includes('ping'));
});

test('jurisdiction: EEA filter in the advisor and in registry search; local always qualifies', async (t) => {
  assert.equal(jurisdictionCountries('eea').has('FI'), true);
  assert.equal(jurisdictionCountries('eu').has('NO'), true, 'eu is an alias for the EEA');
  assert.equal(jurisdictionCountries('eea').has('GB'), false);
  assert.deepEqual([...jurisdictionCountries('de, fi')], ['DE', 'FI']);
  assert.deepEqual([...jurisdictionCountries('uk')], ['GB'], 'UK is the common name for GB');
  assert.equal(inJurisdiction({ jurisdiction: { country: 'UK' } }, 'GB'), true, 'a card declaring UK counts as GB');
  assert.equal(inJurisdiction({ jurisdiction: { country: 'pl' } }, 'eea'), true);
  assert.equal(inJurisdiction({ jurisdiction: { country: null } }, 'eea'), false, 'undeclared counts as outside');
  assert.equal(inJurisdiction({}, null), true, 'no filter, no restriction');

  const base = { modality: 'text', tier: 'verified', serving: { context_window: 8192 }, pricing: { input_per_mtok: 0, output_per_mtok: 0, currency: 'USD' }, observed: {} };
  const offerings = [
    { ...base, node_id: 'io.example.fi', offering_id: 'a', jurisdiction: { country: 'FI' } },
    { ...base, node_id: 'com.example.us', offering_id: 'b', jurisdiction: { country: 'US' } },
    { ...base, node_id: 'import.catalog', offering_id: 'c', jurisdiction: { country: null } },
    { ...base, node_id: 'local', offering_id: 'd', local: { run: 'ollama run d' } },
  ];
  const r = recommend(offerings, extractFeatures('summarize this note'), { jurisdiction: 'eea', limit: 10 });
  assert.deepEqual(r.recommendations.map((x) => x.node_id).sort(), ['io.example.fi', 'local']);
  assert.equal(r.rejected.jurisdiction, 2);
  assert.ok(r.recommendations.find((x) => x.node_id === 'io.example.fi').reasons.some((s) => s.includes('operator in FI (EEA)')));

  // registry search: the fixture's operator declares DE
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  const search = async (qs) => (await (await fetch(`${registry.origin}/v0/offerings?${qs}`)).json()).offerings.map((o) => o.node_id);
  assert.deepEqual(await search('jurisdiction=eea'), ['org.opennodes.fixture']);
  assert.deepEqual(await search('jurisdiction=US,GB'), []);
  const one = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings[0];
  assert.deepEqual(one.jurisdiction, { country: 'DE', regions: one.jurisdiction.regions, basis: 'declared', location: null });

  // imports: a known European provider gets an inferred country; an unknown one gets none
  await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: {
      berget: { id: 'berget', name: 'Berget AI', api: 'https://api.berget.ai/v1', models: { m: { id: 'm', name: 'M', cost: { input: 0.1, output: 0.2 } } } },
      acmecloud: { id: 'acmecloud', name: 'Acme', api: 'https://api.acme.example/v1', models: { n: { id: 'n', name: 'N', cost: { input: 0.1, output: 0.2 } } } },
    } }),
  });
  assert.deepEqual((await search('jurisdiction=eea')).sort(), ['import.modelsdev.berget', 'org.opennodes.fixture']);
  const berget = (await (await fetch(`${registry.origin}/v0/offerings?q=berget`)).json()).offerings[0];
  assert.equal(berget.jurisdiction.country, 'SE');
  assert.equal(berget.jurisdiction.basis, 'inferred');
  const r2 = recommend([berget], extractFeatures('summarize this note'), { jurisdiction: 'eea' });
  assert.ok(r2.recommendations[0].reasons.some((x) => x.includes('operator in SE (EEA, inferred)')));
});

test('auto model names: presets, EU/EEA and any country code', async (t) => {
  assert.deepEqual(parseAutoModel('auto'), { preset: null, jurisdiction: null });
  assert.deepEqual(parseAutoModel('auto-cheap'), { preset: 'cheap', jurisdiction: null });
  assert.deepEqual(parseAutoModel('auto-private'), { preset: 'private', jurisdiction: null });
  assert.deepEqual(parseAutoModel('auto-eu'), { preset: null, jurisdiction: 'eea' });
  assert.deepEqual(parseAutoModel('auto-CA'), { preset: null, jurisdiction: 'CA' });
  assert.deepEqual(parseAutoModel('onp/auto-ca', 'onp/'), { preset: null, jurisdiction: 'CA' });
  assert.deepEqual(parseAutoModel('auto-uk'), { preset: null, jurisdiction: 'GB' });
  assert.equal(parseAutoModel('auto-canada'), null);
  assert.equal(parseAutoModel('autopilot'), null);
  assert.equal(parseAutoModel('llama3.2:1b'), null);

  // the gateway lists auto-eu and auto-ca, and a country with no operators explains itself
  const registry = await startRegistry({ allowPrivateTargets: true });
  const gw = await startGateway({ port: 0, registry: registry.origin, env: {} });
  t.after(async () => { await gw.close(); await registry.close(); });
  const ids = (await (await fetch(`${gw.origin}/v1/models`)).json()).data.map((m) => m.id);
  assert.ok(ids.includes('onp/auto-eu') && ids.includes('onp/auto-ca'));
  const res = await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp/auto-jp', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 404);
  assert.match((await res.json()).type ?? '', /no-callable-offerings/);
});

test('failover budget: adaptive to measured latency and request size, bounded', () => {
  const fast = { observed: { ttft_ms: { p50: 300, p95: 800 }, tps: 50 } };
  assert.equal(responseBudgetMs(fast, { stream: true }), 15_000, 'quick node: the floor applies');
  const slow = { observed: { ttft_ms: { p95: 20_000 }, tps: 5 } };
  assert.equal(responseBudgetMs(slow, { stream: true }), 60_000, '3 x p95 time to first token');
  assert.equal(responseBudgetMs(slow, { stream: false, maxTokens: 100 }), 90_000, 'non-streamed adds expected generation time');
  assert.ok(responseBudgetMs(slow, { stream: true, promptTokens: 2000 }) > 60_000, 'long prompts get more time');
  assert.equal(responseBudgetMs(slow, { stream: false, maxTokens: 4000 }), 180_000, 'capped at 3 minutes');
  assert.equal(responseBudgetMs({}, { stream: true }), 30_000, 'unmeasured: 10 s assumed time to first token');
  assert.equal(responseBudgetMs({ serving: { expected_ttft_ms: { p95: 7000 } } }, { stream: true }), 21_000, 'declared latency when not measured');
});

test('fetchWithin gives up on a node that never answers', async (t) => {
  const server = http.createServer(() => { /* hang */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const t0 = performance.now();
  await assert.rejects(fetchWithin(`http://127.0.0.1:${server.address().port}/`, {}, 300), /no response within/);
  assert.ok(performance.now() - t0 < 3000);
});

test('routing a real request: tools and JSON needs come from the request, not the prompt words', () => {
  const guessed = extractFeatures('hi, how are you today?');
  assert.equal(guessed.needs.tools, true, 'describing a task: "today" suggests a web search');
  const routed = extractFeatures('hi, how are you today?', { request: { tools: undefined, json: false } });
  assert.equal(routed.needs.tools, false, 'no tools sent: any model will do');
  assert.equal(extractFeatures('look it up', { request: { tools: [{ type: 'function' }] } }).needs.tools, true);
  assert.equal(extractFeatures('extract as json', { request: { json: false } }).needs.json, false);
  assert.equal(extractFeatures('hello', { request: { json: true } }).needs.json, true);
});

test('auto-private: simple requests stay on this machine, demanding ones go to the strongest LAN model', () => {
  const free = { modality: 'text', pricing: { input_per_mtok: 0, output_per_mtok: 0 }, data_policy: { retention: 'none', training_on_inputs: false }, observed: { probe_success: 1, probes: 0 } };
  const local = (id, params_b) => ({ ...free, node_id: 'local', offering_id: id, tier: 'local', source: 'local', local: { run: `ollama run ${id}` },
    model: { name: id, params_b }, serving: { context_window: 8192, supports: ['streaming', 'tool_calls'] } });
  const h100 = { ...free, node_id: 'org.lab.h100', offering_id: 'qwen3-235b', tier: 'lan', source: 'lan',
    model: { name: 'Qwen/Qwen3-235B-A22B-FP8', params_b: 235 }, serving: { context_window: 32768, supports: ['streaming', 'tool_calls'], expected_tps: { p50: 60, basis: 'claimed' } } };
  const pick = (pool, prompt, tools) => recommend(pool, extractFeatures(prompt, { request: { tools, json: false } }),
    { preset: 'private', prefer_local: true, limit: 3 }).recommendations[0].offering;

  for (const pool of [[local('qwen3:8b', 8.2), h100], [local('llama3.2:3b', 3.2), h100]]) {
    const own = `local/${pool[0].offering_id}`;
    assert.equal(pick(pool, 'hi, how are you today?'), own);
    assert.equal(pick(pool, 'What is the capital of Australia?'), own);
    assert.equal(pick(pool, 'Prove step by step that the algorithm terminates.'), 'org.lab.h100/qwen3-235b');
    assert.equal(pick(pool, 'Debug this function and find the root cause: ' + 'x = y; '.repeat(80)), 'org.lab.h100/qwen3-235b');
    assert.equal(pick(pool, 'Summarize this report: ' + 'word '.repeat(9000)), 'org.lab.h100/qwen3-235b');
    assert.equal(pick(pool, 'Find the order status', [{ type: 'function' }]), 'org.lab.h100/qwen3-235b');
  }
  // Other presets are unchanged: the own-machine bonus still applies to every task outside auto-private.
  const quality = recommend([local('qwen3:8b', 8.2), h100], extractFeatures('hi there', { request: {} }), { preset: 'quality', prefer_local: true });
  assert.equal(quality.recommendations[0].offering, 'org.lab.h100/qwen3-235b');
});

test('RAG: recognised from the task, answered with an embedder and a generator', () => {
  const f = extractFeatures('Build a RAG app that answers questions over about 2,000 internal documents');
  assert.equal(f.task_class, 'rag');
  assert.equal(f.needs.retrieval, true);
  assert.deepEqual(f.corpus, { documents: 2000, private: true });
  assert.equal(f.est_input_tokens, 6000, 'one answer reads the question plus retrieved passages');
  assert.equal(extractFeatures('Build a RAG app over 2,000 documents', { request: {} }).est_input_tokens < 100, true, 'a real call counts its own size');
  assert.equal(extractFeatures('chat with our 15k support tickets').corpus.documents, 15000);
  assert.equal(extractFeatures('Write a python function that chunks PDFs for RAG').task_class, 'code');
  assert.equal(extractFeatures('What is the capital of France?').needs.retrieval, false);

  const O = (node, id, extra = {}) => ({ node_id: node, offering_id: id, tier: 'unverified', source: 'import', modality: 'text',
    model: { name: id }, binding: { model_id: id }, pricing: { currency: 'USD', input_per_mtok: 0.3, output_per_mtok: 1.2 },
    serving: { context_window: 131072, supports: ['streaming'] }, observed: {}, endpoints: { openai: `https://${node}.example/v1` }, ...extra });
  const pool = [
    O('import.hf.together', 'DeepSeek-V4.1-Flash', { model: { name: 'DeepSeek-V4.1-Flash', params_b: 284 } }),
    O('import.hf.together', 'DeepSeek-V4.1-Flash-1017', { model: { name: 'DeepSeek-V4.1-Flash-1017', params_b: 284 } }),
    O('import.hf.together', 'GLM-5.2', { model: { name: 'GLM-5.2', params_b: 355 } }),
    O('import.openrouter.catalog', 'cohere/command-r', { pricing: { currency: 'USD', input_per_mtok: 0.15, output_per_mtok: 0.6 },
      model: { name: 'Command R', description: 'Optimized for retrieval-augmented generation and tool use' } }),
    O('import.modelsdev.regolo-ai', 'qwen3-embedding-8b', { pricing: { currency: 'USD', input_per_mtok: 0.1, output_per_mtok: 0.1 } }),
    O('import.ollama.library', 'bge-m3', { modality: 'embedding', local: { run: 'ollama pull bge-m3' }, pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0 } }),
  ];
  const r = recommend(pool, f, { limit: 3 });
  assert.equal(r.recommendations[0].offering, 'import.openrouter.catalog/cohere/command-r', 'the RAG-tuned generator leads');
  assert.ok(r.recommendations[0].reasons.some((x) => /built for answering from retrieved documents/.test(x)));
  assert.ok(!r.recommendations.some((x) => /embedding/.test(x.offering)), 'embedding models never answer a chat');
  assert.equal(r.rejected.embedding_model, 1, 'the one listed as "text" is caught by its name');
  assert.equal(r.recommendations.filter((x) => /DeepSeek/.test(x.offering)).length, 1, 'one model, one place');

  assert.equal(r.roles.generate, 'recommendations');
  assert.equal(r.roles.embed[0].offering, 'import.ollama.library/bge-m3', 'a private collection: the local embedder first');
  assert.deepEqual(r.roles.embed[0].indexing_estimate, { usd: 0, basis: 'your own hardware' });
  const hosted = r.roles.embed.find((x) => x.node_id === 'import.modelsdev.regolo-ai');
  assert.equal(hosted.indexing_estimate.usd, 0.2, '2,000 documents × ~1,000 tokens × $0.10/MTok');
  assert.equal(recommend(pool, extractFeatures('hello'), {}).roles, undefined, 'no roles outside RAG');
});

test('RAG ranking: size counts up to ~50B; embedders by size and popularity', () => {
  const f = extractFeatures('RAG over our 2,000 internal documents');
  const gen = (node, name, params, extra = {}) => ({ node_id: node, offering_id: name, tier: 'unverified', source: 'import', modality: 'text',
    model: { name, params_b: params, ...extra }, binding: { model_id: name }, pricing: { currency: 'USD', input_per_mtok: 0.3, output_per_mtok: 1.2 },
    serving: { context_window: 131072 }, observed: {} });
  const r = recommend([gen('a', 'Giant', 750), gen('b', 'Mid-RAG', 35, { description: 'Built for retrieval-augmented generation with citations' })], f, { limit: 2 });
  assert.equal(r.recommendations[0].offering, 'b/Mid-RAG', 'a RAG-tuned 35B beats a 750B giant at the same price');
  assert.ok(r.recommendations[1].reasons.some((x) => /size counted up to ~50B for RAG/.test(x)));

  const emb = (id, params, pulls) => ({ node_id: 'import.ollama.library', offering_id: id, tier: 'unverified', source: 'import', modality: 'embedding',
    model: { name: id, params_b: params }, binding: { model_id: id }, pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0 },
    local: { run: `ollama pull ${id}`, pulls }, observed: {} });
  const e = recommend([emb('all-minilm', 0.03, '3.8M'), emb('bge-large', 0.34, '300.4K'), emb('mxbai-embed-large', 0.34, '16.5M'), emb('nomic-embed-text', null, '95.1M')], f, {}).roles.embed.map((x) => x.offering.split('/')[1]);
  assert.deepEqual(e, ['mxbai-embed-large', 'bge-large', 'nomic-embed-text'], 'mid-size first, more pulls break the tie; the 22M model drops out of the top 3');
});

test('diversity: the shortlist offers different models and providers before repeats', () => {
  const O = (node, name, params) => ({ node_id: node, offering_id: name, tier: 'unverified', source: 'import', modality: 'text',
    model: { name, params_b: params }, binding: { model_id: name }, pricing: { currency: 'USD', input_per_mtok: 0.2, output_per_mtok: 0.8 },
    serving: { context_window: 65536 }, observed: {} });
  const pool = [O('a', 'Big-1', 400), O('a', 'Big-1:latest', 400), O('a', 'Big-2', 390), O('a', 'Big-3', 380), O('b', 'Mid', 70)];
  const ids = recommend(pool, extractFeatures('hello', { request: {} }), { limit: 3 }).recommendations.map((x) => x.offering);
  assert.deepEqual(ids, ['a/Big-1', 'a/Big-2', 'b/Mid'], 'no duplicate model, at most two per node, then the rest');
  assert.equal(recommend(pool, extractFeatures('hello', { request: {} }), { limit: 5 }).recommendations.length, 5, 'repeats still fill a longer list');
});

test('hardware fit: local sizes carry a memory estimate; a memory budget picks the size that fits', () => {
  const lib = (id, sizes) => ({ node_id: 'import.ollama.library', offering_id: id, tier: 'unverified', source: 'import', modality: 'text',
    model: { name: id, params_b: Math.max(...sizes.map((x) => parseFloat(x))) }, binding: { model_id: id },
    pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0 }, serving: { supports: ['streaming'] },
    local: { runtime: 'ollama', run: `ollama run ${id}`, sizes }, observed: {} });
  const pool = [lib('llama3-chatqa', ['8b', '70b']), lib('granite4.1', ['3b', '8b', '30b'])];
  const f = extractFeatures('RAG over our 2,000 internal documents');

  const open = recommend(pool, f, { limit: 2 }).recommendations[0];
  assert.deepEqual(open.local_fit.sizes.map((x) => x.memory_gb), open.offering.includes('chatqa') ? [5.8, 46.5] : [2.4, 5.8, 19.3]);
  assert.equal(open.local_fit.pick, null, 'without a budget nothing is picked, every size is shown');
  assert.ok(open.reasons.some((x) => /memory needed \(4-bit estimate\): .*~\d/.test(x)));

  const laptop = recommend(pool, f, { local_memory_gb: 16, limit: 2 });
  for (const r of laptop.recommendations) assert.equal(r.local_fit.pick, '8b');
  assert.ok(laptop.recommendations[0].reasons.some((x) => /needs ~5\.8 GB RAM\/VRAM, within 16 GB/.test(x)));
  assert.match(laptop.recommendations[0].local_fit.run, /^ollama run .+:8b$/);

  const tiny = recommend(pool, f, { local_memory_gb: 4 });
  assert.deepEqual(tiny.recommendations.map((r) => r.offering), ['import.ollama.library/granite4.1']);
  assert.equal(tiny.recommendations[0].local_fit.pick, '3b');
  assert.equal(tiny.rejected.memory, 1, 'a model with no size that fits is left out');
});

test('locality: "on my laptop" prefers the own machine; "offline" requires it', () => {
  assert.equal(extractFeatures('RAG over our documents, running privately on my laptop').locality, 'preferred');
  assert.equal(extractFeatures('self-hosted chatbot for the team').locality, 'preferred');
  assert.equal(extractFeatures('air-gapped document search').locality, 'required');
  assert.equal(extractFeatures('summarize this, it must not leave my machine').locality, 'required');
  assert.equal(extractFeatures('private cloud deployment in the EU').locality, null, 'a private cloud is not the own machine');
  assert.equal(extractFeatures('run it locally', { request: {} }).locality, null, 'a routed call says it with auto-private, not prompt words');

  const hosted = { node_id: 'import.hf.baseten', offering_id: 'gpt-oss-120b', tier: 'unverified', source: 'import', modality: 'text',
    model: { name: 'gpt-oss-120b', params_b: 117 }, binding: { model_id: 'gpt-oss-120b' }, pricing: { currency: 'USD', input_per_mtok: 0.05, output_per_mtok: 0.2 },
    serving: { context_window: 131072, expected_ttft_ms: { p50: 600 }, expected_tps: { p50: 120 } }, observed: {} };
  const local = { node_id: 'import.ollama.library', offering_id: 'granite4.1', tier: 'unverified', source: 'import', modality: 'text',
    model: { name: 'granite4.1', params_b: 30 }, binding: { model_id: 'granite4.1' }, pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0 },
    serving: {}, local: { runtime: 'ollama', run: 'ollama run granite4.1', sizes: ['3b', '8b', '30b'] }, observed: {} };
  const laptop = recommend([hosted, local], extractFeatures('summarize this note on my laptop'), { local_memory_gb: 16 });
  assert.equal(laptop.recommendations[0].offering, 'import.ollama.library/granite4.1');
  assert.ok(laptop.recommendations[0].reasons.includes('runs on your own machine, as the task asked'));
  assert.equal(laptop.recommendations.length, 2, 'preferred, not required: hosted stays as an option');
  const strong = { ...hosted, offering_id: 'glm-5', model: { name: 'GLM-5', params_b: 744 } };
  const refactor = recommend([strong, local], extractFeatures('Refactor this Python function on my laptop'), { local_memory_gb: 16 });
  assert.deepEqual(refactor.recommendations.map((r) => r.offering), ['import.ollama.library/granite4.1', 'import.hf.baseten/glm-5'],
    'asked for the laptop: local first even against a far larger hosted model');
  const noFit = recommend([strong, local], extractFeatures('Refactor this Python function on my laptop'), { local_memory_gb: 2 });
  assert.deepEqual(noFit.recommendations.map((r) => r.offering), ['import.hf.baseten/glm-5'], 'nothing local fits: hosted is the fallback');
  const f = extractFeatures('Flag toxic comments in our forum, run it locally on my laptop');
  assert.equal(f.task_class, 'classification', 'moderation is a label per item, and "run it locally" is placement, not an agent');
  assert.equal(f.locality, 'preferred');
  const offline = recommend([hosted, local], extractFeatures('summarize this note offline'), {});
  assert.deepEqual(offline.recommendations.map((r) => r.offering), ['import.ollama.library/granite4.1']);
  assert.equal(offline.rejected.not_local, 1);
});

test('specialists: classifiers never chat, specialists score down outside their field and lead inside it', () => {
  const lib = (id, size) => ({ node_id: 'import.ollama.library', offering_id: id, tier: 'unverified', source: 'import', modality: 'text',
    model: { name: id, params_b: size }, binding: { model_id: id }, pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0 },
    serving: { supports: ['streaming'] }, local: { runtime: 'ollama', run: `ollama run ${id}`, sizes: [`${size}b`] }, observed: {} });
  const pool = [lib('mistral-small', 22), lib('codestral', 22), lib('gpt-oss-safeguard', 20), lib('llama-guard3', 8), lib('mistral-medium-3.5', 22)];
  const ids = (t) => recommend(pool, extractFeatures(t), { limit: 5 }).recommendations.map((r) => r.offering.split('/')[1]);

  const rag = recommend(pool, extractFeatures('RAG over our 2,000 internal documents on my laptop'), { limit: 5 });
  assert.equal(rag.rejected.classifier, 2, 'guard and safeguard models are classifiers');
  assert.deepEqual(rag.recommendations.map((r) => r.offering.split('/')[1]).slice(0, 2).sort(), ['mistral-medium-3.5', 'mistral-small'], 'general models first');
  assert.ok(rag.recommendations.find((r) => /codestral/.test(r.offering)).reasons.includes('coding specialist — scored down for a rag task'));
  assert.equal(ids('Refactor this Python function')[0], 'codestral', 'in its field the specialist leads');
  assert.equal(ids('Flag toxic comments in our forum')[0], 'gpt-oss-safeguard', 'moderation tasks may use classifiers');
  assert.ok(recommend(pool, extractFeatures('Flag toxic comments in our forum'), {}).recommendations[0].reasons
    .includes('safety / fact-check classifier, matching this task'), 'the classifier says why it was picked');

  // sensitive data on the user's own machine needs no published data policy
  const sensitive = recommend(pool, extractFeatures('Summarize patient discharge notes on my machine'), {});
  assert.equal(sensitive.features.privacy, 'sensitive');
  assert.ok(sensitive.recommendations.length > 0);
});

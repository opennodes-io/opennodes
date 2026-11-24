// HF + OpenRouter importers (fixtures mirror the live API shapes sampled 2026-08-23)
// and the stdio MCP server as a spawned child process (the editor install path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { startRegistry } from '@opennodes/registry';
import {
  mapModalities, hordeLineage, HORDE_STATUS_URL, HORDE_TEXT_REFERENCE_URL, HORDE_OPENAI_BASE,
} from '@opennodes/registry/src/importers.js';
import { startReimport, dueSources } from '@opennodes/registry/src/reimport.js';
import { createSqliteStore } from '@opennodes/registry/src/store.js';
import { callable } from '@opennodes/cli/src/gateway.js';
import { autoRoutable } from '@opennodes/core';

const HF_ROUTER_FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'zai-org/GLM-5.3-Flash', owned_by: 'zai-org',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      providers: [
        { provider: 'zai-org', status: 'live', is_free: false, supports_tools: true,
          supports_structured_output: false, first_token_latency_ms: 1161.6, throughput: 36.1,
          context_length: 131072, pricing: { input: 0.35, output: 1.4 } },
        { provider: 'deepinfra', status: 'staging', is_free: false },
        { provider: 'novita', status: 'live', is_free: false, context_length: 131072 },
      ],
    },
    {
      id: 'black-forest/FLUX-2-dev', owned_by: 'black-forest',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      providers: [
        { provider: 'fal-ai', status: 'live', is_free: false },
      ],
    },
  ],
};
const HF_HUB_FIXTURE = [
  { id: 'zai-org/GLM-5.3-Flash', pipeline_tag: 'text-generation',
    safetensors: { total: 28_500_000_000 } },
  { id: 'black-forest/FLUX-2-dev', pipeline_tag: 'text-to-image',
    safetensors: { total: 12_000_000_000 } },
];

const OPENROUTER_FIXTURE = {
  data: [
    {
      id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', hugging_face_id: 'zai-org/GLM-5.3-Flash',
      context_length: 1048576,
      architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
      pricing: { prompt: '0.000000075', completion: '0.00000025', input_cache_read: '0.000000015' },
      top_provider: { max_completion_tokens: 131072 },
      supported_parameters: ['tools', 'response_format'],
    },
    {
      id: 'openai/gpt-5', name: 'OpenAI: GPT-5', hugging_face_id: null,
      context_length: 400000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      supported_parameters: ['tools'],
    },
    {
      id: 'meta/free-model', name: 'Free Model', hugging_face_id: null,
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
  ],
};

test('modality mapping from input/output arrays', () => {
  assert.equal(mapModalities(['text'], ['text']), 'text');
  assert.equal(mapModalities(['text', 'image'], ['text']), 'multimodal');
  assert.equal(mapModalities(['text'], ['image']), 'image');
  assert.equal(mapModalities(['text', 'image'], ['video']), 'video');
  assert.equal(mapModalities(['text'], ['embedding']), 'embedding');
});

test('HF importer: per-provider nodes, live-only, params_b, perf as claimed, image models', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());

  const result = await (await fetch(`${registry.origin}/v0/import/huggingface`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ router: HF_ROUTER_FIXTURE, hub: HF_HUB_FIXTURE }),
  })).json();
  assert.equal(result.providers, 3);          // zai-org + novita + fal-ai; deepinfra staging excluded
  assert.equal(result.offerings, 3);

  const text = (await (await fetch(`${registry.origin}/v0/offerings?modality=text`)).json()).offerings;
  assert.equal(text.length, 2);
  const glm = text.find((o) => o.node_id === 'import.hf.zai-org');
  const unpriced = text.find((o) => o.node_id === 'import.hf.novita');
  assert.equal(unpriced.pricing.input_per_mtok, undefined, 'no pricing from HF: not published, not free');
  assert.equal(glm.node_id, 'import.hf.zai-org');
  assert.equal(glm.model.artifact, 'hf:zai-org/GLM-5.3-Flash');
  assert.equal(glm.model.params_b, 28.5);     // from safetensors
  assert.equal(glm.pricing.input_per_mtok, 0.35);
  assert.equal(glm.serving.expected_ttft_ms.basis, 'claimed');
  assert.ok(glm.serving.supports.includes('tool_calls'));

  const images = (await (await fetch(`${registry.origin}/v0/offerings?modality=image`)).json()).offerings;
  assert.equal(images.length, 1);
  assert.equal(images[0].node_id, 'import.hf.fal-ai');
});

test('OpenRouter importer: per-token prices to per-MTok, hf artifact join, modalities', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());

  const result = await (await fetch(`${registry.origin}/v0/import/openrouter`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: OPENROUTER_FIXTURE }),
  })).json();
  assert.equal(result.providers, 1);
  assert.equal(result.offerings, 3);

  const all = (await (await fetch(`${registry.origin}/v0/offerings?limit=10`)).json()).offerings;
  const glm = all.find((o) => o.offering_id === 'z-ai-glm-5.3-flash');
  assert.equal(glm.pricing.input_per_mtok, 0.075);       // 0.000000075 * 1e6
  assert.equal(glm.pricing.output_per_mtok, 0.25);
  assert.equal(glm.pricing.cached_input_per_mtok, 0.015);
  assert.equal(glm.model.artifact, 'hf:zai-org/GLM-5.3-Flash');  // hugging_face_id join
  assert.equal(glm.modality, 'multimodal');
  assert.deepEqual(glm.modalities.input, ['text', 'image', 'video']);
  assert.equal(glm.serving.context_window, 1048576);

  const gpt = all.find((o) => o.offering_id === 'openai-gpt-5');
  assert.equal(gpt.model.artifact, 'urn:proprietary:openai:gpt-5');
  assert.ok(gpt.serving.supports.includes('vision'));

  const free = all.find((o) => o.offering_id === 'meta-free-model');
  assert.deepEqual(free.pricing.schemes, ['free']);

  // min_context works across imported catalogs
  const big = (await (await fetch(`${registry.origin}/v0/offerings?min_context=1000000`)).json()).offerings;
  assert.equal(big.length, 1);
});

// Shapes mirror live models.dev/api.json (sampled 2026-10-19): groq/mistral/openai carry
// only `doc` (their AI SDK packages know the URL); fireworks-ai's `api` has a trailing slash.
const MODELS_DEV_FIXTURE = {
  groq: {
    id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models', npm: '@ai-sdk/groq',
    models: { 'llama-3.3-70b-versatile': { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', cost: { input: 0.59, output: 0.79 } } },
  },
  'fireworks-ai': {
    id: 'fireworks-ai', name: 'Fireworks AI', api: 'https://api.fireworks.ai/inference/v1/', doc: 'https://fireworks.ai/docs/',
    models: { 'accounts/fireworks/models/glm-5': { id: 'accounts/fireworks/models/glm-5', name: 'GLM-5', cost: { input: 1, output: 3 } } },
  },
  cohere: {
    id: 'cohere', name: 'Cohere', doc: 'https://docs.cohere.com/docs/models', npm: '@ai-sdk/cohere',
    models: { 'command-a': { id: 'command-a-03-2025', name: 'Command A', cost: { input: 2.5, output: 10 } } },
  },
  bare: { id: 'bare', name: 'Bare Inc', models: { m1: { id: 'm1', name: 'Bare One', cost: { input: 1, output: 1 } } } },
  databricks: {   // per-account URL template: no single public base
    id: 'databricks', name: 'Databricks', api: 'https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1',
    doc: 'https://docs.databricks.com/aws/en/machine-learning/foundation-models/',
    models: { 'dbrx': { id: 'databricks-dbrx', name: 'DBRX', cost: { input: 0.75, output: 2.25 } } },
  },
};

test('models.dev importer: never uses doc as an API base; known bases fill gaps; others list as not invocable', async (t) => {
  const { MODELS_DEV_API_BASES } = await import('@opennodes/registry/src/importers.js');
  const { callable } = await import('@opennodes/cli/src/gateway.js');
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());

  const result = await (await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: MODELS_DEV_FIXTURE }),
  })).json();
  assert.deepEqual(result, { providers: 5, offerings: 5, skipped: [] });   // nothing dropped: listing-only still imports

  const all = (await (await fetch(`${registry.origin}/v0/offerings?q=import.modelsdev`)).json()).offerings;
  const by = Object.fromEntries(all.map((o) => [o.node_id.split('.').pop(), o]));

  // groq: no `api` -> the known base, never console.groq.com/docs
  assert.equal(by.groq.endpoints.openai, 'https://api.groq.com/openai/v1');
  assert.equal(by.groq.endpoints.health, 'https://api.groq.com/openai/v1/health');
  assert.equal(by.groq.endpoints.docs, 'https://console.groq.com/docs/models');
  assert.equal(by.groq.invocable, true);

  // fireworks: models.dev `api` wins, trailing slash normalized (no //chat/completions)
  assert.equal(by['fireworks-ai'].endpoints.openai, 'https://api.fireworks.ai/inference/v1');

  // cohere: neither api nor a known base -> listed, docs kept, no invocation endpoints
  assert.equal(by.cohere.invocable, false);
  assert.equal(by.cohere.endpoints.openai, undefined);
  assert.equal(by.cohere.endpoints.health, undefined);
  assert.equal(by.cohere.endpoints.docs, 'https://docs.cohere.com/docs/models');
  assert.equal(by.cohere.pricing.input_per_mtok, 2.5);
  const node = await (await fetch(`${registry.origin}/v0/nodes/import.modelsdev.cohere`)).json();
  assert.equal(node.origin, 'https://docs.cohere.com');

  // bare: no api, no doc -> still listed, endpoints empty
  assert.equal(by.bare.invocable, false);
  assert.deepEqual(by.bare.endpoints, {});

  // no imported offering ever points at a documentation page
  for (const o of all) if (o.endpoints.openai) assert.doesNotMatch(o.endpoints.openai, /docs|console\./);

  // invocable filter, and recommend never proposes what cannot be called
  const listingOnly = (await (await fetch(`${registry.origin}/v0/offerings?q=import.modelsdev&invocable=false`)).json()).offerings;
  assert.deepEqual(listingOnly.map((o) => o.node_id).sort(), ['import.modelsdev.bare', 'import.modelsdev.cohere', 'import.modelsdev.databricks']);
  const rec = await (await fetch(`${registry.origin}/v0/recommend`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Summarize this paragraph.', policy: { limit: 10 } }),
  })).json();
  assert.ok(rec.recommendations.length > 0);
  assert.ok(rec.recommendations.every((r) => r.endpoint), 'listing-only offerings are not recommended');

  // the gateway never routes to a listing-only offering, whatever keys it holds
  assert.equal(callable(by.cohere, { 'docs.cohere.com': 'k' }), false);
  assert.equal(callable(by.groq, { 'api.groq.com': 'k' }), true);

  // every mapped base is an https API URL, never a docs page
  for (const [id, base] of Object.entries(MODELS_DEV_API_BASES)) {
    assert.match(base, /^https:\/\/api\.[a-z.]+\/[a-z0-9/]*v1(\/openai)?$/, id);
  }
});

test('Ollama library importer: parses tiles, maps to local offerings on a localhost node', async (t) => {
  const { parseOllamaLibrary } = await import('@opennodes/registry/src/importers.js');
  // fixture mirrors the live ollama.com/library tile structure sampled 2026-08-27
  const html = `
    <li><a href="/library/gemma3" class="group"><h2><span>gemma3</span></h2>
    <p class="max-w-lg break-words text-neutral-800 text-md">The current, most capable model that runs on a single GPU.</p>
    <span class="inline-flex items-center rounded-md bg-indigo-50">vision</span>
    <span class="inline-flex items-center rounded-md">1b</span>
    <span class="inline-flex items-center rounded-md">27b</span>
    <span >39.9M</span> <span class="hidden sm:flex">&nbsp;Pulls</span></a></li>
    <li><a href="/library/nomic-embed-text"><h2><span>nomic-embed-text</span></h2>
    <p class="max-w-lg break-words">A high-performing open embedding model.</p>
    <span class="inline-flex items-center">embedding</span>
    <span >22M</span> <span class="hidden sm:flex">&nbsp;Pulls</span></a></li>`;
  const entries = parseOllamaLibrary(html);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'gemma3');
  assert.deepEqual(entries[0].sizes, ['1b', '27b']);
  assert.deepEqual(entries[0].capabilities, ['vision']);
  assert.equal(entries[0].pulls, '39.9M');
  assert.match(entries[0].description, /single GPU/);

  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const result = await (await fetch(`${registry.origin}/v0/import/ollama`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  })).json();
  assert.equal(result.providers, 1);
  assert.equal(result.offerings, 2);

  const all = (await (await fetch(`${registry.origin}/v0/offerings?limit=10`)).json()).offerings;
  const gemma = all.find((o) => o.offering_id === 'gemma3');
  assert.equal(gemma.node_id, 'import.ollama.library');
  assert.equal(gemma.modality, 'multimodal');       // vision capability
  assert.equal(gemma.model.params_b, 27);           // largest size
  assert.equal(gemma.local.run, 'ollama run gemma3');
  assert.equal(gemma.local.pulls, '39.9M');
  assert.deepEqual(gemma.pricing.schemes, ['free']);
  assert.equal(gemma.endpoints.openai, 'http://127.0.0.1:11434/v1'); // your own machine

  const embed = all.find((o) => o.offering_id === 'nomic-embed-text');
  assert.equal(embed.modality, 'embedding');
  assert.equal(embed.binding.profile, 'onp.openai.embeddings/v1');
});

test('local models list apart: counts, popularity rank, memory fit, sizes with memory, decoded descriptions', async (t) => {
  const { parseOllamaLibrary } = await import('@opennodes/registry/src/importers.js');
  const tile = (name, desc, sizes, pulls, caps = []) => `<li><a href="/library/${name}"><h2><span>${name}</span></h2>
    <p class="max-w-lg break-words">${desc}</p>
    ${caps.map((c) => `<span class="inline-flex items-center">${c}</span>`).join('')}
    ${sizes.map((s) => `<span class="inline-flex items-center">${s}</span>`).join('')}
    <span >${pulls}</span> <span class="hidden sm:flex">&nbsp;Pulls</span></a></li>`;
  const entries = parseOllamaLibrary(tile('llama3.2', 'Meta&#39;s Llama 3.2 goes small &amp; fast.', ['1b', '3b'], '86.8M')
    + tile('codestral', 'Mistral AI&#39;s code model.', ['22b'], '600K')
    + tile('llama3.1', 'Big one.', ['8b', '70b', '405b'], '120.8M'));
  assert.equal(entries[0].description, "Meta's Llama 3.2 goes small & fast.", 'HTML entities decoded');

  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const post = (path, body) => fetch(`${registry.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/v0/import/ollama', { entries });
  await post('/v0/import/models-dev', { catalog: { acmecloud: { id: 'acmecloud', name: 'Acme', api: 'https://api.acmecloud.example/v1',
    models: { 'llama-3.2-3b': { id: 'llama-3.2-3b', name: 'Llama 3.2 3B', cost: { input: 0.1, output: 0.2 } } } } } });
  const get = async (qs) => (await fetch(`${registry.origin}/v0/offerings?${qs}`)).json();

  const local = await get('local=true');
  assert.deepEqual(local.counts, { hosted: 1, local: 3 });
  assert.deepEqual(local.offerings.map((o) => o.offering_id), ['llama3.1', 'llama3.2', 'codestral'], 'most pulled first');
  assert.equal(local.offerings[0].rank, 1);
  assert.equal(local.offerings[0].rank_explanation.basis, 'local');
  assert.deepEqual(local.offerings[1].local.sizes_memory, [{ tag: '1b', memory_gb: 1.2 }, { tag: '3b', memory_gb: 2.5 }]);
  assert.equal(local.offerings[2].specialty, 'coding');

  const hosted = await get('local=false');
  assert.deepEqual(hosted.offerings.map((o) => o.offering_id), ['llama-3.2-3b']);
  assert.equal(hosted.counts.local, 3, 'counts are taken before the local filter');

  assert.deepEqual((await get('local=true&memory_gb=4')).offerings.map((o) => o.offering_id), ['llama3.2'], 'only models with a size that fits');
  assert.deepEqual((await get('local=true&sort=size')).offerings.map((o) => o.offering_id), ['llama3.2', 'llama3.1', 'codestral'], 'smallest first');
  const installed = await get('local=true&ids=llama3.2,codestral,not-in-registry');
  assert.deepEqual(installed.offerings.map((o) => o.offering_id), ['llama3.2', 'codestral'], "ids: the models installed in the visitor's Ollama");
  assert.equal(installed.counts.local, 3, 'tab counts stay whole under ids');
  const mixed = (await get('')).offerings;
  assert.equal(mixed[0].offering_id, 'llama-3.2-3b', 'in a mixed list hosted comes before local: their scores measure different things');
});

test('registry serves the web app at /', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const res = await fetch(`${registry.origin}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /OpenNodes Registry/);
  assert.match(html, /Register an AI node/);
  assert.match(html, /qualification procedure/i);
  assert.match(html, /navigator\.modelContext/); // WebMCP progressive enhancement present
  assert.match(html, /__onpWebMcpTools/);
  const health = await (await fetch(`${registry.origin}/v0/health`)).json();
  assert.equal(health.webmcp, true);
});

test('stdio MCP server: real child process serves search + estimate over imported catalog', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  await fetch(`${registry.origin}/v0/import/openrouter`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: OPENROUTER_FIXTURE }),
  });

  const binPath = fileURLToPath(new URL('../packages/cli/bin.js', import.meta.url));
  const child = spawn(process.execPath, [binPath, 'mcp'], {
    env: { ...process.env, ONP_REGISTRY: registry.origin },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());

  const responses = [];
  let buffer = '';
  let consumed = 0;
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) { responses.push(JSON.parse(line)); waiters.shift()?.(); }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const nextResponse = () => new Promise((resolve, reject) => {
    if (responses.length > consumed) { consumed++; return resolve(); }
    waiters.push(() => { consumed++; resolve(); });
    setTimeout(() => reject(new Error('mcp child response timeout')), 10_000).unref();
  });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await nextResponse();
  assert.equal(responses[0].result.serverInfo.name, 'opennodes');

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_offerings', arguments: { q: 'gpt-5', sort: 'price' } } });
  await nextResponse();
  const found = responses[1].result.structuredContent.offerings;
  assert.equal(found.length, 1);
  assert.equal(found[0].binding.model_id, 'openai/gpt-5');

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estimate', arguments: { steps: [{ select: { modality: 'text', sort: 'price' }, est_input_tokens: 1000, est_output_tokens: 500 }] } } });
  await nextResponse();
  const est = responses[2].result.structuredContent;
  assert.ok(est.steps[0].card_revision);
  assert.equal(est.total.min, 0); // cheapest text offering in fixture is the free model
});

// ---- AI Horde (recorded from the live public API on 2026-11-20) ----
// status: GET https://aihorde.net/api/v2/status/models?type=text&chat=true, verbatim (16 models).
// reference: the entries of Haidra's text model reference (db.json) for those names, verbatim (9 known).
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/horde/${name}`, import.meta.url), 'utf8'));
const HORDE_STATUS = fixture('status-text-chat-2026-11-20.json');
const HORDE_REFERENCE = fixture('reference-subset-2026-11-20.json');
const HORDE = 'import.aihorde.text';

test('AI Horde importer: models with chat workers and a public record, free, logged, lineage only when certain', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const post = (body) => fetch(`${registry.origin}/v0/import/horde`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const result = await post({ status: HORDE_STATUS, reference: HORDE_REFERENCE });
  assert.equal(result.providers, 1);
  assert.equal(result.offerings, 7, 'only models whose reference entry names a Hugging Face record');
  assert.equal(result.workers, 9);
  assert.equal(result.skipped.length, 9);
  assert.ok(result.skipped.includes('koboldcpp/Llama-3.2-1B-Instruct: no public model record'), 'known to the reference, but no url');
  assert.ok(result.skipped.includes('koboldcpp/Cydonia-24B-v4zg-Q4_K_M: no public model record'), 'a worker-declared name');

  const horde = (await (await fetch(`${registry.origin}/v0/offerings?limit=100`)).json()).offerings.filter((o) => o.node_id === HORDE);
  assert.equal(horde.length, 7);
  const byModel = Object.fromEntries(horde.map((o) => [o.binding.model_id, o]));

  const stheno = byModel['koboldcpp/L3-8B-Stheno-v3.2'];
  assert.equal(stheno.model.artifact, 'hf:Sao10K/L3-8B-Stheno-v3.2');
  assert.equal(stheno.model.lineage_origins, undefined, 'a fine-tune: lineage unknown, never clean');
  assert.equal(stheno.binding.profile, 'onp.openai.chat/v1');
  assert.equal(stheno.endpoints.openai, HORDE_OPENAI_BASE);
  assert.equal(stheno.serving.context_window, 4352);
  assert.equal(stheno.serving.max_output_tokens, 512);
  assert.deepEqual(stheno.serving.supports, ['streaming', 'json_mode', 'structured_outputs', 'reasoning', 'tool_calls']);
  assert.deepEqual(stheno.pricing, { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] });
  assert.deepEqual(stheno.data_policy, { retention: 'logged', source: 'https://aihorde.net/faq', checked: '2026-11-20' });
  // chat workers (2), not every text worker (count 6); queue as the Horde reports it
  const { reported_at, ...upstream } = stheno.observed.upstream;
  assert.deepEqual(upstream, { source: 'aihorde', basis: 'reported', workers: 2, queued_tokens: 2048, jobs: 4, eta_s: 15 });
  assert.ok(!Number.isNaN(Date.parse(reported_at)));
  assert.equal(stheno.tier, 'unverified');
  assert.equal(stheno.tested, false);
  assert.equal(stheno.observed.probes, 0);
  assert.equal(stheno.jurisdiction.country, null, 'no operator country: volunteers run anywhere');

  // Qwen's own releases are from scratch: CN. Artemis's reference baseline is Gemma 4, but a
  // fine-tuner is in the chain too, so it stays unknown.
  assert.deepEqual(byModel['koboldcpp/Qwen3-14B'].model.lineage_origins, ['CN']);
  assert.deepEqual(byModel['Qwen/Qwen3.8-Flash-Next'].model.lineage_origins, ['CN']);
  assert.equal(byModel['koboldcpp/Artemis-31B-v1.2'].model.lineage_origins, undefined);
  assert.equal(byModel['Qwen/Qwen3.8-Flash-Next'].modality, 'multimodal');
  assert.ok(byModel['Qwen/Qwen3.8-Flash-Next'].serving.supports.includes('vision'));
  assert.equal(horde.filter((o) => o.model.lineage_origins).length, 4);

  // The node says who can read prompts and links the Horde's own documents.
  const { card } = await (await fetch(`${registry.origin}/v0/nodes/${HORDE}`)).json();
  assert.equal(card.node.operator.country, undefined);
  for (const s of ['can technically read and keep prompts', 'https://aihorde.net/terms', 'https://aihorde.net/privacy', 'https://aihorde.net/faq', '0000000000']) {
    assert.ok(card.node.description.includes(s), `node description mentions ${s}`);
  }
});

test('AI Horde listings stay in the open pool: trusted view, sensitive requests and the gateway exclude them', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const post = (path, body) => fetch(`${registry.origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await post('/v0/import/horde', { status: HORDE_STATUS, reference: HORDE_REFERENCE });
  const get = async (q) => (await (await fetch(`${registry.origin}/v0/offerings?limit=100&${q}`)).json()).offerings.filter((o) => o.node_id === HORDE);

  const all = await get('');
  assert.equal(all.length, 7);
  assert.ok(all.every((o) => o.pool === 'open'));
  assert.deepEqual(await get('trust=trusted'), [], 'the trusted view never lists them');
  assert.deepEqual(await get('retention=none'), [], 'declared retention is logged');
  assert.deepEqual(await get('jurisdiction=eu'), [], 'no operator country, so no jurisdiction matches');

  const advise = async (policy) => (await (await post('/v0/recommend', { task: 'Write a short story about a lighthouse', policy })).json()).recommendations;
  assert.ok((await advise({})).some((r) => r.node_id === HORDE), 'an ordinary request can be pointed at the Horde');
  assert.ok((await advise({ sensitive: true })).every((r) => r.node_id !== HORDE), 'a sensitive request never is');
  assert.ok((await advise({ trust: 'trusted' })).every((r) => r.node_id !== HORDE));

  // The local gateway routes an imported listing only with the user's own key for its host.
  assert.equal(callable(all[0], {}), false);
  assert.equal(callable(all[0], { 'oai.aihorde.net': 'a-user-key' }), true);
  // Even with a key, automatic routing (onp/auto, fallback, failover) never picks it unless the user opts in.
  assert.ok(all.every((o) => !autoRoutable(o)));
  assert.ok(all.every((o) => autoRoutable(o, { allow_logged: true })));
});

test('AI Horde: a ping is refused, an empty snapshot delists and a bad read changes nothing', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const post = (body) => fetch(`${registry.origin}/v0/import/horde`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const listed = async () => (await (await fetch(`${registry.origin}/v0/offerings?limit=100`)).json()).offerings.filter((o) => o.node_id === HORDE).length;
  await post({ status: HORDE_STATUS, reference: HORDE_REFERENCE });

  // A ping would run Stage A, which calls the endpoint, and the Horde answers without a key.
  const ping = await fetch(`${registry.origin}/v0/nodes/${HORDE}/ping`, { method: 'PUT' });
  assert.equal(ping.status, 409);
  assert.equal((await ping.json()).title, 'imported-listing');

  // A response that is not a model list (an error body, a rate limit) leaves the listing alone.
  assert.deepEqual((await post({ status: { message: 'Too many requests' }, reference: HORDE_REFERENCE })).skipped, ['status is not a list']);
  assert.equal(await listed(), 7);

  // No model with chat workers: delisted, not left showing workers that have gone.
  const empty = await post({ status: [], reference: HORDE_REFERENCE });
  assert.equal(empty.offerings, 0);
  assert.equal(await listed(), 0);

  // Workers back: listed again.
  await post({ status: HORDE_STATUS, reference: HORDE_REFERENCE });
  assert.equal(await listed(), 7);
});

test('AI Horde lineage: from-scratch releases only', () => {
  assert.equal(hordeLineage('Qwen/Qwen3-14B'), 'CN');
  assert.equal(hordeLineage('Qwen/Qwen2.5-7B-Instruct'), 'CN');
  assert.equal(hordeLineage('zai-org/GLM-4.5-Air'), 'CN');
  assert.equal(hordeLineage('google/gemma-4-31B-it'), 'US');
  assert.equal(hordeLineage('meta-llama/Llama-3.2-1B-Instruct'), 'US');
  assert.equal(hordeLineage('mistralai/Mistral-Small-3.1-24B-Instruct-2503'), 'FR');
  assert.equal(hordeLineage('TheDrummer/Artemis-31B-v1.2'), null, 'a fine-tune');
  assert.equal(hordeLineage('unsloth/Qwen3-14B'), null, 'a re-upload under another account');
  assert.equal(hordeLineage('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B'), null, 'a distillation');
  assert.equal(hordeLineage('Qwen/Qwen2.5-Distill-Test'), null, 'distilled, even under a listed account');
  assert.equal(hordeLineage('mistralai/Devstral-Small-2505'), null, 'co-developed: not on the list');
  // An org's own release can start from someone else's weights: Bielik 1.5B v3 is initialised from
  // Qwen2.5 1.5B (honest lineage PL+CN), Bielik 11B v3 from Mistral 7B (PL+FR). Not from scratch: unknown.
  assert.equal(hordeLineage('speakleash/Bielik-1.5B-v3.0-Instruct'), null);
  assert.equal(hordeLineage('speakleash/Bielik-11B-v3.0-Instruct'), null);
  assert.equal(hordeLineage(null), null);
});

test('AI Horde re-import: reads only the public status (with Client-Agent) and the reference, hourly', async () => {
  const store = await createSqliteStore(':memory:');
  const calls = [];
  let referenceOk = true;
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, agent: opts.headers?.['client-agent'] ?? null });
    if (url === HORDE_STATUS_URL) return { ok: true, status: 200, json: async () => HORDE_STATUS };
    if (url === HORDE_TEXT_REFERENCE_URL) return referenceOk
      ? { ok: true, status: 200, json: async () => HORDE_REFERENCE }
      : { ok: false, status: 429, json: async () => ({ message: 'rate limited' }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const handle = startReimport(store, { safeFetch: fakeFetch, sources: ['horde'] });
  const r1 = await handle.cycle();
  assert.equal(r1.horde.offerings, 7);
  assert.deepEqual(calls.map((c) => c.url), [HORDE_STATUS_URL, HORDE_TEXT_REFERENCE_URL], 'nothing else: no request to a worker or the front');
  assert.match(calls[0].agent, /^opennodes-registry:\d+\.\d+\.\d+:https:\/\/opennodes\.io$/);

  // A failed reference read keeps the last snapshot (it would otherwise look like nothing to list).
  referenceOk = false;
  const r2 = await handle.cycle();
  assert.match(r2.horde.error, /answered 429/);
  assert.equal((await store.latestCard(HORDE)).offerings.length, 7);
  assert.equal((await store.getNode(HORDE)).state, 'indexed');
  handle.stop();
  await store.close();

  // Horde refreshes hourly while the catalogs keep their six-hour interval.
  const six = 6 * 3600_000, hour = 3600_000;
  const last = new Map([['openrouter', 0], ['horde', 0]]);
  assert.deepEqual(dueSources(['openrouter', 'horde'], last, hour, six), ['horde']);
  assert.deepEqual(dueSources(['openrouter', 'horde'], last, hour - 1, six), []);
  assert.deepEqual(dueSources(['openrouter', 'horde'], last, six, six), ['openrouter', 'horde']);
  assert.deepEqual(dueSources(['openrouter', 'horde'], new Map(), 0, six), ['openrouter', 'horde'], 'first run: all');
  assert.deepEqual(dueSources(['horde'], last, hour, 1800_000), ['horde'], 'a shorter catalog interval wins');
  // A broken or tiny per-source interval never polls the Horde in a loop: the catalog interval applies.
  for (const bad of [0, NaN, 5_000]) {
    assert.deepEqual(dueSources(['horde'], last, hour, six, { horde: bad }), [], `interval ${bad} is ignored`);
  }
});

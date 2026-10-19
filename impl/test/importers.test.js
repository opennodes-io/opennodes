// HF + OpenRouter importers (fixtures mirror the live API shapes sampled 2026-08-23)
// and the stdio MCP server as a spawned child process (the editor install path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRegistry } from '@opennodes/registry';
import { mapModalities } from '@opennodes/registry/src/importers.js';

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
  assert.equal(result.providers, 2);          // zai-org + fal-ai; deepinfra staging excluded
  assert.equal(result.offerings, 2);

  const text = (await (await fetch(`${registry.origin}/v0/offerings?modality=text`)).json()).offerings;
  assert.equal(text.length, 1);
  const glm = text[0];
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

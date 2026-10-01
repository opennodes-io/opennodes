// OpenNodes for Ollama: one Ollama-compatible endpoint over local (fake Ollama), LAN (a second
// fake Ollama as a peer), and public (fixture node via the registry) tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, listen, closeApp, sendJson, readJson } from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startOllamaRouter } from '@opennodes/ollama-router';
import { ollamaChatToOpenAI, OllamaChunker } from '@opennodes/ollama-router/src/translate.js';

/** Minimal Ollama look-alike: tags, show, chat (NDJSON stream + non-stream), generate, version. */
async function startFakeOllama({ models = ['tiny:latest'] } = {}) {
  const app = createApp([
    ['GET', '/api/version', (req, res) => sendJson(res, 200, { version: '0.34.0' })],
    ['GET', '/api/tags', (req, res) => sendJson(res, 200, { models: models.map((name) => ({ name, model: name, modified_at: '2026-09-01T00:00:00Z', size: 10, digest: 'abc', details: { family: 'tiny', families: ['tiny'], parameter_size: '1.0B', quantization_level: 'Q4_0', format: 'gguf' } })) })],
    ['POST', '/api/show', async (req, res) => { const b = await readJson(req); sendJson(res, 200, { modelfile: '', details: { family: 'tiny', parameter_size: '1.0B' }, model_info: { 'tiny.context_length': 4096 }, capabilities: ['completion', 'tools'], shown: b.model }); }],
    ['POST', '/api/chat', async (req, res) => {
      const b = await readJson(req);
      const text = `fake(${b.model}): ` + (b.messages.at(-1)?.content ?? '');
      const fin = { model: b.model, created_at: 'now', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3, total_duration: 1 };
      if (b.stream === false) return sendJson(res, 200, { ...fin, message: { role: 'assistant', content: text } });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ model: b.model, created_at: 'now', message: { role: 'assistant', content: text }, done: false }) + '\n');
      res.end(JSON.stringify(fin) + '\n');
    }],
    ['POST', '/api/generate', async (req, res) => { const b = await readJson(req); sendJson(res, 200, { model: b.model, response: 'gen:' + b.prompt, done: true, prompt_eval_count: 2, eval_count: 2 }); }],
    ['POST', '/v1/chat/completions', async (req, res) => { const b = await readJson(req); sendJson(res, 200, { id: 'x', object: 'chat.completion', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: 'v1:' + b.messages.at(-1).content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); }],
  ]);
  const port = await listen(app, 0);
  return { origin: `http://127.0.0.1:${port}`, close: () => closeApp(app) };
}

async function publicTier(t) {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }) })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  return { node, registry };
}

const ndjson = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

test('translate: Ollama chat -> OpenAI, and OpenAI chunks -> Ollama final with tool calls', () => {
  const req = ollamaChatToOpenAI({ model: 'm', messages: [{ role: 'user', content: 'hi', images: ['AAAA'] }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }] }, { role: 'tool', content: '42' }], options: { temperature: 0.2, num_predict: 50 }, format: 'json', stream: false }, 'up');
  assert.equal(req.model, 'up');
  assert.equal(req.messages[0].content[1].type, 'image_url');
  assert.equal(req.messages[1].tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(req.messages[2].tool_call_id, 'call_0');
  assert.deepEqual([req.temperature, req.max_tokens, req.response_format.type, req.stream], [0.2, 50, 'json_object', false]);

  const c = new OllamaChunker({ model: 'req', mode: 'chat' });
  assert.equal(c.take({ choices: [{ delta: { content: 'Hel' } }] }).message.content, 'Hel');
  assert.equal(c.take({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'look', arguments: '{"q":' } }] } }] }), null);
  c.take({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  const fin = c.final();
  assert.equal(fin.done, true); assert.equal(fin.prompt_eval_count, 5); assert.equal(fin.eval_count, 2);
  assert.deepEqual(fin.message.tool_calls, [{ function: { name: 'look', arguments: { q: 'x' } } }]);
});

test('router: local + LAN + public catalog; native chat via ONP translated and receipted; auto-private stays local', async (t) => {
  const local = await startFakeOllama({ models: ['tiny:latest'] });
  const peer = await startFakeOllama({ models: ['tiny:latest', 'big:70b'] });
  t.after(async () => { await local.close(); await peer.close(); });
  const { registry } = await publicTier(t);
  const router = await startOllamaRouter({ port: 0, ollama: local.origin, peers: [peer.origin], registry: registry.origin, mdns: false, log: () => {} });
  t.after(() => router.close());

  // /api/tags merges tiers and lists the advisor models
  const tags = (await (await fetch(`${router.origin}/api/tags`)).json()).models.map((m) => m.name);
  assert.ok(tags.includes('tiny:latest'), 'local model');
  assert.ok(tags.includes('lan/127-0-0-1/big:70b'), 'LAN model with peer prefix');
  assert.ok(tags.includes('onp/org.opennodes.fixture/echo-1'), 'public offering');
  assert.ok(tags.includes('auto-private'));

  // native streaming chat through a public ONP node: OpenAI SSE -> Ollama NDJSON, receipt verified
  const chat = await fetch(`${router.origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'onp/org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'ping' }] }) });
  assert.equal(chat.headers.get('content-type'), 'application/x-ndjson');
  const lines = await ndjson(chat);
  assert.match(lines[0].message.content, /^echo: ping/);
  const last = lines.at(-1);
  assert.equal(last.done, true); assert.equal(last.model, 'onp/org.opennodes.fixture/echo-1'); assert.ok(last.eval_count > 0);
  const signed = () => router.receipts.filter((r) => r.receipt_id);
  assert.equal(signed().length, 1); assert.ok(signed()[0].cost > 0);

  // non-streaming generate through ONP
  const gen = await (await fetch(`${router.origin}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'onp/org.opennodes.fixture/echo-1', prompt: 'hello', stream: false }) })).json();
  assert.match(gen.response, /^echo: hello/); assert.equal(gen.done, true);

  // local passthrough keeps the requested name in chunks
  const loc = await ndjson(await fetch(`${router.origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tiny:latest', messages: [{ role: 'user', content: 'yo' }] }) }));
  assert.match(loc[0].message.content, /^fake\(tiny:latest\): yo/); assert.equal(loc.at(-1).model, 'tiny:latest');

  // LAN fallthrough: a bare name only the peer has
  const lan = await (await fetch(`${router.origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'big:70b', messages: [{ role: 'user', content: 'x' }], stream: false }) })).json();
  assert.match(lan.message.content, /^fake\(big:70b\)/);

  // auto-private never leaves the LAN even though a public node exists
  await fetch(`${router.origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto-private', messages: [{ role: 'user', content: 'summarize this confidential note' }], stream: false }) });
  const advice = await (await fetch(`${router.origin}/router/advice`)).json();
  assert.equal(advice.model, 'auto-private');
  assert.ok(advice.recommendations.every((r) => r.tier === 'local' || r.tier === 'lan'), JSON.stringify(advice.recommendations));
  assert.ok(!JSON.stringify(advice.features).includes('confidential note'));

  // /api/show for a public offering synthesizes capabilities; /v1 surface works for both kinds
  const show = await (await fetch(`${router.origin}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'onp/org.opennodes.fixture/echo-1' }) })).json();
  assert.ok(show.capabilities.includes('completion')); assert.equal(show.onp.tier, 'public');
  const v1 = await (await fetch(`${router.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tiny:latest', messages: [{ role: 'user', content: 'q' }] }) })).json();
  assert.equal(v1.choices[0].message.content, 'v1:q');
  const v1pub = await (await fetch(`${router.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'onp/org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'q' }] }) })).json();
  assert.match(v1pub.choices[0].message.content, /^echo: q/);
  assert.equal(signed().length, 3, 'chat + generate + v1 through the public node');
  assert.ok(router.receipts.filter((r) => r.tier !== 'public').every((r) => r.cost === 0), 'local/LAN calls cost nothing');

  // budget cap: a public call whose estimate exceeds max_request_usd is refused, not silently sent
  const capped = await startOllamaRouter({ port: 0, ollama: local.origin, registry: registry.origin, mdns: false, policy: { max_request_usd: 0.0000001 }, log: () => {} });
  t.after(() => capped.close());
  const refused = await fetch(`${capped.origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'onp/org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'x'.repeat(4000) }], stream: false }) });
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /max_request_usd/);
});

// Gateway /v1/embeddings: the local Ollama's embedding models first, then hosted ones you hold a key for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';

/** A tiny OpenAI-compatible embeddings server; as Ollama it also lists its models at /api/tags. */
async function fakeEmbedder({ models = [], key = null } = {}) {
  const state = { fail: false, calls: 0, lastAuth: null, lastModel: null };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    }
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      let raw = ''; for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      state.calls++; state.lastAuth = req.headers.authorization ?? null; state.lastModel = body.model;
      if (state.fail || (key && req.headers.authorization !== `Bearer ${key}`)) { res.writeHead(state.fail ? 500 : 401); return res.end('{}'); }
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const tokens = inputs.reduce((n, t) => n + Math.ceil(String(t).length / 4), 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens },
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })) }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function network(t) {
  const ollama = await fakeEmbedder({ models: ['nomic-embed-text:latest', 'llama3.2:1b'] });
  const hosted = await fakeEmbedder({ key: 'k-hosted' });
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await ollama.close(); await hosted.close(); await registry.close(); });
  // a hosted provider listing an embedding model, as models.dev catalogs do ("text", told apart by its name)
  await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: { acme: { id: 'acme', name: 'Acme', api: `${hosted.origin}/v1`, models: {
      'acme-embed-v1': { id: 'acme-embed-v1', name: 'Acme Embed v1', cost: { input: 0.1, output: 0 } },
    } } } }),
  });
  return { ollama, hosted, registry };
}
const embed = (gw, body) => fetch(`${gw.origin}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('embeddings: the local Ollama embedder first, free; a chat model is never used', async (t) => {
  const { ollama, registry } = await network(t);
  const gw = await startGateway({ port: 0, registry: registry.origin, env: {}, checksPath: null, ollama: ollama.origin, keys: { '127.0.0.1': 'k-hosted' } });
  t.after(() => gw.close());

  const res = await embed(gw, { model: 'onp/auto', input: ['first chunk', 'second chunk'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'onp/auto');
  assert.equal(body.data.length, 2);
  assert.equal(ollama.state.lastModel, 'nomic-embed-text:latest', 'llama3.2 is a chat model: never an embedder');
  assert.equal(ollama.state.lastAuth, null, 'no key goes to the local Ollama');
  const advice = await (await fetch(`${gw.origin}/gateway/advice`)).json();
  assert.equal(advice.kind, 'embeddings');
  assert.equal(advice.recommendations[0].offering, 'local/nomic-embed-text:latest');
  assert.ok(advice.recommendations.some((r) => r.offering.startsWith('import.modelsdev.acme/')), 'the keyed hosted embedder is the fallback');
  assert.equal(gw.receipts.at(-1).cost, 0);

  // a bare local name works too, as LangChain / LlamaIndex configs write it
  assert.equal((await embed(gw, { model: 'nomic-embed-text', input: 'one' })).status, 200);
  assert.equal((await embed(gw, { model: 'onp/auto' })).status, 400, 'input is required');
});

test('embeddings: when the local model fails, the hosted one answers with your key, and the cost is logged', async (t) => {
  const { ollama, hosted, registry } = await network(t);
  const gw = await startGateway({ port: 0, registry: registry.origin, env: {}, checksPath: null, ollama: ollama.origin, keys: { '127.0.0.1': 'k-hosted' } });
  t.after(() => gw.close());
  ollama.state.fail = true;

  const res = await embed(gw, { model: 'onp/auto', input: 'x'.repeat(4000) });
  assert.equal(res.status, 200);
  assert.equal(hosted.state.lastAuth, 'Bearer k-hosted');
  assert.equal(hosted.state.lastModel, 'acme-embed-v1');
  const entry = gw.receipts.at(-1);
  assert.equal(entry.kind, 'embeddings');
  assert.equal(entry.cost, 0.0001, '1,000 tokens at $0.10 per MTok');
  assert.equal(gw.reputation.calls['local/nomic-embed-text:latest'].at(-1).ok, false, 'the failure is remembered');
});

test('embeddings: auto-private never leaves the machine', async (t) => {
  const { registry } = await network(t);
  const gw = await startGateway({ port: 0, registry: registry.origin, env: {}, checksPath: null, ollama: null, keys: { '127.0.0.1': 'k-hosted' } });
  t.after(() => gw.close());
  const res = await embed(gw, { model: 'onp/auto-private', input: 'secret' });
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /ollama pull nomic-embed-text/);
});

// PII masking in the clients (docs/pii-masking.md): the gateway, `onp invoke` (OnpClient) and the Ollama
// router mask personal data before an open-pool offering and put the values back in the answer; the
// trusted pool and local models get the request as it is; sensitive requests stay trusted-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, listen, closeApp, sendJson } from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';
import { OnpClient } from '@opennodes/cli';
import { startOllamaRouter } from '@opennodes/ollama-router';

const FIXTURE = 'org.opennodes.fixture';
const PROMPT = 'Send the invoice to jane@example.org and call 416-555-0199 if it bounces.';
const VALUES = ['jane@example.org', '416-555-0199'];

/**
 * The fixture node (operator DE, verified) on a registry. Undeclared lineage puts it in the open pool;
 * lineage FR puts it in the trusted pool.
 */
async function network(t, { lineage = null, offerings = ['chat'] } = {}) {
  const node = await startFixtureNode({ lineage, offerings });
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const post = (path, body) => fetch(`${registry.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const reg = await (await post('/v0/nodes', { card_url: `${node.origin}/.well-known/open-node.json` })).json();
  node.setChallenge(reg.challenge.token);
  await post(reg.challenge.verify);
  assert.equal((await (await post(`/v0/nodes/${FIXTURE}/admit`)).json()).state, 'verified');
  return { node, registry, sent: recordUpstream(t, node.origin) };
}

/**
 * What the operator received: every POST to the node's API, recorded at fetch (the clients run in this
 * process). The fixture serves only chat, so embeddings get a stand-in answer here.
 */
function recordUpstream(t, origin) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(`${origin}/v1/`) && init.method === 'POST') {
      sent.push({ path: new URL(u).pathname, body: String(init.body) });
      if (u.endsWith('/embeddings')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 4, total_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
      }
    }
    return real(url, init);
  };
  t.after(() => { globalThis.fetch = real; });
  return sent;
}

const leaked = (text) => VALUES.filter((v) => text.includes(v));
const gatewayOpts = (registry, extra = {}) => ({ port: 0, registry: registry.origin, env: {}, checksPath: null, ollama: null, ...extra });
async function gateway(t, registry, extra) {
  const gw = await startGateway(gatewayOpts(registry, extra));
  t.after(() => gw.close());
  return gw;
}
const chat = (gw, { headers = {}, stream = false, messages = [{ role: 'user', content: PROMPT }] } = {}) => fetch(`${gw.origin}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ model: `${FIXTURE}/echo-1`, messages, max_tokens: 64, stream }),
});

test('gateway: an open-pool offering gets placeholders, the client gets the values back', async (t) => {
  const { registry, sent } = await network(t);
  const gw = await gateway(t, registry);
  assert.deepEqual(gw.pii, { mode: 'open', detector: 'regex' });

  const r = await chat(gw);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  assert.equal((await r.json()).choices[0].message.content, `echo: ${PROMPT}`);
  assert.equal(sent.length, 1);
  assert.deepEqual(leaked(sent[0].body), [], 'no value reached the operator');
  assert.match(JSON.parse(sent[0].body).messages[0].content, /^Send the invoice to \[\[EMAIL_1\]\] and call \[\[PHONE_1\]\] if it bounces\.$/);
  const entry = gw.receipts.at(-1);
  assert.deepEqual(entry.pii_masked, { EMAIL: 1, PHONE: 1 }, 'the ledger has counts by type');
  assert.ok(entry.receipt_id, 'the receipt verified: its request_hash covers the masked bytes sent');
  assert.deepEqual(leaked(JSON.stringify(gw.receipts)), [], 'nor does the ledger hold the values');

  // streamed: the values are put back in the stream; the receipt (by URL, after the stream) still verifies
  const s = await chat(gw, { stream: true });
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  const text = await s.text();
  assert.ok(text.includes('jane@example.org') && text.includes('416-555-0199'));
  assert.ok(!text.includes('[['), 'no placeholder reaches the client');
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
  assert.deepEqual(leaked(sent[1].body), []);
  assert.ok(gw.receipts.at(-1).receipt_id && !gw.receipts.at(-1).receipt_error);

  // a header can ask for more masking, never less
  const weaker = await chat(gw, { headers: { 'onp-mask-pii': 'off' } });
  assert.equal(weaker.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  assert.deepEqual(leaked(sent[2].body), []);
  const bad = await chat(gw, { headers: { 'onp-mask-pii': 'maybe' } });
  assert.equal(bad.status, 400);
  assert.equal(sent.length, 3, 'a misspelt mode sends nothing');

  // --mask-pii off: sent as it is
  const off = await gateway(t, registry, { maskPii: 'off' });
  const raw = await chat(off);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('onp-pii-masked'), null);
  assert.deepEqual(leaked(sent[3].body), VALUES);
});

test('gateway: the trusted pool gets the request as it is, unless masking is asked for every offering', async (t) => {
  const { registry, sent } = await network(t, { lineage: ['FR'] });
  const gw = await gateway(t, registry);
  const r = await chat(gw);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('onp-pii-masked'), null);
  assert.deepEqual(leaked(sent[0].body), VALUES);
  assert.equal(gw.receipts.at(-1).pii_masked, undefined);

  const all = await chat(gw, { headers: { 'onp-mask-pii': 'all' } });
  assert.equal(all.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  assert.equal((await all.json()).choices[0].message.content, `echo: ${PROMPT}`);
  assert.deepEqual(leaked(sent[1].body), []);

  const everywhere = await gateway(t, registry, { maskPii: 'all' });
  assert.equal((await chat(everywhere)).headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  // a request with nothing to mask is still marked as checked
  const plain = await chat(everywhere, { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(plain.headers.get('onp-pii-masked'), 'none');
});

test('gateway: what cannot be masked is not sent to the open pool, and masking never opens it to sensitive requests', async (t) => {
  const { registry, sent } = await network(t);
  const gw = await gateway(t, registry);

  const image = await chat(gw, { messages: [{ role: 'user', content: [{ type: 'text', text: 'What is on this card?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }] });
  assert.equal(image.status, 403);
  assert.match((await image.json()).detail, /image_url content cannot be masked, so it is not sent to org\.opennodes\.fixture\/echo-1 \(open pool\)/);

  const broken = await gateway(t, registry, { piiDetector: { name: 'presidio', detect: async () => { throw new Error('connection refused'); } } });
  const failed = await chat(broken);
  assert.equal(failed.status, 403, 'fail closed: a detector that fails sends nothing');
  assert.match((await failed.json()).detail, /PII masking failed, so nothing was sent .*connection refused/);

  const sensitive = await chat(gw, { headers: { 'onp-sensitive': '1' } });
  assert.equal(sensitive.status, 403);
  assert.match((await sensitive.json()).detail, /open pool and the request is sensitive \(model lineage not declared\)/);
  assert.equal(sent.length, 0, 'none of these reached the operator');
});

test('gateway: embeddings inputs are masked before an open-pool embedding model', async (t) => {
  const { registry, sent } = await network(t, { offerings: ['chat', 'embeddings'] });
  const gw = await gateway(t, registry);
  const r = await fetch(`${gw.origin}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: `${FIXTURE}/embed-1`, input: [PROMPT, 'no personal data here'] }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  assert.equal((await r.json()).data.length, 1);
  const body = JSON.parse(sent.at(-1).body);
  assert.deepEqual(body.input, ['Send the invoice to [[EMAIL_1]] and call [[PHONE_1]] if it bounces.', 'no personal data here']);

  const tokens = await fetch(`${gw.origin}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: `${FIXTURE}/embed-1`, input: [[101, 2023, 102]] }),
  });
  assert.equal(tokens.status, 403, 'token arrays cannot be masked');
  assert.equal(sent.length, 1);
});

test('onp invoke (OnpClient): masked before an open-pool offering, values back in the completion', async (t) => {
  const { registry, sent } = await network(t);
  const client = new OnpClient({ registry: registry.origin });
  const offering = (await client.search({})).find((o) => o.node_id === FIXTURE && o.offering_id === 'echo-1');
  const { completion, receipt, pii_masked } = await client.invoke(offering, [{ role: 'user', content: PROMPT }]);
  assert.equal(completion.choices[0].message.content, `echo: ${PROMPT}`);
  assert.deepEqual(pii_masked, { EMAIL: 1, PHONE: 1 });
  assert.ok(receipt);
  assert.deepEqual(leaked(sent[0].body), []);

  const off = new OnpClient({ registry: registry.origin, policy: { mask_pii: 'off' } });
  const plain = await off.invoke(offering, [{ role: 'user', content: PROMPT }]);
  assert.equal(plain.pii_masked, null);
  assert.deepEqual(leaked(sent[1].body), VALUES);

  const typo = new OnpClient({ registry: registry.origin, policy: { mask_pii: 'sometimes' } });
  await assert.rejects(typo.invoke(offering, [{ role: 'user', content: PROMPT }]), /PII mask mode must be off, open or all/);
  assert.equal(sent.length, 2);
});

async function startFakeOllama(t) {
  const app = createApp([['GET', '/api/tags', (req, res) => sendJson(res, 200, { models: [] })]]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  return `http://127.0.0.1:${port}`;
}

test('ollama router: open-pool public models get placeholders on every route; the answer gets the values', async (t) => {
  const { registry, sent } = await network(t);
  const ollama = await startFakeOllama(t);
  const router = await startOllamaRouter({ port: 0, ollama, registry: registry.origin, mdns: false, log: () => {} });
  t.after(() => router.close());
  const model = `onp/${FIXTURE}/echo-1`;
  const post = (path, body, headers = {}) => fetch(`${router.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // Ollama-native chat, whole answer
  const whole = await post('/api/chat', { model, messages: [{ role: 'user', content: PROMPT }], stream: false });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  assert.equal((await whole.json()).message.content, `echo: ${PROMPT}`);

  // Ollama-native chat, streamed (NDJSON)
  const streamed = await post('/api/chat', { model, messages: [{ role: 'user', content: PROMPT }] });
  assert.equal(streamed.status, 200);
  const lines = (await streamed.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.map((l) => l.message?.content ?? '').join(''), `echo: ${PROMPT}`);

  // Ollama-native generate
  const gen = await post('/api/generate', { model, prompt: PROMPT, stream: false });
  assert.equal(gen.status, 200);
  assert.equal((await gen.json()).response, `echo: ${PROMPT}`);

  // OpenAI surface, whole and streamed
  const oa = await post('/v1/chat/completions', { model, messages: [{ role: 'user', content: PROMPT }] });
  assert.equal(oa.headers.get('onp-pii-masked'), 'EMAIL=1,PHONE=1');
  assert.equal((await oa.json()).choices[0].message.content, `echo: ${PROMPT}`);
  const oas = await post('/v1/chat/completions', { model, messages: [{ role: 'user', content: PROMPT }], stream: true });
  const sse = await oas.text();
  assert.ok(sse.includes('jane@example.org') && !sse.includes('[['));

  assert.equal(sent.length, 5);
  for (const s of sent) assert.deepEqual(leaked(s.body), [], `${s.path}: no value reached the operator`);
  assert.deepEqual(router.receipts.at(-1).pii_masked, { EMAIL: 1, PHONE: 1 });
  assert.deepEqual((await (await fetch(`${router.origin}/router/catalog`)).json()).pii_masking, { mode: 'open', detector: 'regex' });

  // an image cannot be masked: refused, nothing sent
  const image = await post('/api/chat', { model, messages: [{ role: 'user', content: 'What is this?', images: ['iVBORw0KGgo='] }], stream: false });
  assert.equal(image.status, 403);
  assert.match((await image.json()).error, /image_url content cannot be masked/);
  const bad = await post('/api/chat', { model, messages: [{ role: 'user', content: PROMPT }], stream: false }, { 'onp-mask-pii': 'maybe' });
  assert.equal(bad.status, 400);
  assert.equal(sent.length, 5);
});

test('ollama router: the trusted pool gets the request as it is', async (t) => {
  const { registry, sent } = await network(t, { lineage: ['FR'] });
  const ollama = await startFakeOllama(t);
  const router = await startOllamaRouter({ port: 0, ollama, registry: registry.origin, mdns: false, log: () => {} });
  t.after(() => router.close());
  const r = await fetch(`${router.origin}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: `onp/${FIXTURE}/echo-1`, messages: [{ role: 'user', content: PROMPT }], stream: false }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('onp-pii-masked'), null);
  assert.deepEqual(leaked(sent[0].body), VALUES);
});

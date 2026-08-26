// Gateway e2e: a plain OpenAI-style client (no ONP knowledge) works through the gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';

async function setupNetwork(t) {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  return { node, registry };
}

test('plain OpenAI client works through the gateway: models, chat, receipts ledger', async (t) => {
  const { registry } = await setupNetwork(t);
  const gw = await startGateway({
    port: 0,
    registry: registry.origin,
    aliases: { 'fast-eu': 'org.opennodes.fixture/echo-1' },
    virtuals: { 'auto-cheap': 'modality=text&sort=price' },
  });
  t.after(() => gw.close());

  // GET /v1/models lists concrete id, alias, and virtual model
  const models = (await (await fetch(`${gw.origin}/v1/models`)).json()).data.map((m) => m.id);
  assert.ok(models.includes('org.opennodes.fixture/echo-1'));
  assert.ok(models.includes('fast-eu'));
  assert.ok(models.includes('auto-cheap'));

  // Chat via concrete id — request shaped exactly like any OpenAI call
  const chat = await (await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'hello' }] }),
  })).json();
  assert.match(chat.choices[0].message.content, /^echo: hello/);
  assert.equal(chat.model, 'org.opennodes.fixture/echo-1'); // requested id, not upstream binding id
  assert.ok(chat.usage.total_tokens > 0);

  // Alias and virtual model both route to the same offering
  for (const model of ['fast-eu', 'auto-cheap']) {
    const r = await (await fetch(`${gw.origin}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: `via ${model}` }] }),
    })).json();
    assert.match(r.choices[0].message.content, new RegExp(`^echo: via ${model}`));
  }

  // Receipts were verified and logged with cost
  const ledger = await (await fetch(`${gw.origin}/gateway/receipts`)).json();
  assert.equal(ledger.count, 3);
  assert.ok(ledger.total_cost > 0);
  assert.ok(ledger.entries.every((e) => e.receipt_id && e.cost !== null));
});

test('streaming passes through with usage in final chunk', async (t) => {
  const { registry } = await setupNetwork(t);
  const gw = await startGateway({ port: 0, registry: registry.origin });
  t.after(() => gw.close());

  const res = await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org.opennodes.fixture/echo-1', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.match(text, /echo: stream me/);
  assert.match(text, /"usage"/);
  assert.match(text, /data: \[DONE\]/);
});

test('reprice mid-session: gateway recovers transparently, receipt uses new revision', async (t) => {
  const { node, registry } = await setupNetwork(t);
  const gw = await startGateway({ port: 0, registry: registry.origin });
  t.after(() => gw.close());

  // Warm the cache, then reprice so the cached pin goes stale
  await fetch(`${gw.origin}/v1/models`);
  const newRevision = node.reprice(2.5);

  const res = await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'after reprice' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.choices[0].message.content, /^echo: after reprice/);
  assert.equal(gw.receipts.at(-1).revision, newRevision);
});

test('bearer token is enforced when configured', async (t) => {
  const { registry } = await setupNetwork(t);
  const gw = await startGateway({ port: 0, registry: registry.origin, token: 's3cret' });
  t.after(() => gw.close());

  const denied = await fetch(`${gw.origin}/v1/models`);
  assert.equal(denied.status, 401);
  const ok = await fetch(`${gw.origin}/v1/models`, { headers: { authorization: 'Bearer s3cret' } });
  assert.equal(ok.status, 200);
});

test('unknown model gets OpenAI-style 404', async (t) => {
  const { registry } = await setupNetwork(t);
  const gw = await startGateway({ port: 0, registry: registry.origin });
  t.after(() => gw.close());

  const res = await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope/nothing', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(res.status, 404);
});

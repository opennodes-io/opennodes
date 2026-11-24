// Gateway e2e: a plain OpenAI-style client (no ONP knowledge) works through the gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway, callable, credentialsFrom } from '@opennodes/cli/src/gateway.js';
import { autoRoutable, declaresLogged } from '@opennodes/core';

async function setupNetwork(t, nodeOptions = {}) {
  const node = await startFixtureNode(nodeOptions);
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
  const ledger = await (await fetch(`${gw.origin}/gateway/receipts`, { headers: { authorization: `Bearer ${gw.apiToken}` } })).json();
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

  // The streamed receipt (published by URL after the stream) is fetched, verified and recorded.
  let ledger;
  for (let i = 0; i < 20; i++) {
    ledger = await (await fetch(`${gw.origin}/gateway/receipts`, { headers: { authorization: `Bearer ${gw.apiToken}` } })).json();
    if (ledger.count) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(ledger.count, 1);
  assert.ok(ledger.entries[0].receipt_id && ledger.entries[0].cost !== null, JSON.stringify(ledger.entries[0]));
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

test('auto-routing pool: only offerings this machine can call', () => {
  const offering = (source, host, schemes) => ({ source, endpoints: { openai: `https://${host}/v1` }, pricing: { schemes } });
  const none = credentialsFrom({}, {});
  assert.equal(callable(offering('registration', 'node.example.io', ['free']), none), true, 'free registered node');
  assert.equal(callable(offering('registration', 'node.example.io', ['prepaid']), none), false, 'paid-only node needs an account');
  assert.equal(callable(offering('import', 'openrouter.ai', ['free']), none), false, 'imported catalog needs its own key');

  const creds = credentialsFrom({ 'api.example.ai': 'k2' }, { OPENROUTER_API_KEY: 'k1', UNRELATED: 'x' });
  assert.deepEqual(Object.keys(creds).sort(), ['api.example.ai', 'openrouter.ai']);
  assert.equal(callable(offering('import', 'openrouter.ai', ['prepaid']), creds), true, 'env key unlocks its host');
  assert.equal(callable(offering('import', 'router.huggingface.co', ['prepaid']), creds), false, 'but no other host');
  assert.equal(credentialsFrom({ 'openrouter.ai': 'explicit' }, { OPENROUTER_API_KEY: 'env' })['openrouter.ai'], 'explicit', '--key wins over env');
});

test('onp/auto with nothing callable explains how to add keys', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  const gw = await startGateway({ port: 0, registry: registry.origin, env: {} });
  t.after(async () => { await gw.close(); await registry.close(); });

  const res = await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp/auto', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(JSON.stringify(body), /OPENROUTER_API_KEY/);
  assert.match(JSON.stringify(body), /--env-keys/, 'env keys are opt-in, and the hint says how');
});

test('--min-tier: auto-routing honours it, and so does an explicitly named node', async (t) => {
  const { registry } = await setupNetwork(t);   // the fixture registers at community tier
  const chat = (gw, model) => fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'tier' }] }),
  });
  const open = await startGateway({ port: 0, registry: registry.origin, env: {} });
  const strict = await startGateway({ port: 0, registry: registry.origin, env: {}, policy: { min_tier: 'verified' } });
  t.after(async () => { await open.close(); await strict.close(); });

  assert.equal((await chat(open, 'onp/auto')).status, 200, 'default pool includes community nodes');
  assert.equal((await chat(strict, 'onp/auto')).status, 404, 'verified-only pool has no community node');
  assert.equal((await chat(strict, 'onp/auto-private')).status, 404, 'private keeps the stricter floor');
  const refused = await chat(strict, 'org.opennodes.fixture/echo-1');
  assert.equal(refused.status, 403, 'the floor holds for named models too');
  assert.match(JSON.stringify(await refused.json()), /policy-refused[\s\S]*below minimum verified/);
  assert.equal((await chat(open, 'org.opennodes.fixture/echo-1')).status, 200, 'without the flag, any named node is callable');
});

test('models: [...] fallback list (OpenRouter-compatible) tries the next model', async (t) => {
  const { registry } = await setupNetwork(t);
  const gw = await startGateway({ port: 0, registry: registry.origin });
  t.after(() => gw.close());

  const res = await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope/nothing', models: ['also/missing', 'org.opennodes.fixture/echo-1'], messages: [{ role: 'user', content: 'fallback' }] }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).choices[0].message.content, /^echo: fallback/);
});

test('automatic routing: which declared retentions it may pick', () => {
  const o = (retention, extra = {}) => ({ data_policy: retention === undefined ? undefined : { retention }, ...extra });
  assert.equal(declaresLogged(o('logged')), true);
  assert.equal(declaresLogged(o('forever')), true, 'an unknown value counts as logged (ONP-2 §5)');
  assert.equal(declaresLogged(o('none')), false);
  assert.equal(declaresLogged(o('ephemeral')), false);
  assert.equal(declaresLogged(o(undefined)), false, 'undeclared is not "logged": the retention filters treat it as unmet');
  assert.equal(autoRoutable(o('logged')), false);
  assert.equal(autoRoutable(o('logged'), { allow_logged: true }), true, '--allow-logged opts in');
  assert.equal(autoRoutable(o('logged', { local: { run: 'ollama run x' } })), true, 'the user\'s own machine');
  assert.equal(autoRoutable(o('none')), true);
});

test('logged retention: auto and virtual models leave it out, a named model or --allow-logged reaches it', async (t) => {
  const { node, registry } = await setupNetwork(t, { retention: 'logged' });
  const chat = (gw, body) => fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'kept' }], ...body }),
  });
  const gw = await startGateway({ port: 0, registry: registry.origin, env: {}, apiToken: 'advice', virtuals: { 'any-text': 'modality=text' } });
  const optedIn = await startGateway({ port: 0, registry: registry.origin, env: {}, policy: { allow_logged: true } });
  t.after(async () => { await gw.close(); await optedIn.close(); });

  const before = node.prompts.length;
  const auto = await chat(gw, { model: 'onp/auto' });
  assert.equal(auto.status, 404);
  assert.match((await auto.json()).detail, /retention "logged"[\s\S]*--allow-logged/);
  assert.equal((await chat(gw, { model: 'any-text' })).status, 404, 'a query-defined virtual model is automatic too');
  assert.equal(node.prompts.length, before, 'nothing was sent to the node');
  const advice = await (await fetch(`${gw.origin}/gateway/advice`, { headers: { authorization: 'Bearer advice' } })).json();
  assert.equal(advice.left_out_logged, 1);

  // The user's own choice: a named model, alone or in a models: [...] fallback list.
  assert.equal((await chat(gw, { model: 'org.opennodes.fixture/echo-1' })).status, 200);
  assert.equal((await chat(gw, { model: 'onp/auto', models: ['org.opennodes.fixture/echo-1'] })).status, 200);
  // Opted in: automatic routing may pick it.
  assert.equal((await chat(optedIn, { model: 'onp/auto' })).status, 200);
});

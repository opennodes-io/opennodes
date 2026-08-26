// End-to-end: fixture node + registry + client → register, verify, Stage A, search,
// estimate, pinned invoke, receipt verification, and price_changed recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { OnpClient } from '@opennodes/cli';

test('full discover → estimate → invoke → receipt loop', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });

  // 1. Register: submit card URL, get challenge
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  assert.equal(reg.state, 'challenged');
  assert.equal(reg.node_id, 'org.opennodes.fixture');

  // 2. Serve the HTTP challenge token, then verify → Stage A runs → community tier
  node.setChallenge(reg.challenge.token);
  const verify = await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json();
  assert.equal(verify.state, 'community', JSON.stringify(verify.stage_a));
  assert.equal(verify.signature_verified, true);
  assert.equal(verify.stage_a.ok, true);

  // 3. Search finds the offering with rank explanation
  const client = new OnpClient({ registry: registry.origin });
  const offerings = await client.search({ modality: 'text', lang: 'en:strong' });
  assert.equal(offerings.length, 1);
  const offering = offerings[0];
  assert.equal(offering.tier, 'community');
  assert.ok(offering.rank_explanation.weights);

  // 4. Estimate is enforceable: carries the card revision
  const est = await client.estimate([{ offering: 'org.opennodes.fixture/echo-1', est_input_tokens: 100, est_output_tokens: 50 }]);
  assert.equal(est.steps[0].card_revision, offering.card_revision);
  assert.ok(est.total.max > 0);

  // 5. Pinned invoke returns completion + verified receipt matching pinned price
  const { completion, receipt } = await client.invoke(offering, [{ role: 'user', content: 'ping' }]);
  assert.match(completion.choices[0].message.content, /^echo: ping/);
  assert.ok(receipt);
  assert.equal(receipt.card_revision, offering.card_revision);
  assert.ok(client.spendTotal() >= 0);

  // 6. Reprice → stale pin gets 409 → client recovers by re-resolving and retrying once
  const newRevision = node.reprice(9.99);
  assert.notEqual(newRevision, offering.card_revision);
  const second = await client.invoke(offering, [{ role: 'user', content: 'after reprice' }]);
  assert.match(second.completion.choices[0].message.content, /^echo: after reprice/);
  assert.equal(second.receipt.card_revision, newRevision);
  assert.equal(second.repinned, newRevision);
});

test('registry rejects an invalid card and estimate rejects unknown offerings', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());

  const bad = await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: 'http://127.0.0.1:1/nowhere.json' }),
  });
  assert.equal(bad.status, 422);

  const est = await fetch(`${registry.origin}/v0/estimate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ offering: 'no.such/thing', est_input_tokens: 1, est_output_tokens: 1 }] }),
  });
  assert.equal(est.status, 404);
});

test('select-based estimate resolves via search', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });

  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });

  const client = new OnpClient({ registry: registry.origin });
  const est = await client.estimate([{ select: { modality: 'text', sort: 'price' }, est_input_tokens: 500, est_output_tokens: 200 }]);
  assert.equal(est.steps[0].offering, 'org.opennodes.fixture/echo-1');
});

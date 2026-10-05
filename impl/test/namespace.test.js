// Namespace binding (ONP-3 §4): only a host that controls a node id's DNS name may register it,
// and re-submitting a card never delists a node that is already listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { hostControlsNamespace, domainForNodeId, makeRateLimiter } from '@opennodes/registry/src/namespace.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('hostControlsNamespace: the host itself or a parent domain, never a child or a stranger', () => {
  assert.equal(domainForNodeId('io.opennodes.demo-node'), 'demo-node.opennodes.io');
  assert.equal(hostControlsNamespace('demo-node.opennodes.io', 'io.opennodes.demo-node'), true);
  assert.equal(hostControlsNamespace('opennodes.io', 'io.opennodes.demo-node'), true, 'parent domain controls the subtree');
  assert.equal(hostControlsNamespace('evil.example.com', 'io.opennodes.demo-node'), false, 'stranger');
  assert.equal(hostControlsNamespace('alice.github.io', 'io.github'), false, 'child cannot claim its parent');
  assert.equal(hostControlsNamespace('alice.github.io', 'io.github.bob'), false, 'sibling');
  assert.equal(hostControlsNamespace('io', 'io.opennodes.demo-node'), false, 'bare TLD controls nothing');
  assert.equal(hostControlsNamespace('Demo-Node.OpenNodes.io.', 'io.opennodes.demo-node'), true, 'case and trailing dot');
});

test('a card claiming an id its host does not control is refused, and the real listing is untouched', async (t) => {
  const node = await startFixtureNode();                       // card id: org.opennodes.fixture, served from 127.0.0.1
  const dev = await startRegistry({ allowPrivateTargets: true });
  const strict = await startRegistry({ allowPrivateTargets: true, enforceNamespace: true });
  t.after(async () => { await node.close(); await dev.close(); await strict.close(); });
  const cardUrl = `${node.origin}/.well-known/open-node.json`;

  // strict registry: 127.0.0.1 does not control fixture.opennodes.org -> 403, no node row created
  const refused = await post(`${strict.origin}/v0/nodes`, { card_url: cardUrl });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).detail, /fixture\.opennodes\.org/);
  assert.equal((await fetch(`${strict.origin}/v0/nodes/org.opennodes.fixture`)).status, 404);

  // dev registry (loopback exempt): register + verify -> community
  const reg = await (await post(`${dev.origin}/v0/nodes`, { card_url: cardUrl })).json();
  node.setChallenge(reg.challenge.token);
  assert.equal((await (await post(`${dev.origin}${reg.challenge.verify}`)).json()).state, 'community');

  // submitting the card again must NOT delist the node (previously reset to "challenged")
  const again = await (await post(`${dev.origin}/v0/nodes`, { card_url: cardUrl })).json();
  assert.equal(again.state, 'community');
  assert.equal((await (await fetch(`${dev.origin}/v0/nodes/org.opennodes.fixture`)).json()).state, 'community');
  assert.equal((await (await fetch(`${dev.origin}/v0/offerings`)).json()).offerings.length, 1, 'still listed');
});

test('registration rate limit and Stage B cooldown', async (t) => {
  const limiter = makeRateLimiter(2, 60_000);
  assert.deepEqual([limiter('a'), limiter('a'), limiter('a'), limiter('b')], [true, true, false, true]);

  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, registerPerHour: 3, admitCooldownMs: 60_000, stageBCapacity: { durationMs: 200, steps: [1] } });
  t.after(async () => { await node.close(); await registry.close(); });
  const cardUrl = `${node.origin}/.well-known/open-node.json`;
  const reg = await (await post(`${registry.origin}/v0/nodes`, { card_url: cardUrl })).json();     // 1
  node.setChallenge(reg.challenge.token);
  await post(`${registry.origin}${reg.challenge.verify}`);                                          // 2
  assert.equal((await post(`${registry.origin}/v0/nodes`, { card_url: cardUrl })).status, 202);     // 3
  assert.equal((await post(`${registry.origin}/v0/nodes`, { card_url: cardUrl })).status, 429);     // 4 -> limited

  const first = await post(`${registry.origin}/v0/nodes/org.opennodes.fixture/admit`);
  assert.equal(first.status, 200);
  const second = await post(`${registry.origin}/v0/nodes/org.opennodes.fixture/admit`);
  assert.equal(second.status, 429);
  assert.match((await second.json()).detail, /next run allowed/);
});

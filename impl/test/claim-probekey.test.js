// Claiming imported listings and operator probe keys (card-only listings of keyed APIs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const catalog = {
  ownapi: { id: 'ownapi', name: 'Fixture Labs API', api: 'https://api.fixture.opennodes.org/v1',
    models: { m1: { id: 'm1', name: 'Model One', cost: { input: 0.1, output: 0.2 } } } },
  thirdparty: { id: 'thirdparty', name: 'Someone Else', api: 'https://router.example.com/v1',
    models: { m2: { id: 'm2', name: 'Model Two', cost: { input: 0.1, output: 0.2 } } } },
};

test('verifying a node retires imports inside its namespace, never anyone else\'s', async (t) => {
  const node = await startFixtureNode();             // id org.opennodes.fixture -> fixture.opennodes.org
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  await post(`${registry.origin}/v0/import/models-dev`, { catalog });
  assert.equal((await (await fetch(`${registry.origin}/v0/offerings`)).json()).total, 2);

  const reg = await (await post(`${registry.origin}/v0/nodes`, { card_url: `${node.origin}/.well-known/open-node.json` })).json();
  node.setChallenge(reg.challenge.token);
  const verify = await (await post(`${registry.origin}${reg.challenge.verify}`)).json();
  assert.equal(verify.state, 'community');
  assert.deepEqual(verify.claimed_imports, ['import.modelsdev.ownapi']);

  const ids = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings.map((o) => o.node_id).sort();
  assert.deepEqual(ids, ['import.modelsdev.thirdparty', 'org.opennodes.fixture'], 'own import replaced; third party untouched');
  const imp = await (await fetch(`${registry.origin}/v0/nodes/import.modelsdev.ownapi`)).json();
  assert.equal(imp.state, 'claimed');
  assert.match(imp.history.at(-1).reason, /claimed by org\.opennodes\.fixture/);
  const dir = (await (await fetch(`${registry.origin}/v0/nodes`)).json()).nodes.map((n) => n.id);
  assert.ok(!dir.includes('import.modelsdev.ownapi'), 'claimed import left the directory');
});

test('probe key: activated only by the challenge, used for probes, never disclosed', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const cardUrl = `${node.origin}/.well-known/open-node.json`;

  const reg = await (await post(`${registry.origin}/v0/nodes`, { card_url: cardUrl, probe_key: 'pk-operator-123' })).json();
  node.setChallenge(reg.challenge.token);
  assert.equal((await (await post(`${registry.origin}${reg.challenge.verify}`)).json()).state, 'community');
  assert.equal(node.lastAuth, 'Bearer pk-operator-123', 'Stage A probes carried the operator key');

  // a stranger re-submits the card with their own key but cannot pass the challenge
  await post(`${registry.origin}/v0/nodes`, { card_url: cardUrl, probe_key: 'pk-attacker' });
  await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture/ping`, { method: 'PUT' });
  assert.equal(node.lastAuth, 'Bearer pk-operator-123', 'pending key never activated without the challenge');

  for (const path of ['/v0/nodes/org.opennodes.fixture', '/v0/nodes', '/v0/offerings', '/v0/export']) {
    const text = await (await fetch(`${registry.origin}${path}`)).text();
    assert.ok(!text.includes('pk-operator-123') && !text.includes('pk-attacker'), `no key in ${path}`);
  }
});

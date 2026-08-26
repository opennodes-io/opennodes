// BYOK upstream keys in the gateway + the periodic re-import scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';
import { createSqliteStore } from '@opennodes/registry/src/store.js';
import { startReimport } from '@opennodes/registry/src/reimport.js';
import { OPENROUTER_URL } from '@opennodes/registry/src/importers.js';

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

test('gateway attaches BYOK key for matching upstream host only', async (t) => {
  const { node, registry } = await setupNetwork(t);
  const gw = await startGateway({
    port: 0, registry: registry.origin,
    keys: { '127.0.0.1': 'sk-live-123', 'openrouter.ai': 'sk-or-unused' },
  });
  t.after(() => gw.close());

  await (await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'x' }] }),
  })).json();
  assert.equal(node.lastAuth, 'Bearer sk-live-123');

  // Without a key for the host, no authorization header is sent
  const gw2 = await startGateway({ port: 0, registry: registry.origin, keys: { 'openrouter.ai': 'sk-or-unused' } });
  t.after(() => gw2.close());
  await (await fetch(`${gw2.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org.opennodes.fixture/echo-1', messages: [{ role: 'user', content: 'y' }] }),
  })).json();
  assert.equal(node.lastAuth, null);
});

test('reimport scheduler cycles a source and refreshes offerings', async () => {
  const store = await createSqliteStore(':memory:');
  const catalogV1 = { data: [{ id: 'acme/model-a', name: 'A', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] };
  const catalogV2 = { data: [
    { id: 'acme/model-a', name: 'A', pricing: { prompt: '0.000002', completion: '0.000004' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'acme/model-b', name: 'B', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ] };
  let current = catalogV1;
  const fakeFetch = async (url) => {
    assert.equal(url, OPENROUTER_URL);
    return { json: async () => current };
  };

  const handle = startReimport(store, { safeFetch: fakeFetch, sources: ['openrouter'], intervalMs: 3600_000 });
  const r1 = await handle.cycle();
  assert.equal(r1.openrouter.offerings, 1);

  current = catalogV2; // upstream repriced + added a model
  const r2 = await handle.cycle();
  assert.equal(r2.openrouter.offerings, 2);
  const card = await store.latestCard('import.openrouter.catalog');
  assert.equal(card.offerings.length, 2);
  assert.equal(card.offerings[0].pricing.input_per_mtok, 2); // fresh price wins

  // errors are contained per source, never thrown
  const broken = startReimport(store, { safeFetch: async () => { throw new Error('network down'); }, sources: ['openrouter'] });
  const r3 = await broken.cycle();
  assert.match(r3.openrouter.error, /network down/);
  handle.stop(); broken.stop();
  await store.close();
});

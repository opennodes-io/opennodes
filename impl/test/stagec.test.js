// Stage C continuous observation, export feed, seed importer, and admin auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { verifyJws, keyFromJwk } from '@opennodes/core';

async function registerAndVerify(registry, node) {
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  return (await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json());
}

async function waitFor(fn, timeoutMs = 5000, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

test('Stage C: liveness observations accrue, blind probes run, dead node gets suspended', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true,
    stageC: { livenessIntervalMs: 60, blindIntervalMs: 80, failThreshold: 3 },
  });
  t.after(async () => { await registry.close(); await node.close().catch(() => {}); });

  await registerAndVerify(registry, node);

  // Availability observation appears in search, blind probes recorded
  const observed = await waitFor(async () => {
    const detail = await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json();
    const probes = detail.probes ?? [];
    return probes.some((p) => p.stage === 'C' && p.kind === 'liveness' && p.ok)
      && probes.some((p) => p.stage === 'C' && p.kind === 'blind' && p.ok);
  });
  assert.ok(observed, 'liveness and blind probes should be recorded');

  const offerings = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.ok(offerings[0].observed.availability.ratio > 0);

  // Kill the node → consecutive failures → suspended → hidden from search
  await node.close();
  const suspended = await waitFor(async () => {
    const detail = await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json();
    return detail.state === 'suspended';
  }, 8000);
  assert.ok(suspended, 'node should be suspended after consecutive liveness failures');
  const after = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.equal(after.length, 0);
});

test('export feed streams registry-signed NDJSON verifiable against the published key', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  await registerAndVerify(registry, node);

  const health = await (await fetch(`${registry.origin}/v0/health`)).json();
  const pub = keyFromJwk(health.signing_key);

  const text = await (await fetch(`${registry.origin}/v0/export`)).text();
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const decoded = verifyJws(lines[0].jws, pub); // throws on tamper
  assert.equal(decoded.node.id, 'org.opennodes.fixture');
  assert.equal(decoded.card.node.id, 'org.opennodes.fixture');

  // since-filtering: a future cursor yields nothing
  const later = await (await fetch(`${registry.origin}/v0/export?since=2099-01-01T00:00:00Z`)).text();
  assert.equal(later.trim(), '');
});

test('models.dev importer seeds searchable unverified offerings', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());

  const catalog = {
    acmecloud: {
      id: 'acmecloud', name: 'Acme Cloud', api: 'https://api.acmecloud.example/v1',
      models: {
        'acme-large': {
          id: 'acme-large', name: 'Acme Large',
          cost: { input: 0.5, output: 1.5 },
          limit: { context: 128000, output: 8192 },
          modalities: { input: ['text'], output: ['text'] },
          tool_call: true,
        },
        'acme-small': { id: 'acme-small', name: 'Acme Small', cost: { input: 0.05, output: 0.2 } },
      },
    },
    emptyprovider: { id: 'emptyprovider', name: 'No Models Inc', models: {} },
  };
  const result = await (await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog }),
  })).json();
  assert.equal(result.providers, 1);
  assert.equal(result.offerings, 2);
  assert.deepEqual(result.skipped, ['emptyprovider']);

  const offerings = (await (await fetch(`${registry.origin}/v0/offerings?sort=price`)).json()).offerings;
  assert.equal(offerings.length, 2);
  assert.ok(offerings.every((o) => o.tier === 'unverified' && o.source === 'import'));
  assert.equal(offerings[0].binding.model_id, 'acme-small'); // cheapest first
  assert.equal(offerings[1].serving.context_window, 128000);
  assert.deepEqual(offerings[1].serving.supports, ['tool_calls']);

  // tier filter excludes imports
  const verifiedOnly = (await (await fetch(`${registry.origin}/v0/offerings?tier=community`)).json()).offerings;
  assert.equal(verifiedOnly.length, 0);
});

test('node directory and event feed endpoints', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  await registerAndVerify(registry, node);

  const { nodes } = await (await fetch(`${registry.origin}/v0/nodes`)).json();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'org.opennodes.fixture');
  assert.equal(nodes[0].tier, 'community');
  assert.equal(nodes[0].offerings, 1);
  assert.equal(nodes[0].country, 'DE');

  const { events } = await (await fetch(`${registry.origin}/v0/feed?limit=10`)).json();
  assert.ok(events.length >= 3); // challenged, indexed, community
  assert.equal(events[0].to, 'community'); // newest first
  assert.equal(events[0].node_id, 'org.opennodes.fixture');
  assert.ok(events.every((e) => e.at && e.to));
});

test('admin routes demand the bearer token when configured', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true, adminToken: 'adm1n' });
  t.after(() => registry.close());

  const denied = await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ catalog: {} }),
  });
  assert.equal(denied.status, 401);

  const ok = await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer adm1n' },
    body: JSON.stringify({ catalog: {} }),
  });
  assert.equal(ok.status, 200);
});

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

test('Stage C: a node suspended for liveness is reinstated to its tier once it answers again', async (t) => {
  let node = await startFixtureNode();
  const port = node.port;
  const registry = await startRegistry({
    allowPrivateTargets: true,
    stageC: { livenessIntervalMs: 60, blindIntervalMs: 10_000, failThreshold: 3, recoverThreshold: 3 },
  });
  t.after(async () => { await registry.close(); await node.close().catch(() => {}); });
  await registerAndVerify(registry, node);
  const state = async () => (await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json());

  await node.close();                                             // outage
  assert.ok(await waitFor(async () => (await state()).state === 'suspended', 8000), 'suspended during the outage');

  node = await startFixtureNode({ port });                        // back on the same origin
  assert.ok(await waitFor(async () => (await state()).state === 'community', 8000), 'reinstated after it answers again');
  const reasons = (await state()).history.map((h) => h.reason ?? '');
  assert.ok(reasons.some((r) => r.startsWith('reinstated:')), JSON.stringify(reasons));
  const offerings = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.equal(offerings.length, 1, 'listed again');
});

test('Stage C: suspensions for other reasons are never lifted by liveness', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true,
    stageC: { livenessIntervalMs: 60, blindIntervalMs: 10_000, failThreshold: 3, recoverThreshold: 3 },
  });
  t.after(async () => { await registry.close(); await node.close(); });
  await registerAndVerify(registry, node);
  await registry.store.setState('org.opennodes.fixture', 'suspended', 'operator request');
  await sleep(600);                                               // ~10 liveness sweeps against a healthy node
  const detail = await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json();
  assert.equal(detail.state, 'suspended');
});

test('feed collapses liveness flaps into one availability event per run', async () => {
  const { collapseFlaps } = await import('../packages/registry/src/feed.js');
  const ev = (at, node_id, from, to, reason) => ({ at, node_id, from, to, reason, source: 'registration' });
  const events = [   // newest first
    ev('2026-10-15T18:00:00Z', 'io.lab', 'verified', 'suspended', 'liveness: 3 consecutive failures'),
    ev('2026-10-15T09:00:00Z', 'io.lab', 'suspended', 'verified', 'reinstated: 3 consecutive liveness successes'),
    ev('2026-10-14T12:00:00Z', 'io.other', 'community', 'verified', 'Stage B passed'),
    ev('2026-10-14T06:00:00Z', 'io.lab', 'verified', 'suspended', 'liveness: 3 consecutive failures'),
    ev('2026-10-13T06:00:00Z', 'io.lab', 'community', 'verified', 'Stage B passed'),
    ev('2026-10-12T06:00:00Z', 'io.solo', 'verified', 'suspended', 'liveness: 3 consecutive failures'),
  ];
  const out = collapseFlaps(events);
  assert.equal(out.length, 4);
  assert.equal(out[0].kind, 'availability');
  assert.equal(out[0].collapsed, 3, 'flaps of one node collapse even when other nodes interleave');
  assert.equal(out[0].to, 'suspended');
  assert.equal(out[0].from, 'verified');
  assert.equal(out[0].since, '2026-10-14T06:00:00Z');
  assert.match(out[0].reason, /2 outages since 2026-10-14, suspended now/);
  assert.equal(out[1].node_id, 'io.other');
  assert.equal(out[2].reason, 'Stage B passed', 'a non-liveness event ends the run');
  assert.equal(out[3].collapsed, undefined, 'a single liveness event stays as is');
});

test('admin delist hides a node, survives re-import, and relist / re-registration bring it back', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const post = (path, body) => fetch(`${registry.origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const catalog = { acmecloud: { id: 'acmecloud', name: 'Acme Cloud', api: 'https://api.acmecloud.example/v1',
    models: { 'acme-small': { id: 'acme-small', name: 'Acme Small', cost: { input: 0.05, output: 0.2 } } } } };
  await post('/v0/import/models-dev', { catalog });
  await registerAndVerify(registry, node);
  const ids = async () => (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings.map((o) => o.node_id).sort();
  const directory = async () => (await (await fetch(`${registry.origin}/v0/nodes`)).json()).nodes.map((n) => n.id).sort();
  assert.deepEqual(await ids(), ['import.modelsdev.acmecloud', 'org.opennodes.fixture']);

  // operator opt-out of an import: gone from search and the directory, and a re-import keeps it gone
  assert.equal((await post('/v0/admin/nodes/import.modelsdev.acmecloud/delist', { reason: 'operator opt-out' })).status, 200);
  await post('/v0/import/models-dev', { catalog });
  assert.deepEqual(await ids(), ['org.opennodes.fixture']);
  assert.deepEqual(await directory(), ['org.opennodes.fixture']);
  const { events } = await (await fetch(`${registry.origin}/v0/feed?limit=5`)).json();
  assert.equal(events[0].reason, 'delisted: operator opt-out');

  // relist re-opens an import; a registered node is told to register again instead
  assert.equal((await post('/v0/admin/nodes/import.modelsdev.acmecloud/relist')).status, 200);
  assert.deepEqual(await ids(), ['import.modelsdev.acmecloud', 'org.opennodes.fixture']);
  await post('/v0/admin/nodes/org.opennodes.fixture/delist', { reason: 'retired' });
  assert.deepEqual(await ids(), ['import.modelsdev.acmecloud']);
  assert.equal((await post('/v0/admin/nodes/org.opennodes.fixture/relist')).status, 409);
  const back = await registerAndVerify(registry, node);
  assert.equal(back.state, 'community');
  assert.equal((await post('/v0/admin/nodes/nope.none/delist')).status, 404);
});

test('catalog cache: reused between reads, rebuilt after any store write, ranks never leak', async (t) => {
  const { collectOfferings, searchOfferingsPaged } = await import('../packages/registry/src/search.js');
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const { store } = registry;
  const catalog = (name) => ({ acmecloud: { id: 'acmecloud', name, api: 'https://api.acmecloud.example/v1',
    models: { a: { id: 'a', name: 'A', cost: { input: 0.1, output: 0.2 } }, b: { id: 'b', name: 'B', cost: { input: 1, output: 2 } } } } });
  const post = (body) => fetch(`${registry.origin}/v0/import/models-dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await post({ catalog: catalog('Acme') });
  const first = await collectOfferings(store);
  assert.equal(await collectOfferings(store), first, 'second read reuses the cached array');
  const [p1, p2] = await Promise.all([collectOfferings(store), collectOfferings(store)]);
  assert.equal(p1, p2, 'concurrent reads share one result');

  // a write through the store marks the catalog stale: the next read sees it
  await store.setState('import.modelsdev.acmecloud', 'delisted', 'test');
  assert.equal((await collectOfferings(store)).length, 0);
  await store.setState('import.modelsdev.acmecloud', 'indexed', 'test');
  assert.equal((await collectOfferings(store)).length, 2);

  // ranking annotates copies: the cached offerings stay clean
  const { offerings } = await searchOfferingsPaged(store, new URLSearchParams('sort=price'));
  assert.ok(offerings.every((o) => typeof o.rank === 'number'));
  assert.ok((await collectOfferings(store)).every((o) => o.rank === undefined));
});

test('catalog listing: paging, price scored by position, meaningful tie order, pass rate survives liveness churn', async (t) => {
  const { searchOfferingsPaged } = await import('../packages/registry/src/search.js');
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const { store } = registry;
  const model = (id, input, context) => ({ id, name: id.toUpperCase(), cost: { input, output: input * 2 }, ...(context ? { limit: { context } } : {}) });
  await fetch(`${registry.origin}/v0/import/models-dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: { acmecloud: { id: 'acmecloud', name: 'Acme', api: 'https://api.acmecloud.example/v1', models: {
      cheap: model('cheap', 0.1), mid: model('mid', 1), outlier: model('outlier', 150),
      'tie-small': model('tie-small', 0.5, 8192), 'tie-big': model('tie-big', 0.5, 131072),
    } } } }),
  });

  // Paging: offset walks the whole result set without overlap.
  const page = async (qs) => (await (await fetch(`${registry.origin}/v0/offerings?${qs}`)).json());
  const first = await page('limit=2'), second = await page('limit=2&offset=2'), third = await page('limit=2&offset=4');
  assert.equal(first.total, 5);
  const ids = [...first.offerings, ...second.offerings, ...third.offerings].map((o) => o.offering_id);
  assert.equal(new Set(ids).size, 5, 'every offering exactly once across pages');
  assert.equal(second.offset, 2);

  // One very expensive outlier no longer flattens every other price score into a tie.
  const { offerings } = await searchOfferingsPaged(store, new URLSearchParams('limit=10'));
  const rank = Object.fromEntries(offerings.map((o) => [o.offering_id, o.rank]));
  assert.ok(rank.cheap > rank.mid && rank.mid > rank.outlier, JSON.stringify(rank));
  // Equal rank: larger context first, not import order.
  const order = offerings.map((o) => o.offering_id);
  assert.ok(order.indexOf('tie-big') < order.indexOf('tie-small'), order.join(','));

  // A verified node's pass rate counts continuous checks too: liveness churn must not zero it.
  const node = await startFixtureNode();
  t.after(() => node.close());
  await registerAndVerify(registry, node);
  for (let i = 0; i < 120; i++) await store.recordProbe('org.opennodes.fixture', null, 'C', 'liveness', i !== 7);
  const fixture = (await searchOfferingsPaged(store, new URLSearchParams('q=org.opennodes.fixture'))).offerings[0];
  assert.equal(fixture.observed.probes, 100);
  assert.ok(fixture.observed.probe_success >= 0.98, String(fixture.observed.probe_success));
});

// Store-driver conformance: the same behavioral suite runs against sqlite and the
// Postgres driver (backed by pg-mem's in-memory engine through the pg adapter;
// set ONP_PG_URL to also run it against a real server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '@opennodes/registry/src/store.js';
import { createPgStore } from '@opennodes/registry/src/store-pg.js';

async function conformance(store) {
  // nodes + upsert + source
  await store.upsertNode('org.x.a', 'http://a', 'http://a/card', 'challenged');
  await store.upsertNode('org.x.a', 'http://a2', 'http://a2/card', 'challenged'); // upsert overwrites origin
  await store.upsertNode('org.x.b', 'http://b', 'import:x', 'indexed', 'import');
  const a = await store.getNode('org.x.a');
  assert.equal(a.origin, 'http://a2');
  assert.equal((await store.getNode('org.x.b')).source, 'import');
  assert.equal((await store.allNodes()).length, 2);

  // state transitions recorded in order
  await store.setState('org.x.a', 'indexed', 'verified');
  await store.setState('org.x.a', 'community', 'stage a');
  const history = await store.transitionsFor('org.x.a');
  assert.deepEqual(history.map((h) => h.to_state), ['indexed', 'community']);
  assert.equal(history[1].from_state, 'indexed');

  // revisions: latest wins, replace works
  await store.saveRevision('org.x.a', '2026-01-01T00:00:00Z', { v: 1 }, false);
  await store.saveRevision('org.x.a', '2026-02-01T00:00:00Z', { v: 2 }, true);
  await store.saveRevision('org.x.a', '2026-02-01T00:00:00Z', { v: 3 }, true); // same-revision replace
  assert.deepEqual(await store.latestCard('org.x.a'), { v: 3 });

  // challenges: present, replaceable, expiry honored
  await store.setChallenge('org.x.a', 'tok1');
  await store.setChallenge('org.x.a', 'tok2');
  assert.equal((await store.getChallenge('org.x.a')).token, 'tok2');
  await store.setChallenge('org.x.a', 'tok3', -1000); // already expired
  assert.equal(await store.getChallenge('org.x.a'), null);

  // probes: newest-first ordering by insertion
  await store.recordProbe('org.x.a', null, 'A', 'health', true);
  await store.recordProbe('org.x.a', 'off1', 'A', 'blind', false, 'timeout', { latency_ms: 9 });
  const probes = await store.probesFor('org.x.a');
  assert.equal(probes[0].kind, 'blind');
  assert.equal(Boolean(probes[0].ok), false);
  assert.equal(JSON.parse(probes[0].measured).latency_ms, 9);

  // fingerprints: upsert on (artifact, prompt)
  await store.addFingerprints('hf:x/y', [{ prompt: 'p1', expected_hash: 'h1' }]);
  await store.addFingerprints('hf:x/y', [{ prompt: 'p1', expected_hash: 'h2' }, { prompt: 'p2', expected_hash: 'h3' }]);
  const refs = await store.getFingerprints('hf:x/y');
  assert.equal(refs.length, 2);
  assert.equal(refs.find((r) => r.prompt === 'p1').expected_hash, 'h2');

  // observations: keyed upsert + per-node listing
  await store.setObservation('org.x.a', 'off1', 'tps', 42);
  await store.setObservation('org.x.a', 'off1', 'tps', 55);
  await store.setObservation('org.x.a', '_node', 'availability', { ratio: 0.9 });
  assert.equal((await store.getObservations('org.x.a', 'off1')).tps, 55);
  assert.equal((await store.observationsForNode('org.x.a')).length, 2);

  await store.close();
}

test('sqlite driver conformance', async () => {
  await conformance(await createSqliteStore(':memory:'));
});

test('postgres driver conformance (pg-mem engine)', async () => {
  const { newDb } = await import('pg-mem');
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  await conformance(await createPgStore({ pool: new Pool() }));
});

test('postgres driver conformance (real server)', { skip: !process.env.ONP_PG_URL }, async () => {
  await conformance(await createPgStore({ connectionString: process.env.ONP_PG_URL }));
});

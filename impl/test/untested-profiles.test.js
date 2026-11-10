// Verification covers only binding profiles that have a test battery (ONP-3 §4a): today
// onp.openai.chat/v1. Speech, embeddings and other offerings never inherit a node's tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { TESTED_PROFILES } from '@opennodes/registry/src/probes.js';

const FIXTURE = 'org.opennodes.fixture';
const FAST_CAPACITY = { durationMs: 200, steps: [1] };

async function registerAndVerify(registry, node) {
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  return (await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json());
}

const api = (registry) => ({
  get: async (path) => (await fetch(`${registry.origin}${path}`)).json(),
  admit: async () => {
    const res = await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/admit`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  },
  exported: async () => (await (await fetch(`${registry.origin}/v0/export`)).text())
    .trim().split('\n').map((l) => JSON.parse(l).payload).find((p) => p.node.id === FIXTURE),
  tool: async (name, args) => (await (await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result.structuredContent,
});

async function waitFor(fn, timeoutMs = 5000, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

const byId = (offerings) => Object.fromEntries(offerings.map((o) => [o.offering_id, o]));

for (const [kind, offeringId, profile] of [['speech', 'tts-1', 'onp.audio.speech/v1'], ['embeddings', 'embed-1', 'onp.openai.embeddings/v1']]) {
  test(`${kind}-only node: Stage A has nothing to call, so it stays unverified and nothing is called`, async (t) => {
    const node = await startFixtureNode({ offerings: [kind], lineage: ['FR'] });
    const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST_CAPACITY });
    t.after(async () => { await registry.close(); await node.close(); });
    const r = api(registry);

    const v = await registerAndVerify(registry, node);
    assert.equal(v.state, 'indexed');
    assert.equal(v.stage_a.ok, false);
    const gate = v.stage_a.results.find((x) => x.kind === 'tested-offerings');
    assert.equal(gate.ok, false);
    assert.match(gate.detail, /no offerings with a tested profile \(onp\.openai\.chat\/v1\)/);
    assert.ok(gate.detail.includes(profile));
    // The checks that do apply still ran and passed.
    for (const k of ['card-consistency', 'health', 'models-agreement']) {
      assert.equal(v.stage_a.results.find((x) => x.kind === k).ok, true, k);
    }
    assert.equal(node.requestCount, 0, 'no functional call was made');
    const detail = await r.get(`/v0/nodes/${FIXTURE}`);
    assert.equal(detail.history.at(-1).reason, 'Stage A failures: tested-offerings');

    // Labeled untested, tier unverified, never in the trusted pool.
    const [o] = (await r.get('/v0/offerings')).offerings;
    assert.equal(o.offering_id, offeringId);
    assert.equal(o.tier, 'unverified');
    assert.equal(o.tested, false);
    assert.equal(o.pool, 'open');
    assert.equal((await r.get('/v0/offerings?trust=trusted')).offerings.length, 0);
    assert.deepEqual(detail.verification, { tested_profiles: TESTED_PROFILES, untested_offerings: [offeringId], blind_skipped: null });

    // Stage B is not open to an unverified node.
    assert.equal((await r.admit()).status, 409);
    assert.equal(node.requestCount, 0);
  });
}

test('mixed node: chat is verified, speech and embeddings are labeled untested and capped to unverified', async (t) => {
  const node = await startFixtureNode({ offerings: ['chat', 'embeddings', 'speech'], lineage: ['FR'] });
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST_CAPACITY });
  t.after(async () => { await registry.close(); await node.close(); });
  const r = api(registry);

  const v = await registerAndVerify(registry, node);
  assert.equal(v.state, 'community');
  assert.deepEqual(v.stage_a.results.filter((x) => x.kind === 'blind-invocation').map((x) => x.offeringId), ['echo-1']);
  assert.ok(!v.stage_a.results.some((x) => x.kind === 'tested-offerings'));

  const { status, body } = await r.admit();
  assert.equal(status, 200);
  assert.equal(body.state, 'verified');
  assert.deepEqual(body.stage_b.verdicts.map((x) => x.offering_id), ['echo-1']);
  assert.deepEqual(body.stage_b.untested, ['embed-1', 'tts-1']);

  const all = byId((await r.get('/v0/offerings')).offerings);
  assert.deepEqual([all['echo-1'].tier, all['echo-1'].tested, all['echo-1'].pool], ['verified', true, 'trusted']);
  for (const id of ['embed-1', 'tts-1']) {
    assert.deepEqual([all[id].tier, all[id].tested, all[id].pool], ['unverified', false, 'open'], id);
    assert.equal(all[id].rank_explanation.components.tier, 0, `${id} ranks with no tier credit`);
  }
  assert.deepEqual((await r.get('/v0/offerings?tier=verified')).offerings.map((o) => o.offering_id), ['echo-1']);
  assert.deepEqual((await r.get('/v0/offerings?trust=trusted')).offerings.map((o) => o.offering_id), ['echo-1']);

  // Node detail, the export feed and MCP get_node say the same.
  const expected = { tested_profiles: ['onp.openai.chat/v1'], untested_offerings: ['embed-1', 'tts-1'], blind_skipped: null };
  const detail = await r.get(`/v0/nodes/${FIXTURE}`);
  assert.equal(detail.state, 'verified');
  assert.deepEqual(detail.verification, expected);
  assert.deepEqual((await r.exported()).verification, expected);
  const summary = await r.tool('get_node', { node_id: FIXTURE });
  assert.deepEqual(Object.fromEntries(summary.offerings.map((o) => [o.offering_id, o.tested])), { 'echo-1': true, 'embed-1': false, 'tts-1': false });
});

test('a listed node that drops its chat offering: Stage B fails with a reason, Stage C reports it', async (t) => {
  const node = await startFixtureNode({ lineage: ['FR'] });
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST_CAPACITY,
    stageC: { livenessIntervalMs: 60, blindIntervalMs: 80, failThreshold: 3 },
  });
  t.after(async () => { await registry.close(); await node.close(); });
  const r = api(registry);

  assert.equal((await registerAndVerify(registry, node)).state, 'community');
  const revision = node.setOfferings(['speech']);

  // Stage B: nothing to measure, so not ok, and the node stays at community.
  const { status, body } = await r.admit();
  assert.equal(status, 200);
  assert.equal(body.state, 'community');
  assert.equal(body.stage_b.ok, false);
  assert.equal(body.stage_b.reason, 'no offerings with a tested profile (onp.openai.chat/v1)');
  assert.deepEqual(body.stage_b.verdicts, []);
  assert.deepEqual(body.stage_b.untested, ['tts-1']);
  assert.ok(!(await r.get(`/v0/nodes/${FIXTURE}`)).history.some((h) => h.to_state === 'verified'));

  // Stage C: the blind sweep records that it had nothing to call.
  const skipped = await waitFor(async () => (await r.get(`/v0/nodes/${FIXTURE}`)).verification.blind_skipped);
  assert.ok(skipped, 'Stage C should report the node');
  assert.equal(skipped.reason, 'no offerings with a tested profile (onp.openai.chat/v1)');
  assert.deepEqual(skipped.profiles, ['onp.audio.speech/v1']);
  assert.equal(skipped.revision, revision);
  assert.deepEqual((await r.exported()).verification.blind_skipped, skipped);
  // Reported, not failed: a skipped sweep records no failing probe, so the check pass rate is untouched.
  const probes = (await r.get(`/v0/nodes/${FIXTURE}`)).probes;
  assert.ok(!probes.some((p) => p.stage === 'C' && p.kind === 'blind' && !p.ok));
  const [o] = (await r.get('/v0/offerings')).offerings;
  assert.deepEqual([o.offering_id, o.tier, o.tested], ['tts-1', 'unverified', false]);

  // A chat offering again: the report clears and blind probes resume.
  node.setOfferings(['chat']);
  const cleared = await waitFor(async () => {
    const d = await r.get(`/v0/nodes/${FIXTURE}`);
    return d.verification.blind_skipped === null && d.card.offerings[0].offering_id === 'echo-1';
  });
  assert.ok(cleared, 'the report should clear once a chat offering is back');
  const before = node.requestCount;
  assert.ok(await waitFor(() => node.requestCount > before), 'blind probes resume');
});

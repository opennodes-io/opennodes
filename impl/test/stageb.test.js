// Stage B, DNS challenge, and SSRF guard e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';

const FAST_CAPACITY = { durationMs: 300, steps: [1, 2] };

async function registerAndVerify(registry, node) {
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  return (await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json());
}

const admit = async (registry, nodeId) =>
  (await (await fetch(`${registry.origin}/v0/nodes/${nodeId}/admit`, { method: 'POST' })).json());

const captureRefs = (registry, nodeId, offeringId) =>
  fetch(`${registry.origin}/v0/fingerprints/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node_id: nodeId, offering_id: offeringId }),
  }).then((r) => r.json());

test('honest node passes Stage B and is promoted to verified with measured metrics', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST_CAPACITY });
  t.after(async () => { await node.close(); await registry.close(); });

  await registerAndVerify(registry, node);
  // Trusted reference capture from the known-good deployment, then admit
  const cap = await captureRefs(registry, 'org.opennodes.fixture', 'echo-1');
  assert.equal(cap.references, 3);

  const result = await admit(registry, 'org.opennodes.fixture');
  assert.equal(result.state, 'verified', JSON.stringify(result.stage_b));
  const verdict = result.stage_b.verdicts[0];
  assert.equal(verdict.identity.ok, true);
  assert.equal(verdict.context.ok, true);
  assert.ok(verdict.capacity.completed > 0);

  // Search now shows verified tier and registry-measured TTFT/TPS
  const offerings = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.equal(offerings[0].tier, 'verified');
  assert.ok(offerings[0].observed.ttft_ms.p50 >= 0);
  assert.ok(offerings[0].observed.tps >= 0);
});

test('impersonating node (same artifact claim, different model) is marked disputed and hidden', async (t) => {
  // Reference deployment (honest) and impersonator claim the SAME artifact.
  const honest = await startFixtureNode();
  const impostor = await startFixtureNode({ impersonate: true });
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST_CAPACITY });
  t.after(async () => { await honest.close(); await impostor.close(); await registry.close(); });

  // Both cards share node id in fixture; distinguish by registering only the impostor,
  // but capture references from the honest deployment first via a direct registration.
  await registerAndVerify(registry, honest);
  await captureRefs(registry, 'org.opennodes.fixture', 'echo-1');

  // Re-register the same namespace now backed by the impostor origin (hostile takeover scenario).
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${impostor.origin}/.well-known/open-node.json` }),
  })).json();
  impostor.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });

  const result = await admit(registry, 'org.opennodes.fixture');
  assert.equal(result.state, 'disputed');
  assert.equal(result.stage_b.identityFailed, true);

  // Disputed nodes disappear from search
  const offerings = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.equal(offerings.length, 0);
  // ...but the dispute is visible in node detail history
  const detail = await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json();
  assert.ok(detail.history.some((h) => h.to_state === 'disputed'));
});

test('overclaimed context window is capped to the verified size in search', async (t) => {
  // Claims 32768 tokens, actually retrieves from 8192.
  const node = await startFixtureNode({ realContextTokens: 8192, claimContextTokens: 32768 });
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST_CAPACITY });
  t.after(async () => { await node.close(); await registry.close(); });

  await registerAndVerify(registry, node);
  const result = await admit(registry, 'org.opennodes.fixture');
  const context = result.stage_b.verdicts[0].context;
  assert.equal(context.ok, false);
  assert.equal(context.claimed, 32768);
  assert.ok(context.verified_cap >= 8192 * 0.25 && context.verified_cap < 32768);

  const offerings = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.equal(offerings[0].serving.context_window, context.verified_cap);
  assert.equal(offerings[0].serving.context_capped_from, 32768);
});

test('DNS TXT challenge verifies without an HTTP challenge endpoint', async (t) => {
  const node = await startFixtureNode();
  let issuedToken = null;
  const registry = await startRegistry({
    allowPrivateTargets: true,
    // Fake resolver: the operator "published" the TXT record for fixture.opennodes.org
    dnsResolveTxt: async (name) => {
      assert.equal(name, '_onp-challenge.fixture.opennodes.org');
      return [[issuedToken]];
    },
  });
  t.after(async () => { await node.close(); await registry.close(); });

  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  issuedToken = reg.challenge.token;
  // Deliberately do NOT serve the HTTP challenge — DNS must carry it.
  const verify = await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json();
  assert.equal(verify.state, 'community');

  const detail = await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json();
  assert.ok(detail.history.some((h) => h.reason === 'namespace verified via dns'));
});

test('SSRF guard blocks private targets when enabled', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: false });
  t.after(async () => { await node.close(); await registry.close(); });

  const res = await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.detail, /ssrf-blocked/);
});

// Restart persistence: the registry keeps its signing identity (keyPath) and its
// data (file-backed store) across process lifecycles — feed consumers and
// registered nodes survive a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';

test('signing key and registered nodes survive a registry restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onp-persist-'));
  const dbPath = join(dir, 'registry.db');
  const keyPath = join(dir, 'registry.key.pem');
  const node = await startFixtureNode();
  // Temp-dir cleanup is best-effort: Windows (AV/indexer) intermittently EPERMs fresh
  // temp dirs; the OS reaps them, and a cleanup flake must not fail the test.
  t.after(async () => {
    await node.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* leave to OS */ }
  });

  // First lifecycle: register + verify a node
  let registry = await startRegistry({ dbPath, keyPath, allowPrivateTargets: true });
  let firstClosed = false;
  t.after(async () => { if (!firstClosed) await registry.close(); }); // leak guard on failure paths
  const key1 = (await (await fetch(`${registry.origin}/v0/health`)).json()).signing_key;
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  const verify = await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json();
  assert.equal(verify.state, 'community');
  await registry.close();
  firstClosed = true;

  // Second lifecycle: same identity, same data
  registry = await startRegistry({ dbPath, keyPath, allowPrivateTargets: true });
  t.after(() => registry.close());
  const key2 = (await (await fetch(`${registry.origin}/v0/health`)).json()).signing_key;
  assert.deepEqual(key2, key1, 'signing key must be stable across restarts');

  const offerings = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings;
  assert.equal(offerings.length, 1);
  assert.equal(offerings[0].tier, 'community');
  const detail = await (await fetch(`${registry.origin}/v0/nodes/org.opennodes.fixture`)).json();
  assert.ok(detail.history.some((h) => h.to_state === 'community'), 'listing history persisted');
});

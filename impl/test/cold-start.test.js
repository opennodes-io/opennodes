// Before the first outside operators: a node's first identity mismatch for an artefact is "inconclusive", not
// a dispute (ONP-3 §4a.4); references can be captured from an endpoint that is not a node; and
// registrations refused before anything was stored are counted per week and reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { STAGE_B_INCONCLUSIVE } from '@opennodes/registry/src/stageb.js';
import { HOLD, SCHEDULE_DEFAULTS } from '@opennodes/registry/src/schedule.js';

const FIXTURE = 'org.opennodes.fixture';
const ARTIFACT = 'urn:proprietary:opennodes:echo-1';
const FAST = { durationMs: 200, steps: [1] };
const CORPUS = {
  chat: ['Draft a two-line thank-you note to a colleague.', 'Which spice gives paella its colour?', 'Suggest a name for a grey kitten.',
    'How long should I boil an egg for a runny yolk?', 'Recommend one board game for four players.', 'What is the tallest tree species?'],
  identity: ['Reverse the word "lantern".', 'Count the vowels in "orchestra".', 'Name the third month of the year.',
    'Write the number twelve in Roman numerals.', 'What colour do you get by mixing blue and yellow?',
    'Spell "bicycle" one letter per line.', 'Give the opposite of "ancient".', 'What is half of 86?', 'Name a mammal that lays eggs.'],
  filler: ['Every spring the cooperative repaints the boats before the regatta, and the old harbour master keeps a ledger of colours. ',
    'The mountain road closes in November, so the village stocks its pantry in October and the bakery doubles its orders of flour. '],
  needles: [{ fact: 'The locker code written on the back of the ledger is {n}.', question: 'What is the locker code mentioned in the text? Answer with the code only.' }],
};

const post = async (registry, path, body) => {
  const res = await fetch(`${registry.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};
const detail = async (registry) => (await fetch(`${registry.origin}/v0/nodes/${FIXTURE}`)).json();
const admit = (registry) => post(registry, `/v0/nodes/${FIXTURE}/admit`);
const capture = (registry) => post(registry, '/v0/fingerprints/capture', { node_id: FIXTURE, offering_id: 'echo-1' });

async function register(registry, node) {
  const reg = (await post(registry, '/v0/nodes', { card_url: `${node.origin}/.well-known/open-node.json` })).body;
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
}

async function verified(t) {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST, probeCorpus: CORPUS,
    schedule: { tickMs: 3_600_000 },
    stageC: { livenessIntervalMs: 1e9, blindIntervalMs: 1e9, followUpTickMs: 1e9 },
  });
  t.after(async () => { await registry.close(); await node.close(); });
  await register(registry, node);
  assert.equal((await capture(registry)).status, 200);
  assert.equal((await admit(registry)).body.state, 'verified');
  return { node, registry };
}

/** One identity prompt's reply comes out differently on the first ask and on the retry: a partial mismatch. */
const partialMismatch = (node) => node.perturb(2);

test('a first partial identity mismatch is inconclusive: not passed, not disputed, verified drops to community, Stage B held', async (t) => {
  const { node, registry } = await verified(t);
  partialMismatch(node);
  const r = await admit(registry);
  assert.equal(r.body.state, 'community', 'a verified node is no longer verified');
  assert.equal(r.body.stage_b.ok, false);
  assert.equal(r.body.stage_b.identityFailed, false);
  assert.match(r.body.stage_b.reason, /^identity inconclusive: echo-1 \(urn:proprietary:opennodes:echo-1\): 2\/3 reference matches$/);
  const d = await detail(registry);
  assert.match(d.history.at(-1).reason, /^Stage B identity inconclusive: /);
  const probe = d.probes.find((p) => p.kind === STAGE_B_INCONCLUSIVE);
  assert.match(probe.detail, /^2\/3 reference matches: identity inconclusive/);
  assert.deepEqual(JSON.parse((await registry.store.getSchedule(FIXTURE, HOLD)).digest), [ARTIFACT]);
  assert.equal((await registry.store.getSchedule(FIXTURE, 'B')).next_at, null, 'no automatic retry');

  // Held: a change Stage B watches does not schedule it, and a due time does not run it.
  const before = node.calls.length;
  node.setContextWindow(4096);   // part of the serving digest
  assert.equal((await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' })).status < 300, true);
  await registry.scheduleTick();
  assert.equal((await registry.store.getSchedule(FIXTURE, 'B')).next_at, null, 'a serving change does not reschedule a held node');
  const b = await registry.store.getSchedule(FIXTURE, 'B');
  await registry.store.setSchedule(FIXTURE, 'B', { ...b, next_at: new Date(Date.now() - 1000).toISOString() });
  await registry.scheduleTick();
  assert.ok(!node.calls.slice(before).some((c) => CORPUS.identity.includes(c.prompt)), 'no identity prompt sent while held');
  assert.equal((await detail(registry)).state, 'community');
});

test('a second partial mismatch disputes, and a new card revision does not reset the count', async (t) => {
  const { node, registry } = await verified(t);
  partialMismatch(node);
  await admit(registry);
  node.reprice(42);   // a new revision: only a recapture resets "first"
  partialMismatch(node);
  const r = await admit(registry);   // the admin's review: run it again
  assert.equal(r.body.state, 'disputed');
  assert.equal((await detail(registry)).history.at(-1).reason, 'Stage B identity fingerprint mismatch');
  assert.equal(await registry.store.getSchedule(FIXTURE, HOLD), null, 'a judged run ends the hold');
});

test('a recapture reopens a held node within the first-run window and resets "first"', async (t) => {
  const { node, registry } = await verified(t);
  partialMismatch(node);
  await admit(registry);
  const c = await capture(registry);
  assert.deepEqual(c.body.reopened, [FIXTURE]);
  assert.equal(await registry.store.getSchedule(FIXTURE, HOLD), null);
  const due = Date.parse((await registry.store.getSchedule(FIXTURE, 'B')).next_at) - Date.now();
  assert.ok(due > 0 && due <= SCHEDULE_DEFAULTS.stageBFirstMs[1], `Stage B due in the first-run window (${due} ms)`);
  partialMismatch(node);
  assert.equal((await admit(registry)).body.state, 'community', 'inconclusive again, not disputed: new references');
  assert.equal((await admit(registry)).body.state, 'verified', 'an exact run passes and ends the hold');
  assert.equal(await registry.store.getSchedule(FIXTURE, HOLD), null);
});

test('no reference matched: inconclusive the first time too (only hashes are stored), disputed the second; a refused prompt disputes at once', async (t) => {
  await t.test('no reference matched', async (t) => {
    const { node, registry } = await verified(t);
    node.swapModel();
    const first = await admit(registry);
    assert.equal(first.body.state, 'community');
    assert.match(first.body.stage_b.reason, /: 0\/3 reference matches$/);
    assert.equal((await admit(registry)).body.state, 'disputed');
  });
  await t.test('a partial mismatch whose retry is refused (M4 keeps its force)', async (t) => {
    const { node, registry } = await verified(t);
    node.perturb(1);
    node.refuseRepeats();
    const r = await admit(registry);
    assert.equal(r.body.state, 'disputed');
    assert.equal(r.body.stage_b.verdicts[0].identity.unanswered, 1);
  });
});

test('reference capture from an endpoint that is not a node: lists nothing, sends the key to that origin only, keeps the source private', async (t) => {
  const node = await startFixtureNode();
  const lab = await startFixtureNode();   // the capture machine: serves the same weights, never registered
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST, probeCorpus: CORPUS });
  t.after(async () => { await registry.close(); await node.close(); await lab.close(); });

  const bad = await post(registry, '/v0/fingerprints/capture-endpoint', { endpoint: lab.origin.replace('http://', 'http://u:p@') + '/v1', model_id: 'onp-echo-1', artifact: ARTIFACT });
  assert.equal(bad.status, 400, 'no credentials in the URL');
  assert.equal((await post(registry, '/v0/fingerprints/capture-endpoint', { endpoint: `${lab.origin}/v1`, model_id: 'onp-echo-1', artifact: 'echo-1' })).status, 400);

  const r = await post(registry, '/v0/fingerprints/capture-endpoint', {
    endpoint: `${lab.origin}/v1/`, model_id: 'onp-echo-1', artifact: ARTIFACT, key: 'lab-secret', runtime: 'fixture 1.0, CPU',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.artifact, ARTIFACT);
  assert.ok(r.body.references > 0);
  assert.ok(!JSON.stringify(r.body).includes('lab-secret'), 'the key is never returned');
  const sent = lab.calls.filter((c) => CORPUS.identity.includes(c.prompt));
  assert.equal(sent.length, r.body.references, 'identity prompts from the private corpus');
  assert.equal(lab.lastAuth, 'Bearer lab-secret');
  assert.ok(sent.every((c) => !c.pinned), 'no ONP headers to an endpoint that is not a node');

  const [source] = await registry.store.captures(ARTIFACT);
  assert.deepEqual(source.source, { how: 'endpoint', host: new URL(lab.origin).host, model_id: 'onp-echo-1', runtime: 'fixture 1.0, CPU' });
  assert.ok(!(await (await fetch(`${registry.origin}/v0/nodes`)).text()).includes(new URL(lab.origin).host), 'nothing listed');
  assert.ok(!(await (await fetch(`${registry.origin}/v0/export`)).text()).includes('fixture 1.0'), 'the source is not exported');

  // The registered node is then judged against those references.
  await register(registry, node);
  assert.equal((await admit(registry)).body.state, 'verified');
});

test('failed registrations are counted per week and reason, with nothing about the attempt', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await registry.close(); await node.close(); });
  const secretPath = '/no-such-card-7f3a.json';
  for (let i = 0; i < 2; i++) assert.equal((await post(registry, '/v0/nodes', { card_url: `${node.origin}${secretPath}` })).status, 422);
  assert.equal((await post(registry, '/v0/nodes', {})).status, 400, 'a malformed request is not counted');
  const stats = await (await fetch(`${registry.origin}/v0/stats/registrations?weeks=2`)).json();
  assert.equal(stats.weeks.length, 2);
  assert.deepEqual(stats.weeks[0].failed, { 'card-unfetchable': 2, 'card-invalid': 0, 'namespace-mismatch': 0 });
  assert.equal(stats.weeks[0].total, 2);
  assert.ok(!JSON.stringify(stats).includes('7f3a'), 'no card URL');
  assert.deepEqual((await registry.store.registrationFailures()).map((r) => ({ ...r })), [{ week: stats.weeks[0].week, reason: 'card-unfetchable', n: 2 }]);
});

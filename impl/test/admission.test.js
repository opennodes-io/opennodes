// Admission hardening after the expert review (18 Nov 2026, sections 4.2, 4.3, 4.3a, 4.6):
// Stage B only on the registry's schedule or by an admin, disputes that survive re-registration,
// no identity reference = not verified, the vendor-namespace rule, no verified tier for an unsigned
// card, probe prompts from a private corpus, and blind probes whose 409s and failures count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { createSqliteStore } from '@opennodes/registry/src/store.js';
import { createPgStore } from '@opennodes/registry/src/store-pg.js';
import { loadCorpus, BUILTIN_CORPUS, LEGACY_IDENTITY_PROMPTS, IDENTITY_CAPTURE } from '@opennodes/registry/src/corpus.js';
import { vendorClaim, vendorTable, artifactClaimProblems, ownLabel, nodeDomain } from '@opennodes/registry/src/vendors.js';
import { UNSIGNED_CARD, NO_REFERENCE, IDENTITY_MAX_TOKENS, MAX_EXCUSED_409, STAGE_B_409, CUSTOMER_ACCESS_NEEDED } from '@opennodes/registry/src/stageb.js';
import { SCHEDULE_DEFAULTS, servingDigest, makePlanner, TIMER } from '@opennodes/registry/src/schedule.js';
import { FOLLOW_UP, LIGHT_CHECK, FOLLOW_UP_MS, FOLLOW_UP_TICK_MS, JITTER, IDENTITY_SHARE, IDENTITY_STAGE_B_GAP_MS } from '@opennodes/registry/src/stagec.js';

const FIXTURE = 'org.opennodes.fixture';
const FAST = { durationMs: 200, steps: [1] };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** A private corpus for tests: everything a probe may say, none of it in the source of the registry. */
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

function api(registry, token = null) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return {
    get: async (path) => (await fetch(`${registry.origin}${path}`)).json(),
    post: (path, body) => fetch(`${registry.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
    postJson: async (path, body) => {
      const res = await fetch(`${registry.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
      return { status: res.status, body: await res.json() };
    },
  };
}

async function register(registry, node) {
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  const res = await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  return { status: res.status, body: await res.json(), registration: reg };
}

const capture = (registry, extra = {}) => api(registry).postJson('/v0/fingerprints/capture', { node_id: FIXTURE, offering_id: 'echo-1', ...extra });
const admit = (registry) => api(registry).postJson(`/v0/nodes/${FIXTURE}/admit`);
const detail = (registry) => api(registry).get(`/v0/nodes/${FIXTURE}`);

async function waitFor(fn, timeoutMs = 6000, everyMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

// ---------------------------------------------------------------- 4.3a: who runs Stage B

test('Stage B on request is admin-only; without an admin token only loopback may ask', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, adminToken: 'adm1n', stageBCapacity: FAST });
  t.after(async () => { await node.close(); await registry.close(); });
  await register(registry, node);
  const before = node.requestCount;
  assert.equal((await admit(registry)).status, 401);
  assert.equal(node.requestCount, before, 'an unauthenticated call sends nothing to the node');
  const health = await api(registry).get('/v0/health');
  assert.match(health.admission.stage_b, /admin-only/);
  assert.equal(health.admission.schedule, null, 'this registry runs no timetable');
});

// ---------------------------------------------------------------- 4.3: identity references

test('no identity reference: Stage B measures but the node stays at community; legacy public references prove nothing', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST });
  t.after(async () => { await node.close(); await registry.close(); });
  await register(registry, node);

  let { body } = await admit(registry);
  assert.equal(body.state, 'community');
  assert.equal(body.stage_b.ok, false);
  assert.equal(body.stage_b.identityFailed, false, 'unknown identity is not a dispute');
  assert.equal(body.stage_b.verdicts[0].identity.unverified, true);
  assert.equal(body.stage_b.verdicts[0].identity.reason, NO_REFERENCE);
  assert.match(body.stage_b.reason, /identity unverified/);
  assert.ok(body.stage_b.verdicts[0].context, 'context and capacity are still measured');
  const probe = (await detail(registry)).probes.find((p) => p.stage === 'B' && p.kind === 'identity');
  assert.equal(probe.ok, 0);
  assert.match(probe.detail, /identity unverified/);

  // References made with the old public prompts would match this node, and are ignored.
  const artifact = node.card.offerings[0].model.artifact;
  await registry.store.addFingerprints(artifact, LEGACY_IDENTITY_PROMPTS.map((p) => ({ prompt: p, expected_hash: sha256(`echo: ${p}`) })));
  ({ body } = await admit(registry));
  assert.equal(body.state, 'community');
  assert.equal(body.stage_b.verdicts[0].identity.reason, NO_REFERENCE);

  assert.equal((await capture(registry)).body.references, IDENTITY_CAPTURE);
  ({ body } = await admit(registry));
  assert.equal(body.state, 'verified', JSON.stringify(body.stage_b));
  assert.equal(body.stage_b.verdicts[0].identity.total, 3, 'three of the captured references are asked');
});

// ---------------------------------------------------------------- 4.3: disputes

test('a dispute survives registering again; only a recorded resolution ends it', async (t) => {
  const honest = await startFixtureNode();
  const impostor = await startFixtureNode({ impersonate: true });
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST });
  t.after(async () => { await honest.close(); await impostor.close(); await registry.close(); });
  await register(registry, honest);
  await capture(registry);
  await register(registry, impostor);                         // same namespace, now backed by the impostor
  assert.equal((await admit(registry)).body.state, 'community', 'a first mismatch is inconclusive (ONP-3 §4a.4)');
  assert.equal((await admit(registry)).body.state, 'disputed', 'the second disputes');

  // The 4 October path: register again, verify, and expect the tier back. Not any more.
  const again = await register(registry, impostor);
  assert.equal(again.registration.state, 'disputed', 'registration shows the dispute');
  assert.equal(again.status, 409);
  assert.equal(again.body.title, 'disputed');
  assert.match(again.body.detail, /does not end a dispute/);
  assert.equal((await detail(registry)).state, 'disputed');
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  assert.equal((await detail(registry)).state, 'disputed', 'a ping does not clear it either');
  assert.equal((await admit(registry)).status, 409, 'nor can Stage B run on a disputed node');

  const a = api(registry);
  assert.equal((await a.postJson(`/v0/admin/nodes/${FIXTURE}/resolve`, {})).status, 400, 'a resolution must say what was found');
  honest.reprice(0.4);                                        // the operator restores the genuine deployment
  await register(registry, honest);                           // and its card (a newer revision than the impostor's)
  const resolved = await a.postJson(`/v0/admin/nodes/${FIXTURE}/resolve`, { resolution: 'impostor origin removed; genuine deployment restored' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.state, 'community', 'Stage A runs at once; Stage B comes on schedule');
  const history = (await detail(registry)).history;
  assert.ok(history.some((h) => h.from_state === 'disputed' && h.reason === 'dispute resolved: impostor origin removed; genuine deployment restored'));
  assert.equal((await a.postJson(`/v0/admin/nodes/${FIXTURE}/resolve`, { resolution: 'again' })).status, 409, 'only a disputed node can be resolved');
  assert.equal((await admit(registry)).body.state, 'verified');
});

test('registering again keeps a verified node verified and leaves Stage B where it was scheduled', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST });
  t.after(async () => { await node.close(); await registry.close(); });
  await register(registry, node);
  await capture(registry);
  assert.equal((await admit(registry)).body.state, 'verified');
  const planned = await registry.store.getSchedule(FIXTURE, 'B');
  const again = await register(registry, node);
  assert.equal(again.status, 200);
  assert.equal(again.body.state, 'verified');
  assert.deepEqual(await registry.store.getSchedule(FIXTURE, 'B'), planned, 're-registration cannot pull Stage B forward');
});

// ---------------------------------------------------------------- 4.3: vendor namespace

test('vendor-namespace rule: built-in pins, catalogue slugs, the own label, admin entries', () => {
  const catalog = new Map([['groq', new Set(['api.groq.com'])], ['openai', new Set(['api.openai.com'])], ['meta-llama', new Set()],
    ['fireworks-ai', new Set(['api.fireworks.ai'])], ['bt', new Set(['ai.bt.co.uk'])]]);
  const table = vendorTable([{ vendor: 'acme', namespaces: ['com.acme'] }], catalog);
  assert.equal(ownLabel('io.opennodes.helsinki'), 'opennodes');
  assert.equal(nodeDomain('io.opennodes.helsinki'), 'opennodes.io');
  assert.equal(nodeDomain('uk.co.bt.gpu'), 'bt.co.uk');
  assert.equal(vendorClaim('urn:proprietary:openai:gpt-5', 'com.openai.api', table).ok, true, 'pinned vendor, its namespace');
  assert.equal(vendorClaim('urn:proprietary:openai:gpt-5', 'xyz.openai.api', table).ok, false, 'another TLD is not the vendor');
  assert.equal(vendorTable([], catalog).get('openai').source, 'built-in', 'a pin wins over the catalogue');
  assert.equal(vendorClaim('urn:proprietary:groq:llama', 'com.groq.api', table).ok, true, 'a catalogue vendor from the domain its listings are served from');
  assert.equal(vendorClaim('urn:proprietary:groq:llama', 'xyz.groq.api', table).ok, false, '...and from nowhere else');
  assert.equal(vendorClaim('urn:proprietary:fireworks-ai:m', 'ai.fireworks.inference', table).ok, true, 'the slug need not be the domain label');
  assert.equal(vendorClaim('urn:proprietary:bt:m', 'uk.co.bt.gpu', table).ok, true);
  assert.equal(vendorClaim('urn:proprietary:bt:m', 'uk.co.evil', table).ok, false, 'a second-level suffix is not a domain');
  assert.equal(vendorClaim('urn:proprietary:meta-llama:m', 'com.meta-llama.x', table).ok, false, 'reached only through routers: no domain to bind to');
  assert.equal(vendorClaim('urn:proprietary:acme:m', 'com.acme.gpu1', table).ok, true, 'admin entry');
  assert.equal(vendorClaim('urn:proprietary:acme:m', 'io.acme.gpu1', table).ok, false);
  assert.equal(vendorClaim('urn:proprietary:opennodes:echo-1', FIXTURE, table).ok, true, 'own namespace');
  assert.equal(vendorClaim('urn:proprietary:someoneelse:m', FIXTURE, table).ok, false);
  for (const a of ['hf:meta-llama/Llama-3.2-1B', 'ollama:llama3.2:1b']) assert.equal(vendorClaim(a, FIXTURE, table).ok, true, a);
  const card = { node: { id: FIXTURE }, offerings: [{ offering_id: 'x', model: { artifact: 'urn:proprietary:groq:llama' } }] };
  assert.match(artifactClaimProblems(card, table)[0], /known from imported listings/);
});

test('Stage A fails a proprietary artefact claimed outside the vendor namespace, until the registry lists it', async (t) => {
  const node = await startFixtureNode({ artifact: 'urn:proprietary:openai:echo-1' });
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const { body } = await register(registry, node);
  assert.equal(body.state, 'indexed', 'stays unverified');
  const check = body.stage_a.results.find((r) => r.kind === 'artifact-namespace');
  assert.equal(check.ok, false);
  assert.match(check.detail, /may be claimed only from com\.openai/);

  const a = api(registry);
  const vendors = await a.get('/v0/vendors');
  assert.deepEqual(vendors.vendors.find((v) => v.vendor === 'openai'), { vendor: 'openai', namespaces: ['com.openai'], source: 'built-in' });
  assert.equal((await a.postJson('/v0/admin/vendors/openai', { namespaces: ['not a namespace'] })).status, 400);
  assert.equal((await a.postJson('/v0/admin/vendors/openai', { namespaces: ['org.opennodes'] })).body.source, 'admin');
  const ping = await (await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' })).json();
  assert.equal(ping.state, 'community', 'admitted once the table says so');
  assert.equal((await a.postJson('/v0/admin/vendors/openai', { namespaces: null })).body.source, 'built-in', 'removing the admin entry restores the pin');
});

test('a catalogue vendor slug: claimable by the provider claiming its listing, not by another domain', async (t) => {
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(() => registry.close());
  const model = { 'small': { id: 'small', name: 'Small', cost: { input: 0.05, output: 0.2 } } };
  await api(registry).post('/v0/import/models-dev', { catalog: {
    acmecloud: { id: 'acmecloud', name: 'Acme', api: 'https://api.acmecloud.example/v1', models: model },
    // the fixture's own provider listing, as models.dev would have it before the operator registers
    fixtureco: { id: 'fixtureco', name: 'Fixture Co', api: 'https://api.fixture.opennodes.org/v1', models: model },
  } });

  const squatter = await startFixtureNode({ artifact: 'urn:proprietary:acmecloud:echo-1' });
  t.after(() => squatter.close());
  const { body } = await register(registry, squatter);
  assert.equal(body.state, 'indexed');
  assert.match(body.stage_a.results.find((r) => r.kind === 'artifact-namespace').detail, /known from imported listings served from api\.acmecloud\.example/);

  // A founding operator lists its own API card-only: the kit names its models under its catalogue slug.
  const provider = await startFixtureNode({ artifact: 'urn:proprietary:fixtureco:echo-1' });
  t.after(() => provider.close());
  const claimed = await register(registry, provider);
  assert.equal(claimed.body.state, 'community');
  assert.deepEqual(claimed.body.claimed_imports, ['import.modelsdev.fixtureco'], 'and its listing is claimed');
  const vendors = await api(registry).get('/v0/vendors');
  assert.deepEqual(vendors.vendors.find((v) => v.vendor === 'acmecloud'), { vendor: 'acmecloud', namespaces: [], source: 'catalog', hosts: ['api.acmecloud.example'] });

  const open = await startFixtureNode({ artifact: 'ollama:echo:1b' });
  t.after(() => open.close());
  assert.equal((await register(registry, open)).body.state, 'community', 'open-weight names are always fine');
});

// ---------------------------------------------------------------- 4.2: signatures

test('no verified tier for an unsigned card; a verified node whose new card is badly signed drops to community', async (t) => {
  const bad = await startFixtureNode({ badSignature: true });
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST });
  t.after(async () => { await bad.close(); await registry.close(); });
  const v = await register(registry, bad);
  assert.equal(v.body.signature_verified, false);
  assert.equal(v.body.state, 'community', 'accepted but labeled below verified');
  await capture(registry);
  const before = bad.requestCount;
  const { body } = await admit(registry);
  assert.equal(body.state, 'community');
  assert.equal(body.stage_b.reason, UNSIGNED_CARD);
  assert.equal(bad.requestCount, before, 'nothing is sent: the battery cannot lead anywhere');
  assert.equal((await detail(registry)).signature_verified, false);

  bad.setBadSignature(false);                                // re-signed with the published key
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  assert.equal((await detail(registry)).signature_verified, true);
  assert.equal((await admit(registry)).body.state, 'verified');

  bad.setBadSignature(true);                                 // a new revision the JWKS does not vouch for
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  const after = await detail(registry);
  assert.equal(after.state, 'community');
  assert.ok(after.history.at(-1).reason.startsWith(UNSIGNED_CARD), after.history.at(-1).reason);
});

// ---------------------------------------------------------------- 4.3 / 4.6: the probe corpus

test('every probe the node receives comes from the private corpus; nothing announces itself', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST, probeCorpus: CORPUS,
    stageC: { livenessIntervalMs: 10_000, blindIntervalMs: 60 },
  });
  t.after(async () => { await node.close(); await registry.close(); });
  const health = await api(registry).get('/v0/health');
  assert.equal(health.admission.probe_corpus.private, true);
  assert.equal(JSON.stringify(health).includes(CORPUS.chat[0]), false, 'the corpus is never published');

  await register(registry, node);
  const cap = await capture(registry);
  assert.equal(cap.body.corpus, 'private');
  assert.equal(JSON.stringify(cap.body).includes(CORPUS.identity[0]), false, 'nor returned by the capture');
  assert.equal((await admit(registry)).body.state, 'verified');
  await waitFor(async () => (await detail(registry)).probes.filter((p) => p.kind === 'blind' && p.ok).length >= 2);

  const short = new Set([...CORPUS.chat, ...CORPUS.identity]);
  assert.ok(node.prompts.length > 15);
  for (const prompt of node.prompts) {
    assert.doesNotMatch(prompt, /\bONP\b|probe/i, prompt.slice(0, 80));
    if (prompt.length < 400) assert.ok(short.has(prompt), `short prompt not from the corpus: ${prompt}`);
    else assert.ok(CORPUS.filler.some((f) => prompt.includes(f.slice(0, 60))), 'long prompts are built from the corpus filler');
  }
  assert.ok(node.prompts.some((p) => p.includes(CORPUS.needles[0].question)), 'context probes ask the corpus question');
  assert.ok(!node.prompts.some((p) => BUILTIN_CORPUS.chat.includes(p) || BUILTIN_CORPUS.identity.includes(p)), 'nothing from the public corpus');

  // References captured with the public built-in prompts do not count once the corpus is private.
  const artifact = node.card.offerings[0].model.artifact;
  await registry.store.clearFingerprints(artifact);
  await registry.store.addFingerprints(artifact, BUILTIN_CORPUS.identity.map((p) => ({ prompt: p, expected_hash: sha256(`echo: ${p}`) })));
  assert.equal((await admit(registry)).body.stage_b.verdicts[0].identity.reason, NO_REFERENCE);
});

test('probe corpus: a file or an object; a private one must bring its own haystack and needles', (t) => {
  assert.equal(loadCorpus(null).private, false);
  assert.match(loadCorpus(null).summary().note, /public/);
  const dir = mkdtempSync(join(tmpdir(), 'onp-corpus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'corpus.json');
  writeFileSync(file, JSON.stringify(CORPUS));
  const fromFile = loadCorpus(file);
  assert.equal(fromFile.private, true);
  assert.deepEqual(fromFile.summary().prompts, { chat: 6, identity: 9, filler: 2, needles: 1 });
  assert.ok(fromFile.usableReference(CORPUS.identity[0]));
  assert.ok(!fromFile.usableReference(BUILTIN_CORPUS.identity[0]));
  assert.ok(!loadCorpus(null).usableReference(LEGACY_IDENTITY_PROMPTS[0]));
  assert.throws(() => loadCorpus({ chat: CORPUS.chat, filler: CORPUS.filler }), /needles/);
  assert.throws(() => loadCorpus({ chat: CORPUS.chat, needles: CORPUS.needles }), /filler/);
  assert.throws(() => loadCorpus({ ...CORPUS, chat: ['too few'] }), /at least 5/);
  assert.throws(() => loadCorpus({ ...CORPUS, needles: [{ fact: 'no placeholder', question: 'q' }] }), /\{n\}/);
  assert.throws(() => loadCorpus(join(dir, 'missing.json')), /ENOENT/);
});

// ---------------------------------------------------------------- 4.6: blind probes

async function verifiedWithStageC(t, nodeOptions = {}, stageC = {}) {
  const node = await startFixtureNode(nodeOptions);
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST,
    stageC: { livenessIntervalMs: 10_000, blindIntervalMs: 50, ...stageC },
  });
  t.after(async () => { await registry.close(); await node.close(); });
  await register(registry, node);
  await capture(registry);
  assert.equal((await admit(registry)).body.state, 'verified');
  return { node, registry };
}

test('blind probes: a 409 with the current revision pinned is a failure, and repeated failures cost the tier', async (t) => {
  const { node, registry } = await verifiedWithStageC(t);
  node.answer409(100);
  const demoted = await waitFor(async () => {
    const d = await detail(registry);
    return d.state === 'community' ? d : null;
  });
  assert.ok(demoted, 'verified node demoted after repeated blind failures');
  assert.equal(demoted.history.at(-1).reason, 'blind: 3 consecutive failed blind invocations');
  const blind = demoted.probes.filter((p) => p.kind === 'blind');
  assert.ok(blind.slice(0, 3).every((p) => !p.ok && p.detail === '409 with the current card revision pinned'), JSON.stringify(blind.slice(0, 3)));
  assert.equal(demoted.probes.filter((p) => p.kind === 'blind-409').length, 0, 'nothing excused');

  // One tier per run of failures, counted again from the demotion.
  const indexed = await waitFor(async () => (await detail(registry)).state === 'indexed');
  assert.ok(indexed, 'community drops to unverified after 3 more');
});

test('blind probes: a 409 after a real revision change is recorded, re-indexed and retried; at most N a day', async (t) => {
  const { node, registry } = await verifiedWithStageC(t, {}, { maxExcused409: 1, blindFailThreshold: 100 });
  const probes = async () => (await detail(registry)).probes;

  // The node publishes a new card just as the probe arrives: a legitimate 409 (the 4 Oct case).
  node.answer409(1, { newRevision: true });
  const excused = await waitFor(async () => (await probes()).find((p) => p.kind === 'blind-409'));
  assert.ok(excused, 'the 409 is recorded');
  assert.equal(excused.ok, 0);
  assert.match(excused.detail, /^409 with revision .* pinned; card re-indexed at .*, probe retried, a fresh one due within the hour$/);
  const owed = await registry.store.getSchedule(FIXTURE, FOLLOW_UP);
  assert.ok(Date.parse(owed.next_at) - Date.parse(excused.at) <= FOLLOW_UP_MS[1], 'a fresh blind probe is owed within the hour');
  const retried = await waitFor(async () => {
    const list = await probes();
    const i = list.findIndex((p) => p.kind === 'blind-409');
    return i > 0 && list.slice(0, i).find((p) => p.kind === 'blind');   // the probe recorded after it
  });
  assert.equal(retried.ok, 1, 'the retry with the new revision passed');
  assert.equal((await detail(registry)).state, 'verified', 'an excused 409 costs nothing');
  assert.equal((await detail(registry)).card.revision, node.card.revision, 'the registry holds the new card');

  // A second one within 24 h is beyond the bound: it counts as a failed blind call.
  node.answer409(1, { newRevision: true });
  const failed = await waitFor(async () => (await probes()).find((p) => p.kind === 'blind' && /again after 1 card revisions in 24 h/.test(p.detail ?? '')));
  assert.ok(failed, 'the second 409 within 24 h is a failure');
  assert.equal(failed.ok, 0);
  assert.equal((await probes()).filter((p) => p.kind === 'blind-409').length, 1, 'only one was excused');
});

// ---------------------------------------------------------------- follow-up review, point 6

test('blind probes: a node that bumps its revision on every probe still gets probed within the hour', async (t) => {
  // The real window: owed at a random time that, with the follow-up tick's lateness, falls within the hour.
  assert.ok(FOLLOW_UP_MS[1] + JITTER[1] * FOLLOW_UP_TICK_MS < 3_600_000);
  {
    const { node, registry } = await verifiedWithStageC(t, {}, { blindIntervalMs: 1e9, followUpTickMs: 1e9 });
    node.dodge(1);
    const before = Date.now();
    await registry.blindSweep();
    const owed = await registry.store.getSchedule(FIXTURE, FOLLOW_UP);
    assert.equal(owed.revision, node.card.revision, 'owed against the revision the node moved to');
    const due = Date.parse(owed.next_at) - before;
    assert.ok(due >= FOLLOW_UP_MS[0] && due <= FOLLOW_UP_MS[1] + 1000, `follow-up due ${due} ms after the excused 409`);
  }

  // Scaled down: "the hour" is 700 ms. The node refuses every probe it does not know for one, each
  // time with a new card revision, and answers only the registry's immediate retry.
  const WINDOW = [400, 700];
  const { node, registry } = await verifiedWithStageC(t, {}, {
    blindIntervalMs: 1e9, followUpTickMs: 20, followUpMs: WINDOW, maxExcused409: 3, blindFailThreshold: 3,
  });
  const probes = async () => (await detail(registry)).probes;
  node.dodge(100, { answerWithinMs: 300 });
  await registry.blindSweep();   // one regular probe; every excused 409 after it comes from a follow-up

  // Three excused 409s (the daily bound), each followed within the window by a probe pinned to the new revision.
  const third = await waitFor(async () => (await probes()).find((p) => p.kind === 'blind' && /again after 3 card revisions in 24 h/.test(p.detail ?? '')));
  assert.ok(third, 'the fourth 409 in 24 h counts as a failure');
  const excused = (await probes()).filter((p) => p.kind === 'blind-409').reverse();
  assert.equal(excused.length, 3);
  for (const e of excused) {
    const revision = e.detail.match(/re-indexed at (\S+),/)[1];
    const [retry, followUp] = node.calls.filter((c) => c.pinned === revision);
    assert.equal(retry.status, 200, 'the immediate retry is answered');
    assert.ok(followUp, `a fresh probe pinned to ${revision}`);
    const after = Date.parse(followUp.at) - Date.parse(e.at);
    assert.ok(after >= WINDOW[0] - 50 && after <= WINDOW[1] + 250, `follow-up ${after} ms after the excused 409`);
  }
  assert.equal((await registry.store.getSchedule(FIXTURE, FOLLOW_UP)).next_at, null, 'a 409 that is not excused owes nothing');

  // Dodging on: regular probes now fail, and the third failure in a row costs the tier.
  for (let i = 0; i < 2; i++) { await sleep(350); await registry.blindSweep(); }
  const d = await detail(registry);
  assert.equal(d.state, 'community');
  assert.equal(d.history.at(-1).reason, 'blind: 3 consecutive failed blind invocations');

  // Retries and follow-ups go out exactly like any other blind invocation.
  const shapes = new Set(node.calls.filter((c) => c.at > excused[0].at).map((c) => JSON.stringify([c.keys, { ...c.params, model: null }])));
  assert.equal(shapes.size, 1, [...shapes].join('\n'));
});

// ---------------------------------------------------------------- follow-up review, point 8

/** A verified fixture on a registry with the timetable on, Stage C driven by the test, and the private corpus. */
async function verifiedWithLightCheck(t, { schedule = true, ...stageC } = {}) {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST, probeCorpus: CORPUS,
    schedule: schedule ? { tickMs: 3_600_000 } : null,
    stageC: { livenessIntervalMs: 1e9, blindIntervalMs: 1e9, followUpTickMs: 1e9, identityShare: 1, ...stageC },
  });
  t.after(async () => { await registry.close(); await node.close(); });
  await register(registry, node);
  await capture(registry);
  assert.equal((await admit(registry)).body.state, 'verified');
  return { node, registry };
}

const stageBDue = async (registry) => Date.parse((await registry.store.getSchedule(FIXTURE, 'B')).next_at);

test('light identity check: a node that swaps its model after passing is sent to Stage B within the hour; only Stage B disputes', async (t) => {
  const { node, registry } = await verifiedWithLightCheck(t);
  const day = 24 * 3_600_000;
  const references = new Set(CORPUS.identity);
  const planned = await stageBDue(registry);
  assert.ok(planned - Date.now() >= SCHEDULE_DEFAULTS.stageBMinGapMs - 1000, 'after the pass, the next Stage B is a day or more away');

  // The honest node: its reply is the reference's, and nothing changes.
  await registry.blindSweep();
  assert.ok(references.has(node.calls.at(-1).prompt), 'the blind probe asked an identity prompt');
  assert.equal((await registry.store.getSchedule(FIXTURE, LIGHT_CHECK)).ok, true);
  assert.equal(await stageBDue(registry), planned);

  // Batching changed one reply: it is asked once more, matches, and nothing changes either.
  node.perturb(1);
  const n = node.calls.length;
  await registry.blindSweep();
  assert.equal(node.calls.length, n + 2, 'one repeat');
  assert.equal(node.calls.at(-1).prompt, node.calls.at(-2).prompt);
  assert.equal((await registry.store.getSchedule(FIXTURE, LIGHT_CHECK)).ok, true);
  assert.equal(await stageBDue(registry), planned);

  // The node swaps its model under the same card. The next light check sees it.
  node.swapModel();
  const before = Date.now();
  await registry.blindSweep();
  let d = await detail(registry);
  assert.equal(d.state, 'verified', 'a light check never changes the tier');
  const blind = d.probes.find((p) => p.stage === 'C');
  assert.deepEqual([blind.kind, blind.ok, blind.detail], ['blind', 1, null], 'the public record says only that the reply conformed');
  assert.ok(!JSON.stringify(d).includes(node.calls.at(-1).prompt), 'nor what was asked');
  const light = await registry.store.getSchedule(FIXTURE, LIGHT_CHECK);
  assert.deepEqual([light.ok, light.failures], [false, 1]);
  const due = await stageBDue(registry);
  assert.ok(due >= before && due - before <= SCHEDULE_DEFAULTS.stageBIdentityMs[1], `Stage B due ${due - before} ms after the mismatch`);
  assert.ok(SCHEDULE_DEFAULTS.stageBIdentityMs[1] + JITTER[1] * SCHEDULE_DEFAULTS.tickMs <= 3_600_000, 'and it runs within the hour');

  // At most one Stage B a day from light checks: had that run passed, the next mismatch waits.
  const b = await registry.store.getSchedule(FIXTURE, 'B');
  await registry.store.setSchedule(FIXTURE, 'B', { ...b, next_at: new Date(Date.now() + 30 * day).toISOString() });
  await registry.blindSweep();
  assert.ok(await stageBDue(registry) > Date.now() + 29 * day, 'no second Stage B within 24 h');
  assert.equal((await registry.store.getSchedule(FIXTURE, LIGHT_CHECK)).failures, 2, 'the mismatch is still recorded');
  const l = await registry.store.getSchedule(FIXTURE, LIGHT_CHECK);
  await registry.store.setSchedule(FIXTURE, LIGHT_CHECK, { ...l, next_at: new Date(Date.now() - IDENTITY_STAGE_B_GAP_MS - 1000).toISOString() });
  await registry.blindSweep();
  assert.ok(await stageBDue(registry) - Date.now() <= SCHEDULE_DEFAULTS.stageBIdentityMs[1], 'a day later it may ask again');

  // The hour passes; the scheduler runs Stage B. Its first mismatch for the artefact is inconclusive
  // (ONP-3 §4a.4): the node loses verified and Stage B is held until a recapture or an admin's run.
  await registry.store.setSchedule(FIXTURE, 'B', { ...(await registry.store.getSchedule(FIXTURE, 'B')), next_at: new Date(Date.now() - 1000).toISOString() });
  await registry.scheduleTick();
  d = await detail(registry);
  assert.equal(d.state, 'community');
  assert.match(d.history.at(-1).reason, /^Stage B identity inconclusive: /);
  // The admin's review runs Stage B again: a second mismatch disputes.
  assert.equal((await admit(registry)).body.state, 'disputed');
  d = await detail(registry);
  assert.equal(d.state, 'disputed');
  assert.equal(d.history.at(-1).reason, 'Stage B identity fingerprint mismatch');
  assert.equal(d.history.filter((h) => h.to_state === 'disputed').length, 1, 'and nothing before it did');
});

test('light identity check: about 1 in 4 blind probes of a verified node carries one', async (t) => {
  let r = 0.9;
  const { node, registry } = await verifiedWithLightCheck(t, { identityShare: IDENTITY_SHARE, random: () => r });
  assert.equal(IDENTITY_SHARE, 0.25);
  const asked = async (value) => { r = value; await registry.blindSweep(); return node.calls.at(-1).prompt; };
  assert.ok(CORPUS.chat.includes(await asked(0.9)), 'three draws in four: an ordinary prompt');
  assert.ok(CORPUS.chat.includes(await asked(IDENTITY_SHARE)), 'the boundary is ordinary too');
  assert.ok(CORPUS.identity.includes(await asked(0.2)), 'one in four: an identity reference');
});

test('light identity check: it goes out like any blind probe, and without a timetable a mismatch is only recorded', async (t) => {
  const { node, registry } = await verifiedWithLightCheck(t, { schedule: false });
  // The reference capture and Stage B's identity battery so far: the requests a light check must look like.
  const references = node.calls.filter((c) => CORPUS.identity.includes(c.prompt));
  assert.equal(references.length, IDENTITY_CAPTURE + 3);
  await registry.blindSweep();
  const identity = node.calls.at(-1);
  assert.ok(CORPUS.identity.includes(identity.prompt));
  await registry.store.clearFingerprints(node.card.offerings[0].model.artifact);
  await registry.blindSweep();
  const ordinary = node.calls.at(-1);
  assert.ok(CORPUS.chat.includes(ordinary.prompt), 'no reference: an ordinary prompt');
  for (const c of [ordinary, ...references]) {
    assert.deepEqual(c.keys, identity.keys);
    assert.deepEqual(c.params, identity.params);
  }
  assert.deepEqual(identity.params, { model: identity.params.model, temperature: 0, max_tokens: IDENTITY_MAX_TOKENS });

  // No timetable here (ONP_SCHEDULE=0): Stage B runs only on admin request, so nothing is scheduled.
  await capture(registry);
  const before = await registry.store.getSchedule(FIXTURE, 'B');
  node.swapModel();
  await registry.blindSweep();
  assert.equal((await registry.store.getSchedule(FIXTURE, LIGHT_CHECK)).ok, false);
  assert.deepEqual(await registry.store.getSchedule(FIXTURE, 'B'), before);
  assert.equal((await detail(registry)).state, 'verified');
});

// ---------------------------------------------------------------- Stage B 409s (found with point 8)

/** Make Stage B due now and run one scheduler pass. */
async function runDueStageB(registry) {
  const b = await registry.store.getSchedule(FIXTURE, 'B');
  await registry.store.setSchedule(FIXTURE, 'B', { ...b, next_at: new Date(Date.now() - 1000).toISOString() });
  await registry.scheduleTick();
}

test('Stage B: a 409 with the current revision pinned is a reply that does not match, so a swapped node that refuses the repeat is disputed', async (t) => {
  const { node, registry } = await verifiedWithLightCheck(t);
  node.swapModel();
  node.refuseRepeats();
  await registry.blindSweep();   // the light check: a refused repeat counts as a second miss
  assert.ok(await stageBDue(registry) - Date.now() <= SCHEDULE_DEFAULTS.stageBIdentityMs[1], 'sent to Stage B');
  await runDueStageB(registry);
  const d = await detail(registry);
  assert.equal(d.state, 'disputed', 'a verdict, not an abort');
  assert.equal(d.history.at(-1).reason, 'Stage B identity fingerprint mismatch');
  const identity = d.probes.find((p) => p.stage === 'B' && p.kind === 'identity');
  assert.match(identity.detail, /^0\/3 reference matches; \d+ replies refused with 409, the current card revision pinned$/);
  assert.ok(!d.probes.some((p) => p.kind === STAGE_B_409), 'nothing excused');
});

test('Stage B: a node that publishes a new revision to refuse the repeat is excused a bounded number of times, then its refusals count as replies that do not match', async (t) => {
  const { node, registry } = await verifiedWithLightCheck(t);
  node.swapModel();
  node.refuseRepeats(true, { newRevision: true });
  for (let i = 1; i <= MAX_EXCUSED_409; i++) {
    await runDueStageB(registry);
    const d = await detail(registry);
    assert.equal(d.state, 'verified', `run ${i}: stopped unjudged`);
    assert.equal(d.probes.filter((p) => p.kind === STAGE_B_409).length, i, 'every excused 409 is recorded');
    const retry = await stageBDue(registry) - Date.now();
    assert.ok(retry <= SCHEDULE_DEFAULTS.staleRetryMs[1], `run ${i}: tried again within the hour (${retry} ms)`);
  }
  await runDueStageB(registry);
  const d = await detail(registry);
  // Beyond the bound a refusal is a reply that does not match: the swapped model is disputed, it cannot
  // sit at community by spending fresh revisions on every run (review M4).
  assert.equal(d.state, 'disputed', 'the next one is judged on its replies');
  assert.equal(d.history.at(-1).reason, 'Stage B identity fingerprint mismatch');
  assert.match(d.probes.find((p) => p.stage === 'B' && p.kind === 'identity').detail,
    /re-pinned to revision \S+ after 3 excused card changes since the last judged run \(at most 3 are excused\), then \d+ refusals with it pinned, counted as replies that do not match$/);
});

test('Stage B: an honest node that changes its card before every run is re-pinned beyond the bound and passes, never disputed', async (t) => {
  const { node, registry } = await verifiedWithLightCheck(t);
  const before = (await detail(registry)).history.length;
  for (let i = 1; i <= MAX_EXCUSED_409 + 1; i++) {
    node.answer409(1, { newRevision: true });   // a re-price lands just as the run starts: one stale 409
    await runDueStageB(registry);
    const d = await detail(registry);
    assert.equal(d.state, 'verified', `run ${i}: no verdict against the node`);
  }
  const d = await detail(registry);
  assert.equal(d.history.length, before, 'no state change at all');
  assert.match(d.probes.find((p) => p.stage === 'B' && p.kind === 'identity').detail,
    /^3\/3 reference matches; re-pinned to revision \S+ after 3 excused card changes/);
});

test('Stage B: beyond the bound, a card that now claims another model ends the run as not passed, without a dispute', async (t) => {
  const { node, registry } = await verifiedWithLightCheck(t);
  for (let i = 1; i <= MAX_EXCUSED_409; i++) { node.answer409(1, { newRevision: true }); await runDueStageB(registry); }
  // the next change also swaps the claimed artefact: no reply was compared for the new claim
  const card = node.card;
  node.answer409(1, { newRevision: true });
  const realRevisionMoved = registry.store.latestCard.bind(registry.store);
  registry.store.latestCard = async (id) => {
    const latest = await realRevisionMoved(id);
    return latest && latest.revision !== card.revision
      ? { ...latest, offerings: latest.offerings.map((o) => ({ ...o, model: { ...o.model, artifact: 'hf:other/model' } })) } : latest;
  };
  await runDueStageB(registry);
  const d = await detail(registry);
  assert.equal(d.state, 'community');
  assert.match(d.history.at(-1).reason, /claimed model or binding changed or is gone/);
  assert.ok(!d.history.some((h) => h.to_state === 'disputed'));
});

test('Stage B: an honest card change during the run is excused, and the next run passes', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST });
  t.after(async () => { await node.close(); await registry.close(); });
  await register(registry, node);
  await capture(registry);
  node.answer409(1, { newRevision: true });   // the node restarts just as the first identity prompt arrives
  const stale = await admit(registry);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.title, 'stale-card');
  const excused = (await detail(registry)).probes.find((p) => p.kind === STAGE_B_409);
  assert.match(excused.detail, /^409 with revision \S+ pinned; card re-indexed at \S+; Stage B runs again later$/);
  assert.equal((await admit(registry)).body.state, 'verified');
});

// ---------------------------------------------------------------- follow-up review, point 5: card-only listings

const ADMIN = 'adm1n';
async function cardOnlyRegistry(t) {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, stageBCapacity: FAST, adminToken: ADMIN, schedule: { tickMs: 3_600_000 } });
  t.after(async () => { await node.close(); await registry.close(); });
  const admin = api(registry, ADMIN);
  const registerWith = async (body) => {
    const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json`, ...body }),
    })).json();
    node.setChallenge(reg.challenge.token);
    return (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json();
  };
  const access = (key) => admin.postJson(`/v0/admin/nodes/${FIXTURE}/customer-access`, { key });
  return { node, registry, admin, registerWith, access, admitAs: () => admin.postJson(`/v0/nodes/${FIXTURE}/admit`) };
}

test('card-only listing: Stage B may pass it but it stays at community until customer access is recorded; then probes carry that access', async (t) => {
  const { node, registry, admin, registerWith, access, admitAs } = await cardOnlyRegistry(t);
  assert.equal((await registerWith({ probe_key: 'pk-dedicated' })).state, 'community');
  assert.equal(node.lastAuth, 'Bearer pk-dedicated');
  assert.equal((await admin.postJson('/v0/fingerprints/capture', { node_id: FIXTURE, offering_id: 'echo-1' })).status, 200);

  let { body } = await admitAs();
  assert.equal(body.stage_b.ok, true, 'the battery passed');
  assert.equal(body.stage_b.held, CUSTOMER_ACCESS_NEEDED);
  assert.equal(body.state, 'community', 'but on probes the operator could pick out');
  assert.equal((await detail(registry)).probes.find((p) => p.kind === 'customer-access').detail, CUSTOMER_ACCESS_NEEDED);

  // Only the admin records customer access; recording it does not promote on the earlier pass.
  assert.equal((await api(registry).postJson(`/v0/admin/nodes/${FIXTURE}/customer-access`, { key: 'ck-bought' })).status, 401);
  assert.equal((await access('')).status, 400);
  const before = Date.now();
  const recorded = await access('ck-bought');
  assert.deepEqual(recorded.body, { node_id: FIXTURE, customer_access: true, state: 'community' });
  const due = await stageBDue(registry) - before;
  assert.ok(due <= SCHEDULE_DEFAULTS.stageBFirstMs[1] + 1000, 'a fresh Stage B, at a time the registry picks');

  // From now on every probe carries the customer key instead of the dedicated one.
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  assert.equal(node.lastAuth, 'Bearer ck-bought');
  ({ body } = await admitAs());
  assert.equal(body.state, 'verified');
  assert.equal(body.stage_b.held, undefined);
  assert.equal(node.lastAuth, 'Bearer ck-bought');

  // The key is never published, and nothing public says customer access was recorded.
  for (const path of [`/v0/nodes/${FIXTURE}`, '/v0/nodes', '/v0/offerings', '/v0/export', '/v0/health']) {
    const text = await (await fetch(`${registry.origin}${path}`)).text();
    assert.ok(!text.includes('ck-bought') && !text.includes('pk-dedicated'), `no key in ${path}`);
    assert.ok(!text.includes('customer_access'), `no recorded flag in ${path}`);
  }
  assert.ok(!JSON.stringify(recorded.body).includes('ck-bought'), 'nor in the admin response');

  // Removing it: a verified card-only listing goes back to community at once, and the dedicated key is used again.
  assert.deepEqual((await access(null)).body, { node_id: FIXTURE, customer_access: false, state: 'community' });
  assert.equal((await detail(registry)).history.at(-1).reason, CUSTOMER_ACCESS_NEEDED);
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  assert.equal(node.lastAuth, 'Bearer pk-dedicated');
});

test('card-only listing: a verified node that hands over a probe key goes back to community until customer access is recorded', async (t) => {
  const { node, registry, admin, registerWith, access, admitAs } = await cardOnlyRegistry(t);
  await registerWith({});
  await admin.postJson('/v0/fingerprints/capture', { node_id: FIXTURE, offering_id: 'echo-1' });
  assert.equal((await admitAs()).body.state, 'verified', 'no probe key: probes look like any client');
  assert.equal(node.lastAuth, null);

  assert.equal((await registerWith({ probe_key: 'pk-later' })).state, 'community');
  assert.equal((await detail(registry)).history.at(-1).reason, CUSTOMER_ACCESS_NEEDED);
  assert.equal((await access('ck-bought')).body.state, 'community');
  assert.equal((await admitAs()).body.state, 'verified');
  assert.equal(node.lastAuth, 'Bearer ck-bought');
  assert.equal((await api(registry, ADMIN).postJson('/v0/admin/nodes/io.example.nobody/customer-access', { key: 'x' })).status, 404);
});

// ---------------------------------------------------------------- 4.3a: the schedule

test('scheduler: Stage B within the first-run window after community, after a change, and demotion on a failed re-run', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST,
    schedule: { tickMs: 3_600_000, stageAIntervalMs: 40, stageBFirstMs: [0, 0], stageBChangeMs: [0, 0] },
  });
  t.after(async () => { await node.close(); await registry.close(); });
  assert.deepEqual((await api(registry).get('/v0/health')).admission.schedule, { stage_a_max_hours: 0, stage_b_max_days: 91 });
  await register(registry, node);
  await capture(registry);
  const b0 = await registry.store.getSchedule(FIXTURE, 'B');
  assert.ok(b0.next_at && !b0.last_at, 'Stage B planned when the node reached community');

  await sleep(60);
  const sentBefore = node.requestCount;
  await registry.scheduleTick();
  let d = await detail(registry);
  assert.equal(d.state, 'verified', JSON.stringify(d.history.at(-1)));
  assert.ok(node.requestCount - sentBefore >= 1 + 3 + 1 + 3 + 1, 'Stage A and Stage B ran');
  const b1 = await registry.store.getSchedule(FIXTURE, 'B');
  const gap = Date.parse(b1.next_at) - Date.parse(b1.last_at);
  assert.ok(gap >= SCHEDULE_DEFAULTS.stageBMinGapMs - 5 && gap <= SCHEDULE_DEFAULTS.stageBIntervalMs + 5, `next Stage B ${gap} ms later`);
  assert.equal(b1.digest, servingDigest(node.card));

  // A changed serving block makes Stage B due again (here at once).
  node.setContextWindow(4096);
  await sleep(60);
  const bCount = async () => (await detail(registry)).probes.filter((p) => p.stage === 'B' && p.kind === 'identity').length;
  const before = await bCount();
  await registry.scheduleTick();
  assert.equal(await bCount(), before + 1, 'Stage B ran after the change');
  assert.equal((await registry.store.getSchedule(FIXTURE, 'B')).digest, servingDigest(node.card));

  // A re-run that cannot verify identity any more demotes the node.
  await registry.store.clearFingerprints(node.card.offerings[0].model.artifact);
  await registry.store.setSchedule(FIXTURE, 'B', { ...(await registry.store.getSchedule(FIXTURE, 'B')), next_at: new Date(Date.now() - 1000).toISOString() });
  await sleep(60);
  await registry.scheduleTick();
  d = await detail(registry);
  assert.equal(d.state, 'community');
  assert.match(d.history.at(-1).reason, /^Stage B failed: echo-1: identity unverified/);

  // None of this is public: no API, export or detail carries the next run time.
  for (const path of ['/v0/health', `/v0/nodes/${FIXTURE}`, '/v0/export', '/v0/nodes']) {
    const text = await (await fetch(`${registry.origin}${path}`)).text();
    assert.ok(!text.includes('next_at') && !text.includes(b1.next_at), path);
  }
});

test('scheduler: runs a change sets off never move the random Stage B timer (4.3a: the operator cannot time Stage B)', async () => {
  const rows = new Map();
  const store = {
    getSchedule: async (n, stage) => rows.get(`${n}|${stage}`) ?? null,
    setSchedule: async (n, stage, row) => { rows.set(`${n}|${stage}`, { ...row }); },
  };
  const planner = makePlanner(store, { random: () => 0.5 });
  const card = { revision: 'r1', offerings: [] };
  const DAY = 86_400_000;
  const nextB = () => Date.parse(rows.get('n|B').next_at);
  const timer = () => rows.get(`n|${TIMER}`)?.next_at;

  // A pass draws the random timer, 1 to 91 days on, and Stage B is next due then.
  await planner.afterStageB('n', card, { ok: true });
  const first = timer();
  const gap = Date.parse(first) - Date.now();
  assert.ok(gap > DAY && gap <= 91 * DAY, `timer ${gap} ms on`);
  assert.equal(rows.get('n|B').next_at, first);

  // An operator changes the card every day for a month; each change sets off a run that passes.
  for (let day = 0; day < 30; day++) {
    await store.setSchedule('n', 'B', { ...rows.get('n|B'), next_at: new Date(Date.now() - 1).toISOString() });
    await planner.afterStageB('n', card, { ok: true });
    assert.equal(timer(), first, 'a run set off by a change does not redraw the timer');
    assert.equal(rows.get('n|B').next_at, first, 'so the random run still comes when it was drawn');
  }

  // A run that does not pass comes back after the retry gap or at the timer, whichever is sooner.
  await planner.afterStageB('n', card, { ok: false });
  assert.ok(nextB() <= Date.parse(first));
  assert.equal(timer(), first);

  // Only a run the timer set off (the timer is due) draws a new one.
  await store.setSchedule('n', TIMER, { last_at: null, next_at: new Date(Date.now() - 1).toISOString() });
  await planner.afterStageB('n', card, { ok: true });
  assert.ok(Date.parse(timer()) > Date.now() + DAY);
  assert.equal(rows.get('n|B').next_at, timer());

  // A change brings a run at a random time within three days, not within the hour.
  assert.deepEqual(SCHEDULE_DEFAULTS.stageBChangeMs, [0, 72 * 3_600_000]);
});

test('blind probes go out on the card the registry holds: no card fetch just before them (follow-up point 5)', async (t) => {
  const { node, registry } = await verifiedWithStageC(t, {}, { blindIntervalMs: 1e9, followUpTickMs: 1e9, cardRefreshIntervalMs: 1e9 });
  const fetches = node.cardFetches, calls = node.calls.length;
  await registry.blindSweep();
  assert.equal(node.calls.length, calls + 1, 'one blind call');
  assert.equal(node.cardFetches, fetches, 'and no card fetch before it');
  // The card sweep, on its own timer, picks up a new revision.
  node.setContextWindow(4096);
  await registry.cardSweep();
  assert.ok(node.cardFetches > fetches, 'the card sweep fetched the card');
  assert.equal((await registry.store.latestCard(FIXTURE)).revision, node.card.revision);
  // A probe pinned to an old revision still gets the 409 path: re-fetch, then retry with the new pin.
  node.setContextWindow(2048);
  await registry.blindSweep();
  assert.equal((await registry.store.latestCard(FIXTURE)).revision, node.card.revision);
  const failedBlind = async () => (await detail(registry)).probes.filter((p) => p.stage === 'C' && p.kind === 'blind' && !p.ok);
  assert.deepEqual(await failedBlind(), [], 'the retry with the new pin passed');
  // An offering the node dropped since the card was fetched answers 404, not 409: the card is
  // re-fetched after that reply, and the failure is excused like a 409, not counted against the node.
  node.setOfferings(['speech']);
  await registry.blindSweep();
  assert.deepEqual(await failedBlind(), [], 'no failed blind probe recorded');
  assert.ok((await detail(registry)).probes.some((p) => p.kind === 'blind-409' && /no longer offers/.test(p.detail)));
});

test('scheduled Stage B on the held card: a model dropped since the last card fetch is not a dispute', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({
    allowPrivateTargets: true, stageBCapacity: FAST,
    stageC: { livenessIntervalMs: 1e9, blindIntervalMs: 1e9, followUpTickMs: 1e9, cardRefreshIntervalMs: 1e9 },
    schedule: { tickMs: 3_600_000, stageAIntervalMs: 1e9, stageBFirstMs: [1e9, 1e9], stageBChangeMs: [0, 0] },
  });
  t.after(async () => { await node.close(); await registry.close(); });
  await register(registry, node);
  await capture(registry);
  assert.equal((await admit(registry)).body.state, 'verified');

  // The operator drops the chat model; the registry has not fetched the card since.
  const fetches = node.cardFetches;
  node.setOfferings(['speech']);
  await registry.store.setSchedule(FIXTURE, 'B', { ...(await registry.store.getSchedule(FIXTURE, 'B')), next_at: new Date(Date.now() - 1000).toISOString() });
  await registry.scheduleTick();

  const d = await detail(registry);
  assert.equal(d.state, 'verified', JSON.stringify(d.history.at(-1)));
  assert.ok(d.probes.some((p) => p.kind === STAGE_B_409 && /^404 with revision/.test(p.detail)), 'excused after the 404, card re-fetched after the reply');
  assert.ok(node.cardFetches > fetches);
  const b = await registry.store.getSchedule(FIXTURE, 'B');
  assert.ok(Date.parse(b.next_at) - Date.now() <= 3_600_000, 'runs again on the new card within the hour');
});

test('scheduler: a node verified before the schedule existed gets Stage B under the new rules in the legacy window', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'onp-legacy-'));
  const dbPath = join(dir, 'registry.db');
  const node = await startFixtureNode();
  let registry = null;
  t.after(async () => {   // the registry first: Windows cannot delete an open database file
    await registry?.close();
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // An older registry admitted the node: verified, references captured with the old public prompts.
  const old = await startRegistry({ allowPrivateTargets: true, dbPath });
  await register(old, node);
  await old.store.setState(FIXTURE, 'verified', 'Stage B passed');
  await old.store.addFingerprints(node.card.offerings[0].model.artifact,
    LEGACY_IDENTITY_PROMPTS.map((p) => ({ prompt: p, expected_hash: sha256(`echo: ${p}`) })));
  await old.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DELETE FROM schedule');                           // older registries had no schedule table rows
  db.close();

  registry = await startRegistry({
    allowPrivateTargets: true, dbPath, stageBCapacity: FAST,
    schedule: { tickMs: 3_600_000, stageBLegacyMs: [0, 0] },
  });
  await registry.scheduleTick();                             // first sight: plans Stage B, does not run it
  assert.equal((await detail(registry)).state, 'verified');
  assert.ok((await registry.store.getSchedule(FIXTURE, 'B')).next_at, 'Stage B planned in the legacy window');
  await sleep(10);
  await registry.scheduleTick();
  const d = await detail(registry);
  assert.equal(d.state, 'community', 'the legacy references prove nothing, so it is no longer verified');
  assert.match(d.history.at(-1).reason, /identity unverified \(no identity reference for this artefact\)/);
});

// ---------------------------------------------------------------- store conformance

async function storeConformance(store) {
  await store.upsertNode('io.x.a', 'https://a.x.io', 'https://a.x.io/c', 'indexed');
  await store.saveRevision('io.x.a', '2026-11-19T00:00:00.000Z', { revision: '2026-11-19T00:00:00.000Z' }, true);
  await store.saveRevision('io.x.a', '2026-11-20T00:00:00.000Z', { revision: '2026-11-20T00:00:00.000Z' }, false);
  const rev = await store.latestRevision('io.x.a');
  assert.equal(rev.revision, '2026-11-20T00:00:00.000Z');
  assert.equal(rev.sig_ok, false);
  assert.equal(await store.latestRevision('io.x.none'), null);

  assert.equal(await store.getSchedule('io.x.a', 'B'), null);
  await store.setSchedule('io.x.a', 'B', { last_at: 't1', next_at: 't2', ok: true, revision: 'r', digest: 'd', failures: 2 });
  const row = await store.getSchedule('io.x.a', 'B');
  assert.deepEqual([row.last_at, row.next_at, row.ok, row.revision, row.digest, row.pending_digest, Number(row.failures)], ['t1', 't2', true, 'r', 'd', null, 2]);
  await store.setSchedule('io.x.a', 'B', { ...row, ok: null, next_at: null });
  assert.equal((await store.getSchedule('io.x.a', 'B')).ok, null);

  assert.deepEqual(await store.vendorNamespaces(), []);
  await store.setVendorNamespaces('acme', ['com.acme', 'io.acme']);
  assert.deepEqual(await store.vendorNamespaces(), [{ vendor: 'acme', namespaces: ['com.acme', 'io.acme'] }]);
  await store.setVendorNamespaces('acme', null);
  assert.deepEqual(await store.vendorNamespaces(), []);

  await store.addFingerprints('hf:a/b', [{ prompt: 'p1', expected_hash: 'h1' }, { prompt: 'p2', expected_hash: 'h2' }]);
  await store.clearFingerprints('hf:a/b');
  assert.deepEqual(await store.getFingerprints('hf:a/b'), []);

  const since = new Date(Date.now() - 60_000).toISOString();
  await store.recordProbe('io.x.a', 'm', 'C', 'blind-409', false, 'x');
  await store.recordProbe('io.x.a', 'm', 'C', 'blind-409', false, 'y');
  await store.recordProbe('io.x.a', 'm', 'C', 'blind', true);
  assert.equal(await store.countProbes('io.x.a', 'blind-409', since), 2);

  // Private Stage C rows (stagec.js): which nodes are owed a follow-up by now, soonest first.
  await store.setSchedule('io.x.b', 'C:follow-up', { next_at: '2026-11-19T10:00:00.000Z', revision: 'r2' });
  await store.setSchedule('io.x.a', 'C:follow-up', { next_at: '2026-11-19T09:00:00.000Z', revision: 'r1' });
  await store.setSchedule('io.x.c', 'C:follow-up', { next_at: null });
  await store.setSchedule('io.x.d', 'C:follow-up', { next_at: '2026-11-19T12:00:00.000Z' });
  assert.deepEqual(await store.dueSchedules('C:follow-up', '2026-11-19T11:00:00.000Z'), ['io.x.a', 'io.x.b']);
  assert.deepEqual(await store.dueSchedules('B', '2026-11-19T11:00:00.000Z'), []);

  // Customer access (ONP-3 §4): recorded, replaced, removed.
  assert.equal(await store.getCustomerKey('io.x.a'), null);
  await store.setCustomerKey('io.x.a', 'ck-1');
  await store.setCustomerKey('io.x.a', 'ck-2');
  assert.equal(await store.getCustomerKey('io.x.a'), 'ck-2');
  await store.setCustomerKey('io.x.a', null);
  assert.equal(await store.getCustomerKey('io.x.a'), null);
  assert.equal(await store.countProbes('io.x.a', 'blind-409', new Date(Date.now() + 60_000).toISOString()), 0);
  await store.close();
}

test('store: schedule, vendor table, latest revision, probe counts (sqlite and postgres)', async () => {
  await storeConformance(await createSqliteStore(':memory:'));
  const { newDb } = await import('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  await storeConformance(await createPgStore({ pool: new Pool() }));
});

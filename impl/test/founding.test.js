// Founding-operator prep: admin marks (institutional, founding), request counts per node and
// ISO week, and the probe load the qualification page documents (ONP-3 §4a, §4b, §6.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { createSqliteStore } from '@opennodes/registry/src/store.js';
import { createPgStore } from '@opennodes/registry/src/store-pg.js';
import { isoWeek, weekStart, recentWeeks, nodeIdsIn, makeRequestCounter } from '@opennodes/registry/src/counts.js';
import { CONTEXT_FRACTIONS, CAPACITY_RAMP, FINGERPRINT_PROMPTS } from '@opennodes/registry/src/stageb.js';
import { LIVENESS_INTERVAL_MS, BLIND_INTERVAL_MS, JITTER } from '@opennodes/registry/src/stagec.js';

const FIXTURE = 'org.opennodes.fixture';
const ACME = 'import.modelsdev.acmecloud';
const CATALOG = { acmecloud: { id: 'acmecloud', name: 'Acme Cloud', api: 'https://api.acmecloud.example/v1',
  models: {
    'acme-small': { id: 'acme-small', name: 'Acme Small', cost: { input: 0.05, output: 0.2 } },
    'acme-large': { id: 'acme-large', name: 'Acme Large', cost: { input: 1, output: 3 } },
  } } };

async function registerAndVerify(registry, node) {
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  return (await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json());
}

const client = (registry, token = null) => ({
  get: async (path) => (await fetch(`${registry.origin}${path}`)).json(),
  post: (path, body, auth = token) => fetch(`${registry.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body ?? {}),
  }),
  tool: async (name, args) => (await (await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result,
});

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onp-founding-'));
  // best-effort: Windows AV/indexers intermittently EPERM fresh temp dirs
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* OS reaps it */ } });
  return dir;
};

test('ISO weeks: Monday starts, year boundaries, and node ids found anywhere in a response', () => {
  assert.equal(isoWeek(new Date('2026-11-09T00:00:00Z')), '2026-W46');   // a Monday
  assert.equal(isoWeek(new Date('2026-11-15T23:59:59Z')), '2026-W46');   // its Sunday
  assert.equal(weekStart('2026-W46'), '2026-11-09');
  assert.equal(isoWeek(new Date('2021-01-03T12:00:00Z')), '2020-W53');
  assert.equal(weekStart('2020-W53'), '2020-12-28');
  assert.equal(isoWeek(new Date('2024-12-30T12:00:00Z')), '2025-W01');
  assert.equal(weekStart('2025-W01'), '2024-12-30');
  assert.deepEqual(recentWeeks(3, new Date('2026-01-05T08:00:00Z')), ['2026-W02', '2026-W01', '2025-W52']);
  assert.deepEqual([...nodeIdsIn({
    recommendations: [{ node_id: 'a' }, { node_id: 'b' }],
    scenario: { roles: { cheap: { node_id: 'c' }, strong: { node_id: 'a' } } },
    providers: [{ node_ids: ['d', 'b'] }],
  })].sort(), ['a', 'b', 'c', 'd']);
});

test('request counter: one count per node per response, kept in memory until a write succeeds', async () => {
  const written = [];
  let failNext = true;
  const store = {
    async addRequestCounts(rows) { if (failNext) { failNext = false; throw new Error('db down'); } written.push(...rows); },
    async requestCounts() { return written; },
  };
  const counter = makeRequestCounter(store, { flushMs: 0, clock: () => new Date('2026-11-10T10:00:00Z') });
  counter.count('search', ['x', 'x', 'y']);
  counter.count('search', ['x']);
  await counter.flush();                        // fails: nothing lost
  assert.equal(written.length, 0);
  counter.count('mcp', ['y']);
  await counter.flush();
  const n = (node, surface) => written.filter((r) => r.node_id === node && r.surface === surface).reduce((s, r) => s + r.n, 0);
  assert.equal(n('x', 'search'), 2, 'x appeared in two responses (twice in the first counts once)');
  assert.equal(n('y', 'search'), 1);
  assert.equal(n('*', 'search'), 2, 'two search responses');
  assert.equal(n('y', 'mcp'), 1);
  assert.ok(written.every((r) => r.week === '2026-W46'));
  assert.throws(() => counter.count('estimate', ['x']), /unknown surface/);
  await counter.stop();
});

test('admin marks: institutional and founding are set and cleared by admin, shown everywhere, never ranked', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true, adminToken: 'adm1n' });
  t.after(async () => { await node.close(); await registry.close(); });
  const api = client(registry, 'adm1n');
  await api.post('/v0/import/models-dev', { catalog: CATALOG });
  await registerAndVerify(registry, node);
  const mine = async () => (await api.get('/v0/offerings')).offerings.find((o) => o.node_id === FIXTURE);
  const before = await mine();
  const detailBefore = await api.get(`/v0/nodes/${FIXTURE}`);
  assert.equal(before.founding, false);
  assert.equal(before.institutional, false);
  assert.equal(detailBefore.founding, false);

  // admin-only, known nodes, boolean bodies
  assert.equal((await api.post(`/v0/admin/nodes/${FIXTURE}/founding`, { founding: true }, null)).status, 401);
  assert.equal((await api.post(`/v0/admin/nodes/${FIXTURE}/founding`, { founding: true }, 'wrong')).status, 401);
  assert.equal((await api.post('/v0/admin/nodes/nope.none/founding', { founding: true })).status, 404);
  const bad = await api.post(`/v0/admin/nodes/${FIXTURE}/founding`, { founding: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).title, 'bad-flag');
  assert.equal((await api.post(`/v0/admin/nodes/${FIXTURE}/institutional`, { founding: true })).status, 400, 'key must name the flag');

  assert.deepEqual(await (await api.post(`/v0/admin/nodes/${FIXTURE}/founding`, { founding: true })).json(),
    { id: FIXTURE, institutional: false, founding: true });
  assert.deepEqual(await (await api.post(`/v0/admin/nodes/${FIXTURE}/institutional`, { institutional: true })).json(),
    { id: FIXTURE, institutional: true, founding: true });

  // directory, node detail, search (the cached catalog is refreshed), MCP
  const listed = (await api.get('/v0/nodes')).nodes.find((n) => n.id === FIXTURE);
  assert.equal(listed.founding, true);
  assert.equal(listed.institutional, true);
  const detail = await api.get(`/v0/nodes/${FIXTURE}`);
  assert.equal(detail.founding, true);
  assert.equal(detail.institutional, true);
  const after = await mine();
  assert.equal(after.founding, true);
  assert.equal(after.institutional, true);
  assert.equal(after.rank, before.rank, 'marks are labels, not rank inputs');
  assert.deepEqual(after.rank_explanation, before.rank_explanation);
  assert.equal((await api.tool('get_node', { node_id: FIXTURE })).structuredContent.founding, true);
  assert.equal((await api.tool('get_node', { node_id: FIXTURE })).structuredContent.institutional, true);
  const viaMcp = (await api.tool('search_offerings', { q: 'echo' })).structuredContent.offerings;
  assert.ok(viaMcp.length > 0 && viaMcp.every((o) => o.node_id === FIXTURE && o.founding && o.institutional));

  // not a state change: no listing-history entry, updated_at kept
  assert.equal(detail.history.length, detailBefore.history.length);
  assert.equal(detail.updated_at, detailBefore.updated_at);

  // survives re-registration
  await registerAndVerify(registry, node);
  assert.equal((await api.get(`/v0/nodes/${FIXTURE}`)).founding, true);

  // clearing
  assert.deepEqual(await (await api.post(`/v0/admin/nodes/${FIXTURE}/founding`, { founding: false })).json(),
    { id: FIXTURE, institutional: true, founding: false });
  assert.equal((await mine()).founding, false);

  // an unclaimed import has no proven operator: setting is refused, clearing is allowed
  const imported = await api.post(`/v0/admin/nodes/${ACME}/founding`, { founding: true });
  assert.equal(imported.status, 409);
  assert.equal((await imported.json()).title, 'imported-listing');
  assert.equal((await api.post(`/v0/admin/nodes/${ACME}/institutional`, { institutional: true })).status, 409);
  assert.equal((await api.post(`/v0/admin/nodes/${ACME}/institutional`, { institutional: false })).status, 200);
});

test('request counts: search, recommend and MCP count each node once per response; queries are never stored', async (t) => {
  const dbPath = join(tempDir(t), 'registry.db');
  const node = await startFixtureNode();
  t.after(() => node.close());
  let registry = await startRegistry({ dbPath, allowPrivateTargets: true });
  let open = true;
  t.after(async () => { if (open) await registry.close(); });
  let api = client(registry);
  await api.post('/v0/import/models-dev', { catalog: CATALOG });   // loopback admin
  await registerAndVerify(registry, node);
  const SECRET = 'zebra-quokka-7731';

  // search: two responses; Acme returns two offerings in the first but counts once
  const all = await api.get('/v0/offerings');
  assert.equal(all.offerings.filter((o) => o.node_id === ACME).length, 2);
  assert.equal((await api.get(`/v0/offerings?q=${SECRET}`)).offerings.length, 0);

  // recommend: whichever nodes the advice names
  const advice = await (await api.post('/v0/recommend', { task: `Summarise the ${SECRET} report in three bullet points` })).json();
  const advised = nodeIdsIn(advice);
  assert.ok(advised.size > 0);

  // MCP: successful tool calls only
  assert.equal((await api.tool('get_node', { node_id: FIXTURE })).isError, false);
  assert.equal((await api.tool('estimate', { steps: [{ offering: `${FIXTURE}/echo-1`, est_input_tokens: 100, est_output_tokens: 50 }] })).isError, false);
  assert.equal((await api.tool('get_node', { node_id: 'nope.none' })).isError, true);

  const week = isoWeek();
  const counts = (await api.get(`/v0/nodes/${FIXTURE}`)).request_counts;
  assert.equal(counts.length, 12, '12 weeks, newest first, empty ones included');
  assert.deepEqual(counts[0], {
    week, starts: weekStart(week), search: 1, recommend: advised.has(FIXTURE) ? 1 : 0, mcp: 2,
    total: 3 + (advised.has(FIXTURE) ? 1 : 0),
  });
  assert.ok(counts.slice(1).every((w) => w.total === 0));
  assert.deepEqual((await api.get(`/v0/nodes/${FIXTURE}`)).request_counts[0], counts[0], 'node detail is not a counted surface');

  const stats = await api.get('/v0/stats/requests');
  assert.equal(stats.weeks.length, 4);
  assert.equal(stats.weeks[0].week, week);
  assert.deepEqual(stats.weeks[0].responses, { search: 2, recommend: 1, mcp: 2 });
  const acme = stats.weeks[0].nodes.find((n) => n.node_id === ACME);
  assert.equal(acme.search, 1);
  assert.equal(acme.recommend, advised.has(ACME) ? 1 : 0);
  assert.ok(stats.weeks[0].nodes.every((n, i, list) => i === 0 || list[i - 1].total >= n.total), 'most returned first');
  assert.ok(stats.weeks[0].nodes.every((n) => n.node_id !== '*'));
  assert.deepEqual((await api.get(`/v0/stats/requests?node_id=${ACME}`)).weeks[0].nodes.map((n) => n.node_id), [ACME]);
  assert.equal((await api.get('/v0/stats/requests?weeks=500')).weeks.length, 52);
  assert.equal((await api.get('/v0/stats/requests?limit=1')).weeks[0].nodes.length, 1);

  // counts survive a restart; nothing of the query or task reached the database
  await registry.close();
  open = false;
  assert.ok(!readFileSync(dbPath).includes(SECRET), 'query and task text never stored');
  registry = await startRegistry({ dbPath, allowPrivateTargets: true });
  open = true;
  api = client(registry);
  assert.deepEqual((await api.get(`/v0/nodes/${FIXTURE}`)).request_counts[0], counts[0]);
});

test('probe load: Stage A sends one chat call per chat offering; Stage B 3 + 1 + 3 + (1 + 4 + 8) per chat offering', async (t) => {
  const node = await startFixtureNode();             // one chat offering
  const registry = await startRegistry({ allowPrivateTargets: true });   // default capacity ramp
  t.after(async () => { await node.close(); await registry.close(); });
  const api = client(registry);
  const ramp = CAPACITY_RAMP.steps.reduce((a, b) => a + b, 0);

  await registerAndVerify(registry, node);
  assert.equal(node.requestCount, 1, 'Stage A at verification: one blind invocation');
  await fetch(`${registry.origin}/v0/nodes/${FIXTURE}/ping`, { method: 'PUT' });
  assert.equal(node.requestCount, 2, 'each ping runs Stage A again');

  let before = node.requestCount;
  assert.equal((await api.post(`/v0/nodes/${FIXTURE}/admit`)).status, 200);
  assert.equal(node.requestCount - before, 1 + CONTEXT_FRACTIONS.length + ramp, 'no reference fingerprints: battery skipped');

  await api.post('/v0/fingerprints/capture', { node_id: FIXTURE, offering_id: 'echo-1' });
  before = node.requestCount;
  assert.equal((await api.post(`/v0/nodes/${FIXTURE}/admit`)).status, 200);
  assert.equal(node.requestCount - before, FINGERPRINT_PROMPTS.length + 1 + CONTEXT_FRACTIONS.length + ramp);
  assert.equal(FINGERPRINT_PROMPTS.length + 1 + CONTEXT_FRACTIONS.length + ramp, 20);
});

test('the qualification page states the probe load the code uses', () => {
  const html = readFileSync(new URL('../packages/registry/src/web/index.html', import.meta.url), 'utf8');
  const section = html.slice(html.indexOf('id="probe-load"'), html.indexOf('<h2>Principles</h2>'));
  assert.ok(section.length > 500, 'probe load section present');
  const has = (text) => assert.ok(section.includes(text), `qualification page should say: ${text}`);
  const pct = CONTEXT_FRACTIONS.map((f) => Math.round(f * 100));
  const { steps, durationMs } = CAPACITY_RAMP;
  const ramp = steps.reduce((a, b) => a + b, 0);
  has(`${pct[0]}, ${pct[1]} and ${pct[2]}% of the claimed context window`);
  has(`about ${Math.round(CONTEXT_FRACTIONS.reduce((a, b) => a + b, 0) * 100) / 100} times the window`);
  has(`${steps[0]}, ${steps[1]} and ${steps[2]} parallel requests (${ramp} calls`);
  has(`${durationMs / 1000}-second budget`);
  has(`${FINGERPRINT_PROMPTS.length} fixed prompts`);
  has(`up to ${FINGERPRINT_PROMPTS.length + 1 + CONTEXT_FRACTIONS.length + ramp} chat completions`);
  const live = LIVENESS_INTERVAL_MS / 60_000;
  has(`every ${live}&nbsp;minutes on average (each gap is random, ${live * JITTER[0]} to ${live * JITTER[1]}&nbsp;minutes)`);
  assert.equal(BLIND_INTERVAL_MS, 3_600_000);
  has(`per hour on average (${60 * JITTER[0]} to ${60 * JITTER[1]}&nbsp;minutes apart`);
  has(`about ${(24 * 60) / live} health checks and ${(24 * 3_600_000) / BLIND_INTERVAL_MS} chat calls a day`);
  assert.doesNotMatch(html, /Re-run every 6/, 'Stage A has no timed re-run');
});

test('a database from before the founding mark gains the column (sqlite and postgres)', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const OLD_NODES = `CREATE TABLE nodes (id TEXT PRIMARY KEY, origin TEXT NOT NULL, card_url TEXT NOT NULL,
    state TEXT NOT NULL, institutional INTEGER DEFAULT 0, source TEXT NOT NULL DEFAULT 'registration',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  const INSERT = `INSERT INTO nodes (id, origin, card_url, state, institutional, source, created_at, updated_at)
    VALUES ('org.x.old', 'http://o', 'http://o/card', 'community', 1, 'registration', 't', 't')`;

  const path = join(tempDir(t), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(OLD_NODES);
  old.exec(INSERT);
  old.close();
  const sqlite = await createSqliteStore(path);
  assert.equal((await sqlite.getNode('org.x.old')).founding, 0);
  await sqlite.setNodeFlag('org.x.old', 'founding', true);
  assert.equal((await sqlite.getNode('org.x.old')).founding, 1);
  assert.equal((await sqlite.getNode('org.x.old')).institutional, 1);
  await sqlite.close();

  const { newDb } = await import('pg-mem');
  // pg-mem refuses CREATE TABLE IF NOT EXISTS on an existing table unless its AST-coverage check is off;
  // real Postgres skips the statement with a notice
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  const pool = new Pool();
  await pool.query(OLD_NODES);
  await pool.query(INSERT);
  const pg = await createPgStore({ pool });
  // a full scan: pg-mem's primary-key index keeps pre-ALTER row copies until the row is written
  assert.equal((await pg.allNodes())[0].founding, 0);
  await pg.setNodeFlag('org.x.old', 'founding', true);
  assert.equal((await pg.getNode('org.x.old')).founding, 1);
  await pg.close();
});

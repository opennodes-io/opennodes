// The Ollama router's access and LAN-trust rules (Two Minds review, 18 Nov 2026, section 4.11):
// no wildcard CORS; a token for the router API and for other machines; a strict Host and Origin check
// for local apps; mDNS off by default; a LAN peer is the user's own network only when pinned by card
// key; a TXT origin only for the advertising host; a missing data policy is unknown; --public-bind
// only with a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createApp, listen, closeApp, sendJson, readJson, signCard, validateCard, generateKeypair, jwkThumbprint,
  recommend, extractFeatures, trustGaps, onOwnNetwork, inRegion,
} from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startOllamaRouter } from '@opennodes/ollama-router';
import { mdnsOrigins, isLanAddress } from '@opennodes/ollama-router/src/discovery.js';
import { accessPolicy } from '@opennodes/ollama-router/src/access.js';

const FIXTURE = 'org.opennodes.fixture';
const quiet = () => {};

/** Raw HTTP, so a test can send Host, Origin and Sec-Fetch-Site the way a browser or an attacker would. */
function raw(origin, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  const u = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method, path: u.pathname, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const auth = (router) => ({ authorization: `Bearer ${router.token}` });

async function fakeOllama(t, models = ['tiny:latest']) {
  const app = createApp([
    ['GET', '/api/tags', (req, res) => sendJson(res, 200, { models: models.map((name) => ({ name, model: name, details: { family: 'tiny', parameter_size: name.includes('70b') ? '70B' : '1.0B' } })) })],
    ['POST', '/api/show', (req, res) => sendJson(res, 200, { details: { family: 'tiny' }, model_info: {}, capabilities: ['completion'] })],
    ['POST', '/api/chat', async (req, res) => { const b = await readJson(req); sendJson(res, 200, { model: b.model, message: { role: 'assistant', content: `ollama(${b.model})` }, done: true, prompt_eval_count: 1, eval_count: 1 }); }],
  ]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  return `http://127.0.0.1:${port}`;
}

async function start(t, opts) {
  const router = await startOllamaRouter({ port: 0, log: quiet, ...opts });
  t.after(() => router.close());
  return router;
}

const chatBody = (model, content = 'hello') => ({ model, messages: [{ role: 'user', content }], stream: false });

/**
 * A Node Kit-like LAN node with a card we control: signed by `keys`, optionally without data_policy,
 * optionally naming another origin as its endpoint. resign(keys) publishes the card under another key.
 */
async function fakeLanNode(t, { dataPolicy = true, endpoint = null } = {}) {
  const template = await startFixtureNode({ lineage: ['FR'] });
  const { signatures: _s, ...base } = template.card;
  await template.close();
  const state = { keys: generateKeypair(), calls: [], card: null };
  const answer = (path) => async (req, res) => {
    const b = await readJson(req);
    state.calls.push(path);
    sendJson(res, 200, { id: 'x', object: 'chat.completion', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: `lan:${b.messages.at(-1).content}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  const app = createApp([
    ['GET', '/.well-known/open-node.json', (req, res) => sendJson(res, 200, state.card)],
    ['GET', '/.well-known/jwks.json', (req, res) => sendJson(res, 200, { keys: [{ ...state.keys.publicJwk, kid: 'onp-1' }] })],
    ['POST', '/v1/chat/completions', answer('/v1')],
    ['POST', '/onp/v1/chat/completions', answer('/onp/v1')],
  ]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  const origin = `http://127.0.0.1:${port}`;
  const unsigned = {
    ...base,
    node: { ...base.node, id: 'org.example.gpubox' },
    endpoints: { ...base.endpoints, openai: endpoint ?? `${origin}/v1` },
    offerings: base.offerings.map(({ data_policy, ...o }) => (dataPolicy ? { ...o, data_policy } : o)),
  };
  assert.deepEqual(validateCard(unsigned), [], 'the test card is a valid card');
  const sign = () => { state.card = signCard(unsigned, state.keys.privateKey); };
  sign();
  return {
    origin, get calls() { return state.calls; }, get keys() { return state.keys; },
    resign: (keys) => { state.keys = keys; sign(); },
  };
}

test('router access: no wildcard CORS; local pages and allowed origins only; DNS rebinding refused', async (t) => {
  const ollama = await fakeOllama(t);
  const router = await start(t, { ollama, allowOrigins: ['chrome-extension://abcdef'] });

  const plain = await raw(router.origin, { path: '/api/tags' });
  assert.equal(plain.status, 200, 'a local app needs no token for the model routes');
  assert.equal(plain.headers['access-control-allow-origin'], undefined, 'no wildcard CORS');

  // another web page: its preflight and its "simple" requests are refused, on every route
  const evil = 'https://evil.example';
  const pre = await raw(router.origin, { method: 'OPTIONS', path: '/router/peers', headers: { origin: evil, 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  for (const [method, path, body] of [['POST', '/api/chat', chatBody('tiny:latest')], ['POST', '/v1/chat/completions', chatBody('tiny:latest')], ['GET', '/api/tags', null]]) {
    const r = await raw(router.origin, { method, path, body, headers: { origin: evil, ...(body ? { 'content-type': 'text/plain' } : {}) } });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.json().error, /origin https:\/\/evil\.example may not use this router/);
  }

  // a local page, a desktop app shell (as Ollama allows) and an origin the user allowed may call the model routes
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://tauri.localhost', 'tauri://localhost', 'app://msty', 'vscode-webview://1a2b', 'chrome-extension://abcdef']) {
    const r = await raw(router.origin, { path: '/api/tags', headers: { origin } });
    assert.equal(r.status, 200, origin);
    assert.equal(r.headers['access-control-allow-origin'], origin);
    const p = await raw(router.origin, { method: 'OPTIONS', path: '/api/chat', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(p.status, 204);
    assert.equal(p.headers['access-control-allow-origin'], origin);
    assert.match(p.headers['access-control-allow-headers'], /onp-sensitive/);
  }

  // a file:// page or a sandboxed iframe on any site sends "null"; an extension needs --allow-origin
  for (const origin of ['null', 'chrome-extension://other', 'http://0.0.0.0:8000', 'http://192.168.1.5:3000']) {
    assert.equal((await raw(router.origin, { path: '/api/tags', headers: { origin } })).status, 403, origin);
  }

  // DNS rebinding: a page whose name now resolves to 127.0.0.1 still sends its own Host
  const rebound = await raw(router.origin, { path: '/api/tags', headers: { host: `attacker.example:${router.port}` } });
  assert.equal(rebound.status, 403);
  assert.match(rebound.json().error, /DNS rebinding/);
  assert.equal((await raw(router.origin, { path: '/api/tags', headers: { host: `localhost:${router.port}` } })).status, 200);
  assert.equal((await raw(router.origin, { path: '/api/tags', headers: { host: 'attacker.example', ...auth(router) } })).status, 200, 'the token is enough on its own');
  assert.equal((await raw(router.origin, { path: '/api/tags', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'a cross-site fetch without an Origin');

  await assert.rejects(startOllamaRouter({ port: 0, ollama, allowOrigins: ['*'], log: quiet }), /any web page/);
  await assert.rejects(startOllamaRouter({ port: 0, ollama, allowOrigins: ['null'], log: quiet }), /any web page/);
});

test('router access: the router API needs the token, so a web page cannot add a peer or read receipts', async (t) => {
  const ollama = await fakeOllama(t);
  const router = await start(t, { ollama });
  for (const path of ['/router/catalog', '/router/receipts', '/router/advice', '/router/reputation']) {
    assert.equal((await raw(router.origin, { path })).status, 401, path);
    assert.equal((await raw(router.origin, { path, headers: { authorization: 'Bearer wrong' } })).status, 401, path);
    assert.equal((await raw(router.origin, { path, headers: { origin: 'http://localhost:3000' } })).status, 401, `${path}: a local page needs it too`);
    assert.equal((await raw(router.origin, { path, headers: auth(router) })).status, 200, path);
  }
  const add = await raw(router.origin, { method: 'POST', path: '/router/peers', body: { origin: 'http://203.0.113.7:11434' } });
  assert.equal(add.status, 401);
  assert.match(add.json().error, /router token/);
  assert.equal(router.peers.length, 0);
  const notUrl = await raw(router.origin, { method: 'POST', path: '/router/peers', headers: auth(router), body: { origin: 'file:///etc/passwd' } });
  assert.equal(notUrl.status, 400);

  const catalog = (await raw(router.origin, { path: '/router/catalog', headers: auth(router) })).json();
  assert.equal(catalog.mdns, false, 'mDNS is off unless asked for');
  assert.deepEqual([catalog.peers, catalog.discovered], [[], []]);
  assert.equal(typeof router.token, 'string');
  assert.ok(router.token.length >= 32);
});

test('router access: other machines need the token; --public-bind refuses to start without one', async () => {
  const policy = accessPolicy({ token: 's3cret-token' });
  const req = (headers, remoteAddress, url = '/api/tags') => ({ headers, url, method: 'GET', socket: { remoteAddress } });
  const res = () => ({ setHeader() {} });
  assert.equal(policy.check(req({ host: '192.168.1.10:11435' }, '192.168.1.50'), res()).status, 401);
  assert.equal(policy.check(req({ host: '127.0.0.1:11435' }, '192.168.1.50'), res()).status, 401, 'a forged loopback Host does not help');
  assert.equal(policy.check(req({ host: '192.168.1.10:11435', authorization: 'Bearer s3cret-token' }, '192.168.1.50'), res()), null);
  assert.equal(policy.check(req({ host: '192.168.1.10:11435', authorization: 'Bearer s3cret-token ' }, '192.168.1.50', '/router/catalog'), res()), null);
  for (const [host, from] of [['127.0.0.1:11435', '127.0.0.1'], ['[::1]:11435', '::1'], ['localhost', '::ffff:127.0.0.1'], ['host.docker.internal:11435', '127.0.0.1'], ['0.0.0.0:11435', '127.0.0.1']]) {
    assert.equal(policy.check(req({ host }, from), res()), null, `${host} from ${from}`);
  }
  assert.equal(policy.check(req({ host: '0.0.0.0:11435', origin: 'http://0.0.0.0:8000' }, '127.0.0.1'), res()).status, 403, 'a page served from 0.0.0.0 is not a local page');

  await assert.rejects(startOllamaRouter({ port: 0, host: '0.0.0.0', log: quiet }), /without a token/);
  const bin = fileURLToPath(new URL('../packages/ollama-router/bin.js', import.meta.url));
  const run = spawnSync(process.execPath, [bin, '--public-bind', '--registry', 'none', '--port', '0'], { env: { ...process.env, ONP_ROUTER_TOKEN: '' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /--public-bind needs a token/);
});

test('mDNS: a TXT origin is used only for the advertising host; answers from outside the LAN are ignored', () => {
  const answer = (txtOrigin, { a = '192.168.1.20' } = {}) => ({
    answers: [{ type: 'PTR', name: '_onp._tcp.local', data: 'box._onp._tcp.local' }],
    additionals: [
      { type: 'SRV', name: 'box._onp._tcp.local', data: { port: 8800, target: 'box.local' } },
      ...(txtOrigin ? [{ type: 'TXT', name: 'box._onp._tcp.local', data: [Buffer.from(`origin=${txtOrigin}`), Buffer.from('onp=0.1')] }] : []),
      { type: 'A', name: 'box.local', data: a },
    ],
  });
  const from = { address: '192.168.1.20' };
  assert.deepEqual(mdnsOrigins(answer('http://192.168.1.20:9000'), from), ['http://192.168.1.20:9000'], 'the advertising host, its own port');
  assert.deepEqual(mdnsOrigins(answer('https://attacker.example'), from), ['http://192.168.1.20:8800'], 'an internet origin is ignored');
  assert.deepEqual(mdnsOrigins(answer('http://192.168.1.99:8800'), from), ['http://192.168.1.20:8800'], 'another machine is ignored');
  assert.deepEqual(mdnsOrigins(answer('file:///etc/passwd'), from), ['http://192.168.1.20:8800']);
  assert.deepEqual(mdnsOrigins(answer('not a url'), from), ['http://192.168.1.20:8800']);
  assert.deepEqual(mdnsOrigins(answer(null, { a: '203.0.113.5' }), from), ['http://192.168.1.20:8800'], 'an A record cannot move it off the sender');
  assert.deepEqual(mdnsOrigins(answer('http://192.168.1.20:8800'), { address: '203.0.113.5' }), [], 'not from the LAN');
  assert.deepEqual(mdnsOrigins(answer('http://[fd00::5]:8800'), { address: 'fd00::5' }), ['http://[fd00::5]:8800']);
  assert.deepEqual(mdnsOrigins(answer(null), { address: '::ffff:10.0.0.7' }), ['http://10.0.0.7:8800']);
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', '127.0.0.1', 'fd12::1', 'fe80::1', '::1']) assert.ok(isLanAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '203.0.113.5', '2001:db8::1', '']) assert.ok(!isLanAddress(a), a);
});

test('advisor: an unpinned LAN peer is not the user\'s network; a pinned one is', () => {
  const peer = (lan, extra = {}) => ({
    node_id: 'org.example.gpubox', offering_id: 'm', tier: 'lan', source: 'lan', lan, modality: 'text',
    model: { name: 'm', params_b: 70, lineage_origins: ['FR'] }, serving: { context_window: 8192, supports: [] },
    pricing: { input_per_mtok: 0, output_per_mtok: 0 }, observed: { probe_success: 1, probes: 0 }, ...extra,
  });
  const unpinned = peer({ pinned: false });
  const pinned = peer({ pinned: true });
  assert.ok(!onOwnNetwork(unpinned) && !onOwnNetwork(peer(undefined)), 'fails closed without the mark');
  assert.ok(onOwnNetwork(pinned));
  assert.ok(!inRegion(unpinned, 'eu') && inRegion(pinned, 'eu'));
  const plain = extractFeatures('hello there');
  const r = (o, policy) => recommend([o], plain, policy);
  assert.equal(r(unpinned, { jurisdiction: 'eea' }).rejected.jurisdiction, 1);
  assert.equal(r(pinned, { jurisdiction: 'eea' }).eligible, 1);
  assert.equal(r(unpinned, { sensitive: true }).rejected.trust, 1);
  assert.equal(r(pinned, { sensitive: true }).eligible, 1);
  assert.equal(r(unpinned, { min_tier: 'community' }).rejected.tier, 1, 'ranks as unverified');
  assert.equal(r(unpinned, {}).recommendations[0].components.trust, 0.3);
  assert.equal(r(pinned, {}).recommendations[0].components.trust, 1);
  // a prompt the advisor reads as personal: a missing data policy is unknown, so the unpinned peer is out
  const personal = extractFeatures('Write to jane.doe@example.org about her salary');
  assert.equal(recommend([unpinned], personal, {}).rejected.data_policy, 1);
  assert.equal(recommend([pinned], personal, {}).eligible, 1, 'on the user\'s own network the data never leaves it');
  assert.ok(trustGaps(unpinned).includes('no data_policy'));
});

test('LAN peers: only a peer pinned by card key is your own network; added peers work by name; discovered ones wait for a pin', async (t) => {
  const ollama = await fakeOllama(t);
  const box = await fakeOllama(t, ['big:70b']);   // a plain Ollama server on the LAN: no card, no key
  const node = await startFixtureNode({ lineage: ['FR'] });
  t.after(() => node.close());
  const key = jwkThumbprint(node.keys.publicJwk);
  const lanModel = 'lan/fixture/echo-1';
  const hard = 'Prove step by step that the algorithm terminates.';
  const chat = (router, model, headers = {}, content = hard) => raw(router.origin, { method: 'POST', path: '/api/chat', headers, body: chatBody(model, content) });
  const advised = async (router, model) => {
    await chat(router, model);
    return (await raw(router.origin, { path: '/router/advice', headers: auth(router) })).json().recommendations.map((r) => r.offering);
  };

  // added by address, not pinned: usable by name, never for auto-private, auto-eu or sensitive
  const added = await start(t, { ollama, peers: [node.origin, box] });
  assert.deepEqual(added.peers.map((p) => [p.kind, p.source, p.pinned, p.key]), [['onp', 'added', false, key], ['ollama', 'added', false, null]]);
  assert.equal((await chat(added, lanModel)).status, 200, 'a peer you added works when you name it');
  assert.equal((await chat(added, 'big:70b')).status, 200, 'and a bare name falls through to it');
  const refused = await chat(added, lanModel, { 'onp-sensitive': '1' });
  assert.equal(refused.status, 403);
  assert.match(refused.json().error, /LAN peer not pinned by its card key/);
  for (const model of ['auto-private', 'auto-eu']) {
    assert.deepEqual(await advised(added, model), ['local/tiny:latest'], `${model} leaves unpinned peers out`);
  }
  const catalog = (await raw(added.origin, { path: '/router/catalog', headers: auth(added) })).json();
  assert.deepEqual(catalog.models.filter((m) => m.tier === 'lan').map((m) => [m.name, m.pinned, m.pool]), [[lanModel, false, 'open'], ['lan/127-0-0-1/big:70b', false, 'open']]);

  // pinned by card key: your own network, for auto-private, auto-eu and (with a declared lineage) sensitive requests
  const pinned = await start(t, { ollama, peers: [node.origin], pins: [`sha256:${key}`] });
  assert.equal(pinned.peers[0].pinned, true);
  assert.equal((await chat(pinned, lanModel, { 'onp-sensitive': '1' })).status, 200);
  assert.ok((await advised(pinned, 'auto-private')).includes(`${FIXTURE}/echo-1`));
  assert.ok((await advised(pinned, 'auto-eu')).includes(`${FIXTURE}/echo-1`));

  // found by mDNS: listed with its key, never used until the key is pinned
  const browsing = await start(t, { ollama });
  assert.equal(await browsing.addPeer(node.origin, { source: 'mdns' }), null);
  assert.deepEqual(browsing.discovered.map((d) => [d.origin, d.node_id, d.key]), [[node.origin, FIXTURE, key]]);
  assert.equal(browsing.peers.length, 0);
  assert.equal((await chat(browsing, lanModel)).status, 404);
  const wrong = await raw(browsing.origin, { method: 'POST', path: '/router/peers', headers: auth(browsing), body: { origin: node.origin, pin: 'A'.repeat(43) } });
  assert.equal(wrong.status, 422);
  assert.match(wrong.json().error, /not signed by key/);
  assert.equal(browsing.peers.length, 0);
  const right = await raw(browsing.origin, { method: 'POST', path: '/router/peers', headers: auth(browsing), body: { origin: node.origin, pin: key } });
  assert.equal(right.status, 200);
  assert.deepEqual([right.json().pinned, right.json().source, right.json().key], [true, 'added', key]);
  assert.equal(browsing.discovered.length, 0);
  const preset = await start(t, { ollama, pins: [key] });
  assert.equal((await preset.addPeer(node.origin, { source: 'mdns' })).pinned, true, 'a discovered node whose key is pinned is used');
});

const lanChat = (router, model, headers = {}) => raw(router.origin, { method: 'POST', path: '/v1/chat/completions', headers, body: { model, messages: [{ role: 'user', content: 'hi' }] } });

test('LAN peers: a missing data policy stays unknown; a re-signed card loses its pin at once', async (t) => {
  const ollama = await fakeOllama(t);
  const lan = await fakeLanNode(t, { dataPolicy: false });
  const router = await start(t, { ollama, peers: [lan.origin], pins: [jwkThumbprint(lan.keys.publicJwk)], localTtlMs: 0 });
  const model = 'lan/gpubox/echo-1';
  assert.equal(router.peers[0].pinned, true);
  const ok = await lanChat(router, model, { 'onp-sensitive': '1' });
  assert.equal(ok.status, 200, 'pinned, lineage declared: trusted, data policy or not');
  assert.equal(ok.json().choices[0].message.content, 'lan:hi');

  lan.resign(generateKeypair());   // someone else now answers at that address
  const after = await lanChat(router, model, { 'onp-sensitive': '1' });
  assert.equal(after.status, 403);
  assert.match(after.json().error, /LAN peer not pinned by its card key; operator country unknown, outside EU,CA; no data_policy/);
  assert.equal(router.peers[0].pinned, false);
  assert.equal(lan.calls.length, 1, 'nothing was sent');
  assert.equal((await lanChat(router, model)).status, 200, 'still a peer you added: usable by name');
});

test('LAN peers: a card that names another origin is never pinned, and the peer is called where you reached it', async (t) => {
  const ollama = await fakeOllama(t);
  const lan = await fakeLanNode(t, { endpoint: 'http://203.0.113.9/onp/v1' });   // the card names an internet host
  const key = jwkThumbprint(lan.keys.publicJwk);
  const router = await start(t, { ollama, peers: [lan.origin], pins: [key] });
  assert.equal(router.peers[0].pinned, false, 'signed by a pinned key, but served away from the origin it names');
  const refused = await lanChat(router, 'lan/gpubox/echo-1', { 'onp-sensitive': '1' });
  assert.equal(refused.status, 403);
  assert.equal((await lanChat(router, 'lan/gpubox/echo-1')).status, 200, 'usable by name');
  assert.deepEqual(lan.calls, ['/onp/v1'], 'at the origin the router reached, with the card\'s path; never at the host the card names');
  const pinNow = await raw(router.origin, { method: 'POST', path: '/router/peers', headers: auth(router), body: { origin: lan.origin, pin: key } });
  assert.equal(pinNow.status, 422);
  assert.match(pinNow.json().error, /names http:\/\/203\.0\.113\.9\/onp\/v1/);
});

test('onp-ollama --show-pin prints the key that signs a node\'s card', async (t) => {
  const node = await startFixtureNode();
  t.after(() => node.close());
  const bin = fileURLToPath(new URL('../packages/ollama-router/bin.js', import.meta.url));
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const shown = await run(['--show-pin', node.origin]);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, new RegExp(`card key: ${jwkThumbprint(node.keys.publicJwk)}`));
  const none = await run(['--show-pin', 'http://127.0.0.1:9']);
  assert.equal(none.code, 1);
  assert.match(none.err, /no ONP node card/);
});

test('LAN peers: a pinned card copied to another address and advertised by mDNS is not pinned', async (t) => {
  const ollama = await fakeOllama(t);
  const node = await startFixtureNode({ lineage: ['FR'] });
  t.after(() => node.close());
  const key = jwkThumbprint(node.keys.publicJwk);
  // A rogue device replays the real node's signed card and JWKS from its own address.
  const app = createApp([
    ['GET', '/.well-known/open-node.json', (req, res) => sendJson(res, 200, node.card)],
    ['GET', '/.well-known/jwks.json', (req, res) => sendJson(res, 200, { keys: [{ ...node.keys.publicJwk, kid: 'onp-1' }] })],
  ]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  const rogue = `http://127.0.0.1:${port}`;
  const lines = [];
  const router = await start(t, { ollama, pins: [key], log: (l) => lines.push(l) });
  assert.equal(await router.addPeer(rogue, { source: 'mdns' }), null);
  assert.equal(router.peers.length, 0);
  assert.deepEqual(router.discovered.map((d) => [d.origin, d.key, d.card_endpoint, d.at_card_origin]), [[rogue, key, `${node.origin}/v1`, false]]);
  assert.ok(lines.some((l) => /a copied card\?/.test(l)), lines.join('\n'));
  // pinning the rogue by hand, with the key it shows, is refused too
  const pinRogue = await raw(router.origin, { method: 'POST', path: '/router/peers', headers: auth(router), body: { origin: rogue, pin: key } });
  assert.equal(pinRogue.status, 422);
  assert.match(pinRogue.json().error, /a copied card/);
  const added = await router.addPeer(rogue);
  assert.equal(added.pinned, false, 'added by address with the key pinned: still not pinned');
  assert.equal((await lanChat(router, 'lan/fixture/echo-1', { 'onp-sensitive': '1' })).status, 403);
  assert.equal((await router.addPeer(node.origin, { source: 'mdns' })).pinned, true, 'the real node, at the origin its card names, is pinned');
});

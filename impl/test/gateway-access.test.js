// Who may call the gateway (expert review, 18 Nov 2026, section 4.11; ONP-3 §5b): its own API (/gateway/*)
// always needs a token; on loopback without --token the model routes need a Host that is a local name
// (refuses DNS rebinding) and a local or allowed browser Origin; every POST must be application/json;
// provider keys in the environment are used only with --env-keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localAccess, bearerCheck, isJsonContentType, isLoopbackBind } from '@opennodes/core';
import { startGateway, envKeyNames } from '@opennodes/cli/src/gateway.js';

// Nothing in these tests reaches the registry: the routes used do not search it.
const NO_REGISTRY = 'http://127.0.0.1:9';

/** Raw HTTP, so a test can send Host, Origin and Sec-Fetch-Site the way a browser or an attacker would. */
function raw(origin, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  const u = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method, path: u.pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}
const JSON_CT = { 'content-type': 'application/json' };
/**
 * A model-route request that passed every access check gets the route's own 400 (embeddings without model
 * and input), before anything is routed; a refused one gets 401, 403 or 415.
 */
const probe = (gw, headers = {}) => raw(gw.origin, { method: 'POST', path: '/v1/embeddings', headers: { ...JSON_CT, ...headers }, body: '{}' });
const bearer = (gw) => ({ authorization: `Bearer ${gw.apiToken}` });

async function gateway(t, opts = {}) {
  const gw = await startGateway({ port: 0, registry: NO_REGISTRY, env: {}, checksPath: null, ollama: null, ...opts });
  t.after(() => gw.close());
  return gw;
}

test('the gateway API (/gateway/*) needs a token even without --token; the model routes do not', async (t) => {
  const gw = await gateway(t);
  assert.ok(gw.apiToken && gw.apiToken.length >= 24, 'a random API token per run when none is given');
  for (const path of ['/gateway/receipts', '/gateway/advice', '/gateway/reputation']) {
    const r = await raw(gw.origin, { path });
    assert.equal(r.status, 401, `${path}: this machine needs it too`);
    assert.match(r.json().detail, /gateway token/);
    assert.equal((await raw(gw.origin, { path, headers: { origin: 'http://localhost:5173' } })).status, 401, `${path}: so does a local page`);
    assert.equal((await raw(gw.origin, { path, headers: bearer(gw) })).status, 200, path);
  }
  assert.equal((await raw(gw.origin, { path: '/gateway/receipts', headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await probe(gw)).status, 400, 'model routes: this machine without a token');

  const chosen = await gateway(t, { apiToken: 'kept-token' });
  assert.equal(chosen.apiToken, 'kept-token');
  assert.equal((await raw(chosen.origin, { path: '/gateway/receipts', headers: { authorization: 'Bearer kept-token' } })).status, 200);
  // the API token is enough on its own, as the router's is: a token holder may use any Host
  assert.equal((await probe(chosen, { authorization: 'Bearer kept-token', host: 'gateway.lan' })).status, 400);
});

test('DNS rebinding: a model request whose Host is not a local name is refused; local names and --allow-host pass', async (t) => {
  const gw = await gateway(t, { allowHosts: ['proxy.internal'] });
  // the rebinding page's name now resolves to 127.0.0.1, but the browser still sends its own Host
  const rebound = await probe(gw, { host: `attacker.example:${gw.port}` });
  assert.equal(rebound.status, 403);
  assert.match(rebound.json().type, /host-not-allowed$/);
  assert.match(rebound.json().detail, /DNS rebinding/);
  const post = await raw(gw.origin, { method: 'POST', path: '/v1/chat/completions', headers: { host: 'attacker.example', ...JSON_CT }, body: '{"model":"onp/auto","messages":[]}' });
  assert.equal(post.status, 403, 'nothing is routed, so no key is spent');
  assert.equal((await raw(gw.origin, { path: '/v1/models', headers: { host: 'attacker.example' } })).status, 403, 'GET too');

  for (const host of [`127.0.0.1:${gw.port}`, `localhost:${gw.port}`, `app.localhost:${gw.port}`, `[::1]:${gw.port}`, `host.docker.internal:${gw.port}`, 'proxy.internal']) {
    assert.equal((await probe(gw, { host })).status, 400, host);
  }
});

test('browser origins: other web pages are refused and get no CORS headers; localhost, app shells and --allow-origin pass', async (t) => {
  const gw = await gateway(t, { allowOrigins: ['https://app.example:3000'] });
  for (const origin of ['https://evil.example', 'null', 'http://0.0.0.0:8000', 'chrome-extension://abcdef', 'http://127.0.0.1.evil.example']) {
    const r = await probe(gw, { origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.headers['access-control-allow-origin'], undefined, `${origin}: no CORS headers`);
  }
  // the attack in the review: a cross-site "simple" POST (text/plain, no preflight) to spend the user's keys
  const simple = await raw(gw.origin, { method: 'POST', path: '/v1/chat/completions', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{"model":"onp/auto","messages":[]}' });
  assert.equal(simple.status, 403);
  // a no-cors browser request carries no Origin, but Sec-Fetch-Site says where it came from
  assert.equal((await probe(gw, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await probe(gw, { 'sec-fetch-site': 'same-origin' })).status, 400);

  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://tauri.localhost', 'tauri://localhost', 'app://surge', 'vscode-webview://1a2b', 'https://app.example:3000']) {
    const r = await probe(gw, { origin });
    assert.equal(r.status, 400, origin);
    assert.equal(r.headers['access-control-allow-origin'], origin, `${origin}: may read the reply`);
    assert.equal(r.headers.vary, 'origin');
  }
  await assert.rejects(startGateway({ port: 0, registry: NO_REGISTRY, env: {}, allowOrigins: ['*'] }), /any web page/);
  await assert.rejects(startGateway({ port: 0, registry: NO_REGISTRY, env: {}, allowOrigins: ['null'] }), /any web page/);
});

test('CORS preflight: refused for other pages; an allowed page may send the headers it asks for', async (t) => {
  const gw = await gateway(t);
  const evil = await raw(gw.origin, { method: 'OPTIONS', path: '/v1/chat/completions', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const ok = await raw(gw.origin, { method: 'OPTIONS', path: '/v1/chat/completions', headers: {
    origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, x-stainless-os',
  } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.match(ok.headers['access-control-allow-methods'], /POST/);
  assert.equal(ok.headers['access-control-allow-headers'], 'authorization, content-type, x-stainless-os');
});

test('POST needs content-type application/json (parameters and any case allowed)', async (t) => {
  const gw = await gateway(t);
  for (const ct of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
    const r = await raw(gw.origin, { method: 'POST', path: '/v1/embeddings', headers: ct ? { 'content-type': ct } : {}, body: '{}' });
    assert.equal(r.status, 415, String(ct));
    assert.match(r.json().type, /unsupported-media-type$/);
  }
  // accepted: the route itself answers (embeddings without model and input is its own 400)
  for (const ct of ['application/json', 'Application/JSON; charset=utf-8']) {
    const r = await raw(gw.origin, { method: 'POST', path: '/v1/embeddings', headers: { 'content-type': ct }, body: '{}' });
    assert.equal(r.status, 400, ct);
    assert.match(r.json().detail, /model.*input/);
  }
});

test('with --token the token decides (constant-time check), and POST still needs JSON', async (t) => {
  const gw = await gateway(t, { token: 's3cret', apiToken: 'ignored' });
  assert.equal(gw.apiToken, 's3cret', '--token is also the gateway API token');
  assert.equal((await raw(gw.origin, { path: '/gateway/receipts' })).status, 401);
  assert.equal((await raw(gw.origin, { path: '/gateway/receipts', headers: { authorization: 'Bearer s3cre' } })).status, 401);
  assert.equal((await raw(gw.origin, { path: '/gateway/receipts', headers: { authorization: 'Bearer ignored' } })).status, 401);
  assert.equal((await raw(gw.origin, { path: '/gateway/receipts', headers: { authorization: 'Bearer s3cret' } })).status, 200);
  assert.equal((await probe(gw)).status, 401, 'model routes need it too');
  assert.equal((await probe(gw, { authorization: 'Bearer s3cret', host: 'gateway.lan' })).status, 400, 'a token holder may use any Host');
  const plain = await raw(gw.origin, { method: 'POST', path: '/v1/embeddings', headers: { authorization: 'Bearer s3cret', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);
  await assert.rejects(startGateway({ port: 0, host: '0.0.0.0', registry: NO_REGISTRY, env: {} }), /without --token/);
});

test('provider keys in the environment are used only when the user opts in (envKeys / --env-keys)', async (t) => {
  const env = { OPENROUTER_API_KEY: 'sk-or-test', HF_TOKEN: 'hf_test', UNRELATED: 'x' };
  assert.deepEqual(envKeyNames(env).sort(), ['HF_TOKEN', 'OPENROUTER_API_KEY']);
  const off = await gateway(t, { env });
  assert.deepEqual(off.keyHosts, [], 'not used by default');
  assert.deepEqual(off.envKeysIgnored.sort(), ['HF_TOKEN', 'OPENROUTER_API_KEY'], 'names only, so the CLI can say what it left out');
  const on = await gateway(t, { env, envKeys: true });
  assert.deepEqual(on.keyHosts.sort(), ['openrouter.ai', 'router.huggingface.co']);
  assert.deepEqual(on.envKeysIgnored, []);
  const explicit = await gateway(t, { env, keys: { 'api.mistral.ai': 'k' } });
  assert.deepEqual(explicit.keyHosts, ['api.mistral.ai'], '--key works without --env-keys');
});

test('onp gateway CLI: keeps its API token in ~/.opennodes/gateway-token; says which environment keys it ignored', async (t) => {
  const bin = fileURLToPath(new URL('../packages/cli/bin.js', import.meta.url));
  const home = mkdtempSync(join(tmpdir(), 'onp-gw-home-'));   // never the real home directory
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ONP_REGISTRY: NO_REGISTRY, HOME: home, USERPROFILE: home };
  for (const name of [...envKeyNames(process.env), 'ONP_MASK_PII', 'ONP_PII_SERVICE', 'ONP_PII_LLM', 'ONP_SENSITIVE']) delete env[name];
  env.OPENROUTER_API_KEY = 'sk-or-test';
  const run = (extra) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'gateway', '--port', '0', '--no-ollama', '--no-reputation', ...extra], { env });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no start-up output: ${out}`)); }, 20_000);
    child.stdout.on('data', (c) => { out += c; if (/point Cursor/.test(out)) { clearTimeout(timer); child.kill(); } });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
  const tokenFile = join(home, '.opennodes', 'gateway-token');

  const off = await run([]);
  assert.match(off, /no provider keys/);
  assert.match(off, /not used: OPENROUTER_API_KEY .*--env-keys/);
  assert.doesNotMatch(off, /sk-or-test/, 'never prints a key');
  assert.match(off, /browser pages only from localhost/);
  assert.match(off, /gateway API .*needs "authorization: Bearer <token>"; the token is kept in .*gateway-token/);
  const kept = readFileSync(tokenFile, 'utf8').trim();
  assert.ok(kept.length >= 24);
  assert.doesNotMatch(off, new RegExp(kept), 'the kept token is not printed');
  if (process.platform !== 'win32') assert.equal(statSync(tokenFile).mode & 0o777, 0o600);

  const on = await run(['--env-keys']);
  assert.match(on, /keys for: openrouter\.ai/);
  assert.doesNotMatch(on, /not used:/);
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), kept, 'the same token on the next start');

  const withToken = await run(['--token', 'chosen']);
  assert.match(withToken, /the token is your --token/);
});

test('core access helpers: local names, origins, bearer tokens, JSON content type', () => {
  const { hostAllowed, originAllowed } = localAccess({ allowOrigins: ['https://app.example/'], allowHosts: ['Proxy.Internal:8080'] });
  assert.equal(hostAllowed('localhost:4141'), true);
  assert.equal(hostAllowed('127.0.0.5'), true);
  assert.equal(hostAllowed('[::1]:4141'), true);
  assert.equal(hostAllowed('proxy.internal'), true);
  assert.equal(hostAllowed('localhost.evil.example'), false);
  assert.equal(hostAllowed(''), false, 'an HTTP/1.0 request with no Host is not local');
  assert.equal(originAllowed('https://app.example'), true, 'a trailing slash in the allow list is ignored');
  assert.equal(originAllowed('https://app.example.evil'), false);
  assert.equal(originAllowed(undefined), false);
  const check = bearerCheck('tok');
  assert.equal(check({ headers: { authorization: 'Bearer tok' } }), true);
  assert.equal(check({ headers: { authorization: 'bearer tok ' } }), true);
  assert.equal(check({ headers: { authorization: 'Bearer tokk' } }), false);
  assert.equal(check({ headers: { authorization: 'Bearer' } }), false);
  assert.equal(bearerCheck('two words')({ headers: { authorization: 'Bearer two words' } }), true, 'a chosen token with a space still works');
  assert.equal(bearerCheck(null)({ headers: { authorization: 'Bearer null' } }), false, 'no token configured never matches');
  assert.equal(bearerCheck(undefined)({ headers: { authorization: 'Bearer undefined' } }), false);
  assert.equal(isJsonContentType('application/json; charset=UTF-8'), true);
  assert.equal(isJsonContentType('text/plain'), false);
  assert.equal(isJsonContentType(undefined), false);
  assert.equal(isLoopbackBind('[::1]'), true);
  assert.equal(isLoopbackBind('0.0.0.0'), false);
});

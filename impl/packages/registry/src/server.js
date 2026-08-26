// OpenNodes Discovery Service — MVP registry server (REQ-001 subset).
import { randomUUID } from 'node:crypto';
import {
  createApp, listen, closeApp, sendJson, problem, readJson,
  validateCard, verifyCardSignature, keyFromJwk, estimateBounds,
} from '@opennodes/core';
import { resolveTxt } from 'node:dns/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeypair, keypairFromPem } from '@opennodes/core';
import { createStore } from './store.js';
import { runStageA } from './probes.js';
import { runStageB, captureFingerprints } from './stageb.js';
import { startStageC } from './stagec.js';
import { startReimport } from './reimport.js';
import { makeSafeFetch } from './safefetch.js';
import { searchOfferings, collectOfferings, RANK_COMPONENTS } from './search.js';
import { mcpRoutes } from './mcp.js';
import { exportRoutes } from './export.js';
import {
  importModelsDev, importHuggingFace, importOpenRouter,
  HF_ROUTER_URL, HF_HUB_URL, OPENROUTER_URL,
} from './importers.js';

export async function startRegistry({
  port = 0, host = '127.0.0.1', dbPath = ':memory:',
  allowPrivateTargets = false,          // SSRF guard off only for dev/e2e
  dnsResolveTxt = resolveTxt,           // injectable for tests
  stageBCapacity = {},                  // e.g. { durationMs, steps } — shortened in tests
  stageC = null,                        // { livenessIntervalMs, blindIntervalMs, failThreshold } to enable
  reimport = null,                      // { intervalMs, sources } to keep imported catalogs fresh
  adminToken = null,                    // bearer for admin routes; without it, loopback-only
  keyPath = null,                       // PEM file for a persistent signing identity; null = ephemeral
} = {}) {
  const store = await createStore(dbPath); // sqlite path/:memory: or postgres:// URL
  const safeFetch = makeSafeFetch({ allowPrivate: allowPrivateTargets });
  const webApp = readFileSync(fileURLToPath(new URL('./web/index.html', import.meta.url)), 'utf8');
  let registryKeys;
  if (keyPath && existsSync(keyPath)) {
    registryKeys = keypairFromPem(readFileSync(keyPath, 'utf8'));
  } else {
    registryKeys = generateKeypair();
    if (keyPath) writeFileSync(keyPath, registryKeys.privatePem, { mode: 0o600 });
  }

  const adminOk = (req, res) => {
    if (adminToken) {
      if (req.headers.authorization === `Bearer ${adminToken}`) return true;
      problem(res, 401, 'unauthorized', 'admin route requires bearer token');
      return false;
    }
    const remote = req.socket.remoteAddress;
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return true;
    problem(res, 403, 'forbidden', 'admin route is loopback-only without adminToken');
    return false;
  };

  async function fetchCard(cardUrl) {
    const res = await safeFetch(cardUrl, {}, 10_000);
    if (!res.ok) throw new Error(`card fetch failed: ${res.status}`);
    return res.json();
  }

  async function verifySignatureFromOrigin(card, origin) {
    const res = await safeFetch(`${origin}/.well-known/jwks.json`, {}, 10_000);
    if (!res.ok) throw new Error('jwks fetch failed');
    const jwks = await res.json();
    const kid = card.signatures?.[0]?.kid;
    const jwk = jwks.keys.find((k) => !kid || k.kid === kid) ?? jwks.keys[0];
    if (!jwk) throw new Error('no key in jwks');
    verifyCardSignature(card, keyFromJwk(jwk));
  }

  /** node.id is reverse-DNS: org.opennodes.fixture -> fixture.opennodes.org */
  const domainForNodeId = (nodeId) => nodeId.split('.').reverse().join('.');

  async function challengeSatisfied(node, challenge) {
    try { // HTTP method
      const resp = await safeFetch(`${node.origin}/.well-known/onp-challenge/${challenge.token}`, {}, 10_000);
      if (resp.ok) return { ok: true, method: 'http' };
    } catch { /* fall through to DNS */ }
    try { // DNS TXT method: _onp-challenge.{domain} TXT "{token}"
      const records = await dnsResolveTxt(`_onp-challenge.${domainForNodeId(node.id)}`);
      if (records.flat().includes(challenge.token)) return { ok: true, method: 'dns' };
    } catch { /* neither */ }
    return { ok: false };
  }

  async function indexCard(nodeId, cardUrl) {
    const card = await fetchCard(cardUrl);
    const errors = validateCard(card);
    if (errors.length) throw new Error('card invalid: ' + errors.slice(0, 5).join('; '));
    const origin = new URL(cardUrl).origin;
    if (card.node.id !== nodeId) throw new Error(`card node.id ${card.node.id} != registered ${nodeId}`);
    let sigOk = false;
    try { await verifySignatureFromOrigin(card, origin); sigOk = true; } catch { /* accepted but labeled */ }
    await store.saveRevision(nodeId, card.revision, card, sigOk);
    return { card, sigOk };
  }

  const app = createApp([
    ['POST', '/v0/nodes', async (req, res) => {
      const { card_url } = await readJson(req);
      if (!card_url) return problem(res, 400, 'missing-card-url', 'body must be {"card_url": "..."}');
      let card;
      try { card = await fetchCard(card_url); } catch (err) { return problem(res, 422, 'card-unfetchable', String(err.message)); }
      const errors = validateCard(card);
      if (errors.length) return problem(res, 422, 'card-invalid', errors.slice(0, 10).join('; '));

      const nodeId = card.node.id;
      const origin = new URL(card_url).origin;
      await store.upsertNode(nodeId, origin, card_url, 'challenged');
      await store.setState(nodeId, 'challenged', 'registration received');
      const token = randomUUID();
      await store.setChallenge(nodeId, token);
      sendJson(res, 202, {
        node_id: nodeId,
        state: 'challenged',
        challenge: {
          methods: {
            http: `${origin}/.well-known/onp-challenge/${token}`,
            dns: `_onp-challenge.${nodeId.split('.').slice(0, 2).reverse().join('.')} TXT "${token}"`,
          },
          token,
          verify: `/v0/nodes/${nodeId}/verify`,
        },
      });
    }],

    ['POST', '/v0/nodes/:id/verify', async (req, res, { params }) => {
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      const challenge = await store.getChallenge(params.id);
      if (!challenge) return problem(res, 410, 'challenge-expired', 'register again');
      const check = await challengeSatisfied(node, challenge);
      if (!check.ok) return problem(res, 403, 'challenge-failed', 'neither HTTP nor DNS TXT challenge satisfied');
      let indexed;
      try { indexed = await indexCard(params.id, node.card_url); }
      catch (err) { return problem(res, 422, 'card-invalid', String(err.message)); }

      await store.setState(params.id, 'indexed', `namespace verified via ${check.method}`);
      const stageA = await runStageA(store, params.id, indexed.card, { safeFetch });
      await store.setState(params.id, stageA.ok ? 'community' : 'indexed',
        stageA.ok ? 'Stage A passed' : 'Stage A failures: ' + stageA.results.filter((r) => !r.ok).map((r) => r.kind).join(','));
      sendJson(res, 200, {
        node_id: params.id,
        state: (await store.getNode(params.id)).state,
        signature_verified: indexed.sigOk,
        stage_a: stageA,
      });
    }],

    ['PUT', '/v0/nodes/:id/ping', async (req, res, { params }) => {
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      try {
        const { card } = await indexCard(params.id, node.card_url);
        const stageA = await runStageA(store, params.id, card, { safeFetch });
        sendJson(res, 200, { node_id: params.id, revision: card.revision, stage_a_ok: stageA.ok });
      } catch (err) {
        problem(res, 422, 'refresh-failed', String(err.message));
      }
    }],

    // Stage B admission: identity + context + capacity; promotes community -> verified,
    // or marks the node disputed on an identity failure (DS-ADM-02..04).
    ['POST', '/v0/nodes/:id/admit', async (req, res, { params }) => {
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      if (node.state !== 'community' && node.state !== 'verified') {
        return problem(res, 409, 'wrong-state', `Stage B requires community tier, node is ${node.state}`);
      }
      const card = await store.latestCard(params.id);
      const stageB = await runStageB(store, params.id, card, { safeFetch, capacity: stageBCapacity });
      if (stageB.identityFailed) {
        await store.setState(params.id, 'disputed', 'Stage B identity fingerprint mismatch');
      } else if (stageB.ok) {
        await store.setState(params.id, 'verified', 'Stage B passed');
      }
      sendJson(res, 200, { node_id: params.id, state: (await store.getNode(params.id)).state, stage_b: stageB });
    }],

    // Operator-trusted reference capture (admin surface, MVP: unauthenticated local only):
    // runs the fingerprint battery against a KNOWN-GOOD deployment and stores references.
    ['POST', '/v0/fingerprints/capture', async (req, res) => {
      if (!adminOk(req, res)) return;
      const { node_id, offering_id } = await readJson(req);
      const card = await store.latestCard(node_id);
      const offering = card?.offerings.find((o) => o.offering_id === offering_id);
      if (!offering) return problem(res, 404, 'unknown-offering', `${node_id}/${offering_id}`);
      const refs = await captureFingerprints(safeFetch, card, offering);
      await store.addFingerprints(offering.model.artifact, refs);
      sendJson(res, 200, { artifact: offering.model.artifact, references: refs.length });
    }],

    ['GET', '/v0/nodes/:id', async (req, res, { params }) => {
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      sendJson(res, 200, {
        ...node,
        card: await store.latestCard(params.id),
        probes: (await store.probesFor(params.id)).slice(0, 20),
        history: await store.transitionsFor(params.id),
      });
    }],

    ['GET', '/v0/offerings', async (req, res, { query }) => {
      sendJson(res, 200, { offerings: await searchOfferings(store, query) });
    }],

    ['GET', '/v0/offerings/:nodeId/:offeringId', async (req, res, { params }) => {
      const all = await collectOfferings(store);
      const found = all.find((o) => o.node_id === params.nodeId && o.offering_id === params.offeringId);
      if (!found) return problem(res, 404, 'unknown-offering', `${params.nodeId}/${params.offeringId}`);
      sendJson(res, 200, found);
    }],

    ['POST', '/v0/estimate', async (req, res) => {
      const { steps } = await readJson(req);
      if (!Array.isArray(steps) || steps.length === 0) return problem(res, 400, 'missing-steps', 'body must be {"steps": [...]}');
      const all = await collectOfferings(store);
      const out = [];
      let min = 0, max = 0;
      let currency = 'USD';
      for (const step of steps) {
        let offering;
        if (step.offering) {
          const [nodeId, offeringId] = step.offering.split('/');
          offering = all.find((o) => o.node_id === nodeId && o.offering_id === offeringId);
          if (!offering) return problem(res, 404, 'unknown-offering', step.offering);
        } else if (step.select) {
          const query = new URLSearchParams(step.select);
          const results = await searchOfferings(store, query);
          if (!results.length) return problem(res, 404, 'no-offering-matches', JSON.stringify(step.select));
          offering = results[0];
        } else {
          return problem(res, 400, 'bad-step', 'each step needs "offering" or "select"');
        }
        const bounds = estimateBounds(offering.pricing, step.est_input_tokens ?? 0, step.est_output_tokens ?? 0);
        currency = offering.pricing.currency;
        min += bounds.min; max += bounds.max;
        out.push({
          offering: `${offering.node_id}/${offering.offering_id}`,
          card_revision: offering.card_revision,
          cost: { currency: offering.pricing.currency, ...bounds },
        });
      }
      sendJson(res, 200, { total: { currency, min: round6(min), max: round6(max) }, steps: out });
    }],

    // Seed importer (admin): body {catalog} in models.dev shape, or {url} to fetch it.
    ['POST', '/v0/import/models-dev', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 50_000_000);
      let catalog = body.catalog;
      if (!catalog && body.url) {
        const resp = await safeFetch(body.url, {}, 30_000);
        catalog = await resp.json();
      }
      if (!catalog) return problem(res, 400, 'missing-catalog', 'body must carry {catalog} or {url}');
      sendJson(res, 200, await importModelsDev(store, catalog));
    }],

    // HF Inference Providers importer (admin): inline {router, hub}, or fetch the live APIs.
    ['POST', '/v0/import/huggingface', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 100_000_000);
      let { router, hub } = body;
      if (!router) {
        router = await (await safeFetch(HF_ROUTER_URL, {}, 60_000)).json();
        try { hub = await (await safeFetch(HF_HUB_URL, {}, 60_000)).json(); }
        catch { hub = []; } // hub enrichment is optional
      }
      sendJson(res, 200, await importHuggingFace(store, router, hub ?? []));
    }],

    // OpenRouter catalog importer (admin): inline {catalog}, or fetch the live API.
    ['POST', '/v0/import/openrouter', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 100_000_000);
      const catalog = body.catalog ?? await (await safeFetch(OPENROUTER_URL, {}, 60_000)).json();
      sendJson(res, 200, await importOpenRouter(store, catalog));
    }],

    ['GET', '/v0/health', (req, res) => {
      sendJson(res, 200, {
        service: 'opennodes-registry',
        onp: ['0.1'],
        ranking: { components: RANK_COMPONENTS, note: 'weighted sum; sponsored placement not implemented' },
        peers: [],
        fees: { listing: 'free', settlement: 'not-operated' },
        mcp: '/mcp',
        export: '/v0/export',
        signing_key: { ...registryKeys.publicJwk, kid: 'registry-1' },
        stage_c: Boolean(stageC),
      });
    }],

    // The registry web app: OpenRouter-style discovery + ranking + node registration UI.
    ['GET', '/', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=300' });
      res.end(webApp);
    }],

    ...mcpRoutes(store),
    ...exportRoutes(store, registryKeys),
  ]);

  const stageCHandle = stageC ? startStageC(store, { safeFetch, ...stageC }) : null;
  const reimportHandle = reimport ? startReimport(store, { safeFetch, ...reimport }) : null;
  const actualPort = await listen(app, port, host);
  return {
    port: actualPort,
    origin: `http://${host}:${actualPort}`,
    store,
    registryKeys,
    close: async () => {
      stageCHandle?.stop();
      reimportHandle?.stop();
      await closeApp(app);
      await store.close();
    },
  };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

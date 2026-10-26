// OpenNodes Discovery Service — MVP registry server (REQ-001 subset).
import { randomUUID } from 'node:crypto';
import {
  createApp, listen, closeApp, sendJson, problem, readJson,
  validateCard, verifyCardSignature, keyFromJwk, estimateBounds,
  extractFeatures, recommend,
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
import { searchOfferings, searchOfferingsPaged, collectOfferings, watchStoreWrites, RANK_COMPONENTS } from './search.js';
import { mcpRoutes } from './mcp.js';
import { hostControlsNamespace, isPrivateHost, makeRateLimiter } from './namespace.js';
import { exportRoutes } from './export.js';
import { collapseFlaps } from './feed.js';
import { checkNodeLocation } from './location.js';
import {
  importModelsDev, importHuggingFace, importOpenRouter,
  importOllamaLibrary, parseOllamaLibrary,
  HF_ROUTER_URL, HF_HUB_URL, OPENROUTER_URL, OLLAMA_LIBRARY_URL,
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
  enforceNamespace = null,              // null = enforce except for private hosts in dev mode; true/false to force
  registerPerHour = 0,                  // per-client cap on register/verify calls (0 = unlimited; set in production)
  admitCooldownMs = 0,                  // minimum gap between Stage B runs per node (0 = none; set in production)
  trustProxy = false,                   // read the client address from X-Forwarded-For (behind Caddy / a CDN)
  location = null,                      // { selfSite, agents, intervalMs, fetchImpl, resolve, rtt } to check server locations
} = {}) {
  const store = watchStoreWrites(await createStore(dbPath)); // sqlite path/:memory: or postgres:// URL; writes refresh the cached catalog
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

  /** May `originUrl`'s host register `nodeId`? (ONP-3 §4: the host must control the id's DNS namespace.) */
  const namespaceOk = (originUrl, nodeId) => {
    const host = new URL(originUrl).hostname;
    if (enforceNamespace === false) return true;
    if (enforceNamespace !== true && allowPrivateTargets && isPrivateHost(host)) return true;   // dev / e2e on loopback
    return hostControlsNamespace(host, nodeId);
  };
  const registerLimiter = makeRateLimiter(registerPerHour);
  const clientOf = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const isAdmin = (req) => Boolean(adminToken) && req.headers.authorization === `Bearer ${adminToken}`;

  /**
   * Fetch for probing one node: carries the operator's probe key (card-only listings of
   * keyed APIs), and only toward the card's own endpoint origins — never to anything else.
   */
  async function authFetch(nodeId, card) {
    const key = await store.getProbeKey(nodeId);
    if (!key || !card?.endpoints) return safeFetch;
    const origins = new Set([card.endpoints.openai, card.endpoints.health].filter(Boolean).map((u) => new URL(u).origin));
    return (url, opts = {}, timeoutMs) => safeFetch(url,
      origins.has(new URL(url).origin) ? { ...opts, headers: { ...(opts.headers ?? {}), authorization: `Bearer ${key}` } } : opts,
      timeoutMs);
  }

  /**
   * A registered node that reaches community or higher retires imported catalog listings of
   * the same operator — imports whose API host lies inside the node's own namespace. Bound to
   * the namespace so nobody can 'claim' a third party's listings (e.g. Hugging Face's router).
   */
  async function supersedeImports(nodeId) {
    const domain = domainForNodeId(nodeId).toLowerCase();
    const claimed = [];
    for (const imp of await store.allNodes()) {
      if (imp.source !== 'import' || ['claimed', 'delisted'].includes(imp.state)) continue;
      const card = await store.latestCard(imp.id);
      let host;
      try { host = new URL(card?.endpoints?.openai).hostname.toLowerCase(); } catch { continue; }
      if (host === domain || host.endsWith('.' + domain)) {
        await store.setState(imp.id, 'claimed', `claimed by ${nodeId}`);
        claimed.push(imp.id);
      }
    }
    return claimed;
  }

  async function challengeSatisfied(node, challenge) {
    try { // HTTP method — only from a host that controls the id's namespace
      if (namespaceOk(node.origin, node.id)) {
        const resp = await safeFetch(`${node.origin}/.well-known/onp-challenge/${challenge.token}`, {}, 10_000);
        if (resp.ok) return { ok: true, method: 'http' };
      }
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

  /**
   * Re-index a registered node's card when its origin serves a newer revision (restart,
   * reprice, config change). Probes pin the revision they hold; without this a restarted
   * node answers 409 to every probe and would look like an identity mismatch.
   */
  async function refreshCard(nodeId) {
    try {
      const node = await store.getNode(nodeId);
      if (!node?.card_url || node.source === 'import') return;
      const current = await store.latestCard(nodeId);
      const fresh = await fetchCard(node.card_url);
      if (current && fresh.revision === current.revision) return;
      await indexCard(nodeId, node.card_url);
    } catch { /* unreachable or invalid: probes will record the failure themselves */ }
  }

  const app = createApp([
    ['POST', '/v0/nodes', async (req, res) => {
      if (!registerLimiter(clientOf(req))) return problem(res, 429, 'rate-limited', 'too many registration attempts from this address; try again later');
      const { card_url, probe_key } = await readJson(req);
      if (probe_key != null && (typeof probe_key !== 'string' || probe_key.length > 4096)) return problem(res, 400, 'bad-probe-key', 'probe_key must be a string');
      if (!card_url) return problem(res, 400, 'missing-card-url', 'body must be {"card_url": "..."}');
      let card;
      try { card = await fetchCard(card_url); } catch (err) { return problem(res, 422, 'card-unfetchable', String(err.message)); }
      const errors = validateCard(card);
      if (errors.length) return problem(res, 422, 'card-invalid', errors.slice(0, 10).join('; '));

      const nodeId = card.node.id;
      const origin = new URL(card_url).origin;
      // The card must be served by a host that controls the claimed id (reverse-DNS). Otherwise anyone
      // could host a card naming someone else's node and pass the HTTP challenge on their own server.
      if (!namespaceOk(origin, nodeId)) {
        return problem(res, 403, 'namespace-mismatch',
          `node id ${nodeId} maps to ${domainForNodeId(nodeId)}; its card must be served from that host or a parent domain, not ${new URL(origin).hostname}`);
      }
      const existing = await store.getNode(nodeId);
      const listed = existing && !['challenged', 'submitted'].includes(existing.state) && existing.source !== 'import';
      await store.upsertNode(nodeId, origin, card_url, 'challenged');
      // Re-registration of a listed node issues a fresh challenge but never delists it: state moves at /verify.
      if (!listed) await store.setState(nodeId, 'challenged', 'registration received');
      const token = randomUUID();
      await store.setChallenge(nodeId, token);
      // Held as pending: it only becomes active when this namespace's challenge is satisfied, so a
      // stranger re-submitting someone else's card cannot replace (or break) their probe key.
      if (probe_key) await store.setPendingProbeKey(nodeId, probe_key);
      sendJson(res, 202, {
        node_id: nodeId,
        state: listed ? existing.state : 'challenged',
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
      if (!registerLimiter(clientOf(req))) return problem(res, 429, 'rate-limited', 'too many verification attempts from this address; try again later');
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      const challenge = await store.getChallenge(params.id);
      if (!challenge) return problem(res, 410, 'challenge-expired', 'register again');
      const check = await challengeSatisfied(node, challenge);
      if (!check.ok) return problem(res, 403, 'challenge-failed', 'neither HTTP nor DNS TXT challenge satisfied');
      await store.promoteProbeKey(params.id);
      let indexed;
      try { indexed = await indexCard(params.id, node.card_url); }
      catch (err) { return problem(res, 422, 'card-invalid', String(err.message)); }

      await store.setState(params.id, 'indexed', `namespace verified via ${check.method}`);
      const stageA = await runStageA(store, params.id, indexed.card, { safeFetch: await authFetch(params.id, indexed.card) });
      await store.setState(params.id, stageA.ok ? 'community' : 'indexed',
        stageA.ok ? 'Stage A passed' : 'Stage A failures: ' + stageA.results.filter((r) => !r.ok).map((r) => r.kind).join(','));
      const claimed = stageA.ok ? await supersedeImports(params.id) : [];
      if (location) locateNode(params.id).catch(() => {});   // background: never delays registration
      sendJson(res, 200, {
        node_id: params.id,
        state: (await store.getNode(params.id)).state,
        signature_verified: indexed.sigOk,
        stage_a: stageA,
        claimed_imports: claimed,
      });
    }],

    ['PUT', '/v0/nodes/:id/ping', async (req, res, { params }) => {
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      try {
        const { card } = await indexCard(params.id, node.card_url);
        const stageA = await runStageA(store, params.id, card, { safeFetch: await authFetch(params.id, card) });
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
      if (admitCooldownMs > 0 && !isAdmin(req)) {
        const lastB = (await store.probesFor(params.id)).find((p) => p.stage === 'B');
        const age = lastB ? Date.now() - Date.parse(lastB.at) : Infinity;
        if (age < admitCooldownMs) {
          return problem(res, 429, 'admission-cooldown', `Stage B ran ${Math.round(age / 60000)} min ago; next run allowed in ${Math.ceil((admitCooldownMs - age) / 60000)} min`);
        }
      }
      await refreshCard(params.id);
      const card = await store.latestCard(params.id);
      const stageB = await runStageB(store, params.id, card, { safeFetch: await authFetch(params.id, card), capacity: stageBCapacity });
      if (stageB.stale) {
        return problem(res, 409, 'stale-card', 'the node changed its card revision during the battery; retry');
      }
      if (stageB.identityFailed) {
        await store.setState(params.id, 'disputed', 'Stage B identity fingerprint mismatch');
      } else if (stageB.ok) {
        await store.setState(params.id, 'verified', 'Stage B passed');
        await supersedeImports(params.id);
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
      const refs = await captureFingerprints(await authFetch(node_id, card), card, offering);
      await store.addFingerprints(offering.model.artifact, refs);
      sendJson(res, 200, { artifact: offering.model.artifact, references: refs.length });
    }],

    // Node directory: every listed node with tier, source, offering count, availability.
    ['GET', '/v0/nodes', async (req, res) => {
      const out = [];
      for (const node of await store.allNodes()) {
        if (['delisted', 'claimed'].includes(node.state)) continue;
        const card = await store.latestCard(node.id);
        const availability = (await store.getObservations(node.id, '_node')).availability ?? null;
        out.push({
          id: node.id,
          state: node.state,
          tier: node.state === 'indexed' ? 'unverified' : node.state,
          source: node.source ?? 'registration',
          institutional: Boolean(node.institutional),
          updated_at: node.updated_at,
          name: card?.node?.name ?? node.id,
          operator: card?.node?.operator?.name ?? null,
          country: card?.node?.operator?.country ?? null,
          regions: card?.node?.regions ?? [],
          offerings: card?.offerings?.length ?? 0,
          availability,
        });
      }
      out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
      sendJson(res, 200, { nodes: out });
    }],

    // Freshness feed: recent listing events (registrations, tier changes, suspensions),
    // newest first, each linked to its provenance reason.
    // Liveness flaps (suspended/reinstated runs) collapse into one availability event;
    // ?raw=1 returns every transition.
    ['GET', '/v0/feed', async (req, res, { query }) => {
      const limit = Math.min(Number(query.get('limit') ?? 50), 200);
      const raw = query.get('raw') === '1';
      const events = (await store.recentTransitions(raw ? limit : Math.min(limit * 10, 2000))).map((t) => ({
        at: t.at, node_id: t.node_id, from: t.from_state, to: t.to_state,
        reason: t.reason, source: t.source ?? 'registration',
      }));
      sendJson(res, 200, { events: raw ? events : collapseFlaps(events).slice(0, limit) });
    }],

    ['GET', '/v0/nodes/:id', async (req, res, { params }) => {
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      sendJson(res, 200, {
        ...node,
        card: await store.latestCard(params.id),
        probes: (await store.probesFor(params.id)).slice(0, 20),
        history: await store.transitionsFor(params.id),
        location: (await store.getObservations(params.id, '_node')).location ?? null,
      });
    }],

    ['GET', '/v0/offerings', async (req, res, { query }) => {
      const { offerings, total, offset } = await searchOfferingsPaged(store, query);
      sendJson(res, 200, { offerings, total, offset });   // total = matches before `offset`/`limit`
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

    // ONP-3 §5b: task → ranked offerings with estimate + explanation. Accepts either a
    // task description (features extracted here) or pre-extracted `features` so a
    // client never has to send its prompt to the registry.
    ['POST', '/v0/recommend', async (req, res) => {
      const body = await readJson(req, 1_000_000);
      const features = body.features ?? (body.task != null
        ? extractFeatures(String(body.task), { attachments: body.attachments ?? [], est_output_tokens: body.est_output_tokens ?? null, messages: body.messages ?? [] })
        : null);
      if (!features) return problem(res, 400, 'missing-task', 'body must carry "task" (text) or "features" (from extractFeatures)');
      // only what a client could actually call: listing-only imports are never recommended
      const all = (await collectOfferings(store)).filter((o) => o.invocable);
      sendJson(res, 200, recommend(all, features, body.policy ?? {}));
    }],

    // Delist (admin): operator opt-out of an imported listing, or retiring a node. Search,
    // the directory and Stage C skip delisted nodes, and re-imports never revive them.
    // Body {reason}. A registered node returns by registering again; relist re-opens imports.
    // Server-location check on demand (admin): geolocation + network + RTT from the probe sites.
    ['POST', '/v0/admin/nodes/:id/locate', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      if (!location) return problem(res, 409, 'location-checks-disabled', 'start the registry with location checks enabled');
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      sendJson(res, 200, await locateNode(node.id));
    }],
    ['POST', '/v0/admin/nodes/:id/delist', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      const { reason } = await readJson(req);
      if (node.state !== 'delisted') await store.setState(node.id, 'delisted', `delisted: ${reason || 'by registry admin'}`);
      sendJson(res, 200, { id: node.id, state: 'delisted' });
    }],
    ['POST', '/v0/admin/nodes/:id/relist', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      if (node.state !== 'delisted') return problem(res, 409, 'not-delisted', `${node.id} is ${node.state}`);
      if (node.source !== 'import') return problem(res, 409, 'register-again', 'a registered node returns by registering again (POST /v0/nodes)');
      await store.setState(node.id, 'indexed', 'relisted by registry admin');
      sendJson(res, 200, { id: node.id, state: 'indexed' });
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

    // Ollama library importer (admin): inline {entries} or {html}, or fetch the live page.
    ['POST', '/v0/import/ollama', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 50_000_000);
      let entries = body.entries;
      if (!entries) {
        const html = body.html ?? await (await safeFetch(OLLAMA_LIBRARY_URL, {}, 60_000)).text();
        entries = parseOllamaLibrary(html);
      }
      sendJson(res, 200, await importOllamaLibrary(store, entries));
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
        webmcp: true, // the web app at / registers in-page tools via navigator.modelContext where supported
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
  ], { cors: true }); // public read API: third-party web clients may call it directly

  // ---- server-location checks (location.js) ----
  const asHolders = new Map();
  async function locateNode(nodeId) {
    const card = await store.latestCard(nodeId);
    const result = await checkNodeLocation(card, { ...location, asHolders });
    await store.setObservation(nodeId, '_node', 'location', result);
    return result;
  }
  // Daily sweep over registered nodes and imports that carry a country (the ones jurisdiction
  // filters can select), one at a time so the lookup service is never hammered.
  function startLocationSweep() {
    let stopped = false, timer = null;
    const sweep = async () => {
      for (const node of await store.allNodes()) {
        if (stopped) return;
        if (['delisted', 'claimed', 'submitted', 'challenged'].includes(node.state)) continue;
        const card = await store.latestCard(node.id);
        if (!card?.endpoints?.openai) continue;
        if (node.source === 'import' && !card.node?.operator?.country) continue;
        await locateNode(node.id).catch(() => {});
        await new Promise((r) => setTimeout(r, location.pauseMs ?? 2000));
      }
    };
    const loop = async () => { if (stopped) return; await sweep().catch(() => {}); if (!stopped) timer = setTimeout(loop, location.intervalMs ?? 24 * 3600 * 1000); };
    timer = setTimeout(loop, location.firstDelayMs ?? 60_000);
    return { stop: () => { stopped = true; clearTimeout(timer); } };
  }

  const stageCHandle = stageC ? startStageC(store, { safeFetch, fetchFor: authFetch, refreshCard, ...stageC }) : null;
  const reimportHandle = reimport ? startReimport(store, { safeFetch, ...reimport }) : null;
  const locationHandle = location ? startLocationSweep() : null;
  const actualPort = await listen(app, port, host);
  return {
    port: actualPort,
    origin: `http://${host}:${actualPort}`,
    store,
    registryKeys,
    close: async () => {
      stageCHandle?.stop();
      reimportHandle?.stop();
      locationHandle?.stop();
      await closeApp(app);
      await store.close();
    },
  };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

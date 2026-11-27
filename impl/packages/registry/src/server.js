// OpenNodes Discovery Service — MVP registry server (REQ-001 subset).
import { randomUUID } from 'node:crypto';
import {
  createApp, listen, closeApp, sendJson, problem, readJson,
  validateCard, verifyCardWithJwks, estimateBounds,
  extractFeatures, recommend, trustedView, DEFAULT_TRUSTED_JURISDICTIONS, serverCheckOf,
} from '@opennodes/core';
import { resolveTxt } from 'node:dns/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeypair, keypairFromPem } from '@opennodes/core';
import { createStore } from './store.js';
import { runStageA, verificationOf } from './probes.js';
import { runStageB, captureFingerprints, UNSIGNED_CARD, IDENTITY_CAPTURE, CUSTOMER_ACCESS_NEEDED } from './stageb.js';
import { startStageC } from './stagec.js';
import { loadCorpus } from './corpus.js';
import { vendorTable, proprietaryVendor, VENDOR_SLUG, NAMESPACE, ARTIFACT } from './vendors.js';
import { makePlanner, startScheduler } from './schedule.js';
import { startReimport } from './reimport.js';
import { makeSafeFetch } from './safefetch.js';
import { searchOfferings, searchOfferingsPaged, collectOfferings, watchStoreWrites, setSeedPlacements, setTrustedView, RANK_COMPONENTS, pricePublished, ROUTER_HOSTS, locationSummary } from './search.js';
import { mcpRoutes } from './mcp.js';
import { hostControlsNamespace, isPrivateHost, makeRateLimiter } from './namespace.js';
import { exportRoutes } from './export.js';
import { collapseFlaps } from './feed.js';
import { checkNodeLocation, declaredOrigins } from './location.js';
import {
  importModelsDev, importHuggingFace, importOpenRouter,
  importOllamaLibrary, parseOllamaLibrary,
  importOpenRouterProviders, fetchOpenRouterEndpoints, importLocationSeed, importHorde,
  HF_ROUTER_URL, HF_HUB_URL, OPENROUTER_URL, OPENROUTER_PROVIDERS_URL, OLLAMA_LIBRARY_URL,
  HORDE_STATUS_URL, HORDE_TEXT_REFERENCE_URL, HORDE_CLIENT_AGENT,
} from './importers.js';
import { locationRoutes, loadLocationSeeds, seedPlacements, seedNodeSites, nodeServes } from './locations.js';
import { makeRequestCounter, nodeIdsIn } from './counts.js';

/** Default basemap. OSM's tile policy asks for attribution and light use; busy registries set their own. */
export const OSM_TILES = {
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  max_zoom: 19,
};

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
  registerPerHour = 0,                  // per-client cap on register/verify/ping calls (0 = unlimited; set in production)
  schedule = null,                      // {} (or overrides of SCHEDULE_DEFAULTS) to run Stage A and B on the registry's timetable
  probeCorpus = null,                   // private probe prompts: a JSON file path or an object (corpus.js); null = public built-in
  trustProxy = false,                   // read the client address from X-Forwarded-For (behind Caddy / a CDN)
  location = null,                      // { selfSite, agents, intervalMs, fetchImpl, resolve, rtt } to check server locations
  locationSeeds = false,                // import the bundled curated location seeds (src/data/locations-*.json) at start
  mapTiles = OSM_TILES,                 // basemap for the "Where models run" map: { tiles, attribution, max_zoom }, or null for no map
  requestCountFlushMs = 60_000,         // how often request counts move from memory to the store (reads flush first)
  trustedJurisdictions = DEFAULT_TRUSTED_JURISDICTIONS,   // the trusted pool's operator jurisdictions (ONP_TRUSTED_JURISDICTIONS)
} = {}) {
  const corpus = loadCorpus(probeCorpus);   // before the store: a broken corpus file stops the start
  const store = watchStoreWrites(await createStore(dbPath)); // sqlite path/:memory: or postgres:// URL; writes refresh the cached catalog
  const planner = makePlanner(store, schedule ?? {});
  // Vendor-namespace table: built-in pins, admin entries, and the vendor slugs imports already use,
  // each bound to the API hosts of those imports (routers excluded).
  const vendors = async () => {
    const catalog = new Map();
    for (const o of await collectOfferings(store)) {
      const vendor = o.source === 'import' ? proprietaryVendor(o.model?.artifact) : null;
      if (!vendor) continue;
      if (!catalog.has(vendor)) catalog.set(vendor, new Set());
      let host = null;
      try { host = new URL(o.endpoints?.openai).hostname.toLowerCase(); } catch { /* listing-only */ }
      if (host && !ROUTER_HOSTS.has(host)) catalog.get(vendor).add(host);
    }
    return vendorTable(await store.vendorNamespaces(), catalog);
  };
  const requests = makeRequestCounter(store, { flushMs: requestCountFlushMs });   // node ids + counts only
  const safeFetch = makeSafeFetch({ allowPrivate: allowPrivateTargets });
  const seeds = locationSeeds ? loadLocationSeeds() : [];
  for (const seed of seeds) {
    const result = await importLocationSeed(store, seed);
    if (result.skipped.length) console.warn(`location seed ${seed.seed}: skipped ${result.skipped.join('; ')}`);
  }
  setSeedPlacements(store, seedPlacements(seeds));
  const trusted = trustedView(trustedJurisdictions);   // pool labels, trust=trusted, sensitive recommend
  if (!trusted.countries.length) console.warn(`trusted jurisdictions "${trustedJurisdictions}" name no country: no hosted offering is trusted`);
  // The trusted pool needs a passing server-location check (ONP-3 §5e): without checks it holds no hosted offering.
  if (!location && !allowPrivateTargets) console.warn('server-location checks are off (ONP_LOCATION): no hosted offering can pass the server check, so the trusted pool holds none');
  setTrustedView(store, trusted);
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

  /**
   * Check the card's signature against the origin's JWKS. `definite: false` when the JWKS could not
   * be fetched (an outage says nothing about the card); `definite: true` when the card is unsigned
   * or the signature does not verify.
   */
  async function checkSignature(card, origin) {
    if (!card.signatures?.length) return { ok: false, definite: true, error: 'card has no signatures' };
    let jwks;
    try {
      const res = await safeFetch(`${origin}/.well-known/jwks.json`, {}, 10_000);
      if (!res.ok) return { ok: false, definite: false, error: `jwks fetch failed: ${res.status}` };
      jwks = await res.json();
    } catch (err) { return { ok: false, definite: false, error: `jwks fetch failed: ${err.message}` }; }
    try {
      verifyCardWithJwks(card, jwks);   // any signature, by kid first, with a key the origin publishes
      return { ok: true };
    } catch (err) { return { ok: false, definite: true, error: String(err.message ?? err) }; }
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

  /**
   * Fetch for probing one node: carries the customer access the registry bought for it, else the
   * operator's probe key (card-only listings of keyed APIs), and only toward the card's own
   * endpoint origins — never to anything else.
   */
  async function authFetch(nodeId, card) {
    const key = (await store.getCustomerKey(nodeId)) ?? (await store.getProbeKey(nodeId));
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
    // Unsigned cards are accepted but labeled below `verified`, and never at `verified` or above (ONP-2 §8).
    const sig = await checkSignature(card, origin);
    let sigOk = sig.ok;
    if (!sig.ok && !sig.definite) {
      // JWKS unreachable: the same bytes verified before still count; a new revision waits for a check.
      const prev = await store.latestRevision(nodeId);
      if (prev?.sig_ok && prev.revision === card.revision && JSON.stringify(await store.latestCard(nodeId)) === JSON.stringify(card)) sigOk = true;
    }
    await store.saveRevision(nodeId, card.revision, card, sigOk);
    if (!sigOk && sig.definite) {
      const node = await store.getNode(nodeId);
      if (['verified', 'attested'].includes(node?.state)) await store.setState(nodeId, 'community', `${UNSIGNED_CARD}: ${sig.error}`);
    }
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
      const current = await store.latestRevision(nodeId);
      const fresh = await fetchCard(node.card_url);
      // Same revision: nothing to do, unless its signature could not be checked yet.
      if (current && fresh.revision === current.revision && current.sig_ok) return;
      await indexCard(nodeId, node.card_url);
    } catch { /* unreachable or invalid: probes will record the failure themselves */ }
  }

  // ---- admission runs shared by /verify, /ping, /admit, dispute resolution and the scheduler ----
  const LISTED = ['community', 'verified', 'attested'];

  /**
   * Stage A on the node's latest card, and what it means for the tier (ONP-3 §4a): `indexed` that
   * passes goes to `community`; a listed node that fails a structural check (STRUCTURAL_KINDS) goes
   * back to `indexed`; health and blind-call failures are left to Stage C. A dispute is never
   * touched. `recordFailure` writes a failed run on an `indexed` node into the history (/verify);
   * `refresh` re-fetches the card first (scheduled runs: ONP-3 §1, at least every 6 h).
   */
  async function stageAFor(nodeId, { recordFailure = false, refresh = false } = {}) {
    if (refresh) await refreshCard(nodeId);
    const card = await store.latestCard(nodeId);
    const stageA = await runStageA(store, nodeId, card, { safeFetch: await authFetch(nodeId, card), corpus, vendors: await vendors() });
    const node = await store.getNode(nodeId);
    const failed = stageA.results.filter((r) => !r.ok);
    let claimed = [];
    if (stageA.ok && node.state === 'indexed') {
      await store.setState(nodeId, 'community', 'Stage A passed');
      claimed = await supersedeImports(nodeId);
      await planner.firstStageB(nodeId, card, 'first');
    } else if (!stageA.ok && node.state === 'indexed' && recordFailure) {
      await store.setState(nodeId, 'indexed', 'Stage A failures: ' + failed.map((r) => r.kind).join(','));
    } else if (!stageA.ok && LISTED.includes(node.state)) {
      const structural = failed.filter((r) => r.structural).map((r) => r.kind);
      if (structural.length) await store.setState(nodeId, 'indexed', 'Stage A failures: ' + structural.join(','));
    }
    await planner.afterStageA(nodeId, card, stageA.ok);
    return { stageA, claimed };
  }

  /** Stage B runs one at a time per node: the admin route and the scheduler never overlap. */
  const stageBRunning = new Set();

  /**
   * A card-only listing (ONP-3 §4) is probed with the operator's own probe key, which marks every
   * probe: it reaches `verified` only on probes sent with customer access the registry bought.
   */
  const cardOnlyHeld = async (nodeId) => Boolean(await store.getProbeKey(nodeId)) && !(await store.getCustomerKey(nodeId));
  /**
   * A verified or attested card-only listing without customer access goes back to community at once
   * (after a probe key is activated, or customer access removed). The reason never says which.
   */
  async function holdCardOnly(nodeId) {
    const node = await store.getNode(nodeId);
    if (['verified', 'attested'].includes(node?.state) && await cardOnlyHeld(nodeId)) await store.setState(nodeId, 'community', CUSTOMER_ACCESS_NEEDED);
  }

  /**
   * Stage B on the node's freshly fetched card, and its effect: a reference mismatch disputes the
   * node; a pass promotes `community` to `verified`; anything else (no identity reference, unsigned
   * card, capacity) keeps `community` or demotes `verified` to `community`. Returns null when a
   * run is already in progress for the node.
   */
  async function stageBFor(nodeId, { refresh = false } = {}) {
    if (stageBRunning.has(nodeId)) return null;
    stageBRunning.add(nodeId);
    try {
      // Scheduled runs go out on the card already held: a card fetch just before the battery would
      // tell the operator that Stage B is starting (ONP-3 §4a.9). A 409 still re-fetches (below).
      if (refresh) await refreshCard(nodeId);
      const card = await store.latestCard(nodeId);
      const revision = await store.latestRevision(nodeId);
      // Decided before anything is sent: what counts is the key this run's probes carry.
      const held = await cardOnlyHeld(nodeId);
      // A 409 excuses nothing unless a re-fetch shows the card really moved (stageb.js makeOn409).
      const revisionMoved = async () => {
        await refreshCard(nodeId);
        const now = await store.latestRevision(nodeId);
        return now && now.revision !== card.revision ? now.revision : null;
      };
      const stageB = await runStageB(store, nodeId, card, {
        safeFetch: await authFetch(nodeId, card), capacity: stageBCapacity, corpus, vendors: await vendors(), signed: Boolean(revision?.sig_ok), revisionMoved,
      });
      const node = await store.getNode(nodeId);
      if (!stageB.stale && LISTED.includes(node.state)) {
        if (stageB.identityFailed) {
          await store.setState(nodeId, 'disputed', 'Stage B identity fingerprint mismatch');
        } else if (stageB.ok && held) {
          // Passed, but on probes the operator could tell apart: it stays at (or returns to) community.
          stageB.held = CUSTOMER_ACCESS_NEEDED;
          await store.recordProbe(nodeId, null, 'B', 'customer-access', false, CUSTOMER_ACCESS_NEEDED);
          if (node.state !== 'community') await store.setState(nodeId, 'community', `Stage B passed; ${CUSTOMER_ACCESS_NEEDED}`);
          await supersedeImports(nodeId);
        } else if (stageB.ok) {
          if (node.state === 'community') await store.setState(nodeId, 'verified', 'Stage B passed');
          await supersedeImports(nodeId);
        } else if (node.state !== 'community') {
          await store.setState(nodeId, 'community', `Stage B failed: ${stageB.reason}`);
        }
      }
      await planner.afterStageB(nodeId, card, stageB);
      return stageB;
    } finally {
      stageBRunning.delete(nodeId);
    }
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
            dns: `_onp-challenge.${domainForNodeId(nodeId)} TXT "${token}"`,   // the whole id, as the check resolves it
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

      // A dispute survives registering again: only a resolution recorded by the registry ends it
      // (POST /v0/admin/nodes/{id}/resolve). The fresh card is indexed so it can be reviewed.
      const current = (await store.getNode(params.id)).state;
      if (current === 'disputed') {
        const since = [...await store.transitionsFor(params.id)].reverse().find((t) => t.to_state === 'disputed');
        return problem(res, 409, 'disputed',
          `${params.id} is disputed${since ? ` since ${since.at} (${since.reason})` : ''}. Registering again does not end a dispute; the registry records a resolution after review. The card was re-indexed at revision ${indexed.card.revision}.`);
      }
      // A listed or suspended node keeps its state: registering again re-indexes the card and runs
      // Stage A under the listed-node rules, but neither resets the tier nor moves Stage B's schedule
      // (a changed model, serving block or endpoint makes Stage B due on its own, schedule.js).
      if (![...LISTED, 'suspended'].includes(current)) await store.setState(params.id, 'indexed', `namespace verified via ${check.method}`);
      // A probe key handed over now makes a verified node card-only: no verified without customer access.
      await holdCardOnly(params.id);
      const { stageA, claimed } = await stageAFor(params.id, { recordFailure: true });
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
      if (!registerLimiter(clientOf(req))) return problem(res, 429, 'rate-limited', 'too many refresh requests from this address; try again later');
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      // A ping runs Stage A, which calls the endpoint. Imports are never probed: some upstreams (the AI
      // Horde) answer requests without a key, so a public ping must not become traffic to them.
      if (node.source === 'import') return problem(res, 409, 'imported-listing', `${node.id} is an imported catalog listing; the registry does not probe it`);
      try {
        const { card } = await indexCard(params.id, node.card_url);
        if (location) relocateIfStale(params.id, card).catch(() => {});   // background: a new API host is checked again now
        const { stageA } = await stageAFor(params.id);
        sendJson(res, 200, { node_id: params.id, revision: card.revision, stage_a_ok: stageA.ok, state: (await store.getNode(params.id)).state });
      } catch (err) {
        problem(res, 422, 'refresh-failed', String(err.message));
      }
    }],

    // Stage B admission (admin): identity + context + capacity; promotes community -> verified,
    // or marks the node disputed on an identity failure (DS-ADM-02..04). Otherwise Stage B runs
    // only on the registry's own schedule (schedule.js): neither the operator nor a third party
    // chooses when it happens.
    ['POST', '/v0/nodes/:id/admit', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      if (!LISTED.includes(node.state)) {
        return problem(res, 409, 'wrong-state', `Stage B requires community tier, node is ${node.state}`);
      }
      const stageB = await stageBFor(params.id, { refresh: true });   // the admin's request: the latest card
      if (!stageB) return problem(res, 409, 'stage-b-running', `Stage B is already running for ${params.id}`);
      if (stageB.stale) {
        return problem(res, 409, 'stale-card', 'the node changed its card revision during the battery; retry');
      }
      sendJson(res, 200, { node_id: params.id, state: (await store.getNode(params.id)).state, stage_b: stageB });
    }],

    // Operator-trusted reference capture (admin): asks a KNOWN-GOOD deployment of the weights
    // IDENTITY_CAPTURE prompts drawn from the private corpus and stores the answers' hashes as the
    // artefact's references, replacing earlier ones unless {"replace": false}. Body {node_id,
    // offering_id} names the deployment; optional {artifact} stores them under another artefact
    // (e.g. the public name a node is about to switch to). The prompts never leave the registry.
    ['POST', '/v0/fingerprints/capture', async (req, res) => {
      if (!adminOk(req, res)) return;
      const { node_id, offering_id, artifact, replace = true } = await readJson(req);
      const card = await store.latestCard(node_id);
      const offering = card?.offerings.find((o) => o.offering_id === offering_id);
      if (!offering) return problem(res, 404, 'unknown-offering', `${node_id}/${offering_id}`);
      const target = artifact ?? offering.model.artifact;
      if (typeof target !== 'string' || !ARTIFACT.test(target)) return problem(res, 400, 'bad-artifact', 'artifact must be hf:{org}/{repo}, ollama:{name}[:{tag}] or urn:proprietary:{vendor}:{model}');
      let refs;
      try { refs = await captureFingerprints(await authFetch(node_id, card), card, offering, corpus.identityPrompts(IDENTITY_CAPTURE)); }
      catch (err) { return problem(res, 502, 'capture-failed', String(err.message)); }
      if (replace) await store.clearFingerprints(target);
      await store.addFingerprints(target, refs);
      sendJson(res, 200, { artifact: target, references: refs.length, corpus: corpus.private ? 'private' : 'built-in' });
    }],

    // Dispute resolution (admin): the only way out of `disputed`. Body {"resolution": "..."}: what
    // was found and done, recorded in the listing history. The node returns to `indexed`, runs
    // Stage A at once, and Stage B again on the registry's schedule.
    ['POST', '/v0/admin/nodes/:id/resolve', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      if (node.state !== 'disputed') return problem(res, 409, 'not-disputed', `${node.id} is ${node.state}`);
      const { resolution } = await readJson(req);
      if (typeof resolution !== 'string' || !resolution.trim() || resolution.length > 2000) {
        return problem(res, 400, 'missing-resolution', 'body must be {"resolution": "what was found and what was done"}');
      }
      await store.setState(node.id, 'indexed', `dispute resolved: ${resolution.trim()}`);
      await refreshCard(node.id);
      const { stageA } = await stageAFor(node.id, { recordFailure: true });
      sendJson(res, 200, { id: node.id, state: (await store.getNode(node.id)).state, stage_a: stageA });
    }],

    // Customer access (admin, ONP-3 §4): body {"key": "..."} records a key the registry bought as an
    // ordinary customer of the node's API; from then on every probe carries it instead of the
    // operator's probe key, and a card-only listing can reach verified at its next Stage B, which
    // the registry schedules (an earlier pass never counts). {"key": null} removes it. The key is
    // never returned, logged or published, and no public record says it was recorded.
    ['POST', '/v0/admin/nodes/:id/customer-access', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      if (node.source === 'import') return problem(res, 409, 'imported-listing', `${node.id} is an imported catalog listing; the registry does not probe it`);
      const { key } = await readJson(req);
      if (key !== null && (typeof key !== 'string' || !key.trim() || key.length > 4096)) {
        return problem(res, 400, 'bad-customer-key', 'body must be {"key": "<the API key>"}, or {"key": null} to remove it');
      }
      await store.setCustomerKey(node.id, key);
      if (key && LISTED.includes(node.state)) await planner.firstStageB(node.id, await store.latestCard(node.id), 'first');
      if (location) locateNode(node.id).catch(() => {});   // behind a CDN the origin check asks with this key
      if (!key) await holdCardOnly(node.id);
      sendJson(res, 200, { node_id: node.id, customer_access: Boolean(key), state: (await store.getNode(node.id)).state });
    }],

    // The vendor-namespace table (ONP-3 §6.3): who may claim urn:proprietary:{vendor}:* artefacts.
    ['GET', '/v0/vendors', async (req, res) => {
      const table = await vendors();
      sendJson(res, 200, {
        rule: 'urn:proprietary:{vendor}:{model} is admitted only from a node id inside one of the vendor\'s namespaces listed here; for a vendor known from imported listings (source "catalog"), only from a node whose own domain contains one of the hosts those listings are served from; for any other vendor, only from the node\'s own namespace (the second label of its id)',
        vendors: [...table].map(([vendor, v]) => ({ vendor, namespaces: v.namespaces, source: v.source, ...(v.hosts ? { hosts: v.hosts } : {}) }))
          .sort((a, b) => a.vendor.localeCompare(b.vendor)),
      });
    }],
    // Admin: body {"namespaces": ["com.example"]} sets a vendor's namespaces; {"namespaces": null}
    // removes the admin entry (a built-in pin applies again).
    ['POST', '/v0/admin/vendors/:vendor', async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      if (!VENDOR_SLUG.test(params.vendor)) return problem(res, 400, 'bad-vendor', 'vendor must match [a-z0-9-]+');
      const { namespaces } = await readJson(req);
      if (namespaces !== null && !(Array.isArray(namespaces) && namespaces.length && namespaces.every((n) => typeof n === 'string' && NAMESPACE.test(n)))) {
        return problem(res, 400, 'bad-namespaces', 'body must be {"namespaces": ["com.example", ...]} (reverse-DNS, lower case) or {"namespaces": null}');
      }
      await store.setVendorNamespaces(params.vendor, namespaces);
      const entry = (await vendors()).get(params.vendor);
      sendJson(res, 200, { vendor: params.vendor, namespaces: entry?.namespaces ?? null, source: entry?.source ?? null });
    }],

    // Node directory: every listed node with tier, source, offering count, availability.
    ['GET', '/v0/nodes', async (req, res) => {
      const out = [];
      const known = seedNodeSites(seeds);
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
          founding: Boolean(node.founding),
          updated_at: node.updated_at,
          name: card?.node?.name ?? node.id,
          operator: card?.node?.operator?.name ?? null,
          country: card?.node?.operator?.country ?? null,
          regions: card?.node?.regions ?? [],
          locations: card?.node?.locations ?? [],
          serves: nodeServes(node, card, known.get(node.id)),
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
      const card = await store.latestCard(params.id);
      const nodeObs = await store.getObservations(params.id, '_node');
      sendJson(res, 200, {
        ...node,
        institutional: Boolean(node.institutional),
        founding: Boolean(node.founding),
        card,
        // Whether the latest card's signature verified against the origin's JWKS (ONP-2 §8).
        signature_verified: Boolean((await store.latestRevision(params.id))?.sig_ok),
        probes: (await store.probesFor(params.id)).slice(0, 20),
        history: await store.transitionsFor(params.id),
        location: nodeObs.location ?? null,
        // The check's evidence level for the current card (ONP-3 §6.4; `unchecked` when it was made for another host).
        server_check: serverCheckOf({ jurisdiction: { location: locationSummary(nodeObs.location ?? null, card) } }),
        // What the tier covers (ONP-3 §4a): the offerings the tests could not call, and whether
        // Stage C has had to skip blind probes because none could be called.
        verification: verificationOf(card, nodeObs),
        // How often search, recommend and MCP returned this node, last 12 ISO weeks, newest first.
        request_counts: await requests.forNode(params.id),
      });
    }],

    // Request counts (ONP-3 §6.6): per ISO week, the responses on each surface and the nodes they
    // returned. ?weeks=1..52 (default 4), ?node_id= one node, ?limit= nodes per week (default 50).
    ['GET', '/v0/stats/requests', async (req, res, { query }) => {
      const int = (k, dflt, max) => Math.min(max, Math.max(1, Math.floor(Number(query.get(k) ?? dflt)) || dflt));
      sendJson(res, 200, {
        counted: 'responses that returned the node, per ISO week (Monday 00:00 UTC): search = GET /v0/offerings, recommend = POST /v0/recommend, mcp = tools/call on /mcp; each response counts a node once. Only node ids and counts are stored, never the query, task or client.',
        weeks: await requests.stats({ weeks: int('weeks', 4, 52), nodeId: query.get('node_id') || null, limit: int('limit', 50, 500) }),
      });
    }],

    ['GET', '/v0/offerings', async (req, res, { query }) => {
      let page;
      try { page = await searchOfferingsPaged(store, query); }
      catch (err) { if (err.status === 400) return problem(res, 400, 'bad-query', err.message); throw err; }
      const { offerings, total, offset, counts } = page;
      requests.count('search', offerings.map((o) => o.node_id));
      // total = matches before `offset`/`limit`; counts = hosted/local matches before the `local` filter
      sendJson(res, 200, { offerings, total, offset, counts });
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
      let min = 0, max = 0, incomplete = false;
      let currency = 'USD';
      for (const step of steps) {
        let offering;
        if (step.offering) {
          const [nodeId, offeringId] = step.offering.split('/');
          offering = all.find((o) => o.node_id === nodeId && o.offering_id === offeringId);
          if (!offering) return problem(res, 404, 'unknown-offering', step.offering);
        } else if (step.select) {
          const query = new URLSearchParams(step.select);
          let results;
          try { results = await searchOfferings(store, query); }
          catch (err) { if (err.status === 400) return problem(res, 400, 'bad-query', err.message); throw err; }
          if (!results.length) return problem(res, 404, 'no-offering-matches', JSON.stringify(step.select));
          offering = results[0];
        } else {
          return problem(res, 400, 'bad-step', 'each step needs "offering" or "select"');
        }
        const bounds = estimateBounds(offering.pricing, step.est_input_tokens ?? 0, step.est_output_tokens ?? 0);
        currency = offering.pricing.currency;
        min += bounds.min; max += bounds.max;
        // No published per-token price: the step's cost is unknown, not zero.
        const unpriced = !pricePublished(offering.pricing);
        incomplete ||= unpriced;
        out.push({
          offering: `${offering.node_id}/${offering.offering_id}`,
          card_revision: offering.card_revision,
          cost: { currency: offering.pricing.currency, ...bounds, ...(unpriced ? { price_published: false } : {}) },
        });
      }
      sendJson(res, 200, { total: { currency, min: round6(min), max: round6(max), ...(incomplete ? { incomplete: true } : {}) }, steps: out });
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
      // policy.sensitive / policy.trust apply this registry's trusted view; a client cannot replace it
      let advice;
      try { advice = recommend(all, features, { ...(body.policy ?? {}), trusted }); }
      catch (err) { if (err.status === 400) return problem(res, 400, 'bad-policy', err.message); throw err; }
      requests.count('recommend', nodeIdsIn(advice));   // recommendations, scenario roles, embedders
      sendJson(res, 200, advice);
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

    // Operator marks (admin, ONP-3 §4b): body {"institutional": true|false} or {"founding": true|false}.
    // Labels shown with the listing, never rank inputs. Setting one needs a registered node (an
    // unclaimed import has no proven operator); clearing always works.
    ...['institutional', 'founding'].map((flag) => ['POST', `/v0/admin/nodes/:id/${flag}`, async (req, res, { params }) => {
      if (!adminOk(req, res)) return;
      const node = await store.getNode(params.id);
      if (!node) return problem(res, 404, 'unknown-node', params.id);
      const body = await readJson(req);
      if (typeof body[flag] !== 'boolean') return problem(res, 400, 'bad-flag', `body must be {"${flag}": true} or {"${flag}": false}`);
      if (body[flag] && node.source === 'import') {
        return problem(res, 409, 'imported-listing', `${node.id} is an unclaimed catalog import; the ${flag} mark needs a registered node`);
      }
      await store.setNodeFlag(node.id, flag, body[flag]);
      const updated = await store.getNode(node.id);
      sendJson(res, 200, { id: node.id, institutional: Boolean(updated.institutional), founding: Boolean(updated.founding) });
    }]),

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

    // AI Horde importer (admin): inline {status, reference}, or read the live public status (with the
    // Client-Agent the Horde asks for) and Haidra's text model reference. Nothing is sent to a worker.
    ['POST', '/v0/import/horde', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 20_000_000);
      const read = async (url, opts) => {
        const r = await safeFetch(url, opts, 60_000);
        if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
        return r.json();
      };
      const status = body.status ?? await read(HORDE_STATUS_URL, { headers: { 'client-agent': HORDE_CLIENT_AGENT } });
      const reference = body.reference ?? await read(HORDE_TEXT_REFERENCE_URL, {});
      sendJson(res, 200, await importHorde(store, status, reference));
    }],

    // OpenRouter per-provider importer with declared locations (admin): inline
    // {providers, models, endpoints: {modelId: [...]}}, or fetch the live APIs (one call per model).
    ['POST', '/v0/import/openrouter-providers', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 100_000_000);
      const json = async (url) => (await safeFetch(url, {}, 60_000)).json();
      const providers = body.providers ?? (await json(OPENROUTER_PROVIDERS_URL)).data;
      const models = body.models ?? (await json(OPENROUTER_URL)).data;
      const endpoints = body.endpoints ? new Map(Object.entries(body.endpoints)) : await fetchOpenRouterEndpoints(json, models);
      sendJson(res, 200, await importOpenRouterProviders(store, providers, models, endpoints));
    }],

    // Curated location seed (admin): inline {seed}, or re-import the bundled seeds.
    ['POST', '/v0/import/locations', async (req, res) => {
      if (!adminOk(req, res)) return;
      const body = await readJson(req, 10_000_000);
      const list = body.seed ? [body.seed] : loadLocationSeeds();
      const results = {};
      for (const seed of list) {
        results[seed.seed] = await importLocationSeed(store, seed);
        const i = seeds.findIndex((s) => s.seed === seed.seed); // /v0/locations reads site-only entries from here
        if (i < 0) seeds.push(seed); else seeds[i] = seed;
      }
      setSeedPlacements(store, seedPlacements(seeds));
      sendJson(res, 200, results);
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
        locations: '/v0/locations',
        map: mapTiles,
        signing_key: { ...registryKeys.publicJwk, kid: 'registry-1' },
        stage_c: Boolean(stageC),
        // How admission runs here (ONP-3 §4a). The schedule's next run times are never published.
        admission: {
          stage_b: 'registry schedule; POST /v0/nodes/{id}/admit is admin-only',
          schedule: schedule ? {
            stage_a_max_hours: Math.round(planner.options.stageAIntervalMs / 3_600_000 * 10) / 10,
            stage_b_max_days: Math.round(planner.options.stageBIntervalMs / 86_400_000),
          } : null,
          probe_corpus: corpus.summary(),
          proprietary_vendors: '/v0/vendors',
        },
        // What trust=trusted, policy.sensitive and each result's `pool` mean here (ONP-3 §5e).
        // server_location_checks: whether this registry runs them (§6.4); without them nothing hosted passes trusted.server_check.
        trust: { pools: ['trusted', 'open'], trusted, server_location_checks: Boolean(location) },
      });
    }],

    // The registry web app: OpenRouter-style discovery + ranking + node registration UI.
    ['GET', '/', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=300' });
      res.end(webApp);
    }],

    ...mcpRoutes(store, seeds, { onResult: (ids) => requests.count('mcp', ids), trusted }),
    ...exportRoutes(store, registryKeys),
    ...locationRoutes(store, seeds),
  ], { cors: true }); // public read API: third-party web clients may call it directly

  // ---- server-location checks (location.js) ----
  const asHolders = new Map();
  async function locateNode(nodeId) {
    const card = await store.latestCard(nodeId);
    // Behind a CDN the origin check asks the API for its model list with the key the probes carry
    // (authFetch), and counts declared origins only in a signed card.
    const key = (await store.getCustomerKey(nodeId)) ?? (await store.getProbeKey(nodeId));
    const signed = Boolean((await store.latestRevision(nodeId))?.sig_ok);
    // Declared origins must also reply to one prompt as the API does through the CDN (location.js
    // checkOrigins). Never corpus text: the check is labelled and the operator can set it off at will,
    // so a corpus prompt here would show them the identity references (corpus.js originPrompt).
    const comparisonPrompt = corpus.originPrompt();
    const result = await checkNodeLocation(card, { ...location, asHolders, key, signed, comparisonPrompt });
    await store.setObservation(nodeId, '_node', 'location', result);
    return result;
  }
  // A check covers only the card it was made for (search.js locationSummary): when the card now names
  // another API host, declared country or origin addresses, check again rather than wait for the sweep.
  async function relocateIfStale(nodeId, card) {
    const loc = (await store.getObservations(nodeId, '_node')).location;
    const host = (() => { try { return new URL(card?.endpoints?.openai).hostname; } catch { return null; } })();
    const declared = card?.node?.operator?.country ? String(card.node.operator.country).toUpperCase() : null;
    const originsChanged = JSON.stringify(declaredOrigins(card)) !== JSON.stringify(loc?.origin?.declared ?? []);
    const signedChanged = Boolean(loc?.origin) && (loc.origin.signed ?? true) !== Boolean((await store.latestRevision(nodeId))?.sig_ok);
    if (!loc || loc.host !== host || (loc.declared ?? null) !== declared || (loc.verdict === 'cdn' && (originsChanged || signedChanged))) await locateNode(nodeId);
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

  // A confirmed mismatch in a blind identity check makes Stage B due within the hour, on the timetable;
  // without one (ONP_SCHEDULE=0) Stage B runs only on admin request, so the mismatch is only recorded.
  const requestStageB = schedule ? (nodeId, card) => planner.stageBSoon(nodeId, card) : null;
  const stageCHandle = stageC ? startStageC(store, { safeFetch, fetchFor: authFetch, refreshCard, requestStageB, corpus, ...stageC }) : null;
  // Scheduled runs use the card already held when Stage C re-fetches cards on its own timer
  // (stagec.js cardSweep), so no card fetch announces them; without Stage C, Stage A re-fetches.
  const scheduleHandle = schedule ? startScheduler(store, planner, { stageA: (id) => stageAFor(id, { refresh: !stageCHandle }), stageB: (id) => stageBFor(id) }) : null;
  const reimportHandle = reimport ? startReimport(store, { safeFetch, ...reimport }) : null;
  const locationHandle = location ? startLocationSweep() : null;
  const actualPort = await listen(app, port, host);
  return {
    port: actualPort,
    origin: `http://${host}:${actualPort}`,
    store,
    registryKeys,
    /** Run one scheduler pass now (tests); null when the schedule is off. */
    scheduleTick: scheduleHandle ? () => scheduleHandle.tick() : null,
    /** Run one Stage C blind sweep, or one look for due follow-ups, now (tests); null when Stage C is off. */
    blindSweep: stageCHandle ? () => stageCHandle.blindSweep() : null,
    cardSweep: stageCHandle ? () => stageCHandle.cardSweep() : null,
    followUpTick: stageCHandle ? () => stageCHandle.followUpTick() : null,
    close: async () => {
      stageCHandle?.stop();
      scheduleHandle?.stop();
      reimportHandle?.stop();
      locationHandle?.stop();
      await closeApp(app);
      await requests.stop();   // writes the counts still in memory
      await store.close();
    },
  };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

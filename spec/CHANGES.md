# ONP specification changes

## Draft 0.1, revision 12 — 2026-11-19: the EU filter is a declaration, a gateway closed to web pages, blind probes that check identity

This revision answers the follow-up of 19 November to the security review by Mark Lindley, Two Minds (twomindsworks.com): the EU filter (follow-up point 2), the supply chain (3), the gateway (4), card-only listings (5), the 409 excuse (6) and the gap between Stage B runs (8), plus a Stage B gap found on the way, and the reviewer's request of 20 November that the way back in for CDN-fronted providers need its own evidence (S10). Point 1 is this release; point 7 (reference identity) is a deploy decision, below. It ships in the versions of revision 11: core 0.1.25, cli 0.1.34, registry 0.1.54, ollama-router 0.1.28, onp-node 0.1.10.

| # | Where | Change |
|---|---|---|
| S1 | ONP-3 §5; ONP-2 §3 | `jurisdiction` is the declared (or, for imports, inferred) operator country and MUST be presented as a declaration with its evidence level ("EU-declared operator, server front checked"); registries show `operator.country` as declared, with the server check's result. New search parameter `server_check=passed\|any` (400 `bad-query` otherwise), also `policy.server_check` in recommend |
| S2 | ONP-3 §5e | The trusted pool requires a passing server-location check (`match` or `same_region`). Clients apply the rule to published views that lack it; a registry without location checks has no hosted trusted offering |
| S3 | ONP-3 §6.4, §5c; ONP-2 §4 | Behind a CDN, a card may declare up to 4 `endpoints.origin_addresses`; the registry connects to each directly, requires a valid public certificate for the API host, and locates it like a front. All must pass, and they never override `mismatch` or `inconsistent`. A stored check counts only for the card's current API host, declared country and origin list |
| S4 | ONP-2 §5 | `data_policy` (retention, training) is a declaration; optional `data_policy.source` (URI of the published policy) and `checked` (date). Not yet a trusted-pool condition |
| S5 | ONP-3 §4a.9 | An excused `409` to a blind probe is followed by a fresh blind invocation against the new revision at a random time within the hour, under the same rules, so publishing a new revision to refuse a probe buys no quiet stretch |
| S6 | ONP-3 §4a.9, §4a, §6.3 | Light identity check: on `verified` and `attested` nodes some blind invocations ask one of the offering's identity references, in the same request shape and at the same times as the others. A confirmed mismatch makes Stage B due within the hour and never changes the tier itself; only Stage B disputes. Which invocations carried one is never published. Identity prompts SHOULD read like the other prompts |
| S7 | ONP-3 §4a probe load | Stage C blind invocations are sent at temperature 0 with at most 64 output tokens (was 32), plus the identity repeat and the follow-up after an excused `409` |
| S8 | ONP-3 §4a.4 | A `409` to an identity prompt in Stage B is excused only when a card re-fetch shows a new revision, a bounded number of times; the run then stops unjudged and runs again within the hour. With the current revision pinned it counts as a reply that does not match; beyond the bound the run ends as not passed, never as a dispute |
| S9 | ONP-3 §4, §4a | Card-only listings: probes that carry the dedicated probe credential give no `verified`. Stage B may pass such a node, but it stays at `community` until the registry holds access bought as an ordinary customer; then every probe uses that access and the next Stage B decides. The customer credential is never published, nor whether one was recorded |
| S10 | ONP-3 §6.4, §5e; ONP-2 §4 | The way back in behind a CDN needs its own evidence. Declared origin addresses count only in a signed card, as the operator's statement that the CDN forwards the API only to them. The registry asks `{openai}/models` through the CDN with the credential its probes carry; with no model list there, the check fails. Each origin must then answer the same request `200` with the same model ids, where any status below 500 counted before. |

The gateway changes below need no spec text: ONP-3 §5b already requires a client's local API to keep other web pages out and to require a credential for routes that show receipts or advice (revision 10, L4).

### Reference implementation changes

- `@opennodes/registry` 0.1.54:
  - EU filter: `server_check` filter; hosted results carry `jurisdiction.server_check` (`passed` \| `passed_origin` \| `cdn` \| `mismatch` \| `inconsistent` \| `unchecked`) and `jurisdiction.evidence`; recommendations and node detail carry `server_check`; `/v0/health` gains `trust.trusted.server_check: "passed"` and `trust.server_location_checks`. Origin-address checks for CDN-fronted cards: only in a signed card; the registry asks `{openai}/models` through the CDN and at each origin with the key its probes carry, and an origin passes only with `200` and the same model ids (`location.origin` gains `signed` and `front`); recording customer access checks again. The web app labels the filter "EU-declared operator" and has a "server front checked" switch.
  - Stage C: an excused `409` owes a follow-up blind probe at a random time within 0–55 minutes (kept in the private `schedule` table); about 1 in 4 blind probes of verified and attested nodes asks an identity reference (`IDENTITY_SHARE`), and a confirmed mismatch makes Stage B due within 50 minutes, at most once per node per 24 h; every Stage C chat call uses the identity request shape.
  - Stage B: a `409` to an identity prompt is excused only after a card re-fetch shows a new revision, at most 3 times since the last judged run (each recorded as `identity-409`); a run stopped by an excused `409` comes back at a random time within the hour (was 10 minutes twice, then about 7 days).
  - Card-only listings: `POST /v0/admin/nodes/{id}/customer-access` with `{"key": "…"}` or `{"key": null}` (admin token; 400 `bad-customer-key`); the key is kept in a private `customer_keys` table. A card-only listing that passes Stage B stays at `community` (result `held`); recording access makes Stage B due in 1–24 hours.
  - Web app: the qualification section states the new probe load, the `409` rule and the card-only rule; the claim guide says a listing probed only with its probe key stops at `community`.
- `@opennodes/core` 0.1.25: `access.js`, shared by the gateway and the Ollama router (`localAccess()`, `bearerCheck()` in constant time, `isJsonContentType()`, `newToken()`); the advisor and the trusted pool apply the server-check rule; the schema accepts `endpoints.origin_addresses` and `data_policy.source`/`checked` (older validators accept them too).
- `@opennodes/cli` 0.1.34, `onp gateway`:
  - Without `--token`, the model routes serve only this machine: the Host must be a local name (`127.0.0.1`, `localhost`, `*.localhost`, `host.docker.internal`, the machine's name; more with `--allow-host`), or 403 `host-not-allowed`; a browser Origin must be a localhost page, a desktop app shell (`app:`, `tauri:`, `vscode-webview:`, `vscode-file:`) or one named with `--allow-origin`, or 403 `origin-not-allowed`. `*` and `null` cannot be allowed. With `--token`, every request needs it.
  - `/gateway/receipts`, `/gateway/advice` and `/gateway/reputation` need a token: `--token`, or one the gateway keeps in `~/.opennodes/gateway-token` (mode 0600). Library: `apiToken`, `gw.apiToken`.
  - Every POST needs `content-type: application/json`, or 415 `unsupported-media-type`.
  - Provider key variables are used only with `--env-keys` (library: `envKeys: true`); at start the gateway names the ones it found and left unused. `onp check` is unchanged.
  - Refusals and help name the filter "EU-declared operator". `onp mcp --print-config` prints the npx command pinned to its own version.
- `@opennodes/ollama-router` 0.1.28: uses the core access helpers (no change in behaviour); applies the trusted-pool server check.
- `onp-node` 0.1.10 (Node Kit): `[node] origin_addresses` and `[data_policy] source`/`checked` pass into the card; the README's card-only section says such a listing stops at `community` until the registry has customer access.
- Supply chain:
  - The Claude Code plugin runs `@opennodes/cli@0.1.33` instead of `@0.1`. Install lines in the READMEs, `docs/`, the site, the Cursor rule, the plugin and the root `Dockerfile` name exact versions: the latest published one, except a package's own README, which names the version it ships in. `server.json` names cli 0.1.34. `deploy/pin-versions.mjs` re-pins them at each release; its `--check`, part of `npm test`, refuses an unpinned or partial version.
  - CI pins every action by commit SHA, installs `npm@12.2.3`, uses `npm ci` and `build==1.6.1`, and checks `mcp-publisher` v1.8.9 against its SHA-256. A tag push publishes the npm packages only; onp-node goes to PyPI in a separate, manually started run (target `pypi`), after the registry deploy.
- Site and docs: the EU page and `docs/05` describe the filter as a declaration with its evidence level and add "Personal data only to trusted operators"; until the registry deploy, the server-check parts say "from registry 0.1.54". The receipt claim is corrected: Node Kit nodes sign a receipt for every response; card-only listings return none, and a missing receipt is accepted and logged. The problems page lists the codes added in revisions 11 and 12.
- `@opennodes/fixture-node`: `calls`, `dodge`, `swapModel`, `perturb`, `refuseRepeats`.
- Tests: `gateway-access.test.js`, `install-pins.test.js`, new scenarios in `admission.test.js` (revision-bump dodge, model swap after passing, Stage B `409` refusals, card-only listings), the EU-filter tests and the origin-check tests (decoy origins, keyed APIs, unsigned cards, a TLS server, an answer that never ends). `npm test`: 212 tests, 211 pass, 1 skipped (opt-in real Postgres).

### Compatibility

- Gateway users (cli 0.1.34): provider keys in the environment need `--env-keys`; the three `/gateway/*` routes need the kept token or `--token`; a POST without `application/json` (such as `curl -d`) gets 415; without a token, a reverse proxy, a tunnel or another host name needs `--allow-host`, and a browser extension or another web origin needs `--allow-origin` (a `file://` app needs a token). New: localhost pages and desktop app shells can read the gateway's replies.
- Operators behind a CDN: origin addresses count only in a signed card, and each origin must answer `{openai}/models` with the same model list as the API gives through the CDN, to the registry's customer access or probe key; a `401` or another page no longer passes.
- Operators: blind calls at temperature 0 with up to 64 output tokens; about 1 in 4 on verified nodes asks an identity prompt; one more probe within the hour after an excused `409`; in Stage B a `409` with the current revision pinned counts against identity; card-only listings top out at `community` until the registry records customer access. No field was renamed; the new card fields are optional.
- Clients older than core 0.1.25 do not apply the server check when a request names an offering directly: publish core together with registry 0.1.54.

### Release order

1. npm: core 0.1.25, cli 0.1.34, registry 0.1.54, ollama-router 0.1.28 (a `v*` tag push publishes npm only); then `node deploy/pin-versions.mjs` and the MCP Registry.
2. Registry deploy: back up; put the private probe corpus on the server (`ONP_PROBE_CORPUS`), with identity prompts that read like its chat prompts; `ONP_LOCATION=1` stays set; deploy 0.1.54.
3. Reference nodes (follow-up point 7): no references are captured from the project's own deployments. `io.opennodes.helsinki` and `io.opennodes.demo-node` drop to `community` and stay there until references are captured from the public weights on a machine that serves no node. This replaces the same-day capture planned in revision 11.
4. PyPI: onp-node 0.1.10 by a manual run with target `pypi`; re-pin.
5. Site: the "from registry 0.1.54" statuses on the EU page and in `docs/05` become "Live".

## Draft 0.1, revision 11 — 2026-11-19: admission the operator cannot time, avoid or clear

The security review by Mark Lindley, Two Minds (twomindsworks.com) of 18 November 2026 (sections 4.2, 4.3, 4.3a and 4.6) found that the admission battery could be timed, avoided or cleared: Stage B ran only when anyone called an unauthenticated endpoint, a missing identity reference counted as a pass, the identity and probe prompts were fixed and public, a disputed node cleared itself by registering again, blind probes could be answered with `409` unnoticed and never cost a tier, and an unsigned card could reach `verified`. Revision 10 closes these before the first third-party operator is admitted. It does not change how identity is compared (exact text, Draft 0.1); log-probability and behavioural comparison stay planned for Draft 0.2.

| # | Where | Change |
|---|---|---|
| R1 | ONP-3 §4, §4a | Stage B runs on the registry's own schedule: after a node reaches `community`, after a change to a tested offering's model, serving or hardware block or to the API endpoint, and at least quarterly, at times the registry does not publish. A registry MUST NOT let the operator or a third party choose when it runs; its administrator MAY run it. Stage A re-runs at least every 6 h |
| R2 | ONP-3 §3, §4 | `disputed` survives registering again, a fresh challenge and a card re-fetch; it ends only with a resolution the registry records in the listing history. Registering again no longer resets a listed node's tier or moves its Stage B |
| R3 | ONP-3 §4a.4 | No identity reference means identity unverified, never a pass: no `verified` on it. References are captured by the registry with prompts from its private corpus; each run asks a random subset; a mismatch is asked once more before it counts |
| R4 | ONP-3 §6.3, §2; ONP-2 §5 | The vendor-namespace rule is specified in full and enforced: a vendor-namespace table (`GET /v0/vendors`); a slug the catalogue already uses only from the domain its imported listings are served from (routers excluded); otherwise only the node's own namespace. A claim from another namespace stays `unverified`. Open-weight models MUST be named by their public record |
| R5 | ONP-2 §5, schema | New artefact scheme `ollama:{name}[:{tag}]` (the Ollama library; the tag names the quantization). Additive in meaning, but a validator with the old schema rejects it: see the release order below |
| R6 | ONP-2 §8, ONP-3 §4a | "Unsigned" means a signature that does not verify against the origin's key. No `verified` for such a card; a `verified` node whose re-fetched card fails verification is demoted. An unreachable key set does not count as a failure |
| R7 | ONP-3 §4a | Probe prompts come from a corpus the registry keeps private and never identify themselves; identity prompts MUST NOT be published. The probe-load disclosure states amounts, never prompts or run times |
| R8 | ONP-3 §4a.9 | Every `409` to a blind probe is recorded. It is excused (card re-fetched, one retry) only when the revision really changed, a bounded number of times a day; any other counts as a failure. Repeated blind failures while the node answers its health checks cost it a tier |

### Reference implementation changes

Versions, in lockstep: core 0.1.25, cli 0.1.34, registry 0.1.54, ollama-router 0.1.28, onp-node 0.1.10.

- `@opennodes/registry` 0.1.54:
  - `POST /v0/nodes/{id}/admit` requires the admin token (loopback only without one). `admitCooldownMs` / `ONP_ADMIT_COOLDOWN_MS` are gone. `409 stage-b-running` when a run is in progress.
  - The schedule (`schedule.js`, private `schedule` table): Stage A for registered nodes from `indexed` up, at least every 6 h (75–100% of it per gap) and on every new revision, after a card re-fetch; Stage B 1–24 h after a node reaches `community`, within 1 h of a change to a tested offering's `model`/`serving`/`hardware`/`binding`, the node's `hardware` or `endpoints.openai`, 7 days after a run that did not pass, and after a pass at a uniformly random time 1–91 days later. Nodes verified before the upgrade get their first scheduled Stage B 1–7 days after it. `schedule` option, on in `bin.js` unless `ONP_SCHEDULE=0`; `ONP_STAGE_A_MS`, `ONP_STAGE_B_MS`. The next run times are in no API or export.
  - Stage A: new check `artifact-namespace`. A listed node that fails a structural check (`card-consistency`, `artifact-namespace`, `tested-offerings`, or `models-agreement` with `/models` answering 200) returns to `indexed`; health and blind-call failures are left to Stage C. `PUT /ping` runs the same rules (an `indexed` node that now passes goes to `community`) and is rate-limited like registration.
  - Stage B: identity `unverified` (not ok, not a dispute) with no usable reference; legacy references captured with the old public prompts are ignored, and so are those made with the built-in corpus once a private one is set. `signed: false` refuses the run before anything is sent (`reason`). A failed re-run demotes `verified` to `community` with the reason. A mismatched identity reply is asked once more (`retried`). The context probes' number is random, and the haystack and question come from the corpus.
  - `POST /v0/fingerprints/capture` stores 8 references (`IDENTITY_CAPTURE`) from the corpus, replacing the artefact's earlier ones unless `{"replace": false}`, and takes an optional `artifact` (capture under the name a node is about to switch to). The prompts are never returned.
  - Disputes: `/verify` on a disputed node re-indexes its card and answers `409 disputed`; `POST /v0/admin/nodes/{id}/resolve` with `{"resolution": "…"}` (400 `missing-resolution`, 409 `not-disputed`). `/verify` keeps a listed or suspended node's state and its Stage B schedule.
  - Vendor table: `src/data/proprietary-vendors.json` (built-in pins: openai, anthropic, google, mistral, cohere, deepseek, xai), admin entries, then the catalogue: every other slug used by an imported listing, bound to the listings' API hosts (`ROUTER_HOSTS` excluded) and admitted from a node whose domain contains one of them. `GET /v0/vendors` (catalogue entries carry `hosts`), `POST /v0/admin/vendors/{vendor}` with `{"namespaces": [...]}` or `null`, store table `vendor_namespaces`.
  - Signatures: a definite failure (no signature, no key, bad signature) on re-index demotes a `verified`/`attested` node to `community`; a JWKS fetch failure keeps the earlier result for the same card bytes. `refreshCard` re-checks a revision whose signature was not verified yet. Node detail adds `signature_verified`.
  - Probe corpus (`corpus.js`): `probeCorpus` option / `ONP_PROBE_CORPUS` (JSON: `chat`, `identity`, `filler`, `needles`; a private corpus must bring all of them). Without it, a small public development corpus, and a start-up warning. `/v0/health` adds `admission` (`stage_b`, `schedule`, `probe_corpus` with `private` and sizes, never contents).
  - Stage C: blind probes take their prompt from the corpus and also need string content. A `409` is recorded: with the current revision pinned, a failure; after a real revision change, `blind-409` and one retry, at most 3 a day (`maxExcused409`), beyond which a failure. 3 consecutive failed blind probes since the last state change (`blindFailThreshold`), with the health endpoint answering, demote one tier. `blind-409` records are not checks in the search pass rate.
  - Store: `schedule` and `vendor_namespaces` tables; `latestRevision`, `clearFingerprints`, `getSchedule`/`setSchedule`, `vendorNamespaces`/`setVendorNamespaces`, `countProbes`, in both drivers.
  - The Ollama library importer writes `ollama:{name}` instead of `urn:proprietary:ollama:*`.
  - Web app: the qualification and probe-load sections describe the schedule, the corpus, references, 409s and demotion; the registration page no longer offers "Run Stage B".
- `@opennodes/core` 0.1.25: the schema accepts `ollama:` artefacts. `@opennodes/cli` 0.1.34 and `@opennodes/ollama-router` 0.1.28 pin core 0.1.25, so that they accept such cards (both carry further changes in revision 12).
- `onp-node` 0.1.10 (Node Kit): an Ollama model's artefact is `ollama:{name}` (or `hf:{org}/{repo}` for a `hf.co/…` pull), a Hugging Face id `hf:{id}`; `artifact` in `[model."<id>"]` overrides; the `urn:proprietary:{own namespace}:…` fallback remains only for a bare id on another engine, and `serve` and `card` warn that such an offering cannot be verified.
- `@opennodes/fixture-node`: options `artifact`, `badSignature`; `setBadSignature()`, `setContextWindow()`, `answer409(n, {newRevision})`, `prompts`. Its context answer looks for the 8-digit number, whatever the wording.
- `deploy/registry`: `ONP_PROBE_CORPUS` and `ONP_SCHEDULE` in the compose file, `probe-corpus.example.json` (format only); `probe-corpus.json` is git-ignored.
- Tests: `impl/test/admission.test.js` (15 tests); `stageb`, `namespace`, `founding`, `trusted-pool`, `untested-profiles` and `pii-wiring` capture references before expecting `verified`; Node Kit `tests/test_config.py` (4 tests).

### Release order and compatibility

- `OnpClient.resolveCard` (cli) and the Ollama router's LAN discovery validate cards with the schema. Before core 0.1.25 they refuse a card with an `ollama:` artefact: cli 0.1.33 and older refuse it, and ollama-router 0.1.27 and older treat such a LAN node as plain Ollama. Publish core, registry, cli and ollama-router first, and onp-node 0.1.10 after them.
- The hosted registry image (`deploy/registry/Dockerfile`) stays pinned to 0.1.52 until the deploy below.
- Hosted registry: the two verified reference nodes declare `urn:proprietary:opennodes:*` artefacts with no usable reference (any reference the hosted registry holds was captured with the old public prompts, which revision 11 ignores). Without a fresh capture they drop to `community` at their first scheduled Stage B, 1–7 days after the upgrade. Revision 12 decides to let them drop and capture references independently (its release order, step 3).

## Draft 0.1, revision 10 — 2026-11-19: the user's own network means a pinned LAN peer

This revision answers the two High findings on the Ollama router in the security review by Mark Lindley, Two Minds (twomindsworks.com) of 18 November 2026 (section 4.11). First, any web page could add a "LAN" peer, read receipts and spend the user's keys. Second, an mDNS peer with any origin counted as the user's own network for private, EU and sensitive routing.

| # | Where | Change |
|---|---|---|
| L1 | ONP-3 §5b, §5e | A LAN peer is the user's own network only when the user pinned the key that signs its card and the peer answers at the origin that card names, so a copied card served elsewhere is not pinned. The client checks this again whenever it reloads the card. Only a pinned peer satisfies `region`, `jurisdiction`, a private-only preset and §5e item 2. A peer added by address alone, or a plain server with no card, is an offering of unknown operator, location and data policy, and it ranks as `unverified` |
| L2 | ONP-3 §5b | A missing `data_policy` is unknown. It is never read as `retention: none` or `training_on_inputs: false` |
| L3 | ONP-3 §5b | Discovery is off by default, and a discovered peer is used only when it is pinned. An advertised origin on another host than the sender is ignored. LAN peers are invoked at the origin the client reached |
| L4 | ONP-3 §5b | A client's local API: no wildcard CORS. Routes that add peers or show the catalogue, receipts or advice need a credential. Model routes may serve the same machine without one, given a loopback Host and a local or allowed Origin. A client listening on other interfaces needs the credential from other machines |

### Reference implementation changes

- `@opennodes/ollama-router` 0.1.27:
  - **Access:**
    - The router no longer sends `Access-Control-Allow-Origin: *`.
    - `/router/*` needs `authorization: Bearer <token>`. The token comes from `--token` or `ONP_ROUTER_TOKEN`, else the router keeps one in `~/.opennodes/ollama-router-token`. The library returns it as `router.token`.
    - The Ollama and OpenAI routes serve this machine without the token when two things hold. The Host must be a local name: loopback, `localhost`, `host.docker.internal`, the machine's name, or one added with `--allow-host`. Any Origin must be a local page, a desktop app shell that Ollama also accepts (`app:`, `tauri:`, `vscode-webview:`, `vscode-file:`), or one added with `--allow-origin` or `ONP_ROUTER_ORIGINS`. `*` and `null` are refused.
    - `--public-bind` refuses to start without `--token`. Requests from other machines then need the token on every route.
  - **mDNS** is off by default and turned on with `--mdns`. `--no-mdns` is still accepted and changes nothing. The TXT `origin` is used only when it names the host that sent the answer. Answers from outside private and link-local ranges are ignored. A discovered node is used only when it is pinned; otherwise it is listed under `discovered` in `/router/catalog`, with its key and its card's endpoint.
  - **Pinning:**
    - The router takes `--pin <thumbprint>` (RFC 7638), `POST /router/peers {"origin", "pin"}` and `--show-pin <origin>`.
    - A pin holds only when the card is signed by the pinned key and the peer answers at the origin its card names in `endpoints.openai`, however the peer was added. `POST /router/peers` with a pin refuses (`422`) a card signed by another key or served away from its origin.
    - Peers carry `source` (`added` or `mdns`), `pinned` and `key`. `/router/catalog` lists `peers`, `discovered`, `pins` and `mdns`, and marks each LAN model `pinned`.
    - The pin is checked again each time the catalogue is reloaded (every 30 s while in use). A card signed by another key loses the pin.
  - **LAN entries:**
    - A LAN card has no default data policy.
    - A plain Ollama peer no longer carries `local` or a data policy.
    - ONP peers are invoked at the reached origin, keeping the card's path.
    - Receipts from a LAN node are verified with the key that signed its card.
  - **Routing:** `auto-private` uses this machine and pinned peers only. `auto-<jurisdiction>` and sensitive requests leave unpinned peers out, and a sensitive request to one by name gets `403 … LAN peer not pinned by its card key`.
- `@opennodes/core` 0.1.24:
  - New `onOwnNetwork(offering)`. Tier `lan` counts as the user's own network only with `lan.pinned: true`. Otherwise it ranks and filters as `unverified` in `recommend`, the embedder ranking, `inRegion` and `trustGaps`, which gains the gap `LAN peer not pinned by its card key`.
  - New `jwkThumbprint` (RFC 7638) and a `before` hook in `createApp`.
  - `needsMasking` still exempts every LAN peer (see the known gaps below).
- `@opennodes/cli` 0.1.33 and `@opennodes/registry` 0.1.53 only move to core 0.1.24; their behaviour is unchanged. The hosted registry stays on 0.1.52 (`deploy/registry/Dockerfile`).
- Tests: `impl/test/router-lan-trust.test.js` (10 tests). The existing router, advisor and trusted-pool tests are updated for the token and the pinned mark.
- **Compatibility (router users):**
  - Scripts that read `/router/*` or add peers must send the token.
  - `--public-bind` needs `--token`, and apps on other machines must send it. Many Ollama apps cannot send a bearer header.
  - LAN discovery needs `--mdns` plus a pin.
  - Peers added with `--peer`, and every plain Ollama peer, no longer serve `auto-private`, `auto-<country>` or sensitive requests. A plain Ollama server cannot be pinned; put a Node Kit node in front of it.
  - A Node Kit node whose card names a public URL, but which the router reaches by its LAN address, cannot be pinned. Set its `--public-url` to the LAN address, or add it at the origin its card names.
  - Added peers rank as unverified, so plain `auto` may prefer a public node over them.
  - Requests without the token are refused when the Host is not a local name, for example behind a reverse proxy or when the router is reached by the machine's LAN address.
  - A browser origin other than a local page or an app shell needs `--allow-origin`.
  - In `@opennodes/core`, `tier: 'lan'` without `lan.pinned: true` no longer counts as the user's network.
- Known gaps:
  - LAN traffic is still never PII-masked. Peers are now only the ones the user added or pinned. Masking plain Ollama peers would drop native Ollama options and refuse images on the passthrough path. Masking unpinned ONP peers is a possible follow-up.
  - A pin authenticates the card, not each response. Over plain HTTP, an attacker on the network path who takes over a pinned peer's address receives its requests. The failed receipt check is logged only afterwards. TLS would close this.
  - `--show-pin` needs Node.js on the node's machine, which runs the Python Node Kit. Running it over the LAN is trust on first use. The Node Kit should print its own thumbprint.
  - The gateway's loopback Host and Origin check (review 4.11, Medium) is separate work.

## Reference implementation — 2026-11-10: PII masking and a Ukrainian location seed (no spec change)

- PII masking before the open pool, in `@opennodes/core` 0.1.23 (`pii.js`), `@opennodes/cli` 0.1.32 (gateway and `onp invoke`) and `@opennodes/ollama-router` 0.1.26. Design and limits: `docs/pii-masking.md`.
  - Before a request goes to an open-pool offering, the client replaces the personal data it finds with placeholders (`[[EMAIL_1]]`) and puts the values back in the answer, streamed or whole. The vault is in memory for one request and never logged or sent.
  - Detection runs on the user's machine: built-in rules (e-mail, phone, Luhn-checked cards, IBAN, SSN, SIN, postal codes, public IPv4, labelled identifiers), plus optionally a local Presidio service (`ONP_PII_SERVICE`) or a local model (`ONP_PII_LLM`). A detector URL off this machine or the private network is refused.
  - `--mask-pii open` (default) `| all | off`, `ONP_MASK_PII`, and the `onp-mask-pii` header, which can ask for more masking but not less.
  - Masking never makes a request trusted: sensitive requests still go to the trusted pool only (revision 8). Receipts hash the masked bytes actually sent.
  - Tests: `impl/test/pii.test.js`, `impl/test/pii-wiring.test.js` (22 tests).
- `@opennodes/registry` 0.1.52: location seed `locations-ua.json`, six Ukrainian data centres and GPU clouds. Site-only (none serves models through a public API, so none becomes a node), and no finer than the operator publishes: a city or only the country, never an address. `@opennodes/core` 0.1.23 adds a country point for UA.

## Draft 0.1, revision 9 — 2026-11-09: verification covers only tested profiles

| # | Where | Change |
|---|---|---|
| V1 | ONP-3 §4a, §5 | Verification covers only binding profiles that have a defined battery (today `onp.openai.chat/v1`): other offerings never inherit their node's tier (capped to `unverified`, `tested: false`), and a node with no offering the battery can call passes neither Stage A nor Stage B |

- Fixes a reference-registry bug. A node whose offerings were all speech, embeddings or images reached `community` without a functional call. Stage B then passed it to `verified` with nothing measured, and it could enter the trusted pool. Mixed nodes passed their tier on to offerings no test had called.
- `@opennodes/registry` 0.1.52, changes:
  - `TESTED_PROFILES` in `probes.js`;
  - Stage A fails a card with no tested profile (`tested-offerings`), so the node stays `unverified`;
  - Stage B returns `ok: false` with `reason` and lists `untested`;
  - Stage C records `blind_skipped` instead of skipping silently;
  - search adds `tested` and the tier cap;
  - node detail, the export feed and MCP `get_node` carry `verification`;
  - the web app shows an UNTESTED chip, a "tested" row on node pages and a coverage note on the qualification page.
- `@opennodes/core` 0.1.23: `summarizeNode` adds `tested` per offering when the registry sends `verification`.
- `@opennodes/fixture-node`: `offerings` option (`chat`, `embeddings`, `speech`) and `setOfferings()`.
- Tests: `impl/test/untested-profiles.test.js` (4 tests).

## Draft 0.1, revision 8 — 2026-11-09: trusted and open pools

Operators outside the EU, the EEA and Canada, including China-based providers, may list. Revision 8 separates what a client may send them. The open pool is every listing, for tasks with no personal data and no security requirement. The trusted pool is for personal data and sensitive work. Revision 8 is additive: existing queries return what they did, plus a `pool` label.

| # | Where | Change |
|---|---|---|
| T1 | ONP-3 §5 | Data-policy filters `retention=none\|ephemeral\|logged` (at most this retention; an unknown value counts as `logged`) and `no_training=true`. An offering without a `data_policy`, or without the field read, fails either filter |
| T2 | ONP-3 §5, §5c | Strict lineage: `lineage=declared` drops offerings, and `/v0/locations` models, that declare no `lineage_origins`; with `exclude_lineage=CN` it is a strict origin policy |
| T3 | ONP-3 §5e, §5 | The trusted view, as one filter `trust=trusted`: declared lineage without CN; and, for hosted offerings, tier `verified` or higher, an operator in a trusted jurisdiction, and `retention: none` with `training_on_inputs: false`. Models on the user's own machine or LAN need only the lineage rule. Every offering summary and recommendation carries `pool: "trusted" \| "open"` |
| T4 | ONP-3 §5e | Trusted jurisdictions are the registry's choice, published in `/v0/health` as `trust.trusted`. Reference default `EU,CA`, set by `ONP_TRUSTED_JURISDICTIONS` (Switzerland, the UK and Ukraine are undecided) |
| T5 | ONP-3 §5b | Recommend `policy.sensitive: true` (or `trust: "trusted"`): trusted pool only, under the registry's own view, which the request cannot replace; the response carries `trusted_view` |
| T6 | ONP-3 §5e | Sensitive requests in clients: trusted pool only, under the client's own view, checked again before sending, never falling back to the open pool; answers that do not show the trusted view are refused |
| T7 | ONP-3 §5 | Unknown values of `trust`, `lineage`, `retention` or `no_training` are answered with `400 bad-query`, not ignored |

### Reference implementation changes

- `@opennodes/core` 0.1.23: `meetsDataPolicy`, `lineageAllowed`, `trustedView`, `inTrustedPool`, `trustGaps` (why an offering is open, in words), `poolOf`, `wantsTrusted`, `sensitiveHeader`, `trustedJurisdictionsFrom`, `RETENTION_LEVELS`, `DEFAULT_TRUSTED_JURISDICTIONS`. `recommend` and the embedder ranking take `policy.sensitive` / `policy.trust` and `policy.trusted` (the host's view); they reject offerings outside the pool (`rejected.trust`) and label every candidate with `pool`. New auto model `auto-sensitive`. The MCP tools take `trust`, `lineage`, `retention` and `no_training` (search_offerings), `lineage` (find_locations) and `policy.sensitive` (recommend). `summarizeNode` passes `founding` (revision 7).
- `@opennodes/registry` 0.1.52: the filters in `/v0/offerings`, estimate `select` and the MCP tools; `lineage=declared` in `/v0/locations` and `find_locations`; `pool` on every offering summary; `trust.trusted` in `/v0/health`; `policy.sensitive` in `/v0/recommend` and MCP `recommend`, always under the registry's view; `trustedJurisdictions` option and `ONP_TRUSTED_JURISDICTIONS`; `400 bad-query` and `400 bad-policy`.
- `@opennodes/cli` 0.1.32:
  - `OnpClient` takes `policy.sensitive` and `policy.trusted_jurisdictions`, and adds `checkTrusted` and `trustGapsOf`; `checkPolicy` refuses an open-pool offering for a sensitive request;
  - the gateway takes `--sensitive` (every request), the `onp-sensitive: 1` header (one request) and `onp/auto-sensitive`. Routing, fallbacks and named offerings stay in the trusted pool. A named open-pool offering is refused with `403 policy-refused`; an auto or virtual model with nothing trusted answers `404 no-trusted-offerings`. Nothing is sent in either case;
  - the stdio MCP server takes `--sensitive` / `ONP_SENSITIVE=1`, or `policy.sensitive` per task. It narrows search and recommend to the user's trusted jurisdictions, filters search results again on its side, and refuses a recommend answer without `trusted_view` (a registry before 0.1.52);
  - `onp search` takes the new filters and prints each pool; `onp invoke --sensitive` refuses an open-pool offering.
- `@opennodes/ollama-router` 0.1.26: `--sensitive` / `ONP_SENSITIVE=1`, the `onp-sensitive` header and `auto-sensitive`. Open-pool entries are refused before anything is sent (`403`), with the reason; `auto-sensitive` with nothing trusted answers `404`. `/router/catalog` shows each model's pool and the router's trusted view.
- `@opennodes/fixture-node`: `lineage` option (declares `model.lineage_origins`).
- Known gaps and consequences:
  - Hardly anything declares lineage yet. Only the curated Canada and Europe seed models do, and they are listing-only. The two reference nodes, and the local and LAN models in the gateway and the router, declare none. So the trusted pool stays empty until verified nodes put `lineage_origins` in their cards, and local models do not qualify for sensitive requests.
  - A prompt that the advisor itself flags as personal (`features.privacy: sensitive`, from cues such as e-mail addresses or IBANs) still checks only the data policy, as before. Applying the whole trusted view to it is a decision left open.
  - The Ollama router's `/api/embed` passes straight to the local Ollama and does not apply the mark.
- Problem types: `no-trusted-offerings`, `bad-policy`.
- Tests: `impl/test/trusted-pool.test.js` (9 tests).
- Versions: core 0.1.23, cli 0.1.32, registry 0.1.52, ollama-router 0.1.26.

## Draft 0.1, revision 7 — 2026-11-09: operator marks, request counts, published probe load

Before a registry recruits its first operators, three questions need an answer in the protocol: which labels a registry may put on a node, how often it showed the node to clients, and what its probes cost the node. Revision 7 is additive: no card or client changes meaning.

| # | Where | Change |
|---|---|---|
| F1 | ONP-3 §4b, §4 | Operator marks: `institutional` and the new `founding`. Set by the registry, not lifecycle transitions, never rank inputs, never a shortcut through §4a, and only on registered nodes with a verified namespace. Published as booleans in `/v0/nodes`, node detail and search results |
| F2 | ONP-3 §6.6, §2 | Request counts: per node, ISO week and surface (`search`, `recommend`, `mcp`), each response counting a node once. No query, task, prompt, features or client identifier is stored with them. Counts used in rank must be a published component. Optional `GET /v0/stats/requests` |
| F3 | ONP-3 §4a | Registries SHOULD publish the probe load of each stage: requests, sizes, cadence and triggers |

### Reference implementation changes

- `@opennodes/registry`:
  - `POST /v0/admin/nodes/{id}/institutional` and `POST /v0/admin/nodes/{id}/founding` (admin token), with body `{"institutional": true|false}` or `{"founding": true|false}`. Errors: 400 `bad-flag`, 404 `unknown-node`, and 409 `imported-listing` when setting a mark on an unclaimed import (clearing always works). Marks survive re-registration and re-import and leave `updated_at` and the listing history alone;
  - `founding` in `/v0/nodes`, node detail, every offering summary (search, MCP `search_offerings` and `get_offering`) and MCP `get_node` on both MCP servers (core's `summarizeNode`, core 0.1.23). Node detail's `institutional` is now a boolean (it was 0 or 1);
  - store: a `founding` column, added in place to existing SQLite and Postgres databases; a `request_counts` table; `setNodeFlag`, `addRequestCounts`, `requestCounts`;
  - request counts (`src/counts.js`), kept in memory and written every 60 s, before each read and at shutdown: `request_counts` in node detail, and `GET /v0/stats/requests`;
  - web app: FOUNDING and institutional chips in the catalog list and rows, on the model page, rankings, the Nodes page and the node page. The node page shows how often the node was returned this week, last week and over 12 weeks;
  - qualification page: a new "Probe load" section lists what each stage sends. The Stage A text said "Re-run every 6 hours and on every card revision"; it now says what the code does (at verification and on each `PUT /v0/nodes/{id}/ping`). The principle "the registry stays within [the probe allowance] or pays like any client" is replaced: the registry does not read `payment.probe_allowance` and does not pay for probes;
  - `stageb.js` exports `CONTEXT_FRACTIONS` and `CAPACITY_RAMP`, `stagec.js` exports `LIVENESS_INTERVAL_MS`, `BLIND_INTERVAL_MS` and `JITTER`, and `bin.js` uses them. A test holds the qualification page to these values, and another counts the chat calls the fixture node receives in Stage A (1) and Stage B (17 without reference fingerprints, 20 with).
- Known gaps: Stage A has no timed re-run, although §4a asks for one every 6 h and on every card revision (a new revision seen by Stage C is re-indexed without Stage A). The probe allowance a card declares is not read.
- Problem types: `bad-flag` and `imported-listing` added to `site/problems/`.
- Tests: `impl/test/founding.test.js` (7 tests); store conformance covers marks and counts on both drivers.
- Versions: registry 0.1.52. `deploy/registry/Dockerfile` still pins the published 0.1.51; move it when 0.1.52 is published.

## Draft 0.1, revision 6 — 2026-11-03: curated seed placements in search

Revision 4 kept curated seeds out of search, and revision 5 made recommend reject offerings with no known location. Together they left every callable listing out of a region request, including providers whose whole API runs in one documented place. Revision 6 lets a seed supply that place, labelled as such.

| # | Where | Change |
|---|---|---|
| S1 | ONP-3 §5c, §5, §5a | When a seed entry that describes existing nodes says every model is served from every listed site (`placement: "all"`), or names an entry whose sites serve the node's whole API (`serves_from`), search and recommend use those live sites for offerings whose card declares no location. Each location is marked `via: "seed"` and keeps its `claimed` or `documented` basis. A card's own locations always win |
| S2 | ONP-3 §5c | No seed placement for listings reached through a third-party router (Hugging Face router, OpenRouter): the request passes through the router first |

### Reference implementation changes

- `@opennodes/registry`: `seedPlacements` (locations.js) and `setSeedPlacements` (search.js), set at start and on each seed import. The world seed gains `serves_from` for five providers that document a single-region API: Scaleway (Paris), OVHcloud (Gravelines), STACKIT (Germany), Berget (Sweden) and Infomaniak (Switzerland). The 10 world entries that already had `placement: "all"` count too: Alibaba Model Studio (China), Volcengine Ark, DeepSeek, Upstage, Sarvam, Moonshot (global), Z.ai (global), CloudFerro Sherlock, SCX and Pendra. Hyperscalers, Mistral, Nebius and Regolo are not placed: where a model runs depends on the region or endpoint chosen, or is not stated.
- Tests: `impl/test/residency.test.js` (seed placements in search and recommend; `serves_from` references resolve).
- Versions: registry 0.1.47.
- Registry 0.1.48 (no protocol change): `GET /v0/nodes` adds `serves` for each node: the countries its card declares, else those of its seed sites and linked seed entries, or a `label` saying why there are none (`local`, `router`, `not_published`, `not_declared`, `unknown`). The Nodes page reads it instead of the card alone. The seeds add Groq's Kamloops site to Groq's own entry and the two OpenNodes reference nodes.
- Registry 0.1.49: the reference nodes lose `placement: "all"`, so they stay on the map and the Nodes page but out of region search and recommend, where in 0.1.48 they took shortlist places from hosted providers. A loopback endpoint counts as `local` only for a node with no seed entry (Privatemode's endpoint is a client-side proxy to a hosted service).
- Core 0.1.22, cli 0.1.31, registry 0.1.50, ollama-router 0.1.25 (no protocol change): with no `local_memory_gb`, recommend scores catalogue local models at the largest size a typical 16 GB laptop can run and leaves out those with no such size (`rejected.memory`). Each scored model's `local_fit` says `scored_at` and `assumed_memory_gb`; `pick` stays empty. Models on the user's own machines (tiers `local`, `lan`) and callers that pass a budget are unaffected. Previously a free 671B model scored as if anyone could run it and led every shortlist.
- Registry 0.1.51: on the Where page the Site column shows the site name in bold, then a space and the description in small italics. "Run by" and the note are now separated by a full stop; they used to run together.

## Draft 0.1, revision 5 — 2026-11-03: EU and EEA in region matching

Revision 4 let a residency scope of `EU` or `EEA` cover the member states, but search still read `EU` as a plain code that contains only `EU-…`, so `region=EU` missed offerings served from Frankfurt or Paris. Revision 5 uses one containment rule for both.

| # | Where | Change |
|---|---|---|
| E1 | ONP-2 §3 | `EEA` accepted as a region code. `EU` and `EEA` contain their member states and those states' subdivisions, and `EEA` contains `EU`: `EU` is met by `DE-HE`, not by `NO`, `CH` or `GB`; `EEA` is met by `NO`. Containment stays one-way: a requirement of `DE` is not met by `EU` |
| E2 | ONP-3 §5, §5a, §5c | `region=EU` / `region=EEA` in search, the recommend policy and `/v0/locations` follow E1. Every listed location must still lie inside, so an offering also served from London or Zürich does not match `region=EU` |
| E3 | ONP-2 §3b | Residency `scope` uses the §3 rule directly (no separate EU/EEA rule) |
| E4 | ONP-3 §5a | The recommend `region` policy has the §5 meaning: a hosted offering with no pinned region, live serving site or node region does not satisfy it. Offerings on the user's own machine or network still always do. Previously any offering with no known location passed, so an EU policy could shortlist US providers (added 2026-11-03 with registry 0.1.46) |

Cards that pin `EU` keep their meaning; offerings pinned to member states now also match `region=EU`. The `jurisdiction=` filter (the operator's country) is unchanged: there `EU` already meant every EEA country.

### Reference implementation changes

- `@opennodes/core`: `regionWithin` (and so `residencyWithin` and the advisor's region policy) applies EU and EEA membership; `scopeCovers` is the same test with its arguments the other way round. MCP `region` descriptions mention member states.
- `@opennodes/registry`: `region=EU` and `region=EEA` match member-state offerings in `/v0/offerings`, `/v0/recommend` and `/v0/locations`. With the bundled seeds, `region=EU` goes from the legacy `eu-…` pins only to 117 offerings.
- Tests: `impl/test/spec-rev2.test.js` (containment cases), `impl/test/locations.test.js` (search).
- Versions: core 0.1.20, cli 0.1.29, registry 0.1.45, ollama-router 0.1.23.
- E4 (core 0.1.21, cli 0.1.30, registry 0.1.46, ollama-router 0.1.24): new `inRegion` in core, used by `recommend` for generators and embedders (embedders previously ignored `region`) and so by the registry's `/v0/recommend`, MCP `recommend`, the CLI gateway and the Ollama router. It uses an offering summary's `residency` codes when present, else pins plus live sites. With today's registry an EU policy shortlists only local and LAN models: the EU-located offerings are listing-only, and no callable listing declares a location yet.

## Draft 0.1, revision 4 — 2026-11-03: residency commitments

Where a provider serves from (revision 3) is half the answer; the other half is what it promises about where data may go. Revision 4 makes that promise machine-readable, with its source. It is additive: no existing card changes meaning, and region matching in search is unchanged.

| # | Where | Change |
|---|---|---|
| R1 | ONP-2 §3b, schema | New optional `node.residency`: commitments with `commitment` (`processing` > `storage` > `none` > `unstated`), `scope` (region codes plus `EEA`; `EU` and `EEA` cover their member states), `per_region` (each code a separate choice rather than one area), `availability` (`default`, `opt_in`, `enterprise`), `programme`, `statement`, `source`, `checked`. Informational: §5 search still matches pinned regions and live sites |
| R2 | ONP-3 §5c | `/v0/locations` sites carry the commitments that cover them (a per-region promise narrowed to the covering choice); `residency=` and `availability=` filters |
| R3 | ONP-3 §5d, §2 | New `GET /v0/residency`: every provider's commitments, including routers and providers without sites, with `scope=`, `commitment=`, `availability=`, `kind=`, `node_id=` and `format=csv`; `summary` counts providers by their strongest commitment |
| R4 | ONP-3 §5c | A curated seed entry may describe existing nodes instead of creating its own listing; its sites are shown under the node, with the node's models only when the seed says every model is served from every site. Search is unaffected |

### Reference implementation changes

- `@opennodes/core`: schema copy synced; `residencyAt`, `residencyMeets`, `scopeCovers`, `commitmentRank`, `availabilityRank`, `RESIDENCY_COMMITMENTS`, `RESIDENCY_AVAILABILITY`; `find_locations` takes `residency` and `availability`; new MCP tool `find_residency`.
- `@opennodes/registry`:
  - `/v0/residency` (JSON, CSV) and the MCP `find_residency` tool; `residency` on every `/v0/locations` site, in CSV and GeoJSON;
  - curated seed `src/data/locations-world.json` (checked 2026-11-03): every provider in the registry, 216 entries covering 252 nodes, with 269 serving sites outside the Canada and Europe seeds and each provider's residency commitments (97 state one; most small resellers state nothing); seed entries with `nodes` attach to those nodes, with `kind`, `placement` and `residency`;
  - the Canada and Europe seed entries carry residency, directly or via `residency_of` (a cloud's Canadian and European regions share the cloud's commitments);
  - the "Where models run" page shows residency per site, a residency filter and a provider table; a collapsible legend and a countries table grouped by continent (sites live/planned, providers by name, models listed, processing promises; click to filter) replace the one-line country summary (registry 0.1.44).
- `@opennodes/cli`: the stdio MCP server proxies `find_residency`.
- Known gap: `region=EU` in search (§5) matches only codes inside `EU` (`EU-…`), not member states such as `DE`; residency scopes do cover member states. Fixed in revision 5.

## Draft 0.1, revision 3 — 2026-11-02: where models run

No public catalogue says which models run in which country's datacentres, or how anyone knows. Revision 3 adds that layer. It is additive: every revision 2 card stays valid and keeps its meaning, except that residency now also checks the serving locations a card declares.

| # | Where | Change |
|---|---|---|
| L1 | ONP-2 §3a, schema | New optional `node.locations` and per-offering `locations`: region, site, facility operator, `live`/`planned` status, and an evidence `basis` (`claimed` < `documented` < `measured` < `attested`). `documented` requires `source` and `checked`; only registries assign `measured`; an empty offering list means unknown |
| L2 | ONP-2 §5, schema | New optional `model.lineage_origins`: origin countries of every developer in the derivation chain, so clients can apply origin policies |
| L3 | ONP-3 §5 | Residency (`region=`) covers pinned regions **and** live serving locations; new `location_basis=` and `exclude_lineage=` filters; offering summaries carry `locations` and `residency` |
| L4 | ONP-3 §5c, §2 | New `GET /v0/locations`: serving sites by country with evidence and models, from cards and curated seeds, with JSON and CSV output and an `unlocated_offerings` count |
| L5 | ONP-2 §3a, ONP-3 §5c, schema | GIS: optional location `geo` point (`lat`, `lon`, `precision` facility/city/region/country; no finer than the city unless the address is public); registries mark derived region or country points; `/v0/locations` adds `near=` / `within_km=` distance queries and `format=geojson` (RFC 7946) |
| L6 | ONP-1 §5, ONP-2 §3, §5, §9, ONP-3 §4a, §5, §6, ONP-5 §5 | Merged with the Draft 0.1 errata of 2026-10-23 ([KNOWN-ISSUES.md](KNOWN-ISSUES.md)). Revision 2's versioning rules (accept higher minors, open vocabularies) sit beside the errata's draft and major-version rules. `operator.country` keeps its errata meaning (the operator's jurisdiction); `locations` now delivers the per-offering execution location the errata planned for Draft 0.2. ONP-3 §6 is numbered 6.1–6.5 with the errata's server-location checks as §6.4 and ranking as §6.5. `jurisdiction=` and `region=` both filter search: the operator's country, and where requests are served |

The registry's server-location check (§6.4) and site evidence are kept apart: `/v0/locations` shows the check result for a registered node's API host as `server_check` beside its declared sites, and a passing check does not by itself make a site `measured`.

### Reference implementation changes

- `@opennodes/core`: schema copy synced; `countryOf`, `LOCATION_BASES`, `basisRank`, `servingLocations`, `residencyCodes`; the advisor's region policy also rejects offerings served outside the required region; MCP filters `region`, `location_basis`, `exclude_lineage` and a new `find_locations` tool.
- `@opennodes/registry`:
  - `GET /v0/locations` (`?format=csv`) and the "Where models run" page in the web app;
  - curated seed `src/data/locations-ca.json` (14 Canadian providers, checked 2026-11-02), imported at start unless `ONP_LOCATION_SEEDS=0`;
  - per-provider OpenRouter importer (`openrouter-providers` re-import source, `POST /v0/import/openrouter-providers`) that keeps the headquarters, datacentres and region tags providers declare to OpenRouter, as `claimed`;
  - `POST /v0/import/locations`; `/v0/nodes` lists node locations; the MCP endpoint serves `find_locations`;
  - GIS: points on every site (city points for the 18 named Canadian seed sites, derived points otherwise), `near=` / `within_km=`, `format=geojson`, and an interactive map on the "Where models run" page (Leaflet 1.9.4 from cdnjs with subresource integrity, loaded only on that page; basemap from `/v0/health` `map`, OpenStreetMap by default, `ONP_MAP_TILES` to change or `off` to disable).
- `@opennodes/core`: `geo.js` with `pointFor`, `distanceKm`, `parsePoint`, `REGION_POINTS`, `GEO_PRECISIONS`; `find_locations` takes `near` and `within_km`.
- `@opennodes/cli`: the stdio MCP server proxies `find_locations`.
- Shared with the server-location check: one great-circle distance (`distanceKm` in core; `location.js` keeps `haversineKm` as an alias); `/v0/locations` sites carry `server_check`.
- Not built yet: the `measured` basis for sites. It needs probe points inside each region under test (the server-location check now runs from Nuremberg and Helsinki). With `geo` in place, a probe's round-trip time can be checked against the distance to the claimed site.
- Versions: core 0.1.18, registry 0.1.41, cli 0.1.27, ollama-router 0.1.21. `deploy/registry/Dockerfile` still pins the published registry 0.1.40; move it when 0.1.41 is published.
- Tests: `impl/test/locations.test.js` (8 tests).

## Draft 0.1, revision 2 — 2026-10-31

Compatibility and editorial fixes found while profiling ONP for a sovereign, closed-catalogue deployment. Cards written for revision 1 stay valid. The only exception is an `ephemeral` retention without a bound, and no published card uses that.

| # | Where | Change |
|---|---|---|
| D1 | ONP-2 §9 | Schema path corrected to `schemas/open-node.schema.json`. The schema is normative for structure, the prose for semantics |
| D2 | schema `$id`, ONP-5 §2, problem types | One domain: `opennodes.io` (schema `$id`, settlement example, `https://opennodes.io/problems/{name}` in the JS and Python servers) |
| D3 | ONP-1 §5, schema `onp` | Any `0.x` version is accepted; implementations MUST accept higher minor versions |
| D4 | ONP-2 §5, ONP-5 §2, ONP-3 §4a | Offering `pricing.schemes` MUST be a subset of node `payment.schemes`; checked at Stage A |
| D5 | ONP-2 §5 | `tools` listed as a core modality |
| D6 | ONP-3 §6, ONP-5 §5 | ONP-3 §6 numbered 6.1–6.4 so existing citations resolve |
| D7 | ONP-2 §8 | JCS (RFC 8785) canonicalization is normative for card signatures (matches both reference implementations) |
| D8 | ONP-2 §5, ONP-3 §4a | `supports` core vocabulary extended: `parallel_tool_calls`, `structured_outputs`, `audio_input`, `reasoning`, `logprobs`, `prompt_caching`; fingerprinting falls back to output-only comparison when `logprobs` is absent |
| D9 | ONP-2 §5, schema | `retention` values defined; `retention_max_seconds` added and required for `ephemeral`; registries check `data_policy` presence at Stage A |
| D10 | ONP-2 §5, schema | `expected_tps` defined as per-stream; new optional offering `capacity` block (`aggregate_output_tps`, `max_concurrency`, `rate_limits`) |
| D11 | docs/00-project-overview | Fact sheet test and offering counts refreshed |
| D12 | ONP-2 §3, ONP-3 §5 | ISO 3166 region codes with containment (`CA` ⊇ `CA-QC`); `region=` search requires every pinned location inside; `lang=` matches BCP 47 subtags; language tags may carry regions (`fr-CA`) |
| D13 | ONP-3 §5a | Estimate/recommend: free and unauthenticated on public registries; MAY require authentication; SHOULD be rate-limited |
| D14 | ONP-4 §9 | Registered problem types and status codes for refusals, rate limits and capacity; fallbacks MUST NOT weaken the caller's policy |
| D15 | ONP-1 §5, schema | Open vocabularies for `modality`, `supports`, `scheme`, `retention`, with safe defaults for unknown values, so profiles can extend ONP without breaking validation |

### Reference implementation changes

- `@opennodes/core`: schema copy synced; new `regionWithin` / `residencyWithin` helpers; advisor region policy uses containment (every pinned location must lie inside the required region); problem-type domain.
- `@opennodes/registry`: Stage A `card-consistency` check; `region=` search filter (previously specified but not implemented); BCP 47 prefix matching for `lang=`; offering summaries carry `node_regions`.
- `onp-node` (Node Kit): problem-type domain.
- Tests: `impl/test/spec-rev2.test.js` (6 tests).

The packages need a version bump before publishing (core is consumed by registry, CLI and router at a pinned version).

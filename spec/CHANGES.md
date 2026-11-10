# ONP specification changes

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

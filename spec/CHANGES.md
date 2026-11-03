# ONP specification changes

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
  - the "Where models run" page shows residency per site, a residency filter and a provider table.
- `@opennodes/cli`: the stdio MCP server proxies `find_residency`.
- Known gap: `region=EU` in search (§5) matches only codes inside `EU` (`EU-…`), not member states such as `DE`; residency scopes do cover member states. Aligning search is a separate change.

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

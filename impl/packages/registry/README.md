# @opennodes/registry

The OpenNodes Protocol (ONP) reference registry — an open, federatable discovery service for AI inference nodes.

```bash
npx @opennodes/registry                 # web app + API on http://127.0.0.1:4300
ONP_DB=./registry.db npx @opennodes/registry          # persistent SQLite + persistent signing key
ONP_DB=postgres://user:pass@host/db npx @opennodes/registry
```

What it does:

- **Registration with proof of resource** — namespace challenge (HTTP or DNS TXT), Stage A conformance probes, Stage B identity fingerprinting / context verification / capacity ramp, Stage C continuous liveness and blind probes. Trust tiers: `unverified → community → verified` (+ `disputed`, `suspended`). Claimed ≠ measured ≠ attested — always labeled, never blended.
- **Search and transparent ranking** (`/v0/offerings`, `sort=rank|price|ttft|tps`) with per-result `rank_explanation`; **enforceable estimates** (`POST /v0/estimate`) pinned to card revisions; the **advisor** (`POST /v0/recommend`).
- **Catalog importers** — OpenRouter, Hugging Face Inference Providers, models.dev, the Ollama library — so search is useful on day one, with imported listings labeled and claimable by their operators.
- **Where models run** (`/v0/locations`, `?format=csv` or `?format=geojson`): serving sites by country with their evidence (`claimed`, `documented`, `measured`, `attested`), a map point, and the models each serves (ONP-2 §3a, ONP-3 §5c). `near=lat,lon&within_km=` finds what runs close to a point. The GeoJSON opens directly in QGIS, ArcGIS, kepler.gl or any web map; the web app draws it on an interactive map. Built from card locations, the per-provider OpenRouter import (the headquarters, datacentres and region tags providers declare there) and curated seeds in [`src/data/`](src/data/) (Canada, Europe, and every registry provider worldwide). Search takes `region=`, `location_basis=` and `exclude_lineage=`.
- **Residency commitments** (`/v0/residency`, `?format=csv`): what each provider officially promises about where prompts, outputs and stored data stay (`processing`, `storage`, `none` or `unstated`; scope; `default`, `opt_in` or `enterprise`), with source and date (ONP-2 §3b, ONP-3 §5d). Each site in `/v0/locations` carries the commitments that cover it, and `residency=processing|storage` filters by them.
- **MCP surface** at `/mcp` (including `find_locations` and `find_residency`) and a signed **export feed** for federation.
- **Web app** at `/`: OpenRouter-style catalog with model and node pages, hardware and measured performance, playground, multi-model chat (compare / jury / pipeline / iterative), the advisor, the Node Builder, and the "Where models run" page.

Environment: `PORT`, `ONP_DB`, `ONP_REGISTRY_KEY`, `ONP_ADMIN_TOKEN`, `ONP_ALLOW_PRIVATE=1` (dev only: permit localhost nodes), `ONP_STAGE_C=0`, `ONP_REIMPORT=1`, `ONP_REIMPORT_SOURCES` (default `openrouter,huggingface`; also `models-dev`, `ollama`, and `openrouter-providers`, which makes one request per OpenRouter model, so give it a long `ONP_REIMPORT_MS`), `ONP_LOCATION_SEEDS=0` (skip the curated location seeds), `ONP_MAP_TILES` (basemap for the locations map: unset = OpenStreetMap, `off` = no map, or an XYZ URL template with `ONP_MAP_ATTRIBUTION`). The map loads Leaflet from cdnjs, pinned with subresource integrity, only on the "Where models run" page. Viewers' browsers then fetch tiles from the tile server. OpenStreetMap's tile policy asks for light use, so a busy registry should point `ONP_MAP_TILES` at its own or a commercial tile service.

Location seeds are dated JSON files (`locations-{seed}.json`): providers, their sites with `basis`, `source` and `checked`, and the models each site serves. A provider whose models are listed becomes a listing-only node `import.seed.{seed}.{id}`; one that publishes no model list is shown with a note. An entry with `nodes` describes existing registry nodes instead: its sites are shown under the first of them, with that node's models when `placement` is `all`. With `placement: "all"`, or `serves_from: "{seed}:{id}"` (the node's whole API runs at that entry's sites), search and recommend also use the live sites as the node's serving locations, marked `via: "seed"`, for offerings whose card declares none, except for listings reached through the Hugging Face router or OpenRouter. Providers carry `kind` and `residency`; `residency_of: "{seed}:{id}"` reuses another entry's commitments (the Canadian and European regions of a cloud share the cloud's). Corrections and new countries are welcome by pull request: cite the provider's own page for `documented`, anything else is `claimed`.

Part of [OpenNodes](https://opennodes.io) · [specification](https://github.com/opennodes-io/opennodes/tree/main/spec) · Apache-2.0.

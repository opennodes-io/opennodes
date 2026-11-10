# @opennodes/registry

The OpenNodes Protocol (ONP) reference registry — an open, federatable discovery service for AI inference nodes.

```bash
npx @opennodes/registry                 # web app + API on http://127.0.0.1:4300
ONP_DB=./registry.db npx @opennodes/registry          # persistent SQLite + persistent signing key
ONP_DB=postgres://user:pass@host/db npx @opennodes/registry
```

What it does:

- **Registration with proof of resource** — namespace challenge (HTTP or DNS TXT), Stage A conformance probes, Stage B identity fingerprinting / context verification / capacity ramp, Stage C continuous liveness and blind probes. Trust tiers: `unverified → community → verified` (+ `disputed`, `suspended`). Claimed ≠ measured ≠ attested — always labeled, never blended. The tests cover only chat offerings (`onp.openai.chat/v1`). Speech, embeddings and other offerings are shown with `tested: false` and capped to `unverified`, whatever the node's tier, and listed in node detail and the export feed as `verification.untested_offerings`. A node with no chat offering stays unverified. The web app's qualification page (`/#/qualification`) lists the probe load of each stage: Stage A sends 1 blind call per chat offering at verification and on each `PUT /v0/nodes/{id}/ping`; Stage B sends up to 20 per chat offering when the operator asks for admission; Stage C sends a health check every 5 min and 1 blind call per node every hour, both on average.
- **Operator marks** (ONP-3 §4b): `institutional` and `founding`, set by the registry admin on registered nodes and shown in `/v0/nodes`, node detail, search results and the web app. Labels only, never rank inputs:

  ```bash
  curl -X POST https://registry.example/v0/admin/nodes/io.example.ai/founding \
    -H "authorization: Bearer $ONP_ADMIN_TOKEN" -H "content-type: application/json" -d '{"founding": true}'
  ```

  The same request with `{"founding": false}` clears the mark; `/institutional` takes `{"institutional": true|false}`.
- **Trusted and open pools** (ONP-3 §5e):
  - **Who lists:** any operator, from any country.
  - **Search filters:** `trust=trusted` returns only offerings for personal data: declared model lineage without CN, tier verified or higher, an operator in the trusted jurisdictions, `retention: none` and no training on inputs. Each part is also a filter of its own: `lineage=declared`, `exclude_lineage=CN`, `retention=none|ephemeral|logged`, `no_training=true`, `jurisdiction=`, `tier=`.
  - **Labels:** every result carries `pool: "trusted"` or `"open"`.
  - **Recommend:** `policy.sensitive: true` uses the trusted pool, always under the registry's own view.
  - **Configuration:** `ONP_TRUSTED_JURISDICTIONS` (default `EU,CA`) sets the trusted countries, and `/v0/health` publishes the view as `trust.trusted`.
  - **Errors:** a misspelt `trust`, `lineage`, `retention` or `no_training` value gets `400 bad-query`, never a wider result.
- **Request counts** (ONP-3 §6.6): how often search, recommend and the MCP tools returned each node, per ISO week, in node detail (`request_counts`, 12 weeks) and at `GET /v0/stats/requests?weeks=4&node_id=…`. Only node ids and counts are stored, never the query, task or client.
- **Search and transparent ranking** (`/v0/offerings`, `sort=rank|price|ttft|tps`) with per-result `rank_explanation`; **enforceable estimates** (`POST /v0/estimate`) pinned to card revisions; the **advisor** (`POST /v0/recommend`).
- **Catalog importers** — OpenRouter, Hugging Face Inference Providers, models.dev, the Ollama library — so search is useful on day one, with imported listings labeled and claimable by their operators.
- **Where models run** (`/v0/locations`, `?format=csv` or `?format=geojson`): serving sites by country with their evidence (`claimed`, `documented`, `measured`, `attested`), a map point, and the models each serves (ONP-2 §3a, ONP-3 §5c). `near=lat,lon&within_km=` finds what runs close to a point. The GeoJSON opens directly in QGIS, ArcGIS, kepler.gl or any web map; the web app draws it on an interactive map. Built from card locations, the per-provider OpenRouter import (the headquarters, datacentres and region tags providers declare there) and curated seeds in [`src/data/`](src/data/) (Canada, Europe, and every registry provider worldwide). Search takes `region=`, `location_basis=` and `exclude_lineage=`.
- **Residency commitments** (`/v0/residency`, `?format=csv`): what each provider officially promises about where prompts, outputs and stored data stay (`processing`, `storage`, `none` or `unstated`; scope; `default`, `opt_in` or `enterprise`), with source and date (ONP-2 §3b, ONP-3 §5d). Each site in `/v0/locations` carries the commitments that cover it, and `residency=processing|storage` filters by them.
- **MCP surface** at `/mcp` (including `find_locations` and `find_residency`) and a signed **export feed** for federation.
- **Web app** at `/`: OpenRouter-style catalog with model and node pages, hardware and measured performance, playground, multi-model chat (compare / jury / pipeline / iterative), the advisor, the Node Builder, and the "Where models run" page.

Environment: `PORT`, `ONP_DB`, `ONP_REGISTRY_KEY`, `ONP_ADMIN_TOKEN`, `ONP_TRUSTED_JURISDICTIONS` (trusted pool operators, default `EU,CA`), `ONP_ALLOW_PRIVATE=1` (dev only: permit localhost nodes), `ONP_STAGE_C=0`, `ONP_REIMPORT=1`, `ONP_REIMPORT_SOURCES` (default `openrouter,huggingface`; also `models-dev`, `ollama`, and `openrouter-providers`, which makes one request per OpenRouter model, so give it a long `ONP_REIMPORT_MS`), `ONP_LOCATION_SEEDS=0` (skip the curated location seeds), `ONP_MAP_TILES` (basemap for the locations map: unset = OpenStreetMap, `off` = no map, or an XYZ URL template with `ONP_MAP_ATTRIBUTION`). The map loads Leaflet from cdnjs, pinned with subresource integrity, only on the "Where models run" page. Viewers' browsers then fetch tiles from the tile server. OpenStreetMap's tile policy asks for light use, so a busy registry should point `ONP_MAP_TILES` at its own or a commercial tile service.

Location seeds are dated JSON files (`locations-{seed}.json`): providers, their sites with `basis`, `source` and `checked`, and the models each site serves. A provider whose models are listed becomes a listing-only node `import.seed.{seed}.{id}`; one that publishes no model list is shown with a note. An entry with `nodes` describes existing registry nodes instead: its sites are shown under the first of them, with that node's models when `placement` is `all`. With `placement: "all"`, or `serves_from: "{seed}:{id}"` (the node's whole API runs at that entry's sites), search and recommend also use the live sites as the node's serving locations, marked `via: "seed"`, for offerings whose card declares none, except for listings reached through the Hugging Face router or OpenRouter. Providers carry `kind` and `residency`; `residency_of: "{seed}:{id}"` reuses another entry's commitments (the Canadian and European regions of a cloud share the cloud's). Corrections and new countries are welcome by pull request: cite the provider's own page for `documented`, anything else is `claimed`.

Part of [OpenNodes](https://opennodes.io) · [specification](https://github.com/opennodes-io/opennodes/tree/main/spec) · Apache-2.0.

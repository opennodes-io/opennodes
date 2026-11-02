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
- **Where models run** (`/v0/locations`, `?format=csv`): serving sites by country with their evidence (`claimed`, `documented`, `measured`, `attested`) and the models each serves (ONP-2 §3a, ONP-3 §5c). Built from card locations, the per-provider OpenRouter import (the headquarters, datacentres and region tags providers declare there) and curated seeds in [`src/data/`](src/data/) (Canada first). Search takes `region=`, `location_basis=` and `exclude_lineage=`.
- **MCP surface** at `/mcp` (including `find_locations`) and a signed **export feed** for federation.
- **Web app** at `/`: OpenRouter-style catalog with model and node pages, hardware and measured performance, playground, multi-model chat (compare / jury / pipeline / iterative), the advisor, the Node Builder, and the "Where models run" page.

Environment: `PORT`, `ONP_DB`, `ONP_REGISTRY_KEY`, `ONP_ADMIN_TOKEN`, `ONP_ALLOW_PRIVATE=1` (dev only: permit localhost nodes), `ONP_STAGE_C=0`, `ONP_REIMPORT=1`, `ONP_REIMPORT_SOURCES` (default `openrouter,huggingface`; also `models-dev`, `ollama`, and `openrouter-providers`, which makes one request per OpenRouter model, so give it a long `ONP_REIMPORT_MS`), `ONP_LOCATION_SEEDS=0` (skip the curated location seeds).

Location seeds are dated JSON files (`locations-{seed}.json`): providers, their sites with `basis`, `source` and `checked`, and the models each site serves. A provider whose models are listed becomes a listing-only node `import.seed.{seed}.{id}`; one that publishes no model list is shown with a note. Corrections and new countries are welcome by pull request: cite the provider's own page for `documented`, anything else is `claimed`.

Part of [OpenNodes](https://opennodes.io) · [specification](https://github.com/opennodes-io/opennodes/tree/main/spec) · Apache-2.0.

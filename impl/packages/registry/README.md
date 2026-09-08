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
- **MCP surface** at `/mcp` and a signed **export feed** for federation.
- **Web app** at `/`: OpenRouter-style catalog with model and node pages, hardware and measured performance, playground, multi-model chat (compare / jury / pipeline / iterative), the advisor, and the Node Builder.

Environment: `PORT`, `ONP_DB`, `ONP_REGISTRY_KEY`, `ONP_ADMIN_TOKEN`, `ONP_ALLOW_PRIVATE=1` (dev only: permit localhost nodes), `ONP_STAGE_C=0`, `ONP_REIMPORT=1`.

Part of [OpenNodes](https://opennodes.io) · [specification](https://github.com/opennodes-io/opennodes/tree/main/spec) · Apache-2.0.

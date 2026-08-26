# OpenNodes — Reference Implementation (MVP-0)

Runnable vertical slice of the ONP Draft 0.1 stack: registry + fixture node + client, proving the
**register → verify → Stage A → search → estimate → pinned invoke → verified receipt** loop.

Requires Node ≥ 22.5 (uses `node:sqlite`, built-in Ed25519). Zero runtime dependencies beyond Ajv.

## Layout

| Package | Implements |
|---|---|
| `packages/core` | JWS (Ed25519 compact), Node Card validation against `schemas/open-node.schema.json`, stable JSON canonicalization, HTTP micro-router, pricing math |
| `packages/registry` | REQ-001 subset: registration with **HTTP + DNS TXT namespace challenges**, card indexing with signature verification, **SSRF-guarded probe fetching** (private-range denial, size/time caps; `allowPrivateTargets` for dev), Stage A battery (health, /models agreement, blind invocation), **Stage B battery** (`POST /v0/nodes/{id}/admit`: identity fingerprinting against operator-captured references with `disputed` on mismatch, needle-in-haystack context verification with advertised-window capping, stepped-concurrency capacity ramp storing measured TTFT/TPS that override claims in search), search with transparent rank, `POST /v0/estimate`, node detail + listing history, an **MCP server at `/mcp`** (verified against a real MCP client), **Stage C continuous observation** (jittered liveness sweeps -> rolling availability in search, random blind invocations against benchmark-mode gaming, auto-suspension after consecutive failures), a **signed NDJSON export feed** (`/v0/export?since=`, verifiable against the `signing_key` in `/v0/health`), **seed importers** for models.dev (`POST /v0/import/models-dev` — 188 providers / 7,104 offerings live), **OpenRouter** (`/v0/import/openrouter` — 417 offerings incl. image/video models, per-token prices converted to per-MTok, `hugging_face_id` as artifact join), and **HF Inference Providers** (`/v0/import/huggingface` — joins the router API with Hub metadata: per-provider live status, tools support, measured TTFT/TPS as `claimed`, real safetensors param counts; 310 offerings / 14 providers live) — all entering as `unverified`/`source:import` with `modalities: {input, output}` arrays (Draft 0.2 field), and **admin auth** (bearer token or loopback-only) on capture/import routes. Storage: an async store contract with two drivers — `node:sqlite` (dev: file or `:memory:`) and **Postgres** (`store-pg.js`, selected by a `postgres://` URL in `ONP_DB`; conformance-tested against pg-mem, plus an opt-in real-server test via `ONP_PG_URL`). **Persistent signing identity** via `keyPath`/`ONP_REGISTRY_KEY`: the export-feed key survives restarts (auto-derived as `<db>.key.pem` for file-backed deployments) |
| `packages/fixture-node` | A conforming ONP node serving a deterministic echo model: signed card at `/.well-known/open-node.json`, JWKS, challenge endpoint, OpenAI-compatible chat (+streaming) with `usage`, ONP header validation (409 on offering mismatch / `price_changed`), signed receipts, `reprice()` for testing |
| `packages/cli` | REQ-002 subset: `OnpClient` SDK (search, estimate, direct card resolution + signature check, policy gate, pinned invoke with one `price_changed` retry, receipt verification incl. amount = usage × pinned price), the `onp` CLI, and the **ONP Gateway** (`onp gateway`) — a local OpenAI-compatible server (`/v1/models`, `/v1/chat/completions` incl. streaming) exposing discovered offerings to unmodified third-party clients, with aliases, select-backed virtual models, fallback across candidates, bearer auth, transparent reprice recovery, and a receipts ledger (`/gateway/receipts`, `--ledger` JSONL) |

## Run

```
npm install
npm test                 # 3 e2e tests, in-process
```

Live demo (three terminals, or background the first two):

```
set ACCEPT_ANY_CHALLENGE=1 && node packages/fixture-node/bin.js     # :4310
node packages/registry/bin.js                                        # :4300
# register + verify:
curl -X POST http://127.0.0.1:4300/v0/nodes -H "content-type: application/json" -d "{\"card_url\":\"http://127.0.0.1:4310/.well-known/open-node.json\"}"
curl -X POST http://127.0.0.1:4300/v0/nodes/org.opennodes.fixture/verify
# client:
node packages/cli/bin.js search --modality text
node packages/cli/bin.js estimate --offering org.opennodes.fixture/echo-1 --in 2000 --out 800
node packages/cli/bin.js invoke --offering org.opennodes.fixture/echo-1 --prompt "hi"
```

### MCP: model search & chain pricing inside Cursor / VS Code / Claude Desktop

`onp mcp` is a stdio MCP server exposing `search_offerings` / `get_offering` / `estimate`
across everything the registry knows — registered nodes plus the imported OpenRouter,
Hugging Face, and models.dev catalogs (727+ live offerings when seeded). Editor config:

```json
{ "mcpServers": { "opennodes": {
    "command": "node",
    "args": ["<path>/impl/packages/cli/bin.js", "mcp"],
    "env": { "ONP_REGISTRY": "http://127.0.0.1:4300" } } } }
```

(Hosts that support remote MCP can instead point straight at the registry's `/mcp` endpoint.)

### Gateway: use discovered nodes from Cursor / VS Code / any OpenAI client

```
node packages/cli/bin.js gateway --port 4141 --token dev-secret --virtual "auto-cheap=modality=text&sort=price"
```

Then in the third-party client set the OpenAI-compatible base URL to `http://127.0.0.1:4141/v1`
(API key: `dev-secret`) — discovered offerings, aliases, and virtual models appear in its model
list; every request is pinned, policy-checked, receipted, and logged. Spend so far:
`GET /gateway/receipts`.

## Deliberate MVP-0 shortcuts (tracked against requirements)

- Storage is `node:sqlite` (experimental) behind the store interface — DS data model matches REQ-001 §4; Postgres driver is the seam.
- MCP Registry importer (tool-server records) not yet built; only models.dev (DS-IMP-01 is half done).
- Capacity ramp runs seconds, not the spec's 15 minutes (configurable via `stageBCapacity`); receipt-sampling cross-checks during Stage C blind probes record usage but don't yet reconcile against receipts.
- The Postgres driver is validated against pg-mem's engine; run the suite once with `ONP_PG_URL` against a real server before production use.
- CLI lacks MCP mode (REQ-002 TC-MCP); gateway `/v1/embeddings` is a 501 stub until a fixture serves the embeddings profile.
- Fixture signs receipts with scheme `free`; prepaid keys and x402 are unimplemented (ONP-5).
- Card `_jws` convenience field in signatures is an implementation artifact to remove when detached-JWS serialization is finalized.

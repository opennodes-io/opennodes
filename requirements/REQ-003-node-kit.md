# REQ-003 — OpenNodes Node Kit — Development Requirements

**Version 0.1 (draft) — 2026-08-21 — Target: Phase 1 "Node Kit v1" implementing spec ONP-2/ONP-4/ONP-5 node conformance.**
IDs: `NK-<area>-<n>`. RFC 2119 keywords.

## 1. Purpose

The Node Kit turns an existing inference deployment into a conforming ONP Node with one command. It is the supply-side on-ramp for the institutional wedge (university clusters, national computation centres) — operators who already run vLLM/Ollama/TGI and must not be asked to change their serving stack. The kit sits **in front of** the engine as a thin gateway, generates and serves the Node Card, signs receipts, and handles registration.

Form factor: Python package (`pipx install onp-node`), single `onp-node` command, one TOML config; optional Docker image and Helm chart wrapping the same binary.

## 2. Architecture constraint

The kit MUST be a **reverse proxy, not a fork**: engine untouched, kit terminates public TLS traffic (or sits behind the operator's ingress), forwards OpenAI-shape requests to the engine, and adds the ONP layer (headers, receipts, health, card). Overhead budget: p50 < 10 ms added, streaming unbuffered.

## 3. Functional requirements

### 3.1 Card generation & serving
- **NK-CARD-01** `onp-node init` interrogates the engine (vLLM `/v1/models` + config, Ollama `/api/tags`, TGI `/info`) and drafts a Node Card: offerings with `model.artifact` (auto-mapped to `hf:{org}/{repo}` where the engine exposes it), quantization, context window, `supports` capabilities probed empirically (tool_calls, json_mode, vision via test calls), and binding `model_id`s. Operator completes identity, pricing, `data_policy`, `languages`, SLA in the TOML; `init` is a wizard, config is the source of truth.
- **NK-CARD-02** Kit serves `/.well-known/open-node.json` (content type `application/open-node+json`, `Cache-Control: max-age=3600`) and `/.well-known/jwks.json`; card is regenerated from config + a monotonically increasing `revision` on every `onp-node apply`.
- **NK-CARD-03** Card MUST validate against `open-node.schema.json` before serving; `apply` refuses invalid configs with actionable errors.
- **NK-CARD-04** Every generated performance/quality field defaults to `basis: "claimed"`; the kit MUST NOT fabricate benchmark or hardware values — absent means absent. Attestation links are operator-supplied config entries.
- **NK-CARD-05** Key management: `init` generates an Ed25519 keypair (or uses an operator-provided key/KMS reference); JWS signing of card and receipts; key rotation command that re-signs and bumps revision.

### 3.2 Invocation layer
- **NK-INV-01** Implements `onp.openai.chat/v1` node conformance (ONP-4 §2): proxies `/v1/chat/completions` and `/v1/models` (filtered to exactly the card's offerings — agreement enforced by construction), streaming SSE with terminal `usage` (kit MUST count tokens itself via the engine's tokenizer when the engine omits usage in streams).
- **NK-INV-02** `ONP-Offering` header validated against the routed model; mismatch ⇒ 409. `ONP-Card-Revision` validated: superseded revision with changed pricing for that offering ⇒ 409 `price_changed`; requests without ONP headers are served as plain OpenAI traffic (headers are additive, never required — third-party clients keep working).
- **NK-INV-03** Embeddings profile (`onp.openai.embeddings/v1`) when the engine supports it; images profile deferred to v1.1 (flagged in config as unsupported).
- **NK-INV-04** Per-offering rate limits and `free_tier` quotas enforced at the kit (token bucket per API key / client identity).

### 3.3 Receipts & payment
- **NK-PAY-01** Every ONP-headed request returns `ONP-Receipt` (inline JWS): usage, amount = usage × pinned-revision price, request hash, scheme, per ONP-5 §5. Receipts also issued for `free` scheme (amount 0). Local receipt log with retention config (default 90 days) and `onp-node receipts export`.
- **NK-PAY-02** Schemes in v1: `free` and `prepaid` node-direct (kit manages API keys: `onp-node keys issue/revoke`, hashed at rest). Registry-settled prepaid: redemption client stub behind a flag (activates with the Phase 2 settlement service). `x402`: out of v1, config placeholder reserved.
- **NK-PAY-03** `probe_allowance` enforcement: requests authenticated by a registry's probe credential draw from the free daily budget and are marked in logs; exhaustion returns 429 with a distinct problem type.

### 3.4 Registration & operations
- **NK-REG-01** `onp-node register <registry>` submits the card URL, walks the operator through the DNS TXT or HTTP challenge (serving the HTTP token automatically when the kit owns the origin), polls to `indexed`, and prints tier status.
- **NK-REG-02** `onp-node apply` pings registered registries (`PUT /v0/nodes/{id}/ping`) after each revision.
- **NK-REG-03** `/onp/health` endpoint (status, load, queue_ms from engine metrics where available).
- **NK-REG-04** Self-test: `onp-node check` runs the client-side Stage A battery (same checks as REQ-002 TC-TEST-01) against the local deployment and MUST pass before `register` allows submission (`--force` overrides with a warning).
- **NK-REG-05** Observability: structured logs, Prometheus metrics (requests, tokens, receipts, 409s, probe traffic), and a one-page local status UI (`onp-node status --web`, loopback only).

## 4. Non-functional

- **NK-NFR-01** Supported engines v1: vLLM ≥0.8, Ollama ≥0.6, TGI ≥3.0 (adapter interface documented so the community can add others — SGLang, llama.cpp server as candidate contributions).
- **NK-NFR-02** Python ≥3.11; no GPU dependency in the kit itself; runs on the head node or a separate VM.
- **NK-NFR-03** Security: TLS termination or trusted-proxy mode; secrets never in the card or logs; receipt keys separate from TLS; deny-by-default admin surface (loopback).
- **NK-NFR-04** Apache-2.0.

## 5. Acceptance (v1 done =)

1. Fresh vLLM box → `pipx install onp-node && onp-node init && onp-node apply && onp-node register` → node `indexed` on the REQ-001 registry and passing Stage A, in under 30 minutes, no engine changes.
2. Same flow green on Ollama and TGI fixtures in CI.
3. Streamed chat through the kit returns terminal `usage` and a verifiable receipt whose amount matches pinned pricing (validated by REQ-002 `onp e2e`).
4. Pricing change in config → new revision → old-revision request answers 409 `price_changed`; un-headed OpenAI request continues to work throughout.
5. Registry Stage B capacity ramp completes against a kit-fronted node with measured TTFT/TPS recorded and `probe_allowance` accounting matching on both sides.
6. `onp-node check` fails a misconfigured node (engine model renamed, card stale) with errors that name the exact config key to fix.

# REQ-002 — OpenNodes Test Client — Development Requirements

**Version 0.1 (draft) — 2026-08-21 — Target: Phase 1 "SDK & client" implementing spec ONP-4/ONP-6 client conformance.**
IDs: `TC-<area>-<n>`. RFC 2119 keywords.

## 1. Purpose

A reference client with three jobs: (1) **validate the network end-to-end** (discovery → estimate → pin → invoke → receipt) against the REQ-001 registry; (2) serve as the **conformance oracle** other client implementers copy; (3) make discovered nodes usable **from existing popular AI clients without modifying them**, via an OpenAI-compatible gateway. Form factor: one binary/package, `onp` CLI, embedding the TS SDK; no GUI in MVP.

## 2. Modes

| Mode | Command | What it is |
|---|---|---|
| CLI | `onp search / estimate / invoke / run / receipts / card` | direct testing & scripting |
| Gateway | `onp gateway` | local OpenAI-compatible server exposing discovered offerings to third-party clients (Cursor, VS Code, Open WebUI…) |
| MCP | `onp mcp` | stdio MCP server exposing discovery/estimation/invocation as tools to any MCP host |

## 3. Functional requirements

### 3.1 Discovery & resolution
- **TC-DISC-01** Configurable registry list (≥1); `onp search` maps all ONP-3 §5 filters to flags; results table shows tier, basis labels (claimed/observed/attested), price, measured TTFT/TPS, rank + explanation on `--explain`.
- **TC-DISC-02** `onp card <origin|node_id>` fetches and validates a Node Card directly from origin (no registry), verifying JWS — direct resolution MUST work registry-less.
- **TC-DISC-03** Card cache with revision awareness; offline search against last sync (`onp sync`).

### 3.2 Estimation, invocation, receipts
- **TC-INV-01** Implements `onp.openai.chat/v1` client conformance (ONP-4 §7): streaming, `ONP-Offering` + `ONP-Card-Revision` request headers, 409 `price_changed` handling (re-fetch → re-check policy → retry once or surface).
- **TC-INV-02** `onp estimate` calls `POST /v0/estimate`; `onp invoke --pin-from-estimate` MUST use the returned revisions so estimates are enforceable.
- **TC-INV-03** Receipts (`ONP-Receipt`) verified (JWS, amount = usage × pinned price) and appended to a local ledger; `onp receipts` reports estimate-vs-actual per task/day; verification failure raises a dispute-ready report.
- **TC-INV-04** Spend policy file (ONP-5 §3): max price per MTok, per-request ceiling (from `max_tokens` × pinned price), daily budget, allowed schemes, minimum tier; enforced before every invocation in all three modes.
- **TC-INV-05** Payment schemes: `prepaid` node-direct keys (keychain-stored) and `free` in MVP; `x402` behind a feature flag (wallet integration Phase 2).
- **TC-INV-06** `onp run <scenario.json>`: executes ONP-6 §5 Scenarios — sequential steps, conditions, role `select` resolution at run time, parallel fan-out with judge merge, cascade `escalate_to`; per-run receipt aggregation.

### 3.3 Gateway mode (third-party client compatibility)
- **TC-GW-01** `onp gateway` serves an OpenAI-compatible API on `localhost:<port>` (configurable bind/auth token): `GET /v1/models`, `POST /v1/chat/completions` (streaming + tools passthrough), `POST /v1/embeddings`.
- **TC-GW-02** `GET /v1/models` MUST list discovered offerings that pass the user's policy, as stable ids `{node_id}/{offering_id}`, plus user-defined **aliases** (`onp alias fast-eu ai.example-lab.inference/llama-4-70b-instruct-fp8`) and **virtual models** backed by a `select` query (e.g. `auto-cheap` = `sort=price&tier=verified`, re-resolved per request with fallback through the result list).
- **TC-GW-03** Requests are translated to ONP invocations transparently: header pinning, receipts, spend policy, fallback chain on 5xx/timeout (next offering matching the query). The third-party client needs zero ONP knowledge.
- **TC-GW-04** Compatibility MUST be verified against a named matrix (acceptance §5): Cursor (custom OpenAI base URL), VS Code (GitHub Copilot BYOK "OpenAI-compatible" provider; Continue; Cline), Open WebUI, LibreChat, plus raw `openai` SDKs (TS/Python).
- **TC-GW-05** Gateway logs per-request: offering chosen, revision pinned, cost, latency — the demo artifact for pilots ("here is every token and cent").

### 3.4 MCP mode
- **TC-MCP-01** `onp mcp` exposes tools: `search_offerings`, `get_offering`, `estimate`, `invoke_offering` (policy-gated), `run_scenario`; resources: recent receipts summary. Works in Claude Desktop/Code, Cursor, VS Code as MCP hosts.

### 3.5 Test-harness duties
- **TC-TEST-01** `onp conformance --node <origin>` runs the client-side Stage A checks against any node (the same battery REQ-001 DS-ADM-01 runs), producing a shareable report — node developers self-test before registering.
- **TC-TEST-02** End-to-end smoke suite (`onp e2e`) against a target registry: register-fixture → search → estimate → invoke → receipt-verify; used in CI for both REQ-001 and the Node Kit.

## 4. Non-functional

- **TC-NFR-01** Single static binary (or `npx`/`pipx` one-liner) for Win/macOS/Linux; no daemon requirements; config in one TOML file.
- **TC-NFR-02** Gateway overhead p50 < 20 ms added latency; streaming pass-through unbuffered.
- **TC-NFR-03** Secrets in OS keychain; gateway binds loopback by default and refuses non-loopback bind without an auth token.
- **TC-NFR-04** Apache-2.0; SDK published to npm/PyPI from the same codebase.

## 5. Acceptance (MVP done =)

1. `onp e2e` green against the REQ-001 registry with a Node-Kit fixture node.
2. **Cursor** configured with `http://localhost:4141/v1` + token chats through a discovered university node, with receipts in the ledger.
3. **VS Code** (Copilot BYOK or Continue) completes the same flow; **Open WebUI** lists gateway models and streams.
4. A `price_changed` 409 injected mid-test is recovered per TC-INV-01 without user-visible failure.
5. A Scenario with triage→escalate roles resolves both roles from live search, runs, and reports estimate-vs-actual within tolerance.
6. `onp conformance` correctly fails a deliberately broken fixture node (missing usage, wrong model id) with actionable errors.

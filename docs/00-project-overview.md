# OpenNodes — Project Overview

**Status: Draft 0.1 · 2026-08-24 · opennodes.io · github.com/opennodes-io/opennodes**

This document describes the OpenNodes concept, the architecture of the protocol, the state of the initial implementation, the development stages completed so far, and the steps ahead.

---

## 1. The concept

Every layer of the AI stack has converged on a standard except one. MCP standardized how AI applications reach **tools**. The OpenAI API shape became the de facto standard for **invoking models**. x402 standardized **machine-to-machine payments**. W3C DIDs and Verifiable Credentials cover identity and attestations. But **nothing standardizes how a client finds an inference endpoint it doesn't already know**: what model it serves, at what size and quantization, on what hardware, at what per-token price, with what verified capabilities — and whether it is honest and up.

Today that knowledge exists only inside proprietary catalogs (OpenRouter, Hugging Face Inference Providers, hyperscaler model gardens). Each is curated, centralized, in the request path, and closed: a university GPU cluster, a sovereign regional cloud, or an on-prem enterprise deployment cannot be listed at all.

**OpenNodes (ONP — the OpenNodes Protocol)** is an open standard for that missing layer. It defines:

- how any provider — from a frontier lab to a single Ollama box — **self-describes** as an *AI Node*;
- how registries **index, verify, rank, and serve search** over those nodes, with open registration and adversarial trust checks;
- how clients and AI agents **discover, pre-price, invoke, and audit** inference across providers — including multi-model chains;
- how all of it **composes with existing standards** rather than replacing them: OpenAI-compatible invocation, MCP for tool access and editor integration, x402/prepaid for settlement, DIDs/VCs for identity and attestations.

The design principle throughout: **standardize the gap, reuse the rest.** And its trust principle: **verified, not just ranked** — claims are never blended with measurements, ranking inputs must be disclosed, and a node that serves something other than what it claims is detected and delisted.

## 2. Architecture

### The loop: discover → verify → estimate → invoke → receipt

1. **Node Card** (ONP-2). A signed, revisioned JSON document at `https://{origin}/.well-known/open-node.json`. It joins what no existing format joins: model artifact (linked to its Hugging Face repo or a vendor URN) ↔ serving configuration (context window, quantization, capabilities, languages) ↔ hardware ↔ benchmarks ↔ per-unit price ↔ invocation binding. Every performance claim carries a `basis`: `claimed` (self-reported) or `attested` (backed by a Verifiable Credential).

2. **Registry & Discovery** (ONP-3). A registry is a *protocol, not a place*: an OpenAPI any party can implement. Registration is open (namespace proven via DNS TXT or HTTP challenge); trust is earned through a staged admission battery:
   - **Stage A** — conformance: health, card↔endpoint agreement, blind invocation with usage accounting;
   - **Stage B** — substance: *identity fingerprinting* (deterministic probe battery against reference outputs — you cannot serve a cheap substitute under a premium model's name), *context verification* (needle-in-haystack at 25/50/90% of the claimed window; overclaims are capped, not trusted), *capacity ramps* (measured TTFT/throughput overrides claims in search results);
   - **Stage C** — continuous: liveness sweeps feeding a rolling availability score, plus random blind invocations at unpredictable times (defeating "benchmark mode"), with auto-suspension on sustained failure.
   Ranking is transparent by rule: every result carries `rank_explanation` with component weights and values. Registries federate through a signed, mirrorable export feed — provenance survives replication, and no registry owns the data.

3. **Invocation** (ONP-4). No new wire format: nodes speak OpenAI-compatible profiles plus three additive headers. `ONP-Offering` pins *what* you believe you're calling; `ONP-Card-Revision` pins *the price you agreed to* (silent repricing becomes a 409, never a surprise bill); `ONP-Receipt` returns a signed usage receipt. Plain OpenAI traffic without the headers passes untouched — adoption has no cliff.

4. **Estimation & agents** (ONP-3 §5a, ONP-6). `POST /v0/estimate` pre-prices a whole multi-step chain — each step a concrete offering or a live search query — returning cost bounds and pinned revisions, making the estimate *enforceable*. AI agents are the expected primary consumers: registries expose discovery and estimation as MCP tools, so any MCP host plans chains (triage→specialist→judge, parallel fan-out, cascade) with zero ONP-specific code.

5. **Settlement** (ONP-5). Machine-readable price advertisement at discovery time; payment schemes negotiated per node (free, prepaid, x402 reserved); signed receipts (`amount = usage × pinned price`) as the audit primitive for billing and disputes.

## 3. The initial implementation

Two reference stacks, cross-verified against each other:

**`impl/` — JavaScript (Node ≥22.5, near-zero dependencies), Apache-2.0**

| Component | What it does |
|---|---|
| Registry | Full ONP-3 subset: registration with DNS/HTTP challenges, SSRF-guarded probe workers, Stage A/B/C admission, transparent ranking, estimation, MCP server at `/mcp`, signed NDJSON export feed, persistent Ed25519 signing identity, storage drivers for `node:sqlite` (dev) and PostgreSQL (production) behind one async contract |
| Catalog importers | OpenRouter (417 offerings live, incl. image/video models), Hugging Face Inference Providers (14 providers / 310 offerings, with real parameter counts and per-provider measured performance), models.dev (188 providers / 7,104 offerings) — all entering as `unverified`/`source: import`, refreshed by a periodic scheduler |
| Gateway | A local OpenAI-compatible server exposing discovered offerings to *unmodified* third-party apps (Cursor, VS Code, Open WebUI…): aliases, live-search-backed virtual models, revision pinning with transparent reprice recovery, per-host BYOK upstream keys, receipt verification, spend ledger |
| `onp` CLI + stdio MCP server | Search/estimate/invoke from the terminal; `onp mcp` installs OpenNodes discovery + chain pricing into any MCP editor host (`--print-config` emits the paste-ready config) |
| Fixture node | A fully conforming test node with deterministic behavior, used by the e2e suites and the registry's conformance probes |

**`node-kit/` — Python (aiohttp + cryptography), Apache-2.0**

The supply-side on-ramp: a reverse proxy that turns any OpenAI-compatible engine (vLLM, Ollama, TGI) into a conforming node *without touching the engine* — card generation from engine interrogation, Ed25519 signing byte-compatible with the JS verifier, receipts (inline; by-URL for streams), a Stage A self-test that gates registration, and one-command register.

**Verification state:** 28 automated tests (27 passing, 1 opt-in real-Postgres run), including cross-language e2e (Python-signed cards verified by the JS registry), a spawned-child-process MCP handshake, and adversarial cases (an impersonating node is detected and delisted; an overclaimed context window is capped). Validated live against a real deployment: a CPU Ollama box serving Gemma was wrapped, registered, challenge-verified, Stage-A probed, and chatted with through the full gateway chain with a signed receipt.

## 4. Development stages completed

| Stage | What happened | Outcome |
|---|---|---|
| **0 — Research & gap analysis** | Landscape survey: MCP + Registry, WebMCP, A2A, AGNTCY, ANP, NANDA, OpenAI-compatible APIs, DIDs/VCs, x402, model cards, MLPerf; market survey: OpenRouter, HF, gateways, DePIN compute, OS AI runtimes, payment rails; universal-client market study | The white space confirmed: every ingredient exists, the composition — an open, verified, federated registry of inference endpoints — does not (docs/01, 02, 04) |
| **1 — Specification** | ONP Draft 0.1 authored as six documents plus the normative Node Card JSON Schema | spec/ONP-1..6, schemas/open-node.schema.json |
| **2 — Requirements** | Buildable requirements with acceptance criteria for the registry, the client, and the node kit | requirements/REQ-001..003 |
| **3 — Reference stack** | Registry MVP → gateway → MCP surface → Stage B/C + hardening (SSRF, DNS challenges, export, importers) → Python Node Kit; each milestone landed with tests | The full discover→verify→estimate→invoke→receipt loop running end-to-end, cross-language |
| **4 — Real-model validation** | Live Ollama/Gemma deployment through the entire chain | First real node; two real bugs found and fixed by real-world testing (cross-language float serialization; reasoning-model token budgets) |
| **5 — Production storage & identity** | Async store contract with sqlite + PostgreSQL drivers; persistent registry signing key; connection-lifecycle fixes | Restart-safe registry: same signing key, same data, same tiers |
| **6 — Catalog reach & editor distribution** | OpenRouter/HF importers, modalities (input/output) field, `onp mcp` stdio server, BYOK gateway routing, re-import scheduler | Cross-catalog search + chain pricing installable in Cursor/VS Code — a surface no single incumbent offers |
| **7 — Publication readiness** | Licenses (Apache-2.0 code, CC-BY-4.0 spec), sanitized public history, opennodes.io registered, GitHub org + repo (`opennodes-io/opennodes`), landing site + Pages deploy workflow | One visibility flip away from public |

## 5. Next steps

**Immediate**
1. Hands-on editor validation (Cursor/VS Code with the generated MCP config) and an Open WebUI pass over the gateway.
2. One test-suite run against a real PostgreSQL server (`ONP_PG_URL`).
3. Flip the repo public, enable Pages, point opennodes.io DNS, announce quietly.

**Near term (Draft 0.2 and hardening)**
4. Spec: promote `modalities: {input, output}` to normative; finalize detached-JWS card serialization; settlement OpenAPI.
5. Registry: image/audio invocation profiles in gateway and probes; receipt reconciliation in Stage C blind probes; MCP Registry importer (tool servers as `onp.mcp.server/v1`); admin UI.
6. Node Kit: prepaid key management, probe-allowance accounting, metrics, additional engine adapters.

**Phase 2 — first real supply and demand**
7. Institutional pilots: university clusters and national/EU computation centres onboarded via the Node Kit with institutional fast-track admission — supply no incumbent catalog can list.
8. Settlement MVP: registry-settled prepaid credits with receipts as the redemption primitive; x402 pass-through as the low-compliance path.
9. First external attesters (benchmark and uptime credentials as VCs).

**Phase 3 — ecosystem**
10. A second, independent registry implementation and live federation — the credibility milestone for a standard.
11. OS-runtime adapters (resolver behind Apple's `LanguageModel` protocol, Windows AI Foundry catalogs); WebMCP site directory when WebMCP matures.
12. ONP 1.0 candidate and a conversation about a neutral foundation home.

## 6. Fact sheet

- **Name:** OpenNodes; protocol **ONP** (OpenNodes Protocol), Draft 0.1
- **Home:** opennodes.io · **Repo:** github.com/opennodes-io/opennodes
- **Licenses:** Apache-2.0 (code), CC-BY-4.0 (specification & schemas)
- **Implementations:** JS reference stack (registry, gateway, CLI/SDK, MCP servers, fixture), Python Node Kit
- **Live catalog reach via importers:** ~7,800 offerings across OpenRouter, Hugging Face Inference Providers, and models.dev
- **Tests:** 28 (27 pass, 1 opt-in), including cross-language and adversarial cases

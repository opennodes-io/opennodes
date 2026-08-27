# OpenNodes Protocol (ONP) — Draft 0.1

**An open standard for discovering, invoking, and paying AI inference endpoints ("AI Nodes") across vendors — from frontier labs to a university GPU cluster — with bridges to MCP and WebMCP.**

Status: **Draft 0.1 (working proposal, 2026-08-20)** — not affiliated with any standards body yet.
Home: **opennodes.io**

## The one-sentence pitch

MCP standardized how AI applications reach *tools*; the OpenAI API shape standardized how they *invoke models*; x402 standardized how machines *pay each other* — but **nothing standardizes how a client finds an inference endpoint it doesn't already know about**: what model it serves, how big it is, what hardware backs it, how well it benchmarks, what it costs per token, and whether it's up. ONP fills exactly that gap and composes the rest from existing standards.

## Documents

### Start here
- [00 — Project overview](docs/00-project-overview.md) — the concept, architecture, implementation status, completed development stages, and next steps in one document.

### Research (why this standard, and why now)
- [01 — Protocol & standards landscape](docs/01-protocol-landscape.md) — MCP + Registry, WebMCP, A2A, AGNTCY, ANP, NANDA, OpenAI-compatible APIs, DIDs/VCs, x402, UCAN, model cards, MLPerf; full gap analysis.
- [02 — Market landscape & demand evidence](docs/02-market-landscape.md) — OpenRouter, HF Inference Providers, gateways, DePIN/decentralized compute, OS-level AI runtimes, payment rails; viability assessment.
- [04 — Universal AI client landscape](docs/04-universal-client-landscape.md) — AI browsers, branded assistants, neutral/BYOK clients, multi-homing data, distribution economics; assessment of the "primary access point" client idea.

### Specification suite
- [ONP-1 — Overview, terminology, architecture, conformance](spec/ONP-1-overview.md)
- [ONP-2 — The Node Card](spec/ONP-2-node-card.md) — self-description document at `/.well-known/open-node.json`
- [ONP-3 — Registry & Discovery API](spec/ONP-3-registry.md) — registration, verification, search, health, ranking, federation
- [ONP-4 — Invocation profiles](spec/ONP-4-invocation.md) — bindings for text, image/diffusion, embeddings, agents
- [ONP-5 — Settlement](spec/ONP-5-settlement.md) — price advertisement, payment schemes (x402 / prepaid / free), signed usage receipts
- [ONP-6 — Bridging](spec/ONP-6-bridging.md) — connecting discovered nodes to MCP servers, WebMCP sites, and conventional web data

### Development requirements
- [REQ-001 — Discovery Service (registry)](requirements/REQ-001-discovery-service.md) — MVP registry: registration, admission battery, search, estimation, MCP surface; acceptance criteria.
- [REQ-002 — Test client](requirements/REQ-002-test-client.md) — CLI + OpenAI-compatible gateway + MCP modes; compatibility matrix (Cursor, VS Code, Open WebUI…).
- [REQ-003 — Node Kit](requirements/REQ-003-node-kit.md) — reverse-proxy wrapper turning vLLM/Ollama/TGI into a conforming node: card generation, receipts, registration, self-test.

### Implementation
- [schemas/open-node.schema.json](schemas/open-node.schema.json) — normative JSON Schema for the Node Card (Phase 0 deliverable).
- [impl/](impl/README.md) — runnable reference stack (registry + fixture node + `onp` CLI/gateway); `npm install && npm test` in `impl/`.
- [node-kit/](node-kit/README.md) — Python Node Kit (REQ-003): wraps any OpenAI-compatible engine (vLLM/Ollama/TGI) into a conforming node; cross-language e2e against the JS registry.

## Ecosystem

Clients and products consuming ONP — independent of the standard, listed here for discovery:

- **[Surge](https://github.com/opennodes-io/surge)** — a desktop "browser for MCP" with a native OpenNodes provider: model discovery with trust tiers and measured latency in the picker, enforceable pre-pricing, pinned direct-to-node invocation. The first client to span both discovery layers (models via ONP, tools via MCP).
- **Your client here** — ONP is an open standard; any client can implement discovery via [ONP-3](spec/ONP-3-registry.md) and invocation via [ONP-4](spec/ONP-4-invocation.md). Open a PR to be listed.

## Design principles

1. **Standardize the gap, reuse the rest.** ONP defines only the Node Card, the Registry API, and thin profiles binding existing standards together. Invocation is OpenAI-compatible; payment is x402/prepaid; identity is domain-based with optional DIDs; tool access is MCP.
2. **Registry as a protocol, not a place.** Like the MCP Registry, ONP specifies an OpenAPI interface any registry can implement. Anyone can run a registry; clients can query several; a root "meta-registry" is a bootstrap convenience, not an architectural requirement.
3. **Metadata is claims + attestations.** Nodes self-report; registries and third-party attesters verify (liveness probes, conformance tests, benchmark attestations as Verifiable Credentials). Rank is computed by registries from declared, transparent components — ONP standardizes the *signal format*, not the ranking formula.
4. **Curated trust tiers, permissionless entry.** Anyone can publish a Node Card and register (Community tier). Paid production traffic concentrates in Verified/Attested tiers — this is the lesson of Bittensor/Akash vs. OpenRouter/HF.
5. **The client is the orchestrator.** Multi-node scenarios, MCP bridging, and WebMCP access are client-side composition over standard primitives — ONP specifies the primitives and a portable scenario format, not an orchestration runtime.

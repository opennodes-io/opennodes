# ONP-1: Overview, Terminology, Architecture, Conformance

**OpenNodes Protocol — Draft 0.1 — 2026-08-20**

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY are to be interpreted as described in RFC 2119.

---

## 1. Scope

ONP standardizes the **discovery layer for AI inference endpoints** and the thin profiles needed to make discovery actionable:

- a self-description document (**Node Card**, ONP-2) that any inference provider publishes;
- a **Registry & Discovery API** (ONP-3) that any party can implement to index Node Cards, verify claims, compute rankings, and serve search;
- **invocation profiles** (ONP-4) that map discovered models onto existing wire formats (OpenAI-compatible chat/completions, images, embeddings; A2A for agent nodes);
- a **settlement profile** (ONP-5) for machine-readable price advertisement and per-request payment via existing rails (x402, prepaid API keys, free);
- **bridging profiles** (ONP-6) describing how a conforming client connects discovered nodes to MCP servers, WebMCP-enabled websites, and conventional web data.

**Out of scope:** model training; model weights distribution (Hugging Face Hub et al.); the internals of routing intelligence; agent-to-agent task semantics (A2A); tool-call semantics (MCP); payment settlement mechanics (x402/ACP/L402); browser tool APIs (WebMCP). ONP composes these, it does not re-specify them.

## 2. Terminology

| Term | Definition |
|---|---|
| **AI Node** | A network-reachable service exposing one or more AI models for inference, described by a Node Card. May be a frontier-lab API, a regional cloud, a university cluster, an enterprise on-prem gateway, or a single machine. |
| **Node Card** | The signed JSON self-description of an AI Node: identity, models, hardware, pricing, endpoints, capabilities. Published at `/.well-known/open-node.json`. See ONP-2. |
| **Model Offering** | One (model, serving-configuration) pair inside a Node Card: a specific model artifact, at a specific quantization/context configuration, behind a specific binding, at a specific price. The unit of discovery and routing. |
| **AI Nodes Registry** | A service implementing the ONP-3 API: accepts registrations, verifies namespaces and liveness, indexes Model Offerings, serves search/rank, and optionally operates settlement. |
| **Attester** | A party that issues signed statements (W3C Verifiable Credentials) about a Node or Offering — benchmark results, uptime history, conformance-test passes. A registry can be an attester; so can third parties (labs, universities, audit firms). |
| **AI Node Client** | An application (desktop, mobile, OS-integrated, or SDK embedded in a dev tool) that queries registries, selects and invokes nodes, handles settlement, and bridges nodes to MCP/WebMCP/web data. |
| **Scenario** | A portable, declarative description of a multi-step task spanning one or more Offerings and tool connections, executed by a client. See ONP-6 §5. |
| **Trust tier** | `unverified` → `community` → `verified` → `attested`. Assigned per Node by each registry according to ONP-3 §6. |

## 3. Architecture

```
                                 ┌────────────────────────────┐
        federation (ONP-3 §8)   │   AI Nodes Registry (root)  │
      ┌─────────────────────────►│  index · verify · rank ·    │◄───── registration +
      │                          │  search · (settlement)      │       namespace proof
┌─────┴─────────┐                └─────────────▲──────────────┘       (ONP-3 §4)
│ Regional /    │                              │ search, resolve               │
│ vertical      │                              │ (ONP-3 §5)                   │
│ registries    │                ┌─────────────┴──────────────┐        ┌───────┴────────┐
└───────────────┘                │       AI Node Client        │        │    AI Node     │
                                 │ discovery · selection ·     │        │  /.well-known/ │
                                 │ scenarios · settlement      │───────►│  open-node.json  │
                                 └──┬──────────┬──────────┬───┘ invoke │  + inference   │
                                    │          │          │    + pay   │  endpoints     │
                              MCP servers   WebMCP     plain web       └────────────────┘
                              (tools)       sites      (fetch)
                              ONP-6 §2     ONP-6 §3  ONP-6 §4
```

Three independent conformance classes; any party can implement any subset:

- **ONP Node** — publishes a valid Node Card, serves at least one invocation binding, honors its advertised payment schemes, serves the health endpoint.
- **ONP Registry** — implements the ONP-3 OpenAPI; performs namespace verification and liveness probing; labels trust tiers; exposes ranking-signal provenance.
- **ONP Client** — can resolve Node Cards directly and via registries, invoke at least the `openai.chat` binding, and enforce user-set spend/trust policies.

## 4. Layering on existing standards (normative reuse)

| Layer | ONP uses | ONP defines |
|---|---|---|
| Identity | HTTPS origin + DNS/HTTP challenge (as MCP Registry); OPTIONAL W3C DID v1.1 (`did:web` recommended) | Which fields carry them (ONP-2 §3) |
| Self-description | A2A's `/.well-known/` pattern; JWS signing | The Node Card schema (ONP-2) |
| Model metadata | Hugging Face model-card linkage; MLCommons/open-eval benchmark identifiers | The Offering schema joining artifact↔endpoint (ONP-2 §5) |
| Invocation | OpenAI-compatible APIs (de facto); A2A v1.0 for agent nodes | Binding identifiers + minimum conformance per binding (ONP-4) |
| Payments | x402 (LF); provider-prepaid keys; L402 optional | Price-advertisement schema + signed usage receipts (ONP-5) |
| Attestations | W3C Verifiable Credentials 2.0 | Attestation types & claim vocabularies (ONP-3 §7) |
| Tools | MCP (2025-11-25 or later) | The client-side bridge contract (ONP-6 §2) |
| Web tools | WebMCP (W3C WebML CG draft) | Client mediation + registry `webmcp` flag (ONP-6 §3) |

## 5. Versioning

Every ONP document and every Node Card carries `"onp": "0.1"`. Within a major version, additive changes only; unknown fields MUST be ignored (must-ignore semantics). Registries advertise supported versions in `GET /v0/health`.

## 6. Threat model (summary)

The full considerations live in each part; the four attacks ONP is designed around:

1. **Impersonation** (claiming to serve "GPT-5" while serving something cheaper) → signed cards, trust tiers, registry conformance probes that run blind test prompts against offerings (ONP-3 §6), benchmark attestations.
2. **Metadata inflation** (fake benchmark scores, fake hardware) → self-reported fields are explicitly labeled `claimed`; only attester-signed values may be labeled `attested`; registries MUST NOT rank on unverified claims without disclosing so.
3. **Rug-pull pricing** (advertise low, bill high) → the price in force is the one in the signed Node Card revision referenced at invocation time; receipts (ONP-5 §5) bind usage to that revision; clients enforce ceilings.
4. **Registry capture** (a registry favoring its own nodes) → ranking-signal provenance is mandatory and machine-readable; federation makes switching registries cheap; the Node Card lives at the node's origin, not in any registry.

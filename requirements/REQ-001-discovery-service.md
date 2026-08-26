# REQ-001 — OpenNodes Discovery Service (Registry) — Development Requirements

**Version 0.1 (draft) — 2026-08-21 — Target: Phase 1 "Registry v0" implementing spec ONP-3.**
Requirement keywords per RFC 2119. IDs are stable for traceability (`DS-<area>-<n>`).

## 1. Purpose & scope

A hosted service where AI Node operators register signed Node Cards and where clients/agents search Model Offerings, get cost/latency estimates, and retrieve trust signals. MVP covers: registration + namespace verification, card indexing, admission Stage A fully + Stage B subset, search, estimation, MCP tool surface, export feed, and an operator admin view.

**Out of MVP scope:** settlement (separate service, ONP-5), Stage C random blind probing (stub scheduler only), attestation VC issuance (data model present, issuance manual), federation peering (export feed only), site directory (WebMCP flag), sponsored placement.

## 2. Actors

- **Node operator** — registers/updates nodes; sees probe results.
- **Client/agent** — searches, estimates, resolves cards (unauthenticated).
- **Registry admin** — reviews flagged nodes, manages institution allowlist, suspends listings.
- **Probe worker** — internal; executes admission and liveness jobs.

## 3. Functional requirements

### 3.1 Registration & namespace verification
- **DS-REG-01** `POST /v0/nodes` accepts `{card_url}`; service MUST fetch the card, validate against `open-node.schema.json`, and reject with machine-readable errors (RFC 9457) on failure.
- **DS-REG-02** Service MUST verify JWS signature against keys at the card origin (`/.well-known/jwks.json`) or the node's `did:web` document.
- **DS-REG-03** Namespace proof via DNS TXT (`_onp-challenge.{domain}`) or HTTP (`/.well-known/onp-challenge/{token}`); challenge TTL 72 h; `POST /v0/nodes/{id}/verify` completes it.
- **DS-REG-04** Lifecycle states exactly as ONP-3 §3 (`submitted → challenged → indexed(unverified) → community → verified`, plus `suspended`/`delisted`/`disputed`); every transition MUST be timestamped and queryable (`GET /v0/nodes/{id}/history`).
- **DS-REG-05** Institution allowlist (domain patterns + roster source per entry); matching namespaces enter Stage B queue automatically and carry `institutional: true`.
- **DS-REG-06** Re-fetch cards every ≤6 h and on `PUT /v0/nodes/{id}/ping`; a card revision with changed `model`/`serving`/`hardware`/`pricing` blocks MUST re-trigger the relevant admission stages (pricing change: no re-test, but new revision indexed within 15 min).
- **DS-REG-07** `DELETE /v0/nodes/{id}` requires a fresh origin proof; delisting keeps history (tombstone), never erases it.

### 3.2 Admission battery (probe workers)
- **DS-ADM-01 (Stage A, MVP-complete)** Per offering: health endpoint check; one blind invocation through the declared binding profile validating response schema, streaming, and `usage` presence; `GET /models` ↔ card agreement. Runs on registration, on every card revision, and every 6 h.
- **DS-ADM-02 (Stage B, MVP subset)** Identity fingerprinting for a configured set of ≥10 open-weight families: fixed prompt battery, temperature 0, output/logprob distance vs. stored reference vectors; configurable threshold; mismatch ⇒ `model.artifact` marked `disputed` and tier capped at `community`.
- **DS-ADM-03 (Stage B)** Context probe at 25/50/90 % of claimed window (needle-in-haystack battery); failure caps the *indexed* `context_window` to the largest passing size, with the cap visible in search results.
- **DS-ADM-04 (Stage B)** Capacity ramp: stepped concurrency to claimed TPS, sustained 15 min; store measured TTFT/TPS p50/p95; measured values MUST override claimed values in search payloads (claimed retained, labeled).
- **DS-ADM-05** Probes spend the node's `probe_allowance` first and MUST hard-stop at its limit; per-node daily probe budget enforced centrally.
- **DS-ADM-06 (Stage C, stub)** Liveness scheduler at 5-min cadence for `verified` nodes storing rolling 7/30-day availability; random blind-probe scheduler behind a feature flag (off in MVP).
- **DS-ADM-07** Proprietary artifacts (`urn:proprietary:{vendor}:*`) MUST be claimable only by the vendor's own verified namespace (vendor→namespace mapping table, admin-managed).

### 3.3 Search & retrieval
- **DS-SRCH-01** `GET /v0/offerings` implements every filter in ONP-3 §5 (modality, family/artifact, min_context, supports, lang:grade, price ceilings, region, scheme, tier, basis, free-text `q`) with cursor pagination.
- **DS-SRCH-02** Each result MUST carry three clearly separated value groups: card-claimed, registry-observed (probe measurements + availability), attested (linked VCs) — never merged.
- **DS-SRCH-03** `rank` computed from configurable weighted components; `GET /v0/health` MUST publish component names + weights; each result MUST include `rank_explanation` with per-component values.
- **DS-SRCH-04** Search p95 latency < 300 ms at 10k offerings / 50 rps (see §5).
- **DS-SRCH-05** `GET /v0/nodes/{id}` and `GET /v0/offerings/{node_id}/{offering_id}` return full detail incl. probe history summary and listing history.

### 3.4 Estimation
- **DS-EST-01** `POST /v0/estimate` per ONP-3 §5a: steps as concrete offerings or embedded `select` queries; response includes per-step cost min/max, `card_revision` priced against, expected latency percentiles from observations; free, unauthenticated, side-effect-free, rate-limited by IP.

### 3.5 Agent & ecosystem surfaces
- **DS-MCP-01** The registry MUST expose an MCP server (`search_offerings`, `get_offering`, `estimate` tools) over streamable HTTP, generated from the same handlers as the REST API.
- **DS-EXP-01** `GET /v0/export?since=` streams signed NDJSON snapshots (cards + observations) for mirrors/aggregators.
- **DS-IMP-01** Seed importers, runnable as jobs: models.dev catalog → `unverified` offerings with `source: "import"`; MCP Registry `server.json` records → `onp.mcp.server/v1` entries. Imported records MUST be visually distinct and excluded from `verified` tiers until claimed by their operator.

### 3.6 Admin & observability
- **DS-ADM-UI-01** Admin view: pending verifications, probe failures, dispute queue, institution allowlist CRUD, suspend/reinstate with reason (reasons appear in listing history).
- **DS-OBS-01** Structured logs, metrics (registrations, probe pass rates, search QPS/latency, estimate volume), and audit log for all admin actions.

## 4. Data model (summary)

`nodes` (id, origin, state, institutional, timestamps) · `card_revisions` (node_id, revision, raw JSON, sig status) · `offerings` (denormalized searchable projection of latest revision) · `probes` (type, stage, offering, result, measurements, spent budget) · `observations` (rolling aggregates) · `attestations` (VC blobs + parsed claims) · `state_transitions` · `institutions` · `vendor_namespaces`. Postgres; search via indexed columns + trigram/`tsvector` for `q` (no external search engine in MVP).

## 5. Non-functional requirements

- **DS-NFR-01** Availability 99.5 % (MVP, single region); registry outage MUST NOT break invocation (clients cache cards — document TTL guidance).
- **DS-NFR-02** Scale targets: 1k nodes / 10k offerings / 50 rps search / 500 probe jobs per hour.
- **DS-NFR-03** All endpoints TLS; write endpoints rate-limited; probe workers egress-isolated (they call untrusted node URLs — SSRF protections: deny private ranges, response size/time caps).
- **DS-NFR-04** GDPR: operator contact data minimal, exportable, erasable post-delisting (tombstones keep only non-personal facts); EU hosting.
- **DS-NFR-05** Everything reproducible: probe verdicts store inputs' hashes + harness version so any verdict can be re-derived.
- **DS-NFR-06** License Apache-2.0; no proprietary dependency in the conformance-relevant path.

## 6. Acceptance (MVP done =)

1. A node registered with the Node Kit passes DNS challenge, Stage A, and appears in search within 10 min end-to-end.
2. A card claiming `llama-4-*` while serving a different model is auto-marked `disputed` by DS-ADM-02.
3. A claimed 256k context that fails at 90 % is indexed at the passing size, visibly capped.
4. `estimate` for a two-step chain (one concrete offering + one `select`) returns enforceable revisions; invoking with those revisions does not 409.
5. Claude Desktop (or any MCP host) connected to DS-MCP-01 can search and estimate with no ONP-specific code.
6. Seeded catalog (importers) yields ≥200 searchable offerings before any real registration.

# ONP Draft 0.1 — known issues and what happens to them

Two independent technical reviews of Draft 0.1 (October 2026) raised the points below. This page records each one and its outcome: **fixed** in the Draft 0.1 errata of 2026-10-23, **planned** for Draft 0.2, or **not adopted** with the reason. New reports are welcome as [GitHub issues](https://github.com/opennodes-io/opennodes/issues).

## Fixed in the errata (2026-10-23)

| Issue | Where |
|---|---|
| How trust tiers apply: tiers are per node; context caps, measured performance and identity disputes are per offering; client trust/jurisdiction/price constraints are hard filters, never score weights | ONP-1 §3a |
| ONP-1 pointed to the wrong section for verification; it now summarizes the admission battery and links ONP-3 §4a | ONP-1 §2, §3a, §6 |
| No rules for breaking changes — now: drafts may change with a 6-month overlap; from 1.0, breaking changes only in a new major version, with a 12-month dual-acceptance window and a migration section | ONP-1 §5 |
| Threat model lacked residency misstatement / silent sub-processing (a node declaring an EU or Canadian operator while forwarding requests elsewhere) | ONP-1 §6 (threat 5) |
| Signature canonicalization was unnamed (cross-language verification risk) — now JSON Canonicalization Scheme, RFC 8785, for cards and receipts | ONP-2 §8, ONP-5 §5 |
| Stale schema path (`ai-node.schema.json`) | ONP-2 §9 → `schemas/open-node.schema.json` |
| `operator.country` meaning (operator jurisdiction, not hardware location) and how multi-site operators publish (one card per host) | ONP-2 §3 |
| The jurisdiction filter (`jurisdiction=eea` / country codes, declared vs. inferred) was implemented but not specified | ONP-3 §5, §5b |
| Identity checks were described as distribution-based; the reference registry compares exact output. Both are now allowed, with a review step for mismatches on different hardware | ONP-3 §4a.4, §6.3 |
| Streaming receipts: headers precede the tokens, so for `stream: true` the receipt header is a URL filled in after the stream; an optional final `onp.receipt` SSE event | ONP-4 §2 |
| `request_hash` was undefined and the two reference implementations hashed differently — now SHA-256 of the raw request body bytes; the test node was aligned | ONP-5 §5 |
| Reasoning ("thinking") tokens: counted in `completion_tokens` at the output price, never billed twice | ONP-5 §1 |
| Scenario `if` conditions had no grammar (a client using `eval` would run untrusted code) — now a fixed small grammar, and clients MUST NOT use a general-purpose evaluator | ONP-6 §5 |
| Server location was not checked at all (a node could declare an EU operator while running elsewhere). Now: IP geolocation + network owner, and round-trip times from two probe sites (Nuremberg, Helsinki) against physical limits; a server found outside the requested jurisdiction is excluded from jurisdiction filters. Evidence, not proof — a forwarding front server still defeats it (attested residency below) | ONP-3 §6.4; reference registry 0.1.22 |

## Planned for Draft 0.2

| Issue | Plan |
|---|---|
| Criteria for the `attested` tier | Which attestation types, from which attesters, how fresh |
| Settlement API | Deposit, token issue, redeem, statements (OpenAPI companion) |
| Identity checks across heterogeneous hardware | Two-tier: distribution/logprob comparison where exposed, behavioral signature otherwise |
| `model.artifact` cannot name a file or revision inside a repository (e.g. one GGUF quantization) | Optional `:{tag}` / `@{revision}` suffix; schema pattern widened |
| Operator country vs. where an offering runs; endpoints per offering | Per-offering execution location (ISO 3166-1) and optional per-offering endpoints |
| Receipts for audits | Optional account binding (hash of the buyer account or a client nonce) and execution location in the signed receipt — still operator statements, not proof |
| Attested residency | An auditor credential for residency (the network checks above are signals, not proof); operator identity checks (registered EU company, sanctions screening) before an "EU operator" label |
| Pricing gaps | Optional separate reasoning-token price and prompt-cache write price |
| Reference implementations | Python Node Kit: exact RFC 8785 number formatting (e.g. `1e-7`); drop the internal `_jws` member from signature entries; persist receipts instead of keeping them only in memory |
| Well-known URI | Register `open-node.json` with IANA (RFC 8615) once the card format stabilizes |

## Not adopted

| Suggestion | Why not |
|---|---|
| Require nodes to implement the MCP / WebMCP bridging contract | Bridging is client-side by design (ONP-6): requiring it of every node adds operator burden for no gain, and keeps tool credentials off remote nodes |
| Treat receipts as proof of where inference ran (e.g. for subsidy or residency audits) | A receipt proves usage and price, signed by the operator; location in it would be the operator's own statement. Proof needs an attestation (planned above) |

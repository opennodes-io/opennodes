# ONP Draft 0.1 — known issues and what happens to them

Three independent reviews of Draft 0.1 raised the points below: two technical reviews in October 2026, and a review of node validation and trust by an expert reviewer on 18 November 2026. This page records each point and its outcome: **fixed** (in the errata of 2026-10-23 or in a later revision), **planned** for Draft 0.2, **open**, or **not adopted** with the reason. New reports are welcome as [GitHub issues](https://github.com/opennodes-io/opennodes/issues).

## Expert review (2026-11-18): node validation and trust

The review found that "verified" could not yet carry personal data: the admission battery could be timed, avoided or cleared, and the Ollama router treated any LAN peer as the user's own network. Its "Now" items for the Ollama router (section 4.11) are fixed in revision 10, and those for the registry and the Node Kit (sections 4.2, 4.3, 4.3a, 4.6) in revision 11 ([CHANGES](CHANGES.md)); the rest is listed with its status. Section numbers are the review's.

| Finding | Status | Where |
|---|---|---|
| 4.11 Ollama router: CORS `*` and no authentication, so any web page could add a "LAN" peer, read receipts and spend keys | **Fixed** (rev. 10): no wildcard CORS; the router API needs a token; model routes only for local Host and Origin; `--public-bind` needs a token | ONP-3 §5b |
| 4.11 Ollama router: mDNS on by default, and any LAN peer, with any advertised origin, counted as the user's own network for private, EU and sensitive routing | **Fixed** (rev. 10): mDNS opt-in; a LAN peer is the user's network only when its card is signed by a pinned key and it answers at that card's origin; a missing data policy is unknown | ONP-3 §5b, §5e |
| 4.3a Stage B ran only on an unauthenticated `/admit`: the operator chose the time, and anyone could trigger it against any node | **Fixed** (rev. 11): `/admit` is admin-only; Stage B runs on the registry's own, unpublished schedule | ONP-3 §4, §4a |
| 4.3a Scheduled Stage A (6 h) and Stage B (quarterly) were not implemented | **Fixed** (rev. 11): Stage A at least every 6 h and on every revision; Stage B after `community`, on change, and at a random time 1–91 days after a pass. Since rev. 12 also within the hour of a confirmed mismatch in a light identity check (blind probes, below), so the long gap after a pass is watched | ONP-3 §4a re-verification, §4a.9 |
| 4.3 A missing identity reference counted as a pass | **Fixed** (rev. 11): identity unverified, no `verified` | ONP-3 §4a.4 |
| 4.3 Identity prompts were fixed and public | **Fixed** (rev. 11): references from a private corpus, a random subset per run; old references ignored | ONP-3 §4a |
| 4.3 The Node Kit named open-weight models `urn:proprietary:…`, so they never had a reference | **Fixed** (rev. 11): `ollama:{name}[:{tag}]` (the optional tag names the quantization) / `hf:{org}/{repo}`, operator override, warning for the fallback | ONP-2 §5; Node Kit |
| 4.3 The vendor-namespace rule was specified but not enforced | **Fixed** (rev. 11): vendor table, Stage A `artifact-namespace` | ONP-3 §6.3 |
| 4.3 A disputed node cleared itself by registering again (demo node, 4 Oct) | **Fixed** (rev. 11): a dispute ends only with a recorded resolution | ONP-3 §3, §4 |
| 4.2 An unsigned card could reach `verified` | **Fixed** (rev. 11): refused at Stage B; a `verified` node with a failing re-fetched card is demoted | ONP-2 §8 |
| 4.6 Blind probes used fixed text ("ONP continuous probe …"), as did Stage A and the capacity ramp | **Fixed** (rev. 11): every probe prompt from the private corpus | ONP-3 §4a |
| 4.6 A `409` to a blind probe was skipped unrecorded; blind failures never demoted | **Fixed** (rev. 11): every `409` recorded, excused only after a real revision change and at most 3 a day; repeated failures cost a tier. Rev. 12 bounds the dodge the excuse left: each excused `409` brings a fresh blind probe against the new revision at a random time within the hour, under the same rules, so a node that refuses every probe with a new revision is still probed within the hour and soon runs out of excuses. Up to 3 times a day a node can still turn a probe it suspects into a retry it knows and a probe somewhere in the next hour | ONP-3 §4a.9 |
| 4.3 Exact-hash comparison of short replies separates models and quantisations poorly | **Planned** (Draft 0.2): log-probability or distribution comparison, references per quantisation, thresholds and an appeal step | ONP-3 §4a.4 |
| 4.6 The dedicated probe key of card-only listings marks every probe | **Partly fixed** (rev. 12): a card-only listing can pass Stage B but stays at `community` until the registry probes it with access it bought as an ordinary customer, which the registry's administrator records; from then on every probe uses that access, and only a later Stage B can verify it. Still open: that account is used only by the registry, so its traffic (a Stage B burst, the hourly blind calls) can give it away over time | ONP-3 §4, §4a |
| 4.6 Other ways to spot a probe: one source address | **Open**: varied networks | — |
| 4.3 Stage B stopped unjudged on any `409` to an identity prompt, so a node that refused the repeated prompt kept its tier (found while fixing the follow-up's identity point) | **Fixed** (rev. 12): a `409` is excused only when a card re-fetch shows a new revision, at most 3 times before a run is judged; with the current revision pinned it counts as a reply that does not match | ONP-3 §4a.4 |
| 4.6 Blind probes check no identity | **Partly fixed** (rev. 12): narrowed, not closed. On `verified` and `attested` nodes about 1 in 4 blind probes asks one of the offering's identity references, in the same request as any other; a confirmed mismatch makes Stage B due within the hour (at most once a day), and only Stage B disputes. Still open: the check reuses the few exact-hash references Stage B asks, so a node that recognises them (by how often they recur, or from earlier Stage B runs), or that answers a repeated prompt with the claimed model, passes it; an offering with no reference gets none. Closing it needs references a node cannot learn: comparison on arbitrary prompts (the Draft 0.2 log-probability work) or single-use references from a trusted deployment | ONP-3 §4a.9 |
| 4.6 Receipt sampling is not implemented | **Open**: receipt sampling with local token counts | ONP-3 §4a.9 marks receipt sampling as not implemented |
| 4.2 No key rotation or revocation; plaintext key file; clients cache the JWKS for the process | **Open** | — |
| 4.4 Context probes: repetitive filler, a deterministic number, self-reported token counts, 90% maximum | **Partly fixed** (rev. 11): haystack and question from the private corpus, a random number per probe. Self-reported counts and the 90% maximum remain | ONP-3 §4a.5 |
| 4.11 Gateway: no Host or Origin check on loopback; failover multiplies disclosure | **Open** | — |
| 4.5, 4.7–4.10, 4.12, 5 (load ramp and rank weighting, location evidence, receipts, registry trust root, supply chain, EU residency) | **Open**: outside revisions 10 and 11 | — |

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
| `model.artifact` cannot name a file or revision inside a repository (e.g. one GGUF quantization) | Done for Ollama artefacts in revision 11: `ollama:{name}[:{tag}]`, the tag naming the quantization (ONP-2 §5). Still planned for `hf:{org}/{repo}`: an optional `:{tag}` / `@{revision}` suffix, with the schema pattern widened |
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

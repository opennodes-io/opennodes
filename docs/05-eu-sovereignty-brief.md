# 05 — OpenNodes and European digital sovereignty (one-page brief)

*October 2026. Web version: https://opennodes.io/eu*

## In one paragraph

OpenNodes is an open protocol (ONP, CC-BY-4.0) and an open-source registry (Apache-2.0) for **finding and verifying AI inference endpoints** — from a university GPU cluster or an AI Factory service to a regional cloud or a self-hosted server. Each provider publishes a signed self-description (who operates it, in which country, on what hardware, which model, at what price, under which data policy); registries **check those claims automatically** and label claimed, measured and attested values separately. Clients then call the provider **directly**: OpenNodes is never in the data path.

## The European problem it addresses

Europe is building inference capacity in many places at once — EuroHPC AI Factories and Antennas, national centres, sovereign and regional clouds — but there is **no open, vendor-neutral way to discover and compare it**. The common shortcut is a commercial broker that sits in the middle of every request: prompts transit a third party, often outside the EEA, and trust rests on the broker's own claims. ONP standardizes discovery and verification as an open layer instead, and leaves invocation (OpenAI-compatible), tools (MCP) and payment to existing standards.

## How it maps to European requirements

| Need | ONP mechanism | Status |
|---|---|---|
| Keep prompts with the chosen processor (GDPR, transfer minimisation) | Discovery is metadata only; clients invoke the provider directly. The hosted registry never receives prompts (one documented exception: the web advisor box). | **Live** |
| Choose providers by jurisdiction | Node Cards declare the operator's country; an **EU/EEA filter** works in registry search, the advisor, the MCP tools, the OpenAI-compatible gateway (`onp/auto-eu`) and the Ollama router (`auto-eu`). Undeclared counts as outside. | **Live** |
| Know what you are using (AI Act transparency, deployer due diligence) | Signed, versioned Node Cards: model artifact, operator, hardware, data policy (retention, training on inputs). | **Live** |
| Evidence instead of claims | Automated verification: serves the claimed model (identity probes), context window holds (retrieval tests, capped if not), measured latency and throughput under load, continuous blind probes; results labeled claimed / measured / attested, never blended. | **Live** (identity checks across heterogeneous hardware: improving) |
| Auditability of use and cost | Every response carries a provider-signed receipt (usage × price pinned to a card revision); silent repricing is rejected (HTTP 409). | **Live** |
| No lock-in, easy switching (EU Data Act, cloud switching) | OpenAI-compatible invocation; registries are a protocol, self-hostable, with a signed export feed for mirroring; open licences. | **Live** |
| Independent third-party assurance | Attestations as verifiable credentials (audits, benchmark runs, residency). | Planned |
| Federation across institutions | Several registries exchanging signed feeds. | Draft (feed live) |

**What it is not:** OpenNodes does not certify compliance with the AI Act or GDPR. It makes the facts deployers need visible, signed and checkable; obligations stay with providers and deployers.

## Where it could fit European initiatives

- **AI Factories and Antennas:** a common discovery and verification layer for the inference services they expose, so users can find, compare and call them through one open interface; reference fingerprints for open-weight models could be computed on EuroHPC systems.
- **Sovereign and regional clouds:** a free, neutral channel to be found and verified — with measured performance and disclosed hardware — without a broker taking a cut or sitting in the traffic.
- **Data spaces (Gaia-X / Simpl):** ONP self-descriptions plus verification are close in spirit to Gaia-X self-descriptions; a mapping is future work.
- **European models:** the registry lists European models wherever providers serve them — Mistral (370+ offerings) and Poland's Bielik today — and the EU filter keeps traffic with EEA operators. The project's own Finnish reference node serves **Bielik 1.5B v3** (SpeakLeash, Apache-2.0), fully verified: identity matched, the whole 8,192-token context window passed the retrieval test, about 35 tokens/s under load on two CPU cores.

## Status today

- Hosted registry at registry.opennodes.io (Hetzner, Nuremberg, Germany): ~10,000 offerings from ~250 providers imported from public catalogs (shown as unverified until claimed), plus verified reference nodes in Germany (Llama 3.2 1B) and Finland (Bielik 1.5B v3, a Polish open model). The static website is served by Cloudflare.
- Published packages: MCP server and OpenAI-compatible gateway (`@opennodes/cli`), Ollama router, self-hostable registry, Python Node Kit for operators. Listed in the official MCP Registry.
- Independent open-source project; a European legal entity is planned for commercial agreements and programme participation.

## Next

ONP Draft 0.2 (attestations, federation, composite nodes), a W3C Community Group for the specification, and pilots with European operators and AI Factory service teams.

**Contact:** operators@opennodes.io · github.com/opennodes-io/opennodes

# AI Model Marketplaces, Inference Routing & Monetization — Landscape Report (as of August 2026)

Prepared as market context for the proposed "AI Nodes" open federated inference registry.

---

## 1. OpenRouter — the centralized analog, and the demand proof-point

**What it is.** A unified, OpenAI-compatible API gateway over 400+ models (figures cited range 375–500+ depending on date) from all major labs plus dozens of smaller inference hosts. One API key, one prepaid credit balance, one base URL; switch models by changing a string.

**How routing/ranking works.** Each model can be served by multiple underlying providers; OpenRouter routes with automatic failover, and exposes routing preferences via model-name suffixes: `:nitro` (throughput-first), `:floor` (cheapest provider), `:exacto` (quality/tool-calling reliability). It publishes per-provider latency (TTFT) and throughput stats, plus public usage leaderboards ("Rankings") that have become a de facto industry telemetry source (their "State of AI" report claims a 100T-token usage study).

**Fee model.** No markup on inference — provider list price is passed through. Revenue comes from: **5.5% fee on credit purchases** (Stripe; 5% via crypto, $0.80 min) and a **BYOK fee of 5%** above a monthly allowance ($25k pay-as-you-go / $200k enterprise). Free tier includes 25+ free models.

**Adoption (the key demand signal).** Sacra-tracked trajectory: ~$10M annualized inference spend Oct 2024 → $100M+ May 2025 → $19M annualized *revenue* end-2025 → ~$50M (Mar 2026) → ~$140M annualized revenue (Jul 2026); token volume ~1T/day (Feb 2026) → 3T+/day, and 5T→25T tokens/week over six months; ~8M developers; reported ~$1.3B valuation. Treat exact figures as estimates, but the growth direction is unambiguous.

- https://openrouter.ai/docs/faq
- https://sacra.com/c/openrouter/ and https://sacra.com/research/3t-token-coinbase-of-the-inference-economy/
- https://openrouter.ai/state-of-ai

**Caveat relevant to AI Nodes:** OpenRouter is a *curated, centralized* marketplace — providers are onboarded by OpenRouter, not self-registered. There is no permissionless "publish your endpoint" path, and no path for individuals with a GPU.

## 2. Hugging Face Inference Providers — federation under one API, but gated

HF's "Inference Providers" (launched Jan 2025, matured through 2026) routes a single OpenAI-compatible API across **~15+ partner providers** (Groq, Together, Fireworks, Cerebras, SambaNova, Replicate, DeepInfra, Nebius, Novita, Hyperbolic, Cohere…). Billing is unified through the HF account at **provider pass-through rates, zero HF markup** (HF monetizes via Pro/Team/Enterprise subscriptions; free tier gets ~$0.10/mo credits). Users can alternatively supply their own provider key.

**Becoming a provider is a formal partnership, not open registration:** implement HF's task API schemas, register model mappings via a Model Mapping API, implement a billing endpoint, submit client-library PRs (huggingface.js, huggingface_hub), hold a Team/Enterprise Hub account — and HF re-tests every mapped model every 6 hours. This is the closest existing thing to a "federated registry with conformance testing," and it demonstrates both the pattern and its curation cost.

- https://huggingface.co/docs/inference-providers/index
- https://huggingface.co/docs/inference-providers/en/register-as-a-provider
- https://github.com/huggingface/hub-docs/blob/main/docs/inference-providers/pricing.md

## 3. Aggregators/routers: what's standardized, what isn't

The de facto wire standard is simply **the OpenAI Chat Completions API** — every player emulates it. No one has standardized *discovery* or *registration*; each gateway maintains its own proprietary catalog.

| Player | Model | Notes |
|---|---|---|
| **LiteLLM** | Open-source proxy (self-hosted), 100+ providers | Most-adopted OSS gateway; a *translation* layer, not an intelligent router — no marketplace, no billing between strangers |
| **Portkey** | Enterprise gateway, 1,600+ LLM endpoints | Claims ~50B tokens/day; sells observability, guardrails, compliance (SOC2/ISO) |
| **Martian** | Per-request intelligent routing | Still independent; Accenture-invested; reportedly approaching ~$1.3B valuation (Apr 2026) — routing *intelligence* as the product |
| **NotDiamond** | Routing-as-API | Powers OpenRouter's "Auto Router"; active |
| **Requesty** | Managed gateway, 400+ models | Competes on SLA (99.99%), EU hosting, low overhead (~8ms P50) |

Takeaway: the "one API over many models" layer is **commoditized and crowded**; the *value has moved up* (routing intelligence, observability, compliance) or *down* (owning the payment/settlement relationship, as OpenRouter does).

- https://www.requesty.ai/blog/litellm-vs-portkey-vs-openrouter-best-llm-gateway-2026
- https://agentmarketcap.ai/blog/2026/04/06/llm-gateway-market-2026-litellm-portkey-martian-intelligence-router

## 4. Decentralized / permissionless compute — where "anyone can register a node" already exists, and why it underperforms

**Bittensor (TAO).** Permissionless inference/AI-commodity subnets: miners serve work, validators score it (latency/quality), Yuma Consensus distributes emissions; each subnet has an Alpha token paired with TAO. In practice: **non-refundable, demand-priced registration fees; the lowest-performing miners get deregistered each tempo and lose their fee**; high technical bar; median miner earnings on one cited subnet ~$448/month. It rewards *token emissions competition*, not organic customer demand — most subnets have little external paying usage. (https://docs.learnbittensor.org/resources/questions-and-answers, https://subnetaiq.io/blog/is-bittensor-mining-profitable-2026)

**Akash Network.** Reverse-auction cloud marketplace, ~80–90% below AWS for CPU; leads DePIN in fees but only **~$4.3M ARR**, and active providers *fell* from ~69 (Q1 2025) to ~58 (Q1 2026) even as global GPU demand soared — evidence that permissionless supply doesn't automatically attract enterprise demand. (https://akash.network/blog/akash-network-q1-2026-report/, https://messari.io/report/state-of-akash-q3-2025)

**io.net.** Fully permissionless GPU onboarding (NVIDIA ≥4GB VRAM, 200 IO stake per chip, 12h stress test, 5h/day uptime minimum); workers earn block rewards + job payments; A100s listed at $1.50–3.50/GPU-hr. Sector-wide, DePIN compute ARR is only ~$180–220M combined (Q1 2026) — and the whole sector is pivoting from token-subsidized supply to demand-driven cash flow because subsidies didn't create durable demand. (https://developers.io.net/docs/supported-devices, https://blockeden.xyz/blog/2026/03/12/depin-compute-revenue-pivot-akash-ionet-aethir/)

**Gensyn / Prime Intellect.** Focused on decentralized *training*, not an inference marketplace. Prime Intellect proved 10B/32B-param distributed training works (INTELLECT-1, 30 nodes, 3 continents, ~98% efficiency); Gensyn TGE'd in early 2026 and is chasing verifiable-ML as the trust layer. Verification of work done by untrusted nodes remains the hard unsolved problem. (https://cryptobriefing.com/prime-intellect-decentralized-ai-training/)

**Petals / Exo (home inference).** Petals (BitTorrent-style public LLM swarm) is effectively stagnant — public P2P inference hits abuse, reliability, and privacy walls. Exo (~38k GitHub stars) is thriving but as a *LAN clustering* tool for hardware you own (Macs/iPhones), explicitly not a public network. (https://sharedllm.org/blog/sharedllm-vs-petals-vs-exo.html)

**Vast.ai / SaladCloud.** The most *functional* "individual with a GPU earns money" story today — but they rent **raw containers/GPU-hours, not per-token inference**. An RTX 4090 at 35–50% utilization nets ~$400–900/month after electricity. Discovery is a simple specs-and-price listing; trust is handled by verified-datacenter tiers (Vast) or by only running interruptible, stateless batch workloads (Salad). (https://vast.ai/hosting/calculator)

**Pattern across all of these:** permissionless supply-side registration is a solved problem; **permissionless *demand* is not**. Quality ranking of untrusted heterogeneous nodes is solved either by crypto-economic scoring (Bittensor — noisy, gameable, costly) or by centralized benchmarking/curation (HF, OpenRouter). Nobody has cracked trustworthy per-token metering between strangers without a central settlement layer.

## 5. OS-level pluggable model providers — the abstraction is genuinely emerging

- **Apple (WWDC June 2026):** Foundation Models framework added a public **`LanguageModel` protocol** — one Swift API spanning the on-device model, Private Cloud Compute, and third-party clouds; Anthropic (Claude Swift package) and Google (Gemini via Firebase) ship conforming providers, so apps swap providers by changing a dependency, not call sites. Apple said the framework will be open-sourced. This is exactly a "pluggable model provider" abstraction — but provider-implemented SDK packages, **no discovery/registry and no payment layer**. (https://developer.apple.com/videos/play/wwdc2026/241/)
- **Microsoft:** Windows AI Foundry unifies **Windows ML** (ONNX Runtime + vendor "execution providers" for AMD/Intel/NVIDIA/Qualcomm silicon) with **Foundry Local** plus pluggable catalogs (Ollama, NVIDIA NIM). Pluggability exists at the *hardware/EP* and *catalog* level; local models are free, so no billing abstraction. (https://learn.microsoft.com/en-us/windows/ai/overview)
- **Google:** Android **AICore** is a system service that owns Gemini Nano's lifecycle and exposes it to all third-party apps via ML Kit GenAI APIs — a shared on-device model as an OS utility. Single-vendor: no third-party model plug-in point. (https://developer.android.com/ai/gemini-nano)

Net: all three OSes are converging on "OS-managed model runtime + stable app-facing API," and Apple has taken the first real step toward *multi-vendor* pluggability. None has network-endpoint discovery, marketplace, or metering — that layer is unclaimed.

## 6. Machine-payment rails for per-token billing between strangers

- **x402** (Coinbase + Cloudflare; Linux Foundation-hosted foundation as of Apr 2026, ~40 members incl. Stripe, AWS, Google, Visa, Circle): HTTP 402 + stablecoin (USDC) payment negotiation, purpose-built for agents paying per-request. **Adoption reality check:** ~167–169M settled transactions, ~590k buyers / 100k sellers in year one — but ~half classified as gamified and real-commerce volume only ~$28K/day early 2026. Cloudflare and AWS are embedding it at the edge; Coinbase launched Agent.market as a directory of x402-paywalled services. The rail exists and is standardizing faster than usage is materializing. (https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation, https://www.infoq.com/news/2026/07/cloudflare-aws-x402-micropayment/)
- **Stripe ACP** (with OpenAI and Meta): open standard for agent checkout with Shared Payment Tokens (scoped, time/amount-bounded); powers ChatGPT Instant Checkout (Etsy, Shopify merchants). Oriented at *goods commerce*, not micro-metered API billing, but proves fiat rails are being rebuilt for agents. (https://docs.stripe.com/agentic-commerce/acp)
- **L402/Lightning** (Lightning Labs): sats-denominated per-request payments (1–10 sats per inference call) with macaroon auth; agent tooling shipped Feb 2026. Technically the best fit for true per-token micro-settlement; adoption remains niche relative to x402's institutional momentum. (https://lightning.engineering/posts/2026-03-11-L402-for-agents/)

For AI Nodes, this is the strongest tailwind: **the "strangers billing strangers per-request over HTTP" primitive did not exist in 2024 and now has two funded standards bodies behind it.**

## 7. Demand evidence & standards efforts for discovery

- **Fragmentation pain is documented and monetized:** same model costing up to 10x more across providers, radically varying latency/uptime, no structured pricing-change tracking — "choosing a provider still means opening multiple tabs and building spreadsheets." (https://github.com/openmodelsrun/openmodels)
- **Discovery-metadata registries are appearing bottom-up:** **models.dev** (Anomaly/opencode team — community-maintained TOML database of model specs, pricing, capabilities, provider↔model mappings, with JSON API and SDK; front-page Hacker News traction) and **OpenModels** (similar open registry incl. rate limits). These are *static metadata databases*, not live endpoint discovery — no health, no dynamic pricing, no registration protocol, no payments. (https://models.dev/, https://news.ycombinator.com/item?id=48241172)
- **No standards body effort exists for live inference-endpoint discovery/federation.** MCP standardized tool access; ACP/x402 standardized payments; the OpenAI API schema standardized invocation. The discovery + registration + settlement bundle for inference endpoints has no LF/IETF/W3C-style effort — the closest analogs are proprietary (OpenRouter's catalog, HF's provider-registration process).
- **Growth of the category:** OpenRouter's ~7x revenue growth in ~7 months and Portkey's 50B tokens/day show that *routing over many providers* is now default architecture for agentic workloads, not a niche.

---

## Interest & Viability Assessment for "AI Nodes"

**Demonstrated demand (validated by the market):**
1. **One API over many models/providers, billed per token** — massively validated (OpenRouter ~$140M annualized revenue, 8M devs; Portkey 50B tokens/day). The 5%-ish take-rate on settlement is a proven fee model.
2. **Provider-level metadata for discovery** (price, context, capabilities, latency/throughput stats) — validated both commercially (OpenRouter rankings) and as open data (models.dev hitting HN front page).
3. **Agent-native payment rails** — heavily invested in by Coinbase, Cloudflare, Stripe, AWS, Visa; an AI Nodes settlement layer could ride x402/ACP rather than invent one.
4. **OS-level pluggable providers** — Apple's `LanguageModel` protocol proves platform owners now *want* swappable backends; a discovery/registry standard would slot into a hole all three OS vendors have left open.

**Already commoditized (weak white space):**
- The gateway/proxy layer itself (LiteLLM free and open-source; a dozen funded competitors).
- Routing intelligence (Martian, NotDiamond — deep-tech moat you'd be competing against).
- Raw GPU-hour rental by individuals (Vast.ai/Salad do it well without per-token complexity).
- Static model-metadata databases (models.dev is free, open, community-run).

**Cautionary evidence against the most novel part:**
- The "any individual with a GPU serves paid inference to strangers" tail has been tried repeatedly (Petals, Bittensor inference subnets, DePIN clouds) and consistently fails on the same three points: **verification/quality-ranking of untrusted nodes, reliability/SLA expectations of paying clients, and demand generation** (Akash's provider count is *shrinking*; DePIN compute's combined ARR ≈ one month of OpenRouter's settled volume). Buyers overwhelmingly choose curated, centrally-benchmarked supply.

**Plausible white space:**
1. **The open *standard* itself, not the marketplace.** No neutral spec exists for "inference endpoint self-description + registration + health/benchmark attestation + price advertisement." OpenRouter and HF each have proprietary versions; models.dev proves appetite for the open-data half. An "MCP-for-inference-discovery" positioning — federated registries speaking a common protocol, with OpenRouter-style hubs as super-nodes — is genuinely unoccupied, and timing is good (Apple's protocol, x402 foundation, MCP precedent showing a small open spec can win in months).
2. **Discovery + settlement glue for OS-integrated clients:** the OS vendors built the plug socket but no directory or billing; an AI Nodes client library that resolves "cheapest conforming provider for model class X, pay via x402" fills a real gap.
3. **Federation of the *mid-tail*** (regional clouds, GPU startups, universities, on-prem enterprise nodes) rather than individuals — supply that is credible enough to sell but too small for OpenRouter/HF's manual onboarding.

**Realistic risks:** OpenRouter can extend downward into open registration at any time and has the demand side locked; a registry's fee take is only defensible if it owns settlement (which is why OpenRouter charges on credits, not inference); ad-supported inference has no existing precedent in this market; and the individual-GPU tail should be treated as a long-term aspiration, not the wedge — every prior attempt at it stalled on trust and demand, not on technology.

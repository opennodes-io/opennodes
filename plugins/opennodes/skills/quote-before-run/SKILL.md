---
name: quote-before-run
description: Price AI work across inference providers before it runs, and let the developer pick. Use it when the user is about to run bulk or repeatable model calls (translating, summarising, classifying or extracting from many documents; embedding a repo or a document collection; generating synthetic data; running evals or batch jobs), when they write or run code that calls an LLM API in a loop, when they ask which model or provider is cheapest, fastest or keeps data in a region, or when they ask what an AI task will cost. Not for single questions you can answer yourself.
---

# Quote before run

The developer decides where their work runs. Your job is to put the real options next to each other, priced, with what each one means for their data, and then do nothing until they choose.

All OpenNodes tools are read-only: quoting never sends their data anywhere and never spends money. `recommend` analyses the task text on this machine and sends only features (task kind, size, language) to the registry.

## 1. Size the job

Work out, or ask once if you can't:

- **How many items** and **how big**: count files or rows; estimate tokens as characters ÷ 4.
- **Output per item**: a summary is ~5–15% of the input, a translation ~100–120%, a label ~5 tokens, an embedding has no output.
- **Constraints the user stated or the code implies**: a region ("EU only", "must stay in Canada"), personal or client data, secrets, a deadline, a budget.

Decide the **data class** and say it in one line:

- **Sensitive**: personal data, client or patient documents, contracts, credentials, unreleased code they flagged as confidential.
- **Ordinary**: public text, their own non-confidential code, synthetic data.

If you can't tell, ask. Don't guess "ordinary" for documents you haven't seen.

## 2. Collect the options

Use the OpenNodes MCP tools:

1. `recommend` with the task description, `est_output_tokens`, and a `policy` that carries what the user stated (`region`, `max_total_usd`, `prefer_local`). Ask for `limit: 5`.
2. `estimate` to price the whole job for each candidate: one step per candidate with the total input and output tokens. Prefer exact `offering` ids from step 1.
3. Fill the gaps so the table always has these rows when they exist:
   - **What they use now.** The model their code calls, or the model you are running on. Find it with `search_offerings` (`q` = model name) and price it the same way. Always include it, even if it is the most expensive.
   - **Their own machine**: a local model that fits (`search_offerings` with `local: true` and `memory_gb`), for free, with an honest speed note.
   - **A checked hosted option**: best result with `tier: "community"` or higher.
   - **The cheapest option that can do the job**, whatever its protection level or where it runs, including providers based in China. Search without `region` for this row. Leave it out only when the user made the region a hard requirement ("must", "only", a legal reason); being "an EU company" or preferring a region isn't one. Show it with its data label so the trade-off is visible.
   - **In-region option** when a region matters: `region` set, plus `find_residency` for what the provider promises.
4. For any option you put forward, vet it with `get_node`: operator, where it serves from, trust tier and history.

## 3. Show the options

One table, cheapest last or first but never hidden, and the current option clearly marked:

| Option | Runs where | Checked? | Data | Est. cost (whole job) | Speed | You need |
|---|---|---|---|---|---|---|

- **Runs where**: the serving places the registry knows (`serves.places`, `find_locations`), or "not published".
- **Checked?**: `verified` / `community` = the registry measured it; `unverified` = listed from a catalogue, claims not checked; local = your machine.
- **Data**: one of these labels, then the provider's stated retention and training policy if known (as their claim), or "policy not stated".
  - **Stays on your machine**
  - **Stays in <region>**: only with a residency commitment from `find_residency`, naming its level (processing / storage) and who gets it (default / opt-in / enterprise)
  - **Hosted, location known**: name the countries
  - **Hosted, location not published**: the common case for catalogue listings and routers. Neutral: it means we don't know, not that it's unsafe.
  - **Lower protection**: only with positive evidence, and say which: it serves from outside the user's legal area with no residency commitment for their region (for an EU user, outside the EU/EEA without an adequacy decision), or the provider states it may keep or train on prompts. Many of the cheapest providers based in China fall here: the registry knows serving places such as CN for some of them (DeepSeek's own API, Volcengine, Alibaba China).
- **Est. cost**: the `estimate` total as a range if it has bounds. Listed prices, not invoices.
- **You need**: an account and key with that provider, the local Ollama model pulled, nothing.

Then, in at most four short lines:

- Which option you'd pick for this job and why, in one sentence. If what they use now is the best fit, say so plainly.
- For **sensitive** data: say that the lower-protection rows are not suitable for it, and why. Still show them, so the choice is visible.
- For **ordinary** data: lower-protection options are a legitimate trade of protection for price. Don't lecture.
- Anything you assumed (item count, output length).

Ask which option they want. **Stop there.** Don't change code, start servers, or send any data until they answer.

## 4. After they choose

- **What they use now**: carry on as before.
- **Any other option**: offer to hand the work to the `offload-runner` agent, which runs a small pilot through the local OpenNodes gateway, reports sample results and real cost, and only then runs the rest. Give it: the chosen `node_id/offering_id`, the files or data, what to do with each item, where to write results, the user's spend limit, and the data class.
- **Code changes instead**: if they'd rather change their own code, the gateway speaks the OpenAI API. Start it with `npx -y @opennodes/cli@0.1.36 gateway --port 4141`, point the code at `http://127.0.0.1:4141/v1`, and use the chosen `node_id/offering_id` as the model (or `onp/auto-eu`, `onp/auto-cheap`, `onp/auto-private` to let it route). If the chosen option needs their own provider key, add `--env-keys`: from cli 0.1.34, without it the gateway uses no keys from the environment.

## Rules

- **Keys**: never ask the user to paste a key into the chat. Keys go in environment variables (`OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY`, …), which the gateway reads only with `--env-keys` from cli 0.1.34 (always before), or `--key host=KEY` when they start the gateway themselves.
- **Neutral**: rank by fit for their job. Don't steer towards or away from any provider, including the one you run on.
- **Honest numbers**: imported listings are unverified; prices can be stale; say so when an option's price or speed comes only from a catalogue.
- **Small jobs**: if the whole job costs under about $0.50 on what they use now, say the saving isn't worth the switch, show the one-line comparison, and move on.

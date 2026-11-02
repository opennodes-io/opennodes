# Reference node

A small, always-on OpenNodes node on its own server: Ollama serving one model, the Python Node Kit in front of it, Caddy for TLS. The project runs these so the verified tier always has key-less nodes to try; anyone can use the same files to run their own.

## Deploy

1. A fresh Ubuntu 24.04 server (2 vCPU / 4 GB runs a 1B model; 4 vCPU / 8 GB a 4B one, on CPU) and a DNS `A` record for your node host pointing at it, not proxied.
2. Copy this directory to the server (e.g. `/opt/onp-node`), then:
   ```bash
   cp .env.example .env    # set NODE_ID, NODE_HOST, MODEL, names, country
   ./setup.sh
   ```
   The node id must match the host by reversing it: `io.opennodes.helsinki` is served from `helsinki.opennodes.io`.
3. Register it with a registry. The kit serves the challenge itself, so run this on the server:
   ```bash
   docker compose exec node onp-node register https://registry.opennodes.io
   ```
   Stage A runs at registration (community tier). The registry admin then runs Stage B: identity fingerprint capture and the admission battery (verified tier).

## Several models

`MODEL` takes a space-separated list; the kit offers every model Ollama lists, and Ollama keeps one in memory at a time. A model whose Ollama name contains a slash (e.g. `SpeakLeash/bielik-1.5b-v3.0-instruct:Q8_0`) would be read as a Hugging Face id, so add it by hand under a plain local name instead of through `MODEL` (which would pull the slashed name again on every start). Check its chat template too: the SpeakLeash upload of Bielik 1.5B v3 ships a Llama-3 template, while its tokenizer uses ChatML — [models/bielik-1.5b-v3.Modelfile](models/bielik-1.5b-v3.Modelfile) fixes it and documents the commands. Then restart the node and re-register; Stage B for a new or changed model needs a fresh reference capture first.

## Operate

- Logs: `docker compose logs -f node`
- Change the model: set `MODEL` in `.env`, remove `node/data/onp-node.toml` so the card is regenerated, `docker compose up -d --build`, then register again.
- The signing key and card revision live in `node/data/`; keep that directory across rebuilds.

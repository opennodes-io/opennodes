"""Config load + card generation. The TOML file is the operator's source of truth;
the card is derived from it plus live engine interrogation (NK-CARD-01)."""
import datetime
import re
import tomllib
from pathlib import Path


DEFAULT_CONFIG = """\
# OpenNodes Node Kit configuration (onp-node.toml)
[node]
id = "{node_id}"
name = "{name}"
public_url = "{public_url}"     # origin third parties reach this kit at
operator_name = "{operator}"
country = "DE"

[engine]
# vLLM / TGI / Ollama all expose an OpenAI-compatible /v1
base_url = "{engine_base}"
# Optional: offer only a subset of the engine's models, e.g.:
# models = ["gemma4:latest"]
# Optional: seconds to wait for the engine per request (default 300; CPU-only engines need
# minutes to read long prompts)
# timeout_s = 300

[serving]
context_window = 8192
max_output_tokens = 4096

[pricing]
currency = "USD"
input_per_mtok = 0.0
output_per_mtok = 0.0
schemes = ["free"]

[data_policy]
retention = "none"
training_on_inputs = false

[receipts]
# Every signed receipt is appended here (no prompt text: ids, token counts, amount, request
# hash) and the newest `keep` stay retrievable by id. Set file = "" to keep them in memory only.
file = "onp-receipts.jsonl"
keep = 50000

# Per-model details let clients route well (a 235B model on H100s vs a 3B one on a laptop).
# Ollama engines report size, quantization and tool/vision support themselves, vLLM the context
# length it serves; add or correct anything here, keyed by the engine's model id. Claimed values:
# the registry's measurements are shown next to them.
# `artifact` names the public record of the weights, which registries check the model's identity
# against: the kit writes ollama:<name> for Ollama models and hf:<org>/<repo> for Hugging Face ids.
# Set it for a model you created under a local name, e.g. artifact = "hf:speakleash/Bielik-1.5B-v3.0-Instruct".
# [model."Qwen/Qwen3-235B-A22B-FP8"]
# params_b = 235
# context_window = 32768
# supports = ["tool_calls", "json_mode"]          # also "vision"
# quantization = "fp8"
# languages = ["en", "de", {{ lang = "pl", grade = "native" }}]   # plain codes mean "strong"
# expected_tps = 60                                 # tokens/s you expect per request
# expected_ttft_ms = 400

# Disclose the silicon behind this node — same model, different hardware, different
# product. Claimed until attested; the registry's measured TTFT/TPS always wins.
# [hardware]
# accelerators = [{{ type = "H100", count = 2, memory_gb = 80 }}]

[payment]
probe_allowance_per_day = 200
"""


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", str(s).lower()).strip("-")
    return re.sub(r"^[^a-z0-9]+", "", s)[:100] or "model"


def load_config(path: Path) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def stable_revision(card: dict, state_path: Path) -> dict:
    """Keep the card revision unchanged across restarts when the content is unchanged.

    A revision is what clients and registries pin (prices, offerings); minting a new one on
    every start makes every pinned estimate and probe stale for no reason. The state file
    remembers the hash of the card content and the revision that was issued for it.
    """
    import hashlib
    import json
    body = {k: v for k, v in card.items() if k not in ("revision", "signatures")}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("hash") == digest and state.get("revision"):
            card["revision"] = state["revision"]
            return card
    except (OSError, ValueError):
        pass
    state_path.write_text(json.dumps({"hash": digest, "revision": card["revision"]}), encoding="utf-8")
    return card


SUPPORTS = ("tool_calls", "json_mode", "vision", "edit")


def _model_info(cfg: dict, details: dict | None, model_id: str) -> dict:
    """Engine-reported details, overridden by the operator's [model."<id>"] table."""
    return {**((details or {}).get(model_id) or {}), **((cfg.get("model") or {}).get(model_id) or {})}


def _claimed(value):
    if isinstance(value, dict):
        return {"basis": "claimed", **value}
    return {"p50": float(value), "basis": "claimed"}


# model.artifact as the card schema allows it (ONP-2 §5).
ARTIFACT = re.compile(r"^(hf:[^/\s]+/[^/\s]+|ollama:[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?(:[A-Za-z0-9._-]+)?"
                      r"|urn:proprietary:[a-z0-9-]+:[A-Za-z0-9._-]+)$")


def artifact_for(node_id: str, model_id: str, info: dict) -> str:
    """The public record of a model's weights, which registries test its identity against.

    - `artifact` in the operator's [model."<id>"] table wins;
    - an Ollama model is `ollama:<name>[:<tag>]` (the library record; the tag names the quantization),
      and one Ollama pulled from Hugging Face (`hf.co/<org>/<repo>:<quant>`) is `hf:<org>/<repo>`;
    - a Hugging Face id (`<org>/<repo>`, as vLLM and TGI serve them) is `hf:<org>/<repo>`;
    - anything else has no public record the kit can name: `urn:proprietary:<own namespace>:<model>`,
      which registries accept only from the operator's own namespace and can never verify.
    """
    if info.get("artifact"):
        if not ARTIFACT.match(str(info["artifact"])):
            raise SystemExit(f'[model."{model_id}"] artifact = "{info["artifact"]}" is not hf:<org>/<repo>, '
                             f'ollama:<name>[:<tag>] or urn:proprietary:<vendor>:<model>')
        return str(info["artifact"])
    if info.get("engine") == "ollama":
        if model_id.startswith("hf.co/") and model_id.count("/") >= 2:
            org, repo = model_id.split("/")[1], model_id.split("/")[2].split(":")[0]
            candidate = f"hf:{org}/{repo}"
        else:
            candidate = f"ollama:{model_id}"
        if ARTIFACT.match(candidate):
            return candidate
    elif "/" in model_id and ARTIFACT.match(f"hf:{model_id}"):
        return f"hf:{model_id}"
    return f"urn:proprietary:{slug(node_id.split('.')[1])}:{slug(model_id)}"


def unverifiable(card: dict) -> list[str]:
    """Offerings whose artefact is the kit's own proprietary fallback: registries cannot check their
    identity, so they can reach community but never verified."""
    own = f"urn:proprietary:{slug(card['node']['id'].split('.')[1])}:"
    return [o["binding"]["model_id"] for o in card.get("offerings", []) if o["model"]["artifact"].startswith(own)]


def build_card(cfg: dict, model_ids: list[str], details: dict | None = None) -> dict:
    node, serving, pricing = cfg["node"], cfg.get("serving", {}), cfg.get("pricing", {})
    data_policy = cfg.get("data_policy", {})
    public = node["public_url"].rstrip("/")
    offerings = []
    for model_id in model_ids:
        info = _model_info(cfg, details, model_id)
        model = {
            "name": model_id,
            "artifact": artifact_for(node["id"], model_id, info),
            **{k: info[k] for k in ("family", "quantization") if info.get(k)},
            **({"params_b": float(info["params_b"])} if info.get("params_b") else {}),
        }
        model_serving = {
            "context_window": int(info.get("context_window", serving.get("context_window", 8192))),
            "max_output_tokens": int(info.get("max_output_tokens", serving.get("max_output_tokens", 4096))),
            "supports": ["streaming", *dict.fromkeys(s for s in info.get("supports", []) if s in SUPPORTS)],
        }
        if info.get("languages"):
            model_serving["languages"] = [{"lang": l, "grade": "strong"} if isinstance(l, str) else dict(l)
                                          for l in info["languages"]]
        for field in ("expected_tps", "expected_ttft_ms"):
            if info.get(field):
                model_serving[field] = _claimed(info[field])
        offerings.append({
            "offering_id": slug(model_id),
            "modality": "text",
            "model": model,
            "serving": model_serving,
            "binding": {"profile": "onp.openai.chat/v1", "model_id": model_id},
            "pricing": {
                "currency": pricing.get("currency", "USD"),
                "input_per_mtok": float(pricing.get("input_per_mtok", 0)),
                "output_per_mtok": float(pricing.get("output_per_mtok", 0)),
                "schemes": list(pricing.get("schemes", ["free"])),
            },
            "data_policy": {
                "retention": data_policy.get("retention", "none"),
                "training_on_inputs": bool(data_policy.get("training_on_inputs", False)),
            },
        })
    return {
        "onp": "0.1",
        "revision": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "node": {
            "id": node["id"],
            "name": node["name"],
            "description": node.get("description", "Served via the OpenNodes Node Kit."),
            "operator": {"name": node.get("operator_name", node["name"]),
                         **({"country": node["country"]} if node.get("country") else {})},
        },
        "endpoints": {"openai": f"{public}/v1", "health": f"{public}/onp/health"},
        "offerings": offerings,
        **({"hardware": {"accelerators": cfg["hardware"]["accelerators"],
                         "basis": cfg["hardware"].get("basis", "claimed")}}
           if cfg.get("hardware", {}).get("accelerators") else {}),
        "payment": {
            "schemes": [{"scheme": s} for s in pricing.get("schemes", ["free"])],
            "probe_allowance": {"requests_per_day": int(cfg.get("payment", {}).get("probe_allowance_per_day", 200))},
        },
    }

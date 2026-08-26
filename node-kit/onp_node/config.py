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

[payment]
probe_allowance_per_day = 200
"""


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", str(s).lower()).strip("-")
    return re.sub(r"^[^a-z0-9]+", "", s)[:100] or "model"


def load_config(path: Path) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def build_card(cfg: dict, model_ids: list[str]) -> dict:
    node, serving, pricing = cfg["node"], cfg.get("serving", {}), cfg.get("pricing", {})
    data_policy = cfg.get("data_policy", {})
    public = node["public_url"].rstrip("/")
    offerings = []
    for model_id in model_ids:
        offerings.append({
            "offering_id": slug(model_id),
            "modality": "text",
            "model": {
                "name": model_id,
                "artifact": f"hf:{model_id}" if "/" in model_id
                            else f"urn:proprietary:{slug(node['id'].split('.')[1])}:{slug(model_id)}",
            },
            "serving": {
                "context_window": int(serving.get("context_window", 8192)),
                "max_output_tokens": int(serving.get("max_output_tokens", 4096)),
                "supports": ["streaming"],
            },
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
        "payment": {
            "schemes": [{"scheme": s} for s in pricing.get("schemes", ["free"])],
            "probe_allowance": {"requests_per_day": int(cfg.get("payment", {}).get("probe_allowance_per_day", 200))},
        },
    }

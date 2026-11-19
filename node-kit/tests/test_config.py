"""The config template must survive str.format (regression: a `{ ... }` TOML example broke `onp-node init`)."""
import tomllib

from onp_node.config import DEFAULT_CONFIG, build_card

FILL = dict(node_id="org.example.box", name="Box", public_url="https://box.example.org",
            operator="Example", engine_base="http://127.0.0.1:11434/v1")


def test_default_config_formats_and_parses():
    cfg = tomllib.loads(DEFAULT_CONFIG.format(**FILL))
    assert cfg["node"]["id"] == "org.example.box"
    assert "hardware" not in cfg  # the example stays commented out


def test_hardware_section_lands_in_card():
    text = DEFAULT_CONFIG.format(**FILL)
    text += "\n[hardware]\naccelerators = [{ type = \"H100\", count = 2, memory_gb = 80 }]\n"
    card = build_card(tomllib.loads(text), ["m"])
    assert card["hardware"]["accelerators"][0]["type"] == "H100"
    assert card["hardware"]["basis"] == "claimed"


# ---- model.artifact: the public record registries check identity against (ONP-2 §5, ONP-3 §6.3)
from onp_node.config import artifact_for, unverifiable

CFG = tomllib.loads(DEFAULT_CONFIG.format(**FILL))


def _artifact(model_id, details=None, extra=""):
    cfg = tomllib.loads(DEFAULT_CONFIG.format(**FILL) + extra) if extra else CFG
    return build_card(cfg, [model_id], {model_id: details or {}})["offerings"][0]["model"]["artifact"]


def test_ollama_models_get_their_library_record_not_a_proprietary_name():
    ollama = {"engine": "ollama"}
    assert _artifact("llama3.2:1b", ollama) == "ollama:llama3.2:1b"
    assert _artifact("gemma3", ollama) == "ollama:gemma3"
    assert _artifact("SpeakLeash/bielik-1.5b-v3.0-instruct:Q8_0", ollama) == "ollama:SpeakLeash/bielik-1.5b-v3.0-instruct:Q8_0"
    # pulled from Hugging Face through Ollama: the repository is the record
    assert _artifact("hf.co/speakleash/Bielik-1.5B-v3.0-Instruct-GGUF:Q8_0", ollama) == "hf:speakleash/Bielik-1.5B-v3.0-Instruct-GGUF"


def test_hugging_face_ids_and_the_proprietary_fallback():
    assert _artifact("Qwen/Qwen3-8B") == "hf:Qwen/Qwen3-8B"
    # a bare id on another engine has no public record the kit can name: own namespace only
    assert _artifact("my-finetune") == "urn:proprietary:example:my-finetune"
    card = build_card(CFG, ["my-finetune", "Qwen/Qwen3-8B"], {})
    assert unverifiable(card) == ["my-finetune"]


def test_operator_names_the_artifact():
    extra = '\n[model."bielik-1.5b-v3.0-instruct"]\nartifact = "hf:speakleash/Bielik-1.5B-v3.0-Instruct"\n'
    assert _artifact("bielik-1.5b-v3.0-instruct", {"engine": "ollama"}, extra) == "hf:speakleash/Bielik-1.5B-v3.0-Instruct"
    bad = '\n[model."m"]\nartifact = "llama"\n'
    try:
        _artifact("m", {}, bad)
        assert False, "an artifact outside the schema must be refused"
    except SystemExit as err:
        assert "not hf:" in str(err)


def test_every_artifact_the_kit_writes_matches_the_card_schema():
    import json
    import re
    from pathlib import Path
    schema = json.loads((Path(__file__).resolve().parents[2] / "schemas" / "open-node.schema.json").read_text(encoding="utf-8"))
    pattern = re.compile(schema["$defs"]["offering"]["properties"]["model"]["properties"]["artifact"]["pattern"]
                         if "$defs" in schema and "offering" in schema["$defs"] else _find_artifact_pattern(schema))
    for model_id, details in [("llama3.2:1b", {"engine": "ollama"}), ("Qwen/Qwen3-8B", {}), ("x", {}),
                              ("hf.co/a/b:Q4_K_M", {"engine": "ollama"})]:
        assert pattern.match(artifact_for("org.example.box", model_id, details)), model_id


def _find_artifact_pattern(node):
    if isinstance(node, dict):
        if "artifact" in node.get("properties", {}):
            return node["properties"]["artifact"]["pattern"]
        for v in node.values():
            found = _find_artifact_pattern(v)
            if found:
                return found
    if isinstance(node, list):
        for v in node:
            found = _find_artifact_pattern(v)
            if found:
                return found
    return None

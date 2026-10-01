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

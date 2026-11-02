"""The engine timeout must be long enough for CPU-only nodes and configurable per node."""
import tomllib

from onp_node.config import DEFAULT_CONFIG, build_card
from onp_node.jws import generate_private_key
from onp_node.server import NodeKitServer


def _card():
    cfg = tomllib.loads(DEFAULT_CONFIG.format(engine_base="http://127.0.0.1:11434/v1", node_id="org.example.ai",
                                               public_url="https://ai.example.org", name="Example", operator="Example"))
    return build_card(cfg, ["llama3.2:1b"])


def test_default_engine_timeout_suits_cpu_nodes():
    server = NodeKitServer(_card(), generate_private_key(), "http://127.0.0.1:11434/v1")
    assert server.engine_timeout_s == 300


def test_engine_timeout_is_configurable():
    server = NodeKitServer(_card(), generate_private_key(), "http://127.0.0.1:11434/v1", engine_timeout_s=42)
    assert server.engine_timeout_s == 42

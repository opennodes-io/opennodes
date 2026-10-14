"""Card-only listing: a signed static card pointing at the operator's own API."""
import tomllib

from onp_node.cli import make_static_card
from onp_node.config import DEFAULT_CONFIG
from onp_node.jws import generate_private_key


def test_static_card_points_at_the_operator_api(tmp_path):
    cfg = tomllib.loads(DEFAULT_CONFIG.format(node_id="com.example.ai", name="Example AI", public_url="https://ai.example.com",
                                              operator="Example", engine_base="https://api.example.com/v1")
                        .replace('schemes = ["free"]', 'schemes = ["prepaid"]'))
    card, jwks = make_static_card(cfg, ["example-large"], "https://api.example.com/v1/", None,
                                  "https://console.example.com/keys", generate_private_key(), tmp_path / "rev.json")
    assert card["endpoints"] == {"openai": "https://api.example.com/v1", "health": "https://api.example.com/v1/models"}
    assert {"scheme": "prepaid", "signup": "https://console.example.com/keys"} in card["payment"]["schemes"]
    assert card["signatures"] and jwks["keys"][0]["kty"] == "OKP"
    assert card["offerings"][0]["binding"]["model_id"] == "example-large"

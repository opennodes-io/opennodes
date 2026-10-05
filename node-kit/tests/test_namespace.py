"""Node id <-> public host binding, as registries enforce it."""
from onp_node.cli import namespace_ok


def test_namespace_binding():
    assert namespace_ok("org.example.ai", "https://ai.example.org")
    assert namespace_ok("org.example.ai.box", "https://ai.example.org")          # below the host
    assert namespace_ok("io.opennodes.demo-node", "https://demo-node.opennodes.io")
    assert not namespace_ok("org.example.mybox", "https://ai.example.org")       # sibling name
    assert not namespace_ok("io.github", "https://alice.github.io")              # child cannot claim parent
    assert namespace_ok("org.example.mybox", "http://192.168.1.20:8800")         # LAN / dev

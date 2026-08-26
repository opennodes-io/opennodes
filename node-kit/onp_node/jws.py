"""Compact JWS (EdDSA/Ed25519) byte-compatible with the JS reference implementation.

The registry verifies card signatures by re-serializing the received card with its own
stable stringify (sorted keys, compact separators, raw unicode) and checking the JWS
over those exact bytes — so `stable_stringify` here MUST byte-match the JS version
for any value that appears in a card.
"""
import base64
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def from_b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _normalize(v):
    # JS JSON.stringify(0.0) === "0": integral floats must serialize as ints to byte-match.
    if isinstance(v, bool):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, dict):
        return {k: _normalize(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_normalize(x) for x in v]
    return v


def stable_stringify(value) -> str:
    # Matches JS: recursive key sort, arrays in order, compact separators, no \u escapes.
    return json.dumps(_normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def generate_private_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


def private_key_to_pem(key: Ed25519PrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def private_key_from_pem(pem: str) -> Ed25519PrivateKey:
    return serialization.load_pem_private_key(pem.encode(), password=None)


def public_jwk(key: Ed25519PrivateKey, kid: str = "onp-1") -> dict:
    raw = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return {"kty": "OKP", "crv": "Ed25519", "x": b64u(raw), "kid": kid}


def sign_json(payload, key: Ed25519PrivateKey, kid: str = "onp-1") -> str:
    header = b64u(json.dumps({"alg": "EdDSA", "typ": "JWT", "kid": kid},
                             separators=(",", ":")).encode())
    body = b64u(stable_stringify(payload).encode())
    sig = key.sign(f"{header}.{body}".encode())
    return f"{header}.{body}.{b64u(sig)}"


def verify_jws(jws: str, jwk: dict):
    header, body, sig = jws.split(".")
    pub = Ed25519PublicKey.from_public_bytes(from_b64u(jwk["x"]))
    pub.verify(from_b64u(sig), f"{header}.{body}".encode())  # raises on mismatch
    return json.loads(from_b64u(body))


def sign_card(card: dict, key: Ed25519PrivateKey, kid: str = "onp-1") -> dict:
    payload = {k: v for k, v in card.items() if k != "signatures"}
    jws = sign_json(payload, key, kid)
    protected, _, signature = jws.split(".")
    return {**card, "signatures": [{"protected": protected, "signature": signature, "kid": kid}]}

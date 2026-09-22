"""End-to-end encryption for the Forge laptop bridge.

The relay routes frames it cannot read. Nothing in this file talks to the
network; it only turns a peer public key into a channel that seals and opens
bytes.

Scheme (see relay/PROTOCOL.md §3):

    identity   X25519 long-term keypair, private half in ~/.forge/keys.json (0600)
    secret     HKDF-SHA256(X25519(our_priv, their_pub),
                          salt   = sha256(deviceId),
                          info   = "forge-e2e-v2:" + deviceId + ":" + clientId)
    traffic    AES-256-GCM, nonce = 4-byte direction salt + 8-byte BE counter
    rekey      after 2**20 frames or 24 h, by re-running the handshake

Counters (not random nonces) because a WebSocket preserves order, so both ends
always agree, and a counter can never repeat the way random nonces eventually
do. Each direction has its own salt, so the two counters cannot collide either.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import threading
import time
from pathlib import Path

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.x25519 import (
        X25519PrivateKey,
        X25519PublicKey,
    )
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    CRYPTO_AVAILABLE = True
except ImportError:  # pragma: no cover - the installer pins this dependency
    CRYPTO_AVAILABLE = False

INFO_PREFIX = b"forge-e2e-v2:"
NONCE_BYTES = 12
SALT_BYTES = 4
TAG_BYTES = 16
MAX_PLAINTEXT_BYTES = 64 * 1024
REKEY_AFTER_FRAMES = 1 << 20
REKEY_AFTER_SECONDS = 24 * 3600


class CryptoUnavailable(RuntimeError):
    """Raised when `cryptography` is missing from the bridge venv."""


def _require():
    if not CRYPTO_AVAILABLE:
        raise CryptoUnavailable(
            "the 'cryptography' package is missing; re-run the Forge installer"
        )


def b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def b64decode(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def random_bytes(count: int) -> bytes:
    return os.urandom(count)


def random_salt() -> bytes:
    return os.urandom(SALT_BYTES)


class DeviceIdentity:
    """The laptop's long-term X25519 keypair.

    Created on first use, stored next to config.json with mode 0600, and reused
    for every client. Losing it means every paired browser must re-handshake,
    which is why it is written before anything else happens.
    """

    def __init__(self, path: Path):
        _require()
        self.path = Path(path)
        self._lock = threading.Lock()
        stored = self._read()
        if stored is None:
            key = X25519PrivateKey.generate()
            self._private = key
            self._write(key)
        else:
            self._private = X25519PrivateKey.from_private_bytes(stored)
        self._public_bytes = self._private.public_key().public_bytes_raw()
        self.created_at = int(time.time())

    def _read(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        raw = data.get("devicePrivateKey")
        if not raw:
            return None
        try:
            key = b64decode(raw)
        except Exception:
            return None
        return key if len(key) == 32 else None

    def _write(self, key: X25519PrivateKey) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 2,
            "curve": "x25519",
            "devicePrivateKey": b64encode(key.private_bytes_raw()),
            "devicePublicKey": b64encode(key.public_key().public_bytes_raw()),
            "createdAt": int(time.time()),
        }
        with self._lock:
            # Write-then-rename so a crash cannot leave a half-written key.
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass

    @property
    def public_b64(self) -> str:
        return b64encode(self._public_bytes)

    @property
    def public_bytes(self) -> bytes:
        return self._public_bytes

    def shared_secret(self, peer_public_b64: str) -> bytes:
        """X25519 ECDH with a browser's public key."""
        _require()
        peer_raw = b64decode(peer_public_b64)
        if len(peer_raw) != 32:
            raise ValueError("peer public key must be 32 bytes")
        peer = X25519PublicKey.from_public_bytes(peer_raw)
        return self._private.exchange(peer)


def derive_channel_key(shared_secret: bytes, device_id: str, client_id: str) -> bytes:
    """HKDF-SHA256 → 32-byte AES key, bound to this device+client pair."""
    _require()
    info = INFO_PREFIX + device_id.encode("utf-8") + b":" + client_id.encode("utf-8")
    salt = hashlib.sha256(device_id.encode("utf-8")).digest()
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(
        shared_secret
    )


class SecureChannel:
    """Seals and opens frames for one (client, machine) pair.

    Thread-safe: the bridge pumps PTY output from a reader thread while the
    WebSocket thread seals control frames.
    """

    def __init__(self, key: bytes, send_salt: bytes, recv_salt: bytes):
        _require()
        if len(key) != 32:
            raise ValueError("channel key must be 32 bytes")
        if len(send_salt) != SALT_BYTES or len(recv_salt) != SALT_BYTES:
            raise ValueError("direction salts must be %d bytes" % SALT_BYTES)
        self._aead = AESGCM(key)
        self._send_salt = send_salt
        self._recv_salt = recv_salt
        self._send_counter = 0
        self._recv_counter = 0
        self._lock = threading.Lock()
        self._created = time.time()
        self.sent_frames = 0
        self.recv_frames = 0

    @property
    def needs_rekey(self) -> bool:
        return (
            self.sent_frames >= REKEY_AFTER_FRAMES
            or (time.time() - self._created) >= REKEY_AFTER_SECONDS
        )

    def _nonce(self, salt: bytes, counter: int) -> bytes:
        return salt + struct.pack(">Q", counter)

    def seal(self, plaintext: bytes) -> bytes:
        """Return `nonce ‖ ciphertext` ready for the wire."""
        if len(plaintext) > MAX_PLAINTEXT_BYTES:
            raise ValueError(
                "frame too large: %d > %d bytes" % (len(plaintext), MAX_PLAINTEXT_BYTES)
            )
        with self._lock:
            nonce = self._nonce(self._send_salt, self._send_counter)
            self._send_counter += 1
            self.sent_frames += 1
        return nonce + self._aead.encrypt(nonce, plaintext, None)

    def open(self, blob: bytes) -> bytes:
        """Decrypt `nonce ‖ ciphertext`. Raises ValueError if it is not ours."""
        if len(blob) < NONCE_BYTES + TAG_BYTES:
            raise ValueError("ciphertext is truncated")
        nonce, ciphertext = blob[:NONCE_BYTES], blob[NONCE_BYTES:]
        with self._lock:
            expected = self._nonce(self._recv_salt, self._recv_counter)
            if nonce != expected:
                # Out-of-order or replayed frame. WebSocket is ordered, so this
                # means a stale socket or an attacker; refuse it either way.
                raise ValueError(
                    "unexpected nonce (counter %d)" % self._recv_counter
                )
            self._recv_counter += 1
            self.recv_frames += 1
        return self._aead.decrypt(nonce, ciphertext, None)

    def seal_text(self, payload: str) -> bytes:
        """Seal a UTF-8 string into raw `nonce ‖ ciphertext` bytes."""
        return self.seal(payload.encode("utf-8"))

    def open_text(self, sealed: bytes) -> str:
        """`open()` plus UTF-8 decoding, for raw sealed text frames."""
        return self.open(sealed).decode("utf-8", "replace")

    def seal_json(self, payload) -> str:
        """Seal and base64-encode — the form that fits inside a JSON RPC frame."""
        return b64encode(self.seal(json_dumps(payload)))

    def open_json(self, blob: str):
        return json.loads(self.open(b64decode(blob)).decode("utf-8"))


def json_dumps(payload) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def channel_from_handshake(
    identity: DeviceIdentity,
    device_id: str,
    client_id: str,
    client_public_b64: str,
    our_salt: bytes,
    their_salt: bytes,
) -> SecureChannel:
    """Build the machine side of a channel from a browser's handshake."""
    shared = identity.shared_secret(client_public_b64)
    key = derive_channel_key(shared, device_id, client_id)
    return SecureChannel(key, send_salt=our_salt, recv_salt=their_salt)

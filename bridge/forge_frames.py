"""Wire framing for the Forge bridge.

Two encodings share one WebSocket (relay/PROTOCOL.md §2):

* text   — JSON control frames: `{"v": 2, "type": "...", ...}`
* binary — terminal bytes, because base64 would inflate every keystroke batch
           and every screen update by a third.

Binary layout (45-byte header, then ciphertext):

    0       1    kind       0x01 = terminal payload
    1      16    sessionId  UUIDv4 raw bytes — which shell this belongs to
    17     16    clientId   UUIDv4 raw bytes — which browser it is for
    33     12    nonce      4-byte direction salt + 8-byte big-endian counter
    45      N    ciphertext AES-256-GCM, tag included

Every browser has its own key with this machine, so one shell with two viewers
means two sealed copies of the same bytes, each addressed to one viewer. The
relay reads the header to route and never decrypts.
"""

from __future__ import annotations

import json
import struct
import uuid

PROTOCOL_VERSION = 2
BRIDGE_VERSION = "4.0"

KIND_TERMINAL = 0x01
UUID_BYTES = 16
NONCE_BYTES = 12
# What the relay reads to route: kind + sessionId + clientId.
ROUTING_HEADER_BYTES = 1 + UUID_BYTES + UUID_BYTES
# Routing header plus the 12-byte nonce that travels inside the sealed blob.
HEADER_BYTES = ROUTING_HEADER_BYTES + NONCE_BYTES
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_FRAME_BYTES = HEADER_BYTES + MAX_PAYLOAD_BYTES + 16

_BINARY_HEADER = struct.Struct(">B16s16s")


def uuid_to_bytes(value: str) -> bytes:
    """UUID text → 16 raw bytes. Accepts bare hex too (relays are lenient)."""
    try:
        return uuid.UUID(str(value)).bytes
    except (ValueError, AttributeError, TypeError):
        cleaned = str(value).replace("-", "")
        if len(cleaned) != 32:
            raise ValueError("expected a UUID, got %r" % (value,))
        return bytes.fromhex(cleaned)


def uuid_from_bytes(raw: bytes) -> str:
    return str(uuid.UUID(bytes=raw))


def new_uuid() -> str:
    return str(uuid.uuid4())


# Backwards-compatible aliases: session and client ids are both UUIDs.
new_session_id = new_uuid
session_to_bytes = uuid_to_bytes
session_from_bytes = uuid_from_bytes


def pack_terminal(session_id: str, client_id: str, sealed: bytes) -> bytes:
    """`sealed` is `nonce ‖ ciphertext` from SecureChannel.seal()."""
    if len(sealed) < NONCE_BYTES:
        raise ValueError("sealed payload is too short")
    if len(sealed) - NONCE_BYTES > MAX_PAYLOAD_BYTES + 16:
        raise ValueError("terminal frame exceeds %d bytes" % MAX_FRAME_BYTES)
    return (
        _BINARY_HEADER.pack(
            KIND_TERMINAL, uuid_to_bytes(session_id), uuid_to_bytes(client_id)
        )
        + sealed
    )


def unpack_binary(raw: bytes):
    """Return `(kind, session_id, client_id, sealed)`, or None if malformed.

    `sealed` is `nonce ‖ ciphertext` — the nonce sits *after* the routing header
    and belongs to the payload, so it must not be sliced off here.
    """
    if not raw or len(raw) < HEADER_BYTES:
        return None
    try:
        kind, session_bytes, client_bytes = _BINARY_HEADER.unpack_from(raw, 0)
        return (
            kind,
            uuid_from_bytes(session_bytes),
            uuid_from_bytes(client_bytes),
            raw[ROUTING_HEADER_BYTES:],
        )
    except (struct.error, ValueError):
        return None


def text_frame(payload: dict) -> str:
    """JSON control frame with the protocol version stamped on it."""
    frame = dict(payload)
    # Stamped last so a payload can never claim a different protocol version.
    frame["v"] = PROTOCOL_VERSION
    return json.dumps(frame, separators=(",", ":"))


def parse_text(raw) -> dict | None:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def clamp_dimension(value, low: int, high: int, fallback: int) -> int:
    """Clamp cols/rows. xterm.js can emit garbage during a resize storm, and a
    bad winsize ioctl is exactly the kind of thing that kills a shell."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    if number < low:
        return low
    if number > high:
        return high
    return number


def split_length_prefixed(buffer: bytearray) -> tuple[list[bytes], bytearray]:
    """Split `4-byte BE length ‖ blob` frames out of a buffer.

    Used for the encrypted RPC response body: the relay streams bytes verbatim,
    so the laptop frames them and the browser unframes them.
    """
    frames = []
    while len(buffer) >= 4:
        (length,) = struct.unpack_from(">I", buffer, 0)
        if length == 0 or length > MAX_FRAME_BYTES:
            raise ValueError("bad frame length: %d" % length)
        if len(buffer) < 4 + length:
            break
        frames.append(bytes(buffer[4 : 4 + length]))
        del buffer[: 4 + length]
    return frames, buffer


def length_prefix(blob: bytes) -> bytes:
    return struct.pack(">I", len(blob)) + blob

"""Wire framing tests: the 45-byte binary header, JSON control frames, and the
length-prefixed framing used for encrypted RPC response bodies.
"""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forge_frames import (  # noqa: E402
    HEADER_BYTES,
    NONCE_BYTES,
    ROUTING_HEADER_BYTES,
    KIND_TERMINAL,
    PROTOCOL_VERSION,
    clamp_dimension,
    length_prefix,
    pack_terminal,
    parse_text,
    split_length_prefixed,
    text_frame,
    unpack_binary,
    uuid_from_bytes,
    uuid_to_bytes,
)


class FrameTest(unittest.TestCase):
    def setUp(self):
        self.session = str(uuid.uuid4())
        self.client = str(uuid.uuid4())

    def test_header_sizes_match_the_protocol_document(self):
        self.assertEqual(ROUTING_HEADER_BYTES, 33, "kind + sessionId + clientId")
        self.assertEqual(HEADER_BYTES, 45, "routing header + nonce")

    def test_uuid_round_trip(self):
        self.assertEqual(uuid_from_bytes(uuid_to_bytes(self.session)), self.session)

    def test_uuid_accepts_bare_hex(self):
        bare = self.session.replace("-", "")
        self.assertEqual(uuid_to_bytes(bare), uuid_to_bytes(self.session))

    def test_bad_uuid_is_refused(self):
        with self.assertRaises(ValueError):
            uuid_to_bytes("not-a-uuid")

    def test_terminal_frame_round_trip_keeps_the_nonce_with_the_payload(self):
        sealed = b"\x00" * NONCE_BYTES + b"ciphertext"
        frame = pack_terminal(self.session, self.client, sealed)
        self.assertEqual(len(frame), ROUTING_HEADER_BYTES + len(sealed))
        self.assertEqual(len(frame), HEADER_BYTES + len(b"ciphertext"))
        kind, session_id, client_id, payload = unpack_binary(frame)
        self.assertEqual(kind, KIND_TERMINAL)
        self.assertEqual(session_id, self.session)
        self.assertEqual(client_id, self.client)
        self.assertEqual(payload, sealed, "sealed must still contain its nonce")
        self.assertEqual(payload[:NONCE_BYTES], b"\x00" * NONCE_BYTES)

    def test_frame_without_ciphertext_is_rejected(self):
        self.assertIsNone(unpack_binary(b"\x01" * (HEADER_BYTES - 1)))

    def test_malformed_binary_frames_are_ignored_not_crashed_on(self):
        for bad in (b"", b"\x01", b"\x01" * 44, None):
            self.assertIsNone(unpack_binary(bad) if bad is not None else None)

    def test_truncated_sealed_payload_is_refused(self):
        with self.assertRaises(ValueError):
            pack_terminal(self.session, self.client, b"short")

    def test_text_frames_carry_the_protocol_version(self):
        frame = parse_text(text_frame({"type": "term_ready", "sessionId": self.session}))
        self.assertEqual(frame["v"], PROTOCOL_VERSION)
        self.assertEqual(frame["type"], "term_ready")
        self.assertEqual(frame["sessionId"], self.session)

    def test_text_frames_do_not_let_a_payload_override_the_version(self):
        frame = parse_text(text_frame({"v": 99, "type": "x"}))
        self.assertEqual(frame["v"], PROTOCOL_VERSION, "the version is stamped, not trusted")

    def test_parse_text_rejects_junk(self):
        self.assertIsNone(parse_text("not json"))
        self.assertIsNone(parse_text("[1,2,3]"))
        self.assertIsNone(parse_text(None))

    def test_clamp_dimension(self):
        self.assertEqual(clamp_dimension(120, 2, 500, 80), 120)
        self.assertEqual(clamp_dimension(0, 2, 500, 80), 2)
        self.assertEqual(clamp_dimension(10_000, 2, 500, 80), 500)
        self.assertEqual(clamp_dimension("abc", 2, 500, 80), 80)
        self.assertEqual(clamp_dimension(None, 2, 500, 80), 80)
        self.assertEqual(clamp_dimension("132", 2, 500, 80), 132)

    def test_length_prefixed_frames_split_exactly(self):
        blobs = [b"first chunk", b"second", b"x" * 300]
        stream = b"".join(length_prefix(blob) for blob in blobs)
        buffer = bytearray(stream)
        frames, rest = split_length_prefixed(buffer)
        self.assertEqual(frames, blobs)
        self.assertEqual(bytes(rest), b"")

    def test_length_prefixed_split_handles_a_partial_tail(self):
        stream = length_prefix(b"complete") + length_prefix(b"parti")
        buffer = bytearray(stream[:-3])
        frames, rest = split_length_prefixed(buffer)
        self.assertEqual(frames, [b"complete"])
        self.assertEqual(bytes(rest), stream[len(b"complete") + 4 : -3])
        # Feeding the rest back in completes the second frame.
        frames, rest = split_length_prefixed(bytearray(bytes(rest) + stream[-3:]))
        self.assertEqual(frames, [b"parti"])
        self.assertEqual(bytes(rest), b"")

    def test_absurd_frame_length_is_refused(self):
        buffer = bytearray(b"\xff\xff\xff\xff" + b"x" * 10)
        with self.assertRaises(ValueError):
            split_length_prefixed(buffer)


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Cross-language interop test: the Python bridge <-> the browser's own stack.

The browser uses @noble/curves for X25519 and WebCrypto for AES-GCM; the bridge
uses `cryptography`. If these two disagree about a single byte of the nonce or
the HKDF info string, terminals silently fail to connect — so this test drives
the real Node modules (`bridge/tests/crypto_peer.mjs`) against the real Python
channel and asserts they can read each other, byte-exactly, both ways.

Skipped automatically when `node` or the @noble packages are unavailable.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forge_crypto import (  # noqa: E402
    CRYPTO_AVAILABLE,
    DeviceIdentity,
    channel_from_handshake,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PEER = Path(__file__).resolve().parent / "crypto_peer.mjs"
NODE_AVAILABLE = shutil.which("node") is not None
NOBLE_AVAILABLE = (REPO_ROOT / "node_modules" / "@noble").exists()


@unittest.skipUnless(CRYPTO_AVAILABLE, "cryptography is not installed")
@unittest.skipUnless(NODE_AVAILABLE, "node is not installed")
@unittest.skipUnless(NOBLE_AVAILABLE, "@noble packages not installed (pnpm install)")
class CryptoInteropTest(unittest.TestCase):
    """Python seals -> Node opens, and Node seals -> Python opens."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.identity = DeviceIdentity(Path(self._tmp.name) / "keys.json")
        self.device_id = "dev_interop"
        self.client_id = "99999999-9999-4999-8999-999999999999"
        self.peer = subprocess.Popen(
            ["node", str(PEER)],
            cwd=str(REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def tearDown(self):
        try:
            if self.peer.stdin and not self.peer.stdin.closed:
                self.peer.stdin.close()
        except OSError:
            pass
        try:
            self.peer.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.peer.kill()
        self._tmp.cleanup()

    def _send(self, payload: dict) -> None:
        assert self.peer.stdin is not None
        self.peer.stdin.write(json.dumps(payload) + "\n")
        self.peer.stdin.flush()

    def _recv(self) -> dict:
        assert self.peer.stdout is not None
        line = self.peer.stdout.readline()
        if not line:
            stderr = self.peer.stderr.read() if self.peer.stderr else ""
            self.fail("node peer closed without replying: %s" % stderr[:800])
        return json.loads(line)

    def _handshake(self, python_salt: bytes):
        """Swap public keys and direction salts, like the relay would carry."""
        self._send(
            {
                "deviceId": self.device_id,
                "clientId": self.client_id,
                "pythonPublicKey": self.identity.public_b64,
                "pythonSalt": base64.b64encode(python_salt).decode(),
            }
        )
        hello = self._recv()
        self.assertNotIn("fatal", hello, hello.get("fatal"))
        channel = channel_from_handshake(
            self.identity,
            device_id=self.device_id,
            client_id=self.client_id,
            client_public_b64=hello["nodePublicKey"],
            our_salt=python_salt,
            their_salt=base64.b64decode(hello["nodeSalt"]),
        )
        return channel, hello

    def test_python_and_node_channels_interoperate(self):
        channel, hello = self._handshake(b"\x11\x22\x33\x44")
        self.assertEqual(hello["keyLength"], 32)

        # Node -> Python: two frames sealed with counters 0 then 1.
        self.assertEqual(len(hello["sealed"]), 2)
        for expected, sealed_b64 in zip(hello["plaintexts"], hello["sealed"]):
            self.assertEqual(channel.open_text(base64.b64decode(sealed_b64)), expected)

        # Python -> Node: keystrokes, raw binary PTY output, and JSON text.
        binary_output = b"\x1b[32mok\x1b[0m \xe2\x9c\x93 \x00\xff"
        outbound = [
            channel.seal(b"whoami\n"),
            channel.seal(binary_output),
            channel.seal_text(json.dumps({"type": "term_resize", "cols": 100, "rows": 30})),
        ]
        self._send({"sealed": [base64.b64encode(blob).decode() for blob in outbound]})
        result = self._recv()
        self.assertEqual(result["errors"], [], "node failed to open python frames")
        self.assertEqual(len(result["openedB64"]), 3)
        self.assertEqual(base64.b64decode(result["openedB64"][0]), b"whoami\n")
        self.assertEqual(
            base64.b64decode(result["openedB64"][1]),
            binary_output,
            "binary PTY output must survive byte-exactly (ANSI escapes, NUL, high bytes)",
        )
        self.assertEqual(
            json.loads(result["opened"][2]),
            {"type": "term_resize", "cols": 100, "rows": 30},
        )

    def test_a_replayed_python_frame_is_rejected_by_node(self):
        channel, _hello = self._handshake(b"\xaa\xbb\xcc\xdd")
        frame = base64.b64encode(channel.seal(b"first\n")).decode()
        # Send the same sealed frame twice in one batch: the first opens fine,
        # the second hits a nonce WebCrypto has already consumed and fails.
        self._send({"sealed": [frame, frame]})
        result = self._recv()
        self.assertEqual(result["openedB64"], [base64.b64encode(b"first\n").decode()])
        self.assertTrue(result["errors"], "a replayed frame must be rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)

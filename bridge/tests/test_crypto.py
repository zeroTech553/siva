"""E2E crypto tests: the handshake, nonce discipline, and key binding.

The property that matters most is the last one — a channel derived for one
browser must not be able to read another browser's frames, even though both
handshakes pass through the same relay that can see both public keys.
"""

from __future__ import annotations

import base64
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forge_crypto import (  # noqa: E402
    CRYPTO_AVAILABLE,
    DeviceIdentity,
    SecureChannel,
    channel_from_handshake,
    derive_channel_key,
    random_salt,
)


@unittest.skipUnless(CRYPTO_AVAILABLE, "cryptography is not installed")
class CryptoTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.device_id = "dev_0001"
        self.client_id = "11111111-1111-4111-8111-111111111111"

    def tearDown(self):
        self._tmp.cleanup()

    def _identity(self, name: str) -> DeviceIdentity:
        return DeviceIdentity(self.dir / ("%s.json" % name))

    def _pair(self, device: DeviceIdentity, client: DeviceIdentity, client_id: str):
        """Full handshake as the bridge and the browser would do it."""
        device_salt, client_salt = random_salt(), random_salt()
        machine = channel_from_handshake(
            device,
            device_id=self.device_id,
            client_id=client_id,
            client_public_b64=client.public_b64,
            our_salt=device_salt,
            their_salt=client_salt,
        )
        browser = channel_from_handshake(
            client,
            device_id=self.device_id,
            client_id=client_id,
            client_public_b64=device.public_b64,
            our_salt=client_salt,
            their_salt=device_salt,
        )
        return machine, browser

    def test_identity_is_created_once_and_reused(self):
        first = self._identity("device")
        public = first.public_b64
        second = DeviceIdentity(self.dir / "device.json")
        self.assertEqual(second.public_b64, public, "identity must survive a restart")

    def test_private_key_file_is_owner_only(self):
        self._identity("device")
        mode = stat.S_IMODE(os.stat(self.dir / "device.json").st_mode)
        self.assertEqual(mode, 0o600, "keys.json must be 0600, got %o" % mode)

    def test_handshake_produces_a_working_channel_both_ways(self):
        machine, browser = self._pair(self._identity("device"), self._identity("client"), self.client_id)
        sealed = browser.seal(b"ls -la\n")
        self.assertEqual(machine.open(sealed), b"ls -la\n")
        reply = machine.seal(b"total 8\ndrwxr-xr-x")
        self.assertEqual(browser.open(reply), b"total 8\ndrwxr-xr-x")

    def test_json_round_trip(self):
        machine, browser = self._pair(self._identity("d2"), self._identity("c2"), self.client_id)
        blob = browser.seal_json({"cols": 120, "rows": 40, "cwd": "/home/siva"})
        self.assertEqual(machine.open_json(blob), {"cols": 120, "rows": 40, "cwd": "/home/siva"})

    def test_nonce_is_a_counter_and_out_of_order_frames_are_refused(self):
        machine, browser = self._pair(self._identity("d3"), self._identity("c3"), self.client_id)
        first = browser.seal(b"one")
        second = browser.seal(b"two")
        self.assertEqual(machine.open(first), b"one")
        self.assertEqual(machine.open(second), b"two")
        with self.assertRaises(ValueError):
            machine.open(first)  # replay
        with self.assertRaises(ValueError):
            machine.open(second)  # replay

    def test_tampered_ciphertext_fails_authentication(self):
        machine, browser = self._pair(self._identity("d4"), self._identity("c4"), self.client_id)
        sealed = bytearray(browser.seal(b"rm -rf /"))
        sealed[-1] ^= 0xFF
        with self.assertRaises(Exception):
            machine.open(bytes(sealed))

    def test_truncated_frame_is_refused(self):
        machine, _ = self._pair(self._identity("d5"), self._identity("c5"), self.client_id)
        with self.assertRaises(ValueError):
            machine.open(b"short")

    def test_oversized_frame_is_refused(self):
        _, browser = self._pair(self._identity("d6"), self._identity("c6"), self.client_id)
        with self.assertRaises(ValueError):
            browser.seal(b"x" * (64 * 1024 + 1))

    def test_channels_are_bound_to_the_client_id(self):
        """The key property: two browsers of the same machine cannot read
        each other's streams, because clientId is in the HKDF info string."""
        device = self._identity("shared-device")
        alice_id = "22222222-2222-4222-8222-222222222222"
        bob_id = "33333333-3333-4333-8333-333333333333"
        alice_machine, alice_browser = self._pair(device, self._identity("alice"), alice_id)
        bob_machine, bob_browser = self._pair(device, self._identity("bob"), bob_id)

        alice_frame = alice_browser.seal(b"alice private keystrokes")
        self.assertEqual(alice_machine.open(alice_frame), b"alice private keystrokes")
        with self.assertRaises(Exception):
            bob_machine.open(alice_frame)

        bob_frame = bob_browser.seal(b"bob private keystrokes")
        with self.assertRaises(Exception):
            alice_machine.open(bob_frame)
        self.assertEqual(bob_machine.open(bob_frame), b"bob private keystrokes")

    def test_derived_key_depends_on_device_and_client(self):
        secret = os.urandom(32)
        a = derive_channel_key(secret, "dev_a", "client_1")
        b = derive_channel_key(secret, "dev_b", "client_1")
        c = derive_channel_key(secret, "dev_a", "client_2")
        self.assertEqual(len(a), 32)
        self.assertNotEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertEqual(a, derive_channel_key(secret, "dev_a", "client_1"), "must be deterministic")

    def test_bad_peer_key_is_refused(self):
        device = self._identity("d7")
        with self.assertRaises(Exception):
            device.shared_secret(base64.b64encode(b"too-short").decode())

    def test_channel_key_length_is_enforced(self):
        with self.assertRaises(ValueError):
            SecureChannel(b"short", random_salt(), random_salt())

    def test_salt_length_is_enforced(self):
        with self.assertRaises(ValueError):
            SecureChannel(os.urandom(32), b"12", random_salt())


if __name__ == "__main__":
    unittest.main(verbosity=2)

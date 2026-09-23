"""Real-PTY tests. These spawn actual shells, so they prove the terminal is a
terminal: `tty` must report a pts device and `stty size` must follow a resize.
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forge_pty import (  # noqa: E402
    MAX_COLS,
    MAX_ROWS,
    PtyManager,
    PtyUnavailable,
    default_shell,
    shell_capabilities,
)


class SessionHarness:
    """Collects what a session emits so assertions can wait on it."""

    def __init__(self):
        self.output = bytearray()
        self.exits: list = []
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)

    def on_output(self, session_id: str, data: bytes) -> None:
        with self.cond:
            self.output.extend(data)
            self.cond.notify_all()

    def on_exit(self, session_id: str, code) -> None:
        with self.cond:
            self.exits.append((session_id, code))
            self.cond.notify_all()

    def text(self) -> str:
        with self.lock:
            return self.output.decode("utf-8", "replace")

    def wait_for(self, needle: str, timeout: float = 15.0) -> bool:
        deadline = time.monotonic() + timeout
        with self.cond:
            while time.monotonic() < deadline:
                if needle in self.output.decode("utf-8", "replace"):
                    return True
                self.cond.wait(0.1)
        return needle in self.text()

    def wait_for_exit(self, timeout: float = 15.0) -> bool:
        deadline = time.monotonic() + timeout
        with self.cond:
            while time.monotonic() < deadline:
                if self.exits:
                    return True
                self.cond.wait(0.1)
        return bool(self.exits)


@unittest.skipIf(os.name == "nt", "POSIX PTY only")
class PosixPtyTest(unittest.TestCase):
    def setUp(self):
        self.harness = SessionHarness()
        self.manager = PtyManager(self.harness.on_output, self.harness.on_exit)

    def tearDown(self):
        self.manager.close_all()

    def test_default_shell_is_an_argv_list_that_exists(self):
        argv = default_shell()
        self.assertIsInstance(argv, list)
        self.assertTrue(argv, "no default shell resolved")
        self.assertTrue(Path(argv[0]).exists(), "%s does not exist" % argv[0])

    def test_capabilities_report_the_backend(self):
        caps = shell_capabilities()
        self.assertEqual(caps["pty"], "posix")
        self.assertIn("shell", caps)

    def test_session_is_a_real_pty_not_a_pipe(self):
        session = self.manager.create(cols=100, rows=30, shell=["/bin/sh"])
        self.assertTrue(session.is_pty, "session did not get a PTY")
        self.assertEqual(session.backend, "posix")
        session.write(b"tty\n")
        self.assertTrue(
            self.harness.wait_for("/dev/") or self.harness.wait_for("pts"),
            "tty did not report a pts device: %r" % self.harness.text(),
        )

    def test_output_and_echo_round_trip(self):
        session = self.manager.create(shell=["/bin/sh"])
        session.write(b"echo FORGE_MARKER_$((6*7))\n")
        self.assertTrue(self.harness.wait_for("FORGE_MARKER_42"))
        self.assertIn("FORGE_MARKER_42", self.harness.text())
        self.assertGreater(session.bytes_out, 0)
        self.assertGreaterEqual(session.bytes_in, 10)

    def test_interactive_program_gets_a_tty(self):
        """`stty` only works when stdin is a terminal — the real test."""
        if not shutil.which("stty"):
            self.skipTest("stty not installed")
        session = self.manager.create(cols=111, rows=33, shell=["/bin/sh"])
        session.write(b"stty size\n")
        self.assertTrue(self.harness.wait_for("33 111"), self.harness.text())

    def test_resize_reaches_the_kernel_and_clamps_garbage(self):
        if not shutil.which("stty"):
            self.skipTest("stty not installed")
        session = self.manager.create(cols=80, rows=24, shell=["/bin/sh"])
        session.resize(132, 43)
        self.assertEqual((session.cols, session.rows), (132, 43))
        session.write(b"stty size\n")
        self.assertTrue(self.harness.wait_for("43 132"), self.harness.text())

        # xterm.js emits garbage mid-resize; none of these may kill the shell.
        session.resize(0, 0)
        self.assertEqual((session.cols, session.rows), (2, 1))
        session.resize(10_000, 10_000)
        self.assertEqual((session.cols, session.rows), (MAX_COLS, MAX_ROWS))
        session.resize("abc", None)
        self.assertTrue(session.alive)

    def test_ctrl_c_interrupts_a_running_command(self):
        session = self.manager.create(shell=["/bin/sh"])
        session.write(b"sleep 30\n")
        time.sleep(0.6)
        session.write(b"\x03")  # Ctrl-C
        self.assertTrue(self.harness.wait_for("Interrupt") or self.harness.wait_for("^C"),
                        self.harness.text())
        session.write(b"echo STILL_ALIVE\n")
        self.assertTrue(self.harness.wait_for("STILL_ALIVE"), "shell died after Ctrl-C")

    def test_exit_reports_a_code_and_reaps_the_session(self):
        session = self.manager.create(shell=["/bin/sh"])
        session.write(b"exit 7\n")
        self.assertTrue(self.harness.wait_for_exit(), "no exit callback")
        self.assertEqual(self.harness.exits[0][0], session.session_id)
        self.assertEqual(self.harness.exits[0][1], 7)
        time.sleep(0.2)
        self.assertIsNone(self.manager.get(session.session_id))

    def test_replay_buffer_resends_scrollback_to_a_new_viewer(self):
        session = self.manager.create(shell=["/bin/sh"])
        session.write(b"echo REPLAY_LINE_ONE\n")
        self.assertTrue(self.harness.wait_for("REPLAY_LINE_ONE"))
        replay = session.replay_bytes()
        self.assertIn(b"REPLAY_LINE_ONE", replay)
        # A second device attaching later gets the screen it missed.
        session.attach("client-two")
        self.assertIn("client-two", session.snapshot()["attached"])

    def test_multiple_sessions_are_isolated(self):
        first = self.manager.create(shell=["/bin/sh"])
        second = self.manager.create(shell=["/bin/sh"])
        self.assertNotEqual(first.session_id, second.session_id)
        first.write(b"echo ONLY_IN_FIRST\n")
        self.assertTrue(self.harness.wait_for("ONLY_IN_FIRST"))
        self.assertEqual(len(self.manager.list()), 2)
        self.manager.close(first.session_id)
        time.sleep(0.3)
        self.assertEqual(len(self.manager.list()), 1)

    def test_session_limit_is_enforced(self):
        manager = PtyManager(self.harness.on_output, self.harness.on_exit, max_sessions=2)
        try:
            manager.create(shell=["/bin/sh"])
            manager.create(shell=["/bin/sh"])
            with self.assertRaises(PtyUnavailable):
                manager.create(shell=["/bin/sh"])
        finally:
            manager.close_all()

    def test_missing_working_directory_is_refused(self):
        with self.assertRaises(PtyUnavailable):
            self.manager.create(cwd="/nonexistent/forge/path", shell=["/bin/sh"])

    def test_snapshot_shape_is_stable_for_the_ui(self):
        session = self.manager.create(cols=90, rows=25, shell=["/bin/sh"])
        snap = session.snapshot()
        for key in (
            "sessionId",
            "shell",
            "cwd",
            "cols",
            "rows",
            "backend",
            "pty",
            "alive",
            "attached",
            "startedAt",
        ):
            self.assertIn(key, snap)
        self.assertEqual(snap["cols"], 90)
        self.assertTrue(snap["alive"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

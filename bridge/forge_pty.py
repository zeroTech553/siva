"""Real PTY sessions on the laptop.

This is the module that makes the browser terminal a *terminal* instead of a
command runner: it owns a pseudo-terminal, so `vim`, `top`, `claude`, tab
completion, colours, `Ctrl-C` and window resizing all behave exactly as they do
in a native terminal window.

One interface, three backends:

    PosixPty   pty.fork() + termios/fcntl      macOS, Linux
    ConPty     pywinpty (ConPTY)               Windows 10 1809+
    PipePty    subprocess pipes                last-resort fallback

PipePty is not a terminal — programs detect the pipe and drop colours and
interactivity — so a session created on it is flagged `pty: False` and the UI
says why. It exists so a Windows machine without pywinpty still gets a usable
shell instead of an error.

Sessions outlive the browser: they live here until the shell exits, the client
asks to close them, or they idle out with nobody attached (`IDLE_TTL_SECONDS`).
That is what makes "close the tab on the train, reopen it at home" work, and it
is why the scrollback replay buffer lives here rather than in the relay.
"""

from __future__ import annotations

import errno
import os
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

from forge_frames import clamp_dimension, new_session_id

IS_WINDOWS = os.name == "nt"
READ_CHUNK_BYTES = 16 * 1024
REPLAY_BUFFER_BYTES = 256 * 1024
MIN_COLS, MAX_COLS = 2, 500
MIN_ROWS, MAX_ROWS = 1, 200
DEFAULT_COLS, DEFAULT_ROWS = 80, 24
MAX_SESSIONS = 8
IDLE_TTL_SECONDS = 12 * 3600
WRITE_TIMEOUT_SECONDS = 5

if not IS_WINDOWS:
    import fcntl
    import pty
    import select
    import termios

    _TIOCSWINSZ = termios.TIOCSWINSZ


# ---------------------------------------------------------------------------
# backends
# ---------------------------------------------------------------------------


class PtyUnavailable(RuntimeError):
    """No backend could start a shell (missing binary, permission denied, …)."""


class BackendHandle:
    """Minimal contract every backend implements."""

    backend = "unknown"
    is_pty = False

    def read(self, timeout: float) -> bytes | None:
        raise NotImplementedError

    def write(self, data: bytes) -> None:
        raise NotImplementedError

    def resize(self, cols: int, rows: int) -> None:
        raise NotImplementedError

    def terminate(self) -> None:
        raise NotImplementedError

    @property
    def alive(self) -> bool:
        raise NotImplementedError

    @property
    def pid(self) -> int | None:
        return None

    @property
    def exit_code(self) -> int | None:
        return None


class PosixHandle(BackendHandle):
    """A PTY master fd plus its child pid, via pty.fork()."""

    backend = "posix"
    is_pty = True

    def __init__(self, pid: int, fd: int):
        self._pid = pid
        self._fd = fd
        self._exit_code: int | None = None
        self._closed = False

    @property
    def pid(self) -> int:
        return self._pid

    @property
    def alive(self) -> bool:
        if self._closed:
            return False
        if self._exit_code is not None:
            return False
        try:
            pid, status = os.waitpid(self._pid, os.WNOHANG)
        except ChildProcessError:
            self._exit_code = self._exit_code if self._exit_code is not None else -1
            return False
        if pid == 0:
            return True
        self._exit_code = os.waitstatus_to_exit_code(status) if hasattr(
            os, "waitstatus_to_exit_code"
        ) else (status >> 8)
        return False

    @property
    def exit_code(self) -> int | None:
        self.alive  # refresh
        return self._exit_code

    def read(self, timeout: float) -> bytes | None:
        if self._closed:
            return b""
        try:
            ready, _, _ = select.select([self._fd], [], [], timeout)
        except (OSError, ValueError):
            return b""
        if not ready:
            return None
        try:
            data = os.read(self._fd, READ_CHUNK_BYTES)
        except OSError as error:
            # EIO is how Linux/macOS say "the child is gone".
            if error.errno in (errno.EIO, errno.EBADF):
                return b""
            raise
        return data

    def write(self, data: bytes) -> None:
        if self._closed:
            raise PtyUnavailable("session is closed")
        view = memoryview(data)
        deadline = time.monotonic() + WRITE_TIMEOUT_SECONDS
        while view:
            if time.monotonic() > deadline:
                raise PtyUnavailable("write timed out (is the shell blocked?)")
            try:
                written = os.write(self._fd, view)
            except BlockingIOError:
                time.sleep(0.005)
                continue
            except OSError as error:
                if error.errno in (errno.EIO, errno.EBADF, errno.EPIPE):
                    raise PtyUnavailable("session is closed") from error
                raise
            view = view[written:]

    def resize(self, cols: int, rows: int) -> None:
        if self._closed:
            return
        try:
            fcntl.ioctl(self._fd, _TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            return
        try:
            os.kill(self._pid, signal.SIGWINCH)
        except (OSError, ProcessLookupError):
            pass

    def terminate(self) -> None:
        if self._closed:
            return
        self._closed = True
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self._pid, sig)
            except (OSError, ProcessLookupError):
                break
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                if not self.alive:
                    break
                time.sleep(0.02)
            if not self.alive:
                break
        try:
            os.close(self._fd)
        except OSError:
            pass


class ConPtyHandle(BackendHandle):
    """Windows ConPTY through pywinpty's PtyProcess facade."""

    backend = "conpty"
    is_pty = True

    def __init__(self, process):
        self._process = process
        self._closed = False

    @property
    def pid(self) -> int | None:
        return getattr(self._process, "pid", None)

    @property
    def alive(self) -> bool:
        if self._closed:
            return False
        try:
            return bool(self._process.isalive())
        except Exception:
            return False

    @property
    def exit_code(self) -> int | None:
        try:
            if not self._process.isalive():
                return int(getattr(self._process, "exitstatus", 0) or 0)
        except Exception:
            pass
        return None

    def read(self, timeout: float) -> bytes | None:
        # PtyProcess.read blocks; the deadline is enforced by the pump thread's
        # own timeout because ConPTY has no select().
        if self._closed:
            return b""
        try:
            text = self._process.read(READ_CHUNK_BYTES)
        except EOFError:
            return b""
        except Exception as error:
            if "closed" in str(error).lower():
                return b""
            raise
        if text is None:
            return None
        if isinstance(text, bytes):
            return text
        return text.encode("utf-8", "replace")

    def write(self, data: bytes) -> None:
        if self._closed:
            raise PtyUnavailable("session is closed")
        try:
            self._process.write(data.decode("utf-8", "replace"))
        except Exception as error:
            raise PtyUnavailable("ConPTY write failed: %s" % error) from error

    def resize(self, cols: int, rows: int) -> None:
        if self._closed:
            return
        try:
            self._process.setwinsize(rows, cols)
        except Exception:
            pass

    def terminate(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._process.terminate(force=True)
        except Exception:
            pass


class PipeHandle(BackendHandle):
    """Not a PTY. Pipes only, so no colours, no TUIs, no job control."""

    backend = "pipe"
    is_pty = False

    def __init__(self, process: subprocess.Popen):
        self._process = process
        self._closed = False
        self._lock = threading.Lock()

    @property
    def pid(self) -> int | None:
        return self._process.pid

    @property
    def alive(self) -> bool:
        return self._process.poll() is None and not self._closed

    @property
    def exit_code(self) -> int | None:
        return self._process.poll()

    def read(self, timeout: float) -> bytes | None:
        if self._closed or self._process.stdout is None:
            return b""
        # readline() blocks, but a shell writes a prompt line immediately, and
        # the pump thread tolerates the wait; EOF unblocks it for good.
        try:
            data = self._process.stdout.read1(READ_CHUNK_BYTES)
        except (ValueError, OSError):
            return b""
        return data if data else b""

    def write(self, data: bytes) -> None:
        if self._closed or self._process.stdin is None:
            raise PtyUnavailable("session is closed")
        with self._lock:
            try:
                self._process.stdin.write(data)
                self._process.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                raise PtyUnavailable("shell input is closed") from error

    def resize(self, cols: int, rows: int) -> None:
        return None

    def terminate(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._process.stdin:
                self._process.stdin.close()
        except OSError:
            pass
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()


# ---------------------------------------------------------------------------
# shell resolution
# ---------------------------------------------------------------------------


def default_shell() -> list[str]:
    """The shell a native terminal window would open, as an argv list."""
    if IS_WINDOWS:
        for candidate in ("pwsh.exe", "powershell.exe"):
            found = shutil.which(candidate)
            if found:
                return [found, "-NoLogo"]
        comspec = os.environ.get("COMSPEC")
        return [comspec] if comspec else ["cmd.exe"]

    shell = os.environ.get("SHELL", "").strip()
    if shell and Path(shell).exists():
        argv = [shell]
    else:
        for candidate in ("/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"):
            if Path(candidate).exists():
                argv = [candidate]
                break
        else:
            argv = ["/bin/sh"]
    name = Path(argv[0]).name
    if name in {"bash", "zsh", "fish", "-bash", "-zsh"}:
        # Login shell, so the user's PATH (and therefore `claude`, `codex`, …)
        # matches what they get in their own terminal.
        argv.append("-l" if name.startswith("-") is False else "-l")
    return argv


def shell_capabilities() -> dict:
    backend = "pipe"
    if not IS_WINDOWS:
        backend = "posix"
    else:
        try:
            import winpty  # noqa: F401

            backend = "conpty"
        except ImportError:
            backend = "pipe"
    return {
        "pty": backend,
        "shell": " ".join(default_shell()),
        "platform": sys.platform,
        "windows": IS_WINDOWS,
    }


def _terminal_env(cols: int, rows: int, cwd: str, session_id: str) -> dict:
    env = dict(os.environ)
    env.update(
        {
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "FORGE_SESSION": session_id,
            "FORGE_TERMINAL": "1",
            "COLUMNS": str(cols),
            "LINES": str(rows),
        }
    )
    if cwd:
        env["PWD"] = cwd
    env.setdefault("LANG", "en_US.UTF-8")
    # A stale TMUX makes nested shells refuse to start.
    env.pop("TMUX", None)
    return env


def _spawn(argv: list[str], cwd: str, cols: int, rows: int, session_id: str):
    env = _terminal_env(cols, rows, cwd, session_id)
    working_dir = cwd or str(Path.home())
    if not Path(working_dir).is_dir():
        raise PtyUnavailable("working directory does not exist: %s" % working_dir)

    if not IS_WINDOWS:
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(working_dir)
                os.environ.clear()
                os.environ.update(env)
                os.execvp(argv[0], argv)
            except BaseException:
                os._exit(127)
        handle = PosixHandle(pid, fd)
        handle.resize(cols, rows)
        return handle

    try:
        from winpty import PtyProcess
    except ImportError:
        PtyProcess = None

    if PtyProcess is not None:
        command = subprocess.list2cmdline(argv)
        try:
            process = PtyProcess.spawn(
                command, cwd=working_dir, dimensions=(rows, cols), env=env
            )
            return ConPtyHandle(process)
        except TypeError:
            # Older pywinpty: no keyword arguments for dimensions/env.
            try:
                process = PtyProcess.spawn(command, cwd=working_dir)
                handle = ConPtyHandle(process)
                handle.resize(cols, rows)
                return handle
            except Exception:
                pass
        except Exception:
            pass

    try:
        process = subprocess.Popen(
            argv,
            cwd=working_dir,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )
    except (OSError, ValueError) as error:
        raise PtyUnavailable("could not start %s: %s" % (argv[0], error)) from error
    return PipeHandle(process)


# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------


class PtySession:
    """One shell. Owns a reader thread, a scrollback buffer and its clients."""

    def __init__(
        self,
        session_id: str,
        handle: BackendHandle,
        argv: list[str],
        cwd: str,
        cols: int,
        rows: int,
        on_output,
        on_exit,
    ):
        self.session_id = session_id
        self.handle = handle
        self.argv = argv
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.started_at = time.time()
        self.last_attached_at = time.time()
        self.last_output_at = 0.0
        self.attached: set[str] = set()
        self.is_pty = handle.is_pty
        self.backend = handle.backend
        self.bytes_out = 0
        self.bytes_in = 0

        self._on_output = on_output
        self._on_exit = on_exit
        self._replay = bytearray()
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._reader = threading.Thread(
            target=self._pump, name="forge-pty-%s" % session_id[:8], daemon=True
        )
        self._reader.start()

    # -- lifecycle ---------------------------------------------------------
    @property
    def alive(self) -> bool:
        return not self._closed.is_set() and self.handle.alive

    @property
    def pid(self) -> int | None:
        return self.handle.pid

    def snapshot(self) -> dict:
        return {
            "sessionId": self.session_id,
            "shell": " ".join(self.argv),
            "cwd": self.cwd,
            "pid": self.pid,
            "cols": self.cols,
            "rows": self.rows,
            "backend": self.backend,
            "pty": self.is_pty,
            "alive": self.alive,
            "attached": sorted(self.attached),
            "startedAt": self.started_at,
            "bytesOut": self.bytes_out,
            "bytesIn": self.bytes_in,
        }

    def attach(self, client_id: str) -> None:
        with self._lock:
            self.attached.add(client_id)
            self.last_attached_at = time.time()

    def detach(self, client_id: str) -> None:
        with self._lock:
            self.attached.discard(client_id)
            self.last_attached_at = time.time()

    def replay_bytes(self) -> bytes:
        with self._lock:
            return bytes(self._replay)

    # -- io ----------------------------------------------------------------
    def write(self, data: bytes) -> None:
        if not data:
            return
        self.bytes_in += len(data)
        self.handle.write(data)

    def resize(self, cols: int, rows: int) -> None:
        cols = clamp_dimension(cols, MIN_COLS, MAX_COLS, self.cols)
        rows = clamp_dimension(rows, MIN_ROWS, MAX_ROWS, self.rows)
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        self.handle.resize(cols, rows)

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        self.handle.terminate()

    def _remember(self, data: bytes) -> None:
        with self._lock:
            self._replay.extend(data)
            overflow = len(self._replay) - REPLAY_BUFFER_BYTES
            if overflow > 0:
                # Trim on a newline when we can, so replay does not start in the
                # middle of an escape sequence.
                cut = overflow
                boundary = self._replay.find(b"\n", overflow - 4096 if overflow > 4096 else 0)
                if 0 <= boundary < overflow + 4096:
                    cut = boundary + 1
                del self._replay[:cut]

    def _pump(self) -> None:
        """Reader thread: PTY → replay buffer → relay."""
        try:
            while not self._closed.is_set():
                try:
                    data = self.handle.read(0.25)
                except PtyUnavailable:
                    break
                except OSError:
                    break
                if data is None:
                    if not self.handle.alive:
                        break
                    continue
                if data == b"":
                    break
                self.bytes_out += len(data)
                self.last_output_at = time.time()
                self._remember(data)
                self._on_output(self.session_id, data)
        finally:
            exit_code = self.handle.exit_code
            self.close()
            self._on_exit(self.session_id, exit_code)


class PtyManager:
    """All live shells on this machine."""

    def __init__(self, on_output, on_exit, max_sessions: int = MAX_SESSIONS):
        self._sessions: dict[str, PtySession] = {}
        self._lock = threading.Lock()
        self._on_output = on_output
        self._on_exit = on_exit
        self._max_sessions = max_sessions
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True)
        self._reaper.start()

    # -- api ---------------------------------------------------------------
    def create(
        self,
        session_id: str | None = None,
        cols: int = DEFAULT_COLS,
        rows: int = DEFAULT_ROWS,
        cwd: str = "",
        shell: str | list[str] | None = None,
    ) -> PtySession:
        with self._lock:
            self._prune_dead()
            if len(self._sessions) >= self._max_sessions:
                raise PtyUnavailable(
                    "already running %d sessions (limit %d)"
                    % (len(self._sessions), self._max_sessions)
                )
        session_id = session_id or new_session_id()
        cols = clamp_dimension(cols, MIN_COLS, MAX_COLS, DEFAULT_COLS)
        rows = clamp_dimension(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS)
        argv = _resolve_argv(shell)
        handle = _spawn(argv, cwd, cols, rows, session_id)
        session = PtySession(
            session_id=session_id,
            handle=handle,
            argv=argv,
            cwd=str(Path(cwd).resolve()) if cwd else str(Path.home()),
            cols=cols,
            rows=rows,
            on_output=self._on_output,
            on_exit=self._on_exit,
        )
        with self._lock:
            self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> PtySession | None:
        with self._lock:
            session = self._sessions.get(session_id)
        if session and not session.alive:
            self.forget(session_id)
            return None
        return session

    def list(self) -> list[dict]:
        with self._lock:
            sessions = list(self._sessions.values())
        return [session.snapshot() for session in sessions]

    def close(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        session.close()
        return True

    def forget(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()

    # -- internals ---------------------------------------------------------
    def _prune_dead(self) -> None:
        dead = [sid for sid, s in self._sessions.items() if not s.alive]
        for sid in dead:
            self._sessions.pop(sid, None)

    def _reap_loop(self) -> None:
        while True:
            time.sleep(60)
            now = time.time()
            with self._lock:
                self._prune_dead()
                victims = [
                    sid
                    for sid, session in self._sessions.items()
                    if not session.attached
                    and (now - session.last_attached_at) > IDLE_TTL_SECONDS
                ]
            for sid in victims:
                self.close(sid)


def _resolve_argv(shell: str | list[str] | None) -> list[str]:
    """Accept nothing (default shell), a list, or a command line string."""
    if not shell:
        return default_shell()
    if isinstance(shell, (list, tuple)):
        argv = [str(part) for part in shell if str(part).strip()]
        return argv or default_shell()
    text = str(shell).strip()
    if not text:
        return default_shell()
    try:
        argv = shlex.split(text, posix=not IS_WINDOWS)
    except ValueError:
        argv = text.split()
    return argv or default_shell()

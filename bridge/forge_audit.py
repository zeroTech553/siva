"""Append-only audit log of everything a remote client did to this machine.

You are handing a browser a shell on your laptop. The least the machine can do
is keep a receipt: one JSON line per action in `~/.forge/audit.log`, written
locally, never uploaded, rotatable by the user at any time.

Format (one line, stable keys, safe to `jq`):

    {"ts":1760000000.123,"action":"term.input","sessionId":"…","clientId":"…",
     "bytes":42,"detail":"…"}

Actions: term.open, term.input (bytes only — never the keystrokes themselves),
term.resize, term.close, fs.list, fs.read, fs.write, fs.edit, fs.upload,
fs.download, fs.delete, rpc.request, pair.claimed, channel.established.

The log deliberately records *sizes and paths*, not content. Content would make
the audit log the most sensitive file on the machine.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024
KEEP_BYTES = 2 * 1024 * 1024
MAX_DETAIL = 240


class AuditLog:
    def __init__(self, path: Path | str | None = None):
        if path is None:
            override = os.environ.get("FORGE_AUDIT_LOG", "").strip()
            path = Path(override) if override else Path.home() / ".forge" / "audit.log"
        self.path = Path(path)
        self._lock = threading.Lock()
        self._ensure()

    def _ensure(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if not self.path.exists():
                self.path.touch(mode=0o600)
                try:
                    os.chmod(self.path, 0o600)
                except OSError:
                    pass
        except OSError:
            # An unwritable home directory must not take the bridge down.
            pass

    def write(self, action: str, **fields) -> None:
        record = {"ts": round(time.time(), 3), "action": action}
        for key, value in fields.items():
            if value is None or value == "":
                continue
            if isinstance(value, str) and len(value) > MAX_DETAIL:
                value = value[:MAX_DETAIL] + "…"
            record[key] = value
        line = json.dumps(record, separators=(",", ":"), default=str)
        with self._lock:
            try:
                self._rotate_if_needed()
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            except OSError:
                pass

    def _rotate_if_needed(self) -> None:
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size <= MAX_BYTES:
            return
        try:
            with self.path.open("rb") as handle:
                handle.seek(size - KEEP_BYTES)
                tail = handle.read()
            cut = tail.find(b"\n")
            if cut >= 0:
                tail = tail[cut + 1 :]
            tmp = self.path.with_suffix(".tmp")
            tmp.write_bytes(tail)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def recent(self, limit: int = 50) -> list[dict]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        out = []
        for line in lines[-limit:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

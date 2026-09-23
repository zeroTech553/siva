"""The laptop's filesystem, exposed to the signed-in owner's browsers.

Served by the bridge rather than by the vendored daemon so the surface is
identical on macOS, Linux and Windows, and so it can be reasoned about in one
place. Design rules, in order of importance:

1. **Containment.** Every path is expanded, `realpath`-resolved (so symlinks
   cannot escape) and checked against the allowed roots. Default root is the
   user's home directory; `~/.forge/config.json` may add more. Nothing else is
   reachable, and a path that resolves outside a root is refused even if it is
   *inside* one textually.
2. **Bounded.** Listing, reading, globbing and grepping all take limits and
   report `truncated`, so a `node_modules` or a 4 GB log cannot OOM the bridge
   or the phone.
3. **Audited.** Every mutating call writes one JSON line to `~/.forge/audit.log`.

Endpoints (all POST, JSON — see relay/PROTOCOL.md §5):

    /api/fs/list      {path, limit?}                       → entries
    /api/fs/read      {path, offset?, limit?, bytes?}      → lines of text
    /api/fs/write     {path, content, createParents?}      → bytes written
    /api/fs/edit      {path, oldText, newText, replaceAll?}→ exact-unique replace
    /api/fs/stat      {path}                               → metadata
    /api/fs/glob      {path, pattern, limit?}              → matches
    /api/fs/grep      {path, pattern, limit?, ignoreCase?} → matches (rg when present)
    /api/fs/download  {path}                               → base64 body
    /api/fs/upload    {path, contentBase64, append?}       → bytes written
    /api/fs/delete    {path}                               → removed
    /api/fs/roots     {}                                   → the allowed roots
"""

from __future__ import annotations

import base64
import fnmatch
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = os.name == "nt"

DEFAULT_LIST_LIMIT = 500
MAX_LIST_LIMIT = 5000
DEFAULT_READ_LINES = 400
MAX_READ_LINES = 5000
MAX_READ_BYTES = 2 * 1024 * 1024
MAX_WRITE_BYTES = 8 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
DEFAULT_GREP_LIMIT = 200
MAX_GREP_LIMIT = 2000
MAX_LINE_CHARS = 2000
SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".cache",
    "dist",
    "build",
    "target",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
}


class FileError(Exception):
    """A refusal we can explain to the user. `code` survives to the browser."""

    def __init__(self, message: str, code: str = "FS_ERROR", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class FileService:
    def __init__(self, roots=None, audit=None):
        self.audit = audit
        self._roots = self._resolve_roots(roots)

    # -- roots and containment --------------------------------------------
    @staticmethod
    def _resolve_roots(roots) -> list[str]:
        candidates = list(roots) if roots else [str(Path.home())]
        resolved = []
        for candidate in candidates:
            try:
                real = str(Path(os.path.expanduser(str(candidate))).resolve())
            except OSError:
                continue
            if real and real not in resolved:
                resolved.append(real)
        if not resolved:
            resolved = [str(Path.home().resolve())]
        return resolved

    @property
    def roots(self) -> list[str]:
        return list(self._roots)

    def resolve(self, raw_path: str) -> Path:
        """Expand + resolve + contain. The only way to get a Path in here."""
        text = str(raw_path or "").strip()
        if not text:
            raise FileError("path is required", "FS_PATH_REQUIRED")
        if "\x00" in text:
            raise FileError("path contains a NUL byte", "FS_PATH_INVALID")
        expanded = Path(os.path.expanduser(text))
        if not expanded.is_absolute():
            expanded = Path(self._roots[0]) / expanded
        try:
            real = expanded.resolve()
        except OSError as error:
            raise FileError("cannot resolve %s: %s" % (text, error), "FS_PATH_INVALID")
        real_str = str(real)
        for root in self._roots:
            if real_str == root or real_str.startswith(root + os.sep) or (
                IS_WINDOWS and real_str.lower().startswith(root.lower() + os.sep)
            ):
                return real
        raise FileError(
            "%s is outside the allowed roots (%s)" % (real_str, ", ".join(self._roots)),
            "FS_OUTSIDE_ROOT",
            403,
        )

    def _log(self, action: str, path, **fields) -> None:
        if self.audit is None:
            return
        try:
            self.audit.write(action, path=str(path), **fields)
        except Exception:
            pass

    # -- read-only ---------------------------------------------------------
    def roots_info(self) -> dict:
        home = str(Path.home().resolve())
        return {
            "roots": [
                {
                    "path": root,
                    "name": "Home" if root == home else Path(root).name or root,
                    "home": root == home,
                }
                for root in self._roots
            ],
            "home": home,
            "platform": sys.platform,
            "separator": os.sep,
        }

    def stat(self, raw_path: str) -> dict:
        path = self.resolve(raw_path)
        if not path.exists():
            raise FileError("%s does not exist" % path, "FS_NOT_FOUND", 404)
        info = path.stat()
        return {
            "path": str(path),
            "name": path.name or str(path),
            "type": _kind(path),
            "size": info.st_size,
            "mtime": info.st_mtime,
            "mode": _mode_text(info.st_mode),
            "readable": os.access(path, os.R_OK),
            "writable": os.access(path, os.W_OK),
            "root": _root_of(str(path), self._roots),
        }

    def list(self, raw_path: str, limit: int = DEFAULT_LIST_LIMIT) -> dict:
        path = self.resolve(raw_path)
        if not path.exists():
            raise FileError("%s does not exist" % path, "FS_NOT_FOUND", 404)
        if not path.is_dir():
            raise FileError("%s is not a directory" % path, "FS_NOT_DIR")
        limit = _bounded(limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT)

        entries = []
        truncated = False
        try:
            with os.scandir(path) as scan:
                for item in scan:
                    if len(entries) >= limit:
                        truncated = True
                        break
                    try:
                        info = item.stat(follow_symlinks=False)
                        kind = (
                            "dir"
                            if item.is_dir(follow_symlinks=False)
                            else "link"
                            if item.is_symlink()
                            else "file"
                        )
                        entries.append(
                            {
                                "name": item.name,
                                "path": item.path,
                                "type": kind,
                                "size": info.st_size if kind != "dir" else 0,
                                "mtime": info.st_mtime,
                                "mode": _mode_text(info.st_mode),
                                "hidden": item.name.startswith("."),
                                "skipped": kind == "dir" and item.name in SKIP_DIRS,
                            }
                        )
                    except OSError:
                        entries.append(
                            {
                                "name": item.name,
                                "path": item.path,
                                "type": "unknown",
                                "size": 0,
                                "mtime": 0,
                                "mode": "",
                                "hidden": item.name.startswith("."),
                                "unreadable": True,
                            }
                        )
        except PermissionError:
            raise FileError("permission denied: %s" % path, "FS_PERMISSION", 403)
        except OSError as error:
            raise FileError("cannot list %s: %s" % (path, error), "FS_LIST_FAILED")

        entries.sort(key=lambda entry: (entry["type"] != "dir", entry["name"].lower()))
        self._log("fs.list", path, entries=len(entries))
        return {
            "path": str(path),
            "name": path.name or str(path),
            "parent": str(path.parent) if str(path.parent) != str(path) else None,
            "entries": entries,
            "truncated": truncated,
            "root": _root_of(str(path), self._roots),
        }

    def read(
        self,
        raw_path: str,
        offset: int = 0,
        limit: int = DEFAULT_READ_LINES,
        max_bytes: int = MAX_READ_BYTES,
    ) -> dict:
        path = self.resolve(raw_path)
        if not path.exists():
            raise FileError("%s does not exist" % path, "FS_NOT_FOUND", 404)
        if path.is_dir():
            raise FileError("%s is a directory" % path, "FS_IS_DIR")
        size = path.stat().st_size
        limit = _bounded(limit, 1, MAX_READ_LINES, DEFAULT_READ_LINES)
        offset = max(0, int(offset or 0))
        max_bytes = _bounded(max_bytes, 1024, MAX_READ_BYTES, MAX_READ_BYTES)
        if size > MAX_DOWNLOAD_BYTES:
            raise FileError(
                "%s is %.1f MB; refusing to read files over %d MB"
                % (path.name, size / 1e6, MAX_DOWNLOAD_BYTES // (1024 * 1024)),
                "FS_TOO_LARGE",
                413,
            )

        raw = path.read_bytes()
        encoding, decoded, binary = _decode(raw)
        if binary:
            self._log("fs.read", path, bytes=size, encoding="binary")
            return {
                "path": str(path),
                "encoding": "binary",
                "size": size,
                "content": "",
                "lines": [],
                "totalLines": 0,
                "offset": 0,
                "truncated": False,
                "previewBase64": base64.b64encode(raw[:4096]).decode("ascii"),
            }

        all_lines = decoded.splitlines()
        total = len(all_lines)
        window = all_lines[offset : offset + limit]
        content = "\n".join(window)
        truncated_bytes = len(content.encode("utf-8")) > max_bytes
        if truncated_bytes:
            while window and len("\n".join(window).encode("utf-8")) > max_bytes:
                window.pop()
            content = "\n".join(window)
        self._log("fs.read", path, bytes=size, lines=len(window), offset=offset)
        return {
            "path": str(path),
            "encoding": encoding,
            "size": size,
            "content": content,
            "lines": [
                {"number": offset + index + 1, "text": _clip(line)}
                for index, line in enumerate(window)
            ],
            "totalLines": total,
            "offset": offset,
            "count": len(window),
            "truncated": bool(truncated_bytes) or (offset + len(window) < total),
            "nextOffset": offset + len(window) if offset + len(window) < total else None,
            "eol": "\r\n" if "\r\n" in decoded[:4096] else "\n",
        }

    def glob(self, raw_path: str, pattern: str, limit: int = DEFAULT_LIST_LIMIT) -> dict:
        root = self.resolve(raw_path)
        if not root.is_dir():
            raise FileError("%s is not a directory" % root, "FS_NOT_DIR")
        pattern = str(pattern or "").strip()
        if not pattern:
            raise FileError("pattern is required", "FS_PATTERN_REQUIRED")
        limit = _bounded(limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT)
        matches, truncated = [], False
        regex = re.compile(_glob_to_regex(pattern), re.IGNORECASE if IS_WINDOWS else 0)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
            for name in filenames + dirnames:
                relative = os.path.relpath(os.path.join(dirpath, name), root)
                if regex.search(relative.replace(os.sep, "/")) or fnmatch.fnmatch(
                    name, pattern
                ):
                    matches.append(os.path.join(dirpath, name))
                    if len(matches) >= limit:
                        truncated = True
                        break
            if truncated:
                break
        self._log("fs.glob", root, pattern=pattern, matches=len(matches))
        return {"path": str(root), "pattern": pattern, "matches": matches, "truncated": truncated}

    def grep(
        self,
        raw_path: str,
        pattern: str,
        limit: int = DEFAULT_GREP_LIMIT,
        ignore_case: bool = False,
    ) -> dict:
        root = self.resolve(raw_path)
        pattern = str(pattern or "")
        if not pattern:
            raise FileError("pattern is required", "FS_PATTERN_REQUIRED")
        limit = _bounded(limit, 1, MAX_GREP_LIMIT, DEFAULT_GREP_LIMIT)
        matches = _ripgrep(root, pattern, limit, ignore_case)
        engine = "rg"
        if matches is None:
            engine = "python"
            matches = _python_grep(root, pattern, limit, ignore_case)
        self._log("fs.grep", root, pattern=pattern, matches=len(matches), engine=engine)
        return {
            "path": str(root),
            "pattern": pattern,
            "matches": matches[:limit],
            "truncated": len(matches) >= limit,
            "engine": engine,
        }

    # -- mutating ----------------------------------------------------------
    def write(self, raw_path: str, content: str, create_parents: bool = True) -> dict:
        path = self.resolve(raw_path)
        if path.is_dir():
            raise FileError("%s is a directory" % path, "FS_IS_DIR")
        data = (content or "").encode("utf-8")
        if len(data) > MAX_WRITE_BYTES:
            raise FileError("content is too large", "FS_TOO_LARGE", 413)
        if create_parents:
            path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.stat().st_size if path.exists() else 0
        _atomic_write(path, data)
        self._log("fs.write", path, bytes=len(data), previousBytes=existing)
        return {"path": str(path), "bytes": len(data), "previousBytes": existing}

    def edit(
        self, raw_path: str, old_text: str, new_text: str, replace_all: bool = False
    ) -> dict:
        """Exact-string replacement, CRLF-aware, refusing ambiguity.

        Copied from how agents edit files reliably: the match must be *unique*
        unless replace_all is set, otherwise we would silently rewrite the wrong
        occurrence. A file with CRLF endings is matched with LF needles and
        written back with CRLF preserved.
        """
        path = self.resolve(raw_path)
        if not path.exists():
            raise FileError("%s does not exist" % path, "FS_NOT_FOUND", 404)
        if path.is_dir():
            raise FileError("%s is a directory" % path, "FS_IS_DIR")
        old_text = str(old_text or "")
        new_text = str(new_text or "")
        if not old_text:
            raise FileError("oldText is required", "FS_EDIT_REQUIRED")
        if old_text == new_text:
            raise FileError("oldText and newText are identical", "FS_EDIT_NOOP")

        raw = path.read_bytes()
        encoding, text, binary = _decode(raw)
        if binary:
            raise FileError("%s is binary; use upload instead" % path.name, "FS_BINARY")
        crlf = "\r\n" in text
        working = text.replace("\r\n", "\n") if crlf else text
        needle = old_text.replace("\r\n", "\n")
        replacement = new_text.replace("\r\n", "\n")
        found = working.count(needle)
        if found == 0:
            raise FileError("oldText was not found in %s" % path.name, "FS_EDIT_NOT_FOUND", 404)
        if found > 1 and not replace_all:
            raise FileError(
                "oldText matches %d places in %s; make it unique or set replaceAll"
                % (found, path.name),
                "FS_EDIT_AMBIGUOUS",
                409,
            )
        updated = working.replace(needle, replacement) if replace_all else working.replace(
            needle, replacement, 1
        )
        if crlf:
            updated = updated.replace("\n", "\r\n")
        payload = updated.encode("utf-8" if encoding in ("utf-8", "ascii") else encoding, "replace")
        _atomic_write(path, payload)
        replacements = found if replace_all else 1
        self._log("fs.edit", path, bytes=len(payload), replacements=replacements)
        return {"path": str(path), "replacements": replacements, "bytes": len(payload)}

    def upload(self, raw_path: str, content_base64: str, append: bool = False) -> dict:
        path = self.resolve(raw_path)
        if path.is_dir():
            raise FileError("%s is a directory" % path, "FS_IS_DIR")
        try:
            data = base64.b64decode(str(content_base64 or ""), validate=True)
        except Exception:
            raise FileError("contentBase64 is not valid base64", "FS_BAD_BASE64")
        if len(data) > MAX_WRITE_BYTES:
            raise FileError("upload is too large", "FS_TOO_LARGE", 413)
        path.parent.mkdir(parents=True, exist_ok=True)
        if append and path.exists():
            with path.open("ab") as handle:
                handle.write(data)
        else:
            _atomic_write(path, data)
        self._log("fs.upload", path, bytes=len(data), append=append)
        return {"path": str(path), "bytes": len(data), "appended": bool(append)}

    def download(self, raw_path: str) -> dict:
        path = self.resolve(raw_path)
        if not path.exists():
            raise FileError("%s does not exist" % path, "FS_NOT_FOUND", 404)
        if path.is_dir():
            raise FileError("%s is a directory" % path, "FS_IS_DIR")
        size = path.stat().st_size
        if size > MAX_DOWNLOAD_BYTES:
            raise FileError("file is too large to download", "FS_TOO_LARGE", 413)
        data = path.read_bytes()
        self._log("fs.download", path, bytes=size)
        return {
            "path": str(path),
            "name": path.name,
            "size": size,
            "contentBase64": base64.b64encode(data).decode("ascii"),
        }

    def delete(self, raw_path: str) -> dict:
        path = self.resolve(raw_path)
        if str(path) in self._roots:
            raise FileError("refusing to delete a root directory", "FS_FORBIDDEN", 403)
        if not path.exists():
            raise FileError("%s does not exist" % path, "FS_NOT_FOUND", 404)
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        self._log("fs.delete", path)
        return {"path": str(path), "deleted": True}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _bounded(value, low: int, high: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _kind(path: Path) -> str:
    if path.is_symlink():
        return "link"
    if path.is_dir():
        return "dir"
    return "file"


def _mode_text(mode: int) -> str:
    if IS_WINDOWS:
        return ""
    return oct(mode & 0o7777)[2:].rjust(4, "0")


def _root_of(path: str, roots: list[str]) -> str:
    for root in roots:
        if path == root or path.startswith(root + os.sep):
            return root
    return roots[0] if roots else ""


def _decode(raw: bytes):
    """Return (encoding, text, is_binary). UTF-8 first, then latin-1."""
    if b"\x00" in raw[:8192]:
        return "binary", "", True
    try:
        return "utf-8", raw.decode("utf-8"), False
    except UnicodeDecodeError:
        pass
    try:
        return "utf-16", raw.decode("utf-16"), False
    except UnicodeDecodeError:
        pass
    return "latin-1", raw.decode("latin-1", "replace"), False


def _clip(line: str) -> str:
    return line if len(line) <= MAX_LINE_CHARS else line[:MAX_LINE_CHARS] + "…"


def _atomic_write(path: Path, data: bytes) -> None:
    """Write via a temp file in the same directory, then rename."""
    tmp = path.with_name(path.name + ".forge-tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _glob_to_regex(pattern: str) -> str:
    """`src/**.ts` and `**/*.ts` style patterns → a regex over relative paths."""
    out = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if pattern.startswith("**", index):
                out.append(".*")
                index += 2
                if pattern[index : index + 1] == "/":
                    index += 1
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        elif char == ".":
            out.append(r"\.")
        else:
            out.append(re.escape(char))
        index += 1
    return "(%s)$" % "".join(out)


def _ripgrep(root: Path, pattern: str, limit: int, ignore_case: bool):
    rg = shutil.which("rg")
    if not rg:
        return None
    command = [rg, "--line-number", "--no-heading", "--color", "never", "--max-count", "3"]
    if ignore_case:
        command.append("--ignore-case")
    for skip in ("node_modules", ".git", "dist", "build", ".next"):
        command += ["--glob", "!%s" % skip]
    command += ["--max-filesize", "2M", "--", pattern, str(root)]
    try:
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=25, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode not in (0, 1):
        return None
    matches = []
    for line in done.stdout.splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        matches.append(
            {"path": parts[0], "line": _int_or_zero(parts[1]), "text": _clip(parts[2])}
        )
        if len(matches) >= limit:
            break
    return matches


def _python_grep(root: Path, pattern: str, limit: int, ignore_case: bool) -> list[dict]:
    try:
        regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error:
        regex = re.compile(re.escape(pattern), re.IGNORECASE if ignore_case else 0)
    matches = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        for name in filenames:
            full = Path(dirpath) / name
            try:
                if full.stat().st_size > 2 * 1024 * 1024:
                    continue
                text = full.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    matches.append({"path": str(full), "line": number, "text": _clip(line.strip())})
                    if len(matches) >= limit:
                        return matches
                    break
    return matches


def _int_or_zero(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0

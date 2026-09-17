"""Resolve coding CLIs, pick real headless flags, and parse NDJSON streams.

Agent Remote's job manager calls CreateProcess on argv[0]. On Windows the
Claude/Codex npm shims are *.cmd files, and a detached daemon often lacks
%APPDATA%\\npm on PATH — both produce WinError 2. This helper is overlaid
onto the cloned daemon at install time.

Prompt is always on argv. jobs.py closes stdin (DEVNULL), so we never wait
on a pipe.
"""

from __future__ import print_function

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000

_NODE_SCRIPTS = {
    "claude": [
        ("@anthropic-ai/claude-code", "cli.js"),
        ("@anthropic-ai/claude-code", "bin/claude.js"),
    ],
    "codex": [
        ("@openai/codex", "bin/codex.js"),
        ("@openai/codex", "codex.js"),
    ],
}

_FLAGS_CACHE = {}

_FLAVOR_DEFAULTS = {
    "agy": {
        "print_flag": "--print",
        "output_format": True,
        "force": False,
        "skip_permissions": False,
        "stream_partial": False,
        "resume": False,
        "session": False,
    },
    "cursor": {
        "print_flag": "--print",
        "output_format": True,
        "force": True,
        "skip_permissions": False,
        "stream_partial": False,
        "resume": True,
        "session": False,
    },
    "claude": {
        "print_flag": "-p",
        "output_format": True,
        "force": False,
        "skip_permissions": True,
        "stream_partial": False,
        "resume": True,
        "session": False,
    },
}

_SESSION_KEYS = (
    "session_id",
    "sessionId",
    "sessionID",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
)


def _home():
    return Path.home()


def _appdata():
    return Path(os.environ.get("APPDATA") or (_home() / "AppData/Roaming"))


def _localappdata():
    return Path(os.environ.get("LOCALAPPDATA") or (_home() / "AppData/Local"))


def cli_dirs():
    home = _home()
    dirs = [
        _appdata() / "npm",
        _localappdata() / "agy" / "bin",
        _localappdata() / "Programs" / "cursor",
        home / ".local" / "bin",
        home / ".cursor" / "bin",
        home / ".antigravity" / "bin",
        Path(r"C:\Program Files\nodejs"),
        Path(r"C:\Program Files (x86)\nodejs"),
        Path("/usr/local/bin"),
        Path("/opt/homebrew/bin"),
    ]
    return [path for path in dirs if path.is_dir()]


def cli_path():
    return os.pathsep.join(str(path) for path in cli_dirs())


def _which(name, env=None):
    path = None
    if env is not None:
        path = env.get("PATH")
    found = shutil.which(name, path=path)
    if found:
        return found
    if os.name == "nt":
        for suffix in (".cmd", ".exe", ".bat"):
            found = shutil.which(name + suffix, path=path)
            if found:
                return found
        try:
            output = subprocess.check_output(
                ["where", name],
                env=env,
                text=True,
                errors="ignore",
                timeout=10,
            )
            line = output.strip().splitlines()[0].strip() if output.strip() else ""
            if line and os.path.isfile(line):
                return line
        except Exception:
            pass
    return ""


def refresh_cli_bins(config):
    if config is None:
        return
    mapping = (
        ("agy_bin", ("agy", "antigravity")),
        ("claude_bin", ("claude",)),
        ("cursor_bin", ("agent", "cursor-agent")),
        ("codex_bin", ("codex",)),
        ("grok_bin", ("grok",)),
    )
    for attr, aliases in mapping:
        current = str(getattr(config, attr, "") or "")
        if current and os.path.isfile(current):
            continue
        for alias in aliases:
            found = resolve_bin(alias)
            if found:
                try:
                    setattr(config, attr, found)
                except Exception:
                    pass
                break


def resolve_bin(name, env=None):
    raw = str(name or "").strip().strip('"')
    if not raw:
        return ""
    if os.path.isfile(raw):
        return raw
    found = _which(raw, env)
    if found:
        return found
    base = Path(raw).name
    stem = Path(base).stem
    aliases = {
        "claude": ["claude"],
        "codex": ["codex"],
        "agent": ["agent", "cursor-agent"],
        "cursor-agent": ["agent", "cursor-agent"],
        "cursor": ["agent", "cursor-agent"],
        "agy": ["agy", "antigravity"],
        "antigravity": ["agy", "antigravity"],
        "node": ["node"],
    }.get(stem.lower(), [stem])
    for alias in aliases:
        found = _which(alias, env)
        if found:
            return found
        for folder in cli_dirs():
            for candidate in (
                folder / alias,
                folder / (alias + ".cmd"),
                folder / (alias + ".exe"),
                folder / (alias + ".bat"),
            ):
                if candidate.is_file():
                    return str(candidate)
    return ""


def _node_script(head, resolved):
    stem = Path(str(head)).stem.lower()
    packages = _NODE_SCRIPTS.get(stem) or _NODE_SCRIPTS.get(Path(str(resolved or "")).stem.lower())
    if not packages:
        return ""
    roots = []
    if resolved:
        roots.append(Path(resolved).resolve().parent)
    roots.append(_appdata() / "npm")
    roots.append(_appdata() / "npm" / "node_modules")
    for root in roots:
        for package, rel in packages:
            direct = root / "node_modules" / package / rel
            nested = root / package / rel
            for candidate in (direct, nested):
                if candidate.is_file():
                    return str(candidate)
    return ""


def rewrite_command(cmd, env):
    cmd = [str(part) for part in cmd]
    if not cmd:
        return cmd
    resolved = resolve_bin(cmd[0], env) or cmd[0]
    script = _node_script(cmd[0], resolved)
    if script:
        node = resolve_bin("node", env)
        if node:
            return [node, script] + cmd[1:]
    return [resolved] + cmd[1:]


def prepare_popen(cmd, popen_kw):
    popen_kw = dict(popen_kw or {})
    env = dict(os.environ)
    if popen_kw.get("env"):
        env.update(popen_kw["env"])
    extra = cli_path()
    if extra:
        env["PATH"] = extra + os.pathsep + env.get("PATH", "")
    popen_kw["env"] = env
    cmd = rewrite_command(cmd, env)
    if os.name == "nt":
        popen_kw.pop("start_new_session", None)
        popen_kw["creationflags"] = int(popen_kw.get("creationflags") or 0) | CREATE_NEW_PROCESS_GROUP
        head = str(cmd[0]).lower()
        if head.endswith(".cmd") or head.endswith(".bat"):
            comspec = env.get("COMSPEC") or r"C:\Windows\System32\cmd.exe"
            cmd = [comspec, "/d", "/s", "/c", subprocess.list2cmdline(cmd)]
    return cmd, popen_kw


def _help_text(path):
    if not path:
        return ""
    kwargs = {
        "args": [path, "--help"],
        "timeout": 6,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "stdin": subprocess.DEVNULL,
        "text": True,
        "errors": "replace",
    }
    if os.name == "nt":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    try:
        proc = subprocess.run(**kwargs)
        return (proc.stdout or "") + "\n" + (proc.stderr or "")
    except Exception:
        return ""


def detect_cli_flags(exec_path):
    key = str(exec_path or "")
    cached = _FLAGS_CACHE.get(key)
    if cached is not None:
        return cached
    help_text = _help_text(key)
    lower = help_text.lower()
    print_flag = None
    if "--print" in lower:
        print_flag = "--print"
    elif re.search(r"(?:^|\s)-p(?:\s|,|$)", lower):
        print_flag = "-p"
    flags = {
        "help": bool(help_text.strip()),
        "print_flag": print_flag,
        "output_format": "--output-format" in lower,
        "stream_json": "stream-json" in lower,
        "stream_partial": "--stream-partial-output" in lower,
        "force": "--force" in lower,
        "skip_permissions": "--dangerously-skip-permissions" in lower,
        "yes": bool(re.search(r"--yes\b", lower)),
        "resume": "--resume" in lower,
        "session": "--session" in lower,
        "headless": "--headless" in lower,
        "permission_mode": "--permission-mode" in lower,
    }
    _FLAGS_CACHE[key] = flags
    return flags


def _flavor_key(flavor):
    name = str(flavor or "generic").lower()
    if name in ("antigravity", "agy"):
        return "agy"
    if name in ("cursor", "agent", "cursor-agent"):
        return "cursor"
    if name == "claude":
        return "claude"
    return name


def _use_flag(flags, name, flavor):
    if flags.get("help"):
        return flags.get(name)
    defaults = _FLAVOR_DEFAULTS.get(flavor) or {}
    return flags.get(name) or defaults.get(name)


def build_headless_cmd(binary, prompt, session_id="", permission_mode="", flavor="generic"):
    """Build argv for a non-interactive turn. Prompt is always last."""
    flavor = _flavor_key(flavor)
    flags = detect_cli_flags(binary)
    defaults = _FLAVOR_DEFAULTS.get(flavor) or {}
    cmd = [binary]

    print_flag = flags.get("print_flag")
    if not print_flag and not flags.get("help"):
        print_flag = defaults.get("print_flag")
    if print_flag:
        cmd.append(print_flag)
    elif _use_flag(flags, "headless", flavor):
        cmd.append("--headless")

    if _use_flag(flags, "output_format", flavor) or _use_flag(flags, "stream_json", flavor):
        cmd.extend(["--output-format", "stream-json"])
    if _use_flag(flags, "stream_partial", flavor):
        cmd.append("--stream-partial-output")

    mode = permission_mode or ""
    auto = mode in ("bypassPermissions", "acceptEdits", "")
    if auto and _use_flag(flags, "skip_permissions", flavor):
        cmd.append("--dangerously-skip-permissions")
    elif auto and _use_flag(flags, "yes", flavor):
        cmd.append("--yes")
    elif flags.get("help") and flags.get("permission_mode") and mode:
        cmd.extend(["--permission-mode", mode])

    if _use_flag(flags, "force", flavor) and "--force" not in cmd:
        cmd.append("--force")

    sid = str(session_id or "").strip()
    if sid:
        if _use_flag(flags, "resume", flavor):
            cmd.extend(["--resume", sid])
        elif _use_flag(flags, "session", flavor):
            cmd.extend(["--session", sid])

    cmd.append(prompt)
    return cmd


def _clip(value, limit=400):
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    keep = max(12, (limit - 1) // 2)
    return text[:keep] + "…" + text[-keep:]


def _session_id(obj):
    if not isinstance(obj, dict):
        return ""
    for key in _SESSION_KEYS:
        value = obj.get(key)
        if value:
            return str(value)
    nested = obj.get("result")
    if isinstance(nested, dict):
        return _session_id(nested)
    return ""


def _remember_session(job, session_id):
    if not session_id:
        return
    lock = getattr(job, "lock", None)
    if lock is not None:
        with lock:
            job.new_session_id = session_id
    else:
        job.new_session_id = session_id


def _assistant_text(obj):
    if not isinstance(obj, dict):
        return ""
    for key in ("text", "delta", "content"):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    message = obj.get("message") if isinstance(obj.get("message"), dict) else obj
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                parts.append(str(block["text"]))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    part = obj.get("part")
    if isinstance(part, dict) and isinstance(part.get("text"), str):
        return part["text"]
    return ""


def _tool_blocks(obj):
    blocks = []
    message = obj.get("message") if isinstance(obj.get("message"), dict) else obj
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("tool_use", "tool_call", "function_call"):
                blocks.append(block)
    return blocks


def _emit_text(job, text):
    if not text:
        return
    job.add_event("text", text=text)
    if hasattr(job, "set_phase"):
        job.set_phase("writing", text[-160:])
    state = getattr(job, "runner_state", None)
    if isinstance(state, dict):
        state["streamed_text"] = True


def _emit_tool(job, name, detail=""):
    job.add_event("tool", name=str(name or "tool"), detail=_clip(detail))
    if hasattr(job, "set_phase"):
        job.set_phase("tool", str(name or "tool"))


def handle_stream_line(job, line):
    text = (line or "").strip()
    if not text:
        return
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        _emit_text(job, text)
        return
    if not isinstance(obj, dict):
        return

    session_id = _session_id(obj)
    if session_id:
        _remember_session(job, session_id)

    kind = str(obj.get("type") or obj.get("event") or "")
    subtype = str(obj.get("subtype") or "")

    if kind == "init" or (kind == "system" and subtype == "init"):
        init = obj.get("init") if isinstance(obj.get("init"), dict) else obj
        model = ""
        if isinstance(init, dict):
            model = str(init.get("model") or obj.get("model") or "")
        job.add_event("init", session_id=session_id, model=model)
        return

    if kind in ("assistant", "message", "text", "content", "text_delta"):
        streamed = bool((getattr(job, "runner_state", None) or {}).get("streamed_text"))
        partial = obj.get("timestamp_ms") is not None or kind == "text_delta"
        extracted = _assistant_text(obj)
        if extracted and (partial or not streamed):
            _emit_text(job, extracted)
        for block in _tool_blocks(obj):
            name = block.get("name") or block.get("tool") or "tool"
            detail = block.get("input") or block.get("arguments") or block.get("args") or ""
            _emit_tool(job, name, detail)
        return

    if kind in ("tool", "tool_use", "tool_call", "tool_start", "function_call"):
        nested = obj.get("tool_call") if isinstance(obj.get("tool_call"), dict) else {}
        started = nested.get("started") if isinstance(nested.get("started"), dict) else obj
        completed = nested.get("completed") if isinstance(nested.get("completed"), dict) else None
        if subtype == "completed" or completed:
            return
        name = (
            started.get("name")
            or started.get("tool")
            or started.get("tool_name")
            or obj.get("name")
            or obj.get("tool")
            or "tool"
        )
        detail = (
            started.get("args")
            or started.get("arguments")
            or started.get("input")
            or obj.get("input")
            or obj.get("args")
            or obj.get("detail")
            or ""
        )
        _emit_tool(job, name, detail)
        return

    if kind == "step_update":
        step = obj.get("step_update") if isinstance(obj.get("step_update"), dict) else obj
        delta = step.get("text_delta")
        if isinstance(delta, str) and delta:
            _emit_text(job, delta)
        if str(step.get("step_type") or "") == "tool":
            info = step.get("tool_info") if isinstance(step.get("tool_info"), dict) else {}
            name = str(step.get("tool_name") or info.get("name") or "tool")
            detail = info.get("parameters") or info.get("output") or ""
            _emit_tool(job, name, detail)
        return

    if kind in ("item.completed", "item_completed"):
        item = obj.get("item") if isinstance(obj.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
        if item_type in ("message", "agent_message"):
            extracted = _assistant_text(item) or _assistant_text(obj)
            if extracted:
                _emit_text(job, extracted)
        elif item_type in ("tool_call", "function_call", "command_execution"):
            _emit_tool(job, item.get("name") or item.get("command") or "tool", item.get("arguments") or item.get("command") or "")
        return

    if kind in ("error", "turn.failed") or obj.get("is_error"):
        message = obj.get("error") or obj.get("message") or obj.get("result") or text
        job.add_event("error", text=str(message)[:2000])
        return

    if kind in ("result", "done", "turn.completed", "step_finish"):
        result = obj.get("result")
        extracted = ""
        if isinstance(result, dict):
            extracted = result.get("response") or result.get("text") or ""
            error = result.get("error")
            if result.get("status") == "ERROR" and error:
                job.add_event("error", text=str(error)[:2000])
                return
            sid = _session_id(result)
            if sid:
                _remember_session(job, sid)
        elif isinstance(result, str):
            extracted = result
        if not extracted:
            extracted = _assistant_text(obj)
        streamed = bool((getattr(job, "runner_state", None) or {}).get("streamed_text"))
        if extracted and not streamed:
            _emit_text(job, extracted)
        lock = getattr(job, "lock", None)
        if extracted:
            if lock is not None:
                with lock:
                    job.result_text = extracted
            else:
                job.result_text = extracted
        job.add_event("result", duration_ms=obj.get("duration_ms") or 0)
        return

    extracted = _assistant_text(obj)
    if extracted:
        _emit_text(job, extracted)


def finalize_job(job, returncode, stderr_tail):
    tail = (stderr_tail or "").strip()
    events = list(getattr(job, "events", []) or [])
    has_output = bool(getattr(job, "result_text", "")) or any(
        event.get("kind") in ("text", "result") and event.get("text") for event in events
    )
    if returncode not in (0, None) and tail and not has_output:
        job.add_event("error", text=tail[:2000])
        return False
    if has_output:
        return True
    return None

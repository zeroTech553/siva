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
    "opencode": {
        "print_flag": None,
        "output_format": False,
        "force": False,
        "skip_permissions": False,
        "stream_partial": False,
        "resume": False,
        "session": True,
    },
    "copilot": {
        "print_flag": "-p",
        "output_format": True,
        "force": False,
        "skip_permissions": False,
        "stream_partial": False,
        "resume": False,
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
        home / ".opencode" / "bin",
        _localappdata() / "opencode",
        _localappdata() / "GitHub Copilot CLI",
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
        ("opencode_bin", ("opencode",)),
        ("copilot_bin", ("copilot",)),
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
        "opencode": ["opencode"],
        "copilot": ["copilot"],
        "github": ["copilot"],
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
    if "--model" in lower:
        model_flag = "--model"
    elif re.search(r"(?:^|\s)-m(?:\s|,|$)", lower):
        model_flag = "-m"
    else:
        model_flag = ""
    flags = {
        "help": bool(help_text.strip()),
        "print_flag": print_flag,
        "model_flag": model_flag,
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
    if name in ("opencode", "open-code"):
        return "opencode"
    if name in ("copilot", "github", "gh", "github-copilot"):
        return "copilot"
    return name


def _use_flag(flags, name, flavor):
    if flags.get("help"):
        return flags.get(name)
    defaults = _FLAVOR_DEFAULTS.get(flavor) or {}
    return flags.get(name) or defaults.get(name)


# Which flag each CLI takes a model id on. Only used when `--help` did not say
# (a CLI whose help text is empty or unparseable still gets the model the
# visitor picked, rather than silently running its default).
_MODEL_FLAGS = {
    "claude": "--model",
    "cursor": "--model",
    "agy": "--model",
    "opencode": "--model",
    "copilot": "--model",
    "codex": "-m",
}


def _wanted_model(model):
    """A model id worth passing on, or '' for 'let the CLI decide'."""
    wanted = " ".join(str(model or "").split())
    if not wanted:
        return ""
    # "auto" is a real model id for some CLIs (cursor's own picker), so only the
    # words that mean "you choose" are dropped.
    if wanted.lower() in ("default", "none"):
        return ""
    return wanted[:120]


def _model_flag(flags, flavor):
    detected = str((flags or {}).get("model_flag") or "")
    if detected:
        return detected
    return _MODEL_FLAGS.get(flavor, "--model")


def _build_opencode_cmd(binary, prompt, session_id="", model="", permission_mode=""):
    cmd = [binary, "run", "--format", "json"]
    # "Plan" on the phone has to mean something here too: opencode's own plan
    # agent proposes without editing, and --auto (approve everything) is exactly
    # wrong for a read-only pass.
    if str(permission_mode or "") == "plan":
        cmd.extend(["--agent", "plan"])
    else:
        cmd.append("--auto")
    wanted = _wanted_model(model)
    if wanted:
        cmd.extend(["--model", wanted])
    sid = str(session_id or "").strip()
    if sid:
        cmd.extend(["--session", sid])
    cmd.append(prompt)
    return cmd


# How a flavor spells a permission mode the generic logic below cannot express.
# claude speaks --permission-mode; codex is rewritten by apply_codex_permission;
# cursor and copilot have their own words for "look, don't touch".
_PERMISSION_ARGV = {
    "cursor": {"plan": ["--mode", "plan"]},
    "copilot": {"plan": ["--deny-tool", "write"]},
}


def _build_copilot_cmd(binary, prompt, model="", permission_mode=""):
    # Every option first, `-p <prompt>` last. Copilot takes the prompt as the
    # value of -p, so this is the only ordering that keeps the invariant the
    # other flavors have: the prompt is the final argument, whatever the CLI
    # does with trailing positionals.
    cmd = [binary]
    wanted = _wanted_model(model)
    if wanted:
        cmd.extend(["--model", wanted])
    # A read-only pass must not allow every tool: copilot's own deny list is the
    # only brake it has, so writes go on it and --allow-all-tools stays off.
    if str(permission_mode or "") == "plan":
        cmd.extend(["--deny-tool", "write"])
    else:
        cmd.append("--allow-all-tools")
    cmd.extend(["--silent", "--output-format", "json", "-p", prompt])
    return cmd


def build_headless_cmd(binary, prompt, session_id="", permission_mode="", flavor="generic", model=""):
    """Build argv for a non-interactive turn.

    `model` is the model the visitor picked in the browser (lib/shared/cli-flags.ts
    puts the same `--model <id>` in the command it previews). Empty / "default"
    means "let the CLI choose", which is what the daemon did before this existed.
    """
    flavor = _flavor_key(flavor)
    if flavor == "opencode":
        return _build_opencode_cmd(binary, prompt, session_id, model, permission_mode)
    if flavor == "copilot":
        return _build_copilot_cmd(binary, prompt, model, permission_mode)
    flags = detect_cli_flags(binary)
    defaults = _FLAVOR_DEFAULTS.get(flavor) or {}
    cmd = [binary]

    print_flag = flags.get("print_flag")
    if not print_flag:
        # Detection found nothing, so fall back to what this flavor is known to
        # take — even when `--help` answered. Guessing a flag risks "unknown
        # option" (a loud, debuggable failure); omitting it risks launching an
        # interactive TUI inside a headless job, which hangs until the timeout.
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
    auto = mode in ("bypassPermissions", "acceptEdits", "", "default")
    translated = (_PERMISSION_ARGV.get(flavor) or {}).get(mode)
    if translated is not None:
        cmd.extend(translated)
    elif auto and _use_flag(flags, "skip_permissions", flavor):
        cmd.append("--dangerously-skip-permissions")
    elif auto and _use_flag(flags, "yes", flavor):
        cmd.append("--yes")
    elif flags.get("help") and flags.get("permission_mode") and mode:
        cmd.extend(["--permission-mode", mode])

    # A read-only pass never skips the safety check, whatever the CLI offers.
    if _use_flag(flags, "force", flavor) and "--force" not in cmd and mode != "plan":
        cmd.append("--force")

    wanted = _wanted_model(model)
    if wanted:
        model_flag = _model_flag(flags, flavor)
        if model_flag and model_flag not in cmd:
            cmd.extend([model_flag, wanted])

    sid = str(session_id or "").strip()
    if sid:
        if _use_flag(flags, "resume", flavor):
            cmd.extend(["--resume", sid])
        elif _use_flag(flags, "session", flavor):
            cmd.extend(["--session", sid])

    cmd.append(prompt)
    return cmd


# ---------------------------------------------------------------------------
# codex: making the phone's permission choice real
# ---------------------------------------------------------------------------
# `codex exec` speaks sandbox/approval, not claude's permission_mode, and the
# upstream daemon's codex provider takes both from its own config.json — so the
# mode the visitor picked in the browser used to be dropped on the floor and
# every codex job ran with full access. bridge/overlay/codex_mode.py calls
# these two functions to rewrite the argv the upstream provider built.

_CODEX_SANDBOX_ARGV = {
    # Read-only investigation: nothing on disk may change.
    "plan": ["-s", "read-only", "-a", "never"],
    # Edits inside the project, no prompting (a headless codex cannot ask a phone).
    "acceptEdits": ["-s", "workspace-write", "-a", "never"],
    # The upstream default: no sandbox, no approvals. Disposable machines only.
    "bypassPermissions": ["--dangerously-bypass-approvals-and-sandbox"],
    # "Ask each time" cannot be honoured by `codex exec` — there is no TTY to
    # ask on — so it gets the same box as acceptEdits rather than full access.
    # "default" is what the browser sends for that choice (see
    # lib/shared/daemon.ts::wirePermissionMode).
    "": ["-s", "workspace-write", "-a", "never"],
    "default": ["-s", "workspace-write", "-a", "never"],
}

_CODEX_VALUE_FLAGS = ("-s", "--sandbox", "-a", "--ask-for-approval")
_CODEX_BOOL_FLAGS = (
    "--dangerously-bypass-approvals-and-sandbox",
    "--full-auto",
    "--yolo",
)


def codex_sandbox_argv(mode):
    """The codex flags that correspond to a permission_mode from the browser."""
    return list(_CODEX_SANDBOX_ARGV.get(str(mode or ""), _CODEX_SANDBOX_ARGV[""]))


def apply_codex_permission(cmd, mode):
    """Rewrite an upstream `codex exec` argv so the picked mode wins.

    Whatever sandbox/approval the daemon's config asked for is dropped and
    replaced, in the same position (right after `exec`), so the prompt stays the
    last argument and `-C <cwd>` keeps its place.
    """
    out = []
    skip_next = False
    for piece in list(cmd or []):
        token = str(piece)
        if skip_next:
            skip_next = False
            continue
        if token in _CODEX_VALUE_FLAGS:
            skip_next = True
            continue
        if token.startswith(_CODEX_VALUE_FLAGS) and "=" in token:
            continue
        if token in _CODEX_BOOL_FLAGS:
            continue
        out.append(token)

    replacement = codex_sandbox_argv(mode)
    if not replacement:
        return out
    try:
        at = out.index("exec") + 1
    except ValueError:
        at = 1 if len(out) > 1 else len(out)
    return out[:at] + replacement + out[at:]


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
    part = obj.get("part") if isinstance(obj.get("part"), dict) else {}
    if not session_id:
        session_id = str(obj.get("sessionID") or part.get("sessionID") or "")
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
            or part.get("tool")
            or "tool"
        )
        state = part.get("state") if isinstance(part.get("state"), dict) else {}
        detail = (
            started.get("args")
            or started.get("arguments")
            or started.get("input")
            or obj.get("input")
            or obj.get("args")
            or obj.get("detail")
            or state.get("input")
            or state.get("output")
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

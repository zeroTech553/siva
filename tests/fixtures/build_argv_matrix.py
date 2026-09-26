#!/usr/bin/env python3
"""Build the daemon-side argv for a matrix of cases, as JSON.

Called by tests/cli-parity.test.mjs, which generates the cases from
lib/shared/cli-flags.ts and then compares what the browser previews with what
the laptop would exec.

Input  (argv[1]): [{"cli","flavor","prompt","permission_mode","model","session_id","binary"}, …]
Output (argv[2]): [{"argv":[…],"codex_argv":[…],"flags":{…}}, …] in the same order.

`codex_argv` is the upstream codex provider's argv (reconstructed from
agentremoted/providers/codex.py::prepare) after our overlay's
apply_codex_permission rewrite, because codex is not built by build_headless_cmd.
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "bridge" / "overlay"))

import cli_launch  # noqa: E402


def upstream_codex_argv(binary, prompt, model, cwd, session_id):
    """What agentremoted/providers/codex.py::prepare builds, before our overlay.

    Kept in step with the vendored source by tests/cli-parity.test.mjs, which
    reads that file and fails if the shape changes.
    """
    cmd = [binary, "exec", "--json", "--skip-git-repo-check"]
    cmd.append("--dangerously-bypass-approvals-and-sandbox")  # config default
    if model and model != "default":
        cmd += ["-m", model]
    cmd += ["-C", cwd]
    if session_id:
        cmd += ["resume", session_id]
    cmd.append(prompt)
    return cmd


def upstream_claude_argv(binary, prompt, model, mode, session_id):
    """What agentremoted/providers/claude.py::prepare builds.

    claude and codex are served by the vendored daemon, not by build_headless_cmd,
    so the parity test compares against these two shapes. Both are kept honest by
    reading the vendored source in tests/cli-parity.test.mjs.
    """
    cmd = [binary, "-p", prompt, "--output-format", "stream-json", "--verbose"]
    if mode:
        cmd += ["--permission-mode", mode]
    if session_id:
        cmd += ["--resume", session_id]
    if model and model != "default":
        cmd += ["--model", model]
    return cmd


def main():
    cases = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = []
    for case in cases:
        flavor = str(case.get("flavor") or case.get("cli") or "generic")
        binary = str(case.get("binary") or "fake-cli")
        prompt = str(case.get("prompt") or "")
        mode = str(case.get("permission_mode") or "")
        model = str(case.get("model") or "")
        session_id = str(case.get("session_id") or "")
        cwd = str(case.get("cwd") or "/tmp/project")

        argv = cli_launch.build_headless_cmd(
            binary,
            prompt,
            session_id=session_id,
            permission_mode=mode,
            flavor=flavor,
            model=model,
        )
        codex_raw = upstream_codex_argv(binary, prompt, model, cwd, session_id)
        out.append(
            {
                "argv": argv,
                "claude_argv": upstream_claude_argv(binary, prompt, model, mode, session_id),
                "codex_argv": cli_launch.apply_codex_permission(codex_raw, mode),
                "codex_raw": codex_raw,
                "codex_sandbox": cli_launch.codex_sandbox_argv(mode),
                "flags": cli_launch.detect_cli_flags(binary),
            }
        )
    Path(sys.argv[2]).write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("WROTE %d" % len(out))


if __name__ == "__main__":
    main()

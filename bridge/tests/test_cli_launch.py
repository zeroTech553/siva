"""Tests for the overlay that decides what actually exec's on the laptop.

`cli_launch.build_headless_cmd` is the daemon-side twin of the command the
browser previews (lib/shared/cli-flags.ts); `apply_codex_permission` is what
makes the phone's permission choice real for `codex exec`, which upstream takes
from its own config instead. Both are pure functions, so both are tested here
against exact argv — a wrong flag is a job that never starts, or one that starts
with more freedom than the visitor asked for.
"""

from __future__ import annotations

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "overlay"))

import cli_launch  # noqa: E402

PROMPT = "Fix the retry helper so it re-raises the timeout."


def fake_cli(help_text: str) -> str:
    """A throwaway executable whose --help prints `help_text`."""
    tmp = tempfile.mkdtemp(prefix="forge-cli-")
    path = Path(tmp) / "fake-cli"
    path.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--help" ]; then\n'
        "  cat <<'HELP'\n"
        f"{help_text}\n"
        "HELP\n"
        "  exit 0\n"
        "fi\n"
        'echo "ran with: $*"\n',
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


CLAUDE_LIKE_HELP = """
Usage: fake [options] [prompt]
  -p, --print                     print and exit
      --output-format <format>    text | json | stream-json
      --stream-partial-output     stream partials
      --model <model>             model to use
      --permission-mode <mode>    permission mode
      --dangerously-skip-permissions
      --resume <id>               resume a session
      --force                     force
"""

NO_FLAGS_HELP = "a cli with a help text that lists nothing useful"


class BuildHeadlessCmdTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rich = fake_cli(CLAUDE_LIKE_HELP)
        cls.poor = fake_cli(NO_FLAGS_HELP)

    def test_prompt_is_always_the_last_argument(self):
        for flavor in ("claude", "cursor", "agy", "opencode", "copilot"):
            for mode in ("", "acceptEdits", "plan", "bypassPermissions"):
                cmd = cli_launch.build_headless_cmd(
                    self.rich, PROMPT, permission_mode=mode, flavor=flavor, model="opus"
                )
                self.assertEqual(cmd[-1], PROMPT, f"{flavor}/{mode} must end with the prompt")

    def test_auto_modes_skip_permission_prompts_when_the_cli_advertises_it(self):
        for mode in ("", "acceptEdits", "bypassPermissions"):
            cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, permission_mode=mode, flavor="claude")
            self.assertIn("--dangerously-skip-permissions", cmd, mode)

    def test_plan_mode_never_skips_permissions(self):
        cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, permission_mode="plan", flavor="claude")
        self.assertNotIn("--dangerously-skip-permissions", cmd)
        self.assertIn("--permission-mode", cmd)
        self.assertIn("plan", cmd)

    def test_model_reaches_the_cli_for_every_flavor(self):
        cases = {
            "claude": ("--model", "opus"),
            "cursor": ("--model", "composer-1"),
            "agy": ("--model", "gemini-3"),
            "opencode": ("--model", "anthropic/claude-sonnet-4-5"),
            "copilot": ("--model", "gpt-5"),
        }
        for flavor, (flag, value) in cases.items():
            cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor=flavor, model=value)
            self.assertIn(flag, cmd, f"{flavor} must be told which model to use")
            self.assertEqual(cmd[cmd.index(flag) + 1], value, flavor)
            self.assertEqual(cmd[-1], PROMPT, f"{flavor} must still end with the prompt")

    def test_default_model_is_not_passed_on(self):
        for value in ("", "default", "DEFAULT", "none", None, "   "):
            cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="claude", model=value)
            self.assertNotIn("--model", cmd, f"{value!r} means 'let the CLI decide'")

    def test_model_survives_a_cli_whose_help_lists_no_flags(self):
        # A CLI we cannot introspect still gets the visitor's model, via the
        # per-flavor default flag, instead of silently running its own default.
        cmd = cli_launch.build_headless_cmd(self.poor, PROMPT, flavor="claude", model="haiku")
        self.assertIn("--model", cmd)
        self.assertIn("haiku", cmd)
        self.assertIn("-p", cmd, "claude's headless flag comes from the flavor defaults")

    def test_a_long_or_messy_model_id_is_clipped_not_executed_as_a_flag(self):
        cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="claude", model="  opus\n--dangerously-skip-permissions  ")
        self.assertIn("--model", cmd)
        model_value = cmd[cmd.index("--model") + 1]
        self.assertNotIn("\n", model_value)
        self.assertLessEqual(len(model_value), 120)

    def test_session_id_resumes(self):
        cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, session_id="sid-99", flavor="claude")
        self.assertIn("--resume", cmd)
        self.assertIn("sid-99", cmd)

    def test_opencode_plan_mode_is_read_only_and_not_auto_approved(self):
        plan = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="opencode", permission_mode="plan")
        self.assertIn("--agent", plan)
        self.assertIn("plan", plan)
        self.assertNotIn("--auto", plan)
        build = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="opencode", permission_mode="acceptEdits")
        self.assertIn("--auto", build)
        self.assertNotIn("--agent", build)

    def test_auto_is_a_model_id_not_a_synonym_for_default(self):
        cmd = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="cursor", model="auto")
        self.assertIn("--model", cmd)
        self.assertIn("auto", cmd)

    def test_opencode_and_copilot_have_their_own_shapes(self):
        opencode = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="opencode", session_id="s1", model="m1")
        self.assertEqual(opencode[1:5], ["run", "--format", "json", "--auto"])
        self.assertIn("--session", opencode)
        copilot = cli_launch.build_headless_cmd(self.rich, PROMPT, flavor="copilot")
        self.assertEqual(copilot[-2:], ["-p", PROMPT], "copilot takes the prompt as -p's value, last")
        self.assertIn("--allow-all-tools", copilot)
        self.assertIn("json", copilot)


class CodexPermissionTest(unittest.TestCase):
    """`codex exec` speaks sandbox/approval; the browser speaks permission_mode."""

    UPSTREAM = [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        "gpt-5.1",
        "-C",
        "/tmp/project",
        PROMPT,
    ]

    def test_plan_is_read_only(self):
        cmd = cli_launch.apply_codex_permission(self.UPSTREAM, "plan")
        self.assertEqual(cmd[1:5], ["exec", "-s", "read-only", "-a"])
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", cmd)

    def test_accept_edits_writes_inside_the_workspace_only(self):
        cmd = cli_launch.apply_codex_permission(self.UPSTREAM, "acceptEdits")
        self.assertIn("workspace-write", cmd)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", cmd)

    def test_ask_each_time_is_not_full_access(self):
        # A headless codex has no TTY to ask on, so "ask each time" gets the
        # workspace box rather than the upstream no-sandbox default.
        cmd = cli_launch.apply_codex_permission(self.UPSTREAM, "")
        self.assertIn("workspace-write", cmd)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", cmd)

    def test_bypass_keeps_full_access(self):
        cmd = cli_launch.apply_codex_permission(self.UPSTREAM, "bypassPermissions")
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", cmd)
        self.assertNotIn("-s", cmd)

    def test_prompt_stays_last_and_cwd_and_resume_survive(self):
        cmd = cli_launch.apply_codex_permission(
            ["codex", "exec", "--json", "-s", "read-only", "-C", "/tmp/p", "resume", "sid-1", PROMPT],
            "acceptEdits",
        )
        self.assertEqual(cmd[-1], PROMPT)
        self.assertIn("-C", cmd)
        self.assertEqual(cmd[cmd.index("-C") + 1], "/tmp/p")
        self.assertIn("resume", cmd)
        self.assertIn("sid-1", cmd)

    def test_equals_form_flags_are_replaced_too(self):
        cmd = cli_launch.apply_codex_permission(
            ["codex", "exec", "--sandbox=danger-full-access", "--ask-for-approval=never", PROMPT], "plan"
        )
        self.assertNotIn("--sandbox=danger-full-access", cmd)
        self.assertNotIn("--ask-for-approval=never", cmd)
        self.assertIn("read-only", cmd)

    def test_an_unknown_mode_falls_back_to_the_workspace_box(self):
        cmd = cli_launch.apply_codex_permission(self.UPSTREAM, "nonsense")
        self.assertIn("workspace-write", cmd)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", cmd)

    def test_argv_without_exec_is_still_rewritten(self):
        cmd = cli_launch.apply_codex_permission(["codex", PROMPT], "plan")
        self.assertEqual(cmd[-1], PROMPT)
        self.assertIn("read-only", cmd)

    def test_sandbox_argv_is_a_plain_mapping(self):
        self.assertEqual(cli_launch.codex_sandbox_argv("plan"), ["-s", "read-only", "-a", "never"])
        self.assertEqual(
            cli_launch.codex_sandbox_argv("bypassPermissions"),
            ["--dangerously-bypass-approvals-and-sandbox"],
        )


class FlavorKeyTest(unittest.TestCase):
    def test_aliases_collapse_onto_one_flavor(self):
        self.assertEqual(cli_launch._flavor_key("antigravity"), "agy")
        self.assertEqual(cli_launch._flavor_key("AGY"), "agy")
        self.assertEqual(cli_launch._flavor_key("cursor-agent"), "cursor")
        self.assertEqual(cli_launch._flavor_key("github"), "copilot")
        self.assertEqual(cli_launch._flavor_key("open-code"), "opencode")
        self.assertEqual(cli_launch._flavor_key(None), "generic")


if __name__ == "__main__":
    unittest.main()

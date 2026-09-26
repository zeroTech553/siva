"""Make `codex exec` honour the permission mode and model picked in the browser.

The upstream daemon's codex provider takes its sandbox and approval policy from
its own config.json and ignores the job's `permission_mode`, so every codex job
used to run with `--dangerously-bypass-approvals-and-sandbox` no matter what the
visitor chose (see agentremoted/providers/codex.py::prepare). Forge's UI sells
that choice — "Read only / Write in workspace / Full access" — so the argv has
to reflect it.

This is an overlay, not a fork: it subclasses the upstream runner and rewrites
the argv `prepare()` already built (cli_launch.apply_codex_permission). If
anything here fails to import, providers/forge_hook.py falls back to the
upstream codex provider and codex keeps working exactly as before.
"""

from ..cli_launch import apply_codex_permission


def build(config):
    """(store, runner) for `codex`, in the shape forge_hook.try_build returns."""
    from .codex import CodexRunner, CodexStore

    class ModeAwareCodexRunner(CodexRunner):
        def prepare(self, job, mode):
            cmd, env = super().prepare(job, mode)
            return apply_codex_permission(cmd, mode), env

    return CodexStore(config.codex_home_path, config), ModeAwareCodexRunner(config)

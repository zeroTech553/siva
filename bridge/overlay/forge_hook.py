"""Register Forge overlay providers without fragile string patches.

Called from the top of agentremoted/providers/__init__.py::build_one (the
installer inserts the call). Returning None — or raising — leaves the vendored
provider in charge, which is what makes overriding `codex` safe.
"""


def try_build(config, name):
    name = str(name or "").lower()
    if name == "codex":
        # Not a new provider: the upstream one, wrapped so the permission mode
        # and model the browser picked reach `codex exec`. A failure here (or an
        # upstream rename) falls back to the vendored provider untouched.
        try:
            from .codex_mode import build

            return build(config)
        except Exception:
            return None
    if name in ("cursor", "agent", "cursor-agent"):
        from .cursor import CursorRunner, CursorStore

        return CursorStore(config), CursorRunner(config)
    if name in ("antigravity", "agy"):
        from .antigravity import AntigravityRunner, AntigravityStore

        return AntigravityStore(config), AntigravityRunner(config)
    if name in ("opencode", "open-code"):
        from .opencode import OpenCodeRunner, OpenCodeStore

        return OpenCodeStore(config), OpenCodeRunner(config)
    if name in ("copilot", "github", "gh", "github-copilot"):
        from .copilot import CopilotRunner, CopilotStore

        return CopilotStore(config), CopilotRunner(config)
    return None

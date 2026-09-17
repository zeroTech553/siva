"""Register Forge overlay providers without fragile string patches."""


def try_build(config, name):
    name = str(name or "").lower()
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

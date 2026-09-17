"""Register Forge overlay providers without fragile string patches."""


def try_build(config, name):
    name = str(name or "").lower()
    if name in ("cursor", "agent", "cursor-agent"):
        from .cursor import CursorRunner, CursorStore

        return CursorStore(config), CursorRunner(config)
    if name in ("antigravity", "agy"):
        from .antigravity import AntigravityRunner, AntigravityStore

        return AntigravityStore(config), AntigravityRunner(config)
    return None

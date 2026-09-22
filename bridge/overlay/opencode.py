"""OpenCode CLI adapter (binary: opencode).

Headless turn:
  opencode run --format json --auto [--session ID] "prompt"
"""

from .cli_provider import GenericRunner, GenericStore


class OpenCodeStore(GenericStore):
    pass


class OpenCodeRunner(GenericRunner):
    name = "opencode"

    def __init__(self, config):
        super().__init__(config, "opencode")

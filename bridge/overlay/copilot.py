"""GitHub Copilot CLI adapter (binary: copilot).

Headless turn:
  copilot -p "prompt" --allow-all-tools --silent --output-format json
"""

from .cli_provider import GenericRunner, GenericStore


class CopilotStore(GenericStore):
    pass


class CopilotRunner(GenericRunner):
    name = "copilot"

    def __init__(self, config):
        super().__init__(config, "copilot")

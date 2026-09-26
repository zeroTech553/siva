"""Shared empty store + headless runner for extra coding CLIs."""

import os
from pathlib import Path

from . import RunnerError
from ..cli_launch import (
    build_headless_cmd,
    finalize_job,
    handle_stream_line,
    resolve_bin,
)


SPECS = {
    "opencode": {
        "aliases": ("opencode",),
        "bin_attr": "opencode_bin",
        "login": "opencode auth login",
        "label": "OpenCode",
        "missing": "OpenCode CLI not found. Install it, then run: opencode auth login",
    },
    "copilot": {
        "aliases": ("copilot",),
        "bin_attr": "copilot_bin",
        "login": "copilot login",
        "label": "GitHub Copilot",
        "missing": "GitHub Copilot CLI not found. Install `@github/copilot`, then run: copilot login",
    },
}


class GenericStore:
    def __init__(self, config):
        self.config = config
        self.titler = None

    def list_projects(self):
        return []

    def list_sessions(self, project_id=None, limit=25, user_only=True):
        return []

    def search_sessions(self, query, project_id=None, limit=25, user_only=True):
        return []

    def get_session(self, session_id):
        return None

    def get_messages(self, session_id, offset=None, limit=50):
        return None


class GenericRunner:
    def __init__(self, config, flavor):
        self.config = config
        self.name = flavor
        self.spec = SPECS[flavor]

    def _aliases(self):
        return self.spec["aliases"]

    def _bin(self):
        attr = self.spec["bin_attr"]
        return str(getattr(self.config, attr, None) or self._aliases()[0])

    def _resolve(self):
        raw = self._bin()
        found = resolve_bin(raw)
        if found:
            return found
        for alias in self._aliases():
            found = resolve_bin(alias)
            if found:
                return found
        return ""

    def capabilities(self):
        return {"turns": True}

    def auth_health(self):
        path = self._resolve()
        on_path = bool(path)
        return {
            "cli": self._aliases()[0],
            "cli_on_path": on_path,
            "mode": "subscription",
            "status": "ok" if on_path else "missing",
            "detail": path or self.spec["missing"],
        }

    def slash_commands(self):
        return []

    def title_for(self, text):
        return ""

    def prepare(self, job, mode):
        binary = self._resolve()
        if not binary:
            raise RunnerError(self.spec["missing"])
        if not job.cwd:
            job.cwd = str(Path.home())
        cmd = build_headless_cmd(
            binary,
            job.prompt,
            session_id=getattr(job, "session_id", "") or "",
            permission_mode=mode,
            flavor=self.name,
            model=getattr(job, "model", "") or "",
        )
        env = dict(os.environ)
        extra = getattr(self.config, self.name + "_env", None) or {}
        env.update({str(k): str(v) for k, v in extra.items()})
        return cmd, env

    def handle_stream_line(self, job, line):
        handle_stream_line(job, line)

    def tick(self, job):
        return None

    def finalize(self, job, returncode, stderr_tail):
        return finalize_job(job, returncode, stderr_tail)

    def cleanup(self, job):
        return None

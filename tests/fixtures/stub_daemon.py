#!/usr/bin/env python3
"""A stand-in for the laptop's agent daemon (`agentremoted`).

The browser never talks to this directly: it goes
browser -> Next.js /d/[deviceId]/... -> relay -> bridge/forge_bridge.py -> here.
That makes this the last hop of the real pipe, so it is written to the same
contract the vendored daemon serves (lib/shared/daemon.ts):

    GET  /api/ping                     provider list + auth health
    GET  /api/projects                 projects on this machine
    POST /api/sessions/new             start a job  -> {"job_id": ...}
    GET  /api/jobs/<id>?since=<seq>    JobSnapshot with the new events
    POST /api/jobs/<id>/stop           cancel a job
    POST /api/jobs/<id>/permission     answer a permission prompt
    POST /api/jobs/<id>/question       answer a question prompt

It is deliberately *not* a mock of the interesting part: jobs are launched with
bridge/overlay/cli_launch.build_headless_cmd and their output is parsed with
bridge/overlay/cli_launch.handle_stream_line, so the argv that runs and the
events that come back are produced by the same production code the real daemon
overlay uses. Only the CLI binary is fake (tests/fixtures/fake-cli).

Auth: every request must carry `X-Auth-Token: $FAKE_DAEMON_TOKEN`. The bridge
reads that token from ~/.agentremoted/token and injects it, which is how the
test proves no browser ever needs to see it.

Usage:
    FAKE_DAEMON_TOKEN=t FAKE_CLI_LOG=/tmp/argv.log python3 stub_daemon.py [port]
Prints `LISTENING <port>` on stdout once it is accepting connections.
"""

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "bridge" / "overlay"))

import cli_launch  # noqa: E402  (path set up above)

TOKEN = os.environ.get("FAKE_DAEMON_TOKEN", "")
CLI = os.environ.get("FAKE_CLI", str(HERE / "fake-cli"))
PROJECT_DIR = os.environ.get("FAKE_PROJECT_DIR", str(HERE))
REQUEST_LOG = os.environ.get("FAKE_DAEMON_LOG", "")

JOBS = {}
JOBS_LOCK = threading.Lock()


class Job:
    """The slice of the daemon's job object that cli_launch touches."""

    def __init__(self, job_id, session_id, provider, cwd, argv):
        self.id = job_id
        self.session_id = session_id
        self.new_session_id = ""
        self.provider = provider
        self.cwd = cwd
        self.argv = argv
        self.status = "running"
        self.error = ""
        self.result_text = ""
        self.events = []
        self.pending_permission = None
        self.pending_question = None
        self.runner_state = {}
        # Reentrant on purpose: cli_launch takes job.lock itself (to record a
        # session id or result_text) and then calls job.add_event, which takes
        # it again. A plain Lock deadlocks the job thread on the first event.
        self.lock = threading.RLock()
        self.proc = None
        self._seq = 0

    def add_event(self, kind, **fields):
        with self.lock:
            self._seq += 1
            event = {"seq": self._seq, "kind": str(kind)}
            event.update({k: v for k, v in fields.items() if v is not None})
            self.events.append(event)
            if kind == "result" and event.get("text"):
                self.result_text = event["text"]
            return event

    def set_phase(self, phase, detail=""):
        with self.lock:
            self.runner_state["phase"] = str(phase)
            self.runner_state["phase_detail"] = str(detail)[:160]

    def snapshot(self, since=0):
        with self.lock:
            events = [dict(event) for event in self.events if event["seq"] > int(since or 0)]
            next_seq = self.events[-1]["seq"] if self.events else int(since or 0)
            return {
                "id": self.id,
                "session_id": self.session_id,
                "new_session_id": self.new_session_id or None,
                "status": self.status,
                "error": self.error or None,
                "result_text": self.result_text or None,
                "pending_permission": self.pending_permission,
                "pending_question": self.pending_question,
                "next_seq": next_seq,
                "events": events,
                "argv": list(self.argv),
                "provider": self.provider,
                "cwd": self.cwd,
            }


def run_job(job):
    """Spawn the CLI with the overlay's argv builder and stream its output."""
    stderr_tail = ""
    returncode = None
    try:
        job.proc = subprocess.Popen(
            job.argv,
            cwd=job.cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            errors="replace",
            bufsize=1,
        )
        for line in job.proc.stdout:
            cli_launch.handle_stream_line(job, line.rstrip("\n"))
        stderr_tail = (job.proc.stderr.read() or "")[-2000:]
        returncode = job.proc.wait(timeout=30)
    except Exception as error:  # noqa: BLE001 - reported to the browser verbatim
        job.error = str(error)[:500]
        job.status = "failed"
        job.add_event("error", text=job.error)
        return

    ok = cli_launch.finalize_job(job, returncode, stderr_tail)
    with job.lock:
        if ok is False:
            job.status = "failed"
            job.error = stderr_tail.strip()[:500] or "cli exited %s" % returncode
        elif job.status == "running":
            job.status = "completed"
    job.add_event("done", text=job.result_text or "")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "fake-daemon/1.0"

    # -- plumbing ----------------------------------------------------------
    def log_message(self, *args):  # keep the test output readable
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _authed(self):
        if not TOKEN:
            return True
        return self.headers.get("X-Auth-Token", "") == TOKEN

    def _record(self, method, payload):
        if not REQUEST_LOG:
            return
        entry = {
            "at": round(time.time(), 3),
            "method": method,
            "path": self.path,
            "authed": self._authed(),
            "body": payload,
        }
        with open(REQUEST_LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    # -- routes ------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        self._record("GET", {})
        if not self._authed():
            return self._send(401, {"error": "bad daemon token"})
        path = self.path.split("?")[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(pair.split("=", 1) for pair in query.split("&") if "=" in pair)

        if path == "/api/ping":
            return self._send(
                200,
                {
                    "ok": True,
                    "host": os.environ.get("FAKE_HOST_NAME", "fake-laptop"),
                    "providers": ["claude", "codex", "cursor", "opencode", "copilot", "antigravity"],
                    "multi": True,
                    "caps": {"term": True, "files": True, "jobs": True},
                    "auth": {"cli": "claude", "cli_on_path": True, "status": "ok", "mode": "token"},
                    "provider_details": {
                        name: {"auth": {"cli": name, "cli_on_path": True, "status": "ok"}}
                        for name in ("claude", "codex", "cursor", "opencode", "copilot", "antigravity")
                    },
                },
            )
        if path == "/api/projects":
            return self._send(
                200,
                {
                    "projects": [
                        {"id": "proj-1", "cwd": PROJECT_DIR, "name": Path(PROJECT_DIR).name, "session_count": 0}
                    ],
                    "home": str(Path.home()),
                },
            )
        if path.startswith("/api/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": "no such job"})
            return self._send(200, job.snapshot(params.get("since", "0")))
        return self._send(404, {"error": "unknown path %s" % path})

    def do_POST(self):  # noqa: N802
        payload = self._body()
        self._record("POST", payload)
        if not self._authed():
            return self._send(401, {"error": "bad daemon token"})
        path = self.path.split("?")[0]

        if path == "/api/sessions/new" or path.startswith("/api/sessions/"):
            return self._start_job(payload)
        if path.startswith("/api/jobs/") and path.endswith("/stop"):
            job_id = path.split("/")[-2]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": "no such job"})
            if job.proc and job.proc.poll() is None:
                job.proc.terminate()
            with job.lock:
                job.status = "cancelled"
                job.add_event("stopped", text="cancelled by the browser")
            return self._send(200, {"ok": True, "id": job_id})
        if path.startswith("/api/jobs/") and path.endswith("/permission"):
            job_id = path.split("/")[-2]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": "no such job"})
            with job.lock:
                allowed = bool(payload.get("allow"))
                job.pending_permission = None
                job.add_event("permission", text="allowed" if allowed else "denied")
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "unknown path %s" % path})

    def _start_job(self, payload):
        prompt = str(payload.get("prompt") or "")
        if not prompt.strip():
            return self._send(400, {"error": "prompt is required"})
        provider = str(payload.get("provider") or "claude")
        permission_mode = str(payload.get("permission_mode") or "")
        model = str(payload.get("model") or "")
        cwd = str(payload.get("cwd") or PROJECT_DIR)
        session_id = str(payload.get("session_id") or "")

        # The daemon's real job object carries `model` (server.py reads it from
        # the POST body) and the provider hands it to the CLI; so does this one.
        argv = cli_launch.build_headless_cmd(
            CLI,
            prompt,
            session_id=session_id,
            permission_mode=permission_mode,
            flavor=provider,
            model=model,
        )
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id, session_id, provider, cwd, argv)
        job.model = model
        with JOBS_LOCK:
            JOBS[job_id] = job
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        return self._send(200, {"job_id": job_id, "id": job_id, "argv": argv})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    os.chmod(CLI, 0o755)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print("LISTENING %d" % server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Forge laptop bridge.

One outbound WebSocket to the relay, and three jobs behind it:

1. **PTY**   real shells (`vim`, `top`, `claude`, Ctrl-C, resize) via forge_pty
2. **files** /api/fs/* served from this machine, rooted and audited
3. **RPC**   everything else proxied to the local `agentremoted` daemon, with
             the daemon token injected so no browser ever sees it

Nothing here listens on a port. The socket is outbound only, which is what lets
a laptop behind NAT/CGNAT/hotel Wi-Fi work with no tunnels and no firewall
rules. All payloads after the handshake are AES-256-GCM ciphertext that the
relay routes but cannot read (see relay/PROTOCOL.md).

Deployment layout: the installer drops this file and its siblings flat into
~/.forge/, which is why the imports are absolute rather than package-relative.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from pathlib import Path

try:
    import websocket
except ImportError:
    raise SystemExit("websocket-client is required; run the Forge installer again")

from forge_audit import AuditLog
from forge_crypto import (
    CRYPTO_AVAILABLE,
    CryptoUnavailable,
    DeviceIdentity,
    channel_from_handshake,
    random_salt,
)
from forge_files import FileError, FileService
from forge_frames import (
    BRIDGE_VERSION,
    KIND_TERMINAL,
    MAX_PAYLOAD_BYTES,
    PROTOCOL_VERSION,
    clamp_dimension,
    length_prefix,
    new_uuid,
    pack_terminal,
    parse_text,
    text_frame,
    unpack_binary,
    uuid_to_bytes,
)
from forge_pty import (
    DEFAULT_COLS,
    DEFAULT_ROWS,
    MAX_COLS,
    MAX_ROWS,
    PtyManager,
    PtyUnavailable,
    shell_capabilities,
)

FORGE_HOME = Path(os.environ.get("FORGE_HOME", str(Path.home() / ".forge")))
CONFIG_PATH = Path(os.environ.get("FORGE_CONFIG", str(FORGE_HOME / "config.json")))
KEYS_PATH = Path(os.environ.get("FORGE_KEYS", str(FORGE_HOME / "keys.json")))
CLIENTS_PATH = Path(os.environ.get("FORGE_CLIENTS", str(FORGE_HOME / "clients.json")))
AUDIT_PATH = Path(os.environ.get("FORGE_AUDIT_LOG", str(FORGE_HOME / "audit.log")))

MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 25 * 1024 * 1024
CHUNK_BYTES = 16 * 1024
CONNECT_TIMEOUT_S = 3
READ_TIMEOUT_S = 300
HEARTBEAT_S = 15
CHANNEL_TIMEOUT_S = 20
LOCK_PORT = 18473
FS_PREFIX = "/api/fs/"
BRIDGE_PREFIX = "/api/bridge/"

HOP_HEADERS = {
    "connection",
    "content-length",
    "content-encoding",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
}


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------


def load_config() -> dict:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit("Could not read %s: %s" % (CONFIG_PATH, error))
    required = ("deviceId", "deviceToken", "workerWebSocketUrl")
    if any(not config.get(key) for key in required):
        raise SystemExit("Forge config is incomplete; pair this laptop again")
    return config


def websocket_url(config: dict) -> str:
    url = str(config["workerWebSocketUrl"])
    token = str(config["deviceToken"])
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if not query.get("token") and token:
        query["token"] = [token]
    encoded = urllib.parse.urlencode({key: values[-1] for key, values in query.items()})
    scheme = parsed.scheme if parsed.scheme in {"ws", "wss"} else (
        "wss" if parsed.scheme == "https" else "ws"
    )
    return urllib.parse.urlunsplit((scheme, parsed.netloc, parsed.path, encoded, ""))


def daemon_token() -> str:
    token_path = Path.home() / ".agentremoted" / "token"
    try:
        return token_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def daemon_target(config: dict) -> tuple:
    parsed = urllib.parse.urlsplit(str(config.get("daemonUrl", "http://127.0.0.1:8473")))
    return parsed.hostname or "127.0.0.1", parsed.port or 8473


def daemon_headers() -> dict:
    headers = {"User-Agent": "forge-bridge/%s" % BRIDGE_VERSION, "Connection": "close"}
    token = daemon_token()
    if token:
        headers["X-Auth-Token"] = token
    return headers


def daemon_online(config: dict) -> bool:
    host, port = daemon_target(config)
    conn = http.client.HTTPConnection(host, port, timeout=CONNECT_TIMEOUT_S)
    try:
        conn.request("GET", "/api/ping", headers=daemon_headers())
        response = conn.getresponse()
        response.read()
        return response.status < 500
    except Exception:
        return False
    finally:
        conn.close()


def validate_daemon_path(path: str) -> str:
    parsed = urllib.parse.urlsplit(path)
    if not parsed.path.startswith("/") or parsed.path.startswith("/internal"):
        raise ValueError("Forbidden local path")
    if ".." in parsed.path.split("/"):
        raise ValueError("Forbidden local path")
    return path


# ---------------------------------------------------------------------------
# trusted browsers
# ---------------------------------------------------------------------------


class Clients:
    """Which browsers this machine trusts, and the live channel for each.

    Trust is decided once, at handshake:

    * the client that paired this machine is always trusted;
    * after that, only clients whose verified `userId` equals the owner recorded
      at pairing time (`ownerUserId` in config.json);
    * a guest pairing (no owner recorded) trusts any relay-authorised client —
      that is the documented no-account mode.

    The relay supplies `userId` from a Supabase JWT it verified against the
    project's JWKS, so it is authentic as far as this machine is concerned.
    """

    def __init__(self, identity, path: Path, owner_user_id: str, pairing_client_id: str, audit):
        self.identity = identity
        self.path = Path(path)
        self.owner_user_id = str(owner_user_id or "")
        self.pairing_client_id = str(pairing_client_id or "")
        self.audit = audit
        self._channels: dict = {}
        self._trust = self._read()
        self._lock = threading.Lock()

    # -- persistence -------------------------------------------------------
    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._trust, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        except OSError:
            pass

    # -- authorisation -----------------------------------------------------
    def authorize(self, client_id: str, client_pub: str, user_id: str) -> None:
        client_id = str(client_id or "")
        user_id = str(user_id or "")
        if not client_id or not client_pub:
            raise PermissionError("clientId and clientPub are required")
        if client_id == self.pairing_client_id:
            return
        if self.owner_user_id:
            if user_id != self.owner_user_id:
                raise PermissionError(
                    "this machine belongs to another Forge account"
                )
        known = self._trust.get(client_id)
        if known and known.get("publicKey") and known.get("publicKey") != client_pub:
            if known.get("userId") and user_id and known.get("userId") != user_id:
                raise PermissionError("client key does not match its account")

    # -- channels ----------------------------------------------------------
    def establish(self, client_id: str, client_pub: str, client_salt_b64: str, user_id: str, label: str = ""):
        """Create (or recreate) the encrypted channel for one browser."""
        self.authorize(client_id, client_pub, user_id)
        try:
            client_salt = base64.b64decode(str(client_salt_b64 or ""), validate=True)
        except Exception:
            client_salt = b""
        if len(client_salt) != 4:
            client_salt = random_salt()
        our_salt = random_salt()
        channel = channel_from_handshake(
            self.identity,
            device_id=str(CONFIG_DEVICE_ID.get("value", "")),
            client_id=client_id,
            client_public_b64=client_pub,
            our_salt=our_salt,
            their_salt=client_salt,
        )
        with self._lock:
            self._channels[client_id] = channel
            record = self._trust.setdefault(client_id, {})
            record.update(
                {
                    "publicKey": client_pub,
                    "userId": str(user_id or ""),
                    "label": str(label or record.get("label") or "")[:80],
                    "firstSeen": record.get("firstSeen") or int(time.time()),
                    "lastSeen": int(time.time()),
                }
            )
            self._write()
        if self.audit:
            self.audit.write(
                "channel.established", clientId=client_id, userId=user_id or None
            )
        return channel, self.identity.public_b64, base64.b64encode(our_salt).decode("ascii")

    def channel(self, client_id: str):
        with self._lock:
            return self._channels.get(str(client_id or ""))

    def forget_channel(self, client_id: str) -> None:
        with self._lock:
            self._channels.pop(str(client_id or ""), None)

    def known(self) -> list:
        with self._lock:
            return [
                {"clientId": key, **{k: v for k, v in value.items() if k != "publicKey"}}
                for key, value in self._trust.items()
            ]

    def revoke(self, client_id: str) -> bool:
        with self._lock:
            existed = self._trust.pop(str(client_id or ""), None) is not None
            self._channels.pop(str(client_id or ""), None)
            self._write()
        return existed


# Set by main() so Clients can derive keys bound to this device id.
CONFIG_DEVICE_ID: dict = {"value": ""}


# ---------------------------------------------------------------------------
# the bridge
# ---------------------------------------------------------------------------


class Bridge:
    def __init__(self, config: dict):
        self.config = config
        self.device_id = str(config["deviceId"])
        CONFIG_DEVICE_ID["value"] = self.device_id
        self.socket = None
        self.stop = threading.Event()
        self.send_lock = threading.Lock()
        self.connected_since = 0.0

        self.audit = AuditLog(AUDIT_PATH)
        self.identity = DeviceIdentity(KEYS_PATH) if CRYPTO_AVAILABLE else None
        self.clients = Clients(
            identity=self.identity,
            path=CLIENTS_PATH,
            owner_user_id=str(config.get("ownerUserId") or ""),
            pairing_client_id=str(config.get("pairingClientId") or ""),
            audit=self.audit,
        )
        self.files = FileService(roots=config.get("roots"), audit=self.audit)
        self.pty = PtyManager(on_output=self.on_pty_output, on_exit=self.on_pty_exit)
        self._session_clients: dict = {}  # sessionId -> {clientId}
        self._session_lock = threading.Lock()
        self._pending_channels: dict = {}  # clientId -> threading.Event + result
        self.capabilities = shell_capabilities()

    # -- transport ---------------------------------------------------------
    def send_text(self, payload: dict) -> None:
        frame = text_frame(payload)
        with self.send_lock:
            if self.socket and self.socket.sock and self.socket.sock.connected:
                self.socket.send(frame)

    def send_binary(self, data: bytes) -> None:
        with self.send_lock:
            if not (self.socket and self.socket.sock and self.socket.sock.connected):
                return
            # websocket-client: send_bytes() on modern versions, otherwise
            # send() with the binary opcode.
            sender = getattr(self.socket, "send_bytes", None)
            if callable(sender):
                sender(data)
            else:
                self.socket.send(data, opcode=websocket.ABNF.OPCODE_BINARY)

    def on_open(self, ws) -> None:
        self.socket = ws
        self.stop.clear()
        self.connected_since = time.time()
        print("Forge bridge connected (protocol v%d)" % PROTOCOL_VERSION, flush=True)
        self.send_heartbeat()
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()

    def on_message(self, _ws, raw) -> None:
        if isinstance(raw, (bytes, bytearray)):
            self.handle_binary(bytes(raw))
            return
        message = parse_text(raw)
        if not message:
            return
        kind = message.get("type")
        if kind == "rpc_request" and message.get("id"):
            threading.Thread(target=self.proxy_request, args=(message,), daemon=True).start()
            return
        if kind == "channel_hello":
            threading.Thread(target=self.handle_channel_hello, args=(message,), daemon=True).start()
            return
        if kind in ("term_open", "term_attach"):
            threading.Thread(target=self.handle_term_open, args=(message,), daemon=True).start()
            return
        if kind == "term_resize":
            self.handle_term_resize(message)
            return
        if kind == "term_detach":
            self.handle_term_detach(message)
            return
        if kind == "term_close":
            self.handle_term_close(message)
            return
        if kind == "term_list":
            self.send_text({"type": "term_list_result", "sessions": self.pty.list()})
            return
        if kind == "heartbeat_ack":
            return
        if kind == "revoke_client":
            self.clients.revoke(str(message.get("clientId") or ""))
            return

    def on_error(self, _ws, error) -> None:
        sys.stderr.write("Forge connection error: %s\n" % error)

    def on_close(self, _ws, code, reason) -> None:
        self.stop.set()
        self.socket = None
        print("Forge bridge disconnected (%s %s)" % (code or "", reason or ""), flush=True)

    def send_heartbeat(self) -> None:
        self.send_text(
            {
                "type": "heartbeat",
                "daemonOnline": daemon_online(self.config),
                "bridge": BRIDGE_VERSION,
                "protocol": PROTOCOL_VERSION,
                "caps": {
                    "e2e": bool(self.identity),
                    "term": True,
                    "files": True,
                    "pty": self.capabilities["pty"],
                },
                "sessions": len(self.pty.list()),
            }
        )

    def heartbeat_loop(self) -> None:
        while not self.stop.wait(HEARTBEAT_S):
            self.send_heartbeat()

    def run(self) -> None:
        delay = 1
        url = websocket_url(self.config)
        while True:
            app = websocket.WebSocketApp(
                url,
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close,
            )
            app.run_forever(
                ping_interval=25, ping_timeout=10, sslopt={"cert_reqs": ssl.CERT_REQUIRED}
            )
            if self.stop.is_set() and os.environ.get("FORGE_ONCE"):
                return
            time.sleep(delay)
            delay = min(delay * 2, 30)

    # -- encryption --------------------------------------------------------
    def establish_channel(self, message: dict):
        client_id = str(message.get("clientId") or "")
        client_pub = str(message.get("clientPub") or "")
        user_id = str(message.get("userId") or "")
        label = str(message.get("label") or "")
        if not self.identity:
            raise CryptoUnavailable("cryptography is not installed in the bridge venv")
        return self.clients.establish(client_id, client_pub, str(message.get("clientSalt") or ""), user_id, label)

    def handle_channel_hello(self, message: dict) -> None:
        client_id = str(message.get("clientId") or "")
        try:
            _channel, device_pub, device_salt = self.establish_channel(message)
            self.send_text(
                {
                    "type": "channel_key",
                    "clientId": client_id,
                    "devicePub": device_pub,
                    "deviceSalt": device_salt,
                    "ok": True,
                }
            )
        except (PermissionError, CryptoUnavailable, ValueError) as error:
            self.send_text(
                {
                    "type": "channel_key",
                    "clientId": client_id,
                    "ok": False,
                    "error": str(error)[:300],
                    "code": "AUTH_DENIED" if isinstance(error, PermissionError) else "E2E_UNAVAILABLE",
                }
            )

    def seal_for(self, client_id: str, plaintext: bytes):
        channel = self.clients.channel(client_id)
        if channel is None:
            return None
        return channel.seal(plaintext)

    def open_from(self, client_id: str, sealed: bytes) -> bytes:
        channel = self.clients.channel(client_id)
        if channel is None:
            raise PermissionError("no channel for this client; handshake first")
        return channel.open(sealed)

    # -- terminal ----------------------------------------------------------
    def _attached(self, session_id: str) -> set:
        with self._session_lock:
            return set(self._session_clients.get(session_id, ()))

    def _attach(self, session_id: str, client_id: str) -> None:
        with self._session_lock:
            clients = self._session_clients.setdefault(session_id, set())
            clients.add(client_id)

    def _detach(self, session_id: str, client_id: str) -> None:
        with self._session_lock:
            clients = self._session_clients.get(session_id)
            if not clients:
                return
            clients.discard(client_id)
            if not clients:
                self._session_clients.pop(session_id, None)

    def handle_term_open(self, message: dict) -> None:
        client_id = str(message.get("clientId") or "")
        session_id = str(message.get("sessionId") or "")
        try:
            _channel, device_pub, device_salt = self.establish_channel(message)
        except (PermissionError, CryptoUnavailable, ValueError) as error:
            self.send_text(
                {
                    "type": "term_error",
                    "sessionId": session_id,
                    "clientId": client_id,
                    "message": str(error)[:300],
                    "code": "AUTH_DENIED" if isinstance(error, PermissionError) else "E2E_UNAVAILABLE",
                }
            )
            return
        self.send_text(
            {
                "type": "term_key",
                "clientId": client_id,
                "sessionId": session_id or None,
                "devicePub": device_pub,
                "deviceSalt": device_salt,
            }
        )

        existing = self.pty.get(session_id) if session_id else None
        if existing is not None:
            existing.attach(client_id)
            self._attach(existing.session_id, client_id)
            replay = existing.replay_bytes()
            self.send_text(
                {
                    "type": "term_ready",
                    "sessionId": existing.session_id,
                    "clientId": client_id,
                    "resumed": True,
                    **_session_public(existing),
                    "replayBytes": len(replay),
                }
            )
            if replay:
                self.send_terminal(existing.session_id, client_id, replay)
            return

        cols = clamp_dimension(message.get("cols"), 2, MAX_COLS, DEFAULT_COLS)
        rows = clamp_dimension(message.get("rows"), 1, MAX_ROWS, DEFAULT_ROWS)
        cwd = str(message.get("cwd") or "").strip()
        if cwd:
            try:
                cwd = str(self.files.resolve(cwd))
            except FileError as error:
                self.send_text(
                    {
                        "type": "term_error",
                        "sessionId": session_id,
                        "clientId": client_id,
                        "message": error.message,
                        "code": error.code,
                    }
                )
                return
        try:
            session = self.pty.create(
                session_id=session_id or None,
                cols=cols,
                rows=rows,
                cwd=cwd,
                shell=message.get("shell"),
            )
        except (PtyUnavailable, OSError) as error:
            self.send_text(
                {
                    "type": "term_error",
                    "sessionId": session_id,
                    "clientId": client_id,
                    "message": str(error)[:300],
                    "code": "PTY_UNAVAILABLE",
                }
            )
            return
        session.attach(client_id)
        self._attach(session.session_id, client_id)
        self.audit.write(
            "term.open",
            sessionId=session.session_id,
            clientId=client_id,
            cwd=session.cwd,
            shell=" ".join(session.argv),
            backend=session.backend,
        )
        self.send_text(
            {
                "type": "term_ready",
                "sessionId": session.session_id,
                "clientId": client_id,
                "resumed": False,
                **_session_public(session),
                "replayBytes": 0,
            }
        )

    def handle_term_resize(self, message: dict) -> None:
        session = self.pty.get(str(message.get("sessionId") or ""))
        if session is None:
            return
        session.resize(message.get("cols"), message.get("rows"))

    def handle_term_detach(self, message: dict) -> None:
        session_id = str(message.get("sessionId") or "")
        client_id = str(message.get("clientId") or "")
        session = self.pty.get(session_id)
        if session is not None:
            session.detach(client_id)
        self._detach(session_id, client_id)

    def handle_term_close(self, message: dict) -> None:
        session_id = str(message.get("sessionId") or "")
        closed = self.pty.close(session_id)
        with self._session_lock:
            self._session_clients.pop(session_id, None)
        self.audit.write("term.close", sessionId=session_id)
        self.send_text({"type": "term_closed", "sessionId": session_id, "closed": closed})

    def handle_binary(self, raw: bytes) -> None:
        parsed = unpack_binary(raw)
        if parsed is None:
            return
        kind, session_id, client_id, sealed = parsed
        if kind != KIND_TERMINAL:
            return
        try:
            plaintext = self.open_from(client_id, sealed)
        except (PermissionError, ValueError) as error:
            self.send_text(
                {
                    "type": "term_error",
                    "sessionId": session_id,
                    "clientId": client_id,
                    "message": str(error)[:200],
                    "code": "E2E_FAILED",
                }
            )
            return
        session = self.pty.get(session_id)
        if session is None:
            self.send_text(
                {
                    "type": "term_error",
                    "sessionId": session_id,
                    "clientId": client_id,
                    "message": "that shell is no longer running",
                    "code": "SESSION_NOT_FOUND",
                }
            )
            return
        if client_id not in self._attached(session_id):
            # The relay checks this too; defence in depth costs one set lookup.
            return
        try:
            session.write(plaintext)
        except PtyUnavailable as error:
            self.send_text(
                {
                    "type": "term_error",
                    "sessionId": session_id,
                    "clientId": client_id,
                    "message": str(error)[:200],
                    "code": "WRITE_FAILED",
                }
            )

    def send_terminal(self, session_id: str, client_id: str, data: bytes) -> None:
        for offset in range(0, len(data), MAX_PAYLOAD_BYTES):
            sealed = self.seal_for(client_id, data[offset : offset + MAX_PAYLOAD_BYTES])
            if sealed is None:
                return
            self.send_binary(pack_terminal(session_id, client_id, sealed))

    def on_pty_output(self, session_id: str, data: bytes) -> None:
        for client_id in self._attached(session_id):
            self.send_terminal(session_id, client_id, data)

    def on_pty_exit(self, session_id: str, exit_code) -> None:
        clients = self._attached(session_id)
        with self._session_lock:
            self._session_clients.pop(session_id, None)
        self.audit.write("term.exit", sessionId=session_id, exitCode=exit_code)
        for client_id in clients:
            self.send_text(
                {
                    "type": "term_eof",
                    "sessionId": session_id,
                    "clientId": client_id,
                    "exitCode": exit_code,
                }
            )

    # -- RPC (files served here, everything else proxied to the daemon) -----
    def proxy_request(self, rpc: dict) -> None:
        request_id = str(rpc["id"])
        client_id = str(rpc.get("clientId") or "")
        encrypted = bool(rpc.get("data"))
        self.send_text({"type": "rpc_accepted", "id": request_id})
        conn = None
        try:
            if encrypted:
                payload = json.loads(self.open_from(client_id, base64.b64decode(rpc["data"], validate=True)))
            else:
                payload = rpc
            path = str(payload.get("path") or "/")
            method = str(payload.get("method") or "GET").upper()
            if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                raise ValueError("Unsupported method")
            body_value = payload.get("bodyBase64")
            body = base64.b64decode(body_value, validate=True) if body_value else None
            if body and len(body) > MAX_REQUEST_BYTES:
                raise ValueError("Request body is too large")

            if path.startswith(FS_PREFIX) or path.startswith(BRIDGE_PREFIX):
                status, result = self.handle_local(path, method, body, client_id)
                self.respond_local(request_id, client_id, encrypted, status, result)
                return

            path = validate_daemon_path(path)
            headers = daemon_headers()
            for name, value in dict(payload.get("headers") or {}).items():
                if str(name).lower() not in HOP_HEADERS:
                    headers[str(name)] = str(value)
            if body is not None:
                headers["Content-Length"] = str(len(body))
            host, port = daemon_target(self.config)
            conn = http.client.HTTPConnection(host, port, timeout=CONNECT_TIMEOUT_S)
            try:
                conn.connect()
            except OSError as error:
                raise RuntimeError("Local daemon is not running on %s:%s" % (host, port)) from error
            if conn.sock is not None:
                conn.sock.settimeout(READ_TIMEOUT_S)
            self.audit.write(
                "rpc.request", clientId=client_id or None, method=method, path=path.split("?")[0]
            )
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            out_headers = {
                name: value for name, value in response.getheaders() if name.lower() not in HOP_HEADERS
            }
            self.send_text(
                {"type": "rpc_start", "id": request_id, "status": int(response.status), "headers": out_headers}
            )
            total = 0
            while True:
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise ValueError("Response body is too large")
                self.send_text(
                    {
                        "type": "rpc_chunk",
                        "id": request_id,
                        "bodyBase64": base64.b64encode(self._out_chunk(client_id, encrypted, chunk)).decode("ascii"),
                    }
                )
            self.send_text({"type": "rpc_end", "id": request_id})
        except (PermissionError, CryptoUnavailable) as error:
            self.send_text(
                {"type": "rpc_error", "id": request_id, "message": str(error)[:500], "code": "E2E_FAILED"}
            )
        except FileError as error:
            self.respond_local(request_id, client_id, encrypted, error.status, {"error": error.message, "code": error.code})
        except Exception as error:
            self.send_text({"type": "rpc_error", "id": request_id, "message": str(error)[:500]})
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def _out_chunk(self, client_id: str, encrypted: bool, chunk: bytes) -> bytes:
        """Length-prefixed ciphertext when encrypted, raw bytes otherwise."""
        if not encrypted:
            return chunk
        sealed = self.seal_for(client_id, chunk)
        if sealed is None:
            raise PermissionError("no channel for this client; handshake first")
        return length_prefix(sealed)

    def respond_local(self, request_id: str, client_id: str, encrypted: bool, status: int, result: dict) -> None:
        raw = json.dumps(result, separators=(",", ":")).encode("utf-8")
        self.send_text(
            {
                "type": "rpc_start",
                "id": request_id,
                "status": int(status),
                "headers": {"content-type": "application/json; charset=utf-8"},
            }
        )
        for offset in range(0, len(raw), CHUNK_BYTES):
            self.send_text(
                {
                    "type": "rpc_chunk",
                    "id": request_id,
                    "bodyBase64": base64.b64encode(
                        self._out_chunk(client_id, encrypted, raw[offset : offset + CHUNK_BYTES])
                    ).decode("ascii"),
                }
            )
        self.send_text({"type": "rpc_end", "id": request_id})

    # -- local endpoints ---------------------------------------------------
    def handle_local(self, path: str, method: str, body, client_id: str):
        parsed = urllib.parse.urlsplit(path)
        route = parsed.path
        query = {key: values[-1] for key, values in urllib.parse.parse_qs(parsed.query).items()}
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, ValueError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        payload.update({key: value for key, value in query.items() if key not in payload})

        if route.startswith(BRIDGE_PREFIX):
            return self.handle_bridge_route(route, payload)

        action = route[len(FS_PREFIX) :].strip("/")
        self.audit.write(
            "fs.%s" % action, clientId=client_id or None, path=payload.get("path") or None
        )
        if action == "roots":
            return 200, self.files.roots_info()
        # Optional numbers are passed through untouched: FileService clamps
        # real values and falls back on missing ones. (Coercing absent fields
        # to 0 here once turned every default listing into a single entry.)
        if action == "list":
            return 200, self.files.list(payload.get("path", ""), payload.get("limit"))
        if action == "stat":
            return 200, self.files.stat(payload.get("path", ""))
        if action == "read":
            return 200, self.files.read(
                payload.get("path", ""),
                payload.get("offset") or 0,
                payload.get("limit"),
                payload.get("bytes"),
            )
        if action == "glob":
            return 200, self.files.glob(
                payload.get("path", ""), payload.get("pattern", ""), payload.get("limit")
            )
        if action == "grep":
            return 200, self.files.grep(
                payload.get("path", ""),
                payload.get("pattern", ""),
                payload.get("limit"),
                bool(payload.get("ignoreCase")),
            )
        if method != "POST":
            raise FileError("%s needs POST" % route, "FS_METHOD", 405)
        if action == "write":
            return 200, self.files.write(
                payload.get("path", ""),
                str(payload.get("content") or ""),
                bool(payload.get("createParents", True)),
            )
        if action == "edit":
            return 200, self.files.edit(
                payload.get("path", ""),
                str(payload.get("oldText") or ""),
                str(payload.get("newText") or ""),
                bool(payload.get("replaceAll")),
            )
        if action == "upload":
            return 200, self.files.upload(
                payload.get("path", ""), str(payload.get("contentBase64") or ""), bool(payload.get("append"))
            )
        if action == "download":
            return 200, self.files.download(payload.get("path", ""))
        if action == "delete":
            return 200, self.files.delete(payload.get("path", ""))
        raise FileError("unknown file endpoint: %s" % route, "FS_UNKNOWN", 404)

    def handle_bridge_route(self, route: str, payload: dict):
        name = route[len(BRIDGE_PREFIX) :].strip("/")
        if name in ("info", "ping"):
            return 200, {
                "ok": True,
                "bridge": BRIDGE_VERSION,
                "protocol": PROTOCOL_VERSION,
                "deviceId": self.device_id,
                "host": socket.gethostname(),
                "capabilities": self.capabilities,
                "crypto": bool(self.identity),
                "roots": self.files.roots,
                "sessions": self.pty.list(),
                "clients": self.clients.known(),
                "daemonOnline": daemon_online(self.config),
                "connectedSince": self.connected_since,
            }
        if name == "sessions":
            return 200, {"sessions": self.pty.list()}
        if name == "clients":
            return 200, {"clients": self.clients.known()}
        if name == "clients/revoke":
            client_id = str(payload.get("clientId") or "")
            return 200, {"revoked": self.clients.revoke(client_id)}
        if name == "audit":
            limit = max(1, min(500, int(payload.get("limit") or 100)))
            return 200, {"entries": self.audit.recent(limit)}
        return 404, {"error": "unknown bridge endpoint", "route": route}


def _session_public(session) -> dict:
    return {
        "shell": " ".join(session.argv),
        "cwd": session.cwd,
        "pid": session.pid,
        "cols": session.cols,
        "rows": session.rows,
        "backend": session.backend,
        "pty": session.is_pty,
        "startedAt": session.started_at,
    }


def acquire_single_instance():
    """One bridge per machine: bind a loopback port as a lock."""
    deadline = time.time() + 12
    while True:
        lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            lock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            lock.bind(("127.0.0.1", LOCK_PORT))
            lock.listen(1)
            return lock
        except OSError:
            lock.close()
            if time.time() >= deadline:
                raise SystemExit("Forge bridge is already running")
            time.sleep(0.4)


def main() -> None:
    instance_lock = acquire_single_instance()
    websocket.enableTrace(False)
    config = load_config()
    bridge = Bridge(config)
    print(
        "Forge bridge %s (protocol v%d, pty=%s, crypto=%s)"
        % (BRIDGE_VERSION, PROTOCOL_VERSION, bridge.capabilities["pty"], bool(bridge.identity)),
        flush=True,
    )
    try:
        bridge.run()
    finally:
        bridge.pty.close_all()
        instance_lock.close()


if __name__ == "__main__":
    main()

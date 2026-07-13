"""Dependency-free Python client for the WebBrain Cloud browser API."""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional
from urllib import error, parse, request


TERMINAL_RUN_STATUSES = {"completed", "failed", "aborted"}


class WebBrainApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class WebBrainClient:
    def __init__(self, api_key: str, base_url: str = "https://webbrain.cloud", timeout: float = 30.0):
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else None
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8")
            try:
                parsed = json.loads(payload) if payload else None
            except json.JSONDecodeError:
                parsed = payload
            message = parsed.get("error") if isinstance(parsed, dict) else None
            raise WebBrainApiError(message or f"WebBrain API request failed with status {exc.code}", exc.code, parsed) from exc

    @staticmethod
    def _id(value: str) -> str:
        return parse.quote(str(value), safe="")

    def list_browser_sessions(self):
        return self._request("GET", "/api/browser-sessions")["browser_sessions"]

    def create_browser_session(self, **options):
        return self._request("POST", "/api/browser-sessions", options)["browser_session"]

    def get_browser_session(self, session_id: str):
        return self._request("GET", f"/api/browser-sessions/{self._id(session_id)}")["browser_session"]

    def update_browser_session(self, session_id: str, *, display_name: Optional[str] = None):
        name = display_name.strip() if display_name else None
        return self._request("PATCH", f"/api/browser-sessions/{self._id(session_id)}", {"display_name": name})["browser_session"]

    def delete_browser_session(self, session_id: str):
        return self._request("DELETE", f"/api/browser-sessions/{self._id(session_id)}")["browser_session"]

    def create_connect_token(self, session_id: str, **options):
        return self._request("POST", f"/api/browser-sessions/{self._id(session_id)}/connect-token", options)

    def wait_for_browser_session(self, session_id: str, *, poll_interval: float = 2.0, timeout: float = 300.0):
        deadline = time.monotonic() + timeout
        while True:
            session = self.get_browser_session(session_id)
            if session.get("runtime_ready") is True:
                return session
            if session.get("status") in {"failed", "destroyed"}:
                raise WebBrainApiError(f"Browser session {session_id} entered {session['status']}", body=session)
            if time.monotonic() >= deadline:
                raise WebBrainApiError(f"Browser session {session_id} was not ready within {timeout} seconds", body=session)
            time.sleep(poll_interval)

    def create_run(
        self,
        session_id: str,
        task: str,
        *,
        wait: bool = False,
        timeout_ms: Optional[int] = None,
        tab_id: Optional[int] = None,
        output_schema: Optional[Dict[str, Any]] = None,
    ):
        if not task:
            raise ValueError("task is required")
        body: Dict[str, Any] = {"task": task, "wait": wait}
        if timeout_ms is not None:
            body["timeout_ms"] = timeout_ms
        if tab_id is not None:
            body["tab_id"] = tab_id
        if output_schema is not None:
            body["output_schema"] = output_schema
        return self._request("POST", f"/api/browser-sessions/{self._id(session_id)}/runs", body)

    def get_run(self, session_id: str, run_id: str):
        return self._request("GET", f"/api/browser-sessions/{self._id(session_id)}/runs/{self._id(run_id)}")

    def abort_run(self, session_id: str, run_id: str):
        return self._request("POST", f"/api/browser-sessions/{self._id(session_id)}/runs/{self._id(run_id)}/abort", {})

    def wait_for_run(self, session_id: str, run_id: str, *, poll_interval: float = 1.0, timeout: float = 120.0):
        deadline = time.monotonic() + timeout
        while True:
            run = self.get_run(session_id, run_id)
            if run.get("status") in TERMINAL_RUN_STATUSES:
                return run
            if time.monotonic() >= deadline:
                raise WebBrainApiError(f"Run {run_id} did not finish within {timeout} seconds", body=run)
            time.sleep(poll_interval)

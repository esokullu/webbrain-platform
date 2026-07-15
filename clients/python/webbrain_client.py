"""Dependency-free Python client for the WebBrain Cloud browser API."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import stat
import tempfile
import time
from typing import Any, Dict, Optional
from urllib import error, parse, request


TERMINAL_RUN_STATUSES = {"completed", "failed", "aborted"}
WAIT_RETURN_STATUSES = TERMINAL_RUN_STATUSES | {"needs_user_input"}


class _NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_DOWNLOADS_OPENER = request.build_opener(_NoRedirectHandler())


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

    def get_browser_proxy(self, session_id: str):
        return self._request("GET", f"/api/browser-sessions/{self._id(session_id)}/proxy")["proxy"]

    def update_browser_proxy(
        self,
        session_id: str,
        *,
        proxy_url: Optional[str] = None,
        proxy: Optional[Dict[str, Any]] = None,
    ):
        body = {"proxy": proxy} if proxy is not None else {"proxy_url": proxy_url}
        return self._request(
            "PATCH",
            f"/api/browser-sessions/{self._id(session_id)}/proxy",
            body,
        )["proxy"]

    def delete_browser_proxy(self, session_id: str):
        return self._request("DELETE", f"/api/browser-sessions/{self._id(session_id)}/proxy")["proxy"]

    def delete_browser_session(self, session_id: str):
        return self._request("DELETE", f"/api/browser-sessions/{self._id(session_id)}")["browser_session"]

    def create_connect_token(self, session_id: str, **options):
        return self._request("POST", f"/api/browser-sessions/{self._id(session_id)}/connect-token", options)

    def create_downloads_access(self, session_id: str):
        return self._request("POST", f"/api/browser-sessions/{self._id(session_id)}/downloads-access", {})

    def list_downloads(self, session_id: str, path: str = "", *, access: Optional[Dict[str, Any]] = None):
        downloads_access = self._downloads_access(session_id, access)
        response = self._downloads_request(
            downloads_access,
            self._downloads_url(downloads_access, path, directory=True),
            headers={"Accept": "application/json"},
            timeout=self.timeout,
        )
        with response:
            payload = response.read().decode("utf-8")
        return json.loads(payload)

    def upload_downloads_file(
        self,
        session_id: str,
        local_path: str,
        *,
        remote_path: Optional[str] = None,
        access: Optional[Dict[str, Any]] = None,
    ):
        file_stat = os.stat(local_path)
        if not stat.S_ISREG(file_stat.st_mode):
            raise ValueError("local_path must be a regular file")
        downloads_access = self._downloads_access(session_id, access)
        upload_limit = downloads_access.get("upload_limit_bytes")
        if isinstance(upload_limit, int) and file_stat.st_size > upload_limit:
            raise ValueError(f"file exceeds the {upload_limit}-byte Downloads upload limit")
        destination = remote_path if remote_path is not None else os.path.basename(local_path)
        headers = {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(file_stat.st_size),
            "Accept": "application/json",
        }
        with open(local_path, "rb") as source:
            response = self._downloads_request(
                downloads_access,
                self._downloads_url(downloads_access, destination),
                method="PUT",
                data=source,
                headers=headers,
                timeout=None,
            )
            with response:
                payload = response.read().decode("utf-8")
        return json.loads(payload)

    def download_downloads_file(
        self,
        session_id: str,
        remote_path: str,
        destination_path: str,
        *,
        access: Optional[Dict[str, Any]] = None,
        byte_range: Optional[str] = None,
        overwrite: bool = False,
    ):
        if byte_range is not None and re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", byte_range) is None:
            raise ValueError("byte_range must use the form bytes=START-END")
        downloads_access = self._downloads_access(session_id, access)
        headers = {"Range": byte_range} if byte_range is not None else {}
        response = self._downloads_request(
            downloads_access,
            self._downloads_url(downloads_access, remote_path),
            headers=headers,
            timeout=None,
        )
        status_code = response.getcode()
        if byte_range is not None and status_code != 206:
            response.close()
            raise WebBrainApiError("Downloads service did not honor the requested byte range", status_code)

        absolute_destination = os.path.abspath(os.fspath(destination_path))
        destination_directory = os.path.dirname(absolute_destination)
        os.makedirs(destination_directory, exist_ok=True)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{os.path.basename(absolute_destination)}.webbrain-",
                suffix=".part",
                dir=destination_directory,
                delete=False,
            ) as destination:
                temporary_path = destination.name
                os.chmod(temporary_path, 0o600)
                with response:
                    shutil.copyfileobj(response, destination, length=1024 * 1024)
            if overwrite:
                os.replace(temporary_path, absolute_destination)
            else:
                os.link(temporary_path, absolute_destination)
                os.unlink(temporary_path)
            temporary_path = None
        finally:
            response.close()
            if temporary_path is not None:
                try:
                    os.unlink(temporary_path)
                except FileNotFoundError:
                    pass

        return {
            "path": absolute_destination,
            "size": os.path.getsize(absolute_destination),
            "status": status_code,
            "content_type": response.headers.get("Content-Type"),
            "content_range": response.headers.get("Content-Range"),
        }

    def _downloads_access(self, session_id: str, access: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        result = self.create_downloads_access(session_id) if access is None else access
        if not isinstance(result, dict) or not all(result.get(key) for key in ("url", "username", "password")):
            raise ValueError("access must contain url, username, and password")
        self._downloads_base_url(result["url"])
        return result

    @staticmethod
    def _downloads_url(access: Dict[str, Any], remote_path: str = "", *, directory: bool = False) -> str:
        segments = WebBrainClient._downloads_path_segments(remote_path)
        base_url = WebBrainClient._downloads_base_url(access["url"])
        encoded_path = "/".join(parse.quote(segment, safe="") for segment in segments)
        result = base_url + encoded_path
        if directory and encoded_path:
            result += "/"
        return result

    @staticmethod
    def _downloads_path_segments(remote_path: str):
        normalized = os.fspath(remote_path or "")
        segments = normalized.split("/") if normalized else []
        for segment in segments:
            if (
                segment in {"", ".", ".."}
                or segment.startswith(".")
                or "\\" in segment
                or any(ord(character) < 32 or ord(character) == 127 for character in segment)
            ):
                raise ValueError("Downloads paths cannot contain empty, dotfile, traversal, or control-character segments")
        return segments

    @staticmethod
    def _downloads_base_url(value: str) -> str:
        parsed = parse.urlsplit(str(value))
        loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
            raise ValueError("Downloads access URL must use HTTPS")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.netloc:
            raise ValueError("Downloads access URL cannot contain credentials, a query, or a fragment")
        return str(value).rstrip("/") + "/"

    def _downloads_request(
        self,
        access: Dict[str, Any],
        url: str,
        *,
        method: str = "GET",
        data: Any = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ):
        credentials = f'{access["username"]}:{access["password"]}'.encode("utf-8")
        request_headers = dict(headers or {})
        request_headers["Authorization"] = "Basic " + base64.b64encode(credentials).decode("ascii")
        req = request.Request(url, data=data, headers=request_headers, method=method)
        try:
            if timeout is None:
                return _DOWNLOADS_OPENER.open(req)
            return _DOWNLOADS_OPENER.open(req, timeout=timeout)
        except error.HTTPError as exc:
            payload = exc.read(1024 * 1024).decode("utf-8", errors="replace")
            try:
                parsed = json.loads(payload) if payload else None
            except json.JSONDecodeError:
                parsed = payload
            message = parsed.get("error") if isinstance(parsed, dict) else None
            raise WebBrainApiError(message or f"Downloads request failed with status {exc.code}", exc.code, parsed) from exc

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

    def continue_run(
        self,
        session_id: str,
        run_id: str,
        task: str,
        *,
        wait: bool = False,
        timeout_ms: Optional[int] = None,
        output_schema: Optional[Dict[str, Any]] = None,
    ):
        if not task:
            raise ValueError("task is required")
        body: Dict[str, Any] = {"task": task, "wait": wait}
        if timeout_ms is not None:
            body["timeout_ms"] = timeout_ms
        if output_schema is not None:
            body["output_schema"] = output_schema
        return self._request(
            "POST",
            f"/api/browser-sessions/{self._id(session_id)}/runs/{self._id(run_id)}/messages",
            body,
        )

    def abort_run(self, session_id: str, run_id: str):
        return self._request("POST", f"/api/browser-sessions/{self._id(session_id)}/runs/{self._id(run_id)}/abort", {})

    def respond_to_run(self, session_id: str, run_id: str, clarify_id: str, answer: str):
        if not clarify_id:
            raise ValueError("clarify_id is required")
        if answer is None or not str(answer).strip():
            raise ValueError("answer is required")
        return self._request(
            "POST",
            f"/api/browser-sessions/{self._id(session_id)}/runs/{self._id(run_id)}/responses",
            {"clarify_id": clarify_id, "answer": str(answer)},
        )

    def wait_for_run(self, session_id: str, run_id: str, *, poll_interval: float = 1.0, timeout: float = 120.0):
        deadline = time.monotonic() + timeout
        while True:
            run = self.get_run(session_id, run_id)
            if run.get("status") in WAIT_RETURN_STATUSES:
                return run
            if time.monotonic() >= deadline:
                raise WebBrainApiError(f"Run {run_id} did not finish within {timeout} seconds", body=run)
            time.sleep(poll_interval)

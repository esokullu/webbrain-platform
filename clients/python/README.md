# WebBrain Cloud client for Python

Dependency-free client for Python 3.9 and newer, implemented with the standard
library.

## Setup

Copy [`webbrain_client.py`](webbrain_client.py) into your project and set your
dashboard API key:

```bash
export WEBBRAIN_API_KEY='wbp_your_key_here'
```

## Create a browser and run a task

```python
import os
from webbrain_client import WebBrainClient

client = WebBrainClient(os.environ["WEBBRAIN_API_KEY"])
session = client.create_browser_session(display_name="Research")
ready = client.wait_for_browser_session(session["id"])
downloads = client.create_downloads_access(ready["id"])
# downloads contains the private URL, username, password, limit, and expiry.
client.update_browser_proxy(
    ready["id"],
    proxy={
        "domain": "p.webshare.io",
        "port": 80,
        "username": "webshare-user",
        "password": "webshare-password",
    },
)
run = client.create_run(
    ready["id"],
    "Open example.com and return the page title",
)
finished = client.wait_for_run(ready["id"], run["run_id"])
if finished["status"] == "needs_user_input":
    client.respond_to_run(
        ready["id"],
        run["run_id"],
        finished["pending_input"]["clarify_id"],
        "Work",
    )
    finished = client.wait_for_run(ready["id"], run["run_id"])

print(finished["result"])

follow_up = client.continue_run(
    ready["id"],
    finished["run_id"],
    "Now open the first link and summarize it",
)
print(client.wait_for_run(ready["id"], follow_up["run_id"])["result"])
```

`continue_run` creates a child run with `parent_run_id` and reuses the same tab
and WebBrain conversation. Append later turns to the newest child run.

Pause destroys the Droplet but retains the fixed 2 GiB Chrome profile volume;
resume attaches it to a new Droplet. Shared Downloads stay available:

```python
client.pause_browser_session(ready["id"])
client.list_downloads(ready["id"])
client.resume_browser_session(ready["id"])
client.wait_for_browser_session(ready["id"])
```

## Downloads transfers

The transfer helpers stream file bodies instead of buffering them in memory.
Reuse one access response for a batch of operations:

```python
access = client.create_downloads_access(ready["id"])

uploaded = client.upload_downloads_file(
    ready["id"],
    "./report.pdf",
    remote_path="report.pdf",
    access=access,
)
print(uploaded["name"])  # May be "report (1).pdf" on a collision.

listing = client.list_downloads(ready["id"], access=access)
print(listing["entries"])

client.download_downloads_file(
    ready["id"],
    uploaded["name"],
    "./saved/report.pdf",
    access=access,
)
client.download_downloads_file(
    ready["id"],
    uploaded["name"],
    "./saved/report-first-1KiB",
    access=access,
    byte_range="bytes=0-1023",
)
```

If `access` is omitted, each helper calls `create_downloads_access` itself. A
download will not replace an existing local file unless `overwrite=True` is
explicitly supplied. Remote paths reject traversal, dotfile, and control
character segments.

## Structured output

```python
run = client.create_run(
    session["id"],
    "Return the title and visible links",
    output_schema={"title": "string", "links": "string[]"},
)
```

## Main methods

- `list_browser_sessions()`
- `create_browser_session(**options)`
- `get_browser_session(session_id)`
- `update_browser_session(session_id, display_name=...)`
- `get_browser_proxy(session_id)`
- `update_browser_proxy(session_id, proxy_url=...)` or `proxy={...}`
- `delete_browser_proxy(session_id)`
- `wait_for_browser_session(session_id, ...)`
- `delete_browser_session(session_id)`
- `pause_browser_session(session_id)`
- `resume_browser_session(session_id)`
- `create_run(session_id, task, ...)`
- `get_run(session_id, run_id)`
- `continue_run(session_id, run_id, task, ...)`
- `respond_to_run(session_id, run_id, clarify_id, answer)`
- `wait_for_run(session_id, run_id, ...)`
- `abort_run(session_id, run_id)`
- `create_connect_token(session_id, **options)`
- `create_downloads_access(session_id)`
- `list_downloads(session_id, path="", access=...)`
- `upload_downloads_file(session_id, local_path, remote_path=..., access=...)`
- `download_downloads_file(session_id, remote_path, destination_path, access=...)`

Failed HTTP requests raise `WebBrainApiError` with `status` and `body`
attributes.

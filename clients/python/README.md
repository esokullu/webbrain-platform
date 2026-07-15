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

print(finished["result"])
```

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
- `wait_for_browser_session(session_id, ...)`
- `delete_browser_session(session_id)`
- `create_run(session_id, task, ...)`
- `get_run(session_id, run_id)`
- `wait_for_run(session_id, run_id, ...)`
- `abort_run(session_id, run_id)`
- `create_connect_token(session_id, **options)`

Failed HTTP requests raise `WebBrainApiError` with `status` and `body`
attributes.

# WebBrain Cloud API reference

## Contents

- Authentication and request behavior
- Browser sessions
- Runs
- Structured output
- Downloads and viewer access
- CLI command map
- Errors and recovery

## Authentication and request behavior

- Base URL: `https://webbrain.cloud`
- Authentication: `Authorization: Bearer $WEBBRAIN_API_KEY`
- Successful JSON responses use the documented entity fields below.
- Error responses use `{ "error": "message" }` and may include state such as `runtime_ready`, `status`, or `active_run_ids`.
- `401` means the API key is missing, invalid, or revoked. `404` also protects ownership boundaries. `409` means the resource is not in a valid state for the requested transition.

## Browser sessions

Create with `POST /api/browser-sessions`:

| Field | Type | Meaning |
| --- | --- | --- |
| `display_name` | string | Optional dashboard label, up to 120 characters. |
| `type` | `normal` or `incognito` | `normal` keeps a persistent profile; `incognito` is disposable and cannot pause. |
| `proxy_enabled` | boolean | Use the platform-configured proxy or a direct connection. |
| `webbrain_config` | `webbrain-config/1` object | Optional sparse Settings import copied directly from WebBrain's `/export --config` output. Invalid or platform-managed fields are ignored. |

The public session includes `id`, `display_name`, `status`, `profile_mode`, timestamps, volume metadata, `droplet_connected`, `extension_connected`, `runtime_ready`, and proxy state. When `webbrain_config` is supplied, the create response also includes `webbrain_config_result` with accepted field paths, ignored fields and reason codes, and non-secret warnings. It never echoes setting values or credentials. Start a run only when `status` is `ready` and `runtime_ready` is `true`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/browser-sessions` | List owned sessions. |
| `POST` | `/api/browser-sessions` | Create a browser. |
| `GET` | `/api/browser-sessions/:sessionId` | Refresh one browser and read readiness. |
| `PATCH` | `/api/browser-sessions/:sessionId` | Rename with `display_name`. |
| `POST` | `/api/browser-sessions/:sessionId/pause` | Stop a supported normal browser while retaining its profile. |
| `POST` | `/api/browser-sessions/:sessionId/resume` | Provision a new runtime for a paused profile. |
| `POST` | `/api/browser-sessions/:sessionId/reset` | Restart the running browser runtime. |
| `DELETE` | `/api/browser-sessions/:sessionId` | Destroy the browser and its infrastructure. |
| `GET` | `/api/browser-sessions/:sessionId/proxy` | Read proxy state and verified exit IP when connected. |
| `PATCH` | `/api/browser-sessions/:sessionId/proxy` | Set `proxy_enabled`; no active run may exist. |
| `DELETE` | `/api/browser-sessions/:sessionId/proxy` | Return to a direct connection. |
| `POST` | `/api/browser-sessions/:sessionId/connect-token` | Return a short-lived noVNC `url`, `token`, and `expires_at`. |
| `POST` | `/api/browser-sessions/:sessionId/downloads-access` | Return private file-transfer access metadata. |

Normal-session pause requires shared Downloads sync and a persistent volume. Lifecycle transitions can take time; poll the session instead of issuing the same transition again.

## Runs

Create with `POST /api/browser-sessions/:sessionId/runs`:

| Field | Required | Meaning |
| --- | --- | --- |
| `task` | yes | Natural-language browser objective. |
| `wait` | no | Block until terminal or user input instead of returning `202`. |
| `timeout_ms` | no | Blocking-path timeout. Client-side polling remains preferable for long agent tasks. |
| `tab_id` | no | Target a specific tab; otherwise use the active page. |
| `output_schema` | no | Request validated structured JSON. |

The public run includes `run_id`, `session_id`, `parent_run_id`, `tab_id`, `status`, `result`, `summary`, `final_url`, `error`, `pending_input`, `updates`, and timestamps.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/runs?limit=50&offset=0` | List recent owned run summaries. |
| `POST` | `/api/browser-sessions/:sessionId/runs` | Start a run; asynchronous by default. |
| `GET` | `/api/browser-sessions/:sessionId/runs/:runId` | Refresh and read the latest run snapshot. |
| `POST` | `/api/browser-sessions/:sessionId/runs/:runId/messages` | Continue a finished run as an immutable child on the same tab/conversation. |
| `POST` | `/api/browser-sessions/:sessionId/runs/:runId/responses` | Answer the current `pending_input.clarify_id`. |
| `POST` | `/api/browser-sessions/:sessionId/runs/:runId/abort` | Abort an active run. |
| `GET` | `/api/browser-sessions/:sessionId/runs/:runId/export` | Download a trace for a completed or failed run. |

Statuses are `running`, `needs_user_input`, `completed`, `failed`, `aborting`, and `aborted`. Polling should return on `needs_user_input` as well as terminal states. A run can be continued only after it finishes, and each run can have at most one direct child; append the next turn to the newest child.

For `needs_user_input`, pass this body to `/responses`:

```json
{
  "clarify_id": "the current pending_input.clarify_id",
  "answer": "the user's explicit answer"
}
```

## Structured output

`output_schema` accepts shorthand field maps such as:

```json
{
  "title": "string",
  "price": "number?",
  "available": "boolean",
  "sources": "string[]"
}
```

The supported JSON Schema subset includes `type`, `properties`, `required`, `items`, `enum`, and `additionalProperties`. Validate that a completed run's `result` matches the requested shape before using it downstream.

## Downloads and viewer access

`downloads-access` returns `url`, `username`, `password`, `upload_limit_bytes`, and `expires_at` with `Cache-Control: no-store`. Use HTTP Basic authentication against that URL.

- Send `Accept: application/json` to list files.
- Upload a raw file with `PUT`; existing remote names receive a collision-safe suffix.
- Download with `GET` or `HEAD`; one `Range: bytes=...` is supported.
- Upload responses include `name`, `size`, `sha256`, `storage_backend`, `browser_path`, and `browser_ready`.
- `browser_local` with `browser_ready: true` yields a path the browser can open immediately.
- `shared_object` with `browser_ready: false` remains durable while paused but is not a browser-local path.

Connect-token responses contain short-lived bearer material. Treat the noVNC URL and token as secrets; return them only when the user explicitly asks to watch or control the session.

## CLI command map

All commands read `WEBBRAIN_API_KEY` and optionally `WEBBRAIN_BASE_URL`:

```text
me
list-sessions
create-session [--name TEXT] [--type normal|incognito] [--proxy-enabled true|false]
get-session SESSION_ID
wait-session SESSION_ID [--timeout-ms N] [--poll-ms N]
rename-session SESSION_ID --name TEXT
pause-session SESSION_ID | resume-session SESSION_ID | reset-session SESSION_ID
delete-session SESSION_ID
get-proxy SESSION_ID | set-proxy SESSION_ID --enabled true|false | clear-proxy SESSION_ID
connect-session SESSION_ID
downloads-access SESSION_ID
list-downloads SESSION_ID [--path REMOTE_DIRECTORY]
upload-download SESSION_ID --file LOCAL_PATH [--remote REMOTE_NAME]
download-file SESSION_ID --remote REMOTE_NAME --output LOCAL_PATH [--force]
list-runs [--limit N] [--offset N]
create-run SESSION_ID --task TEXT|--task-file PATH [--schema JSON|@FILE] [--tab-id ID]
get-run SESSION_ID RUN_ID
wait-run SESSION_ID RUN_ID [--timeout-ms N] [--poll-ms N]
continue-run SESSION_ID RUN_ID --task TEXT|--task-file PATH [--schema JSON|@FILE]
respond-run SESSION_ID RUN_ID --clarify-id ID --answer TEXT|--answer-file PATH
abort-run SESSION_ID RUN_ID
export-run SESSION_ID RUN_ID --output PATH [--force]
```

The CLI prints only JSON entity data to stdout. It prints sanitized JSON errors to stderr and never prints the API key.

## Errors and recovery

- On `409` before a run, poll until both session readiness conditions are true.
- On timeout, read the current session or run once before deciding whether to continue polling, abort, or report partial state.
- On `needs_user_input`, do not retry `create-run`; answer the pending clarification.
- On a failed run, export the trace only when useful for diagnosis and keep it in the user's requested workspace.
- On ambiguous network failure after a mutating request, read current state before retrying to avoid duplicate browsers or child runs.

# WebBrain Platform

All-in-one cloud runtime for programmable WebBrain browser sessions.

The repo has two runtime roles:

- `platform`: Express + MySQL control plane for users, API keys, browser sessions, DigitalOcean droplets, run orchestration, and signed noVNC URLs.
- `droplet`: cloud browser runtime that runs the local WebBrain sidecar, connects outbound to the platform control WebSocket, and gates noVNC with signed tokens.

[`webbrain-one/webbrain`](https://github.com/webbrain-one/webbrain) is the canonical WebBrain execution engine cloned into each browser VM.

## Run Locally

```bash
npm install
WEBBRAIN_DB_DRIVER=memory WEBBRAIN_PROVISIONER=null npm run start:platform
```

For the local droplet sidecar/browser pieces:

```bash
npm run start:sidecar
npm run start:browser
npm run start:droplet
```

## Production Configuration

Platform:

- `WEBBRAIN_DB_DRIVER=mysql`
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
- `DO_API_TOKEN`, `DO_REGION`, `DO_SIZE`, `DO_IMAGE`, `DO_SSH_KEYS`
- `WEBBRAIN_PLATFORM_URL`
- `WEBBRAIN_INSTANCE_DOMAIN` (for example, `webbrain.cloud`; serves each browser session at an HTTPS subdomain)
- `WEBBRAIN_REGISTRATION_ENABLED=true` only when public account creation should be available (disabled by default)
- `WEBBRAIN_MODEL_PROXY_BASE_URL`, `WEBBRAIN_MODEL_PROXY_API_KEY`

Production uses `WEBBRAIN_MODEL_PROXY_BASE_URL=https://api.webbrain.one/v1`.
The platform authenticates browser model traffic with the per-session secret,
then replaces that credential before forwarding and assigns a stable,
non-email WebBrain Cloud identity derived from the platform user id.

Droplet cloud-init passes:

- `WEBBRAIN_SESSION_ID`
- `WEBBRAIN_SESSION_TOKEN`
- `WEBBRAIN_PLATFORM_URL`
- `WEBBRAIN_CONTROL_WS_URL`
- `WEBBRAIN_EXTENSION_DIR`
- `WEBBRAIN_PROVIDER_BASE_URL`
- `WEBBRAIN_PROVIDER_API_KEY`
- `WEBBRAIN_NOVNC_SECRET`

## Browser Automation API

The production API is served from `https://webbrain.cloud`. It controls the
same visible browser sessions shown in the dashboard and noVNC.

- Interactive, tabbed guide: [`https://webbrain.cloud/docs`](https://webbrain.cloud/docs)
- Dependency-free clients: [`clients/`](clients/) for Node.js, Python, and PHP

### Authentication

Create an API key from the **API keys** section of the dashboard, then send it
as a bearer token with every API request:

```bash
export WEBBRAIN_API_KEY='wbp_your_key_here'

curl -sS https://webbrain.cloud/api/me \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

API keys carry the same browser-session permissions as the owning user's login
session and cannot access another user's sessions. They are not DigitalOcean or
model-provider credentials. The complete key is displayed only once; store it
securely and revoke it immediately if it is exposed.

The account and key-management endpoints are:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/auth/register` | Create an account and login cookie when registration is enabled. |
| `POST` | `/auth/login` | Create a login cookie. |
| `POST` | `/auth/logout` | Delete the current login session. |
| `GET` | `/api/me` | Return the authenticated user and authentication type. |
| `POST` | `/api/api-keys` | Create an API key. The raw key is returned once. |
| `GET` | `/api/api-keys` | List API-key metadata, never raw secrets. |
| `DELETE` | `/api/api-keys/:keyId` | Revoke an API key. |

### 1. Create a browser session

```bash
curl -sS -X POST \
  https://webbrain.cloud/api/browser-sessions \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"Research"}'
```

The response is `201 Created`:

```json
{
  "browser_session": {
    "id": "bs_0123456789abcdef",
    "status": "provisioning",
    "droplet_id": "123456789",
    "public_ip": null,
    "region": "nyc3",
    "size": "s-2vcpu-4gb",
    "expires_at": "2026-07-13T12:00:00.000Z",
    "created_at": "2026-07-13T06:00:00.000Z",
    "updated_at": "2026-07-13T06:00:00.000Z",
    "droplet_connected": false,
    "extension_connected": false,
    "runtime_ready": false
  }
}
```

Save the returned `id`:

```bash
export WEBBRAIN_SESSION_ID='bs_0123456789abcdef'
```

Provisioning takes time. Poll the session until `runtime_ready` is `true`:

```bash
curl -sS \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

`status: "ready"` means the Droplet is reachable. `runtime_ready: true` also
confirms that the WebBrain extension bridge is connected and can accept runs.

### 2. Start a browser run

Runs are asynchronous by default:

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Open google.com and tell me the page title",
    "wait": false
  }'
```

The response is `202 Accepted` and contains a `run_id`:

```json
{
  "run_id": "run_0123456789abcdef",
  "status": "running",
  "session_id": "bs_0123456789abcdef",
  "result": null,
  "summary": "",
  "final_url": "",
  "error": "",
  "created_at": "2026-07-13T06:05:00.000Z",
  "updated_at": "2026-07-13T06:05:00.000Z",
  "completed_at": null
}
```

Run request fields:

| Field | Required | Description |
| --- | --- | --- |
| `task` | Yes | Natural-language browser task. |
| `wait` | No | When `true`, keep the HTTP request open while polling for a terminal result. Default: `false`. |
| `timeout_ms` | No | Maximum time for the synchronous wait path. A timeout can return the run while it is still running. |
| `tab_id` | No | Chrome tab ID to control. Without it, WebBrain uses the visible active normal webpage. |
| `output_schema` | No | Require a machine-readable result matching the supplied schema. |

Without `tab_id`, the API controls the visible active webpage. Navigation and
page interaction are therefore observable in noVNC.

### 3. Poll or wait for the result

Poll an asynchronous run:

```bash
export WEBBRAIN_RUN_ID='run_0123456789abcdef'

curl -sS \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs/$WEBBRAIN_RUN_ID" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

Run statuses are `running`, `completed`, `failed`, `aborting`, and `aborted`.
Terminal responses put the final answer in `result`, any human-readable detail
in `summary`, the active page in `final_url`, and failure detail in `error`.

For a single blocking request, set `wait` to `true`:

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Open example.com and return the page title",
    "wait": true,
    "timeout_ms": 120000
  }'
```

A completed blocking run returns `200`. If the wait deadline is reached while
the run is still active, the response is `202` and can be polled normally.

### Structured output

Supply `output_schema` when calling code needs a predictable JSON object:

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Open example.com and describe the page",
    "output_schema": {
      "title": "string",
      "summary": "string",
      "links": "string[]"
    },
    "wait": true,
    "timeout_ms": 120000
  }'
```

The schema accepts shorthand values such as `string`, `number`, `integer`,
`boolean`, `object`, `array`, `string[]`, and optional `string?` fields. It also
accepts the supported JSON Schema subset: `type`, `properties`, `required`,
`items`, `enum`, `description`, and `additionalProperties`. A structured run
completes only after WebBrain returns a value that validates against the schema;
the validated object is returned as `result`.

### Abort a run

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs/$WEBBRAIN_RUN_ID/abort" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Abort is cooperative. A run can briefly report `aborting` before becoming
`aborted`.

### Browser-session endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/browser-sessions` | Create a browser using the configured production defaults. |
| `GET` | `/api/browser-sessions` | List the authenticated user's browser sessions. |
| `GET` | `/api/browser-sessions/:sessionId` | Read provisioning and runtime readiness. |
| `PATCH` | `/api/browser-sessions/:sessionId` | Set or clear the browser's `display_name`. |
| `DELETE` | `/api/browser-sessions/:sessionId` | Destroy the browser session and its Droplet. |
| `POST` | `/api/browser-sessions/:sessionId/connect-token` | Create a short-lived signed noVNC URL. |

Destroy a session when it is no longer needed:

```bash
curl -sS -X DELETE \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

Destroyed sessions remain in API history even though the dashboard hides them
by default.

### Errors

Request-level errors use a consistent JSON envelope:

```json
{
  "error": "WebBrain browser runtime is not ready; the extension bridge is not connected."
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `400` | Missing or invalid request fields. |
| `401` | Missing, invalid, or revoked API key. |
| `404` | Session or run does not exist for the authenticated user. |
| `409` | The browser runtime is not ready to accept a run. |
| `500` | The sidecar, extension, or browser run failed. Check `error` for details. |

A blocking run that reaches `failed` or `aborted` returns the normal run object
with a non-empty `error` field rather than the request-error envelope.

## Droplet Internals

Browser VMs use the latest Stable [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing/) build for a reproducible automation runtime. Chrome is launched with its non-interactive infobars disabled and starts on `https://webbrain.one` so the WebBrain extension has normal site access immediately.

The WebBrain extension connects outbound to the local sidecar:

```text
ws://127.0.0.1:17373/extension
```

The droplet role connects outbound to the platform:

```text
ws(s)://<platform>/droplet/control?session_token=<session secret>
```

The command sidecar remains local-only. noVNC is exposed through the droplet gate on `6081` and requires a short-lived signed token from `POST /api/browser-sessions/:sessionId/connect-token`. When `WEBBRAIN_INSTANCE_DOMAIN` is set, the platform proxies noVNC over the wildcard HTTPS hostname `bs-<session-id>.<domain>` so browser assets and WebSockets remain same-site with the dashboard.

Legacy Chrome managed-storage policy example (the VM launcher currently seeds
the same values directly into the isolated browser profile):

```text
config/webbrain-cloud-managed-policy.example.json
```

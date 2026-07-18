# WebBrain Platform

All-in-one cloud runtime for programmable WebBrain browser sessions.

The repo has two runtime roles:

- `platform`: Express + MySQL control plane for users, API keys, browser sessions, DigitalOcean droplets, run orchestration, and signed noVNC URLs.
- `droplet`: cloud browser runtime that runs the local WebBrain sidecar, connects outbound to the platform control WebSocket, and gates noVNC with signed tokens.
- `warm-pool`: prebooted browser VM role that installs Chrome/WebBrain/noVNC and waits for the platform to assign one browser session.

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
- `DO_BROWSER_VOLUME_SIZE_GIB` (defaults to a fixed 2 GiB Chrome-profile volume; volumes are not auto-expanded)
- `WEBBRAIN_WARM_DROPLET_POOL_SIZE` (defaults to `0`; production can set `1` for one prebooted spare)
- `WEBBRAIN_WARM_DROPLET_SIZE` (defaults to `DO_SIZE`, then `s-2vcpu-4gb`)
- `WEBBRAIN_WARM_DROPLET_CLAIM_WAIT_MS` (defaults to `60000`; waits for a creating spare before cold fallback)
- `WEBBRAIN_WARM_DROPLET_CLAIM_POLL_MS` (defaults to `2000`)
- `WEBBRAIN_SPACES_ENDPOINT`, `WEBBRAIN_SPACES_ACCESS_KEY`, `WEBBRAIN_SPACES_SECRET_KEY`, `WEBBRAIN_SPACES_BUCKET`
- `WEBBRAIN_SPACES_S3_REGION` (defaults to `us-east-1`, the S3 signing region used by DigitalOcean Spaces)
- `WEBBRAIN_DOWNLOADS_USER_QUOTA_BYTES` (defaults to 25 GiB fair use per user)
- `WEBBRAIN_DOWNLOADS_MAX_UPLOAD_BYTES` (defaults to 25 GiB)
- `WEBBRAIN_PLATFORM_URL`
- `WEBBRAIN_INSTANCE_DOMAIN` (for example, `webbrain.cloud`; serves each browser session at an HTTPS subdomain)
- `WEBBRAIN_REGISTRATION_ENABLED=true` only when public account creation should be available (disabled by default)
- `WEBBRAIN_MODEL_PROXY_BASE_URL`, `WEBBRAIN_MODEL_PROXY_API_KEY`
- `WEBBRAIN_BROWSER_HOUR_CENTS` (defaults to `10`, or `$0.10` per active browser hour in the pricing and billing UI)
- `WEBBRAIN_BILLING_METER_INTERVAL_MS` (defaults to `60000`; active Droplet-backed browsers are prorated with sub-cent carry)
- `WEBBRAIN_BILLING_ENFORCE_CREDIT=false` (optional emergency override; credit enforcement is enabled by default)
- `WEBBRAIN_UNLIMITED_BILLING_EMAILS` (comma-separated credit-check bypass list; defaults to `esokullu@gmail.com`)
- `STRIPE_SECRET_KEY` (enables dashboard credit checkout)
- `STRIPE_WEBHOOK_SECRET` (verifies `POST /api/billing/stripe-webhook`)
- `WEBBRAIN_BROWSER_PROXY_URL` (optional default authenticated upstream proxy for new browsers)
- `WEBBRAIN_PROXY_VERIFY_URL` (HTTP exit-IP endpoint; defaults to `http://api.ipify.org?format=json`)
- `WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS` (defaults to `10000`)
- `WEBBRAIN_PROXY_BYPASS_LIST` (optional Chrome bypass list; defaults to the platform hostname)
- `WEBBRAIN_EPHEMERAL_GATE_BASE_PORT` (defaults to `6100`; first public noVNC gate reserved for hosted ephemeral browsers)
- `WEBBRAIN_EPHEMERAL_MAX_SESSIONS` (defaults to `1` additional browser per running Droplet)
- `WEBBRAIN_EPHEMERAL_SESSION_TTL_MS` (defaults to 6 hours; applies only to ephemeral browsers)
- `WEBBRAIN_EPHEMERAL_MEMORY_MAX` (defaults to `2G` for each transient runtime)
- `WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES` (defaults to 2 GiB total writable data per temporary browser)
- `WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES` (defaults to 512 MiB per uploaded file in a temporary browser)
- `WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES` (defaults to 1 GiB of temporary Downloads)
- `WEBBRAIN_BROWSER_CLEANUP_INTERVAL_MS` (defaults to `30000`)

Warm spare cost is one normal running Droplet per spare. As of July 2026,
DigitalOcean lists the Basic 2 vCPU / 4 GiB Droplet (`s-2vcpu-4gb`) at
`$24/mo`; verify current pricing before changing pool size:
[`digitalocean.com/pricing/droplets`](https://www.digitalocean.com/pricing/droplets).
DigitalOcean bills powered-off Droplets because compute remains reserved, so
unused warm capacity is destroyed rather than powered down:
[`docs.digitalocean.com/products/droplets/details/pricing/`](https://docs.digitalocean.com/products/droplets/details/pricing/).

The public `/pricing` page and dashboard Billing view use a default customer
rate of `$0.10` per active browser hour. Against the current `$0.03571` hourly
Droplet rate, that leaves room for Stripe fees, standard automation services,
and platform operations. Credit packs are `$10`, `$25`, `$50`, and `$100`.
Stripe Checkout credits are idempotent by Checkout Session id, so the success
redirect and webhook can safely process the same payment. Active Droplet-backed
browsers are prorated against the configured hourly rate; fractional cents carry
forward instead of being rounded away. Empty balances block new browsers and
resume attempts. Customers can explicitly consent to save the card from a
credit purchase and configure an automatic Stripe top-up threshold and amount.
Off-session attempts use a stable idempotency key, retry after one hour on
failure, and surface their status in the Billing view. Running browsers are not
automatically destroyed when a balance is exhausted.

Production uses `WEBBRAIN_MODEL_PROXY_BASE_URL=https://api.webbrain.one/v1`.
The platform authenticates browser model traffic with the per-session secret,
then replaces that credential before forwarding and assigns a stable,
non-email WebBrain Cloud identity derived from the platform user id.

Shared Downloads currently require a single platform writer. Per-user quota
checks and collision-safe filename allocation are serialized in-process; run
one platform process or replica until a distributed lock is added.

Droplet cloud-init passes:

- `WEBBRAIN_SESSION_ID`
- `WEBBRAIN_SESSION_TOKEN`
- `WEBBRAIN_PLATFORM_URL`
- `WEBBRAIN_CONTROL_WS_URL`
- `WEBBRAIN_EXTENSION_DIR`
- `WEBBRAIN_PROVIDER_BASE_URL`
- `WEBBRAIN_PROVIDER_API_KEY`
- `WEBBRAIN_NOVNC_SECRET`
- `WEBBRAIN_BROWSER_PROXY_URL`
- `WEBBRAIN_BROWSER_PROXY_SERVER` (the local relay Chrome uses)
- `WEBBRAIN_BROWSER_PROXY_BYPASS_LIST`
- `WEBBRAIN_PROXY_RELAY_HOST`, `WEBBRAIN_PROXY_RELAY_PORT`, `WEBBRAIN_PROXY_STATE_PATH`
- `WEBBRAIN_PROFILE_DIR`, `WEBBRAIN_PROFILE_MOUNT`, `WEBBRAIN_BROWSER_DISK_CACHE_DIR`
- `WEBBRAIN_DOWNLOADS_SYNC_ENABLED`, `WEBBRAIN_DOWNLOADS_STAGING_DIR`, `WEBBRAIN_DOWNLOADS_INGEST_URL`

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
| `PATCH` | `/api/me` | Change the signed-in user's email and/or password after verifying the current password. Password changes revoke other dashboard sessions. |
| `POST` | `/api/api-keys` | Create an API key. The raw key is returned once. |
| `GET` | `/api/api-keys` | List API-key metadata, never raw secrets. |
| `DELETE` | `/api/api-keys/:keyId` | Revoke an API key. |

### 1. Create a browser session

```bash
curl -sS -X POST \
  https://webbrain.cloud/api/browser-sessions \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"Research","lifecycle":"resumable"}'
```

`lifecycle` accepts `resumable` (the default), `always_on`, or `ephemeral`. Resumable
browsers receive a fixed 2 GiB profile volume and can be paused once shared
Downloads storage is configured. Always-on browsers use the classic single
Droplet layout: Chrome state and Downloads stay on that Droplet, and Pause is
unavailable. Ephemeral browsers reuse one of the user's running resumable or
always-on Droplets without mounting or reading its Chrome profile. Resumable
and always-on browsers do not expire automatically; they remain until explicitly
deleted. Only ephemeral browsers enforce `ttl_ms`.

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
    "profile_mode": "persistent",
    "host_session_id": null,
    "volume": {
      "id": "volume-id",
      "name": "wb-profile-bs-0123456789abcdef",
      "size_gib": 2
    },
    "paused_at": null,
    "expires_at": null,
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

To create an always-on browser, set `lifecycle` to `always_on`. You can also
assign a Webshare upstream while the Droplet is created by including its four
connection values in `proxy`:

```bash
curl -sS -X POST https://webbrain.cloud/api/browser-sessions \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Research",
    "lifecycle": "always_on",
    "proxy": {
      "domain": "p.webshare.io",
      "port": 80,
      "username": "webshare-user",
      "password": "webshare-password"
    }
  }'
```

Chrome always connects to a loopback-only relay. The relay handles upstream
authentication, while API and session responses expose only the credential-free
endpoint and verified exit IP. The initial URL is written to the root-only
Droplet environment by cloud-init; live replacements are stored in a root-only
state file and survive service restarts.

To start a blank ephemeral browser on a running browser's Droplet, pass that
browser as `host_session_id`:

```bash
export WEBBRAIN_HOST_SESSION_ID='bs_existing_host'

curl -sS -X POST https://webbrain.cloud/api/browser-sessions \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"display_name\": \"Private research\",
    \"lifecycle\": \"ephemeral\",
    \"host_session_id\": \"$WEBBRAIN_HOST_SESSION_ID\",
    \"ttl_ms\": 3600000
  }"
```

The host must belong to the same user and be running with its Droplet control
channel connected. A paused resumable browser cannot host a child because its
Droplet no longer exists. New Droplets support hosted ephemeral browsers;
older already-running Droplets must be upgraded or recreated once so their
runtime manager is installed.

An ephemeral browser gets a separate control channel, display, proxy relay,
noVNC gate, Downloads service, and blank Chrome profile. All writable browser
state lives in the service's private, disk-backed `/tmp` namespace; `/run`
holds only the systemd lifetime marker. The runtime uses a dynamic unprivileged
user, cannot access the host's loopback services or persistent profile paths,
and never attaches the host's profile volume. systemd removes the private
temporary namespace after a normal stop or crash. Browser crashes, runtime
manager restarts, host pause/reset/delete, Droplet reboot, and TTL expiry all
end the session instead of restoring it. Downloads are temporary and have a
separate aggregate quota.

Provisioning takes time. Poll the session until `runtime_ready` is `true`:

```bash
curl -sS \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

`status: "ready"` means the Droplet is reachable. `runtime_ready: true` also
confirms that the WebBrain extension bridge is connected and can accept runs.

### Access a browser's Downloads folder

Request the private HTTPS URL and Basic Auth credentials for a ready or paused browser:

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/downloads-access" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The response contains `url`, `username`, `password`, `upload_limit_bytes`, and
`expires_at`, and is marked `Cache-Control: no-store`. Credentials stay fixed
for the session lifetime and stop working when the session is destroyed. Files
use a private per-user shared namespace, so all browsers owned by the same user
see the same Downloads and the URL remains online while a browser is paused.
The default fair-use allowance is 25 GiB per user. The tray supports listing,
downloads (including `HEAD` and byte ranges), and streaming uploads. Name
collisions receive a numbered suffix; delete, rename, and folder creation are
intentionally unavailable.

For terminal use, keep the credential response in shell variables (the literal
password is not written to shell history):

```bash
DOWNLOADS_ACCESS=$(curl --fail-with-body -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/downloads-access" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}')
DOWNLOADS_URL=$(jq -r '.url' <<<"$DOWNLOADS_ACCESS")
DOWNLOADS_USER=$(jq -r '.username' <<<"$DOWNLOADS_ACCESS")
DOWNLOADS_PASSWORD=$(jq -r '.password' <<<"$DOWNLOADS_ACCESS")
```

List files as JSON:

```bash
curl --fail-with-body -sS \
  -u "$DOWNLOADS_USER:$DOWNLOADS_PASSWORD" \
  -H 'Accept: application/json' \
  "$DOWNLOADS_URL" | jq
```

Upload a local file. The JSON response reports the actual stored name, including
an automatic ` (1)` suffix if the requested name already exists:

```bash
LOCAL_FILE='./report.pdf'
REMOTE_NAME=$(jq -rn --arg name "$(basename -- "$LOCAL_FILE")" '$name | @uri')
curl --fail-with-body -sS -X PUT \
  -u "$DOWNLOADS_USER:$DOWNLOADS_PASSWORD" \
  -H 'Content-Type: application/octet-stream' \
  --upload-file "$LOCAL_FILE" \
  "${DOWNLOADS_URL}${REMOTE_NAME}" | jq
```

Download a complete file or a byte range:

```bash
REMOTE_NAME=$(jq -rn --arg name 'report.pdf' '$name | @uri')
curl --fail-with-body -sS \
  -u "$DOWNLOADS_USER:$DOWNLOADS_PASSWORD" \
  --output './report.pdf' \
  "${DOWNLOADS_URL}${REMOTE_NAME}"

curl --fail-with-body -sS \
  -u "$DOWNLOADS_USER:$DOWNLOADS_PASSWORD" \
  -H 'Range: bytes=0-1023' \
  --output './report.first-1KiB' \
  "${DOWNLOADS_URL}${REMOTE_NAME}"
```

The Node.js, Python, and PHP clients wrap these operations with streaming
`listDownloads`/`list_downloads`, `uploadDownloadsFile`/`upload_downloads_file`,
and `downloadDownloadsFile`/`download_downloads_file` helpers. Pass a previously
returned access object to several calls to avoid requesting the same session
credential repeatedly; clients do not cache it on their own.

Chrome downloads first stream to the Droplet's ephemeral root disk. When Chrome
reports completion, the launcher uploads the file to shared storage, verifies
the platform response, and then removes the staged copy. A browser cannot be
paused while a download or its upload is pending. Permanent storage rejections
such as an upload-limit or quota error retain the staged file, stop automatic
retry timers, and surface the rejection when Pause is attempted. After the
limit is corrected, restart the browser service to retry the retained file.

### Pause and resume a browser

For resumable browsers, pausing cleanly stops Chrome, flushes and unmounts its
fixed 2 GiB profile volume, and destroys the billable Droplet while retaining
the volume. Resuming creates a new Droplet, attaches the same volume, and
restores the Chrome profile and saved proxy configuration. Downloads remain
online throughout. Pause is
enabled only after all four `WEBBRAIN_SPACES_*` storage values are configured,
so destroying a Droplet can never discard local-only Downloads.
The running Droplet must also report that sync was enabled when it booted.
Turning on Spaces later does not migrate an existing Droplet's local Downloads
or make that Droplet safe to pause.

Pausing, resetting, deleting, or expiring a host first terminates all of its
ephemeral children and marks their unfinished runs failed. Their volatile
profiles and Downloads cannot be resumed.

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/pause" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H 'Content-Type: application/json' -d '{}'

curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/resume" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

Pause returns `409` if a run or download sync is active. Resume returns `202`
and the session moves through provisioning until `runtime_ready` is true again.

### Change a running browser's proxy

Read the active proxy and last verified exit IP:

```bash
curl -sS \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/proxy" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

Switch upstreams without restarting Chrome or recreating the Droplet:

```bash
curl -sS -X PATCH \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/proxy" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "proxy": {
      "domain": "p.webshare.io",
      "port": 80,
      "username": "next-user",
      "password": "next-password"
    }
  }'
```

The structured form defaults to an HTTP upstream and safely URL-encodes the
Webshare credentials. Generic HTTP, HTTPS, SOCKS4, and SOCKS5 integrations may
send a complete `proxy_url` instead. The relay closes existing connections,
verifies the replacement's exit IP, and rolls back if verification fails.

Delete the proxy configuration to return to a direct connection:

```bash
curl -sS -X DELETE \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/proxy" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY"
```

`PATCH` with `{"proxy_url":null}` remains equivalent. Proxy changes return
`409 Conflict` while a browser run is active; abort or finish the run first so
one task cannot span two network identities.

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
  "parent_run_id": null,
  "tab_id": 42,
  "result": null,
  "summary": "",
  "final_url": "",
  "error": "",
  "updates": [],
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

Run statuses are `running`, `needs_user_input`, `completed`, `failed`,
`aborting`, and `aborted`.
Terminal responses put the final answer in `result`, any human-readable detail
in `summary`, the active page in `final_url`, and failure detail in `error`.
Every run response also includes the newest 200 ordered progress events in
`updates`. Each event has a monotonic `seq`, a `type`, type-specific `data`, and
an ISO timestamp in `ts`.

List historical runs for the authenticated account with `GET /api/runs`. The
response is newest-first and uses `limit` plus `offset` pagination; each item is
a lightweight summary with its task, browser session, status, timestamps, and
recorded event count. Fetch the session-specific run endpoint to reopen the full
result and progress snapshot.

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

A completed blocking run returns `200`. A run that needs an answer returns
`202` immediately with status `needs_user_input`. If the wait deadline is
reached while the run is still active, the response is also `202` and can be
polled normally.

### Respond to requested input

Clarification, permission, and form-submit prompts pause the run with
`needs_user_input`. The response includes a normalized `pending_input` object
with its `clarify_id`, question, choices, and any permission or submit details:

```json
{
  "status": "needs_user_input",
  "pending_input": {
    "clarify_id": "clr_abc123",
    "question": "Which account should I use?",
    "options": ["Personal", "Work"]
  }
}
```

Answer the exact pending clarification to resume the same run:

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs/$WEBBRAIN_RUN_ID/responses" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "clarify_id": "clr_abc123",
    "answer": "Work"
  }'
```

A valid response returns the refreshed run, normally back in `running` state.
Stale, mismatched, or already-answered clarification IDs return `409`. Answers
are delivered to the active agent but are not copied into run progress logs.

### Continue a finished run

Append another turn after a run reaches `completed`, `failed`, or `aborted`:

```bash
curl -sS -X POST \
  "https://webbrain.cloud/api/browser-sessions/$WEBBRAIN_SESSION_ID/runs/$WEBBRAIN_RUN_ID/messages" \
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Now open the first result and summarize it",
    "wait": true,
    "timeout_ms": 120000
  }'
```

This creates a new run rather than changing the finished run. The child
response has its own `run_id`, sets `parent_run_id` to the finished run, and
reuses the same browser tab and WebBrain conversation. The follow-up can keep
working on the current page or navigate somewhere completely different.

Each run can have one direct child, producing a linear conversation history.
To append again, post to the newest child run. Continuing an active or already
continued run returns `409`; an already-continued response includes
`child_run_id`. The request accepts `task`, `wait`, `timeout_ms`, and
`output_schema`. Use `/responses` instead when a run is paused in
`needs_user_input`, because that resumes the existing run rather than creating
a new turn.

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
| `POST` | `/api/browser-sessions` | Create a resumable browser by default, an always-on browser, or an ephemeral browser on a running `host_session_id`. |
| `GET` | `/api/browser-sessions` | List the authenticated user's browser sessions. |
| `GET` | `/api/browser-sessions/:sessionId` | Read provisioning and runtime readiness. |
| `PATCH` | `/api/browser-sessions/:sessionId` | Set or clear the browser's `display_name`. |
| `POST` | `/api/browser-sessions/:sessionId/reset` | Force-restart a persistent browser's Droplet, ending hosted ephemeral children. Resetting an ephemeral browser ends it. |
| `POST` | `/api/browser-sessions/:sessionId/pause` | Safely stop Chrome, retain its 2 GiB profile volume, and destroy the Droplet. |
| `POST` | `/api/browser-sessions/:sessionId/resume` | Create a new Droplet and attach the saved profile volume. |
| `DELETE` | `/api/browser-sessions/:sessionId` | Destroy a persistent browser and its infrastructure, or stop only an ephemeral runtime while retaining its host Droplet. |
| `POST` | `/api/browser-sessions/:sessionId/connect-token` | Create a short-lived signed noVNC URL. |
| `POST` | `/api/browser-sessions/:sessionId/downloads-access` | Create private Downloads URL and Basic Auth credentials. |

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

Downloads use the same HTTPS instance hostname under `/downloads/`. The
platform validates session-specific Basic Auth and serves the user's private
DigitalOcean Spaces prefix directly, so the tray remains available without a
running Droplet. Chrome uses the Droplet root disk only as temporary staging;
completed files are streamed to the platform and removed after confirmation.
The legacy localhost-only Caddy service remains as a compatibility fallback
when Spaces is not configured, and no additional public Droplet port is opened.

Legacy Chrome managed-storage policy example (the VM launcher currently seeds
the same values directly into the isolated browser profile):

```text
config/webbrain-cloud-managed-policy.example.json
```

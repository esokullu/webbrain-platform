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
- `WEBBRAIN_MODEL_PROXY_BASE_URL`, `WEBBRAIN_MODEL_PROXY_API_KEY`

Droplet cloud-init passes:

- `WEBBRAIN_SESSION_ID`
- `WEBBRAIN_SESSION_TOKEN`
- `WEBBRAIN_PLATFORM_URL`
- `WEBBRAIN_CONTROL_WS_URL`
- `WEBBRAIN_EXTENSION_DIR`
- `WEBBRAIN_PROVIDER_BASE_URL`
- `WEBBRAIN_PROVIDER_API_KEY`
- `WEBBRAIN_NOVNC_SECRET`

## Platform API

Auth:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /api/me`
- `POST /api/api-keys`
- `GET /api/api-keys`
- `DELETE /api/api-keys/:keyId`

Browser sessions:

- `POST /api/browser-sessions`
- `GET /api/browser-sessions`
- `GET /api/browser-sessions/:sessionId`
- `DELETE /api/browser-sessions/:sessionId`
- `POST /api/browser-sessions/:sessionId/connect-token`

Runs:

- `POST /api/browser-sessions/:sessionId/runs`
- `GET /api/browser-sessions/:sessionId/runs/:runId`
- `POST /api/browser-sessions/:sessionId/runs/:runId/abort`

Example run:

```json
{
  "task": "Go to nytimes.com/... and summarize the article",
  "output_schema": {
    "title": "string",
    "summary": "string",
    "key_points": "string[]"
  },
  "wait": true,
  "timeout_ms": 120000
}
```

## Droplet Internals

The WebBrain extension connects outbound to the local sidecar:

```text
ws://127.0.0.1:17373/extension
```

The droplet role connects outbound to the platform:

```text
ws(s)://<platform>/droplet/control?session_token=<session secret>
```

The command sidecar remains local-only. noVNC is exposed through the droplet gate on `6081` and requires a short-lived signed token from `POST /api/browser-sessions/:sessionId/connect-token`. When `WEBBRAIN_INSTANCE_DOMAIN` is set, the platform proxies noVNC over the wildcard HTTPS hostname `bs-<session-id>.<domain>` so browser assets and WebSockets remain same-site with the dashboard.

Chrome managed storage example:

```text
config/webbrain-cloud-managed-policy.example.json
```

# WebBrain Cloud Execution Bridge

Local-only v1 sidecar for managed cloud browser droplets.

```bash
npm install
npm run start:sidecar
```

In a second process on the droplet, launch the managed browser profile:

```bash
npm run start:browser
```

Useful browser bootstrap environment variables:

- `WEBBRAIN_SESSION_ID`: browser-session/profile name. Defaults to `default`.
- `WEBBRAIN_PROFILE_DIR`: persistent Chromium user data dir.
- `WEBBRAIN_EXTENSION_DIR`: unpacked WebBrain Chrome extension dir. Defaults to `../webbrain3/src/chrome`.
- `WEBBRAIN_SIDECAR_WS_URL`: extension bridge URL. Defaults to `ws://127.0.0.1:17373/extension`.
- `WEBBRAIN_PROVIDER_BASE_URL`, `WEBBRAIN_PROVIDER_API_KEY`, `WEBBRAIN_PROVIDER_MODEL`: WebBrain Platform model/proxy settings.
- `WEBBRAIN_TRACING_ENABLED`: `true` by default for cloud debugging.

The WebBrain extension connects outbound to:

```text
ws://127.0.0.1:17373/extension
```

REST endpoints:

- `POST /runs`
- `GET /runs/:runId`
- `POST /runs/:runId/abort`
- `POST /api/browser-sessions/:sessionId/runs`
- `GET /api/browser-sessions/:sessionId/runs/:runId`
- `POST /api/browser-sessions/:sessionId/runs/:runId/abort`

Example:

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

The extension also accepts Chrome managed storage under `webbrainCloud`; see
`config/webbrain-cloud-managed-policy.example.json`. The local bootstrap script
uses CDP to preseed the same settings for development and simple droplets.

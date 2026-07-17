# WebBrain Cloud clients

Small, dependency-free clients for the browser automation API at
`https://webbrain.cloud`.

| Runtime | File | Requirement |
| --- | --- | --- |
| Node.js | [`node/README.md`](node/README.md) | Node.js 18+ |
| Python | [`python/README.md`](python/README.md) | Python 3.9+ |
| PHP | [`php/README.md`](php/README.md) | PHP 8.1+ with cURL |

Each client supports browser-session creation, force reset, pause, resume, and deletion, readiness polling,
startup and live proxy assignment, run creation and polling, structured output,
finished-run follow-up turns, aborting, signed noVNC links, and private
Downloads access that remains available while browsers are paused.
All three clients also provide streaming Downloads listing, upload, full-file
download, and byte-range download helpers, with collision-safe server naming
and no-overwrite local saves by default.
See the public API guide at `https://webbrain.cloud/docs` for complete examples.

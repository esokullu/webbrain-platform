# WebBrain Cloud clients

Small, dependency-free clients for the browser automation API at
`https://webbrain.cloud`.

| Runtime | File | Requirement |
| --- | --- | --- |
| Node.js | [`node/webbrain-client.js`](node/webbrain-client.js) | Node.js 18+ |
| Python | [`python/webbrain_client.py`](python/webbrain_client.py) | Python 3.9+ |
| PHP | [`php/WebBrainClient.php`](php/WebBrainClient.php) | PHP 8.1+ with cURL |

Each client supports browser-session creation and deletion, readiness polling,
run creation and polling, structured output, aborting, and signed noVNC links.
See the public API guide at `https://webbrain.cloud/docs` for complete examples.

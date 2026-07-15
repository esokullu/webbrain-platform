# WebBrain Cloud client for Node.js

Dependency-free ESM client for Node.js 18 and newer. It uses the built-in
`fetch` implementation.

## Setup

Copy [`webbrain-client.js`](webbrain-client.js) into your project and set your
dashboard API key:

```bash
export WEBBRAIN_API_KEY='wbp_your_key_here'
```

## Create a browser and run a task

```js
import { WebBrainClient } from './webbrain-client.js';

const client = new WebBrainClient({
  apiKey: process.env.WEBBRAIN_API_KEY,
});

const session = await client.createBrowserSession({
  display_name: 'Research',
});
const ready = await client.waitForBrowserSession(session.id);
const downloads = await client.createDownloadsAccess(ready.id);
// downloads contains the private URL, username, password, limit, and expiry.
await client.updateBrowserProxy(ready.id, {
  proxy: {
    domain: 'p.webshare.io',
    port: 80,
    username: 'webshare-user',
    password: 'webshare-password',
  },
});
const run = await client.createRun(ready.id, {
  task: 'Open example.com and return the page title',
});
let finished = await client.waitForRun(ready.id, run.run_id);
if (finished.status === 'needs_user_input') {
  finished = await client.respondToRun(
    ready.id,
    run.run_id,
    finished.pending_input.clarify_id,
    'Work',
  );
  finished = await client.waitForRun(ready.id, run.run_id);
}

console.log(finished.result);

const followUp = await client.continueRun(ready.id, finished.run_id, {
  task: 'Now open the first link and summarize it',
});
console.log((await client.waitForRun(ready.id, followUp.run_id)).result);
```

`continueRun` creates a child run with `parent_run_id` and reuses the same tab
and WebBrain conversation. Append later turns to the newest child run.

## Structured output

```js
const run = await client.createRun(session.id, {
  task: 'Return the title and visible links',
  outputSchema: {
    title: 'string',
    links: 'string[]',
  },
});
```

## Main methods

- `listBrowserSessions()`
- `createBrowserSession(options)`
- `getBrowserSession(sessionId)`
- `updateBrowserSession(sessionId, { displayName })`
- `getBrowserProxy(sessionId)`
- `updateBrowserProxy(sessionId, { proxyUrl })` or `{ proxy: { domain, port, username, password } }`
- `deleteBrowserProxy(sessionId)`
- `waitForBrowserSession(sessionId, options)`
- `deleteBrowserSession(sessionId)`
- `createRun(sessionId, options)`
- `getRun(sessionId, runId)`
- `continueRun(sessionId, runId, options)`
- `respondToRun(sessionId, runId, clarifyId, answer)`
- `waitForRun(sessionId, runId, options)`
- `abortRun(sessionId, runId)`
- `createConnectToken(sessionId, options)`
- `createDownloadsAccess(sessionId)`

Failed HTTP requests throw `WebBrainApiError` with `status` and `body`
properties.

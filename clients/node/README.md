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
  lifecycle: 'resumable', // or 'always_on' for a classic single-Droplet browser
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

Pause destroys the Droplet but retains the fixed 2 GiB Chrome profile volume;
resume attaches it to a new Droplet. Shared Downloads stay available:

```js
await client.pauseBrowserSession(ready.id);
await client.listDownloads(ready.id);
await client.resumeBrowserSession(ready.id);
await client.waitForBrowserSession(ready.id);
```

## Downloads transfers

The transfer helpers stream file bodies instead of buffering them in memory.
Reuse one access response for a batch of operations:

```js
const access = await client.createDownloadsAccess(ready.id);

const uploaded = await client.uploadDownloadsFile(
  ready.id,
  './report.pdf',
  { remotePath: 'report.pdf', access },
);
console.log(uploaded.name); // May be "report (1).pdf" on a collision.

const listing = await client.listDownloads(ready.id, { access });
console.log(listing.entries);

await client.downloadDownloadsFile(
  ready.id,
  uploaded.name,
  './saved/report.pdf',
  { access },
);

await client.downloadDownloadsFile(
  ready.id,
  uploaded.name,
  './saved/report-first-1KiB',
  { access, range: 'bytes=0-1023' },
);
```

If `access` is omitted, each helper calls `createDownloadsAccess` itself. A
download will not replace an existing local file unless `overwrite: true` is
explicitly supplied. Remote paths reject traversal, dotfile, and control
character segments.

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
- `pauseBrowserSession(sessionId)`
- `resumeBrowserSession(sessionId)`
- `createRun(sessionId, options)`
- `getRun(sessionId, runId)`
- `continueRun(sessionId, runId, options)`
- `respondToRun(sessionId, runId, clarifyId, answer)`
- `waitForRun(sessionId, runId, options)`
- `abortRun(sessionId, runId)`
- `createConnectToken(sessionId, options)`
- `createDownloadsAccess(sessionId)`
- `listDownloads(sessionId, options)`
- `uploadDownloadsFile(sessionId, localPath, options)`
- `downloadDownloadsFile(sessionId, remotePath, destinationPath, options)`

Failed HTTP requests throw `WebBrainApiError` with `status` and `body`
properties.

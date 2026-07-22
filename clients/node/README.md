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
  type: 'normal', // or 'incognito', matching the dashboard
  proxy_enabled: false,
});
const ready = await client.waitForBrowserSession(session.id);
const downloads = await client.createDownloadsAccess(ready.id);
// downloads contains the private URL, username, password, limit, and expiry.
await client.updateBrowserProxy(ready.id, { enabled: true });
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

Use `resetBrowserSession` to hard power-cycle the current Droplet without
deleting the browser session or profile. Any active run is marked failed:

```js
await client.resetBrowserSession(ready.id);
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
  { remotePath: 'report.pdf', access, browserLocal: true },
);
console.log(uploaded.name);         // May be "report (1).pdf" on a collision.
console.log(uploaded.browser_path); // Real path in this ready browser.
console.log(uploaded.browser_ready);

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

`browserLocal: true` uploads directly to the ready, running browser and returns
its absolute Downloads path. Omit it to use durable shared object storage; that
default remains accessible while paused but returns `browser_path: null`.

If `access` is omitted, each helper calls `createDownloadsAccess` itself. A
download will not replace an existing local file unless `overwrite: true` is
explicitly supplied. Remote paths reject traversal, dotfile, and control
character segments.

## Structured output

```js
const run = await client.createRun(session.id, {
  task: 'Return the title and visible links',
  capture: 'video',
  outputSchema: {
    title: 'string',
    links: 'string[]',
  },
});
```

When `capture: 'video'` is set, the extension records the active run tab without
microphone audio and saves `webbrain-ci-<run_id>.webm` in browser Downloads.
Use the Downloads helpers to retrieve it after the run completes.

## Main methods

- `listBrowserSessions()`
- `createBrowserSession(options)`
- `getBrowserSession(sessionId)`
- `updateBrowserSession(sessionId, { displayName })`
- `getBrowserProxy(sessionId)`
- `updateBrowserProxy(sessionId, { enabled })`
- `deleteBrowserProxy(sessionId)`
- `waitForBrowserSession(sessionId, options)`
- `deleteBrowserSession(sessionId)`
- `resetBrowserSession(sessionId)`
- `pauseBrowserSession(sessionId)`
- `resumeBrowserSession(sessionId)`
- `createWorkflow({ name, sourceSessionId, sourceRunId })`
- `listWorkflows(options)` / `getWorkflow(workflowId)`
- `renameWorkflow(workflowId, name)` / `deleteWorkflow(workflowId)`
- `createRun(sessionId, options)`
- `createWorkflowRun(sessionId, workflowId, options)`
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

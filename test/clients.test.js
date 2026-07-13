import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebBrainApiError, WebBrainClient } from '../clients/node/webbrain-client.js';

test('Node.js client sends authenticated session and run requests', async () => {
  const requests = [];
  let runPolls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/browser-sessions') {
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', status: 'provisioning' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test') {
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', status: 'ready', runtime_ready: true } }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/browser-sessions/bs_test') {
      res.end(JSON.stringify({ browser_session: { id: 'bs_test', display_name: JSON.parse(rawBody).display_name } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/runs') {
      res.statusCode = 202;
      res.end(JSON.stringify({ run_id: 'run_test', status: 'running' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test/runs/run_test') {
      runPolls += 1;
      res.end(JSON.stringify(runPolls < 2
        ? { run_id: 'run_test', status: 'running' }
        : { run_id: 'run_test', status: 'completed', result: 'Example Domain' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const client = new WebBrainClient({
      apiKey: 'wbp_test',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });
    const session = await client.createBrowserSession();
    assert.equal(session.id, 'bs_test');
    const ready = await client.waitForBrowserSession(session.id, { pollIntervalMs: 1, timeoutMs: 1000 });
    assert.equal(ready.runtime_ready, true);
    const renamed = await client.updateBrowserSession(ready.id, { displayName: 'Research' });
    assert.equal(renamed.display_name, 'Research');
    const run = await client.createRun(ready.id, {
      task: 'Open example.com',
      tabId: 42,
      outputSchema: { title: 'string' },
    });
    const finished = await client.waitForRun(session.id, run.run_id, { pollIntervalMs: 1, timeoutMs: 1000 });
    assert.equal(finished.result, 'Example Domain');
    assert.equal(requests.every(entry => entry.authorization === 'Bearer wbp_test'), true);
    assert.deepEqual(requests[3].body, {
      task: 'Open example.com',
      wait: false,
      tab_id: 42,
      output_schema: { title: 'string' },
    });

    await assert.rejects(
      () => client.getBrowserSession('missing'),
      error => error instanceof WebBrainApiError && error.status === 404 && error.message === 'Not found'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Python and PHP clients expose the shared browser automation operations', async () => {
  const python = await readFile(new URL('../clients/python/webbrain_client.py', import.meta.url), 'utf8');
  const php = await readFile(new URL('../clients/php/WebBrainClient.php', import.meta.url), 'utf8');
  for (const method of ['create_browser_session', 'update_browser_session', 'wait_for_browser_session', 'create_run', 'get_run', 'abort_run', 'wait_for_run']) {
    assert.match(python, new RegExp(`def ${method}\\(`));
  }
  for (const method of ['createBrowserSession', 'updateBrowserSession', 'waitForBrowserSession', 'createRun', 'getRun', 'abortRun', 'waitForRun']) {
    assert.match(php, new RegExp(`function ${method}\\(`));
  }
  assert.match(python, /Authorization.*Bearer/);
  assert.match(php, /Authorization: Bearer/);

  const readmes = await Promise.all([
    readFile(new URL('../clients/node/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../clients/python/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../clients/php/README.md', import.meta.url), 'utf8'),
  ]);
  for (const readme of readmes) {
    assert.match(readme, /Create a browser and run a task/);
    assert.match(readme, /Structured output/);
  }
});

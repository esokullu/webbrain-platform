import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('.agents/skills/webbrain-cloud/scripts/webbrain.mjs');

async function runCli(args, env = {}, options = {}) {
  return await execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    ...options,
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

async function startMockApi() {
  const requests = [];
  let sessionReads = 0;
  let runReads = 0;
  const server = http.createServer(async (req, res) => {
    const body = ['POST', 'PATCH'].includes(req.method) ? await readJsonBody(req) : undefined;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET' && req.url === '/downloads/' && req.headers.authorization === 'Basic d2ViYnJhaW46cHJpdmF0ZQ==') {
      res.end(JSON.stringify({ files: [{ name: 'report.pdf', size: 42 }] }));
      return;
    }
    if (req.headers.authorization !== 'Bearer test-webbrain-key') {
      res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/me') {
      res.end(JSON.stringify({ user: { id: 'user_1' }, auth_type: 'api_key' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions') {
      res.statusCode = 201;
      res.end(JSON.stringify({
        browser_session: {
          id: 'bs_test',
          display_name: body.display_name,
          profile_mode: body.type,
          status: 'provisioning',
          runtime_ready: false,
        },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test') {
      sessionReads += 1;
      res.end(JSON.stringify({
        browser_session: {
          id: 'bs_test',
          status: sessionReads > 1 ? 'ready' : 'provisioning',
          runtime_ready: sessionReads > 1,
        },
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/runs') {
      res.statusCode = 202;
      res.end(JSON.stringify({ run_id: 'run_test', session_id: 'bs_test', status: 'running' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/browser-sessions/bs_test/runs/run_test') {
      runReads += 1;
      res.end(JSON.stringify({
        run_id: 'run_test',
        session_id: 'bs_test',
        status: runReads > 1 ? 'completed' : 'running',
        result: runReads > 1 ? { title: 'Example Domain' } : null,
        final_url: runReads > 1 ? 'https://example.com/' : '',
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/browser-sessions/bs_test/downloads-access') {
      const address = server.address();
      res.end(JSON.stringify({
        url: `http://127.0.0.1:${address.port}/downloads/`,
        username: 'webbrain',
        password: 'private',
        upload_limit_bytes: 1024,
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/workflows/import') {
      res.statusCode = 201;
      res.end(JSON.stringify({ workflow: { ...body.definition, id: 'wfl_imported', name: body.name || body.definition.name } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/workflows/wfl_imported/export') {
      res.end(JSON.stringify({ schema: 'webbrain-workflow/1', id: 'wfl_imported', name: 'Portable' }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('WebBrain skill CLI documents commands without requiring a key', async () => {
  const { stdout, stderr } = await runCli(['help'], { WEBBRAIN_API_KEY: '' });
  assert.match(stdout, /create-session/);
  assert.match(stdout, /respond-run/);
  assert.match(stdout, /workflows import FILE/);
  assert.match(stdout, /WEBBRAIN_API_KEY/);
  assert.equal(stderr, '');
});

test('WebBrain skill CLI drives the create, readiness, and run workflow', async () => {
  const mock = await startMockApi();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webbrain-workflow-cli-'));
  const env = {
    WEBBRAIN_API_KEY: 'test-webbrain-key',
    WEBBRAIN_BASE_URL: mock.baseUrl,
  };
  try {
    const me = await runCli(['me'], env);
    assert.deepEqual(JSON.parse(me.stdout), { user: { id: 'user_1' }, auth_type: 'api_key' });

    const created = await runCli([
      'create-session', '--type', 'incognito', '--name', 'CLI test', '--proxy-enabled', 'false',
    ], env);
    assert.equal(JSON.parse(created.stdout).id, 'bs_test');

    const ready = await runCli(['wait-session', 'bs_test', '--poll-ms', '250', '--timeout-ms', '2000'], env);
    assert.equal(JSON.parse(ready.stdout).runtime_ready, true);

    const started = await runCli([
      'create-run', 'bs_test', '--task', 'Read the title', '--schema', '{"title":"string"}',
    ], env);
    assert.equal(JSON.parse(started.stdout).run_id, 'run_test');

    const finished = await runCli(['wait-run', 'bs_test', 'run_test', '--poll-ms', '250', '--timeout-ms', '2000'], env);
    assert.deepEqual(JSON.parse(finished.stdout).result, { title: 'Example Domain' });

    const downloads = await runCli(['list-downloads', 'bs_test'], env);
    assert.deepEqual(JSON.parse(downloads.stdout), { files: [{ name: 'report.pdf', size: 42 }] });

    const workflowInput = path.join(directory, 'portable.json');
    const workflowOutput = path.join(directory, 'cloud-copy.json');
    await writeFile(workflowInput, JSON.stringify({ schema: 'webbrain-workflow/1', name: 'Portable' }));
    const imported = await runCli(['workflows', 'import', workflowInput, '--name', 'Cloud copy'], env);
    assert.equal(JSON.parse(imported.stdout).id, 'wfl_imported');
    await runCli(['workflows', 'export', 'wfl_imported', '--output', workflowOutput], env);
    assert.equal(JSON.parse(await readFile(workflowOutput, 'utf8')).id, 'wfl_imported');
    const defaultExport = path.join(directory, 'Portable.webbrain-workflow.json');
    await runCli(['workflows', 'export', 'wfl_imported'], env, { cwd: directory });
    assert.equal(JSON.parse(await readFile(defaultExport, 'utf8')).id, 'wfl_imported');

    const createRequest = mock.requests.find(request => request.url === '/api/browser-sessions');
    assert.deepEqual(createRequest.body, {
      type: 'incognito',
      display_name: 'CLI test',
      proxy_enabled: false,
    });
    const runRequest = mock.requests.find(request => request.url.endsWith('/runs') && request.method === 'POST');
    assert.deepEqual(runRequest.body, {
      task: 'Read the title',
      output_schema: { title: 'string' },
    });
    assert.doesNotMatch(`${me.stdout}${created.stdout}${ready.stdout}${started.stdout}${finished.stdout}${downloads.stdout}`, /test-webbrain-key|private/);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('WebBrain skill CLI fails safely when its API key is missing', async () => {
  await assert.rejects(
    runCli(['me'], { WEBBRAIN_API_KEY: '', WEBBRAIN_BASE_URL: 'https://example.invalid' }),
    error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /WEBBRAIN_API_KEY is not set/);
      assert.doesNotMatch(error.stderr, /authorization/i);
      return true;
    },
  );
});

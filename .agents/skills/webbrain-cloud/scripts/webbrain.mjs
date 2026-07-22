#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const WAIT_RUN_STATUSES = new Set(['completed', 'failed', 'aborted', 'needs_user_input']);
const BASE_URL = String(process.env.WEBBRAIN_BASE_URL || 'https://webbrain.cloud').replace(/\/+$/, '');
const API_KEY = process.env.WEBBRAIN_API_KEY || '';

const HELP = `WebBrain Cloud agent CLI

Usage:
  webbrain.mjs me
  webbrain.mjs list-sessions
  webbrain.mjs create-session [--name TEXT] [--type normal|incognito] [--proxy-enabled true|false]
  webbrain.mjs get-session SESSION_ID
  webbrain.mjs wait-session SESSION_ID [--timeout-ms N] [--poll-ms N]
  webbrain.mjs rename-session SESSION_ID --name TEXT
  webbrain.mjs pause-session|resume-session|reset-session|delete-session SESSION_ID
  webbrain.mjs get-proxy SESSION_ID
  webbrain.mjs set-proxy SESSION_ID --enabled true|false
  webbrain.mjs clear-proxy|connect-session|downloads-access SESSION_ID
  webbrain.mjs list-downloads SESSION_ID [--path REMOTE_DIRECTORY]
  webbrain.mjs upload-download SESSION_ID --file LOCAL_PATH [--remote REMOTE_NAME]
  webbrain.mjs download-file SESSION_ID --remote REMOTE_NAME --output LOCAL_PATH [--force]
  webbrain.mjs list-runs [--limit N] [--offset N]
  webbrain.mjs list-workflows [--limit N] [--offset N]
  webbrain.mjs create-workflow SOURCE_SESSION_ID SOURCE_RUN_ID --name TEXT
  webbrain.mjs workflows import FILE [--name TEXT]
  webbrain.mjs workflows export WORKFLOW_ID [--output PATH] [--force]
  webbrain.mjs get-workflow|delete-workflow WORKFLOW_ID
  webbrain.mjs rename-workflow WORKFLOW_ID --name TEXT
  webbrain.mjs create-workflow-run SESSION_ID WORKFLOW_ID [--parameters JSON|@FILE] [--tab-id ID]
  webbrain.mjs create-run SESSION_ID --task TEXT|--task-file PATH [--schema JSON|@FILE] [--tab-id ID]
  webbrain.mjs get-run|wait-run SESSION_ID RUN_ID [--timeout-ms N] [--poll-ms N]
  webbrain.mjs continue-run SESSION_ID RUN_ID --task TEXT|--task-file PATH [--schema JSON|@FILE]
  webbrain.mjs respond-run SESSION_ID RUN_ID --clarify-id ID --answer TEXT|--answer-file PATH
  webbrain.mjs abort-run SESSION_ID RUN_ID
  webbrain.mjs export-run SESSION_ID RUN_ID --output PATH [--force]

Environment:
  WEBBRAIN_API_KEY   Required bearer key. Never pass it as an argument.
  WEBBRAIN_BASE_URL  Optional trusted deployment; defaults to https://webbrain.cloud.
`;

class CliError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.status = status;
    this.body = body;
  }
}

function parseArguments(values) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!key) throw new CliError('Invalid empty option');
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new CliError(`${label} is required`);
  }
  return String(value);
}

function workflowExportFilename(value) {
  const stem = String(value || 'workflow')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120) || 'workflow';
  return `${stem}.webbrain-workflow.json`;
}

function integerOption(options, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (options[key] === undefined) return fallback;
  const value = Number(options[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CliError(`--${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function booleanOption(options, key) {
  if (options[key] === undefined) return undefined;
  if (options[key] === true || options[key] === 'true') return true;
  if (options[key] === 'false') return false;
  throw new CliError(`--${key} must be true or false`);
}

function entityPath(sessionId, suffix = '') {
  return `/api/browser-sessions/${encodeURIComponent(required(sessionId, 'SESSION_ID'))}${suffix}`;
}

function validatedBaseUrl(value = BASE_URL) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('WEBBRAIN_BASE_URL is invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('WEBBRAIN_BASE_URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new CliError('WEBBRAIN_BASE_URL must be an origin without credentials, a path, query, or fragment');
  }
  return url.origin;
}

async function api(method, path, body, { raw = false } = {}) {
  if (!API_KEY) throw new CliError('WEBBRAIN_API_KEY is not set');
  const response = await fetch(`${validatedBaseUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new CliError(parsed?.error || `WebBrain API request failed with status ${response.status}`, {
      status: response.status,
      body: parsed,
    });
  }
  return raw ? text : parsed;
}

async function downloadsAccess(sessionId) {
  const access = await api('POST', entityPath(sessionId, '/downloads-access'), {});
  if (!access?.url || !access?.username || !access?.password) {
    throw new CliError('Downloads access response is incomplete');
  }
  downloadsBaseUrl(access.url);
  return access;
}

function downloadsBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new CliError('Downloads access URL is invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('Downloads access URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError('Downloads access URL cannot contain credentials, a query, or a fragment');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function downloadsUrl(access, remotePath = '', { directory = false } = {}) {
  const input = String(remotePath || '');
  const segments = input ? input.split('/') : [];
  if (segments.some(segment => !segment
      || segment === '.'
      || segment === '..'
      || segment.startsWith('.')
      || /[\\\0\r\n\u0000-\u001f\u007f]/.test(segment))) {
    throw new CliError('Downloads path contains a forbidden segment');
  }
  const suffix = segments.map(segment => encodeURIComponent(segment)).join('/');
  return downloadsBaseUrl(access.url) + suffix + (directory && suffix ? '/' : '');
}

async function downloadsRequest(access, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    headers: {
      authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.ok) return response;
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  throw new CliError(body?.error || text || `Downloads request failed with status ${response.status}`, {
    status: response.status,
    body,
  });
}

async function listDownloads(sessionId, options) {
  const access = await downloadsAccess(sessionId);
  const response = await downloadsRequest(access, downloadsUrl(access, options.path || '', { directory: true }), {
    headers: { accept: 'application/json' },
  });
  return await response.json();
}

async function uploadDownload(sessionId, options) {
  const localPath = required(options.file, '--file');
  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) throw new CliError('--file must point to a regular file');
  const access = await downloadsAccess(sessionId);
  if (access.upload_limit_bytes && fileStat.size > Number(access.upload_limit_bytes)) {
    throw new CliError('File exceeds the Downloads upload limit', { status: 413 });
  }
  const remotePath = options.remote || path.basename(localPath);
  const response = await downloadsRequest(access, downloadsUrl(access, remotePath), {
    method: 'PUT',
    headers: {
      'content-length': String(fileStat.size),
      'content-type': 'application/octet-stream',
    },
    body: createReadStream(localPath),
    duplex: 'half',
  });
  return await response.json();
}

async function downloadFile(sessionId, options) {
  const remotePath = required(options.remote, '--remote');
  const output = required(options.output, '--output');
  if (existsSync(output) && options.force !== true) {
    throw new CliError(`Refusing to overwrite ${output}; pass --force to replace it`);
  }
  const access = await downloadsAccess(sessionId);
  const response = await downloadsRequest(access, downloadsUrl(access, remotePath));
  if (!response.body) throw new CliError('Downloads response did not include a body');
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const temporary = path.join(
    path.dirname(path.resolve(output)),
    `.${path.basename(output)}.webbrain-${process.pid}-${randomBytes(6).toString('hex')}.part`,
  );
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (options.force === true) {
      await rm(output, { force: true });
      await rename(temporary, output);
    } else {
      await link(temporary, output);
      await unlink(temporary);
    }
    const saved = await stat(output);
    return {
      path: output,
      size: saved.size,
      content_type: response.headers.get('content-type'),
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function jsonOption(value, label) {
  if (value === undefined) return undefined;
  const source = String(value).startsWith('@')
    ? await readFile(required(String(value).slice(1), `${label} file`), 'utf8')
    : String(value);
  try {
    return JSON.parse(source);
  } catch {
    throw new CliError(`${label} must be valid JSON or @FILE`);
  }
}

async function textInput(options, directKey, fileKey, label) {
  if (options[directKey] !== undefined && options[fileKey] !== undefined) {
    throw new CliError(`Use either --${directKey} or --${fileKey}, not both`);
  }
  if (options[fileKey] !== undefined) {
    return required(await readFile(required(options[fileKey], `--${fileKey}`), 'utf8'), label).trim();
  }
  return required(options[directKey], `--${directKey}`).trim();
}

async function waitForSession(sessionId, options) {
  const timeoutMs = integerOption(options, 'timeout-ms', 300_000, { min: 1 });
  const pollMs = integerOption(options, 'poll-ms', 2_000, { min: 250 });
  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() <= deadline) {
    session = (await api('GET', entityPath(sessionId))).browser_session;
    if (session?.runtime_ready === true) return session;
    if (['failed', 'destroyed'].includes(session?.status)) {
      throw new CliError(`Browser session entered ${session.status}`, { body: session });
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  throw new CliError(`Browser session was not ready within ${timeoutMs}ms`, { body: session });
}

async function waitForRun(sessionId, runId, options) {
  const timeoutMs = integerOption(options, 'timeout-ms', 120_000, { min: 1 });
  const pollMs = integerOption(options, 'poll-ms', 1_000, { min: 250 });
  const path = entityPath(sessionId, `/runs/${encodeURIComponent(required(runId, 'RUN_ID'))}`);
  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() <= deadline) {
    run = await api('GET', path);
    if (WAIT_RUN_STATUSES.has(run?.status)) return run;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  throw new CliError(`Run did not reach a return state within ${timeoutMs}ms`, { body: run });
}

async function runPayload(options) {
  const task = await textInput(options, 'task', 'task-file', 'task');
  const outputSchema = await jsonOption(options.schema, '--schema');
  return {
    task,
    ...(options['tab-id'] === undefined ? {} : { tab_id: options['tab-id'] }),
    ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const { positionals, options } = parseArguments(rest);
  const sessionId = positionals[0];
  const runId = positionals[1];

  switch (command) {
    case 'me':
      print(await api('GET', '/api/me'));
      break;
    case 'list-sessions':
      print((await api('GET', '/api/browser-sessions')).browser_sessions);
      break;
    case 'create-session': {
      const type = options.type || 'normal';
      if (!['normal', 'incognito'].includes(type)) throw new CliError('--type must be normal or incognito');
      const proxyEnabled = booleanOption(options, 'proxy-enabled');
      const response = await api('POST', '/api/browser-sessions', {
        type,
        ...(options.name === undefined ? {} : { display_name: options.name }),
        ...(proxyEnabled === undefined ? {} : { proxy_enabled: proxyEnabled }),
      });
      print(response.browser_session);
      break;
    }
    case 'get-session':
      print((await api('GET', entityPath(sessionId))).browser_session);
      break;
    case 'wait-session':
      print(await waitForSession(sessionId, options));
      break;
    case 'rename-session':
      print((await api('PATCH', entityPath(sessionId), { display_name: required(options.name, '--name') })).browser_session);
      break;
    case 'pause-session':
    case 'resume-session':
    case 'reset-session': {
      const action = command.replace('-session', '');
      print((await api('POST', entityPath(sessionId, `/${action}`), {})).browser_session);
      break;
    }
    case 'delete-session':
      print((await api('DELETE', entityPath(sessionId))).browser_session);
      break;
    case 'get-proxy':
      print(await api('GET', entityPath(sessionId, '/proxy')));
      break;
    case 'set-proxy': {
      const enabled = booleanOption(options, 'enabled');
      if (enabled === undefined) throw new CliError('--enabled is required');
      print(await api('PATCH', entityPath(sessionId, '/proxy'), {
        proxy_enabled: enabled,
      }));
      break;
    }
    case 'clear-proxy':
      print(await api('DELETE', entityPath(sessionId, '/proxy')));
      break;
    case 'connect-session':
      print(await api('POST', entityPath(sessionId, '/connect-token'), {}));
      break;
    case 'downloads-access':
      print(await downloadsAccess(sessionId));
      break;
    case 'list-downloads':
      print(await listDownloads(sessionId, options));
      break;
    case 'upload-download':
      print(await uploadDownload(sessionId, options));
      break;
    case 'download-file':
      print(await downloadFile(sessionId, options));
      break;
    case 'list-runs': {
      const limit = integerOption(options, 'limit', 50, { min: 1, max: 100 });
      const offset = integerOption(options, 'offset', 0, { min: 0 });
      print(await api('GET', `/api/runs?limit=${limit}&offset=${offset}`));
      break;
    }
    case 'list-workflows': {
      const limit = integerOption(options, 'limit', 50, { min: 1, max: 100 });
      const offset = integerOption(options, 'offset', 0, { min: 0 });
      print(await api('GET', `/api/workflows?limit=${limit}&offset=${offset}`));
      break;
    }
    case 'create-workflow':
      print(await api('POST', '/api/workflows', {
        name: required(options.name, '--name'),
        source_session_id: required(sessionId, 'SOURCE_SESSION_ID'),
        source_run_id: required(runId, 'SOURCE_RUN_ID'),
      }));
      break;
    case 'workflows': {
      const action = required(sessionId, 'WORKFLOW_ACTION');
      const target = required(runId, action === 'import' ? 'FILE' : 'WORKFLOW_ID');
      if (action === 'import') {
        const raw = await readFile(target, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
          throw new CliError('Portable workflow files must not exceed 1 MiB');
        }
        let definition;
        try {
          definition = JSON.parse(raw);
        } catch {
          throw new CliError('Workflow file must contain valid JSON');
        }
        print((await api('POST', '/api/workflows/import', {
          definition,
          ...(options.name === undefined ? {} : { name: options.name }),
        })).workflow);
        break;
      }
      if (action === 'export') {
        const definition = await api('GET', `/api/workflows/${encodeURIComponent(target)}/export`);
        const output = options.output === undefined
          ? workflowExportFilename(definition?.name)
          : required(options.output, '--output');
        if (existsSync(output) && options.force !== true) {
          throw new CliError(`Refusing to overwrite ${output}; pass --force to replace it`);
        }
        await writeFile(output, `${JSON.stringify(definition, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        print({ workflow_id: target, path: output });
        break;
      }
      throw new CliError('WORKFLOW_ACTION must be import or export');
    }
    case 'get-workflow':
      print((await api('GET', `/api/workflows/${encodeURIComponent(required(sessionId, 'WORKFLOW_ID'))}`)).workflow);
      break;
    case 'rename-workflow':
      print((await api('PATCH', `/api/workflows/${encodeURIComponent(required(sessionId, 'WORKFLOW_ID'))}`, {
        name: required(options.name, '--name'),
      })).workflow);
      break;
    case 'delete-workflow':
      await api('DELETE', `/api/workflows/${encodeURIComponent(required(sessionId, 'WORKFLOW_ID'))}`);
      print({ deleted: true, workflow_id: sessionId });
      break;
    case 'create-workflow-run': {
      const parameters = await jsonOption(options.parameters, '--parameters');
      print(await api('POST', entityPath(sessionId, '/runs'), {
        workflow_id: required(runId, 'WORKFLOW_ID'),
        parameters: parameters ?? {},
        ...(options['tab-id'] === undefined ? {} : { tab_id: options['tab-id'] }),
      }));
      break;
    }
    case 'create-run':
      print(await api('POST', entityPath(sessionId, '/runs'), await runPayload(options)));
      break;
    case 'get-run':
      print(await api('GET', entityPath(sessionId, `/runs/${encodeURIComponent(required(runId, 'RUN_ID'))}`)));
      break;
    case 'wait-run':
      print(await waitForRun(sessionId, runId, options));
      break;
    case 'continue-run':
      print(await api('POST', entityPath(sessionId, `/runs/${encodeURIComponent(required(runId, 'RUN_ID'))}/messages`), await runPayload(options)));
      break;
    case 'respond-run': {
      const answer = await textInput(options, 'answer', 'answer-file', 'answer');
      print(await api('POST', entityPath(sessionId, `/runs/${encodeURIComponent(required(runId, 'RUN_ID'))}/responses`), {
        clarify_id: required(options['clarify-id'], '--clarify-id'),
        answer,
      }));
      break;
    }
    case 'abort-run':
      print(await api('POST', entityPath(sessionId, `/runs/${encodeURIComponent(required(runId, 'RUN_ID'))}/abort`), {}));
      break;
    case 'export-run': {
      const output = required(options.output, '--output');
      if (existsSync(output) && options.force !== true) throw new CliError(`Refusing to overwrite ${output}; pass --force to replace it`);
      const trace = await api('GET', entityPath(sessionId, `/runs/${encodeURIComponent(required(runId, 'RUN_ID'))}/export`), undefined, { raw: true });
      await writeFile(output, trace, { encoding: 'utf8', mode: 0o600 });
      print({ path: output, bytes: Buffer.byteLength(trace) });
      break;
    }
    default:
      throw new CliError(`Unknown command: ${command}. Run with help for usage.`);
  }
}

main().catch(error => {
  const payload = {
    error: error?.message || String(error),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.body === null || error?.body === undefined ? {} : { details: error.body }),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});

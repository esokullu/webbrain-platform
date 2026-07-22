import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'aborted']);
const WAIT_RETURN_STATUSES = new Set([...TERMINAL_RUN_STATUSES, 'needs_user_input']);

export class WebBrainApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'WebBrainApiError';
    this.status = status;
    this.body = body;
  }
}

export class WebBrainClient {
  constructor({ apiKey, baseUrl = 'https://webbrain.cloud', fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new TypeError('apiKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible fetchImpl is required');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      throw new WebBrainApiError(parsed?.error || `WebBrain API request failed with status ${response.status}`, {
        status: response.status,
        body: parsed,
      });
    }
    return parsed;
  }

  async listBrowserSessions() {
    return (await this.request('GET', '/api/browser-sessions')).browser_sessions;
  }

  async createBrowserSession(options = {}) {
    const response = await this.request('POST', '/api/browser-sessions', options);
    return {
      ...response.browser_session,
      ...(response.webbrain_config_result
        ? { webbrain_config_result: response.webbrain_config_result }
        : {}),
    };
  }

  async getBrowserSession(sessionId) {
    return (await this.request('GET', `/api/browser-sessions/${encodeURIComponent(sessionId)}`)).browser_session;
  }

  async updateBrowserSession(sessionId, { displayName } = {}) {
    return (await this.request('PATCH', `/api/browser-sessions/${encodeURIComponent(sessionId)}`, {
      display_name: displayName?.trim() || null,
    })).browser_session;
  }

  async getBrowserProxy(sessionId) {
    return (await this.request('GET', `/api/browser-sessions/${encodeURIComponent(sessionId)}/proxy`)).proxy;
  }

  async updateBrowserProxy(sessionId, { enabled = true } = {}) {
    return (await this.request('PATCH', `/api/browser-sessions/${encodeURIComponent(sessionId)}/proxy`, {
      proxy_enabled: Boolean(enabled),
    })).proxy;
  }

  async deleteBrowserProxy(sessionId) {
    return (await this.request('DELETE', `/api/browser-sessions/${encodeURIComponent(sessionId)}/proxy`)).proxy;
  }

  async deleteBrowserSession(sessionId) {
    return (await this.request('DELETE', `/api/browser-sessions/${encodeURIComponent(sessionId)}`)).browser_session;
  }

  async pauseBrowserSession(sessionId) {
    return (await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/pause`, {})).browser_session;
  }

  async resumeBrowserSession(sessionId) {
    return (await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/resume`, {})).browser_session;
  }

  async resetBrowserSession(sessionId) {
    return (await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/reset`, {})).browser_session;
  }

  async createConnectToken(sessionId, options = {}) {
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/connect-token`, options);
  }

  async createDownloadsAccess(sessionId) {
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/downloads-access`, {});
  }

  async listDownloads(sessionId, { path: remotePath = '', access } = {}) {
    const resolvedAccess = await this.downloadsAccess(sessionId, access);
    const response = await this.downloadsRequest(resolvedAccess, downloadsUrl(resolvedAccess, remotePath, true), {
      headers: { accept: 'application/json' },
    });
    return await response.json();
  }

  async uploadDownloadsFile(sessionId, localPath, {
    remotePath = path.basename(String(localPath)),
    access,
    browserLocal = false,
  } = {}) {
    const resolvedAccess = await this.downloadsAccess(sessionId, access);
    const source = String(localPath || '');
    if (!source) throw new TypeError('localPath is required');
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new TypeError('localPath must point to a regular file');
    if (resolvedAccess.upload_limit_bytes && stat.size > Number(resolvedAccess.upload_limit_bytes)) {
      throw new WebBrainApiError('File exceeds the Downloads upload limit', { status: 413 });
    }
    const response = await this.downloadsRequest(resolvedAccess, downloadsUrl(resolvedAccess, remotePath), {
      method: 'PUT',
      headers: {
        'content-length': String(stat.size),
        'content-type': 'application/octet-stream',
        ...(browserLocal ? { 'x-webbrain-upload-target': 'browser' } : {}),
      },
      body: createReadStream(source),
      duplex: 'half',
    });
    return await response.json();
  }

  async downloadDownloadsFile(sessionId, remotePath, destinationPath, {
    access,
    range,
    overwrite = false,
  } = {}) {
    const resolvedAccess = await this.downloadsAccess(sessionId, access);
    const destination = String(destinationPath || '');
    if (!destination) throw new TypeError('destinationPath is required');
    if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/.test(String(range))) {
      throw new TypeError('range must use a single HTTP bytes range, for example bytes=0-1023');
    }
    const response = await this.downloadsRequest(resolvedAccess, downloadsUrl(resolvedAccess, remotePath), {
      headers: range === undefined ? {} : { range: String(range) },
    });
    if (range !== undefined && response.status !== 206) {
      throw new WebBrainApiError('Downloads service did not honor the requested byte range', { status: response.status });
    }
    if (!response.body) throw new WebBrainApiError('Downloads response did not include a body');

    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.webbrain-${process.pid}-${randomBytes(6).toString('hex')}.part`,
    );
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (overwrite) {
        await fs.rename(temporary, destination);
      } else {
        await fs.link(temporary, destination);
        await fs.unlink(temporary);
      }
      const saved = await fs.stat(destination);
      return {
        path: destination,
        size: saved.size,
        status: response.status,
        content_type: response.headers.get('content-type'),
        content_range: response.headers.get('content-range'),
      };
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async downloadsAccess(sessionId, access) {
    const resolved = access || await this.createDownloadsAccess(sessionId);
    if (!resolved?.url || !resolved?.username || !resolved?.password) {
      throw new WebBrainApiError('Downloads access response is incomplete');
    }
    downloadsBaseUrl(resolved.url);
    return resolved;
  }

  async downloadsRequest(access, url, options = {}) {
    const authorization = `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}`;
    const response = await this.fetch(url, {
      ...options,
      redirect: 'error',
      headers: {
        authorization,
        ...(options.headers || {}),
      },
    });
    if (response.ok) return response;
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    throw new WebBrainApiError(body?.error || text || `Downloads request failed with status ${response.status}`, {
      status: response.status,
      body,
    });
  }

  async waitForBrowserSession(sessionId, { pollIntervalMs = 2000, timeoutMs = 300000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const session = await this.getBrowserSession(sessionId);
      if (session.runtime_ready === true) return session;
      if (['failed', 'destroyed'].includes(session.status)) {
        throw new WebBrainApiError(`Browser session ${sessionId} entered ${session.status}`, { body: session });
      }
      if (Date.now() >= deadline) {
        throw new WebBrainApiError(`Browser session ${sessionId} was not ready within ${timeoutMs}ms`, { body: session });
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  async createWorkflow({ name, sourceSessionId, sourceRunId } = {}) {
    if (!name) throw new TypeError('name is required');
    if (!sourceSessionId) throw new TypeError('sourceSessionId is required');
    if (!sourceRunId) throw new TypeError('sourceRunId is required');
    return await this.request('POST', '/api/workflows', {
      name,
      source_session_id: sourceSessionId,
      source_run_id: sourceRunId,
    });
  }

  async listWorkflows({ limit = 50, offset = 0 } = {}) {
    return await this.request('GET', `/api/workflows?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
  }

  async getWorkflow(workflowId) {
    return (await this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}`)).workflow;
  }

  async renameWorkflow(workflowId, name) {
    if (!name) throw new TypeError('name is required');
    return (await this.request('PATCH', `/api/workflows/${encodeURIComponent(workflowId)}`, { name })).workflow;
  }

  async deleteWorkflow(workflowId) {
    await this.request('DELETE', `/api/workflows/${encodeURIComponent(workflowId)}`);
  }

  async createRun(sessionId, { task, wait = false, timeoutMs, tabId, outputSchema, capture } = {}) {
    if (!task) throw new TypeError('task is required');
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs`, {
      task,
      wait,
      ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      ...(tabId === undefined ? {} : { tab_id: tabId }),
      ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
      ...(capture === undefined ? {} : { capture }),
    });
  }

  async createWorkflowRun(sessionId, workflowId, {
    parameters = {}, wait = false, timeoutMs, tabId, capture,
  } = {}) {
    if (!workflowId) throw new TypeError('workflowId is required');
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs`, {
      workflow_id: workflowId,
      parameters,
      wait,
      ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      ...(tabId === undefined ? {} : { tab_id: tabId }),
      ...(capture === undefined ? {} : { capture }),
    });
  }

  async getRun(sessionId, runId) {
    return await this.request('GET', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`);
  }

  async continueRun(sessionId, runId, { task, wait = false, timeoutMs, outputSchema, capture } = {}) {
    if (!task) throw new TypeError('task is required');
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/messages`, {
      task,
      wait,
      ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
      ...(capture === undefined ? {} : { capture }),
    });
  }

  async abortRun(sessionId, runId) {
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/abort`, {});
  }

  async respondToRun(sessionId, runId, clarifyId, answer) {
    if (!clarifyId) throw new TypeError('clarifyId is required');
    if (answer === undefined || answer === null || String(answer).trim() === '') throw new TypeError('answer is required');
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/responses`, {
      clarify_id: clarifyId,
      answer: String(answer),
    });
  }

  async waitForRun(sessionId, runId, { pollIntervalMs = 1000, timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const run = await this.getRun(sessionId, runId);
      if (WAIT_RETURN_STATUSES.has(run.status)) return run;
      if (Date.now() >= deadline) {
        throw new WebBrainApiError(`Run ${runId} did not finish within ${timeoutMs}ms`, { body: run });
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }
}

function downloadsUrl(access, remotePath = '', directory = false) {
  const segments = downloadsPathSegments(remotePath);
  const base = downloadsBaseUrl(access.url);
  const suffix = segments.map(segment => encodeURIComponent(segment)).join('/');
  return base + suffix + (directory && suffix ? '/' : '');
}

function downloadsBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError('Downloads access URL is invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('Downloads access URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Downloads access URL cannot contain credentials, a query, or a fragment');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function downloadsPathSegments(value) {
  const input = String(value || '');
  if (!input) return [];
  const segments = input.split('/');
  if (segments.some(segment => !segment
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
    || /[\\\0\r\n\u0000-\u001f\u007f]/.test(segment))) {
    throw new TypeError('Downloads path contains a forbidden segment');
  }
  return segments;
}

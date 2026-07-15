const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'aborted']);

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
    return (await this.request('POST', '/api/browser-sessions', options)).browser_session;
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

  async updateBrowserProxy(sessionId, { proxyUrl, proxy } = {}) {
    const body = proxy === undefined ? { proxy_url: proxyUrl ?? null } : { proxy };
    return (await this.request('PATCH', `/api/browser-sessions/${encodeURIComponent(sessionId)}/proxy`, body)).proxy;
  }

  async deleteBrowserSession(sessionId) {
    return (await this.request('DELETE', `/api/browser-sessions/${encodeURIComponent(sessionId)}`)).browser_session;
  }

  async createConnectToken(sessionId, options = {}) {
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/connect-token`, options);
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

  async createRun(sessionId, { task, wait = false, timeoutMs, tabId, outputSchema } = {}) {
    if (!task) throw new TypeError('task is required');
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs`, {
      task,
      wait,
      ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      ...(tabId === undefined ? {} : { tab_id: tabId }),
      ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
    });
  }

  async getRun(sessionId, runId) {
    return await this.request('GET', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`);
  }

  async abortRun(sessionId, runId) {
    return await this.request('POST', `/api/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/abort`, {});
  }

  async waitForRun(sessionId, runId, { pollIntervalMs = 1000, timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const run = await this.getRun(sessionId, runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
      if (Date.now() >= deadline) {
        throw new WebBrainApiError(`Run ${runId} did not finish within ${timeoutMs}ms`, { body: run });
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }
}

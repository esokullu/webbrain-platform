const EXAMPLES = {
  rest: `export WEBBRAIN_API_KEY='wbp_your_key_here'

# 1. Create a browser
SESSION_ID=$(curl -sS -X POST https://webbrain.cloud/api/browser-sessions \\
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{}' | jq -r '.browser_session.id')

# 2. Wait for the extension bridge
until [ "$(curl -sS \\
  "https://webbrain.cloud/api/browser-sessions/$SESSION_ID" \\
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \\
  | jq -r '.browser_session.runtime_ready')" = "true" ]; do sleep 2; done

# 3. Start a visible run
RUN_ID=$(curl -sS -X POST \\
  "https://webbrain.cloud/api/browser-sessions/$SESSION_ID/runs" \\
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"task":"Open google.com and return the page title"}' \\
  | jq -r '.run_id')

# 4. Read the result
curl -sS \\
  "https://webbrain.cloud/api/browser-sessions/$SESSION_ID/runs/$RUN_ID" \\
  -H "Authorization: Bearer $WEBBRAIN_API_KEY" | jq`,

  node: `import { WebBrainClient } from './clients/node/webbrain-client.js';

const client = new WebBrainClient({
  apiKey: process.env.WEBBRAIN_API_KEY,
});

const session = await client.createBrowserSession();
const ready = await client.waitForBrowserSession(session.id);
const run = await client.createRun(ready.id, {
  task: 'Open google.com and return the page title',
});

const finished = await client.waitForRun(ready.id, run.run_id);
console.log(finished.result);`,

  python: `import os
from clients.python.webbrain_client import WebBrainClient

client = WebBrainClient(os.environ["WEBBRAIN_API_KEY"])
session = client.create_browser_session()
ready = client.wait_for_browser_session(session["id"])
run = client.create_run(
    ready["id"],
    "Open google.com and return the page title",
)

finished = client.wait_for_run(ready["id"], run["run_id"])
print(finished["result"])`,

  php: `<?php

require_once __DIR__ . '/clients/php/WebBrainClient.php';

$client = new WebBrainClient(getenv('WEBBRAIN_API_KEY') ?: '');
$session = $client->createBrowserSession();
$ready = $client->waitForBrowserSession($session['id']);
$run = $client->createRun(
    $ready['id'],
    'Open google.com and return the page title',
);

$finished = $client->waitForRun($ready['id'], $run['run_id']);
print_r($finished['result']);`,
};

const TABS = [
  ['rest', 'REST'],
  ['node', 'Node.js'],
  ['python', 'Python'],
  ['php', 'PHP'],
];

const TOKEN_PATTERNS = {
  rest: /#[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$[A-Za-z_][A-Za-z0-9_]*|\b(?:export|until|do|done|sleep|curl|jq)\b|\b(?:true|false|null)\b|\b\d+\b/gm,
  node: /\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:import|from|const|let|await|new|export|class|async|throw|return|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*(?=\()/gm,
  python: /#[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:import|from|as|class|def|return|raise|if|else|elif|while|for|in|with|try|except|True|False|None)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*(?=\()/gm,
  php: /<\?php|\/\/[^\n]*|#[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$[A-Za-z_][A-Za-z0-9_]*|\b(?:require_once|new|print_r|true|false|null|function|public|private|class|final|return|throw)\b|\b\d+(?:\.\d+)?\b|(?:->|::)[A-Za-z_][A-Za-z0-9_]*/gm,
};

const KEYWORDS = {
  rest: new Set(['export', 'until', 'do', 'done']),
  node: new Set(['import', 'from', 'const', 'let', 'await', 'new', 'export', 'class', 'async', 'throw', 'return']),
  python: new Set(['import', 'from', 'as', 'class', 'def', 'return', 'raise', 'if', 'else', 'elif', 'while', 'for', 'in', 'with', 'try', 'except']),
  php: new Set(['<?php', 'require_once', 'new', 'function', 'public', 'private', 'class', 'final', 'return', 'throw']),
};

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'True', 'False', 'None']);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function highlightedCode(source, language) {
  const pattern = TOKEN_PATTERNS[language];
  let html = '';
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    html += escapeHtml(source.slice(cursor, match.index));
    const token = match[0];
    let kind = 'function';
    if (token.startsWith('#') || token.startsWith('//')) kind = 'comment';
    else if (/^['"`]/.test(token)) kind = 'string';
    else if (token.startsWith('$')) kind = 'variable';
    else if (/^\d/.test(token)) kind = 'number';
    else if (LITERALS.has(token)) kind = 'literal';
    else if (KEYWORDS[language].has(token)) kind = 'keyword';
    html += `<span class="tok-${kind}">${escapeHtml(token)}</span>`;
    cursor = match.index + token.length;
  }
  return html + escapeHtml(source.slice(cursor));
}

export function docsPage() {
  const tabButtons = TABS.map(([id, label], index) => `
    <button class="code-tab" id="tab-${id}" type="button" role="tab" aria-selected="${index === 0}" aria-controls="panel-${id}" tabindex="${index === 0 ? 0 : -1}" data-client="${id}">${label}</button>`).join('');
  const tabPanels = TABS.map(([id, label], index) => `
    <pre class="code-panel language-${id}" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}" ${index === 0 ? '' : 'hidden'}><code>${highlightedCode(EXAMPLES[id], id)}</code></pre>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="WebBrain Cloud browser automation API documentation and client examples for REST, Node.js, Python, and PHP.">
  <link rel="icon" type="image/png" href="https://webbrain.one/logo-github.png">
  <title>API documentation · WebBrain Cloud</title>
  <style>
    :root {
      --bg: #f7f1e6;
      --card: #fffdf8;
      --card-hover: #f2e9d4;
      --surface: #ede2cb;
      --border: rgba(89,55,25,.15);
      --text: #2c1810;
      --text-dim: #6b5b47;
      --accent: #5b52e8;
      --accent2: #7c6ce6;
      --accent-glow: rgba(91,82,232,.20);
      --success: #2d8866;
      --danger: #a43b32;
      --code: #0f1424;
      --code-border: rgba(167,139,250,.24);
      --shadow: rgba(89,55,25,.10);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    a { color: var(--accent); }
    .glow-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
    .glow-bg::before { content: ''; position: absolute; width: 760px; height: 760px; top: -360px; left: 53%; transform: translateX(-50%); background: radial-gradient(circle, var(--accent-glow), transparent 70%); filter: blur(78px); }
    .glow-bg::after { content: ''; position: absolute; width: 440px; height: 440px; top: 45%; right: -170px; background: radial-gradient(circle, rgba(167,139,250,.13), transparent 70%); filter: blur(60px); }
    nav { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border); background: rgba(247,241,230,.88); backdrop-filter: blur(20px); }
    .nav-inner { max-width: 1200px; min-height: 68px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 10px; color: var(--accent); font-size: 20px; font-weight: 800; text-decoration: none; }
    .brand img { width: 30px; height: 30px; border-radius: 8px; box-shadow: 0 6px 18px var(--accent-glow); }
    .brand-domain { color: var(--accent2); opacity: .68; font-weight: 400; }
    .nav-links { display: flex; align-items: center; gap: 20px; }
    .nav-links a { color: var(--text-dim); font-size: 13px; font-weight: 650; text-decoration: none; }
    .nav-links a:hover { color: var(--text); }
    main { max-width: 1200px; margin: 0 auto; padding: 72px 24px 88px; }
    .hero { max-width: 850px; }
    .eyebrow { margin: 0 0 14px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(46px, 7vw, 78px); line-height: .98; letter-spacing: -.055em; }
    h1 span { color: var(--accent); }
    .lede { max-width: 700px; margin: 24px 0 0; color: var(--text-dim); font-size: 18px; }
    .auth-callout { display: inline-flex; align-items: center; gap: 10px; margin-top: 26px; padding: 10px 13px; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,253,248,.7); color: var(--text-dim); font-size: 13px; }
    .auth-callout code { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .flow { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); margin: 54px 0 26px; border: 1px solid var(--border); border-radius: 16px; background: rgba(255,253,248,.82); box-shadow: 0 16px 42px var(--shadow); overflow: hidden; }
    .flow-step { position: relative; min-height: 116px; padding: 20px; border-right: 1px solid var(--border); }
    .flow-step:last-child { border-right: 0; }
    .flow-number { display: inline-grid; width: 25px; height: 25px; place-items: center; border-radius: 50%; background: rgba(91,82,232,.10); color: var(--accent); font-size: 11px; font-weight: 800; }
    .flow-step strong { display: block; margin-top: 12px; font-size: 14px; }
    .flow-step span { display: block; margin-top: 3px; color: var(--text-dim); font-size: 12px; }
    .code-card { overflow: hidden; border: 1px solid var(--code-border); border-radius: 16px; background: var(--code); box-shadow: 0 24px 60px rgba(15,20,36,.22); }
    .code-toolbar { min-height: 56px; padding: 8px 10px 8px 16px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .code-tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; }
    .code-tab { min-height: 34px; padding: 6px 12px; border: 0; border-radius: 7px; background: transparent; color: #8991aa; font: inherit; font-size: 12px; font-weight: 750; cursor: pointer; }
    .code-tab[aria-selected="true"] { background: rgba(108,99,255,.20); color: #dcd9ff; }
    .code-tab:focus-visible, .copy-button:focus-visible, a:focus-visible { outline: 3px solid var(--accent-glow); outline-offset: 2px; }
    .copy-button { min-height: 34px; padding: 6px 11px; border: 1px solid rgba(255,255,255,.12); border-radius: 7px; background: rgba(255,255,255,.05); color: #bcc3d8; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
    .copy-button:hover { background: rgba(255,255,255,.10); color: white; }
    .code-panel { min-height: 420px; max-height: 580px; margin: 0; padding: 28px; overflow: auto; color: #dfe5f5; font: 13px/1.75 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; white-space: pre; }
    .code-panel[hidden] { display: none; }
    .tok-comment { color: #77849f; font-style: italic; }
    .tok-keyword { color: #c8a7ff; font-weight: 650; }
    .tok-string { color: #9de2b0; }
    .tok-variable { color: #f2c879; }
    .tok-number, .tok-literal { color: #ff9f7a; }
    .tok-function { color: #82b7ff; }
    .docs-grid { display: grid; grid-template-columns: 220px minmax(0,1fr); gap: 56px; margin-top: 76px; align-items: start; }
    .toc { position: sticky; top: 94px; display: grid; gap: 5px; }
    .toc-label { margin-bottom: 7px; color: var(--text-dim); font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .toc a { padding: 7px 9px; border-radius: 7px; color: var(--text-dim); font-size: 13px; font-weight: 600; text-decoration: none; }
    .toc a:hover { background: rgba(89,55,25,.05); color: var(--text); }
    .docs-content { min-width: 0; }
    .docs-section { padding: 0 0 56px; scroll-margin-top: 94px; }
    .docs-section + .docs-section { padding-top: 56px; border-top: 1px solid var(--border); }
    .section-kicker { margin: 0 0 7px; color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
    h2 { margin: 0 0 14px; font-size: clamp(27px, 4vw, 38px); line-height: 1.1; letter-spacing: -.035em; }
    h3 { margin: 28px 0 9px; font-size: 17px; }
    .docs-section > p { max-width: 750px; color: var(--text-dim); }
    .inline-code, .docs-section code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .inline-code { padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px; background: rgba(89,55,25,.05); font-size: .9em; }
    .endpoint-list { display: grid; gap: 8px; margin-top: 24px; }
    .endpoint { display: grid; grid-template-columns: 74px minmax(0,1fr) minmax(180px,.8fr); align-items: center; gap: 14px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,253,248,.65); }
    .method { width: max-content; padding: 4px 7px; border-radius: 5px; background: rgba(91,82,232,.10); color: var(--accent); font: 700 10px ui-monospace, monospace; }
    .endpoint code { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-size: 12px; }
    .endpoint span:last-child { color: var(--text-dim); font-size: 12px; }
    .field-table { width: 100%; margin-top: 22px; border-collapse: collapse; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,253,248,.65); }
    .field-table th, .field-table td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; font-size: 13px; }
    .field-table th { color: var(--text-dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
    .field-table tr:last-child td { border-bottom: 0; }
    .status-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .status { padding: 6px 9px; border: 1px solid var(--border); border-radius: 999px; background: rgba(255,253,248,.68); color: var(--text-dim); font: 700 11px ui-monospace, monospace; }
    .status.completed { border-color: rgba(45,136,102,.25); color: var(--success); }
    .status.failed, .status.aborted { border-color: rgba(164,59,50,.24); color: var(--danger); }
    .client-cards { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-top: 22px; }
    .client-card { padding: 17px; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,253,248,.72); color: var(--text); text-decoration: none; }
    .client-card:hover { border-color: rgba(91,82,232,.35); transform: translateY(-1px); }
    .client-card strong { display: block; }
    .client-card span { display: block; margin-top: 3px; color: var(--text-dim); font-size: 12px; }
    footer { max-width: 1200px; margin: 0 auto; padding: 26px 24px 42px; border-top: 1px solid var(--border); color: var(--text-dim); font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
    @media (max-width: 820px) {
      main { padding-top: 52px; }
      .flow { grid-template-columns: 1fr 1fr; }
      .flow-step:nth-child(2) { border-right: 0; }
      .flow-step:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
      .docs-grid { grid-template-columns: 1fr; gap: 34px; }
      .toc { position: static; grid-template-columns: repeat(3,1fr); }
      .toc-label { grid-column: 1/-1; }
      .client-cards { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .nav-inner { padding-inline: 14px; }
      .brand { font-size: 17px; gap: 7px; }
      .brand img { width: 27px; height: 27px; }
      .nav-links a:first-child { display: none; }
      main { padding: 42px 14px 64px; }
      h1 { font-size: clamp(43px, 15vw, 62px); }
      .lede { font-size: 16px; }
      .flow { grid-template-columns: 1fr; }
      .flow-step { min-height: 0; border-right: 0; border-bottom: 1px solid var(--border); }
      .flow-step:last-child { border-bottom: 0; }
      .code-toolbar { align-items: flex-start; flex-direction: column; }
      .code-tabs { width: 100%; }
      .copy-button { align-self: flex-end; }
      .code-panel { min-height: 380px; padding: 20px; font-size: 12px; }
      .toc { grid-template-columns: 1fr 1fr; }
      .endpoint { grid-template-columns: 64px minmax(0,1fr); }
      .endpoint span:last-child { grid-column: 2; }
      .field-table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="glow-bg" aria-hidden="true"></div>
  <nav>
    <div class="nav-inner">
      <a class="brand" href="/">
        <img src="https://webbrain.one/logo-github.png" alt=""> WebBrain<span class="brand-domain">.cloud</span>
      </a>
      <div class="nav-links">
        <a href="/">Dashboard</a>
        <a href="https://github.com/esokullu/webbrain-platform/tree/main/clients">Client libraries ↗</a>
      </div>
    </div>
  </nav>
  <main>
    <header class="hero">
      <p class="eyebrow">Browser automation API</p>
      <h1>One browser.<br><span>Four ways to drive it.</span></h1>
      <p class="lede">Create a persistent WebBrain browser, watch it work in noVNC, and control that same visible session from REST, Node.js, Python, or PHP.</p>
      <div class="auth-callout"><strong>Base URL</strong><code>https://webbrain.cloud</code></div>
    </header>

    <section aria-labelledby="quickstart-title">
      <div class="flow" aria-label="API request flow">
        <div class="flow-step"><span class="flow-number">1</span><strong>Create</strong><span>Launch an isolated browser.</span></div>
        <div class="flow-step"><span class="flow-number">2</span><strong>Ready</strong><span>Wait for the extension bridge.</span></div>
        <div class="flow-step"><span class="flow-number">3</span><strong>Run</strong><span>Send a natural-language task.</span></div>
        <div class="flow-step"><span class="flow-number">4</span><strong>Result</strong><span>Poll for text or structured JSON.</span></div>
      </div>
      <div class="code-card">
        <div class="code-toolbar">
          <div class="code-tabs" role="tablist" aria-label="Choose a client">${tabButtons}</div>
          <button class="copy-button" type="button">Copy example</button>
        </div>
        ${tabPanels}
      </div>
    </section>

    <div class="docs-grid">
      <aside class="toc" aria-label="On this page">
        <span class="toc-label">On this page</span>
        <a href="#authentication">Authentication</a>
        <a href="#sessions">Browser sessions</a>
        <a href="#runs">Runs</a>
        <a href="#structured-output">Structured output</a>
        <a href="#statuses">Statuses</a>
        <a href="#clients">Clients</a>
      </aside>
      <article class="docs-content">
        <section class="docs-section" id="authentication">
          <p class="section-kicker">Start here</p>
          <h2>Authenticate once</h2>
          <p>Create a key from the dashboard's API Keys panel and send it as <span class="inline-code">Authorization: Bearer wbp_…</span>. A key can control only its owner's browser sessions. The complete secret is displayed once, so revoke it immediately if it is exposed.</p>
        </section>

        <section class="docs-section" id="sessions">
          <p class="section-kicker">Lifecycle</p>
          <h2>Browser sessions</h2>
          <p>A session is a persistent Chrome profile on its own cloud machine. Create it, poll until <span class="inline-code">runtime_ready</span> is true, then start runs. Destroy it when it is no longer needed.</p>
          <div class="endpoint-list">
            <div class="endpoint"><span class="method">POST</span><code>/api/browser-sessions</code><span>Create a browser.</span></div>
            <div class="endpoint"><span class="method">GET</span><code>/api/browser-sessions</code><span>List your sessions.</span></div>
            <div class="endpoint"><span class="method">GET</span><code>/api/browser-sessions/:sessionId</code><span>Read readiness.</span></div>
            <div class="endpoint"><span class="method">PATCH</span><code>/api/browser-sessions/:sessionId</code><span>Set its display name.</span></div>
            <div class="endpoint"><span class="method">GET</span><code>/api/browser-sessions/:sessionId/proxy</code><span>Read proxy and exit IP.</span></div>
            <div class="endpoint"><span class="method">PATCH</span><code>/api/browser-sessions/:sessionId/proxy</code><span>Switch proxy without restart.</span></div>
            <div class="endpoint"><span class="method">DELETE</span><code>/api/browser-sessions/:sessionId/proxy</code><span>Return to a direct connection.</span></div>
            <div class="endpoint"><span class="method">DELETE</span><code>/api/browser-sessions/:sessionId</code><span>Destroy a browser.</span></div>
            <div class="endpoint"><span class="method">POST</span><code>/api/browser-sessions/:sessionId/connect-token</code><span>Create a noVNC link.</span></div>
          </div>
        </section>

        <section class="docs-section" id="runs">
          <p class="section-kicker">Automation</p>
          <h2>Run a task</h2>
          <p>Runs are asynchronous by default and return <span class="inline-code">202 Accepted</span> with a <span class="inline-code">run_id</span>. Poll the run endpoint, or set <span class="inline-code">wait: true</span> for a blocking request.</p>
          <table class="field-table">
            <thead><tr><th>Field</th><th>Required</th><th>Purpose</th></tr></thead>
            <tbody>
              <tr><td><code>task</code></td><td>Yes</td><td>The natural-language browser task.</td></tr>
              <tr><td><code>wait</code></td><td>No</td><td>Wait for a terminal response instead of returning immediately.</td></tr>
              <tr><td><code>timeout_ms</code></td><td>No</td><td>Maximum time for the blocking request path.</td></tr>
              <tr><td><code>tab_id</code></td><td>No</td><td>Target a specific tab. Otherwise the visible active page is used.</td></tr>
              <tr><td><code>output_schema</code></td><td>No</td><td>Require a validated JSON result.</td></tr>
            </tbody>
          </table>
          <div class="endpoint-list">
            <div class="endpoint"><span class="method">POST</span><code>/api/browser-sessions/:sessionId/runs</code><span>Start a run.</span></div>
            <div class="endpoint"><span class="method">GET</span><code>/api/browser-sessions/:sessionId/runs/:runId</code><span>Read a run.</span></div>
            <div class="endpoint"><span class="method">POST</span><code>/api/browser-sessions/:sessionId/runs/:runId/abort</code><span>Abort a run.</span></div>
          </div>
        </section>

        <section class="docs-section" id="structured-output">
          <p class="section-kicker">Typed results</p>
          <h2>Structured output</h2>
          <p>Use shorthand fields such as <span class="inline-code">string</span>, <span class="inline-code">number</span>, <span class="inline-code">boolean</span>, <span class="inline-code">string[]</span>, and optional <span class="inline-code">string?</span>. The supported JSON Schema subset includes <span class="inline-code">type</span>, <span class="inline-code">properties</span>, <span class="inline-code">required</span>, <span class="inline-code">items</span>, <span class="inline-code">enum</span>, and <span class="inline-code">additionalProperties</span>.</p>
        </section>

        <section class="docs-section" id="statuses">
          <p class="section-kicker">Run state</p>
          <h2>Know when it is done</h2>
          <p>A terminal response includes <span class="inline-code">result</span>, <span class="inline-code">summary</span>, <span class="inline-code">final_url</span>, and any failure detail in <span class="inline-code">error</span>.</p>
          <div class="status-row">
            <span class="status">running</span><span class="status completed">completed</span><span class="status failed">failed</span><span class="status">aborting</span><span class="status aborted">aborted</span>
          </div>
        </section>

        <section class="docs-section" id="clients">
          <p class="section-kicker">No dependencies</p>
          <h2>Use your language</h2>
          <p>The repository includes small clients with the same core operations: session lifecycle, readiness, runs, polling, aborting, structured output, and noVNC links.</p>
          <div class="client-cards">
            <a class="client-card" href="https://github.com/esokullu/webbrain-platform/tree/main/clients/node"><strong>Node.js</strong><span>Node 18+ · native fetch</span></a>
            <a class="client-card" href="https://github.com/esokullu/webbrain-platform/tree/main/clients/python"><strong>Python</strong><span>Python 3.9+ · standard library</span></a>
            <a class="client-card" href="https://github.com/esokullu/webbrain-platform/tree/main/clients/php"><strong>PHP</strong><span>PHP 8.1+ · cURL</span></a>
          </div>
        </section>
      </article>
    </div>
  </main>
  <footer>WebBrain Cloud API · The browser you can watch while your code drives it.</footer>
  <script>
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
    const copyButton = document.querySelector('.copy-button');

    function activateTab(tab) {
      for (const candidate of tabs) {
        const selected = candidate === tab;
        candidate.setAttribute('aria-selected', String(selected));
        candidate.tabIndex = selected ? 0 : -1;
      }
      for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', event => {
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        activateTab(tabs[next]);
        tabs[next].focus();
      });
    });

    copyButton.addEventListener('click', async () => {
      const active = panels.find(panel => !panel.hidden);
      if (!active) return;
      try {
        await navigator.clipboard.writeText(active.innerText);
        copyButton.textContent = 'Copied';
        setTimeout(() => { copyButton.textContent = 'Copy example'; }, 1400);
      } catch {
        copyButton.textContent = 'Copy unavailable';
      }
    });
  </script>
</body>
</html>`;
}

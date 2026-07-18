import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_DOWNLOADS_UPLOAD_LIMIT_BYTES } from '../shared/downloads-access.js';

export const DEFAULT_DOWNLOADS_ROOT = '/root/Downloads';
export { DEFAULT_DOWNLOADS_UPLOAD_LIMIT_BYTES } from '../shared/downloads-access.js';

const ROUTE_PREFIX = '/downloads';
const TEMP_PREFIX = '.webbrain-upload-';

export function createDownloadsService({
  rootDir = DEFAULT_DOWNLOADS_ROOT,
  maxUploadBytes = DEFAULT_DOWNLOADS_UPLOAD_LIMIT_BYTES,
  maxStorageBytes = null,
} = {}) {
  const root = path.resolve(rootDir);
  const uploadLimit = Number(maxUploadBytes);
  if (!Number.isSafeInteger(uploadLimit) || uploadLimit <= 0) {
    throw new Error('Downloads upload limit must be a positive safe integer.');
  }
  const storageLimit = maxStorageBytes == null || maxStorageBytes === ''
    ? null
    : Number(maxStorageBytes);
  if (storageLimit != null && (!Number.isSafeInteger(storageLimit) || storageLimit <= 0)) {
    throw new Error('Downloads storage limit must be a positive safe integer.');
  }
  let uploadQueue = Promise.resolve();
  const withUploadLock = async callback => {
    const previous = uploadQueue;
    let release;
    uploadQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { root, uploadLimit, storageLimit, withUploadLock }).catch(error => {
      if (res.headersSent || res.destroyed) {
        res.destroy(error);
        return;
      }
      sendText(res, error.status || 500, error.expose ? error.message : 'Downloads service error');
    });
  });

  return {
    server,
    async listen(port, host = '127.0.0.1') {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700);
      await cleanupStaleUploads(root);
      return await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    },
  };
}

async function cleanupStaleUploads(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const itemPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.startsWith(TEMP_PREFIX)) {
      await fs.rm(itemPath, { force: true });
      continue;
    }
    if (entry.isDirectory() && !isPrivateName(entry.name)) {
      await cleanupStaleUploads(itemPath);
    }
  }
}

async function handleRequest(req, res, context) {
  setSecurityHeaders(res);
  const route = parseRoute(req.url);
  if (!route) return sendText(res, 404, 'Not found');
  if (route.redirect) {
    res.writeHead(308, { location: ROUTE_PREFIX + '/' });
    return res.end();
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return await servePath(req, res, context, route);
  }
  if (req.method === 'PUT') {
    if (route.trailingSlash || route.segments.length === 0) {
      return sendText(res, 400, 'Upload URL must include a filename.');
    }
    return await context.withUploadLock(() => receiveUpload(req, res, context, route));
  }

  res.setHeader('allow', 'GET, HEAD, PUT');
  return sendText(res, 405, 'Method not allowed');
}

async function servePath(req, res, { root, uploadLimit }, route) {
  const resolved = await resolveExistingPath(root, route.segments);
  if (!resolved) return sendText(res, 404, 'Not found');
  if (resolved.stat.isDirectory()) {
    if (!route.trailingSlash) {
      res.writeHead(308, { location: buildDownloadsUrl(route.segments, true) });
      return res.end();
    }
    return await serveDirectory(req, res, root, route.segments, resolved.path, uploadLimit);
  }
  if (!resolved.stat.isFile()) return sendText(res, 404, 'Not found');
  return serveFile(req, res, resolved.path, route.segments.at(-1), resolved.stat);
}

async function serveDirectory(req, res, root, segments, directoryPath, uploadLimit) {
  const rawEntries = await fs.readdir(directoryPath, { withFileTypes: true });
  const entries = [];
  for (const entry of rawEntries) {
    if (isPrivateName(entry.name) || entry.isSymbolicLink()) continue;
    const itemPath = path.join(directoryPath, entry.name);
    const stat = await fs.lstat(itemPath).catch(() => null);
    if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
    entries.push({
      name: entry.name,
      directory: stat.isDirectory(),
      size: stat.isFile() ? stat.size : null,
      modified: stat.mtime,
      url: buildDownloadsUrl([...segments, entry.name], stat.isDirectory()),
    });
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory)
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  if (acceptsJson(req)) {
    const body = JSON.stringify({
      path: segments.join('/'),
      entries: entries.map(entry => ({
        name: entry.name,
        path: [...segments, entry.name].join('/'),
        type: entry.directory ? 'directory' : 'file',
        size: entry.size,
        modified_at: entry.modified.toISOString(),
        url: entry.url,
      })),
      upload_limit_bytes: uploadLimit,
    });
    res.writeHead(200, {
      'cache-control': 'private, no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json; charset=utf-8',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }

  const nonce = randomBytes(18).toString('base64url');
  res.setHeader('content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const html = renderDirectoryPage({ root, segments, entries, uploadLimit, nonce });
  res.setHeader('content-length', Buffer.byteLength(html));
  res.writeHead(200);
  if (req.method === 'HEAD') return res.end();
  res.end(html);
}

function acceptsJson(req) {
  return String(req.headers.accept || '')
    .split(',')
    .some(value => value.split(';')[0].trim().toLowerCase() === 'application/json');
}

function serveFile(req, res, filePath, fileName, stat) {
  const range = parseRange(req.headers.range, stat.size);
  if (range?.invalid) {
    res.writeHead(416, {
      'accept-ranges': 'bytes',
      'content-range': `bytes */${stat.size}`,
    });
    return res.end();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stat.size - 1);
  const contentLength = stat.size === 0 ? 0 : end - start + 1;
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-disposition': contentDisposition(fileName),
    'content-length': contentLength,
    'content-type': contentTypeFor(fileName),
    'last-modified': stat.mtime.toUTCString(),
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = createReadStream(filePath, { start, end });
  stream.once('error', error => res.destroy(error));
  stream.pipe(res);
}

async function receiveUpload(req, res, { root, uploadLimit, storageLimit }, route) {
  const declaredLength = parseContentLength(req.headers['content-length']);
  if (declaredLength?.invalid) return sendText(res, 400, 'Invalid Content-Length.');
  if (declaredLength != null && declaredLength > uploadLimit) {
    return sendText(res, 413, `File exceeds the ${formatBytes(uploadLimit)} upload limit.`);
  }

  const parentSegments = route.segments.slice(0, -1);
  const requestedName = route.segments.at(-1);
  const parent = await resolveExistingPath(root, parentSegments);
  if (!parent || !parent.stat.isDirectory()) return sendText(res, 404, 'Upload directory not found.');

  const usedBytes = storageLimit == null ? 0 : await directorySize(root);
  const remainingBytes = storageLimit == null ? uploadLimit : Math.max(0, storageLimit - usedBytes);
  if (storageLimit != null && (
    remainingBytes === 0
    || (declaredLength != null && declaredLength > remainingBytes)
  )) {
    return sendText(res, 507, `Downloads storage has reached its ${formatBytes(storageLimit)} limit.`);
  }
  const streamLimit = Math.min(uploadLimit, remainingBytes);
  const limitErrorCode = storageLimit != null && streamLimit < uploadLimit
    ? 'STORAGE_FULL'
    : 'UPLOAD_TOO_LARGE';
  const tempName = `${TEMP_PREFIX}${randomBytes(12).toString('hex')}.part`;
  const tempPath = path.join(parent.path, tempName);
  let bytesWritten = 0;
  try {
    const uploaded = await streamUpload(req, tempPath, streamLimit, limitErrorCode);
    bytesWritten = uploaded.size;
    const final = await linkWithAvailableName(tempPath, parent.path, requestedName);
    await fs.unlink(tempPath);
    const browserPath = path.join(parent.path, final.name);
    const body = JSON.stringify({
      name: final.name,
      size: bytesWritten,
      sha256: uploaded.sha256,
      storage_backend: 'browser_local',
      browser_path: browserPath,
      browser_ready: true,
      url: buildDownloadsUrl([...parentSegments, final.name], false),
    });
    res.writeHead(201, {
      'cache-control': 'private, no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json; charset=utf-8',
      location: buildDownloadsUrl([...parentSegments, final.name], false),
    });
    res.end(body);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    if (error.code === 'UPLOAD_TOO_LARGE') {
      return sendText(res, 413, `File exceeds the ${formatBytes(uploadLimit)} upload limit.`);
    }
    if (error.code === 'STORAGE_FULL') {
      return sendText(res, 507, `Downloads storage has reached its ${formatBytes(storageLimit)} limit.`);
    }
    if (error.code === 'REQUEST_ABORTED') {
      if (!res.destroyed) res.destroy();
      return;
    }
    throw error;
  }
}

function streamUpload(req, tempPath, uploadLimit, limitErrorCode = 'UPLOAD_TOO_LARGE') {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let bytes = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      output.destroy();
      reject(error);
    };

    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > uploadLimit) {
        const error = new Error('Upload exceeds the configured limit.');
        error.code = limitErrorCode;
        req.resume();
        fail(error);
        return;
      }
      hash.update(chunk);
      if (!output.write(chunk)) {
        req.pause();
        output.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });
    req.once('end', () => {
      if (!settled) output.end();
    });
    req.once('aborted', () => {
      const error = new Error('Upload request was aborted.');
      error.code = 'REQUEST_ABORTED';
      fail(error);
    });
    req.once('error', fail);
    output.once('error', fail);
    output.once('finish', () => {
      if (settled) return;
      settled = true;
      resolve({
        size: bytes,
        sha256: hash.digest('hex'),
      });
    });
  });
}

async function directorySize(root) {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const itemPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(itemPath);
      } else if (entry.isFile()) {
        total += (await fs.lstat(itemPath)).size;
      }
    }
  }
  return total;
}

async function linkWithAvailableName(tempPath, parentPath, requestedName) {
  const extension = path.extname(requestedName);
  const stem = extension ? requestedName.slice(0, -extension.length) : requestedName;
  for (let index = 0; index < 10_000; index += 1) {
    const name = index === 0 ? requestedName : `${stem} (${index})${extension}`;
    try {
      await fs.link(tempPath, path.join(parentPath, name));
      return { name };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const error = new Error('Could not allocate a unique upload filename.');
  error.status = 409;
  error.expose = true;
  throw error;
}

async function resolveExistingPath(root, segments) {
  let current = root;
  let stat;
  try {
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return null;
    for (const segment of segments) {
      current = path.join(current, segment);
      stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return null;
    }
    const relative = path.relative(root, current);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return { path: current, stat };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function parseRoute(requestUrl) {
  let url;
  try {
    url = new URL(String(requestUrl || '/'), 'http://127.0.0.1');
  } catch {
    return null;
  }
  if (url.pathname === ROUTE_PREFIX) return { redirect: true };
  if (!url.pathname.startsWith(ROUTE_PREFIX + '/')) return null;
  const encoded = url.pathname.slice(ROUTE_PREFIX.length + 1);
  const trailingSlash = url.pathname.endsWith('/');
  const rawSegments = encoded === '' ? [] : encoded.split('/');
  if (trailingSlash && rawSegments.at(-1) === '') rawSegments.pop();
  const segments = [];
  for (const raw of rawSegments) {
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!validPathSegment(decoded)) return null;
    segments.push(decoded);
  }
  return { segments, trailingSlash };
}

function validPathSegment(segment) {
  return Boolean(segment)
    && segment !== '.'
    && segment !== '..'
    && !segment.startsWith('.')
    && !/[\\/\0\r\n]/.test(segment)
    && !/[\u0000-\u001f\u007f]/.test(segment);
}

function isPrivateName(name) {
  return name.startsWith('.') || name.startsWith(TEMP_PREFIX);
}

function parseContentLength(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { invalid: true };
  return parsed;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return { invalid: true };
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return { invalid: true };
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function renderDirectoryPage({ root, segments, entries, uploadLimit, nonce }) {
  const title = segments.length ? segments.at(-1) : 'Downloads';
  const breadcrumbs = [
    `<a href="${ROUTE_PREFIX}/">Downloads</a>`,
    ...segments.map((segment, index) => {
      const url = buildDownloadsUrl(segments.slice(0, index + 1), true);
      return `<span>/</span><a href="${escapeHtml(url)}">${escapeHtml(segment)}</a>`;
    }),
  ].join('');
  const parent = segments.length
    ? `<a class="file-row parent-row" href="${escapeHtml(buildDownloadsUrl(segments.slice(0, -1), true))}"><span class="file-kind">↰</span><span class="file-name">Parent directory</span><span class="file-meta">Up one level</span></a>`
    : '';
  const rows = entries.map(entry => `
    <a class="file-row" href="${escapeHtml(entry.url)}">
      <span class="file-kind" aria-hidden="true">${entry.directory ? '▰' : '—'}</span>
      <span class="file-name">${escapeHtml(entry.name)}</span>
      <span class="file-meta">${entry.directory ? 'Folder' : formatBytes(entry.size)} · ${escapeHtml(formatDate(entry.modified))}</span>
    </a>`).join('');
  const empty = entries.length ? '' : '<div class="empty"><strong>No files yet</strong><span>Drop a file into this browser workspace.</span></div>';
  const rootLabel = path.basename(root) || root;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · WebBrain Downloads</title>
  <style>
    :root { --paper:#f7f1e6; --card:#fffdf8; --ink:#2c1810; --dim:#6b5b47; --line:rgba(89,55,25,.16); --violet:#5b52e8; --violet-soft:rgba(91,82,232,.09); --green:#2d8866; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 70% -20%,rgba(91,82,232,.16),transparent 40%),var(--paper); color:var(--ink); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(900px,calc(100% - 32px)); margin:0 auto; padding:56px 0 72px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px; }
    .eyebrow { margin:0 0 5px; color:var(--violet); font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:0; font-size:clamp(30px,5vw,46px); line-height:1.05; letter-spacing:-.04em; }
    .disk { flex:0 0 auto; padding:8px 11px; border:1px solid var(--line); border-radius:9px; background:rgba(255,253,248,.65); color:var(--dim); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .shell { overflow:hidden; border:1px solid var(--line); border-radius:16px; background:rgba(255,253,248,.92); box-shadow:0 22px 58px rgba(89,55,25,.11); }
    .pathbar { display:flex; flex-wrap:wrap; align-items:center; gap:7px; padding:14px 17px; border-bottom:1px solid var(--line); background:rgba(89,55,25,.025); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    a { color:inherit; }
    .pathbar a { color:var(--violet); font-weight:750; text-decoration:none; }
    .file-list { padding:8px; }
    .file-row { min-height:54px; display:grid; grid-template-columns:32px minmax(0,1fr) auto; align-items:center; gap:10px; padding:8px 10px; border-radius:9px; text-decoration:none; }
    .file-row:hover { background:var(--violet-soft); }
    .file-row:focus-visible,.upload-button:focus-visible,input:focus-visible { outline:3px solid rgba(91,82,232,.22); outline-offset:2px; }
    .file-kind { width:28px; height:28px; display:grid; place-items:center; border-radius:8px; background:var(--violet-soft); color:var(--violet); font-size:12px; font-weight:900; }
    .file-name { min-width:0; overflow:hidden; font-weight:720; text-overflow:ellipsis; white-space:nowrap; }
    .file-meta { color:var(--dim); font-size:11px; white-space:nowrap; }
    .parent-row { color:var(--dim); }
    .empty { min-height:180px; display:grid; place-content:center; gap:3px; color:var(--dim); text-align:center; }
    .empty strong { color:var(--ink); font-size:15px; }
    .upload { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:center; padding:16px 17px; border-top:1px solid var(--line); background:rgba(91,82,232,.045); }
    .upload-copy strong { display:block; font-size:12px; }
    .upload-copy span { color:var(--dim); font-size:11px; }
    .upload-control { display:flex; align-items:center; gap:8px; }
    input[type=file] { max-width:270px; color:var(--dim); font-size:11px; }
    .upload-button { min-height:34px; padding:6px 11px; border:1px solid var(--violet); border-radius:8px; background:var(--violet); color:#fff; font:700 12px inherit; cursor:pointer; }
    .upload-button:disabled { opacity:.48; cursor:not-allowed; }
    .upload-status { grid-column:1/-1; min-height:18px; color:var(--green); font-size:11px; }
    .upload-status.error { color:#a43b32; }
    @media(max-width:650px){ main{width:min(100% - 20px,900px);padding-top:30px} header{align-items:flex-start;flex-direction:column}.disk{display:none}.file-row{grid-template-columns:32px minmax(0,1fr)}.file-meta{grid-column:2;white-space:normal}.upload{grid-template-columns:1fr}.upload-control{align-items:stretch;flex-direction:column}.upload-button{width:100%}input[type=file]{max-width:100%} }
  </style>
</head>
<body>
  <main>
    <header><div><p class="eyebrow">WebBrain file tray</p><h1>${escapeHtml(title)}</h1></div><div class="disk">~/${escapeHtml(rootLabel)}</div></header>
    <section class="shell">
      <nav class="pathbar" aria-label="Current folder">${breadcrumbs}</nav>
      <div class="file-list">${parent}${rows}${empty}</div>
      <section class="upload">
        <div class="upload-copy"><strong>Upload to this folder</strong><span>Files up to ${formatBytes(uploadLimit)}. Existing names get a numbered copy.</span></div>
        <div class="upload-control"><input id="uploadFile" type="file"><button class="upload-button" id="uploadButton" type="button">Upload file</button></div>
        <div class="upload-status" id="uploadStatus" aria-live="polite"></div>
      </section>
    </section>
  </main>
  <script nonce="${nonce}">
    const input = document.getElementById('uploadFile');
    const button = document.getElementById('uploadButton');
    const status = document.getElementById('uploadStatus');
    button.addEventListener('click', () => {
      const file = input.files && input.files[0];
      if (!file) { status.textContent = 'Choose a file first.'; status.className = 'upload-status error'; return; }
      button.disabled = true;
      status.className = 'upload-status';
      status.textContent = 'Uploading…';
      const request = new XMLHttpRequest();
      request.open('PUT', location.pathname + encodeURIComponent(file.name));
      request.upload.onprogress = event => {
        if (event.lengthComputable) status.textContent = 'Uploading… ' + Math.round((event.loaded / event.total) * 100) + '%';
      };
      request.onload = () => {
        if (request.status === 201) { status.textContent = 'Uploaded.'; location.reload(); return; }
        status.className = 'upload-status error';
        status.textContent = request.responseText || ('Upload failed with HTTP ' + request.status + '.');
        button.disabled = false;
      };
      request.onerror = () => { status.className = 'upload-status error'; status.textContent = 'Upload connection failed.'; button.disabled = false; };
      request.send(file);
    });
  </script>
</body>
</html>`;
}

function buildDownloadsUrl(segments, directory) {
  const suffix = segments.map(segment => encodeURIComponent(segment)).join('/');
  return ROUTE_PREFIX + '/' + suffix + (directory && suffix ? '/' : '');
}

function setSecurityHeaders(res) {
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
}

function sendText(res, status, message) {
  if (res.headersSent || res.destroyed) return;
  const body = String(message);
  res.writeHead(status, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end(body);
}

function contentDisposition(name) {
  const fallback = String(name || 'download').replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name || 'download'))}`;
}

function contentTypeFor(name) {
  const extension = path.extname(String(name)).toLowerCase();
  return ({
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.htm': 'text/html; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
  })[extension] || 'application/octet-stream';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return amount.toFixed(amount >= 10 || Number.isInteger(amount) ? 0 : 1) + ' ' + units[unit];
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
  } catch {
    return '';
  }
}

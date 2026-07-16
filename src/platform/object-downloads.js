import path from 'node:path';
import { Readable, Transform } from 'node:stream';

const ROUTE_PREFIX = '/downloads';
const INTERNAL_PREFIX = '.webbrain-internal/';
const UPLOAD_ID_METADATA_KEY = 'webbrain-upload-id';

export function createObjectDownloadsHandler({
  objectStore,
  quotaBytes,
  maxUploadBytes = quotaBytes,
  prefixForUser = userId => `users/${userId}/`,
} = {}) {
  if (!objectStore) throw new TypeError('objectStore is required');
  const quota = positiveSafeInteger(quotaBytes, 'Downloads quota');
  const uploadLimit = positiveSafeInteger(maxUploadBytes, 'Downloads upload limit');
  const userLocks = new Map();

  async function listUserObjects(userId) {
    const prefix = prefixForUser(userId);
    const objects = await objectStore.list(prefix);
    return objects
      .filter(item => item.key.startsWith(prefix) && item.key.length > prefix.length)
      .map(item => ({
        ...item,
        relativeKey: item.key.slice(prefix.length),
      }))
      .filter(item => !item.relativeKey.startsWith(INTERNAL_PREFIX));
  }

  async function uploadStream({
    userId,
    requestedPath,
    stream,
    contentLength = null,
    contentType = '',
    idempotencyKey = '',
  }) {
    const segments = parseRelativePath(requestedPath);
    if (!segments?.length) throw httpError(400, 'Upload path must include a filename.');
    const declared = parseContentLength(contentLength);
    if (declared?.invalid) throw httpError(400, 'Invalid Content-Length.');
    if (declared != null && declared > uploadLimit) {
      throw httpError(413, `File exceeds the ${formatBytes(uploadLimit)} upload limit.`);
    }

    return await withUserLock(userLocks, userId, async () => {
      const prefix = prefixForUser(userId);
      const objects = await listUserObjects(userId);
      const usedBytes = objects.reduce((sum, item) => sum + Number(item.size || 0), 0);
      const availableBytes = Math.max(0, quota - usedBytes);

      const requested = segments.join('/');
      const occupied = new Set(objects.map(item => item.relativeKey));
      const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
      const markerKey = normalizedIdempotencyKey ? `${prefix}${INTERNAL_PREFIX}${normalizedIdempotencyKey}.json` : '';
      const marker = markerKey ? await readUploadMarker(objectStore, markerKey) : null;
      const validMarker = marker?.requested === requested
          && typeof marker.path === 'string'
          && parseRelativePath(marker.path)?.length
        ? marker
        : null;
      if (validMarker) {
        const finalPath = validMarker.path;
        const existing = await objectStore.head(prefix + finalPath);
        const committedMatch = validMarker.committed === true
          && Number(existing?.size || 0) === Number(validMarker.size || 0)
          && (!validMarker.etag || !existing?.etag || validMarker.etag === existing.etag);
        const reservationSizeMatch = validMarker.expected_size == null
          ? declared == null || Number(existing?.size || 0) === declared
          : Number(existing?.size || 0) === Number(validMarker.expected_size);
        const reservationMatch = validMarker.upload_id === normalizedIdempotencyKey
          && existing?.metadata?.[UPLOAD_ID_METADATA_KEY] === normalizedIdempotencyKey
          && reservationSizeMatch;
        if (existing && (committedMatch || reservationMatch)) {
          stream.resume?.();
          return {
            name: path.posix.basename(finalPath),
            path: finalPath,
            size: Number(existing.size || 0),
            url: downloadsUrl(finalPath),
            etag: existing.etag || null,
            idempotent: true,
          };
        }
      }
      const canReuseReservation = validMarker?.upload_id === normalizedIdempotencyKey
        && !occupied.has(validMarker.path);
      const finalPath = canReuseReservation ? validMarker.path : availableObjectName(requested, occupied);
      if (availableBytes <= 0 || (declared != null && declared > availableBytes)) {
        throw httpError(507, `Downloads quota of ${formatBytes(quota)} has been reached.`);
      }
      if (markerKey && (!validMarker
          || validMarker.path !== finalPath
          || validMarker.upload_id !== normalizedIdempotencyKey)) {
        await writeUploadMarker(objectStore, markerKey, {
          committed: false,
          requested,
          path: finalPath,
          upload_id: normalizedIdempotencyKey,
          expected_size: declared,
        });
      }
      const limiter = limitStream(Math.min(uploadLimit, availableBytes));
      const upload = objectStore.put(prefix + finalPath, limiter, {
        contentLength: declared,
        contentType: contentType || contentTypeFor(finalPath),
        metadata: normalizedIdempotencyKey ? { [UPLOAD_ID_METADATA_KEY]: normalizedIdempotencyKey } : {},
      });
      const abortUpload = error => limiter.destroy(error instanceof Error ? error : new Error('Downloads upload was interrupted.'));
      stream.once('error', abortUpload);
      stream.once('aborted', abortUpload);
      stream.pipe(limiter);
      try {
        const result = await upload;
        if (markerKey) {
          await writeUploadMarker(objectStore, markerKey, {
            committed: true,
            requested,
            path: finalPath,
            upload_id: normalizedIdempotencyKey,
            expected_size: declared,
            size: limiter.bytesRead,
            etag: result?.etag || null,
          }).catch(error => {
            console.error('[downloads] object published but idempotency marker finalization failed:', error.message || error);
          });
        }
        return {
          name: path.posix.basename(finalPath),
          path: finalPath,
          size: limiter.bytesRead,
          url: downloadsUrl(finalPath),
          etag: result?.etag || null,
        };
      } catch (error) {
        stream.unpipe(limiter);
        stream.resume?.();
        if (error.code === 'DOWNLOADS_LIMIT_EXCEEDED') {
          throw httpError(error.limit === uploadLimit ? 413 : 507,
            error.limit === uploadLimit
              ? `File exceeds the ${formatBytes(uploadLimit)} upload limit.`
              : `Downloads quota of ${formatBytes(quota)} has been reached.`);
        }
        throw error;
      } finally {
        stream.off('error', abortUpload);
        stream.off('aborted', abortUpload);
      }
    });
  }

  async function handleRequest(req, res, { userId }) {
    setSecurityHeaders(res);
    const route = parseRoute(req.url);
    if (!route) return sendText(res, 404, 'Not found');
    if (route.redirect) {
      res.writeHead(308, { location: ROUTE_PREFIX + '/' });
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      if (route.trailingSlash || route.segments.length === 0) return sendText(res, 400, 'Upload URL must include a filename.');
      try {
        const uploaded = await uploadStream({
          userId,
          requestedPath: route.segments.join('/'),
          stream: req,
          contentLength: req.headers['content-length'],
          contentType: req.headers['content-type'],
          idempotencyKey: req.headers['x-webbrain-download-id'],
        });
        const body = JSON.stringify(uploaded);
        res.writeHead(201, {
          'cache-control': 'private, no-store',
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json; charset=utf-8',
          location: uploaded.url,
        });
        res.end(body);
      } catch (error) {
        sendText(res, error.status || 500, error.expose ? error.message : 'Downloads storage error');
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD, PUT');
      return sendText(res, 405, 'Method not allowed');
    }

    const relativePath = route.segments.join('/');
    const prefix = prefixForUser(userId);
    if (!route.trailingSlash && relativePath) {
      const object = await objectStore.head(prefix + relativePath).catch(error => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (object) return await serveObject(req, res, objectStore, prefix + relativePath, relativePath, object);
    }

    const objects = await listUserObjects(userId);
    const directoryPrefix = relativePath ? relativePath + '/' : '';
    const hasDirectory = objects.some(item => item.relativeKey.startsWith(directoryPrefix));
    if (relativePath && !hasDirectory) return sendText(res, 404, 'Not found');
    if (!route.trailingSlash) {
      res.writeHead(308, { location: downloadsUrl(relativePath, true) });
      res.end();
      return;
    }
    return serveDirectory(req, res, route.segments, objects, { quota, uploadLimit });
  }

  return { handleRequest, uploadStream, listUserObjects };
}

async function serveObject(req, res, objectStore, key, relativePath, object) {
  const size = Number(object.size || 0);
  const range = parseRange(req.headers.range, size);
  if (range?.invalid) {
    res.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` });
    return res.end();
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const contentLength = size === 0 ? 0 : end - start + 1;
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-disposition': contentDisposition(path.posix.basename(relativePath)),
    'content-length': contentLength,
    'content-type': object.contentType || contentTypeFor(relativePath),
    'last-modified': new Date(object.modifiedAt || Date.now()).toUTCString(),
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const result = await objectStore.get(key, range || null);
  const body = result?.body;
  if (!body) return res.end();
  const stream = bodyToNodeReadable(body);
  stream.once('error', error => res.destroy(error));
  stream.pipe(res);
}

function serveDirectory(req, res, segments, objects, { quota, uploadLimit }) {
  const directoryPrefix = segments.length ? segments.join('/') + '/' : '';
  const directories = new Set();
  const files = [];
  for (const object of objects) {
    if (!object.relativeKey.startsWith(directoryPrefix)) continue;
    const remainder = object.relativeKey.slice(directoryPrefix.length);
    if (!remainder) continue;
    const slash = remainder.indexOf('/');
    if (slash !== -1) {
      directories.add(remainder.slice(0, slash));
      continue;
    }
    files.push({
      name: remainder,
      path: object.relativeKey,
      type: 'file',
      size: Number(object.size || 0),
      modified_at: new Date(object.modifiedAt || Date.now()).toISOString(),
      url: downloadsUrl(object.relativeKey),
    });
  }
  const entries = [
    ...[...directories].sort(naturalCompare).map(name => ({
      name,
      path: directoryPrefix + name,
      type: 'directory',
      size: null,
      modified_at: null,
      url: downloadsUrl(directoryPrefix + name, true),
    })),
    ...files.sort((a, b) => naturalCompare(a.name, b.name)),
  ];
  const usedBytes = objects.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (acceptsJson(req)) {
    const body = JSON.stringify({
      path: segments.join('/'),
      entries,
      upload_limit_bytes: uploadLimit,
      quota_bytes: quota,
      used_bytes: usedBytes,
    });
    res.writeHead(200, {
      'cache-control': 'private, no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json; charset=utf-8',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }
  const html = renderDirectoryPage({ segments, entries, uploadLimit, quota, usedBytes });
  res.writeHead(200, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(html),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(html);
}

function renderDirectoryPage({ segments, entries, uploadLimit, quota, usedBytes }) {
  const title = segments.at(-1) || 'Downloads';
  const rows = entries.map(entry => `<a class="row" href="${escapeHtml(entry.url)}"><span>${entry.type === 'directory' ? '▰' : '—'}</span><strong>${escapeHtml(entry.name)}</strong><small>${entry.type === 'directory' ? 'Folder' : formatBytes(entry.size)}</small></a>`).join('');
  const parent = segments.length ? `<a class="row" href="${escapeHtml(downloadsUrl(segments.slice(0, -1).join('/'), true))}"><span>↰</span><strong>Parent directory</strong><small>Up one level</small></a>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · WebBrain Downloads</title><style>
  :root{--paper:#f7f1e6;--card:#fffdf8;--ink:#2c1810;--dim:#6b5b47;--line:rgba(89,55,25,.16);--violet:#5b52e8}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 system-ui,sans-serif}main{width:min(860px,calc(100% - 28px));margin:48px auto}h1{font-size:40px;letter-spacing:-.04em}.meta{color:var(--dim)}.shell{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--card);box-shadow:0 20px 55px rgba(89,55,25,.1)}.list{padding:8px}.row{display:grid;grid-template-columns:30px 1fr auto;gap:10px;align-items:center;min-height:52px;padding:8px 11px;border-radius:9px;color:inherit;text-decoration:none}.row:hover{background:rgba(91,82,232,.08)}small{color:var(--dim)}.upload{display:flex;gap:10px;align-items:center;padding:16px;border-top:1px solid var(--line)}input{min-width:0;flex:1}button{padding:9px 13px;border:0;border-radius:8px;background:var(--violet);color:white;font-weight:700}.status{padding:0 16px 16px;color:var(--dim)}</style></head><body><main><p class="meta">WEBBRAIN SHARED STORAGE</p><h1>${escapeHtml(title)}</h1><p class="meta">${formatBytes(usedBytes)} of ${formatBytes(quota)} used · available even while browsers are paused</p><section class="shell"><div class="list">${parent}${rows || '<p class="meta">No files yet.</p>'}</div><div class="upload"><input id="file" type="file"><button id="send">Upload</button></div><div class="status" id="status">Files up to ${formatBytes(uploadLimit)}.</div></section></main><script>
  const input=document.getElementById('file'),button=document.getElementById('send'),status=document.getElementById('status');button.onclick=()=>{const file=input.files&&input.files[0];if(!file){status.textContent='Choose a file first.';return}button.disabled=true;status.textContent='Uploading…';const xhr=new XMLHttpRequest();xhr.open('PUT',location.pathname+encodeURIComponent(file.name));xhr.upload.onprogress=e=>{if(e.lengthComputable)status.textContent='Uploading… '+Math.round(e.loaded/e.total*100)+'%'};xhr.onload=()=>{if(xhr.status===201){location.reload();return}status.textContent=xhr.responseText||'Upload failed.';button.disabled=false};xhr.onerror=()=>{status.textContent='Upload connection failed.';button.disabled=false};xhr.send(file)};
  </script></body></html>`;
}

function limitStream(limit) {
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      this.bytesRead += chunk.length;
      if (this.bytesRead > limit) {
        const error = new Error('Downloads stream limit exceeded.');
        error.code = 'DOWNLOADS_LIMIT_EXCEEDED';
        error.limit = limit;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  stream.bytesRead = 0;
  return stream;
}

function availableObjectName(requested, occupied) {
  if (!occupied.has(requested)) return requested;
  const directory = path.posix.dirname(requested);
  const filename = path.posix.basename(requested);
  const extension = path.posix.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  for (let index = 1; index < 100_000; index += 1) {
    const name = `${stem} (${index})${extension}`;
    const candidate = directory === '.' ? name : `${directory}/${name}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw httpError(409, 'Could not allocate an available filename.');
}

function withUserLock(locks, userId, task) {
  const previous = locks.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(userId, current);
  return current.finally(() => {
    if (locks.get(userId) === current) locks.delete(userId);
  });
}

function parseRoute(requestUrl) {
  let url;
  try { url = new URL(String(requestUrl || '/'), 'http://127.0.0.1'); } catch { return null; }
  if (url.pathname === ROUTE_PREFIX) return { redirect: true };
  if (!url.pathname.startsWith(ROUTE_PREFIX + '/')) return null;
  const raw = url.pathname.slice(ROUTE_PREFIX.length + 1);
  const trailingSlash = url.pathname.endsWith('/');
  const rawSegments = raw ? raw.split('/') : [];
  if (trailingSlash && rawSegments.at(-1) === '') rawSegments.pop();
  const segments = [];
  for (const value of rawSegments) {
    let segment;
    try { segment = decodeURIComponent(value); } catch { return null; }
    if (!validSegment(segment)) return null;
    segments.push(segment);
  }
  return { segments, trailingSlash };
}

function parseRelativePath(value) {
  const raw = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!raw) return [];
  const segments = raw.split('/');
  return segments.every(validSegment) ? segments : null;
}

function validSegment(segment) {
  return Boolean(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('.')
    && !/[\\/\0\r\n]/.test(segment) && !/[\u0000-\u001f\u007f]/.test(segment);
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{1,128}$/.test(key) ? key : '';
}

async function readUploadMarker(objectStore, key) {
  const metadata = await objectStore.head(key);
  if (!metadata) return null;
  try {
    const result = await objectStore.get(key);
    const stream = bodyToNodeReadable(result?.body);
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > 8192) return null;
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function writeUploadMarker(objectStore, key, marker) {
  const body = Buffer.from(JSON.stringify(marker));
  await objectStore.put(key, Readable.from(body), {
    contentLength: body.length,
    contentType: 'application/json',
  });
}

function bodyToNodeReadable(body) {
  if (typeof body?.pipe === 'function') return body;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return Readable.fromWeb(body);
  return Readable.from(body || []);
}

function downloadsUrl(relativePath = '', directory = false) {
  const encoded = String(relativePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${ROUTE_PREFIX}/${encoded}${directory && encoded ? '/' : ''}`;
}

function parseContentLength(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : { invalid: true };
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
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return { invalid: true };
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function positiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return parsed;
}

function acceptsJson(req) {
  return String(req.headers.accept || '').split(',').some(value => value.split(';')[0].trim().toLowerCase() === 'application/json');
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

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function isNotFound(error) {
  return error?.status === 404 || error?.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error?.name);
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function contentDisposition(name) {
  const fallback = String(name || 'download').replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name || 'download'))}`;
}

function contentTypeFor(name) {
  const extension = path.extname(String(name)).toLowerCase();
  return ({ '.csv': 'text/csv; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.webm': 'video/webm', '.webp': 'image/webp', '.zip': 'application/zip' })[extension] || 'application/octet-stream';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 || Number.isInteger(amount) ? 0 : 1)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

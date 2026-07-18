import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

export class ChromeDownloadSync {
  constructor({
    stagingDir,
    ingestUrl,
    sessionToken,
    fetchImpl = fetch,
    retryDelaysMs = RETRY_DELAYS_MS,
  }) {
    if (!stagingDir || !ingestUrl || !sessionToken) throw new TypeError('Download sync configuration is incomplete.');
    this.stagingDir = path.resolve(stagingDir);
    this.ingestUrl = String(ingestUrl).replace(/\/+$/, '');
    this.sessionToken = sessionToken;
    this.fetch = fetchImpl;
    this.retryDelaysMs = retryDelaysMs;
    this.records = new Map();
    this.persisting = new Map();
    this.uploading = new Set();
    this.timers = new Set();
    this.stopped = false;
  }

  async start(cdp) {
    await fs.mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    await this.recover();
    cdp.on('Browser.downloadWillBegin', event => this.onDownloadWillBegin(event));
    cdp.on('Browser.downloadProgress', event => this.onDownloadProgress(event));
    await cdp.call('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: this.stagingDir,
      eventsEnabled: true,
    });
  }

  async recover() {
    const entries = await fs.readdir(this.stagingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.tmp')) {
        await fs.rm(path.join(this.stagingDir, entry.name), { force: true });
      }
    }
    const metadataFiles = new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name));
    for (const metadataFile of metadataFiles) {
      const metadataPath = path.join(this.stagingDir, metadataFile);
      try {
        const record = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        if (!validGuid(record.guid)) {
          await fs.rm(metadataPath, { force: true });
          continue;
        }
        if (!record.completed) {
          if (await this.hasNonEmptyData(record.guid)) {
            await this.recoverPartial(record.guid, record);
          } else {
            await this.removeRecordFiles(record.guid, metadataPath);
          }
          continue;
        }
        const filePath = this.dataPath(record.guid);
        await fs.access(filePath);
        this.records.set(record.guid, record);
        this.queueUpload(record.guid, 0);
      } catch {
        const guid = metadataFile.slice(0, -'.json'.length);
        if (validGuid(guid) && await this.hasNonEmptyData(guid)) {
          await this.recoverPartial(guid);
        } else {
          if (validGuid(guid)) await fs.rm(this.dataPath(guid), { force: true });
          await fs.rm(metadataPath, { force: true });
        }
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.json') || entry.name.endsWith('.tmp') || metadataFiles.has(`${entry.name}.json`)) continue;
      if (!validGuid(entry.name)) continue;
      if (await this.hasNonEmptyData(entry.name)) {
        await this.recoverPartial(entry.name);
      } else {
        await fs.rm(this.dataPath(entry.name), { force: true });
      }
    }
  }

  async recoverPartial(guid, previousRecord = null) {
    const now = new Date().toISOString();
    const originalFilename = safeFilename(
      previousRecord?.filename || `recovered-download-${guid}`,
    );
    const record = {
      ...(previousRecord || {}),
      guid,
      filename: originalFilename.endsWith('.partial')
        ? originalFilename
        : `${originalFilename}.partial`,
      source_url: String(previousRecord?.source_url || ''),
      completed: true,
      recovered_partial: true,
      created_at: previousRecord?.created_at || now,
      completed_at: now,
    };
    delete record.upload_error;
    this.records.set(guid, record);
    await this.persist(record);
    this.queueUpload(guid, 0);
  }

  onDownloadWillBegin(event) {
    if (!validGuid(event?.guid)) return;
    const record = {
      guid: event.guid,
      filename: safeFilename(event.suggestedFilename || 'download'),
      source_url: String(event.url || ''),
      completed: false,
      created_at: new Date().toISOString(),
    };
    this.records.set(record.guid, record);
    this.persist(record).catch(error => console.error('[download-sync] could not save download metadata:', error.message || error));
  }

  onDownloadProgress(event) {
    if (!validGuid(event?.guid)) return;
    if (event.state === 'canceled') {
      this.records.delete(event.guid);
      const pending = this.persisting.get(event.guid) || Promise.resolve();
      pending.catch(() => {}).then(() => this.removeRecordFiles(event.guid)).catch(() => {});
      return;
    }
    if (event.state !== 'completed') return;
    const record = this.records.get(event.guid) || {
      guid: event.guid,
      filename: 'download',
      source_url: '',
      created_at: new Date().toISOString(),
    };
    record.completed = true;
    record.completed_at = new Date().toISOString();
    this.records.set(record.guid, record);
    this.persist(record)
      .then(() => this.queueUpload(record.guid, 0))
      .catch(error => console.error('[download-sync] could not finalize download metadata:', error.message || error));
  }

  queueUpload(guid, attempt) {
    if (this.stopped || this.uploading.has(guid)) return;
    this.uploading.add(guid);
    this.upload(guid).catch(error => {
      if (this.stopped) return;
      if (error.terminal === true) {
        const record = this.records.get(guid);
        if (record) {
          record.upload_error = {
            status: Number(error.status || 0),
            message: String(error.message || 'Shared storage rejected the download.').slice(0, 500),
            failed_at: new Date().toISOString(),
          };
          this.persist(record).catch(persistError => {
            console.error('[download-sync] could not save terminal upload error:', persistError.message || persistError);
          });
        }
        console.error('[download-sync] upload rejected permanently; restart the browser service after correcting shared storage:', error.message || error);
        return;
      }
      const delay = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] || 60_000;
      console.error(`[download-sync] upload failed; retrying in ${delay}ms:`, error.message || error);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.queueUpload(guid, attempt + 1);
      }, delay);
      timer.unref?.();
      this.timers.add(timer);
    }).finally(() => this.uploading.delete(guid));
  }

  async upload(guid) {
    const record = this.records.get(guid);
    if (!record?.completed) return;
    const filePath = this.dataPath(guid);
    const stat = await fs.stat(filePath);
    const target = `${this.ingestUrl}/${encodeURIComponent(record.filename)}`;
    const response = await this.fetch(target, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.sessionToken}`,
        'content-length': String(stat.size),
        'content-type': 'application/octet-stream',
        'x-webbrain-download-id': guid,
      },
      body: createReadStream(filePath),
      duplex: 'half',
    });
    if (!response.ok) {
      const error = new Error(`platform returned ${response.status}: ${await response.text()}`);
      error.status = response.status;
      error.terminal = isTerminalUploadStatus(response.status);
      throw error;
    }
    const responseText = await response.text();
    let uploaded = {};
    try { uploaded = responseText ? JSON.parse(responseText) : {}; } catch {}
    await this.removeRecordFiles(guid);
    this.records.delete(guid);
    console.log(`[download-sync] uploaded ${record.filename} as ${uploaded.path || uploaded.name || record.filename}`);
  }

  async persist(record) {
    const target = this.metadataPath(record.guid);
    const temporary = `${target}.${process.pid}.tmp`;
    const contents = JSON.stringify(record);
    const previous = this.persisting.get(record.guid) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      try {
        await fs.writeFile(temporary, contents, { mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    this.persisting.set(record.guid, current);
    try {
      await current;
    } finally {
      if (this.persisting.get(record.guid) === current) this.persisting.delete(record.guid);
    }
  }

  dataPath(guid) {
    return path.join(this.stagingDir, guid);
  }

  metadataPath(guid) {
    return path.join(this.stagingDir, `${guid}.json`);
  }

  async hasNonEmptyData(guid) {
    try {
      return (await fs.stat(this.dataPath(guid))).size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async removeRecordFiles(guid, knownMetadataPath = '') {
    if (validGuid(guid)) await fs.rm(this.dataPath(guid), { force: true });
    if (knownMetadataPath) await fs.rm(knownMetadataPath, { force: true });
    else if (validGuid(guid)) await fs.rm(this.metadataPath(guid), { force: true });
  }

  close() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

function safeFilename(value) {
  const name = path.posix.basename(String(value || '').replaceAll('\\', '/')).trim();
  if (!name || name === '.' || name === '..' || name.startsWith('.')) return 'download';
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 240) || 'download';
}

function validGuid(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isTerminalUploadStatus(status) {
  return status === 507 || (status >= 400 && status < 500 && ![408, 425, 429].includes(status));
}

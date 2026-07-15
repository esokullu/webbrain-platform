#!/usr/bin/env node
import {
  createDownloadsService,
  DEFAULT_DOWNLOADS_ROOT,
  DEFAULT_DOWNLOADS_UPLOAD_LIMIT_BYTES,
} from './downloads-service.js';

const service = createDownloadsService({
  rootDir: process.env.WEBBRAIN_DOWNLOADS_ROOT || DEFAULT_DOWNLOADS_ROOT,
  maxUploadBytes: Number(process.env.WEBBRAIN_DOWNLOADS_UPLOAD_LIMIT_BYTES || DEFAULT_DOWNLOADS_UPLOAD_LIMIT_BYTES),
});
const host = process.env.WEBBRAIN_DOWNLOADS_HOST || '127.0.0.1';
const port = Number(process.env.WEBBRAIN_DOWNLOADS_PORT || 6083);
await service.listen(port, host);
console.log(`WebBrain Downloads service listening on http://${host}:${port}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await service.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

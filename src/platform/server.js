import http from 'node:http';
import { createPlatformApp } from './app.js';
import { DropletControlChannel } from './control-channel.js';
import { createInstanceProxy } from './instance-proxy.js';
import { createObjectDownloadsHandler } from './object-downloads.js';
import { createSpacesObjectStore } from './spaces-object-store.js';

export function createPlatformServer({ store, provisioner, config, downloadsHandler: injectedDownloadsHandler = null }) {
  const spacesObjectStore = injectedDownloadsHandler ? null : createSpacesObjectStore(config.downloads?.spaces);
  const downloadsHandler = injectedDownloadsHandler || (spacesObjectStore ? createObjectDownloadsHandler({
    objectStore: spacesObjectStore,
    quotaBytes: config.downloads.quotaBytes,
    maxUploadBytes: config.downloads.maxUploadBytes,
  }) : null);
  const controlChannel = new DropletControlChannel({
    store,
    requestTimeoutMs: config.runWaitTimeoutMs,
  });
  const app = createPlatformApp({ store, provisioner, controlChannel, config, downloadsHandler });
  const instanceProxy = createInstanceProxy({
    store,
    domain: config.instanceDomain,
    targetPort: config.droplet.noVncGatePort,
    downloadsHandler,
  });
  const server = http.createServer((req, res) => {
    instanceProxy.handleRequest(req, res)
      .then(handled => {
        if (!handled) app(req, res);
      })
      .catch(error => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Instance proxy error');
      });
  });
  // Downloads are streamed and can legitimately take longer than Node's
  // default five-minute whole-request timer. Header and socket protections
  // remain in place, and production traffic arrives through the HTTPS proxy.
  server.requestTimeout = 0;
  instanceProxy.attach(server);
  controlChannel.attach(server);

  return {
    app,
    server,
    controlChannel,
    listen(port = config.port, host = config.host) {
      return new Promise(resolve => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      return new Promise(resolve => {
        Promise.all([controlChannel.close(), instanceProxy.close()]).then(() => {
          spacesObjectStore?.close();
          server.close(resolve);
        });
      });
    },
  };
}

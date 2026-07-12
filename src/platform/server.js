import http from 'node:http';
import { createPlatformApp } from './app.js';
import { DropletControlChannel } from './control-channel.js';
import { createInstanceProxy } from './instance-proxy.js';

export function createPlatformServer({ store, provisioner, config }) {
  const controlChannel = new DropletControlChannel({
    store,
    requestTimeoutMs: config.runWaitTimeoutMs,
  });
  const app = createPlatformApp({ store, provisioner, controlChannel, config });
  const instanceProxy = createInstanceProxy({
    store,
    domain: config.instanceDomain,
    targetPort: config.droplet.noVncGatePort,
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
        Promise.all([controlChannel.close(), instanceProxy.close()]).then(() => server.close(resolve));
      });
    },
  };
}

import http from 'node:http';
import { createPlatformApp } from './app.js';
import { DropletControlChannel } from './control-channel.js';

export function createPlatformServer({ store, provisioner, config }) {
  const controlChannel = new DropletControlChannel({
    store,
    requestTimeoutMs: config.runWaitTimeoutMs,
  });
  const app = createPlatformApp({ store, provisioner, controlChannel, config });
  const server = http.createServer(app);
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
        controlChannel.close().then(() => server.close(resolve));
      });
    },
  };
}

#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createStore } from '../db/index.js';
import { DigitalOceanProvisioner, NullProvisioner } from './digitalocean.js';
import { createPlatformServer } from './server.js';

const config = loadConfig();
const store = createStore(config.db);
await store.migrate();

const provisioner = process.env.WEBBRAIN_PROVISIONER === 'null'
  ? new NullProvisioner()
  : new DigitalOceanProvisioner(config);

const platform = createPlatformServer({ store, provisioner, config });
await platform.listen();
console.log(`WebBrain platform listening on http://${config.host}:${config.port}`);

process.on('SIGINT', async () => {
  await platform.close();
  await store.close?.();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await platform.close();
  await store.close?.();
  process.exit(0);
});

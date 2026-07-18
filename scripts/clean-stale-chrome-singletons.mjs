#!/usr/bin/env node
import { cleanStaleChromeSingletons } from '../src/droplet/chrome-singletons.js';

const result = await cleanStaleChromeSingletons();
if (result.removed.length) {
  console.log(`[chrome-profile] removed stale entries: ${result.removed.join(', ')}`);
}

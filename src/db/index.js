import { MemoryStore } from './memory.js';
import { MySqlStore } from './mysql.js';

export function createStore(config) {
  if (config.driver === 'memory') return new MemoryStore();
  if (config.driver === 'mysql') return new MySqlStore(config);
  throw new Error(`Unsupported database driver: ${config.driver}`);
}

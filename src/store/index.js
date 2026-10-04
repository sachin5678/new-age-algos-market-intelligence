import { MemoryStore } from './memory.js';
import { SqliteStore } from './sqlite.js';

export function openStore({ driver = 'sqlite', dbPath = ':memory:' } = {}) {
  if (driver === 'memory') return new MemoryStore();
  if (driver === 'sqlite') return new SqliteStore(dbPath);
  throw new Error(`Unknown store driver: ${driver}`);
}

export { MemoryStore, SqliteStore };

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const SECRET_KEY_RE = /api[_-]?key|apikey|token|secret|password|authorization|session|credential|auth_/i;
const SECRET_VAL_RE = /sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Deep-clone a value, masking secret-looking keys/values. Never logs secrets. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.replace(SECRET_VAL_RE, '[REDACTED]');
  return value;
}

/**
 * Structured stage logger.
 * Stages: COLLECT | NORMALIZE | DEDUPE | EVENT_DETECT | CLASSIFY | AI_ANALYZE | PUBLISH_DECISION | TELEGRAM_SEND
 */
export function createLogger({
  runId = `run_${Date.now()}`,
  dir = null,
  toConsole = true,
  minLevel = 'INFO',
  clock = () => new Date(),
} = {}) {
  let fd = null;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(path.join(dir, `${runId}.jsonl`), 'a');
  }
  const min = LEVELS[String(minLevel).toUpperCase()] ?? 20;

  function log(stage, level, msg, data = null) {
    const lvl = String(level).toUpperCase();
    const lv = LEVELS[lvl] ?? 20;
    if (lv < min) return;
    const ts = clock().toISOString();
    const safeData = data === null || data === undefined ? null : redact(data);
    const safeMsg = typeof msg === 'string' ? redact(msg) : String(msg);
    const line = { ts, runId, stage, level: lvl, levelName: lvl, msg: safeMsg, ...(safeData !== null ? { data: safeData } : {}) };
    if (fd) fs.writeSync(fd, JSON.stringify(line) + '\n');
    if (toConsole) {
      const time = ts.slice(11, 19);
      const extra = safeData !== null ? ' ' + JSON.stringify(safeData) : '';
      process.stdout.write(`${time} ${lvl.padEnd(5)} [${stage}] ${safeMsg}${extra}\n`);
    }
  }

  return {
    runId,
    log,
    debug: (stage, msg, data) => log(stage, 'DEBUG', msg, data),
    info: (stage, msg, data) => log(stage, 'INFO', msg, data),
    warn: (stage, msg, data) => log(stage, 'WARN', msg, data),
    error: (stage, msg, data) => log(stage, 'ERROR', msg, data),
    redact,
    close() {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        fd = null;
      }
    },
  };
}

export function nullLogger() {
  return {
    runId: 'null',
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    redact,
    close() {},
  };
}

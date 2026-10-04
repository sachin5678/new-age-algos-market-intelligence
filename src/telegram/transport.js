/**
 * Telegram transports. The application owns delivery — the AI layer never touches these.
 *
 *  - DryRunTransport (default): prints the message, sends nothing.
 *  - JsonEmitTransport: emits structured JSON for an external sender.
 *  - GramJsTransport: real sending via the existing .mcp-telegram session.
 *
 * Messages are formatted as Telegram HTML (<b>, <i>, <u>, …). MarkdownV2 is NOT
 * used: gramjs' MarkdownV2 parser ignores backslash escapes and mangles hyphens,
 * so `\(x\)` / `\-` rendered literally in the delivered message.
 */

import { decodeEntities } from '../normalize/normalizeArticle.js';

export class DryRunTransport {
  constructor({ logger = null, out = process.stdout } = {}) {
    this.logger = logger;
    this.out = out;
    this.name = 'dry-run';
  }

  async send(text, meta = {}) {
    this.logger?.info('TELEGRAM_SEND', `DRY_RUN — not sent (${text.length} chars)`, { mode: meta.mode ?? null });
    // Show the reader what Telegram will render: strip tags, restore entities.
    const rendered = decodeEntities(String(text).replace(/<[^>]+>/g, ''));
    this.out.write(`\n---------- TELEGRAM MESSAGE (DRY RUN — nothing sent) ----------\n${rendered}\n--------------------------------------------------------------\n`);
    return { message_id: null, dry_run: true };
  }
}

export class JsonEmitTransport {
  constructor({ out = process.stdout } = {}) {
    this.out = out;
    this.name = 'json-emit';
  }

  async send(text, meta = {}) {
    this.out.write(JSON.stringify({ type: 'telegram_outbox', text, ...meta }) + '\n');
    return { message_id: null, emitted: true };
  }
}

/** Sleep utility for retries. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter: base * 2^attempt ± 25% */
function backoffDelay(attempt, baseMs = 1000) {
  const delay = baseMs * Math.pow(2, attempt);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(delay + jitter));
}

/**
 * Escape a value for safe embedding in a Telegram HTML message.
 * Decodes residual HTML entities first (stale rows may still contain `&#39;`),
 * then escapes `&`, `<`, `>` so injected markup can never become real tags.
 */
export function escapeHtml(text = '') {
  return decodeEntities(String(text))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * GramJsTransport: real sending via the existing .mcp-telegram session.
 * Requires `npm i telegram` (gramjs).
 */
export class GramJsTransport {
  constructor({ chatId, apiId, apiHash, sessionPath, logger = null } = {}) {
    this.chatId = chatId;
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.sessionPath = sessionPath;
    this.logger = logger;
    this.name = 'gramjs';
  }

  async send(text, meta = {}) {
    if (!this.chatId) throw new Error('TELEGRAM_CHAT_ID not configured');

    let TelegramClient, StoreSession;
    try {
      ({ TelegramClient } = await import('telegram'));
      ({ StoreSession } = await import('telegram/sessions/index.js'));
    } catch {
      throw new Error('GramJsTransport requires the gramjs package: npm install telegram');
    }

    const os = await import('node:os');
    const pathMod = await import('node:path');
    const cwd = process.cwd();
    process.chdir(os.homedir());

    let client;
    try {
      const session = new StoreSession(this.sessionPath ?? pathMod.join('.mcp-telegram', 'sessions', '1718604740'));
      client = new TelegramClient(session, Number(this.apiId), this.apiHash, { connectionRetries: 3 });
      await client.connect();

      if (!(await client.isUserAuthorized())) {
        throw new Error('Telegram session not authorized (run: npx mcp-telegram login)');
      }

      // Retry with exponential backoff
      const maxRetries = 3;
      let lastError;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Telegram HTML (not MarkdownV2): gramjs' MarkdownV2 parser ignores
          // backslash escapes, so `\(x\)` / `\-` were delivered literally.
          const sent = await client.sendMessage(this.chatId, { message: text, parseMode: 'html' });
          this.logger?.info('TELEGRAM_SEND', `sent to ${this.chatId} (${text.length} chars)`, {
            message_id: sent?.id ?? null,
            mode: meta.mode ?? null,
            category: meta.category ?? null,
            event_id: meta.event_id ?? null,
            attempt,
          });
          return { message_id: sent?.id ?? null };
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries) {
            const delay = backoffDelay(attempt);
            this.logger?.warn('TELEGRAM_SEND', `send failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${err.message}`);
            await sleep(delay);
          }
        }
      }

      throw lastError;
    } finally {
      if (client) {
        try { await client.disconnect(); } catch {}
      }
      process.chdir(cwd);
    }
  }
}

export function createTransport({ mode = 'dry-run', options = {} } = {}) {
  switch (mode) {
    case 'dry-run':
      return new DryRunTransport(options);
    case 'json':
      return new JsonEmitTransport(options);
    case 'gramjs':
      return new GramJsTransport(options);
    default:
      throw new Error(`Unknown transport: ${mode}`);
  }
}
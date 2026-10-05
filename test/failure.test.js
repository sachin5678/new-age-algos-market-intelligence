import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConfig, rssXml, stubFetch } from './helpers.js';
import { Provider, runProviders } from '../src/providers/base.js';
import { NewsProvider } from '../src/providers/newsProvider.js';
import { readInboxFile } from '../src/providers/inbox.js';
import { createOpenAIService } from '../src/ai/openaiService.js';
import { createCategorizer } from '../src/normalize/categorize.js';
import { createEntityExtractor } from '../src/normalize/extractEntities.js';
import { createLogger } from '../src/log/logger.js';
import { DryRunTransport } from '../src/telegram/transport.js';

const cfg = testConfig();

// ---------------------------------------------------------------- COLLECT

test('one failing provider never stops the others', async () => {
  const ok = new Provider({ name: 'ok', kind: 'news' });
  ok.collect = async () => ['item-a'];
  const bad = new Provider({ name: 'bad', kind: 'official' });
  bad.collect = async () => {
    throw new Error('provider exploded');
  };
  const slow = new Provider({ name: 'slow', kind: 'market' });
  slow.collect = async () => ['item-b'];

  const r = await runProviders([ok, bad, slow], {}, null);
  assert.deepEqual(r.items, ['item-a', 'item-b']);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].provider, 'bad');
  assert.equal(r.failures[0].error, 'provider exploded');
  assert.equal(r.perProvider.ok.ok, true);
  assert.equal(r.perProvider.bad.ok, false);
  assert.equal(r.perProvider.slow.count, 1);
});

test('a dead feed inside NewsProvider does not kill the batch', async () => {
  const categorizer = createCategorizer(cfg.categories);
  const extractor = createEntityExtractor(cfg.entities);
  const provider = new NewsProvider({
    feeds: [
      { source: 'GoodFeed', kind: 'news', url: 'https://good.test/rss', tier: 2, enabled: true },
      { source: 'DeadFeed', kind: 'news', url: 'https://dead.test/rss', tier: 2, enabled: true },
      { source: 'DisabledFeed', kind: 'news', url: 'https://off.test/rss', tier: 2, enabled: false },
    ],
    categorizer,
    extractor,
    fetchImpl: stubFetch({
      'https://good.test/rss': rssXml([{ title: 'RBI keeps repo rate unchanged', url: 'https://good.test/a' }]),
    }),
  });
  const items = await provider.collect({});
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'GoodFeed');
  assert.equal(items[0].category, 'RBI');
});

test('malformed inbox JSON is reported, missing inbox is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naa-inbox-'));
  const badFile = path.join(dir, 'official.json');
  fs.writeFileSync(badFile, '{ this is not json');
  assert.throws(() => readInboxFile(badFile), /not valid JSON/);
  assert.deepEqual(readInboxFile(path.join(dir, 'missing.json')), []);

  const goodFile = path.join(dir, 'market.json');
  fs.writeFileSync(goodFile, JSON.stringify({ source: 'nse-mcp', items: [{ name: 'NIFTY 50', value: 22400 }] }));
  const items = readInboxFile(goodFile);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'nse-mcp');
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- AI_ANALYZE

test('AI service falls back to rules when the network fails', async () => {
  const ai = createOpenAIService({
    settings: cfg.settings,
    apiKey: 'sk-test-abcdef123456',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const v = await ai.analyze({ title: 'SEBI issues circular on margin norms', importance_level: 'HIGH', companies: [], sectors: [] });
  assert.equal(v.analysis_source, 'rules_only');
  assert.equal(v.fallback_reason, 'ai_unavailable');
  assert.equal(v.is_material, true);
  assert.equal(v.confidence, 'low');
});

test('AI service falls back on unparseable completions', async () => {
  const ai = createOpenAIService({
    settings: cfg.settings,
    apiKey: 'sk-test-abcdef123456',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }) }),
  });
  const v = await ai.analyze({ title: 'x', importance_level: 'MEDIUM' });
  assert.equal(v.analysis_source, 'rules_only');
  assert.equal(v.fallback_reason, 'ai_unavailable');
  assert.equal(v.is_material, false);
});

test('AI service reports a missing key without throwing', async () => {
  const ai = createOpenAIService({
    settings: { ...cfg.settings, ai: { ...cfg.settings.ai, apiKeyFile: path.join(os.tmpdir(), 'no-such-key-file') } },
    fetchImpl: async () => {
      throw new Error('should never be called');
    },
  });
  assert.equal(ai.hasKey, false);
  const v = await ai.analyze({ title: 'x', importance_level: 'HIGH' });
  assert.equal(v.analysis_source, 'rules_only');
  assert.equal(v.fallback_reason, 'ai_unavailable');
});

test('AI service validates and coerces structured output', async () => {
  const ai = createOpenAIService({
    settings: cfg.settings,
    apiKey: 'sk-test-abcdef123456',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                headline: 'Clean headline',
                summary: 'Clean summary',
                market_relevance: 'relevance',
                affected_sectors: ['BANKING'],
                affected_stocks: [],
                impact: 'sideways', // invalid → coerced
                confidence: 'high',
                is_material: true,
                publication_priority: 'urgent', // invalid → coerced from level
              }),
            },
          },
        ],
      }),
    }),
  });
  const v = await ai.analyze({ title: 'T', importance_level: 'HIGH', companies: [], sectors: [] });
  assert.equal(v.analysis_source, 'openai');
  assert.equal(v.impact, 'unclear');
  assert.equal(v.publication_priority, 'high');
  assert.equal(v.confidence, 'high');
  assert.equal(v.is_material, true);
  assert.equal(v.fallback_reason, null);
});

test('AI endpoint is configurable (Gemini/Groq/OpenRouter compatible)', async () => {
  const urls = [];
  const ai = createOpenAIService({
    settings: {
      ...cfg.settings,
      ai: {
        ...cfg.settings.ai,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        backoffBaseMs: 1,
      },
    },
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"confidence":"high","is_material":true}' } }],
        }),
      };
    },
  });
  const v = await ai.analyze({
    title: 'SEBI issues circular on margin norms',
    importance_level: 'HIGH',
    companies: [],
    sectors: [],
  });
  assert.equal(v.analysis_source, 'openai');
  assert.equal(urls.length, 1);
  // Trailing slash in config must not produce a doubled slash in the URL.
  assert.equal(
    urls[0],
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );
});

test('defaults to the OpenAI endpoint when baseUrl is absent', async () => {
  const urls = [];
  const ai = createOpenAIService({
    settings: {
      ...cfg.settings,
      ai: { ...cfg.settings.ai, backoffBaseMs: 1 },
    },
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"confidence":"high","is_material":true}' } }],
        }),
      };
    },
  });
  await ai.analyze({ title: 'x', importance_level: 'HIGH', companies: [], sectors: [] });
  assert.equal(urls[0], 'https://api.openai.com/v1/chat/completions');
});

test('a 429 rate limit is retried, not silently downgraded to rules', async () => {
  let calls = 0;
  const ai = createOpenAIService({
    settings: { ...cfg.settings, ai: { ...cfg.settings.ai, backoffBaseMs: 1 } },
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate limited' };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"confidence":"high","is_material":true}' } }],
        }),
      };
    },
  });
  const v = await ai.analyze({ title: 'x', importance_level: 'HIGH', companies: [], sectors: [] });
  assert.equal(calls, 3, 'expected two rate-limited attempts then success');
  assert.equal(v.analysis_source, 'openai');
  assert.equal(v.confidence, 'high');
  assert.equal(v.fallback_reason, null);
});

test('a non-retryable error fails immediately instead of backing off', async () => {
  let calls = 0;
  const ai = createOpenAIService({
    settings: { ...cfg.settings, ai: { ...cfg.settings.ai, backoffBaseMs: 1 } },
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'invalid key' };
    },
  });
  const v = await ai.analyze({ title: 'x', importance_level: 'HIGH', companies: [], sectors: [] });
  assert.equal(calls, 1, '401 must not be retried');
  assert.equal(v.analysis_source, 'rules_only');
  assert.equal(v.confidence, 'low');
});

test('persistent rate limiting exhausts retries, then falls back to rules', async () => {
  let calls = 0;
  const ai = createOpenAIService({
    settings: { ...cfg.settings, ai: { ...cfg.settings.ai, maxRetries: 3, backoffBaseMs: 1 } },
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate limited' };
    },
  });
  const v = await ai.analyze({ title: 'x', importance_level: 'HIGH', companies: [], sectors: [] });
  assert.equal(calls, 4, 'one initial attempt plus three retries');
  assert.equal(v.analysis_source, 'rules_only');
  assert.equal(v.confidence, 'low');
});

test('AI service can be disabled entirely', async () => {
  const ai = createOpenAIService({
    settings: { ...cfg.settings, ai: { ...cfg.settings.ai, enabled: false } },
    apiKey: 'sk-test-abcdef123456',
    fetchImpl: async () => {
      throw new Error('should never be called');
    },
  });
  const v = await ai.analyze({ title: 'x', importance_level: 'MEDIUM' });
  assert.equal(v.analysis_source, 'rules_only');
  assert.equal(v.fallback_reason, 'disabled');
});

// ------------------------------------------------------------------ LOGGING

test('logger never writes secrets to disk or console', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naa-log-'));
  const logger = createLogger({ runId: 't', dir, toConsole: false });
  logger.info('AI_ANALYZE', 'calling openai with sk-secret1234567890 in the message', {
    apiKey: 'sk-secret1234567890',
    authorization: 'Bearer abcdef1234567890',
    nested: { token: 'tok-should-hide', model: 'gpt-4o-mini' },
  });
  logger.close();

  const content = fs.readFileSync(path.join(dir, 't.jsonl'), 'utf8');
  assert.ok(!content.includes('sk-secret1234567890'), 'api key leaked');
  assert.ok(!content.includes('abcdef1234567890'), 'bearer token leaked');
  assert.ok(!content.includes('tok-should-hide'), 'nested token leaked');
  assert.ok(content.includes('[REDACTED]'));
  assert.ok(content.includes('gpt-4o-mini'), 'benign fields must survive redaction');

  // console path also redacted
  let printed = '';
  const logger2 = createLogger({ runId: 't2', dir: null, toConsole: true });
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    printed += s;
    return true;
  };
  try {
    logger2.info('TELEGRAM_SEND', 'oops sk-secret1234567890 again', null);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.ok(!printed.includes('sk-secret1234567890'));

  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- TELEGRAM_SEND

test('DryRunTransport prints the message and sends nothing', async () => {
  let printed = '';
  const out = { write: (s) => (printed += s) };
  const t = new DryRunTransport({ logger: null, out });
  const res = await t.send('hello world', { mode: 'intraday' });
  assert.equal(res.dry_run, true);
  assert.equal(res.message_id, null);
  assert.ok(printed.includes('DRY RUN'));
  assert.ok(printed.includes('hello world'));
});

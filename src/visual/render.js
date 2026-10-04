/**
 * Deterministic rendering engine (§22): HTML+CSS → PNG + PDF via headless
 * Chromium (puppeteer-core driving an existing Chrome/Edge — no browser
 * download, no SaaS, no AI image generation).
 *
 *   renderPng   — exact pixel dimensions (VISUAL_WIDTH × VISUAL_HEIGHT)
 *   renderPdf   — A4 portrait, selectable text, clickable links
 *   validateImage / validatePdf — the §28 QA gate run BEFORE any send
 *   saveVisual  — deterministic file names (§14) under artifacts/briefings/
 *
 * Rendering failure throws a RenderError; callers treat it as "optional
 * section failed" (§35): log it, skip the image, never send something broken.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT } from '../config.js';
import { VISUAL_DEFAULTS } from './theme.js';

/** Rendering problems are recoverable — the caller falls back to text. */
export class RenderError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'RenderError';
    this.cause = cause;
  }
}

// ------------------------------------------------------------ browser

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge',
  ],
};

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Locate a Chromium-based browser. Override with PUPPETEER_EXECUTABLE_PATH
 * (CI) — GitHub's ubuntu runners ship google-chrome at /usr/bin/google-chrome.
 */
export function findBrowser(env = process.env) {
  const explicit = env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || null;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new RenderError(`PUPPETEER_EXECUTABLE_PATH not found: ${explicit}`);
  }
  for (const p of CANDIDATES[process.platform] ?? []) {
    if (fs.existsSync(p)) return p;
  }
  const viaPath = which('google-chrome') || which('google-chrome-stable') || which('chromium') || which('msedge');
  if (viaPath && fs.existsSync(viaPath)) return viaPath;
  throw new RenderError(
    'No Chrome/Edge found for rendering. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.'
  );
}

async function launch(env = process.env) {
  const executablePath = findBrowser(env);
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--hide-scrollbars',
    ],
  });
}

// ------------------------------------------------------------- render

/**
 * HTML → PNG at exact output dimensions (§33: dimensions must be correct).
 * The template is authored at width/scale logical px with deviceScaleFactor.
 * Rejects if the page overflows the canvas (no clipped content).
 */
export async function renderPng({ html, width, height, scale = VISUAL_DEFAULTS.scale, timeoutMs = 9000 }) {
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  let browser = null;
  const started = Date.now();
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    await page.evaluate(() => document.fonts?.ready);

    const overflow = await page.evaluate((limit) => {
      const el = document.querySelector('.poster');
      if (!el) return { missing: true };
      const rects = [...el.querySelectorAll('*')].filter(
        (n) => n.scrollHeight > n.clientHeight + 2 && getComputedStyle(n).overflowY !== 'visible'
      );
      return {
        missing: false,
        height: Math.max(el.scrollHeight, document.body.scrollHeight),
        clipped: rects.length,
        limit,
      };
    }, vh + 2);

    if (overflow.missing) throw new RenderError('Template has no .poster root element');
    if (overflow.height > vh + 2) {
      throw new RenderError(
        `Content overflows canvas: ${overflow.height}px > ${vh}px logical — fix caps/layout before sending`
      );
    }

    const buf = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: vw, height: vh },
    });
    return { buffer: Buffer.from(buf), width, height, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`PNG rendering failed: ${err.message}`, err);
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** HTML (PDF layout) → A4 portrait PDF, text selectable, links clickable. */
export async function renderPdf({ html, timeoutMs = 14000 }) {
  let browser = null;
  const started = Date.now();
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    await page.evaluate(() => document.fonts?.ready);
    const buf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return { buffer: Buffer.from(buf), ms: Date.now() - started };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`PDF rendering failed: ${err.message}`, err);
  } finally {
    await browser?.close().catch(() => {});
  }
}

// --------------------------------------------------------------- QA (§28)

/** Parse width/height from a PNG's IHDR without external dependencies. */
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const sig = buffer.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * §28 validation — every check must pass before a send:
 * exists, non-empty, correct dimensions, no undefined/null/[object Object],
 * no duplicate headlines, no fabricated-looking URLs.
 * Returns { ok, problems: [] }.
 */
export function validateImage({ buffer, width, height, html = '', brief = null }) {
  const problems = [];
  if (!buffer || !buffer.length) problems.push('file is empty or missing');
  if (buffer && buffer.length < 5000) problems.push(`file suspiciously small (${buffer.length} bytes)`);

  const dims = buffer ? pngDimensions(buffer) : null;
  if (!dims) problems.push('not a valid PNG');
  else if (dims.width !== width || dims.height !== height) {
    problems.push(`wrong dimensions: ${dims.width}×${dims.height}, expected ${width}×${height}`);
  }

  const visible = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  const hasWord = (token) =>
    new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(visible);
  for (const token of ['undefined', '[object Object]', 'NaN']) {
    if (hasWord(token)) problems.push(`rendered text contains "${token}"`);
  }
  if (hasWord('null')) problems.push('rendered text contains "null"');

  if (brief) {
    const headlines = (brief.top_developments ?? []).map((d) => d.headline).filter(Boolean);
    if (new Set(headlines).size !== headlines.length) problems.push('duplicate stories in briefing');
    for (const d of brief.top_developments ?? []) {
      if (d.source_url && !/^https?:\/\//i.test(d.source_url)) {
        problems.push(`broken source URL: ${d.source_url}`);
      }
      if (!d.headline || !String(d.headline).trim()) problems.push('missing headline');
    }
  }
  return { ok: problems.length === 0, problems };
}

/** PDF QA: exists, non-empty, %PDF header, plausible page count. */
export function validatePdf({ buffer, minPages = 4 }) {
  const problems = [];
  if (!buffer || !buffer.length) problems.push('file is empty or missing');
  if (buffer && buffer.length < 5000) problems.push(`file suspiciously small (${buffer.length} bytes)`);
  if (buffer && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') problems.push('not a PDF file');
  if (buffer) {
    const text = buffer.toString('latin1');
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pages && pages < minPages) problems.push(`only ${pages} pages, expected ≥ ${minPages}`);
  }
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------ persistence

/** Deterministic file names (§14): premarket-2026-10-05.png, breaking-…-0942.png */
export function visualFileName({ type, date, now = null }) {
  const t = now ?? new Date();
  // IST calendar day — file names must match the channel's local dates
  const dayIst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
  const day = date ?? dayIst;
  if (type === 'breaking') {
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(t)) {
      p[part.type] = part.value;
    }
    return `breaking-${day}-${p.hour}${p.minute}`;
  }
  const base = type === 'closing' ? 'closing' : 'premarket';
  return `${base}-${day}`;
}

/** Write buffer under artifacts/briefings (or an override dir). Returns paths. */
export function saveVisual({ buffer, type, date = null, now = null, ext, dir = null }) {
  const outDir = dir ?? path.join(PROJECT_ROOT, VISUAL_DEFAULTS.dir);
  fs.mkdirSync(outDir, { recursive: true });
  const base = visualFileName({ type, date, now });
  const file = path.join(outDir, `${base}.${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
}

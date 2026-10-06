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
import { VISUAL_DEFAULTS, baseCss } from './theme.js';
import { packPages, packedContentHeight, renderPageDoc, planFragments, FRAG_GAP, PAGE_PAD } from './templates.js';

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

/** Exposed so previews and tests can reuse the same browser process. */
export { launch as launchBrowser };

// ------------------------------------------------------------- render

/**
 * Lay one document out and screenshot it, inside an already-running browser.
 * Shared by renderPng (single fixed page) and renderPlanPages (measured page).
 *
 * Rejects if content overflows the canvas — clipped content is never sent.
 */
async function shoot(browser, { html, width, height, scale = VISUAL_DEFAULTS.scale, timeoutMs = 9000 }) {
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    await page.evaluate(() => document.fonts?.ready);

    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.poster');
      if (!el) return { missing: true };
      return { missing: false, height: Math.max(el.scrollHeight, document.body.scrollHeight) };
    });
    if (overflow.missing) throw new RenderError('Template has no .poster root element');
    if (overflow.height > vh + 2) {
      throw new RenderError(
        `Content overflows canvas: ${overflow.height}px > ${vh}px logical — fix caps/layout before sending`
      );
    }

    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: vw, height: vh } });
    return Buffer.from(buf);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * HTML → PNG at exact output dimensions (§33: dimensions must be correct).
 * The template is authored at width/scale logical px with deviceScaleFactor.
 */
export async function renderPng({ html, width, height, scale = VISUAL_DEFAULTS.scale, timeoutMs = 9000 }) {
  const started = Date.now();
  let browser = null;
  try {
    browser = await launch();
    const buffer = await shoot(browser, { html, width, height, scale, timeoutMs });
    return { buffer, width, height, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`PNG rendering failed: ${err.message}`, err);
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------- measure + paginate

/**
 * Natural height (LOGICAL px) of a poster rendered with `exact: false`.
 *
 * The probe carries the same stylesheet and the same `.poster` box as the real
 * render, so the number it returns is the height the final canvas should get.
 */
export async function measurePosterHeight({ browser, html, width, height, scale = VISUAL_DEFAULTS.scale, timeoutMs = 9000 }) {
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: vw, height: Math.max(vh, 200), deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    await page.evaluate(() => document.fonts?.ready);
    return await page.evaluate(() => {
      const p = document.querySelector('.poster');
      return p ? Math.ceil(p.getBoundingClientRect().height) : 0;
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render at the SMALLEST height that actually contains the content.
 *
 * A breaking alert on a quiet story has no business printing 1080×1080 with a
 * third of it empty background. Measure once, round up to PAGE_STEP, clamp to
 * `[min, max]`, then shoot for real — content decides the box.
 *
 * `renderHtml(dims)` must accept `{ height, exact }` and return the document.
 * Returns `{ buffer, width, height, html, ms }`.
 */
export async function renderFittedPng({
  renderHtml,
  dims = {},
  scale = VISUAL_DEFAULTS.scale,
  min = 0,
  max = Infinity,
  pageStep = VISUAL_DEFAULTS.pageStep,
  timeoutMs = 9000,
}) {
  const width = dims.width ?? VISUAL_DEFAULTS.width;
  const ceiling = Math.min(max, dims.height ?? max);
  const started = Date.now();
  let browser = null;
  try {
    browser = await launch();

    const probe = renderHtml({ ...dims, scale, height: min, exact: false });
    const natural = await measurePosterHeight({ browser, html: probe, width, height: min, scale, timeoutMs });
    if (!Number.isFinite(natural) || natural <= 0) {
      throw new RenderError('Content did not measure — cannot size the canvas');
    }

    const naturalOut = Math.ceil(natural * scale);
    const step = Math.max(1, pageStep);
    const fitted = Math.ceil(naturalOut / step) * step;
    const height = Math.max(min, Math.min(fitted, ceiling));

    const html = renderHtml({ ...dims, scale, height, exact: true });
    const buffer = await shoot(browser, { html, width, height, scale, timeoutMs });
    return { buffer, width, height, html, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`PNG rendering failed: ${err.message}`, err);
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Measure every fragment of a plan in ONE Chromium pass.
 *
 * Returns `{ [data-frag]: heightInLogicalPx }`. Layout is identical to a real
 * page — same stylesheet, same `.poster` flex column, same padding — so the
 * numbers are exactly what the renderer will later produce.
 */
export async function measureFragments({
  browser,
  fragments,
  width,
  scale = VISUAL_DEFAULTS.scale,
  timeoutMs = 9000,
}) {
  const vw = Math.round(width / scale);
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<style>${baseCss({ vw, vh: 0 })}</style></head><body>` +
    `<div class="poster" style="width:${vw}px;min-height:0;height:auto">` +
    fragments.map((f) => f.html).join('') +
    `</div></body></html>`;

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: vw, height: 400, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    await page.evaluate(() => document.fonts?.ready);
    return await page.evaluate(() => {
      const out = {};
      for (const n of document.querySelectorAll('.poster > .frag')) {
        const key = n.dataset.frag;
        if (key) out[key] = Math.ceil(n.getBoundingClientRect().height);
      }
      return out;
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Content-first page production (PART 2/17/20):
 *
 *   1. measure every fragment
 *   2. pack them into pages no taller than VISUAL_HEIGHT
 *   3. give each page the SMALLEST height that contains it (rounded up to
 *      PAGE_STEP), floored at 1080 for page 1
 *
 * Result: no fixed empty space, no squeezed text, and a second page instead of
 * a smaller font. Returns `[{ buffer, width, height, index, html }]`.
 */
export async function renderPlanPages({
  plan,
  dims = {},
  logger = null,
  timeoutMs = 9000,
  replan = null,
}) {
  const width = dims.width ?? VISUAL_DEFAULTS.width;
  const scale = dims.scale ?? VISUAL_DEFAULTS.scale;
  const maxLogical = Math.round((dims.maxHeight ?? dims.height ?? VISUAL_DEFAULTS.height) / scale);
  const minLogical = Math.round((dims.minPageHeight ?? VISUAL_DEFAULTS.minPageHeight) / scale);
  const step = Math.max(1, Math.round((dims.pageStep ?? VISUAL_DEFAULTS.pageStep) / scale));
  const maxPages = dims.maxPages ?? VISUAL_DEFAULTS.maxPages;
  const hardMaxPages = dims.hardMaxPages ?? VISUAL_DEFAULTS.hardMaxPages;

  let browser = null;
  const started = Date.now();
  try {
    browser = await launch();

    const measure = async (p) => {
      const fragments = planFragments(p);
      const h = await measureFragments({ browser, fragments, width, scale, timeoutMs });
      const missing = fragments.filter((f) => !Number.isFinite(h[f.key])).map((f) => f.key);
      if (missing.length) throw new RenderError(`Fragments did not measure: ${missing.join(', ')}`);
      return h;
    };

    // Every page is PAGE_PAD + header + sections + footer + the gaps between
    // them. Reserving the footer, the padding and a few px of measurement
    // safety up front is what keeps a page from silently exceeding
    // VISUAL_HEIGHT. All arithmetic below is in LOGICAL px and converted to
    // output px exactly once, at the end.
    const SAFETY = 6;
    const maxContentFor = (h) =>
      maxLogical - (PAGE_PAD + (h[plan.footer.key] ?? 0) + FRAG_GAP) - SAFETY;
    const pack = (p, h) => {
      const maxContent = maxContentFor(h);
      if (maxContent <= step) {
        throw new RenderError(
          `VISUAL_HEIGHT=${maxLogical * scale}px leaves no room for content after the footer`
        );
      }
      return packPages({
        header1Key: p.header1.key,
        headerNKey: p.headerN.key,
        sections: p.sections,
        heights: h,
        maxContent,
        maxPages,
        hardMaxPages,
      });
    };

    let currentPlan = plan;
    let heights = await measure(currentPlan);
    let pages = pack(currentPlan, heights);

    // ---- self-sizing -------------------------------------------------------
    // The poster adapts its card budget instead of producing an unbounded
    // album: if the plan would overrun the target page count, ask the caller
    // for a plan with fewer full-width cards and measure again. Story TEXT is
    // never touched — we select fewer stories, we never shorten one.
    let attempts = 0;
    while (pages.length > maxPages && (currentPlan.cap ?? 1) > 1 && replan && attempts < 4) {
      const nextCap = Math.max(1, Math.floor(((currentPlan.cap ?? 1) * maxPages) / pages.length));
      if (nextCap >= (currentPlan.cap ?? 1)) break;
      const nextPlan = replan(nextCap);
      if (!nextPlan) break;
      currentPlan = nextPlan;
      heights = await measure(currentPlan);
      pages = pack(currentPlan, heights);
      attempts += 1;
      logger?.info(
        'VISUAL',
        `page budget ${pages.length}>${maxPages} — re-planned with imageCap=${nextCap} → ${pages.length} pages`
      );
    }
    if (pages.length > maxPages) {
      logger?.warn?.(
        'VISUAL',
        `content needs ${pages.length} pages (target ${maxPages}); rendering them all rather than dropping sections`
      );
    }
    // ------------------------------------------------------------------------

    const out = [];
    const pageCount = pages.length;
    for (const [i, page] of pages.entries()) {
      const content = packedContentHeight(page, heights);
      let h = Math.ceil((content + SAFETY + 1) / step) * step;
      if (i === 0) h = Math.max(h, minLogical);
      h = Math.min(h, Math.max(maxLogical, content + SAFETY));
      h = Math.max(h, content + SAFETY);

      const html = renderPageDoc(currentPlan, page, {
        height: h * scale,
        width,
        scale,
        pageIndex: i + 1,
        pageCount,
      });
      const buffer = await shoot(browser, { html, width, height: h * scale, scale, timeoutMs });
      out.push({ buffer, width, height: h * scale, index: i, html, content });
    }

    logger?.debug?.(
      'VISUAL',
      `rendered ${out.length} page(s) at imageCap=${currentPlan.cap ?? 1}: ` +
        `${out.map((p) => `${p.width}×${p.height}`).join(', ')} (${Date.now() - started}ms)`
    );
    return {
      pages: out,
      heights,
      imageCap: currentPlan.cap ?? 1,
      ms: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`Page rendering failed: ${err.message}`, err);
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

/**
 * Write buffer under artifacts/briefings (or an override dir). Returns paths.
 * Multi-page briefings append `-p2`, `-p3` so page 1 keeps the canonical name.
 */
export function saveVisual({ buffer, type, date = null, now = null, ext, dir = null, page = 1, pageCount = 1 }) {
  const outDir = dir ?? path.join(PROJECT_ROOT, VISUAL_DEFAULTS.dir);
  fs.mkdirSync(outDir, { recursive: true });
  const base = visualFileName({ type, date, now });
  const suffix = pageCount > 1 ? `-p${page}` : '';
  const file = path.join(outDir, `${base}${suffix}.${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
}

/**
 * Visual delivery (§16, §17, §35): render briefing → PNG → QA gate → send via
 * transport (Bot API sendPhoto) with a one-line caption saying what the image is.
 * On render failure: log, don't send broken image, fall back to text briefing (§35).
 *
 * PNG is the production delivery format. The A4 PDF is opt-in only (VISUAL_PDF=true)
 * because several PDF viewers drop painted page backgrounds — the images render
 * consistently everywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildVisualBriefing, buildAlertBriefing } from '../visual/data.js';
import {
  buildPagePlan,
  renderAlertHtml,
  renderPdfHtml,
} from '../visual/templates.js';
import { visualDimensions, VISUAL_DEFAULTS } from '../visual/theme.js';
import {
  renderPlanPages,
  renderFittedPng,
  renderPdf,
  validateImage,
  validatePdf,
  saveVisual,
  RenderError,
} from '../visual/render.js';

export class VisualDeliver {
  constructor({ transport, logger = null, settings = {}, env = process.env, enabled = null } = {}) {
    this.transport = transport;
    this.logger = logger;
    this.settings = settings;
    this.env = env;
    // CLI --visual flag overrides env VISUAL_BRIEFING
    this.enabled = enabled !== null ? enabled : String(env.VISUAL_BRIEFING ?? 'false').toLowerCase() === 'true';
    // PDF is opt-in: most Telegram/PDF viewers render the dark theme inconsistently.
    this.pdfEnabled = String(env.VISUAL_PDF ?? 'false').toLowerCase() === 'true';
    this.alertsEnabled = String(env.VISUAL_ALERTS ?? 'false').toLowerCase() === 'true';
    this.dryRun = String(env.DRY_RUN ?? 'false').toLowerCase() === 'true';
  }

  /**
   * Send a daily briefing (premarket or closing) as one or more images plus an
   * optional PDF.
   *
   * Layout is CONTENT-FIRST (PART 2/17/20): the plan is measured, packed into
   * pages no taller than VISUAL_HEIGHT, and each page gets the smallest height
   * that contains it. Page 1 always goes out; continuation pages follow only
   * when the content genuinely needs them.
   */
  async sendBriefing({ type, snapshots, events, now, runId }) {
    if (!this.enabled) {
      this.logger?.info('VISUAL', 'disabled — skipping image render');
      return { visual: false };
    }

    const holidays = this.settings.holidays ?? [];
    const marketHours = this.settings.marketHours ?? {};
    const makeBrief = (imageCap) =>
      buildVisualBriefing({ type, snapshots, events, now, holidays, marketHours, sample: false, imageCap });

    let brief = makeBrief();
    let plan = buildPagePlan(brief, { type, now });

    try {
      const dims = visualDimensions(this.env, type);
      const { pages, imageCap } = await renderPlanPages({
        plan,
        dims,
        logger: this.logger,
        // SELF-SIZING: if the plan would overrun the target page count the
        // renderer asks for a briefing with fewer full-width cards and
        // re-measures. Story text is never shortened — we show fewer stories,
        // never smaller ones (PART 17/20).
        replan: (cap) => {
          brief = makeBrief(cap);
          plan = buildPagePlan(brief, { type, now });
          return plan;
        },
      });
      if (imageCap !== undefined) {
        this.logger?.info('VISUAL', `poster rendered at imageCap=${imageCap}, pages=${pages.length}`);
      }

      const pngPaths = [];
      for (const p of pages) {
        const qa = validateImage({ buffer: p.buffer, width: p.width, height: p.height, html: p.html, brief });
        if (!qa.ok) throw new RenderError(`PNG QA failed on page ${p.index + 1}: ${qa.problems.join('; ')}`);
        const file = saveVisual({
          buffer: p.buffer,
          type,
          now,
          ext: 'png',
          page: p.index + 1,
          pageCount: pages.length,
        });
        pngPaths.push(file);
        this.logger?.info(
          'VISUAL',
          `PNG saved: ${file} (${p.buffer.length} bytes, ${p.width}×${p.height}, page ${p.index + 1}/${pages.length})`
        );
      }

      // Optional PDF
      let pdfPath = null;
      if (this.pdfEnabled) {
        const pdfHtml = renderPdfHtml(brief, { type });
        const pdfResult = await renderPdf({ html: pdfHtml });
        const pdfQA = validatePdf({ buffer: pdfResult.buffer });
        if (!pdfQA.ok) {
          this.logger?.warn('VISUAL', `PDF QA failed (continuing without PDF): ${pdfQA.problems.join('; ')}`);
        } else {
          pdfPath = saveVisual({ buffer: pdfResult.buffer, type, now, ext: 'pdf' });
          this.logger?.info('VISUAL', `PDF saved: ${pdfPath} (${pdfResult.buffer.length} bytes, ${pdfResult.ms}ms)`);
        }
      }

      const caption = this.buildCaption(brief, type, { page: 1, pageCount: pages.length });

      if (!this.dryRun) {
        await this.transport.sendPhoto(pngPaths[0], caption, { mode: type, runId });
        this.logger?.info('VISUAL', `PNG sent via transport (page 1/${pages.length})`);

        // Continuation pages only exist when there is more to read (PART 17).
        for (let i = 1; i < pngPaths.length; i++) {
          await this.transport.sendPhoto(
            pngPaths[i],
            this.buildCaption(brief, type, { page: i + 1, pageCount: pages.length }),
            { mode: type, runId }
          );
          this.logger?.info('VISUAL', `PNG sent via transport (page ${i + 1}/${pages.length})`);
        }

        if (pdfPath) {
          await this.transport.sendDocument(pdfPath, caption, { mode: type, runId });
          this.logger?.info('VISUAL', `PDF sent via transport`);
        }
      } else {
        this.logger?.info(
          'VISUAL',
          `DRY_RUN — files ready: ${pngPaths.join(', ')}${pdfPath ? ` PDF=${pdfPath}` : ''}`
        );
      }

      return { visual: true, pngPath: pngPaths[0], pngPaths, pdfPath, pages: pages.length };
    } catch (err) {
      if (err instanceof RenderError) {
        this.logger?.error('VISUAL', `Render failed — falling back to text: ${err.message}`);
        return { visual: false, renderError: err.message };
      }
      throw err;
    }
  }

  /** Send a breaking alert as 1080×1080 image. */
  async sendAlert({ event, verdict, now, runId }) {
    if (!this.alertsEnabled) {
      this.logger?.info('VISUAL_ALERT', 'disabled — skipping alert image');
      return { visual: false };
    }

    const brief = buildAlertBriefing({ event, verdict, now, sample: false });

    try {
      const dims = { width: 1080, height: 1080 };
      // Content decides the canvas: a thin story renders shorter than 1080×1080
      // instead of printing a band of empty background under it.
      const pngResult = await renderFittedPng({
        renderHtml: (d) => renderAlertHtml(brief, d),
        dims,
        scale: 2,
        min: VISUAL_DEFAULTS.alertMinHeight,
        max: dims.height,
        pageStep: VISUAL_DEFAULTS.pageStep,
      });
      const { buffer, width, height, html } = pngResult;
      const pngQA = validateImage({ buffer, width, height, html, brief });
      if (!pngQA.ok) {
        throw new RenderError(`Alert PNG QA failed: ${pngQA.problems.join('; ')}`);
      }

      const pngPath = saveVisual({
        buffer,
        type: 'breaking',
        now,
        ext: 'png',
      });
      this.logger?.info(
        'VISUAL_ALERT',
        `Alert PNG saved: ${pngPath} ${width}×${height} (${buffer.length} bytes, ${pngResult.ms}ms)`
      );

      if (!this.dryRun) {
        const caption = this.buildAlertCaption(brief);
        await this.transport.sendPhoto(pngPath, caption, { mode: 'alert', runId, event_id: event.event_id });
        this.logger?.info('VISUAL_ALERT', `Alert PNG sent via transport`);
      } else {
        this.logger?.info('VISUAL_ALERT', `DRY_RUN — alert PNG ready: ${pngPath}`);
      }

      return { visual: true, pngPath };
    } catch (err) {
      if (err instanceof RenderError) {
        this.logger?.error('VISUAL_ALERT', `Render failed: ${err.message}`);
        return { visual: false, renderError: err.message };
      }
      throw err;
    }
  }

  /**
   * Telegram caption (PART 34): title, date, and a two-line pointer at what the
   * image contains. The report itself lives in the image — the caption never
   * repeats it as text.
   */
  buildCaption(brief, type, { page = 1, pageCount = 1 } = {}) {
    const cal = brief.calendar ?? {};
    const title = type === 'closing' ? 'Market Close' : 'Pre-Market Intelligence';
    const blurb =
      type === 'closing'
        ? 'What drove the session, the day’s key developments and tomorrow’s watchlist — including sources.'
        : 'Overnight global cues, yesterday’s session and today’s agenda — including sources.';

    const dateBits = [];
    if (cal.weekday) {
      dateBits.push(
        cal.weekday.charAt(0) + cal.weekday.slice(1).toLowerCase() // MONDAY -> Monday
      );
    }
    if (cal.dateLong) {
      dateBits.push(
        cal.dateLong
          .toLowerCase()
          .replace(/\b\w/g, (ch) => ch.toUpperCase())
      );
    }
    if (cal.time) dateBits.push(cal.time);

    const lines = [title, dateBits.join(', '), blurb];
    if (cal.closed && cal.closedLabel) lines.push(cal.closedLabel);
    if (pageCount > 1) lines.push(page === 1 ? `Page 1 of ${pageCount}` : `Page ${page} of ${pageCount}`);
    return lines.filter(Boolean).join('\n');
  }

  /** One-line caption for an alert image. e.g. "Breaking news • 09:42 IST" */
  buildAlertCaption() {
    const [h, m] = new Date()
      .toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' })
      .split(':');
    return `Breaking news • ${h}:${m} IST`;
  }
}

export { RenderError };
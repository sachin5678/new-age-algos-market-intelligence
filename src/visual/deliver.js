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
  renderPreMarketHtml,
  renderClosingHtml,
  renderAlertHtml,
  renderPdfHtml,
} from '../visual/templates.js';
import {
  renderPng,
  renderPdf,
  validateImage,
  validatePdf,
  saveVisual,
  visualFileName,
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

  /** Send a daily briefing (premarket or closing) as image + optional PDF. */
  async sendBriefing({ type, snapshots, events, now, runId }) {
    if (!this.enabled) {
      this.logger?.info('VISUAL', 'disabled — skipping image render');
      return { visual: false };
    }

    const holidays = this.settings.holidays ?? [];
    const marketHours = this.settings.marketHours ?? {};
    const brief = buildVisualBriefing({
      type,
      snapshots,
      events,
      now,
      holidays,
      marketHours,
      sample: false,
    });

    try {
      const dims = type === 'alert'
        ? { width: 1080, height: 1080 }
        : { width: 1080, height: 1350 };

      // Render PNG
      const html = type === 'closing'
        ? renderClosingHtml(brief, dims)
        : renderPreMarketHtml(brief, dims);

      const pngResult = await renderPng({ html, ...dims, scale: 2 });
      const pngQA = validateImage({ buffer: pngResult.buffer, ...dims, html, brief });
      if (!pngQA.ok) {
        throw new RenderError(`PNG QA failed: ${pngQA.problems.join('; ')}`);
      }

      // Save PNG
      const pngPath = saveVisual({
        buffer: pngResult.buffer,
        type,
        now,
        ext: 'png',
      });
      this.logger?.info('VISUAL', `PNG saved: ${pngPath} (${pngResult.buffer.length} bytes, ${pngResult.ms}ms)`);

      // Optional PDF
      let pdfPath = null;
      if (this.pdfEnabled && type !== 'alert') {
        const pdfHtml = renderPdfHtml(brief, { type });
        const pdfResult = await renderPdf({ html: pdfHtml });
        const pdfQA = validatePdf({ buffer: pdfResult.buffer });
        if (!pdfQA.ok) {
          this.logger?.warn('VISUAL', `PDF QA failed (continuing without PDF): ${pdfQA.problems.join('; ')}`);
        } else {
          pdfPath = saveVisual({
            buffer: pdfResult.buffer,
            type,
            now,
            ext: 'pdf',
          });
          this.logger?.info('VISUAL', `PDF saved: ${pdfPath} (${pdfResult.buffer.length} bytes, ${pdfResult.ms}ms)`);
        }
      }

      // Send via transport
      if (!this.dryRun) {
        const caption = this.buildCaption(brief, type);
        await this.transport.sendPhoto(pngPath, caption, { mode: type, runId });
        this.logger?.info('VISUAL', `PNG sent via transport`);

        if (pdfPath) {
          await this.transport.sendDocument(pdfPath, caption, { mode: type, runId });
          this.logger?.info('VISUAL', `PDF sent via transport`);
        }
      } else {
        this.logger?.info('VISUAL', `DRY_RUN — files ready: PNG=${pngPath}${pdfPath ? ` PDF=${pdfPath}` : ''}`);
      }

      return { visual: true, pngPath, pdfPath };
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
      const html = renderAlertHtml(brief, dims);

      const pngResult = await renderPng({ html, ...dims, scale: 2 });
      const pngQA = validateImage({ buffer: pngResult.buffer, ...dims, html, brief });
      if (!pngQA.ok) {
        throw new RenderError(`Alert PNG QA failed: ${pngQA.problems.join('; ')}`);
      }

      const pngPath = saveVisual({
        buffer: pngResult.buffer,
        type: 'breaking',
        now,
        ext: 'png',
      });
      this.logger?.info('VISUAL_ALERT', `Alert PNG saved: ${pngPath} (${pngResult.buffer.length} bytes, ${pngResult.ms}ms)`);

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
   * One-line caption saying what the image is — nothing else.
   * e.g. "Pre-session summary • 05 October 2026 • 08:20 IST"
   */
  buildCaption(brief, type) {
    const what = type === 'closing' ? 'Market close summary' : 'Pre-session summary';
    const cal = brief.calendar ?? {};
    const bits = [what];
    if (cal.dateLong) {
      // calendar stores it shouty ("05 OCTOBER 2026") — title-case for a caption
      bits.push(
        cal.dateLong
          .toLowerCase()
          .replace(/\b\w/g, (ch) => ch.toUpperCase())
      );
    }
    if (cal.time) bits.push(cal.time);
    if (cal.closed && cal.closedLabel) bits.push(cal.closedLabel);
    return bits.join(' • ');
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
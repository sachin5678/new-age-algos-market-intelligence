/**
 * Captions stage — Market → Short factory stage 3.
 *
 * Builds burned-in Shorts-style captions: short uppercase word chunks with
 * exact start/end times, emitted as an ASS (Advanced SubStation) file that
 * ffmpeg's libass burns into the video.
 *
 * Chunking rules keep it readable at phone size:
 *   - max ~4 words / ~18 chars per chunk → one or two short lines
 *   - a gap > maxGap flushes the chunk (scene changes reset captions)
 *   - position sits at 30% from the bottom — clear of the YouTube Shorts UI
 *
 * All colors/typography derive from the central visual theme (§27).
 */

import { theme } from '../visual/theme.js';

/** "#RRGGBB" → ASS "&H00BBGGRR" (libass uses little-endian BGR). */
function hexToAss(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return '&H00FFFFFF';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const h = (v) => v.toString(16).padStart(2, '0').toUpperCase();
  return `&H00${h(b)}${h(g)}${h(r)}`;
}

function assTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  // ASS spec: hours are NOT zero-padded → H:MM:SS.CC
  return `${h}:${pad(m)}:${pad(sec)}.${pad(Math.min(cs, 99))}`;
}

/**
 * Group word timings into caption chunks.
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function buildCaptionChunks(
  words,
  { maxChars = 18, maxWords = 4, maxGap = 0.45 } = {}
) {
  const chunks = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.words.length) {
      chunks.push({
        text: cur.words.join(' '),
        start: cur.start,
        end: cur.end,
      });
    }
    cur = null;
  };

  for (const w of words) {
    const text = String(w.word ?? '').trim();
    if (!text) continue;
    if (cur) {
      const gap = w.start - cur.end;
      const candidate = `${cur.words.join(' ')} ${text}`;
      if (gap > maxGap || cur.words.length >= maxWords || candidate.length > maxChars) {
        flush();
      }
    }
    if (!cur) {
      cur = { words: [], start: w.start, end: w.end };
    }
    cur.words.push(text);
    cur.end = w.end;
  }
  flush();
  return chunks;
}

/** Split a chunk into at most two balanced lines for the on-screen caption. */
function captionLines(text, perLine = 16) {
  const words = String(text).split(/\s+/);
  if (text.length <= perLine || words.length < 2) return [text];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/**
 * Build the ASS subtitle document for ffmpeg's `ass=` filter.
 * @param {Array<{text, start, end}>} chunks
 * @param {{width?: number, height?: number}} [dims]
 */
export function buildAss(chunks, { width = 1080, height = 1920 } = {}) {
  const c = theme.colors;
  const primary = hexToAss(c.text);
  const outline = hexToAss(c.background);
  const fontSize = Math.round(height * 0.04); // ~77px at 1920
  const marginV = Math.round(height * 0.3); // captions clear of Shorts UI

  const events = chunks
    .map((ch) => {
      const lines = captionLines(ch.text);
      const text = lines.map((l) => l.toUpperCase().replace(/[{}]/g, '')).join('\\N');
      return `Dialogue: 0,${assTime(ch.start)},${assTime(ch.end)},Short,,0,0,0,,${text}`;
    })
    .join('\n');

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Short,Arial,${fontSize},${primary},${primary},${outline},&H60000000,-1,0,0,0,100,100,1,0,1,7,3,2,60,60,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    events,
    '',
  ].join('\n');
}

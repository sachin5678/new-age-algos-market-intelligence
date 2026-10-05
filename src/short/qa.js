/**
 * QA gate — Market → Short factory stage 6.
 *
 * Same principle as the briefing QA (§28): nothing reaches the content
 * queue unless the artifact passes validation. Runs ffprobe-derived facts
 * against the short's contract:
 *   - file exists, non-trivial size
 *   - 1080 × 1920 (9:16), h264 video + aac audio
 *   - duration inside the Shorts-friendly window
 */

import fs from 'node:fs';

const MIN_BYTES = 150 * 1024; // 45s of 1080x1920 h264 is several MB — below this is broken

/**
 * @param {{file: string, probe: {duration, size, width, height, hasVideo, hasAudio, videoCodec, audioCodec}}}
 * @param {{minSec?: number, maxSec?: number, width?: number, height?: number}} [bounds]
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateShort(
  { file, probe },
  { minSec = 18, maxSec = 75, width = 1080, height = 1920 } = {}
) {
  const problems = [];

  if (!file || !probe) {
    problems.push('missing file or probe info');
    return { ok: false, problems };
  }
  if (!fs.existsSync(file)) problems.push(`file not found: ${file}`);
  if (!(probe.size > 0 && probe.size >= MIN_BYTES)) {
    problems.push(`file suspiciously small (${probe.size} bytes)`);
  }
  if (!probe.hasVideo) problems.push('no video stream');
  if (!probe.hasAudio) problems.push('no audio stream');
  if (probe.width !== width || probe.height !== height) {
    problems.push(`wrong dimensions: ${probe.width}x${probe.height}, expected ${width}x${height}`);
  }
  if (probe.videoCodec && probe.videoCodec !== 'h264') {
    problems.push(`unexpected video codec: ${probe.videoCodec}`);
  }
  if (probe.audioCodec && probe.audioCodec !== 'aac') {
    problems.push(`unexpected audio codec: ${probe.audioCodec}`);
  }
  if (!(probe.duration >= minSec && probe.duration <= maxSec)) {
    problems.push(`duration ${probe.duration.toFixed(1)}s outside ${minSec}-${maxSec}s window`);
  }

  return { ok: problems.length === 0, problems };
}

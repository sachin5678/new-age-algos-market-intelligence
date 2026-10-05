/**
 * Video assembly — Market → Short factory stage 5.
 *
 * Free, local ffmpeg orchestration (no SaaS):
 *   findTool         — locate ffmpeg/ffprobe (env override → PATH → local
 *                      download under %LOCALAPPDATA%\ffmpeg)
 *   ffprobeInfo      — stream metadata (duration, dimensions, codecs)
 *   renderSegments   — one short MP4 per scene (scene PNG + exact duration)
 *   concatSegments   — concat demuxer join into a silent base track
 *   burnAndMux       — burn ASS captions + attach narration → final short
 *
 * Every scene segment is encoded with identical parameters so the concat
 * demuxer can join them without re-encoding, and only the final pass
 * re-encodes (captions burn) — fast and deterministic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function walkFor(name, root, depth = 4) {
  if (depth < 0 || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory() && (e.name === 'bin' || depth > 1)) {
      const found = walkFor(name, p, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve ffmpeg or ffprobe.
 * Order: explicit env (FFMPEG_PATH / FFPROBE_PATH) → PATH → local download.
 */
export function findTool(tool = 'ffmpeg', env = process.env) {
  const exe = isWindows ? `${tool}.exe` : tool;
  const override = env[tool === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (override) {
    const p = fs.existsSync(override)
      ? override
      : path.join(override, isWindows ? 'bin' : '', exe);
    if (fs.existsSync(p)) return p;
  }
  const probe = spawnSync(tool, ['-version'], { windowsHide: true });
  if (!probe.error && probe.status === 0) return tool;
  const local = walkFor(exe, path.join(env.LOCALAPPDATA ?? '', 'ffmpeg'));
  if (local) return local;
  throw new Error(
    `${tool} not found — install it (free) or set ${tool.toUpperCase()}_PATH. ` +
      `Tried: PATH and %LOCALAPPDATA%\\ffmpeg.`
  );
}

/** Run a binary; throw with the stderr tail on failure. */
export function run(bin, args, { cwd, input, timeoutMs = 300_000 } = {}) {
  const res = spawnSync(bin, args, {
    cwd,
    input,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (res.error) throw new Error(`${bin}: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = `${res.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n');
    throw new Error(`${bin} exited ${res.status}:\n${tail}`);
  }
  return res.stdout ?? '';
}

/** Probe a media file → { duration, width, height, hasAudio, hasVideo }. */
export function ffprobeInfo(file, { ffprobe = null, timeoutMs = 60_000 } = {}) {
  const bin = ffprobe ?? findTool('ffprobe');
  const out = run(
    bin,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      file,
    ],
    { timeoutMs }
  );
  const info = JSON.parse(out);
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(info.format?.duration ?? 0),
    size: Number(info.format?.size ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * Encode one MP4 per scene (static frame for the scene's duration).
 * @param {Array<{png: string, dur: number}>} scenes
 * @returns {string[]} segment file paths, in scene order
 */
export function renderSegments({ ffmpeg, scenes, outDir, fps = 30 }) {
  const segs = [];
  scenes.forEach((scene, i) => {
    if (!(scene.dur > 0)) throw new Error(`scene ${i} has non-positive duration ${scene.dur}`);
    const seg = path.join(outDir, `seg-${String(i).padStart(2, '0')}.mp4`);
    run(ffmpeg, [
      '-y',
      '-loop', '1',
      '-framerate', String(fps),
      '-t', scene.dur.toFixed(3),
      '-i', scene.png,
      '-r', String(fps),
      '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      seg,
    ]);
    segs.push(seg);
  });
  return segs;
}

/** Join segments with the concat demuxer (stream copy — params match). */
export function concatSegments({ ffmpeg, segments, outFile, cwd }) {
  const listFile = path.join(cwd, 'concat.txt');
  fs.writeFileSync(
    listFile,
    segments.map((s) => `file '${path.basename(s)}'`).join('\n'),
    'utf8'
  );
  run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', path.basename(outFile)], {
    cwd,
  });
  return outFile;
}

/**
 * Final pass: burn ASS captions over the base track and attach the
 * narration audio.
 * @param {{base: string, audio: string, ass: string, out: string, cwd: string}} args
 */
export function burnAndMux({ ffmpeg, base, audio, ass, out, cwd, fps = 30 }) {
  run(ffmpeg, [
    '-y',
    '-i', base,
    '-i', audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', `ass=${path.basename(ass)},fps=${fps}`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-movflags', '+faststart',
    path.basename(out),
  ], { cwd });
  return out;
}

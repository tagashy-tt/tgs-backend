import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Noise tolerance of ffmpeg's freezedetect per sensitivity (0 careful, 1 normal, 2 aggressive). */
export const FREEZE_NOISE = [0.0003, 0.001, 0.004];

/** Pure: freeze spans (seconds) from the text ffmpeg prints while running freezedetect. */
export function parseFreezeLog(log) {
  const out = [];
  let start = null;
  for (const line of String(log).split(/\r?\n/)) {
    const s = /lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/.exec(line);
    if (s) { start = Number(s[1]); continue; }
    const e = /lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

/** Pure: turns freeze spans into cuts. The first frame of a freeze stays; the repeats after it go. */
export function cutsFromFreezes(freezes, fps, durationMs, minFreezeMs) {
  const frameMs = fps > 0 ? 1000 / fps : 33;
  const cuts = [];
  for (const f of freezes) {
    const s = Math.round(f.start * 1000 + frameMs);
    const e = Math.min(durationMs, Math.round(f.end * 1000));
    if (e - s >= Math.max(frameMs, minFreezeMs - frameMs)) cuts.push({ startMs: s, endMs: e });
  }
  return cuts;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)); });
  });
}

/** Finds the frozen parts of a video (Buffer) with ffmpeg freezedetect. Returns what the app expects from its own analysers. */
export async function analyzeFrozen(buffer, { sensitivity = 1, minFreezeMs = 300, timeoutMs = 120000 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tays-df-'));
  const file = path.join(dir, 'in.mp4');
  try {
    await writeFile(file, buffer);
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=avg_frame_rate,nb_read_frames:format=duration', '-of', 'json', file], timeoutMs)).out);
    const [a, b] = String(probe.streams?.[0]?.avg_frame_rate || '30/1').split('/').map(Number);
    const fps = b ? a / b : a || 30;
    const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    const totalFrames = Number(probe.streams?.[0]?.nb_read_frames) || Math.round((durationMs / 1000) * fps);
    const noise = FREEZE_NOISE[Math.min(2, Math.max(0, sensitivity | 0))];
    const d = Math.max(0.05, (minFreezeMs - 1000 / fps) / 1000);
    const { err } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-vf', `freezedetect=n=${noise}:d=${d.toFixed(3)}`, '-an', '-f', 'null', '-'], timeoutMs);
    const cuts = cutsFromFreezes(parseFreezeLog(err), fps, durationMs, minFreezeMs);
    const removedMs = cuts.reduce((s, c) => s + (c.endMs - c.startMs), 0);
    return { cuts, deadFrames: Math.round((removedMs / 1000) * fps), totalFrames, removedMs, durationMs, fps };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// AI subtitles: the app uploads the audio track (m4a/mp3/wav, <= SUBS_MAX_BYTES); the server asks an OpenAI-compatible
// speech-to-text endpoint and returns clean segments. Nothing is stored: the audio only lives in memory for the request.
//   STT_API_KEY   key of the provider (required)
//   STT_API_URL   default https://api.openai.com/v1/audio/transcriptions  (Groq: https://api.groq.com/openai/v1/audio/transcriptions)
//   STT_MODEL     default whisper-1  (Groq: whisper-large-v3-turbo)

const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

/** Provider answer -> [{start, end, text}] in seconds, ordered, non-overlapping, never empty text. */
export function cleanSegments(raw, maxSeconds = 4 * 3600) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of list) {
    const text = clean(s?.text).slice(0, 400);
    let start = Number(s?.start); let end = Number(s?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(maxSeconds, start)); end = Math.max(0, Math.min(maxSeconds, end));
    if (end <= start) end = start + 0.5;
    const prev = out[out.length - 1];
    if (prev && start < prev.end) start = prev.end;
    if (end <= start) continue;
    out.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
  }
  return out;
}

export function toSrt(segments) {
  const t = (sec) => {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
  };
  return segments.map((g, i) => `${i + 1}\n${t(g.start)} --> ${t(g.end)}\n${g.text}\n`).join('\n');
}

export function sttConfig(env = process.env) {
  return {
    key: String(env.STT_API_KEY || '').trim(),
    url: String(env.STT_API_URL || 'https://api.openai.com/v1/audio/transcriptions').trim(),
    model: String(env.STT_MODEL || 'whisper-1').trim(),
    maxBytes: Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Number(env.SUBS_MAX_BYTES) || 24 * 1024 * 1024)),
    maxSeconds: Math.max(30, Number(env.SUBS_MAX_SECONDS) || 600),
    monthlySeconds: Math.max(60, Number(env.SUBS_MONTHLY_SECONDS) || 3600),
    dailySeconds: Math.max(60, Number(env.SUBS_DAILY_SECONDS) || 7200),
  };
}

export async function transcribe({ audio, mime = 'audio/mp4', language = '', cfg = sttConfig(), fetchImpl = fetch }) {
  if (!cfg.key) { const e = new Error('Subtitles are not configured on the server'); e.status = 503; e.code = 'stt_not_configured'; throw e; }
  const ext = /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : /ogg/.test(mime) ? 'ogg' : /webm/.test(mime) ? 'webm' : 'm4a';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  form.append('model', cfg.model);
  form.append('response_format', 'verbose_json');
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(language)) form.append('language', language.slice(0, 2).toLowerCase());
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  let res;
  try {
    res = await fetchImpl(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form, signal: ctl.signal });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'The speech service took too long' : 'The speech service is unreachable');
    err.status = 504; err.code = 'stt_unreachable'; throw err;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const err = new Error('The speech service rejected the audio'); err.status = res.status === 429 ? 503 : 502; err.code = res.status === 401 ? 'stt_credentials' : 'stt_error'; throw err;
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') { const err = new Error('Unexpected answer from the speech service'); err.status = 502; err.code = 'stt_bad_response'; throw err; }
  let segs = cleanSegments(body.segments);
  if (!segs.length && typeof body.text === 'string' && clean(body.text)) {
    const dur = Math.max(1, Number(body.duration) || 1);
    segs = cleanSegments([{ start: 0, end: dur, text: body.text }]);
  }
  return { language: typeof body.language === 'string' ? body.language.slice(0, 20) : '', duration: Number(body.duration) || (segs.at(-1)?.end ?? 0), segments: segs };
}

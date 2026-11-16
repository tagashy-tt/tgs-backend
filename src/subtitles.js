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

/*
 * Speech engines. The five community projects people asked for are local apps (whisper.cpp, faster-whisper, SenseVoice), not hosted
 * APIs, so the server talks to a *server* that runs them:
 *   openai        OpenAI-compatible  /v1/audio/transcriptions   (OpenAI, Groq, or any compatible server)
 *   fasterwhisper same protocol, self-hosted faster-whisper server (what asub / auto-subtitles / transcribix run on)
 *   whispercpp    whisper.cpp `whisper-server`  POST /inference  (what morethancoder/transcribe runs on)
 * Each one is configured with STT_<ID>_URL (+ STT_<ID>_KEY, STT_<ID>_MODEL). STT_PROVIDERS sets the order (the first that works wins).
 * The old STT_API_KEY / STT_API_URL / STT_MODEL variables still work as the engine "default".
 */
export const ENGINES = {
  openai: { kind: 'openai', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', needsKey: true },
  groq: { kind: 'openai', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', needsKey: true },
  fasterwhisper: { kind: 'openai', url: '', model: 'Systran/faster-whisper-small', needsKey: false },
  whispercpp: { kind: 'whispercpp', url: '', model: '', needsKey: false },
};

export function sttProviders(env = process.env) {
  const out = [];
  const order = String(env.STT_PROVIDERS || '').split(',').map(x => x.trim().toLowerCase()).filter(x => ENGINES[x]);
  for (const id of order) {
    const d = ENGINES[id];
    const U = id.toUpperCase();
    const url = String(env[`STT_${U}_URL`] || d.url).trim();
    const key = String(env[`STT_${U}_KEY`] || (id === 'openai' ? env.STT_API_KEY || '' : '')).trim();
    if (!url || (d.needsKey && !key)) continue;
    out.push({ id, kind: d.kind, url, key, model: String(env[`STT_${U}_MODEL`] || d.model).trim() });
  }
  const legacy = String(env.STT_API_KEY || '').trim();
  if (legacy && !out.length) {
    out.push({ id: 'default', kind: 'openai', url: String(env.STT_API_URL || ENGINES.openai.url).trim(), key: legacy, model: String(env.STT_MODEL || 'whisper-1').trim() });
  }
  return out;
}

export function sttConfig(env = process.env) {
  const providers = sttProviders(env);
  return {
    providers,
    key: providers.length ? 'configured' : '',
    maxBytes: Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Number(env.SUBS_MAX_BYTES) || 24 * 1024 * 1024)),
    maxSeconds: Math.max(30, Number(env.SUBS_MAX_SECONDS) || 600),
    monthlySeconds: Math.max(60, Number(env.SUBS_MONTHLY_SECONDS) || 3600),
    dailySeconds: Math.max(60, Number(env.SUBS_DAILY_SECONDS) || 7200),
  };
}

async function callProvider(p, { audio, mime, language, fetchImpl }) {
  const ext = /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : /ogg/.test(mime) ? 'ogg' : /webm/.test(mime) ? 'webm' : 'm4a';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  if (p.kind === 'whispercpp') {
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');
  } else {
    form.append('model', p.model);
    form.append('response_format', 'verbose_json');
  }
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(language)) form.append('language', language.slice(0, 2).toLowerCase());
  const url = p.kind === 'whispercpp' && !/\/inference\/?$/.test(p.url) ? p.url.replace(/\/+$/, '') + '/inference' : p.url;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: p.key ? { Authorization: `Bearer ${p.key}` } : {}, body: form, signal: ctl.signal });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'The speech service took too long' : 'The speech service is unreachable');
    err.status = 504; err.code = 'stt_unreachable'; throw err;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const err = new Error('The speech service rejected the audio'); err.status = res.status === 429 ? 503 : 502; err.code = res.status === 401 ? 'stt_credentials' : 'stt_error'; throw err;
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') { const err = new Error('Unexpected answer from the speech service'); err.status = 502; err.code = 'stt_bad_response'; throw err; }
  return body;
}

export async function transcribe({ audio, mime = 'audio/mp4', language = '', cfg = sttConfig(), fetchImpl = fetch, engine = '' }) {
  const list = (cfg.providers || []).slice();
  if (!list.length) { const e = new Error('Subtitles are not configured on the server'); e.status = 503; e.code = 'stt_not_configured'; throw e; }
  // the engine the person chose goes first; the others stay as fallback
  const first = list.findIndex(x => x.id === engine);
  if (first > 0) list.unshift(list.splice(first, 1)[0]);
  let body = null, used = '', lastErr = null;
  for (const p of list) {
    try { body = await callProvider(p, { audio, mime, language, fetchImpl }); used = p.id; break; } catch (e) { lastErr = e; }
  }
  if (!body) throw lastErr;
  let segs = cleanSegments(body.segments);
  if (!segs.length && typeof body.text === 'string' && clean(body.text)) {
    const dur = Math.max(1, Number(body.duration) || 1);
    segs = cleanSegments([{ start: 0, end: dur, text: body.text }]);
  }
  return { engine: used, language: typeof body.language === 'string' ? body.language.slice(0, 20) : '', duration: Number(body.duration) || (segs.at(-1)?.end ?? 0), segments: segs };
}

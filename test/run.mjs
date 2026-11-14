// Integration test against a real PostgreSQL (DATABASE_URL). Starts the server and a fake speech-to-text provider.
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/tgs';
const PORT = 3911, STT_PORT = 3912, BASE = `http://127.0.0.1:${PORT}`;
const pool = new pg.Pool({ connectionString: DB, host: process.env.PGHOST, ssl: false });

await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await pool.query(fs.readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));

// fake STT
let sttCalls = 0;
const stt = http.createServer((req, res) => {
  sttCalls++;
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (!/Bearer test-key/.test(req.headers.authorization || '')) { res.statusCode = 401; return res.end('{}'); }
    res.end(JSON.stringify({ language: 'spanish', duration: 6.5, segments: [{ start: 0, end: 2.1, text: ' Hola   mundo ' }, { start: 2.0, end: 4, text: 'segundo\u0007 tramo' }, { start: 5, end: 5, text: '' }] }));
  });
}).listen(STT_PORT);

const env = {
  ...process.env, PORT: String(PORT), DATABASE_URL: DB, DATABASE_SSL: 'disable', PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'x', APP_BASE_URL: 'http://localhost',
  OWNER_EMAIL: 'owner@test.dev', STT_API_KEY: 'test-key', STT_API_URL: `http://127.0.0.1:${STT_PORT}/v1/audio/transcriptions`, SUBS_DAILY_SECONDS: '120', SUBS_MAX_SECONDS: '100',
  TRIAL_MAX_DEVICES_PER_IP: '5', TRUST_PROXY: 'true', SUBS_PER_MINUTE: '30',
};
const srv = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; srv.stdout.on('data', (d) => (logs += d)); srv.stderr.on('data', (d) => (logs += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

let n = 0;
const ok = (name) => console.log(`  ok ${++n} ${name}`);
const call = async (path, { method = 'GET', body, token, device, ip, raw, query = '', headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (device) h['x-device-id'] = device;
  if (ip) h['x-forwarded-for'] = ip;
  let payload;
  if (raw) { h['content-type'] = 'audio/mp4'; payload = raw; } else if (body) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path + query, { method, headers: h, body: payload });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const PASS = 'a-long-password-123';
const signup = async (email, device, ip = '10.0.0.1') => {
  const r = await call('/api/v1/auth/register', { method: 'POST', body: { email, password: PASS }, ip });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const l = await call('/api/v1/auth/login', { method: 'POST', body: { email, password: PASS }, device, ip });
  assert.equal(l.status, 200);
  return l.json.accessToken;
};
const dev = (c) => `device-${c}-aaaaaaaaaaaaaaaaaaaaaaaa`;

try {
  const h = await call('/health'); assert.equal(h.json.version, '0.4.0'); ok('health reports 0.4.0');

  // 1. hello starts the clock
  const hello = await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('A'), version: '1.1.0' }, ip: '10.0.0.1' });
  assert.equal(hello.status, 200); assert.equal(hello.json.trial.active, true); assert.equal(hello.json.trial.daysRemaining, 7); ok('hello starts a 7-day trial');
  const again = await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('A') }, ip: '10.0.0.1' });
  assert.equal(again.json.trial.endsAt, hello.json.trial.endsAt); ok('hello twice does not move the end date');
  assert.equal((await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: 'short' } })).status, 400); ok('bad device id refused');

  // 2. account on the device gets the trial
  const t1 = await signup('one@test.dev', dev('A'));
  let e = await call('/api/v1/me/entitlements', { token: t1, device: dev('A') });
  assert.equal(e.json.premium, true); assert.equal(e.json.plan, 'trial'); assert.equal(e.json.trial.active, true); assert.ok(e.json.daysRemaining >= 6); ok('account on the device gets premium plan=trial');
  assert.equal(e.json.features.ai_subtitles, true);

  // 3. no device id -> free
  const tFree = await signup('free@test.dev', undefined, '10.0.0.2');
  e = await call('/api/v1/me/entitlements', { token: tFree }); assert.equal(e.json.premium, false); assert.equal(e.json.plan, 'free'); ok('no device id: stays free');

  // 4. second account shares the same end; third is refused
  const t2 = await signup('two@test.dev', dev('A'));
  const e1 = await call('/api/v1/me/entitlements', { token: t1, device: dev('A') });
  const e2 = await call('/api/v1/me/entitlements', { token: t2, device: dev('A') });
  assert.equal(e2.json.premium, true); assert.equal(e2.json.expiresAt, e1.json.expiresAt); ok('second account shares the device trial (same end)');
  const t3 = await signup('three@test.dev', dev('A'));
  const e3 = await call('/api/v1/me/entitlements', { token: t3, device: dev('A') });
  assert.equal(e3.json.premium, false); ok('third account on the same device gets no trial');

  // 5. ip velocity
  let lastTok;
  for (let i = 0; i < 7; i++) {
    await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('V' + i) }, ip: '203.0.113.9' });
  }
  lastTok = await signup('farm@test.dev', dev('V6'), '203.0.113.9');
  e = await call('/api/v1/me/entitlements', { token: lastTok, device: dev('V6') });
  assert.equal(e.json.premium, false); ok('device farm from one IP: trial refused');
  const okDev = await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('V0') }, ip: '203.0.113.9' });
  assert.equal(okDev.json.trial.active, true); ok('the first devices of that IP keep their trial');

  // 6. subtitles
  const audio = Buffer.alloc(4096, 1);
  let s = await call('/api/v1/subtitles', { method: 'POST', token: tFree, raw: audio, query: '?seconds=6' });
  assert.equal(s.status, 402); assert.equal(s.json.code, 'premium_required'); ok('subtitles: free account gets 402');
  s = await call('/api/v1/subtitles', { method: 'POST', token: t1, device: dev('A'), raw: audio, query: '?seconds=6&lang=es' });
  assert.equal(s.status, 200, JSON.stringify(s.json)); assert.equal(s.json.segments.length, 2);
  assert.equal(s.json.segments[0].text, 'Hola mundo'); assert.ok(s.json.segments[1].start >= s.json.segments[0].end); assert.ok(!/\u0007/.test(s.json.segments[1].text));
  assert.match(s.json.srt, /1\n00:00:00,000 --> 00:00:02,100\nHola mundo/); ok('subtitles: trial account gets cleaned segments + srt');
  s = await call('/api/v1/subtitles', { method: 'POST', token: t1, raw: audio, query: '?seconds=500' }); assert.equal(s.status, 413); ok('subtitles: too long refused');
  s = await call('/api/v1/subtitles', { method: 'POST', token: t1, raw: audio }); assert.equal(s.status, 400); ok('subtitles: duration required');
  s = await call('/api/v1/subtitles', { method: 'POST', token: t1, raw: Buffer.alloc(10), query: '?seconds=5' }); assert.equal(s.status, 400); ok('subtitles: empty audio refused');
  s = await call('/api/v1/subtitles', { method: 'POST', token: t1, raw: audio, query: '?seconds=100' }); assert.equal(s.status, 200);
  s = await call('/api/v1/subtitles', { method: 'POST', token: t1, raw: audio, query: '?seconds=60' }); assert.equal(s.status, 429); assert.equal(s.json.code, 'limit_reached'); ok('subtitles: daily limit (6+100 used, +60 over 120)');

  // 7. ban revokes
  const owTok = await signup('owner@test.dev', undefined, '10.0.0.3');
  const forbidden = await call('/api/v1/admin/abuse', { token: tFree }); assert.equal(forbidden.status, 403); ok('admin routes: customers get 403');
  const ban = await call('/api/v1/admin/device/ban', { method: 'POST', token: owTok, body: { deviceId: dev('A') } });
  assert.equal(ban.status, 200); assert.equal(ban.json.revoked, 2); ok('ban revokes the trials of that device (2 accounts)');
  e = await call('/api/v1/me/entitlements', { token: t1, device: dev('A') }); assert.equal(e.json.premium, false); assert.equal(e.json.trial.active, false); ok('banned device: premium gone, trial inactive');
  const ab = await call('/api/v1/admin/abuse', { token: owTok }); assert.equal(ab.status, 200);
  const kinds = ab.json.counts.map((c) => c.kind); assert.ok(kinds.includes('multi_account') && kinds.includes('ip_velocity') && kinds.includes('ban')); ok('abuse log lists multi_account, ip_velocity, ban');

  // 8. expiry is final
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('E') }, ip: '10.0.0.7' });
  const tE = await signup('exp@test.dev', dev('E'), '10.0.0.7');
  e = await call('/api/v1/me/entitlements', { token: tE, device: dev('E') }); assert.equal(e.json.premium, true);
  await pool.query(`UPDATE device_trials SET ends_at = NOW() - INTERVAL '1 hour' WHERE first_seen > NOW() - INTERVAL '1 minute' AND device_hash = (SELECT device_hash FROM device_accounts da JOIN app_users u ON u.id = da.user_id WHERE u.email = 'exp@test.dev')`);
  await pool.query(`UPDATE user_entitlements SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = (SELECT id FROM app_users WHERE email='exp@test.dev')`);
  e = await call('/api/v1/me/entitlements', { token: tE, device: dev('E') }); assert.equal(e.json.premium, false); assert.equal(e.json.trial.active, false);
  const relog = await call('/api/v1/auth/login', { method: 'POST', body: { email: 'exp@test.dev', password: PASS }, device: dev('E'), ip: '10.0.0.7' });
  e = await call('/api/v1/me/entitlements', { token: relog.json.accessToken, device: dev('E') }); assert.equal(e.json.premium, false); ok('after the 7 days: free, and logging in again does not restart it');

  // 9. paid rows are never overwritten by a trial
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('P') }, ip: '10.0.0.8' });
  const tP = await signup('paid@test.dev', undefined, '10.0.0.8');
  await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at) SELECT id,'premium',TRUE,'paypal',NULL FROM app_users WHERE email='paid@test.dev'`);
  e = await call('/api/v1/me/entitlements', { token: tP, device: dev('P') }); assert.equal(e.json.plan, 'lifetime'); ok('lifetime/paid premium is not replaced by the trial');

  // 10. integrity report flags tampered builds; with enforce off the trial still works
  const rep = await call('/api/v1/integrity', { method: 'POST', body: { deviceId: dev('Q'), cert: 'aa', pkg: 'com.tgs.uploader', flags: ['emulator', 'bogus'] }, ip: '10.0.0.9' });
  assert.equal(rep.status, 200); await new Promise((r) => setTimeout(r, 300));
  const f = await pool.query(`SELECT flags FROM device_trials WHERE flags @> ARRAY['emulator']`); assert.equal(f.rowCount, 1); assert.ok(!f.rows[0].flags.includes('bogus')); ok('integrity report stores only known flags');

  // 11. rate limit on register
  let last;
  for (let i = 0; i < 9; i++) last = await call('/api/v1/auth/register', { method: 'POST', body: { email: `rl${i}@test.dev`, password: PASS }, ip: '198.51.100.5' });
  assert.equal(last.status, 429); assert.equal(last.json.code, 'rate_limited'); ok('register is rate limited per IP');

  console.log(`\nbackend OK (${n} checks, STT called ${sttCalls} times)`);
} catch (e) {
  console.error('\nFAILED:', e.message); console.error(logs.split('\n').slice(-12).join('\n')); process.exitCode = 1;
} finally {
  srv.kill(); stt.close(); await pool.end();
}

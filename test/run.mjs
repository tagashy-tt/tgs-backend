// Integration test against a real PostgreSQL (DATABASE_URL). Starts the server and a fake speech-to-text provider.
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/tgs';
const PORT = 3911, STT_PORT = 3912, BASE = `http://127.0.0.1:${PORT}`;
const pool = new pg.Pool({ connectionString: DB, host: process.env.PGHOST, ssl: false });

await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await pool.query(fs.readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));


// legacy data from the old automatic-trial model: the server must migrate it when it starts
await pool.query(`CREATE TABLE public.device_trials (device_hash TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), ends_at TIMESTAMPTZ NOT NULL, ip_hash TEXT, banned BOOLEAN NOT NULL DEFAULT FALSE, flags TEXT[] NOT NULL DEFAULT '{}', app_version TEXT, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await pool.query(`CREATE TABLE public.device_accounts (device_hash TEXT NOT NULL, user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE, linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (device_hash, user_id))`);
const legacyUser = (await pool.query(`INSERT INTO app_users (email, password_hash) VALUES ('legacy@test.dev','x') RETURNING id`)).rows[0].id;
await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at, external_id) VALUES ($1,'premium',TRUE,'trial',NOW() + INTERVAL '3 days','legacyhash000000')`, [legacyUser]);
const peppered = (v) => crypto.createHash('sha256').update(`http://localhost:${v}`).digest('hex'); // DEVICE_PEPPER falls back to APP_BASE_URL
await pool.query(`INSERT INTO device_trials (device_hash, ends_at) VALUES ($1, NOW() + INTERVAL '3 days'), ($2, NOW() + INTERVAL '5 days')`, [peppered('device-L-aaaaaaaaaaaaaaaaaaaaaaaa'), peppered('device-O-aaaaaaaaaaaaaaaaaaaaaaaa')]);
await pool.query(`INSERT INTO device_accounts (device_hash, user_id) VALUES ($1, $2)`, [peppered('device-L-aaaaaaaaaaaaaaaaaaaaaaaa'), legacyUser]);

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
  OWNER_EMAIL: 'owner@test.dev', STT_API_KEY: 'test-key', STT_API_URL: `http://127.0.0.1:${STT_PORT}/v1/audio/transcriptions`, SUBS_DAILY_SECONDS: '120', SUBS_MAX_SECONDS: '100', SUBS_MONTHLY_SECONDS: '200',
  TRIAL_MAX_DEVICES_PER_IP: '5', TRUST_PROXY: 'true', SUBS_PER_MINUTE: '30', TRIAL_CLAIMS_PER_HOUR: '100',
  BETA_PREMIUM_EMAILS: '"beta1@test.dev","Beta2@Test.dev"\n  beta3@test.dev; <beta4@test.dev> , beta5@test.dev',
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
  const h = await call('/health'); assert.equal(h.json.version, '0.5.5'); ok('health reports 0.5.5');

  // 1. hello only registers the device: no clock starts
  const hello = await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('A'), version: '1.1.0' }, ip: '10.0.0.1' });
  assert.equal(hello.status, 200); assert.equal(hello.json.trial.active, false); assert.equal(hello.json.trial.claimable, true); assert.equal(hello.json.trial.claimed, false); assert.equal(hello.json.trialDays, 7); ok('hello registers the device and starts NO trial');
  assert.equal((await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: 'short' } })).status, 400); ok('bad device id refused');

  // 2. an account on the device stays free until it claims
  const t1 = await signup('one@test.dev', dev('A'));
  let e = await call('/api/v1/me/entitlements', { token: t1, device: dev('A') });
  assert.equal(e.json.premium, false); assert.equal(e.json.plan, 'free'); assert.equal(e.json.trial.claimable, true); assert.equal(e.json.features.ai_subtitles, false); assert.equal(e.json.features.cc_lab, false); ok('signing up does not start the trial (plan=free, claimable)');
  let c = await call('/api/v1/trial/claim', { method: 'POST' }); assert.equal(c.status, 401); ok('claim needs a signed-in account');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: t1 }); assert.equal(c.status, 400); ok('claim needs a device id');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: t1, device: dev('A') });
  assert.equal(c.status, 200, JSON.stringify(c.json)); assert.equal(c.json.trial.active, true); assert.equal(c.json.trial.daysRemaining, 7); ok('claim starts the 7 days');
  e = await call('/api/v1/me/entitlements', { token: t1, device: dev('A') });
  assert.equal(e.json.premium, true); assert.equal(e.json.plan, 'trial'); assert.equal(e.json.features.ai_subtitles, true); assert.equal(e.json.features.cc_lab, true); assert.equal(e.json.trial.claimable, false); assert.ok(e.json.daysRemaining >= 6); ok('after the claim: premium plan=trial, everything unlocked');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: t1, device: dev('A') }); assert.equal(c.status, 409); assert.equal(c.json.code, 'device_used'); ok('claiming twice is refused');

  // 3. no device id -> free, nothing to claim with
  const tFree = await signup('free@test.dev', undefined, '10.0.0.2');
  e = await call('/api/v1/me/entitlements', { token: tFree }); assert.equal(e.json.premium, false); assert.equal(e.json.plan, 'free'); ok('no device id: stays free');

  // 4. a second account on the SAME device cannot get another trial; the first account cannot get one from another device
  const t2 = await signup('two@test.dev', dev('A'));
  c = await call('/api/v1/trial/claim', { method: 'POST', token: t2, device: dev('A') }); assert.equal(c.status, 409); assert.equal(c.json.code, 'device_used');
  e = await call('/api/v1/me/entitlements', { token: t2, device: dev('A') }); assert.equal(e.json.premium, false); assert.equal(e.json.trial.claimable, false); ok('second account on the same device: no trial');
  const t3 = await signup('three@test.dev', dev('A'));
  c = await call('/api/v1/trial/claim', { method: 'POST', token: t3, device: dev('A') }); assert.equal(c.status, 409); ok('third account on the same device: no trial');
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('B') }, ip: '10.0.0.4' });
  c = await call('/api/v1/trial/claim', { method: 'POST', token: t1, device: dev('B') }); assert.equal(c.status, 409); assert.equal(c.json.code, 'account_used'); ok('same account on a new device: no second trial');
  const dB = await pool.query(`SELECT claimed_at FROM device_trials WHERE ends_at IS NULL AND claimed_at IS NULL AND first_seen > NOW() - INTERVAL '1 minute' LIMIT 1`);
  assert.ok(dB.rowCount >= 1); ok('a refused claim does not burn the new device');
  // 4b. legacy (automatic trial) data was migrated
  c = await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('O') }, ip: '10.0.0.5' });
  assert.equal(c.json.trial.claimable, true); assert.equal(c.json.trial.active, false); ok('legacy: a device that never signed anyone in becomes claimable');
  const tl = await signup('legacy-new@test.dev', dev('L'), '10.0.0.6');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: tl, device: dev('L') }); assert.equal(c.status, 409); assert.equal(c.json.code, 'device_used'); ok('legacy: a device whose trial already ran is used');
  const lt = await pool.query(`SELECT 1 FROM trial_claims WHERE user_id = $1`, [legacyUser]); assert.equal(lt.rowCount, 1); ok('legacy: the account that had the automatic trial counts as used');

  // 5. ip velocity
  for (let i = 0; i < 7; i++) {
    await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('V' + i) }, ip: '203.0.113.9' });
  }
  const lastTok = await signup('farm@test.dev', dev('V6'), '203.0.113.9');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: lastTok, device: dev('V6') });
  assert.equal(c.status, 403); assert.equal(c.json.code, 'not_available'); ok('device farm from one IP: claim refused (reason not leaked)');
  const okDev = await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('V0') }, ip: '203.0.113.9' });
  assert.equal(okDev.json.trial.claimable, true); ok('the first devices of that IP can still claim');

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

  // 6b. monthly quota of subtitle minutes (SUBS_MONTHLY_SECONDS=200 in this test)
  const q = await call('/api/v1/subtitles/quota', { token: t1 }); assert.equal(q.status, 200); assert.equal(q.json.monthlySeconds, 200); assert.equal(q.json.usedSeconds, 106); assert.equal(q.json.remainingSeconds, 94); assert.equal(q.json.maxSeconds, 100); ok('subtitles: quota endpoint reports minutes used this month');
  const old = await pool.query(`SELECT (NOW() - (date_trunc('month', NOW() AT TIME ZONE 'America/Costa_Rica') AT TIME ZONE 'America/Costa_Rica')) > INTERVAL '26 hours' AS can`);
  if (old.rows[0].can) {
    const uq = (await pool.query(`SELECT id FROM app_users WHERE email = 'two@test.dev'`)).rows[0].id;
    await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at) VALUES ($1,'premium',TRUE,'manual',NULL)`, [uq]);
    await pool.query(`INSERT INTO subtitle_jobs (user_id, seconds, bytes, created_at) VALUES ($1, 150, 1, date_trunc('month', NOW() AT TIME ZONE 'America/Costa_Rica') AT TIME ZONE 'America/Costa_Rica' + INTERVAL '1 second')`, [uq]);
    s = await call('/api/v1/subtitles', { method: 'POST', token: t2, raw: audio, query: '?seconds=60' }); assert.equal(s.status, 429); assert.equal(s.json.code, 'quota_reached'); assert.equal(s.json.remainingSeconds, 50);
    s = await call('/api/v1/subtitles', { method: 'POST', token: t2, raw: audio, query: '?seconds=40' }); assert.equal(s.status, 200); ok('subtitles: monthly quota stops at the limit and still lets a clip that fits');
  } else ok('subtitles: monthly quota test skipped (first day of the month)');

  // 6c. everything that used to be free weekly is paid now
  const u = await call('/api/v1/usage/consume', { method: 'POST', token: tFree, body: { feature: 'topaz' } }); assert.equal(u.status, 429); assert.equal(u.json.features.topaz.limit, 0); ok('usage: free accounts have 0 uses of Topaz / Check / Download');
  const u2 = await call('/api/v1/usage/consume', { method: 'POST', token: t1, body: { feature: 'topaz' } }); assert.equal(u2.status, 200); assert.equal(u2.json.features.topaz.limit, null); ok('usage: the trial account is unlimited');

  // 7. ban revokes
  const owTok = await signup('owner@test.dev', undefined, '10.0.0.3');
  const forbidden = await call('/api/v1/admin/abuse', { token: tFree }); assert.equal(forbidden.status, 403); ok('admin routes: customers get 403');
  const ban = await call('/api/v1/admin/device/ban', { method: 'POST', token: owTok, body: { deviceId: dev('A') } });
  assert.equal(ban.status, 200); assert.equal(ban.json.revoked, 1); ok('ban revokes the trial of that device');
  e = await call('/api/v1/me/entitlements', { token: t1, device: dev('A') }); assert.equal(e.json.premium, false); assert.equal(e.json.trial.active, false); ok('banned device: premium gone, trial inactive');
  const ab = await call('/api/v1/admin/abuse', { token: owTok }); assert.equal(ab.status, 200);
  const kinds = ab.json.counts.map((c) => c.kind); assert.ok(kinds.includes('multi_account') && kinds.includes('ip_velocity') && kinds.includes('ban') && kinds.includes('claim_device_used')); ok('abuse log lists multi_account, ip_velocity, ban, claim_device_used');

  // 8. expiry is final
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('E') }, ip: '10.0.0.7' });
  const tE = await signup('exp@test.dev', dev('E'), '10.0.0.7');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: tE, device: dev('E') }); assert.equal(c.status, 200);
  e = await call('/api/v1/me/entitlements', { token: tE, device: dev('E') }); assert.equal(e.json.premium, true);
  await pool.query(`UPDATE device_trials SET ends_at = NOW() - INTERVAL '1 hour' WHERE first_seen > NOW() - INTERVAL '1 minute' AND device_hash = (SELECT device_hash FROM device_accounts da JOIN app_users u ON u.id = da.user_id WHERE u.email = 'exp@test.dev')`);
  await pool.query(`UPDATE user_entitlements SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = (SELECT id FROM app_users WHERE email='exp@test.dev')`);
  e = await call('/api/v1/me/entitlements', { token: tE, device: dev('E') }); assert.equal(e.json.premium, false); assert.equal(e.json.trial.active, false);
  const relog = await call('/api/v1/auth/login', { method: 'POST', body: { email: 'exp@test.dev', password: PASS }, device: dev('E'), ip: '10.0.0.7' });
  e = await call('/api/v1/me/entitlements', { token: relog.json.accessToken, device: dev('E') }); assert.equal(e.json.premium, false);
  c = await call('/api/v1/trial/claim', { method: 'POST', token: relog.json.accessToken, device: dev('E') }); assert.equal(c.status, 409); ok('after the 7 days: free, logging in again or claiming again does not restart it');

  // 9. paid rows are never overwritten by a trial
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('P') }, ip: '10.0.0.8' });
  const tP = await signup('paid@test.dev', undefined, '10.0.0.8');
  await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at) SELECT id,'premium',TRUE,'paypal',NULL FROM app_users WHERE email='paid@test.dev'`);
  e = await call('/api/v1/me/entitlements', { token: tP, device: dev('P') }); assert.equal(e.json.plan, 'lifetime'); assert.equal(e.json.trial.claimable, false);
  c = await call('/api/v1/trial/claim', { method: 'POST', token: tP, device: dev('P') }); assert.equal(c.status, 409); assert.equal(c.json.code, 'has_premium_row'); ok('lifetime/paid premium is not replaced by the trial and cannot claim one');

  // 10. integrity report flags tampered builds; with enforce off the trial still works
  const rep = await call('/api/v1/integrity', { method: 'POST', body: { deviceId: dev('Q'), cert: 'aa', pkg: 'com.tgs.uploader', flags: ['emulator', 'bogus'] }, ip: '10.0.0.9' });
  assert.equal(rep.status, 200); await new Promise((r) => setTimeout(r, 300));
  const f = await pool.query(`SELECT flags FROM device_trials WHERE flags @> ARRAY['emulator']`); assert.equal(f.rowCount, 1); assert.ok(!f.rows[0].flags.includes('bogus')); ok('integrity report stores only known flags');

  // 12. deleting the account and creating another one does not give a new trial
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('D') }, ip: '10.0.0.10' });
  const tD = await signup('del@test.dev', dev('D'), '10.0.0.10');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: tD, device: dev('D') }); assert.equal(c.status, 200);
  await pool.query(`DELETE FROM app_users WHERE email = 'del@test.dev'`);
  const tD2 = await signup('del2@test.dev', dev('D'), '10.0.0.10');
  c = await call('/api/v1/trial/claim', { method: 'POST', token: tD2, device: dev('D') }); assert.equal(c.status, 409); assert.equal(c.json.code, 'device_used'); ok('deleting the account and creating another one gives no new trial');
  // two parallel claims on a fresh device: exactly one wins
  await call('/api/v1/device/hello', { method: 'POST', body: { deviceId: dev('R') }, ip: '10.0.0.11' });
  const tR1 = await signup('race1@test.dev', dev('R'), '10.0.0.11'); const tR2 = await signup('race2@test.dev', dev('R'), '10.0.0.11');
  const race = await Promise.all([call('/api/v1/trial/claim', { method: 'POST', token: tR1, device: dev('R') }), call('/api/v1/trial/claim', { method: 'POST', token: tR2, device: dev('R') })]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]); ok('two simultaneous claims on one device: only one wins');


  // 10b. beta gift: list parsing (quotes, case, new lines, <>), expired rows, active paid rows, diagnostics
  const tB1 = await signup('beta1@test.dev', dev('B1'), '10.0.1.1');
  e = await call('/api/v1/me/entitlements', { token: tB1, device: dev('B1') });
  assert.equal(e.json.premium, true); assert.ok(e.json.daysRemaining >= 364); ok('beta: an email written with quotes in the list gets the gift');
  const tB2 = await signup('beta2@test.dev', dev('B2'), '10.0.1.2');
  e = await call('/api/v1/me/entitlements', { token: tB2, device: dev('B2') }); assert.equal(e.json.premium, true); ok('beta: list is case-insensitive');
  const tB3 = await signup('beta3@test.dev', dev('B3'), '10.0.1.3');
  await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at) SELECT id, 'premium', FALSE, 'paypal_subscription', NOW() - INTERVAL '10 days' FROM app_users WHERE email = 'beta3@test.dev'`);
  e = await call('/api/v1/me/entitlements', { token: tB3, device: dev('B3') }); assert.equal(e.json.premium, true); ok('beta: an account with an EXPIRED premium row now gets the gift (0.5.3 skipped it)');
  const tB4 = await signup('beta4@test.dev', dev('B4'), '10.0.1.4');
  await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at) SELECT id, 'premium', TRUE, 'paypal_lifetime', NULL FROM app_users WHERE email = 'beta4@test.dev'`);
  e = await call('/api/v1/me/entitlements', { token: tB4, device: dev('B4') }); assert.equal(e.json.plan, 'lifetime'); ok('beta: an active lifetime row is never replaced');
  const tB5 = await signup('beta5@test.dev', dev('B5'), '10.0.1.5');
  await pool.query(`INSERT INTO user_entitlements (user_id, feature, active, source, expires_at) SELECT id, 'premium', TRUE, 'trial', NOW() + INTERVAL '2 days' FROM app_users WHERE email = 'beta5@test.dev'`);
  e = await call('/api/v1/me/entitlements', { token: tB5, device: dev('B5') }); assert.ok(e.json.daysRemaining >= 364); assert.notEqual(e.json.plan, 'trial'); ok('beta: an active 7-day trial is upgraded to the beta gift');
  const dg = await call('/api/v1/admin/diagnostics', { token: owTok });
  assert.equal(dg.status, 200, JSON.stringify(dg.json)); assert.equal(dg.json.trialSchema.ok, true); assert.equal(dg.json.betaCount, 5); assert.equal(dg.json.beta.find((b) => b.email === 'beta4@test.dev').reason, 'has_active_premium'); ok('diagnostics: owner sees schema status and why each beta email does/does not get the gift');
  assert.equal((await call('/api/v1/admin/diagnostics', { token: tB1, device: dev('B1') })).status, 403); ok('diagnostics: customers get 403');

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

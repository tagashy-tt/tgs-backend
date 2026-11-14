// 7-day free trial tied to the DEVICE (install), with the abuse rules around it.
//   - the clock starts the first time an install talks to the server (POST /api/v1/device/hello), not at sign-up;
//   - one trial per device: a second/third account on the same device shares the SAME end date, never a new one;
//   - at most TRIAL_MAX_ACCOUNTS_PER_DEVICE accounts per device get the trial, the rest are refused and logged;
//   - at most TRIAL_MAX_DEVICES_PER_IP new devices per IP per 24 h (a farm of reinstalls is refused and logged);
//   - banned devices, tampered builds (when INTEGRITY_ENFORCE=true) and emulators (when TRIAL_BLOCK_EMULATORS=true) get no trial;
//   - the trial is a normal 'premium' entitlement row with source 'trial', so every existing check (usage, features) just works,
//     and a paid/gifted/lifetime row is never touched.
import crypto from 'node:crypto';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

export function trialConfig(env = process.env) {
  return {
    days: Math.min(60, Math.max(1, Math.floor(num(env.TRIAL_DAYS, 7)))),
    maxAccountsPerDevice: Math.max(1, Math.floor(num(env.TRIAL_MAX_ACCOUNTS_PER_DEVICE, 2))),
    maxDevicesPerIpDay: Math.max(1, Math.floor(num(env.TRIAL_MAX_DEVICES_PER_IP, 8))),
    blockEmulators: env.TRIAL_BLOCK_EMULATORS === 'true',
    enforceIntegrity: env.INTEGRITY_ENFORCE === 'true',
    pepper: String(env.DEVICE_PEPPER || env.APP_BASE_URL || 'tgs'),
  };
}

export const hashWithPepper = (value, pepper) => crypto.createHash('sha256').update(`${pepper}:${value}`).digest('hex');

/**
 * Pure decision: may this account get the trial of this device right now?
 * device = {endsAt: Date|string, banned: boolean, flags: string[]}
 * returns {grant: boolean, reason: string}
 */
export function decideTrial({ device, accountRank, hasPremiumRow, now = Date.now(), cfg }) {
  if (!device) return { grant: false, reason: 'no_device' };
  if (hasPremiumRow) return { grant: false, reason: 'has_premium_row' };
  if (device.banned) return { grant: false, reason: 'device_banned' };
  const flags = device.flags || [];
  if (cfg.enforceIntegrity && flags.includes('tampered')) return { grant: false, reason: 'tampered' };
  if (cfg.blockEmulators && flags.includes('emulator')) return { grant: false, reason: 'emulator' };
  if (flags.includes('ip_velocity')) return { grant: false, reason: 'ip_velocity' };
  const ends = new Date(device.endsAt).getTime();
  if (!Number.isFinite(ends) || ends <= now) return { grant: false, reason: 'trial_over' };
  if (accountRank > cfg.maxAccountsPerDevice) return { grant: false, reason: 'multi_account' };
  return { grant: true, reason: 'ok' };
}

export const daysLeft = (endsAt, now = Date.now()) => {
  const t = new Date(endsAt).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 86400000)) : 0;
};

export function createTrialService({ pool, setEntitlement, env = process.env, log = console }) {
  const cfg = trialConfig(env);
  let ready = null;
  const done = new Set(); // `${userId}:${deviceHash}` already handled in this process

  function ensureSchema() {
    ready ??= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.device_trials (
        device_hash TEXT PRIMARY KEY,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ends_at TIMESTAMPTZ NOT NULL,
        ip_hash TEXT,
        banned BOOLEAN NOT NULL DEFAULT FALSE,
        flags TEXT[] NOT NULL DEFAULT '{}',
        app_version TEXT,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS device_trials_ip_idx ON public.device_trials (ip_hash, first_seen)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.device_accounts (
        device_hash TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (device_hash, user_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.abuse_events (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        device_hash TEXT,
        user_id UUID,
        ip_hash TEXT,
        detail JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  async function event(kind, { deviceHash = null, userId = null, ipHash = null, detail = {} } = {}) {
    try {
      await pool.query(`INSERT INTO abuse_events (kind, device_hash, user_id, ip_hash, detail) VALUES ($1,$2,$3,$4,$5)`, [kind, deviceHash, userId, ipHash, JSON.stringify(detail)]);
    } catch (e) { log.error?.('[abuse] could not log event:', e.message); }
  }

  const hashDevice = (deviceId) => hashWithPepper(deviceId, cfg.pepper);
  const hashIp = (ip) => hashWithPepper(String(ip || ''), cfg.pepper);

  /** First contact of an install: starts its clock (once). Returns the device row as a plain object. */
  async function hello({ deviceId, ip, version = '', flags = [] }) {
    await ensureSchema();
    const deviceHash = hashDevice(deviceId);
    const ipHash = hashIp(ip);
    const ins = await pool.query(
      `INSERT INTO device_trials (device_hash, ends_at, ip_hash, app_version, flags)
       VALUES ($1, NOW() + ($2 || ' days')::interval, $3, $4, $5)
       ON CONFLICT (device_hash) DO NOTHING
       RETURNING device_hash`,
      [deviceHash, String(cfg.days), ipHash, String(version).slice(0, 20), flags]
    );
    if (ins.rowCount) {
      // new device: too many new devices from one IP in 24 h means somebody is farming trials
      const n = await pool.query(`SELECT COUNT(*)::int AS n FROM device_trials WHERE ip_hash = $1 AND first_seen > NOW() - INTERVAL '24 hours'`, [ipHash]);
      if (n.rows[0].n > cfg.maxDevicesPerIpDay) {
        await pool.query(`UPDATE device_trials SET flags = array_append(flags, 'ip_velocity') WHERE device_hash = $1 AND NOT ('ip_velocity' = ANY(flags))`, [deviceHash]);
        await event('ip_velocity', { deviceHash, ipHash, detail: { devicesLast24h: n.rows[0].n } });
      }
    } else {
      await pool.query(
        `UPDATE device_trials SET last_seen = NOW(), app_version = COALESCE(NULLIF($2,''), app_version),
           flags = (SELECT ARRAY(SELECT DISTINCT unnest(flags || $3::text[]))) WHERE device_hash = $1`,
        [deviceHash, String(version).slice(0, 20), flags]
      );
    }
    return { deviceHash, device: await getDevice(deviceHash) };
  }

  async function getDevice(deviceHash) {
    const r = await pool.query(`SELECT device_hash, first_seen, ends_at, banned, flags FROM device_trials WHERE device_hash = $1`, [deviceHash]);
    const row = r.rows[0];
    return row ? { deviceHash: row.device_hash, firstSeen: row.first_seen, endsAt: row.ends_at, banned: row.banned, flags: row.flags || [] } : null;
  }

  /** What the app shows: never leaks reasons that would help an abuser, only active/over and the date. */
  function publicTrial(device, now = Date.now()) {
    if (!device) return { active: false, endsAt: null, daysRemaining: 0 };
    const ends = new Date(device.endsAt).getTime();
    const active = !device.banned && !(device.flags || []).includes('ip_velocity') && Number.isFinite(ends) && ends > now;
    return { active, endsAt: device.endsAt, daysRemaining: active ? daysLeft(device.endsAt, now) : 0 };
  }

  /** Called when an authenticated request carries a device id. Grants the trial entitlement when the rules allow. */
  async function onAuthed({ user, deviceId, ip, version = '' }) {
    if (!user || !deviceId) return { granted: false, reason: 'no_device_id' };
    const deviceHash = hashDevice(deviceId);
    const key = `${user.id}:${deviceHash}`;
    if (done.has(key)) return { granted: false, reason: 'already_handled' };
    await ensureSchema();
    let device = await getDevice(deviceHash);
    if (!device) device = (await hello({ deviceId, ip, version })).device;
    await pool.query(`INSERT INTO device_accounts (device_hash, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [deviceHash, user.id]);
    const rank = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_accounts WHERE device_hash = $1
         AND linked_at <= (SELECT linked_at FROM device_accounts WHERE device_hash = $1 AND user_id = $2)`,
      [deviceHash, user.id]
    )).rows[0].n;
    const hasRow = (await pool.query(`SELECT 1 FROM user_entitlements WHERE user_id = $1 AND feature = 'premium' LIMIT 1`, [user.id])).rowCount > 0;
    const d = decideTrial({ device, accountRank: rank, hasPremiumRow: hasRow, cfg });
    if (d.grant) {
      await setEntitlement(user.id, 'premium', true, { source: 'trial', expires_at: new Date(device.endsAt).toISOString(), external_id: deviceHash.slice(0, 16) });
      log.log?.(`[trial] ${user.email} got the trial until ${new Date(device.endsAt).toISOString()}`);
    } else if (['multi_account', 'tampered', 'emulator', 'device_banned', 'ip_velocity'].includes(d.reason)) {
      await event(d.reason, { deviceHash, userId: user.id, detail: { rank } });
    }
    if (d.reason !== 'no_device') done.add(key);
    return { granted: d.grant, reason: d.reason };
  }

  /** The app reports its own environment (integrity check, emulator/root hints). Flags are recorded; blocking is decided by decideTrial. */
  async function report({ deviceId, ip, flags = [], mismatch = false }) {
    if (!deviceId) return;
    await ensureSchema();
    const all = [...flags, ...(mismatch ? ['tampered'] : [])];
    const { deviceHash } = await hello({ deviceId, ip, flags: all });
    if (all.length) {
      await event('env_report', { deviceHash, ipHash: hashIp(ip), detail: { flags: all } });
      if (cfg.enforceIntegrity && all.includes('tampered')) await revokeTrials(deviceHash);
    }
  }

  async function revokeTrials(deviceHash) {
    const r = await pool.query(
      `UPDATE user_entitlements SET active = FALSE, updated_at = NOW()
       WHERE feature = 'premium' AND source = 'trial' AND active = TRUE
         AND user_id IN (SELECT user_id FROM device_accounts WHERE device_hash = $1)`,
      [deviceHash]
    );
    return r.rowCount;
  }

  async function setBan({ deviceHash, banned }) {
    await ensureSchema();
    const r = await pool.query(`UPDATE device_trials SET banned = $2 WHERE device_hash = $1`, [deviceHash, !!banned]);
    const revoked = banned ? await revokeTrials(deviceHash) : 0;
    await event(banned ? 'ban' : 'unban', { deviceHash, detail: { revoked } });
    return { found: r.rowCount > 0, revoked };
  }

  async function recentAbuse(limit = 100) {
    await ensureSchema();
    const rows = (await pool.query(`SELECT id, kind, device_hash, user_id, detail, created_at FROM abuse_events ORDER BY id DESC LIMIT $1`, [Math.min(500, Math.max(1, limit))])).rows;
    const counts = (await pool.query(`SELECT kind, COUNT(*)::int AS n FROM abuse_events WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY kind ORDER BY n DESC`)).rows;
    return { counts, events: rows };
  }

  return { cfg, ensureSchema, hello, getDevice, publicTrial, onAuthed, report, setBan, recentAbuse, hashDevice, hashIp };
}

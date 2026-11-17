// 7-day free trial, CLAIMED on purpose by a signed-in account, with the abuse rules around it.
//   - nothing starts by itself: the person taps "Claim 7 days" (POST /api/v1/trial/claim) while signed in;
//   - once per DEVICE, for ever: the first claim marks the device (device_trials.claimed_at); a second account, a reinstall or a
//     deleted + re-created account on that device gets 'device_used', never a new trial;
//   - once per ACCOUNT, for ever (trial_claims): the same account cannot claim again from another device;
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
 * Pure decision for a claim. device = {claimedAt, banned, flags}; account = {claimedBefore, hasPaidRow}.
 * reason: ok | no_device | device_used | account_used | has_premium_row | device_banned | tampered | emulator | ip_velocity
 */
export function decideClaim({ device, account, cfg }) {
  if (!device) return { grant: false, reason: 'no_device' };
  if (device.claimedAt) return { grant: false, reason: 'device_used' };
  if (account?.claimedBefore) return { grant: false, reason: 'account_used' };
  if (account?.hasPaidRow) return { grant: false, reason: 'has_premium_row' };
  if (device.banned) return { grant: false, reason: 'device_banned' };
  const flags = device.flags || [];
  if (cfg.enforceIntegrity && flags.includes('tampered')) return { grant: false, reason: 'tampered' };
  if (cfg.blockEmulators && flags.includes('emulator')) return { grant: false, reason: 'emulator' };
  if (flags.includes('ip_velocity')) return { grant: false, reason: 'ip_velocity' };
  return { grant: true, reason: 'ok' };
}

export const daysLeft = (endsAt, now = Date.now()) => {
  const t = new Date(endsAt).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 86400000)) : 0;
};

export function createTrialService({ pool, env = process.env, log = console }) {
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
      // claim model: the clock no longer starts at first contact
      await pool.query(`ALTER TABLE public.device_trials ALTER COLUMN ends_at DROP NOT NULL`);
      await pool.query(`ALTER TABLE public.device_trials ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE public.device_trials ADD COLUMN IF NOT EXISTS claimed_by UUID`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.device_accounts (
        device_hash TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (device_hash, user_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.trial_claims (
        user_id UUID PRIMARY KEY,
        device_hash TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // trials that the old (automatic) model already started count as used; devices that never signed anyone in become claimable
      await pool.query(`UPDATE public.device_trials d SET claimed_at = d.first_seen
        WHERE d.claimed_at IS NULL AND d.ends_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.device_accounts a WHERE a.device_hash = d.device_hash)`);
      await pool.query(`UPDATE public.device_trials SET ends_at = NULL WHERE claimed_at IS NULL AND ends_at IS NOT NULL`);
      await pool.query(`INSERT INTO public.trial_claims (user_id, device_hash, claimed_at)
        SELECT user_id, COALESCE(external_id, ''), COALESCE(updated_at, NOW()) FROM public.user_entitlements WHERE feature = 'premium' AND source = 'trial'
        ON CONFLICT (user_id) DO NOTHING`);
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

  /** First contact of an install: registers the device (no trial starts here). Returns the device row as a plain object. */
  async function hello({ deviceId, ip, version = '', flags = [] }) {
    await ensureSchema();
    const deviceHash = hashDevice(deviceId);
    const ipHash = hashIp(ip);
    const ins = await pool.query(
      `INSERT INTO device_trials (device_hash, ends_at, ip_hash, app_version, flags)
       VALUES ($1, NULL, $2, $3, $4)
       ON CONFLICT (device_hash) DO NOTHING
       RETURNING device_hash`,
      [deviceHash, ipHash, String(version).slice(0, 20), flags]
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
    const r = await pool.query(`SELECT device_hash, first_seen, ends_at, claimed_at, banned, flags FROM device_trials WHERE device_hash = $1`, [deviceHash]);
    const row = r.rows[0];
    return row ? { deviceHash: row.device_hash, firstSeen: row.first_seen, endsAt: row.ends_at, claimedAt: row.claimed_at, banned: row.banned, flags: row.flags || [] } : null;
  }

  /** What the app shows: never leaks reasons that would help an abuser. claimable is a hint; the claim itself decides. */
  function publicTrial(device, now = Date.now(), { accountUsed = false } = {}) {
    if (!device) return { active: false, endsAt: null, daysRemaining: 0, claimed: false, claimable: false, days: cfg.days };
    const ends = device.endsAt ? new Date(device.endsAt).getTime() : NaN;
    const blocked = device.banned || (device.flags || []).includes('ip_velocity');
    const active = !blocked && Number.isFinite(ends) && ends > now;
    return {
      active,
      endsAt: device.endsAt || null,
      daysRemaining: active ? daysLeft(device.endsAt, now) : 0,
      claimed: !!device.claimedAt,
      claimable: !device.claimedAt && !blocked && !accountUsed,
      days: cfg.days,
    };
  }

  /** Called when an authenticated request carries a device id. It only LINKS the account to the device (and logs odd multi-account use): the trial is never granted here. */
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
    if (rank > cfg.maxAccountsPerDevice) await event('multi_account', { deviceHash, userId: user.id, detail: { rank } });
    done.add(key);
    return { granted: false, reason: 'claim_required' };
  }

  /** Has this account ever claimed (or used the old automatic) trial? */
  async function accountClaimed(userId) {
    await ensureSchema();
    return (await pool.query(`SELECT 1 FROM trial_claims WHERE user_id = $1`, [userId])).rowCount > 0;
  }

  /**
   * The person taps "Claim 7 days". One transaction: the device is marked first (atomic, only if nobody claimed it), then the account.
   * Returns {granted, reason, endsAt?}. Refusals are logged as abuse events when they look like abuse.
   */
  async function claim({ user, deviceId, ip, version = '' }) {
    if (!user) return { granted: false, reason: 'no_user' };
    if (!deviceId) return { granted: false, reason: 'no_device' };
    await ensureSchema();
    const { deviceHash, device } = await hello({ deviceId, ip, version });
    const claimedBefore = await accountClaimed(user.id);
    const hasPaidRow = (await pool.query(`SELECT 1 FROM user_entitlements WHERE user_id = $1 AND feature = 'premium' AND source <> 'trial' LIMIT 1`, [user.id])).rowCount > 0;
    const d = decideClaim({ device, account: { claimedBefore, hasPaidRow }, cfg });
    if (!d.grant) {
      if (['device_used', 'account_used', 'tampered', 'emulator', 'device_banned', 'ip_velocity'].includes(d.reason)) await event(`claim_${d.reason}`, { deviceHash, userId: user.id });
      return { granted: false, reason: d.reason };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Preserve the account/device relationship even if the normal auth hook
      // was interrupted before this explicit trial claim.
      await client.query(
        `INSERT INTO device_accounts (device_hash, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [deviceHash, user.id]
      );
      const upd = await client.query(
        `UPDATE device_trials SET claimed_at = NOW(), claimed_by = $2, ends_at = NOW() + ($3 || ' days')::interval
         WHERE device_hash = $1 AND claimed_at IS NULL RETURNING ends_at`,
        [deviceHash, user.id, String(cfg.days)]
      );
      if (!upd.rowCount) { await client.query('ROLLBACK'); return { granted: false, reason: 'device_used' }; }
      const ins = await client.query(`INSERT INTO trial_claims (user_id, device_hash) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [user.id, deviceHash]);
      if (!ins.rowCount) { await client.query('ROLLBACK'); return { granted: false, reason: 'account_used' }; }
      const endsAt = new Date(upd.rows[0].ends_at).toISOString();
      // inside the same transaction: the claim is never consumed without the premium row
      await client.query(
        `INSERT INTO user_entitlements (user_id, feature, active, source, expires_at, external_id, updated_at)
         VALUES ($1, 'premium', TRUE, 'trial', $2, $3, NOW())
         ON CONFLICT (user_id, feature) DO UPDATE SET active = TRUE, source = 'trial', expires_at = EXCLUDED.expires_at, external_id = EXCLUDED.external_id, updated_at = NOW()`,
        [user.id, endsAt, deviceHash.slice(0, 16)]
      );
      await client.query('COMMIT');
      log.log?.(`[trial] ${user.email} claimed the trial until ${endsAt}`);
      return { granted: true, reason: 'ok', endsAt };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** The app reports its own environment (integrity check, emulator/root hints). Flags are recorded; blocking is decided by decideClaim. */
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

  return { cfg, ensureSchema, hello, getDevice, publicTrial, onAuthed, claim, accountClaimed, report, setBan, recentAbuse, hashDevice, hashIp };
}

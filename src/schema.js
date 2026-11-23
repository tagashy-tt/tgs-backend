// The id type of app_users in THIS database. The tables the backend creates on its own (device_accounts, usage_counters, subtitle_jobs...)
// must reference it with the same type, otherwise Postgres refuses the foreign key (42804 "cannot be implemented") and every call that
// touches them answers HTTP 500. A database made from sql/schema.sql has uuid; an older or hand-made one may have text, bigint...
const cache = new WeakMap();

export async function userIdType(pool) {
  if (cache.has(pool)) return cache.get(pool);
  let type = 'uuid';
  try {
    const r = await pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass('public.app_users') AND a.attname = 'id' AND NOT a.attisdropped`
    );
    const t = r.rows[0] && String(r.rows[0].t || '').trim();
    if (t && /^[A-Za-z0-9_ ()\[\],]+$/.test(t)) type = t;
  } catch { /* keep uuid */ }
  cache.set(pool, type);
  return type;
}

/**
 * TGS - Persistent storage via Upstash Redis
 */

function getHeaders() {
  const token = process.env.STORAGE_TOKEN || process.env.KV_REST_API_TOKEN;
  return { Authorization: `Bearer ${token}` };
}

function getBaseUrl() {
  return process.env.STORAGE_URL || process.env.KV_REST_API_URL;
}

async function get(key) {
  const url = getBaseUrl();
  if (!url) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: getHeaders()
    });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch(e) {
    console.error('[DB] get error:', e);
    return null;
  }
}

async function set(key, value, ttl = null) {
  const url = getBaseUrl();
  if (!url) return false;
  try {
    const serialized = JSON.stringify(value);
    let endpoint = `${url}/set/${encodeURIComponent(key)}`;
    if (ttl) endpoint += `/ex/${ttl}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(serialized)
    });
    return res.ok;
  } catch(e) {
    console.error('[DB] set error:', e);
    return false;
  }
}

async function del(key) {
  const url = getBaseUrl();
  if (!url) return;
  try {
    await fetch(`${url}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: getHeaders()
    });
  } catch(e) {
    console.error('[DB] del error:', e);
  }
}

module.exports = { get, set, del };

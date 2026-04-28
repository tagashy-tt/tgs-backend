/**
 * TGS - Simple in-memory + persistent store
 * Uses Vercel KV (free tier) via fetch
 * Fallback: in-memory for dev
 */

// In-memory store (persists per serverless instance)
const store = {};

/**
 * Get a value
 */
async function get(key) {
  // Try Vercel KV if configured
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  }
  return store[key] || null;
}

/**
 * Set a value with optional TTL in seconds
 */
async function set(key, value, ttl = null) {
  const serialized = JSON.stringify(value);
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    let url = `${process.env.KV_REST_API_URL}/set/${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(ttl ? { value: serialized, ex: ttl } : { value: serialized })
    });
    return res.ok;
  }
  store[key] = value;
  return true;
}

/**
 * Delete a value
 */
async function del(key) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    await fetch(`${process.env.KV_REST_API_URL}/del/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    return;
  }
  delete store[key];
}

module.exports = { get, set, del };

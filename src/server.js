import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const paypalBase = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const required = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) console.warn(`Missing environment variables: ${missing.join(', ')}`);

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '256kb' }));

function assertConfigured() {
  if (!supabase) throw Object.assign(new Error('Database is not configured'), { status: 503 });
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    throw Object.assign(new Error('PayPal is not configured'), { status: 503 });
  }
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
async function getUser(req, _res, next) {
  try {
    assertConfigured();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return next(Object.assign(new Error('Sign-in required'), { status: 401 }));
    // Validate the user token with Supabase Auth; never trust a user ID supplied in request body.
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return next(Object.assign(new Error('Invalid session'), { status: 401 }));
    req.user = data.user;
    next();
  } catch (e) { next(e); }
}
async function paypalAccessToken() {
  const credentials = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`PayPal token error: ${body.error_description || body.error || response.status}`);
  return body.access_token;
}
async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();
  const response = await fetch(`${paypalBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`PayPal API error (${response.status}): ${body?.message || 'request failed'}`);
    error.status = 502;
    throw error;
  }
  return body;
}
async function setEntitlement(userId, feature, active, details = {}) {
  const { error } = await supabase.from('user_entitlements').upsert({
    user_id: userId,
    feature,
    active,
    source: details.source || 'paypal',
    expires_at: details.expires_at || null,
    external_id: details.external_id || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,feature' });
  if (error) throw new Error(`Database entitlement write failed: ${error.message}`);
}
function isOwner(user) {
  const ownerEmail = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const accountEmail = (user?.email || '').trim().toLowerCase();
  // Owner identity is configured only on the server, never supplied by the client.
  return Boolean(ownerEmail && accountEmail && accountEmail === ownerEmail && user.email_confirmed_at);
}
function entitlementStatus(row, now = Date.now()) {
  const expiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : null;
  const expired = expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now);
  const daysRemaining = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 86400000));
  return { ...row, active: Boolean(row?.active) && !expired, daysRemaining,
    accessType: expiresAt === null ? 'lifetime' : 'subscription' };
}
async function hasPremium(user) {
  if (isOwner(user)) return true;
  const { data, error } = await supabase.from('user_entitlements')
    .select('feature,active,expires_at')
    .eq('user_id', user.id)
    .eq('active', true);
  if (error) throw new Error('Could not load entitlements');
  const now = Date.now();
  return (data || []).some(row => row.feature === 'premium' &&
    (!row.expires_at || new Date(row.expires_at).getTime() > now));
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'tay-studio-backend', version: '0.1.0' }));
app.get('/api/v1/plans', (_req, res) => res.json({
  currency: 'USD',
  plans: [
    { id: 'monthly', type: 'subscription', label: 'Premium Monthly', price: null, configured: Boolean(process.env.PAYPAL_PLAN_MONTHLY_ID) },
    { id: 'yearly', type: 'subscription', label: 'Premium Yearly', price: null, configured: Boolean(process.env.PAYPAL_PLAN_YEARLY_ID) },
    { id: 'lifetime', type: 'one_time', label: 'Premium Lifetime', price: null, configured: false }
  ],
  note: 'Set prices on the server and create PayPal plans before production. Never accept client-supplied prices.'
}));

// Current account entitlements. Methods and uploads are always free by policy.
app.get('/api/v1/me/entitlements', getUser, async (req, res, next) => {
  try {
    const owner = isOwner(req.user);
    const { data, error } = await supabase.from('user_entitlements')
      .select('feature,active,expires_at,source,external_id,updated_at')
      .eq('user_id', req.user.id);
    if (error) throw error;
    const entitlements = (data || []).map(row => entitlementStatus(row));
    const active = entitlements.filter(row => row.active);
    const premium = owner || active.some(row => row.feature === 'premium');
    const premiumEntitlement = active.find(row => row.feature === 'premium');
    res.json({
      userId: req.user.id,
      role: owner ? 'owner' : 'customer',
      owner,
      premium,
      plan: owner ? 'owner' : (premiumEntitlement?.accessType === 'lifetime' ? 'lifetime' : premium ? 'subscription' : 'free'),
      daysRemaining: owner || (premiumEntitlement && premiumEntitlement.accessType === 'lifetime')
        ? null : (premiumEntitlement?.daysRemaining ?? 0),
      expiresAt: owner ? null : (premiumEntitlement?.expires_at ?? null),
      features: {
        processing_methods: true,
        uploads: true,
        anime_in_app: premium,
        torrent_downloader: premium,
        premium_tools: premium
      },
      entitlements: owner ? [{ feature: 'premium', active: true, accessType: 'owner', daysRemaining: null, expires_at: null }] : active
    });
  } catch (e) { next(e); }
});

// Subscription checkout. Plan IDs are configured only on the server.
app.post('/api/v1/paypal/subscription', getUser, async (req, res, next) => {
  try {
    const plan = req.body?.plan;
    const planId = plan === 'monthly' ? process.env.PAYPAL_PLAN_MONTHLY_ID
      : plan === 'yearly' ? process.env.PAYPAL_PLAN_YEARLY_ID : null;
    if (!planId) return res.status(400).json({ error: 'Plan is not configured' });
    const result = await paypalRequest('/v1/billing/subscriptions', {
      method: 'POST',
      headers: { 'PayPal-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        plan_id: planId,
        custom_id: req.user.id,
        application_context: {
          brand_name: "TAY'S STUDIO",
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${process.env.APP_BASE_URL}/payment/success`,
          cancel_url: `${process.env.APP_BASE_URL}/payment/cancel`
        }
      })
    });
    const approval = result.links?.find(link => link.rel === 'approve')?.href;
    if (!approval) throw new Error('PayPal did not return an approval URL');
    res.json({ subscriptionId: result.id, approvalUrl: approval });
  } catch (e) { next(e); }
});

// Lifetime checkout creates a PayPal order; server-side price is mandatory.
app.post('/api/v1/paypal/lifetime/order', getUser, async (req, res, next) => {
  try {
    const price = process.env.PAYPAL_LIFETIME_PRICE_USD;
    if (!price || !/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
      return res.status(503).json({ error: 'Lifetime price is not configured on the server' });
    }
    const order = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      headers: { 'PayPal-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: 'tay-studio-lifetime',
          custom_id: req.user.id,
          description: "TAY'S STUDIO Premium Lifetime",
          amount: { currency_code: 'USD', value: Number(price).toFixed(2) }
        }],
        application_context: {
          brand_name: "TAY'S STUDIO",
          user_action: 'PAY_NOW',
          return_url: `${process.env.APP_BASE_URL}/payment/success`,
          cancel_url: `${process.env.APP_BASE_URL}/payment/cancel`
        }
      })
    });
    const approval = order.links?.find(link => link.rel === 'approve')?.href;
    if (!approval) throw new Error('PayPal did not return an approval URL');
    res.json({ orderId: order.id, approvalUrl: approval });
  } catch (e) { next(e); }
});

// Capture after the buyer returns. Webhook is still required as a second confirmation path.
app.post('/api/v1/paypal/lifetime/capture', getUser, async (req, res, next) => {
  try {
    const orderId = String(req.body?.orderId || '');
    if (!/^[A-Z0-9-]{8,64}$/i.test(orderId)) return res.status(400).json({ error: 'Invalid orderId' });
    const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': crypto.randomUUID() },
      body: '{}'
    });
    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    // Verify captured status, exact server-configured amount, currency and account ownership.
    if (order.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' ||
        unit?.custom_id !== req.user.id ||
        capture?.amount?.currency_code !== 'USD' ||
        capture?.amount?.value !== Number(process.env.PAYPAL_LIFETIME_PRICE_USD).toFixed(2)) {
      return res.status(409).json({ error: 'Payment not verified' });
    }
    await setEntitlement(req.user.id, 'premium', true, { source: 'paypal_lifetime', external_id: order.id });
    res.json({ ok: true, premium: true });
  } catch (e) { next(e); }
});

// Verify PayPal webhook signature with PayPal's API; do not trust unsigned notifications.
app.post('/api/v1/paypal/webhook', express.json(), async (req, res, next) => {
  try {
    assertConfigured();
    if (!process.env.PAYPAL_WEBHOOK_ID) return res.status(503).json({ error: 'Webhook ID not configured' });
    const h = req.headers;
    const verification = await paypalRequest('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        auth_algo: h['paypal-auth-algo'],
        cert_url: h['paypal-cert-url'],
        transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'],
        transmission_time: h['paypal-transmission-time'],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: req.body
      })
    });
    if (verification.verification_status !== 'SUCCESS') return res.status(400).json({ error: 'Invalid webhook signature' });

    const event = req.body;
    const resource = event.resource || {};
    const userId = resource.custom_id || resource.subscriber?.payer_id && null;
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && userId) {
      await setEntitlement(userId, 'premium', true, { source: 'paypal_lifetime', external_id: resource.id });
    }
    // Subscription events must be mapped by subscription ID to a locally stored owner.
    // Add subscription mapping before enabling these event handlers in production.
    res.json({ received: true });
  } catch (e) { next(e); }
});

// Torrent limits are per file/job, not a claim about total phone Wi-Fi usage.
// Actual enforcement must also exist in the downloader/worker that transfers bytes.
app.get('/api/v1/torrent/policy', getUser, async (req, res, next) => {
  try {
    const premium = await hasPremium(req.user);
    res.json({
      premium,
      maxBytesPerDownload: Number(premium
        ? process.env.PREMIUM_TORRENT_MAX_BYTES || 104857600
        : process.env.FREE_TORRENT_MAX_BYTES || 10485760),
      unit: 'bytes',
      note: 'Per-download cap. This endpoint alone does not enforce transfer limits.'
    });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err.message);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

app.listen(PORT, '0.0.0.0', () => console.log(`TAY'S STUDIO backend listening on ${PORT}`));

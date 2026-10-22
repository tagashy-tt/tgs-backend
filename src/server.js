
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable'
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const paypalBase = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const required = [
  'DATABASE_URL',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'APP_BASE_URL'
];

const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.warn(`Missing environment variables: ${missing.join(', ')}`);
}

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.disable('x-powered-by');

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '256kb' }));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function requireConfig() {
  if (!process.env.DATABASE_URL) {
    throw httpError(503, 'Database is not configured');
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isOwner(user) {
  const ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  return Boolean(
    ownerEmail &&
    user &&
    normalizeEmail(user.email) === ownerEmail &&
    user.email_verified_at
  );
}

function safeUser(row) {
  return {
    id: row.id,
    email: row.email,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at
  };
}

function entitlementStatus(row, now = Date.now()) {
  const expiresAt = row.expires_at
    ? new Date(row.expires_at).getTime()
    : null;

  const expired = expiresAt !== null &&
    (!Number.isFinite(expiresAt) || expiresAt <= now);

  return {
    ...row,
    active: Boolean(row.active) && !expired,
    daysRemaining: expiresAt === null
      ? null
      : Math.max(0, Math.ceil((expiresAt - now) / 86400000)),
    accessType: expiresAt === null ? 'lifetime' : 'subscription'
  };
}

async function getUser(req, _res, next) {
  try {
    requireConfig();

    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) throw httpError(401, 'Sign-in required');

    const token = match[1].trim();
    if (token.length < 32 || token.length > 512) {
      throw httpError(401, 'Invalid session');
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.email_verified_at, u.created_at
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
      [hashToken(token)]
    );

    if (!result.rows.length) throw httpError(401, 'Invalid or expired session');

    req.user = result.rows[0];

    await pool.query(
      'UPDATE app_sessions SET last_used_at = NOW() WHERE token_hash = $1',
      [hashToken(token)]
    );

    next();
  } catch (error) {
    next(error);
  }
}

async function createSession(user, req) {
  const token = crypto.randomBytes(48).toString('base64url');
  const tokenHash = hashToken(token);
  const days = Math.min(
    30,
    Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30))
  );

  await pool.query(
    `INSERT INTO app_sessions
       (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 day'), $4, $5)`,
    [
      user.id,
      tokenHash,
      days,
      String(req.headers['user-agent'] || '').slice(0, 500) || null,
      req.ip || null
    ]
  );

  return { token, expiresInDays: days };
}

async function paypalAccessToken() {
  if (!process.env.PAYPAL_CLIENT_ID ||
      !process.env.PAYPAL_CLIENT_SECRET) {
    throw httpError(503, 'PayPal is not configured');
  }

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('PayPal OAuth failed:', response.status);
    throw httpError(502, 'Could not authenticate with PayPal');
  }

  return body.access_token;
}

async function paypalRequest(path, options = {}) {
  const accessToken = await paypalAccessToken();

  const response = await fetch(`${paypalBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  const body = response.status === 204
    ? null
    : await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('PayPal API error:', response.status);
    throw httpError(502, 'PayPal request failed');
  }

  return body;
}

async function setEntitlement(userId, feature, active, details = {}) {
  await pool.query(
    `INSERT INTO user_entitlements
       (user_id, feature, active, source, expires_at, external_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, feature)
     DO UPDATE SET
       active = EXCLUDED.active,
       source = EXCLUDED.source,
       expires_at = EXCLUDED.expires_at,
       external_id = EXCLUDED.external_id,
       updated_at = NOW()`,
    [
      userId,
      feature,
      active,
      details.source || 'manual',
      details.expires_at || null,
      details.external_id || null
    ]
  );
}

async function hasPremium(user) {
  if (isOwner(user)) return true;

  const result = await pool.query(
    `SELECT 1 FROM user_entitlements
     WHERE user_id = $1
       AND feature = 'premium'
       AND active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [user.id]
  );

  return result.rowCount > 0;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      service: 'tay-studio-backend',
      version: '0.2.0',
      database: 'connected'
    });
  } catch {
    res.status(503).json({
      ok: false,
      service: 'tay-studio-backend',
      database: 'unavailable'
    });
  }
});

app.get('/api/v1/plans', (_req, res) => {
  res.json({
    currency: 'USD',
    plans: [
      {
        id: 'monthly',
        type: 'subscription',
        label: 'Premium Monthly',
        configured: Boolean(process.env.PAYPAL_PLAN_MONTHLY_ID)
      },
      {
        id: 'yearly',
        type: 'subscription',
        label: 'Premium Yearly',
        configured: Boolean(process.env.PAYPAL_PLAN_YEARLY_ID)
      },
      {
        id: 'lifetime',
        type: 'one_time',
        label: 'Premium Lifetime',
        configured: Boolean(process.env.PAYPAL_LIFETIME_PRICE_USD)
      }
    ]
  });
});

// Registration. Email verification must be added before public production.
app.post('/api/v1/auth/register', async (req, res, next) => {
  try {
    requireConfig();

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw httpError(400, 'Invalid email');
    }
    if (password.length < 12 || password.length > 128) {
      throw httpError(400, 'Password must be 12–128 characters');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO app_users (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id, email, email_verified_at, created_at`,
      [email, passwordHash]
    );

    if (!result.rows.length) {
      throw httpError(409, 'An account with that email may already exist');
    }

    // Registration never accepts a role or Premium status from the client.
    res.status(201).json({
      user: safeUser(result.rows[0]),
      message: 'Account created. Email verification is not yet implemented.'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/auth/login', async (req, res, next) => {
  try {
    requireConfig();

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!email || !password || password.length > 128) {
      throw httpError(400, 'Email and password are required');
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, email_verified_at, created_at
       FROM app_users WHERE lower(email) = $1 LIMIT 1`,
      [email]
    );

    const user = result.rows[0];
    const valid = user
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    if (!valid) throw httpError(401, 'Invalid email or password');

    const session = await createSession(user, req);

    res.json({
      user: safeUser(user),
      accessToken: session.token,
      tokenType: 'Bearer',
      expiresInDays: session.expiresInDays
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/auth/logout', getUser, async (req, res, next) => {
  try {
    const token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();

    await pool.query(
      `UPDATE app_sessions SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/me', getUser, async (req, res) => {
  res.json({
    user: safeUser(req.user),
    owner: isOwner(req.user)
  });
});

app.get('/api/v1/me/entitlements', getUser, async (req, res, next) => {
  try {
    const owner = isOwner(req.user);

    const result = await pool.query(
      `SELECT feature, active, expires_at, source, external_id, updated_at
       FROM user_entitlements WHERE user_id = $1`,
      [req.user.id]
    );

    const entitlements = result.rows.map(row => entitlementStatus(row));
    const active = entitlements.filter(row => row.active);
    const premium = owner || active.some(row => row.feature === 'premium');
    const premiumRow = active.find(row => row.feature === 'premium');

    res.json({
      userId: req.user.id,
      role: owner ? 'owner' : 'customer',
      owner,
      premium,
      plan: owner ? 'owner'
        : !premium ? 'free'
        : premiumRow.accessType === 'lifetime' ? 'lifetime'
        : 'subscription',
      daysRemaining: owner || premiumRow?.accessType === 'lifetime'
        ? null : (premiumRow?.daysRemaining ?? 0),
      expiresAt: owner ? null : (premiumRow?.expires_at ?? null),
      features: {
        processing_methods: true,
        uploads: true,
        anime_in_app: premium,
        torrent_downloader: premium,
        premium_tools: premium
      },
      entitlements: owner
        ? [{
            feature: 'premium',
            active: true,
            accessType: 'owner',
            daysRemaining: null,
            expires_at: null
          }]
        : active
    });
  } catch (error) {
    next(error);
  }
});

// Subscription creation. Prices and plan IDs remain server-side.
app.post('/api/v1/paypal/subscription', getUser, async (req, res, next) => {
  try {
    const plan = req.body?.plan;
    const planId = plan === 'monthly'
      ? process.env.PAYPAL_PLAN_MONTHLY_ID
      : plan === 'yearly'
        ? process.env.PAYPAL_PLAN_YEARLY_ID
        : null;

    if (!planId) throw httpError(400, 'Plan is not configured');

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

    const approvalUrl = result.links?.find(link => link.rel === 'approve')?.href;
    if (!approvalUrl || !result.id) {
      throw httpError(502, 'PayPal did not return an approval URL');
    }

    await pool.query(
      `INSERT INTO paypal_subscriptions
         (paypal_subscription_id, user_id, plan, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (paypal_subscription_id) DO NOTHING`,
      [result.id, req.user.id, plan, result.status || 'APPROVAL_PENDING']
    );

    res.json({ subscriptionId: result.id, approvalUrl });
  } catch (error) {
    next(error);
  }
});

// Lifetime checkout.
app.post('/api/v1/paypal/lifetime/order', getUser, async (req, res, next) => {
  try {
    const price = process.env.PAYPAL_LIFETIME_PRICE_USD;

    if (!price || !/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
      throw httpError(503, 'Lifetime price is not configured');
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
          amount: {
            currency_code: 'USD',
            value: Number(price).toFixed(2)
          }
        }],
        application_context: {
          brand_name: "TAY'S STUDIO",
          user_action: 'PAY_NOW',
          return_url: `${process.env.APP_BASE_URL}/payment/success`,
          cancel_url: `${process.env.APP_BASE_URL}/payment/cancel`
        }
      })
    });

    const approvalUrl = order.links?.find(link => link.rel === 'approve')?.href;
    if (!approvalUrl) throw httpError(502, 'PayPal approval URL missing');

    res.json({ orderId: order.id, approvalUrl });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/paypal/lifetime/capture', getUser, async (req, res, next) => {
  try {
    const orderId = String(req.body?.orderId || '');
    if (!/^[A-Z0-9-]{8,64}$/i.test(orderId)) {
      throw httpError(400, 'Invalid orderId');
    }

    const price = process.env.PAYPAL_LIFETIME_PRICE_USD;
    if (!price || !/^\d+(\.\d{1,2})?$/.test(price)) {
      throw httpError(503, 'Lifetime price is not configured');
    }

    const order = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: 'POST',
        headers: { 'PayPal-Request-Id': crypto.randomUUID() },
        body: '{}'
      }
    );

    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];

    if (
      order.status !== 'COMPLETED' ||
      capture?.status !== 'COMPLETED' ||
      unit?.custom_id !== req.user.id ||
      capture?.amount?.currency_code !== 'USD' ||
      capture?.amount?.value !== Number(price).toFixed(2)
    ) {
      throw httpError(409, 'Payment not verified');
    }

    // A completed order must not be granted to a different account.
    const externalId = `paypal-order:${order.id}`;
    const existing = await pool.query(
      `SELECT user_id FROM user_entitlements
       WHERE feature = 'premium' AND external_id = $1`,
      [externalId]
    );

    if (existing.rows.length && existing.rows[0].user_id !== req.user.id) {
      throw httpError(409, 'Order already associated with another account');
    }

    await setEntitlement(req.user.id, 'premium', true, {
      source: 'paypal_lifetime',
      external_id: externalId
    });

    res.json({ ok: true, premium: true });
  } catch (error) {
    next(error);
  }
});

// Webhooks are signature-verified with PayPal before processing.
// Subscription events use the local subscription mapping.
app.post('/api/v1/paypal/webhook', async (req, res, next) => {
  try {
    if (!process.env.PAYPAL_WEBHOOK_ID) {
      throw httpError(503, 'Webhook ID is not configured');
    }

    const event = req.body;
    if (!event || typeof event !== 'object') {
      throw httpError(400, 'Invalid webhook body');
    }

    const headers = req.headers;
    const verification = await paypalRequest(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: JSON.stringify({
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: process.env.PAYPAL_WEBHOOK_ID,
          webhook_event: event
        })
      }
    );

    if (verification.verification_status !== 'SUCCESS') {
      throw httpError(400, 'Invalid webhook signature');
    }

    if (!event.id || !event.event_type) {
      throw httpError(400, 'Missing webhook event identity');
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO paypal_events (event_id, event_type)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event.id, event.event_type]
      );

      // Already processed: return success so PayPal doesn't retry forever.
      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return res.json({ received: true, duplicate: true });
      }

      const resource = event.resource || {};
      const subscriptionId = resource.id;

      const subscriptionEvents = {
        'BILLING.SUBSCRIPTION.ACTIVATED': 'active',
        'BILLING.SUBSCRIPTION.UPDATED': 'active',
        'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled',
        'BILLING.SUBSCRIPTION.EXPIRED': 'expired',
        'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended'
      };

      const mappedStatus = subscriptionEvents[event.event_type];

      if (mappedStatus && subscriptionId) {
        const mapped = await client.query(
          `UPDATE paypal_subscriptions
           SET status = $2, updated_at = NOW()
           WHERE paypal_subscription_id = $1
           RETURNING user_id`,
          [subscriptionId, mappedStatus]
        );

        if (mapped.rowCount) {
          const userId = mapped.rows[0].user_id;

          if (mappedStatus === 'active') {
            // Subscription is active, but activation alone does not prove
            // a successful billing cycle. Payment events should be reconciled.
            await client.query(
              `INSERT INTO user_entitlements
                 (user_id, feature, active, source, external_id, updated_at)
               VALUES ($1, 'premium', TRUE, 'paypal_subscription', $2, NOW())
               ON CONFLICT (user_id, feature)
               DO UPDATE SET active = TRUE,
                 source = 'paypal_subscription',
                 external_id = EXCLUDED.external_id,
                 updated_at = NOW()`,
              [userId, subscriptionId]
            );
          } else {
            await client.query(
              `UPDATE user_entitlements
               SET active = FALSE, updated_at = NOW()
               WHERE user_id = $1 AND feature = 'premium'
                 AND source = 'paypal_subscription'
                 AND external_id = $2`,
              [userId, subscriptionId]
            );
          }
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/torrent/policy', getUser, async (req, res, next) => {
  try {
    const premium = await hasPremium(req.user);

    const maxBytesPerDownload = Number(
      premium
        ? process.env.PREMIUM_TORRENT_MAX_BYTES || 104857600
        : process.env.FREE_TORRENT_MAX_BYTES || 10485760
    );

    res.json({
      premium,
      maxBytesPerDownload,
      unit: 'bytes',
      note: 'Per-download policy; the downloader must enforce the limit.'
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;

  if (status >= 500) {
    console.error(error.message);
  }

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : error.message
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`TAY'S STUDIO backend listening on ${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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

const paypalBase = String(process.env.PAYPAL_MODE || '').trim().toLowerCase() === 'live'
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
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.disable('x-powered-by');

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      allowedOrigins.length === 0 ||
      allowedOrigins.includes(origin)
    ) {
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

// Railway variables are often pasted with stray spaces, quotes or newlines.
function env(name) {
  return String(process.env[name] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/*
 * Owner is assigned only by the server, from the private OWNER_EMAIL variable.
 * Email verification is not implemented yet, so requiring email_verified_at
 * made it impossible for the owner to ever be recognised. Set
 * OWNER_REQUIRE_VERIFIED=true once verification exists to restore that check.
 */
function isOwner(user) {
  const ownerEmail = normalizeEmail(env('OWNER_EMAIL'));

  if (!ownerEmail || !user) return false;
  if (normalizeEmail(user.email) !== ownerEmail) return false;

  return env('OWNER_REQUIRE_VERIFIED') === 'true'
    ? Boolean(user.email_verified_at)
    : true;
}

function safeUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: isOwner(row) ? 'owner' : 'customer',
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

function validMoney(value) {
  return typeof value === 'string' &&
    /^\d+(\.\d{1,2})?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0;
}

function configuredLifetimePrice() {
  const price = process.env.PAYPAL_LIFETIME_PRICE_USD;

  if (!validMoney(price)) {
    throw httpError(503, 'Lifetime price is not configured');
  }

  return Number(price).toFixed(2);
}

function planPrice(name, fallback) {
  const value = env(name);
  return validMoney(value) ? Number(value).toFixed(2) : fallback;
}

function configuredSubscriptionPlan(plan) {
  if (plan === 'monthly') {
    return {
      id: env('PAYPAL_PLAN_MONTHLY_ID'),
      price: planPrice('PAYPAL_PLAN_MONTHLY_PRICE_USD', '2.99'),
      intervalDays: 31
    };
  }

  if (plan === 'yearly') {
    return {
      id: env('PAYPAL_PLAN_YEARLY_ID'),
      price: planPrice('PAYPAL_PLAN_YEARLY_PRICE_USD', '29.99'),
      intervalDays: 366
    };
  }

  return null;
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

    const tokenHash = hashToken(token);

    const result = await pool.query(
      `SELECT u.id, u.email, u.email_verified_at, u.created_at
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );

    if (!result.rows.length) {
      throw httpError(401, 'Invalid or expired session');
    }

    req.user = result.rows[0];

    await pool.query(
      `UPDATE app_sessions
       SET last_used_at = NOW()
       WHERE token_hash = $1`,
      [tokenHash]
    );

    next();
  } catch (error) {
    next(error);
  }
}

async function createSession(user, req) {
  const token = crypto.randomBytes(48).toString('base64url');
  const tokenHash = hashToken(token);

  const configuredDays = Number(process.env.SESSION_TTL_DAYS || 30);

  const days = Number.isFinite(configuredDays)
    ? Math.min(30, Math.max(1, Math.floor(configuredDays)))
    : 30;

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
  if (!env('PAYPAL_CLIENT_ID') || !env('PAYPAL_CLIENT_SECRET')) {
    throw httpError(503, 'PayPal is not configured');
  }

  const credentials = Buffer.from(
    `${env('PAYPAL_CLIENT_ID')}:${env('PAYPAL_CLIENT_SECRET')}`
  ).toString('base64');

  const response = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000)
  }).catch(error => {
    console.error('PayPal network error:', error?.name || 'error');
    throw Object.assign(httpError(502, 'PayPal is unreachable'), {
      code: 'paypal_unreachable'
    });
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    console.error('PayPal OAuth failed:', response.status);
    throw Object.assign(
      httpError(502, 'Could not authenticate with PayPal'),
      { code: 'paypal_credentials' } // wrong client id/secret or wrong mode
    );
  }

  return body.access_token;
}

function paypalErrorCode(status, name, issue) {
  const text = `${name || ''} ${issue || ''}`.toUpperCase();

  if (status === 404 || text.includes('RESOURCE_NOT_FOUND')) {
    return 'plan_not_found'; // wrong plan id, or sandbox/live mismatch
  }

  if (text.includes('PLAN_NOT_ACTIVE') || text.includes('INACTIVE')) {
    return 'plan_inactive';
  }

  if (status === 401 || status === 403 || text.includes('NOT_AUTHORIZED')) {
    return 'paypal_not_authorized'; // Subscriptions not enabled on the app
  }

  if (status === 422 || status === 400) {
    return 'paypal_rejected';
  }

  return 'paypal_error';
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
  }).catch(error => {
    console.error('PayPal network error:', error?.name || 'error');
    throw Object.assign(httpError(502, 'PayPal is unreachable'), {
      code: 'paypal_unreachable'
    });
  });

  const body = response.status === 204
    ? null
    : await response.json().catch(() => ({}));

  if (!response.ok) {
    // Log PayPal's own error name/issue (never credentials) so the cause
    // shows up in Railway logs instead of a bare "502".
    const issue = body?.details?.[0]?.issue || null;

    console.error(
      'PayPal API error:',
      response.status,
      path.split('?')[0].replace(/\/[A-Z0-9-]{10,}/gi, '/:id'),
      body?.name || '',
      issue || '',
      body?.debug_id ? `debug_id=${body.debug_id}` : ''
    );

    throw Object.assign(httpError(502, 'PayPal request failed'), {
      code: paypalErrorCode(response.status, body?.name, issue),
      paypal: {
        status: response.status,
        name: body?.name || null,
        issue,
        debugId: body?.debug_id || null
      }
    });
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
    `SELECT 1
     FROM user_entitlements
     WHERE user_id = $1
       AND feature = 'premium'
       AND active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [user.id]
  );

  return result.rowCount > 0;
}

/*
 * Health
 */

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      service: 'tay-studio-backend',
      version: '0.3.1',
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

/*
 * Plans
 */

app.get('/api/v1/plans', (_req, res) => {
  res.json({
    currency: 'USD',
    plans: [
      {
        id: 'monthly',
        type: 'subscription',
        label: 'Premium Monthly',
        configured: Boolean(env('PAYPAL_PLAN_MONTHLY_ID'))
      },
      {
        id: 'yearly',
        type: 'subscription',
        label: 'Premium Yearly',
        configured: Boolean(env('PAYPAL_PLAN_YEARLY_ID'))
      },
      {
        id: 'lifetime',
        type: 'one_time',
        label: 'Premium Lifetime',
        configured: validMoney(
          process.env.PAYPAL_LIFETIME_PRICE_USD
        )
      }
    ]
  });
});

/*
 * Authentication
 */

app.post('/api/v1/auth/register', async (req, res, next) => {
  try {
    requireConfig();

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254
    ) {
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
       FROM app_users
       WHERE lower(email) = $1
       LIMIT 1`,
      [email]
    );

    const user = result.rows[0];

    const valid = user
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    if (!valid) {
      throw httpError(401, 'Invalid email or password');
    }

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
    const token = req.headers.authorization
      .replace(/^Bearer\s+/i, '')
      .trim();

    await pool.query(
      `UPDATE app_sessions
       SET revoked_at = NOW()
       WHERE token_hash = $1
         AND revoked_at IS NULL`,
      [hashToken(token)]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/*
 * Current user
 */

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
       FROM user_entitlements
       WHERE user_id = $1`,
      [req.user.id]
    );

    const entitlements = result.rows.map(row => entitlementStatus(row));
    const active = entitlements.filter(row => row.active);

    const premium = owner ||
      active.some(row => row.feature === 'premium');

    const premiumRow = active.find(row => row.feature === 'premium');

    res.json({
      userId: req.user.id,
      role: owner ? 'owner' : 'customer',
      owner,
      premium,
      plan: owner
        ? 'owner'
        : !premium
          ? 'free'
          : premiumRow.accessType === 'lifetime'
            ? 'lifetime'
            : 'subscription',
      daysRemaining: owner || premiumRow?.accessType === 'lifetime'
        ? null
        : (premiumRow?.daysRemaining ?? 0),
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

/*
 * PayPal subscription checkout
 */

app.post('/api/v1/paypal/subscription', getUser, async (req, res, next) => {
  try {
    const plan = String(req.body?.plan || '');
    const configuredPlan = configuredSubscriptionPlan(plan);

    if (!configuredPlan) {
      throw httpError(400, 'Unknown plan');
    }

    if (!configuredPlan.id) {
      throw Object.assign(
        httpError(503, 'Plan is not configured on the server'),
        { code: 'plan_not_configured' }
      );
    }

    if (!/^https?:\/\//i.test(env('APP_BASE_URL'))) {
      throw Object.assign(
        httpError(503, 'APP_BASE_URL is not configured'),
        { code: 'app_base_url_missing' }
      );
    }

    const result = await paypalRequest('/v1/billing/subscriptions', {
      method: 'POST',
      headers: {
        'PayPal-Request-Id': crypto.randomUUID(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        plan_id: configuredPlan.id,
        custom_id: req.user.id,
        application_context: {
          brand_name: "TAY'S STUDIO",
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${env('APP_BASE_URL').replace(/\/+$/, '')}/payment/success`,
          cancel_url: `${env('APP_BASE_URL').replace(/\/+$/, '')}/payment/cancel`
        }
      })
    });

    const approvalUrl = result.links?.find(
      link => link.rel === 'approve'
    )?.href;

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

    res.json({
      subscriptionId: result.id,
      approvalUrl
    });
  } catch (error) {
    next(error);
  }
});

/*
 * Lifetime promo code. Checked only here (never in the app).
 *   LIFETIME_PROMO_CODE     default TAY'S-LAUNCH31 (case, spaces, hyphens and apostrophes are ignored)
 *   LIFETIME_PROMO_PRICE_USD exact price with the code (e.g. 19.99); wins over the percent
 *   LIFETIME_PROMO_PERCENT  discount in percent, 1-90 (default 20)
 *   LIFETIME_PROMO_ENABLED  set to false (or 0 / off / no) to switch the code off; unset or anything else = on
 *   LIFETIME_PROMO_UNTIL    optional ISO date; after it the code stops working
 */
const promoKey = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function lifetimePromo(code, { ignoreSwitch = false } = {}) {
  if (!ignoreSwitch && ['false', '0', 'off', 'no'].includes(String(process.env.LIFETIME_PROMO_ENABLED || '').trim().toLowerCase())) return null;
  const configured = process.env.LIFETIME_PROMO_CODE || "TAY'S-LAUNCH31";
  if (!code || promoKey(code) !== promoKey(configured)) return null;
  const until = process.env.LIFETIME_PROMO_UNTIL;
  if (!ignoreSwitch && until && !(Date.now() <= Date.parse(until))) return null;
  const pct = Math.min(90, Math.max(1, Number(process.env.LIFETIME_PROMO_PERCENT) || 20));
  const full = Number(configuredLifetimePrice());
  const fixed = process.env.LIFETIME_PROMO_PRICE_USD;
  if (validMoney(fixed) && Number(fixed) < full) {
    return { percent: Math.round((1 - Number(fixed) / full) * 100), price: Number(fixed).toFixed(2), full: full.toFixed(2) };
  }
  return { percent: pct, price: (Math.round(full * (100 - pct)) / 100).toFixed(2), full: full.toFixed(2) };
}

app.post('/api/v1/promo/lifetime', getUser, (req, res, next) => {
  try {
    const promo = lifetimePromo(req.body?.code);
    res.json(promo ? { valid: true, ...promo } : { valid: false });
  } catch (error) {
    next(error);
  }
});

/*
 * PayPal Lifetime order creation
 */

app.post('/api/v1/paypal/lifetime/order', getUser, async (req, res, next) => {
  try {
    const promo = req.body?.promo ? lifetimePromo(req.body.promo) : null;
    if (req.body?.promo && !promo) throw httpError(400, 'Invalid promo code');
    const price = promo ? promo.price : configuredLifetimePrice();

    const order = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'PayPal-Request-Id': crypto.randomUUID()
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: 'tay-studio-lifetime',
          custom_id: req.user.id,
          description: "TAY'S STUDIO Premium Lifetime",
          amount: {
            currency_code: 'USD',
            value: price
          }
        }],
        application_context: {
          brand_name: "TAY'S STUDIO",
          user_action: 'PAY_NOW',
          return_url: `${env('APP_BASE_URL').replace(/\/+$/, '')}/payment/success`,
          cancel_url: `${env('APP_BASE_URL').replace(/\/+$/, '')}/payment/cancel`
        }
      })
    });

    const approvalUrl = order.links?.find(
      link => link.rel === 'approve'
    )?.href;

    if (!order.id || !approvalUrl) {
      throw httpError(502, 'PayPal approval URL missing');
    }

    res.json({
      orderId: order.id,
      approvalUrl
    });
  } catch (error) {
    next(error);
  }
});

/*
 * Lifetime capture
 *
 * Verify the order and capture with PayPal.
 * The database transaction prevents a capture from being granted
 * to another user and ensures the payment and entitlement are recorded
 * together.
 */

app.post('/api/v1/paypal/lifetime/capture', getUser, async (req, res, next) => {
  let client;

  try {
    const orderId = String(req.body?.orderId || '');

    if (!/^[A-Z0-9-]{8,64}$/i.test(orderId)) {
      throw httpError(400, 'Invalid orderId');
    }

    const fullPrice = configuredLifetimePrice();
    const promoPrice = lifetimePromo(process.env.LIFETIME_PROMO_CODE || "TAY'S-LAUNCH31", { ignoreSwitch: true })?.price;

    // Read the order first, so retries do not blindly recapture it.
    let order = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      { method: 'GET' }
    );

    if (order.status !== 'COMPLETED') {
      if (order.status !== 'APPROVED') {
        throw httpError(409, 'Order is not approved for capture');
      }

      order = await paypalRequest(
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        {
          method: 'POST',
          headers: {
            'PayPal-Request-Id': `tay-lifetime-${orderId}`
          },
          body: '{}'
        }
      );
    }

    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];

    if (
      order.status !== 'COMPLETED' ||
      capture?.status !== 'COMPLETED' ||
      String(unit?.custom_id || '') !== String(req.user.id) ||
      unit?.reference_id !== 'tay-studio-lifetime' ||
      capture?.amount?.currency_code !== 'USD' ||
      ![fullPrice, promoPrice].includes(capture?.amount?.value) ||
      !capture?.id
    ) {
      throw httpError(409, 'Payment not verified');
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO paypal_payments
         (paypal_capture_id, user_id, payment_type,
          amount, currency, status, event_id)
       VALUES ($1, $2, 'lifetime', $3, 'USD', 'completed', $4)
       ON CONFLICT (paypal_capture_id) DO NOTHING
       RETURNING paypal_capture_id`,
      [
        capture.id,
        req.user.id,
        capture.amount.value,
        `capture:${capture.id}`
      ]
    );

    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT user_id, payment_type, status
         FROM paypal_payments
         WHERE paypal_capture_id = $1`,
        [capture.id]
      );

      const payment = existing.rows[0];

      if (
        !payment ||
        String(payment.user_id) !== String(req.user.id) ||
        payment.payment_type !== 'lifetime' ||
        payment.status !== 'completed'
      ) {
        throw httpError(409, 'Payment already processed');
      }

      await client.query('COMMIT');

      return res.json({
        ok: true,
        premium: true,
        duplicate: true
      });
    }

    // Do not overwrite an existing Lifetime entitlement with a subscription.
    const current = await client.query(
      `SELECT source, active, expires_at
       FROM user_entitlements
       WHERE user_id = $1 AND feature = 'premium'
       FOR UPDATE`,
      [req.user.id]
    );

    const currentEntitlement = current.rows[0];

    if (
      currentEntitlement?.source === 'paypal_lifetime' &&
      currentEntitlement.active
    ) {
      await client.query('COMMIT');

      return res.json({
        ok: true,
        premium: true,
        alreadyLifetime: true
      });
    }

    await client.query(
      `INSERT INTO user_entitlements
         (user_id, feature, active, source, expires_at, external_id, updated_at)
       VALUES ($1, 'premium', TRUE, 'paypal_lifetime', NULL, $2, NOW())
       ON CONFLICT (user_id, feature)
       DO UPDATE SET
         active = TRUE,
         source = 'paypal_lifetime',
         expires_at = NULL,
         external_id = EXCLUDED.external_id,
         updated_at = NOW()`,
      [req.user.id, `paypal-capture:${capture.id}`]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      premium: true
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }

    next(error);
  } finally {
    client?.release();
  }
});

/*
 * PayPal webhook signature verification
 */

async function verifyPayPalWebhook(event, headers) {
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    throw httpError(503, 'Webhook ID is not configured');
  }

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
}

async function processSubscriptionPayment(client, resource, eventId) {
  const subscriptionId = resource.billing_agreement_id;

  if (!subscriptionId || !resource.id) {
    return;
  }

  // Only accept payments for subscriptions created by this backend.
  const mapping = await client.query(
    `SELECT user_id, plan, status
     FROM paypal_subscriptions
     WHERE paypal_subscription_id = $1
     FOR UPDATE`,
    [subscriptionId]
  );

  if (!mapping.rowCount) {
    console.warn('Ignoring payment for an unmapped PayPal subscription');
    return;
  }

  const subscription = mapping.rows[0];

  if (
    resource.state &&
    resource.state !== 'completed'
  ) {
    return;
  }

  const amount = resource.amount?.total;
  const currency = resource.amount?.currency;

  if (
    currency !== 'USD' ||
    !validMoney(String(amount || ''))
  ) {
    throw httpError(400, 'Invalid subscription payment amount');
  }

  const plan = configuredSubscriptionPlan(subscription.plan);

  if (!plan || Number(amount).toFixed(2) !== plan.price) {
    throw httpError(400, 'Subscription payment amount mismatch');
  }

  // Fetch PayPal's subscription record for its next billing date.
  const remote = await paypalRequest(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'GET' }
  );

  if (
    String(remote.custom_id || '') !== String(subscription.user_id)
  ) {
    throw httpError(409, 'Subscription account mismatch');
  }

  let expiresAt = remote.billing_info?.next_billing_time
    ? new Date(remote.billing_info.next_billing_time)
    : new Date(Date.now() + plan.intervalDays * 86400000);

  if (!Number.isFinite(expiresAt.getTime())) {
    expiresAt = new Date(Date.now() + plan.intervalDays * 86400000);
  }

  const paymentInsert = await client.query(
    `INSERT INTO paypal_payments
       (paypal_capture_id, user_id, payment_type,
        paypal_subscription_id, amount, currency, status, event_id)
     VALUES ($1, $2, 'subscription', $3, $4, 'USD', 'completed', $5)
     ON CONFLICT (paypal_capture_id) DO NOTHING
     RETURNING paypal_capture_id`,
    [
      resource.id,
      subscription.user_id,
      subscriptionId,
      Number(amount).toFixed(2),
      eventId
    ]
  );

  // A repeated sale must never extend the entitlement again.
  if (!paymentInsert.rowCount) {
    return;
  }

  await client.query(
    `UPDATE paypal_subscriptions
     SET status = 'active', updated_at = NOW()
     WHERE paypal_subscription_id = $1`,
    [subscriptionId]
  );

  // Lifetime access always takes precedence over subscription access.
  const current = await client.query(
    `SELECT source, active
     FROM user_entitlements
     WHERE user_id = $1 AND feature = 'premium'
     FOR UPDATE`,
    [subscription.user_id]
  );

  const currentEntitlement = current.rows[0];

  if (
    currentEntitlement?.source === 'paypal_lifetime' &&
    currentEntitlement.active
  ) {
    return;
  }

  await client.query(
    `INSERT INTO user_entitlements
       (user_id, feature, active, source, expires_at, external_id, updated_at)
     VALUES ($1, 'premium', TRUE, 'paypal_subscription', $2, $3, NOW())
     ON CONFLICT (user_id, feature)
     DO UPDATE SET
       active = TRUE,
       source = 'paypal_subscription',
       expires_at = GREATEST(
         COALESCE(user_entitlements.expires_at, EXCLUDED.expires_at),
         EXCLUDED.expires_at
       ),
       external_id = EXCLUDED.external_id,
       updated_at = NOW()
     WHERE user_entitlements.source <> 'paypal_lifetime'`,
    [subscription.user_id, expiresAt, subscriptionId]
  );
}

/*
 * PayPal webhooks
 *
 * Activation by itself does not grant Premium.
 * A completed subscription payment is required.
 */

app.post('/api/v1/paypal/webhook', async (req, res, next) => {
  let client;

  try {
    const event = req.body;

    if (!event || typeof event !== 'object') {
      throw httpError(400, 'Invalid webhook body');
    }

    await verifyPayPalWebhook(event, req.headers);

    if (!event.id || !event.event_type) {
      throw httpError(400, 'Missing webhook event identity');
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO paypal_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.event_type]
    );

    if (!inserted.rowCount) {
      await client.query('COMMIT');

      return res.json({
        received: true,
        duplicate: true
      });
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
      await client.query(
        `UPDATE paypal_subscriptions
         SET status = $2, updated_at = NOW()
         WHERE paypal_subscription_id = $1`,
        [subscriptionId, mappedStatus]
      );

      // Do not grant Premium merely because a subscription was activated.
      // Cancellation does not automatically remove already-paid access.
      if (mappedStatus === 'expired') {
        await client.query(
          `UPDATE user_entitlements
           SET active = FALSE, updated_at = NOW()
           WHERE feature = 'premium'
             AND source = 'paypal_subscription'
             AND external_id = $1
             AND expires_at <= NOW()`,
          [subscriptionId]
        );
      }
    }

    if (event.event_type === 'PAYMENT.SALE.COMPLETED') {
      await processSubscriptionPayment(client, resource, event.id);
    }

    if (
      event.event_type === 'PAYMENT.SALE.REFUNDED' ||
      event.event_type === 'PAYMENT.SALE.REVERSED'
    ) {
      const originalSaleId = resource.sale_id || resource.id;

      await client.query(
        `UPDATE paypal_payments
         SET status = $2, updated_at = NOW()
         WHERE paypal_capture_id = $1
           AND payment_type = 'subscription'`,
        [
          originalSaleId,
          event.event_type === 'PAYMENT.SALE.REFUNDED'
            ? 'refunded'
            : 'reversed'
        ]
      );

      // Revoke only the matching subscription entitlement, never Lifetime.
      const payment = await client.query(
        `SELECT paypal_subscription_id
         FROM paypal_payments
         WHERE paypal_capture_id = $1
           AND payment_type = 'subscription'`,
        [originalSaleId]
      );

      if (payment.rowCount) {
        const affectedSubscription = payment.rows[0].paypal_subscription_id;

        await client.query(
          `UPDATE user_entitlements
           SET active = FALSE, updated_at = NOW()
           WHERE feature = 'premium'
             AND source = 'paypal_subscription'
             AND external_id = $1`,
          [affectedSubscription]
        );
      }
    }

    await client.query('COMMIT');

    res.json({ received: true });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }

    next(error);
  } finally {
    client?.release();
  }
});

/*
 * Weekly usage limits (server-side, so they survive reinstalling the APK)
 *
 * Free users: topaz 10 / check 5 / download 5 per week. Premium and owner are
 * unlimited. The week starts on Monday 00:00 in USAGE_TZ.
 * Flow: the app calls /usage/consume BEFORE the job and /usage/refund if the
 * job fails, so a failed job never costs a use.
 */

const USAGE_FEATURES = {
  topaz: { env: 'FREE_WEEKLY_TOPAZ', fallback: 10 },
  check: { env: 'FREE_WEEKLY_CHECK', fallback: 5 },
  download: { env: 'FREE_WEEKLY_DOWNLOAD', fallback: 5 }
};

function usageTimezone() {
  return env('USAGE_TZ') || 'America/Costa_Rica';
}

function usageLimit(feature) {
  const cfg = USAGE_FEATURES[feature];
  const raw = env(cfg.env);
  const n = raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : cfg.fallback;
}

let usageSchemaReady = null;

function ensureUsageSchema() {
  usageSchemaReady ??= pool.query(
    `CREATE TABLE IF NOT EXISTS public.usage_counters (
       user_id UUID NOT NULL REFERENCES public.app_users(id)
         ON DELETE CASCADE,
       feature TEXT NOT NULL,
       week_start DATE NOT NULL,
       count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (user_id, feature, week_start)
     )`
  ).catch(error => {
    usageSchemaReady = null;
    throw error;
  });

  return usageSchemaReady;
}

async function currentWeek() {
  const r = await pool.query(
    `SELECT to_char(date_trunc('week', NOW() AT TIME ZONE $1), 'YYYY-MM-DD') AS week_start,
            ((date_trunc('week', NOW() AT TIME ZONE $1)
              + INTERVAL '7 days') AT TIME ZONE $1) AS resets_at`,
    [usageTimezone()]
  );

  return r.rows[0];
}

async function usageSnapshot(user) {
  await ensureUsageSchema();

  const unlimited = await hasPremium(user);
  const week = await currentWeek();

  const rows = await pool.query(
    `SELECT feature, count FROM usage_counters
     WHERE user_id = $1 AND week_start = $2`,
    [user.id, week.week_start]
  );

  const used = Object.fromEntries(rows.rows.map(r => [r.feature, r.count]));

  const features = {};

  for (const feature of Object.keys(USAGE_FEATURES)) {
    const limit = usageLimit(feature);
    const n = used[feature] || 0;

    features[feature] = unlimited
      ? { limit: null, used: n, remaining: null }
      : { limit, used: n, remaining: Math.max(0, limit - n) };
  }

  return {
    unlimited,
    weekStart: week.week_start,
    resetsAt: week.resets_at,
    timezone: usageTimezone(),
    features
  };
}


// ---------------------------------------------------------------------------------------------------------
// App integrity. The app sends the SHA-256 of the certificate it is signed with and its package name. A copy of the app
// that was rebuilt / re-signed by somebody else reports a different certificate. The answer decides whether the app locks itself.
//   APP_CERT_SHA256   comma-separated list of allowed certificate fingerprints (hex, with or without colons). Empty = nothing is checked.
//   APP_PACKAGE       allowed package name (default com.tgs.uploader)
//   INTEGRITY_ENFORCE 'true' turns the lock on. Anything else only logs mismatches (use it first to confirm your own builds pass).
// Fails open: no answer from the server never locks the app. This raises the cost of re-publishing the app; it cannot make copying impossible.
// ---------------------------------------------------------------------------------------------------------
const normHex = (v) => String(v || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
app.post('/api/v1/integrity', (req, res) => {
  const allowedCerts = String(process.env.APP_CERT_SHA256 || '').split(',').map(normHex).filter(Boolean);
  const allowedPkg = String(process.env.APP_PACKAGE || 'com.tgs.uploader').trim();
  const cert = normHex(req.body && req.body.cert);
  const pkg = String((req.body && req.body.pkg) || '').slice(0, 120);
  const certBad = allowedCerts.length > 0 && cert !== '' && !allowedCerts.includes(cert);
  const pkgBad = pkg !== '' && pkg !== allowedPkg;
  const mismatch = certBad || pkgBad;
  if (mismatch) {
    console.warn('[integrity] mismatch', { cert: cert.slice(0, 16), pkg, version: String((req.body && req.body.version) || '').slice(0, 20) });
  }
  res.json({ ok: !mismatch, lock: mismatch && process.env.INTEGRITY_ENFORCE === 'true' });
});

app.get('/api/v1/me/usage', getUser, async (req, res, next) => {
  try {
    res.json(await usageSnapshot(req.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/usage/consume', getUser, async (req, res, next) => {
  try {
    const feature = String(req.body?.feature || '');

    if (!USAGE_FEATURES[feature]) {
      throw httpError(400, 'Unknown feature');
    }

    await ensureUsageSchema();

    if (await hasPremium(req.user)) {
      return res.json({ ok: true, ...(await usageSnapshot(req.user)) });
    }

    const week = await currentWeek();
    const limit = usageLimit(feature);

    // Atomic: the row is only incremented while it is below the limit.
    const result = await pool.query(
      `INSERT INTO usage_counters (user_id, feature, week_start, count)
       SELECT $1, $2, $3, 1 WHERE $4 > 0
       ON CONFLICT (user_id, feature, week_start)
       DO UPDATE SET count = usage_counters.count + 1, updated_at = NOW()
       WHERE usage_counters.count < $4
       RETURNING count`,
      [req.user.id, feature, week.week_start, limit]
    );

    if (!result.rowCount) {
      const snapshot = await usageSnapshot(req.user);

      return res.status(429).json({
        error: 'Weekly free limit reached',
        code: 'limit_reached',
        ...snapshot
      });
    }

    res.json({ ok: true, ...(await usageSnapshot(req.user)) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/usage/refund', getUser, async (req, res, next) => {
  try {
    const feature = String(req.body?.feature || '');

    if (!USAGE_FEATURES[feature]) {
      throw httpError(400, 'Unknown feature');
    }

    await ensureUsageSchema();

    const week = await currentWeek();

    await pool.query(
      `UPDATE usage_counters
       SET count = GREATEST(0, count - 1), updated_at = NOW()
       WHERE user_id = $1 AND feature = $2 AND week_start = $3`,
      [req.user.id, feature, week.week_start]
    );

    res.json({ ok: true, ...(await usageSnapshot(req.user)) });
  } catch (error) {
    next(error);
  }
});

/*
 * Owner-only PayPal configuration check. Returns no secrets: it reports
 * whether the credentials work and whether each plan id exists and is ACTIVE
 * in the configured PAYPAL_MODE.
 */

app.get('/api/v1/admin/paypal-check', getUser, async (req, res, next) => {
  try {
    if (!isOwner(req.user)) throw httpError(403, 'Owner only');

    const out = {
      mode: String(env('PAYPAL_MODE')).toLowerCase() === 'live' ? 'live' : 'sandbox',
      appBaseUrlOk: /^https?:\/\//i.test(env('APP_BASE_URL')),
      lifetimePriceOk: validMoney(env('PAYPAL_LIFETIME_PRICE_USD')),
      webhookIdSet: Boolean(env('PAYPAL_WEBHOOK_ID')),
      credentials: false,
      plans: {}
    };

    try {
      await paypalAccessToken();
      out.credentials = true;
    } catch {
      return res.json(out);
    }

    for (const name of ['monthly', 'yearly']) {
      const plan = configuredSubscriptionPlan(name);

      if (!plan.id) {
        out.plans[name] = { configured: false };
        continue;
      }

      try {
        const remote = await paypalRequest(
          `/v1/billing/plans/${encodeURIComponent(plan.id)}`,
          { method: 'GET' }
        );

        const price = remote.billing_cycles
          ?.find(c => c.tenure_type === 'REGULAR')
          ?.pricing_scheme?.fixed_price?.value;

        out.plans[name] = {
          configured: true,
          found: true,
          status: remote.status,
          price: price ?? null,
          expectedPrice: plan.price,
          priceMatches: price === undefined ? null : price === plan.price
        };
      } catch (error) {
        out.plans[name] = {
          configured: true,
          found: false,
          code: error.code || 'paypal_error',
          paypal: error.paypal || null
        };
      }
    }

    res.json(out);
  } catch (error) {
    next(error);
  }
});

/*
 * Torrent policy
 */

app.get('/api/v1/torrent/policy', getUser, async (req, res, next) => {
  try {
    const premium = await hasPremium(req.user);

    const configuredLimit = Number(
      premium
        ? process.env.PREMIUM_TORRENT_MAX_BYTES || 104857600
        : process.env.FREE_TORRENT_MAX_BYTES || 10485760
    );

    const maxBytesPerDownload = Number.isSafeInteger(configuredLimit) &&
      configuredLimit > 0
      ? configuredLimit
      : premium ? 104857600 : 10485760;

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

/*
 * Error handling
 */

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;

  if (status >= 500) {
    console.error('Backend error:', error.message);
  }

  const body = {
    error: status >= 500 && !error.code
      ? 'Internal server error'
      : error.message
  };

  // Safe, non-secret diagnostics so the app can show a useful message.
  if (error.code) body.code = error.code;
  if (error.paypal) body.paypal = error.paypal;

  res.status(status).json(body);
});

/*
 * Server shutdown
 */

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`TAY'S STUDIO backend listening on ${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

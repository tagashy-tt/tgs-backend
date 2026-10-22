-- TAY'S STUDIO — Railway PostgreSQL
-- No Supabase dependencies.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Application users
CREATE TABLE IF NOT EXISTS public.app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer', 'owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(email)) > 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_unique
  ON public.app_users (lower(email));

-- Sessions: store a hash of each random bearer token, never the raw token.
CREATE TABLE IF NOT EXISTS public.app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.app_users(id)
    ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address INET
);

CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx
  ON public.app_sessions (user_id);

CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx
  ON public.app_sessions (expires_at);

-- Premium and other feature entitlements
CREATE TABLE IF NOT EXISTS public.user_entitlements (
  user_id UUID NOT NULL REFERENCES public.app_users(id)
    ON DELETE CASCADE,
  feature TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'manual',
  expires_at TIMESTAMPTZ,
  external_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, feature)
);

CREATE INDEX IF NOT EXISTS user_entitlements_active_idx
  ON public.user_entitlements (user_id, active);

-- PayPal subscription mapping
CREATE TABLE IF NOT EXISTS public.paypal_subscriptions (
  paypal_subscription_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.app_users(id)
    ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'yearly')),
  status TEXT NOT NULL DEFAULT 'APPROVAL_PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paypal_subscriptions_user_id_idx
  ON public.paypal_subscriptions (user_id);

-- Idempotency ledger for PayPal webhook events
CREATE TABLE IF NOT EXISTS public.paypal_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

Important security notes

- "password_hash" must contain a strong password hash produced by the backend, for example Argon2id. Never store plaintext passwords.
- Generate session tokens with a cryptographically secure random generator and store only their SHA-256 hash in "token_hash".
- Configure "OWNER_EMAIL" as a private Railway variable. Owner privileges must be assigned by the server, never by the APK or public registration.
- Verify PayPal webhook signatures before processing events or granting Premium.
- Back up the database before applying schema changes. This script creates the new tables; it does not migrate existing Supabase users or subscriptions.

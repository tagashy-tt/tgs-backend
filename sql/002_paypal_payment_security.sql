
BEGIN;

-- One record per verified PayPal payment.
-- PayPal transaction IDs must be unique to prevent reuse.
CREATE TABLE IF NOT EXISTS public.paypal_payments (
  paypal_capture_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.app_users(id)
    ON DELETE RESTRICT,
  payment_type TEXT NOT NULL
    CHECK (payment_type IN ('lifetime', 'subscription')),
  paypal_subscription_id TEXT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  status TEXT NOT NULL
    CHECK (status IN ('completed', 'refunded', 'reversed')),
  event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paypal_payments_user_type_idx
  ON public.paypal_payments (user_id, payment_type);

CREATE INDEX IF NOT EXISTS paypal_payments_subscription_idx
  ON public.paypal_payments (paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

COMMIT;

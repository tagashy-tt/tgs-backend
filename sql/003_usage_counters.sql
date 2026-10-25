BEGIN;

-- Weekly free-tier usage (topaz / check / download). The backend also creates
-- this table on first use; running this file is optional.
CREATE TABLE IF NOT EXISTS public.usage_counters (
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  week_start DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, feature, week_start)
);

COMMIT;

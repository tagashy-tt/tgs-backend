-- Run in the Supabase SQL editor. Auth users are managed by Supabase Auth.
create table if not exists public.user_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null,
  active boolean not null default false,
  source text not null default 'manual',
  expires_at timestamptz null,
  external_id text null,
  updated_at timestamptz not null default now(),
  primary key (user_id, feature)
);

create table if not exists public.paypal_subscriptions (
  paypal_subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('monthly', 'yearly')),
  status text not null default 'APPROVAL_PENDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.paypal_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.user_entitlements enable row level security;
alter table public.paypal_subscriptions enable row level security;
alter table public.paypal_events enable row level security;

-- No client policies are added: all writes/reads are performed by the server service role.
-- Never expose SUPABASE_SERVICE_ROLE_KEY to the APK or browser.

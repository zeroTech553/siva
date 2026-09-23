-- Machines: which paired laptops belong to which account.
--
-- The relay remains the source of truth for device credentials; this table
-- only maps auth.users -> devices so a signed-in user's machines follow them
-- to any browser. phone_secret is the device-scoped credential minted at
-- pairing time — it never leaves the owner's rows thanks to RLS.
--
-- Apply with: supabase db push   (or paste into the SQL editor)

create table if not exists public.machines (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_id    uuid not null,
  phone_secret text not null,
  name         text not null default 'Laptop',
  platform     text not null default 'unknown',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,

  unique (user_id, device_id)
);

comment on table public.machines is
  'Paired laptops per account. The relay owns device state; this is the account mapping.';

alter table public.machines enable row level security;

-- Owners read their own machines.
create policy "machines are visible to their owner"
  on public.machines for select
  using ((select auth.uid()) = user_id);

-- Owners add machines for themselves only.
create policy "machines are added by their owner"
  on public.machines for insert
  with check ((select auth.uid()) = user_id);

-- Owners rename / touch their own machines.
create policy "machines are updated by their owner"
  on public.machines for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Owners remove their own machines.
create policy "machines are removed by their owner"
  on public.machines for delete
  using ((select auth.uid()) = user_id);

create index if not exists machines_user_id_idx on public.machines (user_id);

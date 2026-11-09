-- Run once in the same database as MST user_data. No public calendar data policies.
create table if not exists public.calendar_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  timezone text not null default 'Asia/Shanghai',
  updated_at timestamptz not null default now()
);
alter table public.calendar_subscriptions enable row level security;
revoke all on public.calendar_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.calendar_subscriptions to authenticated;
grant all on public.calendar_subscriptions to service_role;
drop policy if exists calendar_subscription_owner on public.calendar_subscriptions;
create policy calendar_subscription_owner on public.calendar_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop trigger if exists trg_calendar_subscription_updated_at on public.calendar_subscriptions;
create trigger trg_calendar_subscription_updated_at before insert or update
  on public.calendar_subscriptions for each row execute function public.set_row_updated_at();

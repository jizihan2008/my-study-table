begin;

create table if not exists public.calendar_custom_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  timezone text not null default 'Asia/Shanghai',
  include_events boolean not null default false,
  categories text[] not null default '{}',
  include_todo_due boolean not null default false,
  unique (user_id, name),
  check (cardinality(categories) <= 100 and array_position(categories, null) is null),
  check (coalesce(array_ndims(categories), 1) = 1),
  check (include_events or cardinality(categories) > 0 or include_todo_due)
);
alter table public.calendar_custom_subscriptions enable row level security;
revoke all on public.calendar_custom_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_custom_subscriptions to authenticated;
grant select on public.calendar_custom_subscriptions to service_role;
drop policy if exists calendar_custom_subscription_owner on public.calendar_custom_subscriptions;
create policy calendar_custom_subscription_owner on public.calendar_custom_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

notify pgrst, 'reload schema';
commit;

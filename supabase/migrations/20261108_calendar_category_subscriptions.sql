begin;

-- Separate from calendar_subscriptions so an older feed cannot read a category token as an all-events token.
create table if not exists public.calendar_category_subscriptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (char_length(category) between 1 and 40 and category = btrim(category)),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  timezone text not null default 'Asia/Shanghai',
  primary key (user_id, category)
);
alter table public.calendar_category_subscriptions enable row level security;
revoke all on public.calendar_category_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_category_subscriptions to authenticated;
grant select on public.calendar_category_subscriptions to service_role;
drop policy if exists calendar_category_subscription_owner on public.calendar_category_subscriptions;
create policy calendar_category_subscription_owner on public.calendar_category_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

notify pgrst, 'reload schema';
commit;

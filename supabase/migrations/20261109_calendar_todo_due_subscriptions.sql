begin;

create table if not exists public.calendar_todo_due_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  timezone text not null default 'Asia/Shanghai'
);
alter table public.calendar_todo_due_subscriptions enable row level security;
revoke all on public.calendar_todo_due_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_todo_due_subscriptions to authenticated;
grant select on public.calendar_todo_due_subscriptions to service_role;
drop policy if exists calendar_todo_due_subscription_owner on public.calendar_todo_due_subscriptions;
create policy calendar_todo_due_subscription_owner on public.calendar_todo_due_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

notify pgrst, 'reload schema';
commit;

-- ═══════════════════════════════════════════════════════════════════
-- My Study Table — 好友系统数据库 Schema（Supabase / PostgreSQL）
-- 使用方法：在 Supabase Dashboard → SQL Editor 中粘贴执行整个脚本。
-- 执行后还需：
--   1. Authentication → Providers → Email 关闭 "Confirm email"（可选，便于直接登录）
--   2. 复制 Project URL 与 anon public key 填入应用「设置 → 好友」面板
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. 用户资料 profiles
-- ─────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,                    -- 用户名（搜索/添加好友的唯一标识）
  nickname text not null default '',                -- 昵称
  avatar_url text not null default '',              -- 头像 URL
  bio text not null default '',                     -- 简介
  online_status text not null default 'offline',    -- online | offline
  last_seen timestamptz not null default now(),     -- 最近活跃时间
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ─────────────────────────────────────────────
-- 2. 好友分组 friend_groups
-- ─────────────────────────────────────────────
create table if not exists public.friend_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  color text not null default '#4f6ef7',
  created_at timestamptz not null default now()
);
alter table public.friend_groups enable row level security;

-- ─────────────────────────────────────────────
-- 3. 好友关系 friendships（user_id 为发起方 / friend_id 为接收方）
-- ─────────────────────────────────────────────
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',           -- pending | accepted
  group_id uuid references public.friend_groups(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_unique_pair unique (user_id, friend_id),
  constraint friendships_no_self check (user_id <> friend_id)
);
alter table public.friendships enable row level security;

-- ─────────────────────────────────────────────
-- 4. 聚合学习统计 study_stats（每日一行，仅聚合数据，不包含具体内容）
-- ─────────────────────────────────────────────
create table if not exists public.study_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  date date not null,
  checkin boolean not null default false,           -- 当日是否打卡
  focus_ms bigint not null default 0,               -- 当日专注时长（毫秒）
  todos_done int not null default 0,                -- 当日完成任务数
  habit_count int not null default 0,               -- 当日习惯打卡次数
  streak int not null default 0,                    -- 连续学习天数
  updated_at timestamptz not null default now(),
  constraint study_stats_unique_date unique (user_id, date)
);
alter table public.study_stats enable row level security;

-- ─────────────────────────────────────────────
-- 4b. 本周专注 Top5 待办 weekly_focus_todos（仅标题+时长聚合，供好友查看）
-- ─────────────────────────────────────────────
create table if not exists public.weekly_focus_todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,                        -- 本周周一日期
  todo_id bigint not null,                         -- 本地待办 id
  title text not null,                             -- 待办标题
  focus_ms bigint not null default 0,              -- 本周该待办专注毫秒
  updated_at timestamptz not null default now(),
  constraint weekly_focus_unique unique (user_id, week_start, todo_id)
);
alter table public.weekly_focus_todos enable row level security;

-- ─────────────────────────────────────────────
-- 5. 好友动态 activities
-- ─────────────────────────────────────────────
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,                               -- checkin | focus | todos_done | habit | streak
  content text not null,                            -- 动态文案
  meta jsonb not null default '{}'::jsonb,          -- 附加数据（如 {date, minutes}）
  created_at timestamptz not null default now()
);
create index if not exists activities_user_created_idx on public.activities (user_id, created_at desc);
alter table public.activities enable row level security;

-- ─────────────────────────────────────────────
-- 6. 会话 conversations（user_a < user_b 规范化顺序）
-- ─────────────────────────────────────────────
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_unique_pair unique (user_a, user_b)
);
alter table public.conversations enable row level security;

-- ─────────────────────────────────────────────
-- 7. 消息 messages
-- ─────────────────────────────────────────────
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists messages_conv_created_idx on public.messages (conversation_id, created_at);
alter table public.messages enable row level security;

-- ═══════════════════════════════════════════════════════════════════
-- RLS 辅助函数
-- ═══════════════════════════════════════════════════════════════════

-- 判断 target 是否为当前登录用户的好友
create or replace function public.is_friend(target uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.user_id = auth.uid() and f.friend_id = target)
        or (f.user_id = target and f.friend_id = auth.uid()))
  );
$$;

-- ═══════════════════════════════════════════════════════════════════
-- RLS 策略
-- ═══════════════════════════════════════════════════════════════════

-- profiles：仅「已登录」用户可读（未登录的陌生人看不到任何用户资料，防枚举隐私），本人可更新
-- 注：若需未登录也能看（如公开展示作者），改为 using (true) 即可；内置共享 anon key 时务必保持登录门槛。
drop policy if exists "profiles_readable" on public.profiles;
create policy "profiles_readable" on public.profiles
  for select using (auth.role() = 'authenticated');
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

-- profiles_public：未登录用户也能读的「最小公开视图」，仅暴露昵称/用户名，供插件市场展示作者名。
-- 不暴露头像URL、简介、在线状态、last_seen 等隐私字段；真正的敏感资料仍需登录后经 profiles 表读取。
-- 授权给 anon（未登录）与 authenticated（已登录）角色。
-- 注意：视图默认 security_definer（以 owner=postgres 权限读基表），这样才能让 anon 通过视图读到
-- 昵称/用户名（基表 profiles 的 RLS 对 anon 是拒绝的，若用 security_invoker 则 anon 读视图会空）。
drop view if exists public.profiles_public;
create view public.profiles_public as
  select id, nickname, username
  from public.profiles;
revoke all on public.profiles_public from anon, authenticated;
grant select on public.profiles_public to anon, authenticated;

-- friend_groups：仅本人
drop policy if exists "groups_self_all" on public.friend_groups;
create policy "groups_self_all" on public.friend_groups
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- friendships：双向相关方可见、可操作
drop policy if exists "friendships_readable" on public.friendships;
create policy "friendships_readable" on public.friendships
  for select using (auth.uid() = user_id or auth.uid() = friend_id);
drop policy if exists "friendships_insert" on public.friendships;
create policy "friendships_insert" on public.friendships
  for insert with check (auth.uid() = user_id);
drop policy if exists "friendships_update" on public.friendships;
create policy "friendships_update" on public.friendships
  for update using (auth.uid() = user_id or auth.uid() = friend_id)
  with check (auth.uid() = user_id or auth.uid() = friend_id);
drop policy if exists "friendships_delete" on public.friendships;
create policy "friendships_delete" on public.friendships
  for delete using (auth.uid() = user_id or auth.uid() = friend_id);

-- study_stats：本人可读写，好友可读
drop policy if exists "stats_readable" on public.study_stats;
create policy "stats_readable" on public.study_stats
  for select using (auth.uid() = user_id or public.is_friend(user_id));
drop policy if exists "stats_self_write" on public.study_stats;
create policy "stats_self_write" on public.study_stats
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- weekly_focus_todos：本人可读写，好友可读
drop policy if exists "weekly_todos_readable" on public.weekly_focus_todos;
create policy "weekly_todos_readable" on public.weekly_focus_todos
  for select using (auth.uid() = user_id or public.is_friend(user_id));
drop policy if exists "weekly_todos_self_write" on public.weekly_focus_todos;
create policy "weekly_todos_self_write" on public.weekly_focus_todos
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- activities：本人可写，本人与好友可读
drop policy if exists "activities_readable" on public.activities;
create policy "activities_readable" on public.activities
  for select using (auth.uid() = user_id or public.is_friend(user_id));
drop policy if exists "activities_self_write" on public.activities;
create policy "activities_self_write" on public.activities
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- conversations：参与者可读可写
drop policy if exists "conv_readable" on public.conversations;
create policy "conv_readable" on public.conversations
  for select using (auth.uid() = user_a or auth.uid() = user_b);
drop policy if exists "conv_insert" on public.conversations;
create policy "conv_insert" on public.conversations
  for insert with check (auth.uid() = user_a or auth.uid() = user_b);
drop policy if exists "conv_update" on public.conversations;
create policy "conv_update" on public.conversations
  for update using (auth.uid() = user_a or auth.uid() = user_b)
  with check (auth.uid() = user_a or auth.uid() = user_b);

-- 参与者只能触碰 updated_at；user_a/user_b 创建后不可变，避免把历史会话转交给第三人。
revoke update on table public.conversations from anon, authenticated;
grant update (updated_at) on table public.conversations to authenticated;

-- messages：会话参与者可读，发送者本人可写
drop policy if exists "messages_readable" on public.messages;
create policy "messages_readable" on public.messages
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );
drop policy if exists "messages_update" on public.messages;
create policy "messages_update" on public.messages
  for update using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

-- 消息身份与正文不可修改；参与者更新仅用于已读时间。
revoke update on table public.messages from anon, authenticated;
grant update (read_at) on table public.messages to authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- 授权 Data API 角色（anon / authenticated / service_role）
-- 若新建项目时关闭了 "Automatically expose new tables"，此段必不可少；
-- 若保持开启，重复 GRANT 也幂等无害。数据访问仍由上方 RLS 策略精确控制。
-- ═══════════════════════════════════════════════════════════════════
grant usage on schema public to anon, authenticated, service_role;
grant all on table public.profiles to anon, authenticated, service_role;
grant all on table public.friend_groups to anon, authenticated, service_role;
grant all on table public.friendships to anon, authenticated, service_role;
grant all on table public.study_stats to anon, authenticated, service_role;
grant all on table public.activities to anon, authenticated, service_role;
revoke all on table public.conversations from anon, authenticated;
grant select, insert on table public.conversations to authenticated;
grant update (updated_at) on table public.conversations to authenticated;
grant all on table public.conversations to service_role;
revoke all on table public.messages from anon, authenticated;
grant select, insert on table public.messages to authenticated;
grant update (read_at) on table public.messages to authenticated;
grant all on table public.messages to service_role;
revoke all on sequence public.messages_id_seq from anon;
grant usage, select on sequence public.messages_id_seq to authenticated;
grant all on sequence public.messages_id_seq to service_role;
grant all on table public.weekly_focus_todos to anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════
-- 触发器：注册用户后自动创建 profile（用户名从 user_metadata 提取）
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, nickname)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    coalesce(new.raw_user_meta_data->>'nickname', new.raw_user_meta_data->>'username', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══════════════════════════════════════════════════════════════════
-- 启用 Realtime（供动态流与聊天实时推送）
-- ═══════════════════════════════════════════════════════════════════
do $$ begin alter publication supabase_realtime add table public.activities; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.study_stats; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.weekly_focus_todos; exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════
-- 插件市场（v0.2.3）
-- ═══════════════════════════════════════════════════════════════════

-- 插件商店条目表
create table if not exists public.plugin_store_items (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid references public.profiles(id) on delete set null,
  author_name text not null default '',
  ext_id     text not null,                          -- 插件 id（manifest.id）
  name       text not null,
  type       text not null check (type in ('plugin','patch')),
  version    text not null default '1.0.0',
  description text not null default '',
  tags       text[] default '{}',                   -- 标签：["todo","notes","timer"]
  downloads  integer not null default 0,
  rating     real default 0,                        -- 平均评分 0~5
  status     text not null default 'pending' check (status in ('pending','approved','rejected')),
  file_path  text not null,                         -- Storage 路径
  file_sha256 text not null default '',             -- 安装前校验包完整性
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plugin_store_items add column if not exists file_sha256 text not null default '';

-- 索引
create index if not exists idx_plugin_store_status  on public.plugin_store_items (status);
create index if not exists idx_plugin_store_tags    on public.plugin_store_items using gin (tags);
create index if not exists idx_plugin_store_download on public.plugin_store_items (downloads desc);

-- 下载历史（记录谁下载了什么）
create table if not exists public.plugin_downloads (
  id         uuid primary key default gen_random_uuid(),
  plugin_id  uuid references public.plugin_store_items(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_plugin_downloads_plugin on public.plugin_downloads (plugin_id);
-- 每个账号只记录一次下载，避免刷下载量。
delete from public.plugin_downloads a
using public.plugin_downloads b
where a.plugin_id = b.plugin_id
  and a.user_id = b.user_id
  and a.id::text > b.id::text;
create unique index if not exists plugin_downloads_unique_user
  on public.plugin_downloads (plugin_id, user_id)
  where user_id is not null;

-- 下载量自增 RPC（security definer 绕过 RLS，因下载者非作者无法直接 UPDATE）
create or replace function public.increment_downloads(target_plugin_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.plugin_store_items
     set downloads = downloads + 1
   where id = target_plugin_id;
$$;
revoke all on function public.increment_downloads(uuid) from public, anon, authenticated;
grant execute on function public.increment_downloads(uuid) to service_role;

-- 下载记录落库后由数据库维护计数，客户端不能直接调用自增函数。
create or replace function public.on_plugin_download_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.plugin_store_items
     set downloads = downloads + 1
   where id = new.plugin_id;
  return new;
end;
$$;
revoke all on function public.on_plugin_download_created() from public, anon, authenticated;
drop trigger if exists trg_plugin_download_created on public.plugin_downloads;
create trigger trg_plugin_download_created
  after insert on public.plugin_downloads
  for each row execute function public.on_plugin_download_created();

-- 评分
create table if not exists public.plugin_ratings (
  id         uuid primary key default gen_random_uuid(),
  plugin_id  uuid references public.plugin_store_items(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete cascade,
  rating     integer not null check (rating >= 1 and rating <= 5),
  created_at timestamptz not null default now(),
  unique(plugin_id, user_id)
);

-- RLS
alter table public.plugin_store_items enable row level security;
alter table public.plugin_downloads    enable row level security;
alter table public.plugin_ratings      enable row level security;

-- 插件条目：所有人可读（仅 approved），作者可写自己的
drop policy if exists "Anyone can read approved plugins" on public.plugin_store_items;
create policy "Anyone can read approved plugins" on public.plugin_store_items
  for select using (status = 'approved');

drop policy if exists "Author can manage own plugins" on public.plugin_store_items;
drop policy if exists "Author can insert pending plugins" on public.plugin_store_items;
create policy "Author can insert pending plugins" on public.plugin_store_items
  for insert with check (author_id = auth.uid() and status = 'pending');
drop policy if exists "Author can update own plugins" on public.plugin_store_items;
drop policy if exists "Author can delete own plugins" on public.plugin_store_items;
create policy "Author can delete own plugins" on public.plugin_store_items
  for delete using (author_id = auth.uid());

-- 下载记录：本人可读/写
drop policy if exists "Users can read own downloads" on public.plugin_downloads;
create policy "Users can read own downloads" on public.plugin_downloads
  for select using (user_id = auth.uid());

drop policy if exists "Users can insert downloads" on public.plugin_downloads;
create policy "Users can insert downloads" on public.plugin_downloads
  for insert with check (user_id = auth.uid());

-- 评分：所有人可读，本人可写
drop policy if exists "Anyone can read ratings" on public.plugin_ratings;
create policy "Anyone can read ratings" on public.plugin_ratings
  for select using (true);

drop policy if exists "Users can manage own ratings" on public.plugin_ratings;
create policy "Users can manage own ratings" on public.plugin_ratings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 权限：授权 anon/authenticated 访问这三张表（PostgREST 不会自动识别新表）
revoke all on public.plugin_store_items from anon, authenticated;
grant select on public.plugin_store_items to anon, authenticated;
grant insert, delete on public.plugin_store_items to authenticated;
revoke all on public.plugin_downloads from anon, authenticated;
grant select, insert on public.plugin_downloads to authenticated;
revoke all on public.plugin_ratings from anon, authenticated;
grant select on public.plugin_ratings to anon, authenticated;
grant insert, update, delete on public.plugin_ratings to authenticated;

-- Storage 存储桶：插件市场文件
insert into storage.buckets (id, name, public)
values ('plugin-store', 'plugin-store', true)
on conflict (id) do nothing;

-- Storage RLS：插件上传/更新/删除 + 读取
-- 注意：上传用 upsert:true，文件已存在时会走 UPDATE，必须有 for all（覆盖 UPDATE）而非仅 for insert
drop policy if exists "Authenticated users can manage plugin files" on storage.objects;
drop policy if exists "Authors can manage own plugin files" on storage.objects;
create policy "Authors can manage own plugin files" on storage.objects
  for all
  using (
    bucket_id = 'plugin-store'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'plugin-store'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Anyone can read plugin files" on storage.objects;
create policy "Anyone can read plugin files" on storage.objects
  for select using (bucket_id = 'plugin-store');

-- 更新插件平均评分的触发器
create or replace function public.update_plugin_avg_rating()
returns trigger language plpgsql security definer as $$
begin
  update public.plugin_store_items
  set rating = (select coalesce(avg(rating), 0) from public.plugin_ratings where plugin_id = coalesce(new.plugin_id, old.plugin_id)),
      updated_at = now()
  where id = coalesce(new.plugin_id, old.plugin_id);
  return null;
end $$;

drop trigger if exists trg_plugin_rating_update on public.plugin_ratings;
create trigger trg_plugin_rating_update
  after insert or update or delete on public.plugin_ratings
  for each row execute function public.update_plugin_avg_rating();

-- ═══════════════════════════════════════════════════════════════════
-- 手机端 PWA：跨设备数据同步（v0.4.0）
-- 通用键值表，存储待办/笔记/计时/习惯/任务线/电子书元数据等学习数据，
-- 每行一个 localStorage key（value 为 JSON），per-key updated_at 后写者胜。
-- ═══════════════════════════════════════════════════════════════════
create table if not exists public.user_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_data_unique_key unique (user_id, key)
);
create index if not exists idx_user_data_user on public.user_data (user_id, updated_at desc);
alter table public.user_data enable row level security;

-- RLS：仅本人可读可写
drop policy if exists "user_data_self_all" on public.user_data;
create policy "user_data_self_all" on public.user_data
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 授权 Data API 角色
grant all on table public.user_data to anon, authenticated, service_role;

-- 启用 Realtime（远端变更实时推送）
do $$ begin alter publication supabase_realtime add table public.user_data; exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════
-- 日志类数据独立云存储（v0.4.1 云存储管理面板）
-- 存 AI 对话、教材章节讲解日志、全书问答日志，与普通同步（user_data）分离，
-- 按 item 粒度分片增量上传，每行一个 item（data 为 gzip 压缩串包装 {v,c,d}），
-- bytes 记录压缩后字节数供每用户配额聚合（默认 50MB，可配置）。
-- 说明：kind = 'ai_conv' | 'bk_explain' | 'bk_qa'；item_id 分片时追加 _p0/_p1 后缀。
-- ═══════════════════════════════════════════════════════════════════
create table if not exists public.user_sync_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  item_id text not null,
  data jsonb not null default '{}'::jsonb,
  bytes int not null default 0,
  updated_at timestamptz not null default now(),
  constraint user_sync_items_unique unique (user_id, kind, item_id)
);
create index if not exists idx_user_sync_items_user on public.user_sync_items (user_id, updated_at desc);
alter table public.user_sync_items enable row level security;

-- RLS：仅本人可读可写
drop policy if exists "user_sync_items_self_all" on public.user_sync_items;
create policy "user_sync_items_self_all" on public.user_sync_items
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 授权 Data API 角色
grant all on table public.user_sync_items to anon, authenticated, service_role;

-- 启用 Realtime（远端变更实时推送，供其他设备合并回本地）
do $$ begin alter publication supabase_realtime add table public.user_sync_items; exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════
-- Storage 配置说明（需在 Supabase 控制台手动操作）
-- ═══════════════════════════════════════════════════════════════════
-- 1. 创建 bucket：名称 plugin-store，勾选 Public bucket
-- 2. Storage RLS Policy → plugin-store bucket：
--    SELECT (读取)：bucket_id = 'plugin-store' → 允许所有人（public）
--    INSERT (上传)：bucket_id = 'plugin-store' → 仅认证用户（auth.role() = 'authenticated'）
-- 3. 插件文件存储格式：
--    - 路径：<plugin_id>/<version>/<ext_id>.zip
--    - zip 内容：manifest.json + main.js
--    示例：550e8400-e29b-41d4-a716-446655440000/1.0.0/my-plugin.zip


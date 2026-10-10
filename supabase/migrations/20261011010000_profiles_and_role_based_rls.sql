-- Step 3-1: 個人アカウント（管理者／スタッフ）の土台と、役割ベースの RLS
-- 対象DB: ihpngacdpoynygfyxgup（東京）のみ。Wan!Voice と Wan!Sync の両方に効く。
--
-- 方針
--   スタッフ : 閲覧＋フィードバック／アクションの入力。自分が入れた行の修正まで。
--   管理者   : 全操作（削除、回／イベント、アンケート取り込み、設定など）
--   active = false のユーザーは何もできない（profiles が無いユーザーも同じ）
--   sessions の public（未ログイン）向けポリシーは削除する
--   既存の共有アカウント shimana@net-fun.co.jp は管理者にする
--     → 今の Wan!Voice / Wan!Sync は共有アカウントで動いているので、この適用で挙動は変わらない
--
-- 補足: trg_resolve_feedback_event / trg_register_event_from_session は SECURITY DEFINER なので、
--       スタッフのフィードバック入力で events / session_alias に自動登録する動きはそのまま動く。

begin;

-- ===== profiles =====
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role text not null default 'staff' check (role in ('admin', 'staff')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 新規ユーザー作成時（招待含む）に profiles を自動作成する。役割は必ず staff から始める。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role, active)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)),
    'staff',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 既存ユーザーの profiles を作る。共有アカウントは管理者（嶋名）。
insert into public.profiles (id, display_name, role, active)
select u.id,
       case when u.email = 'shimana@net-fun.co.jp' then '嶋名' else split_part(u.email, '@', 1) end,
       case when u.email = 'shimana@net-fun.co.jp' then 'admin' else 'staff' end,
       true
from auth.users u
on conflict (id) do nothing;

create or replace function public.touch_profiles()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_profiles on public.profiles;
create trigger trg_touch_profiles
  before update on public.profiles
  for each row execute function public.touch_profiles();

-- 最後の管理者を staff に下げたり無効にしたりして、誰も管理できなくなるのを防ぐ
create or replace function public.keep_one_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'admin' and old.active
     and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from public.profiles p
                     where p.id <> old.id and p.role = 'admin' and p.active) then
    raise exception '有効な管理者が1人もいなくなるため変更できません';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_keep_one_admin on public.profiles;
create trigger trg_keep_one_admin
  before update on public.profiles
  for each row execute function public.keep_one_admin();

-- ===== 判定関数（RLS から使う。SECURITY DEFINER で profiles の RLS を回避して判定する） =====
create or replace function public.is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'admin');
$$;

revoke all on function public.is_active() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.is_active() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ===== created_by =====
alter table public.feedbacks add column if not exists created_by uuid default auth.uid() references auth.users (id) on delete set null;
alter table public.actions   add column if not exists created_by uuid default auth.uid() references auth.users (id) on delete set null;

-- ===== 既存ポリシーをすべて外す（public / authenticated とも） =====
do $$
declare
  r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('actions','analyses','app_settings','content_alias','contents','events','feedbacks',
                        'session_alias','sessions','survey_answers','survey_imports','survey_responses')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end;
$$;

-- ===== 閲覧はアクティブなユーザー全員、変更は管理者だけ のテーブル =====
do $$
declare
  t text;
begin
  foreach t in array array['analyses','app_settings','content_alias','contents','events',
                           'session_alias','sessions','survey_answers','survey_imports','survey_responses']
  loop
    execute format('create policy active_select on public.%I for select to authenticated using (public.is_active())', t);
    execute format('create policy admin_insert on public.%I for insert to authenticated with check (public.is_admin())', t);
    execute format('create policy admin_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using (public.is_admin())', t);
  end loop;
end;
$$;

-- ===== feedbacks / actions: スタッフは入力と自分の行の修正まで。削除は管理者だけ =====
do $$
declare
  t text;
begin
  foreach t in array array['feedbacks','actions']
  loop
    execute format('create policy active_select on public.%I for select to authenticated using (public.is_active())', t);
    execute format('create policy active_insert on public.%I for insert to authenticated
                    with check (public.is_active() and (created_by = auth.uid() or public.is_admin()))', t);
    execute format('create policy owner_or_admin_update on public.%I for update to authenticated
                    using (public.is_admin() or (public.is_active() and created_by = auth.uid()))
                    with check (public.is_admin() or (public.is_active() and created_by = auth.uid()))', t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using (public.is_admin())', t);
  end loop;
end;
$$;

-- ===== profiles: 閲覧はアクティブなユーザー全員（名前表示のため）、変更は管理者だけ =====
-- INSERT はトリガー（SECURITY DEFINER）だけが行う。DELETE は auth.users の削除に連動する。
drop policy if exists active_select on public.profiles;
drop policy if exists admin_update on public.profiles;
create policy active_select on public.profiles for select to authenticated using (public.is_active());
create policy admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;

-- Oxford Vocab Together: Supabase database schema
-- Chạy toàn bộ file này một lần trong Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'student' check (role in ('student','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.vocabulary (
  id uuid primary key default gen_random_uuid(),
  entry_key text not null unique,
  word text not null,
  meaning_vi text,
  pos text not null default '',
  level text not null default 'Custom',
  hint text not null default '',
  source text not null default 'Admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  vocab_id uuid not null references public.vocabulary(id) on delete cascade,
  status text not null default 'new' check (status in ('new','learning','learned')),
  seen_count integer not null default 0,
  correct_count integer not null default 0,
  wrong_count integer not null default 0,
  last_reviewed_at timestamptz,
  primary key (user_id, vocab_id)
);

create table if not exists public.attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  vocab_id uuid references public.vocabulary(id) on delete set null,
  exercise_type text not null,
  is_correct boolean not null,
  answer text,
  created_at timestamptz not null default now()
);

create table if not exists public.reading_passages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  level text not null default 'Mixed',
  content text not null,
  questions jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.reading_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  passage_id uuid not null references public.reading_passages(id) on delete cascade,
  score integer not null,
  total integer not null,
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists vocab_updated_at on public.vocabulary;
create trigger vocab_updated_at before update on public.vocabulary
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger security definer set search_path = public language plpgsql as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'display_name',''))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean security definer set search_path = public language sql stable as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

alter table public.profiles enable row level security;
alter table public.vocabulary enable row level security;
alter table public.user_progress enable row level security;
alter table public.attempts enable row level security;
alter table public.reading_passages enable row level security;
alter table public.reading_attempts enable row level security;

drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile" on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid() and role = 'student');

drop policy if exists "Anyone reads vocabulary" on public.vocabulary;
create policy "Anyone reads vocabulary" on public.vocabulary for select to anon, authenticated using (true);
drop policy if exists "Admins manage vocabulary" on public.vocabulary;
create policy "Admins manage vocabulary" on public.vocabulary for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read progress" on public.user_progress;
create policy "Users read progress" on public.user_progress for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users insert progress" on public.user_progress;
create policy "Users insert progress" on public.user_progress for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "Users update progress" on public.user_progress;
create policy "Users update progress" on public.user_progress for update to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users read attempts" on public.attempts;
create policy "Users read attempts" on public.attempts for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users add attempts" on public.attempts;
create policy "Users add attempts" on public.attempts for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "Anyone reads readings" on public.reading_passages;
create policy "Anyone reads readings" on public.reading_passages for select to anon, authenticated using (true);
drop policy if exists "Admins manage readings" on public.reading_passages;
create policy "Admins manage readings" on public.reading_passages for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read own reading attempts" on public.reading_attempts;
create policy "Users read own reading attempts" on public.reading_attempts for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users add reading attempts" on public.reading_attempts;
create policy "Users add reading attempts" on public.reading_attempts for insert to authenticated with check (user_id = auth.uid());

-- Cho phép app nhận từ mới và bài reading mới tức thời.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='vocabulary') then
    alter publication supabase_realtime add table public.vocabulary;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='reading_passages') then
    alter publication supabase_realtime add table public.reading_passages;
  end if;
end $$;

-- Bài reading mẫu. Bạn có thể sửa/xóa bằng SQL hoặc đăng bài mới từ Admin Studio.
insert into public.reading_passages (title, level, content, questions)
select
  'A Sustainable Community Garden',
  'B2',
  'A neighbourhood decided to transform an empty space into a sustainable community garden. At first, some residents were sceptical, because they assumed the project would require considerable funding. However, local volunteers donated equipment and seeds. The garden now produces vegetables, strengthens community relationships, and provides workshops on nutrition. Its success has encouraged nearby districts to adopt similar projects.',
  '[{"question":"Why were some residents sceptical at first?","options":["They disliked vegetables.","They thought the project would need a lot of money.","They preferred a new road.","They had no empty space."],"answer":1},{"question":"Which result is mentioned in the passage?","options":["The garden created pollution.","The garden closed local workshops.","The garden strengthened community relationships.","The districts rejected the idea."],"answer":2}]'::jsonb
where not exists (select 1 from public.reading_passages where title = 'A Sustainable Community Garden');

-- Sau khi bạn đăng ký tài khoản trên website, chạy lệnh dưới đây và thay email của bạn để mở trang Admin:
-- update public.profiles set role = 'admin' where email = 'email-cua-ban@example.com';

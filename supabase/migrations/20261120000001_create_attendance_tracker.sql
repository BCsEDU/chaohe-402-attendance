-- 班級出缺席請假與聯絡簿補作業追蹤系統資料表
-- 隱私設計：雲端僅儲存座號（1~45），不儲存學生真實姓名

create table if not exists public.att_settings (
  id text primary key default 'default',
  class_name text not null default '402 班',
  max_seat integer not null default 29 check (max_seat between 1 and 45),
  inactive_seats integer[] not null default '{}',
  updated_at timestamptz not null default now()
);

insert into public.att_settings (id, class_name, max_seat, inactive_seats)
values ('default', '402 班', 29, '{}')
on conflict (id) do nothing;

create table if not exists public.att_contact_days (
  date date primary key,
  raw_text text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.att_contact_items (
  id uuid primary key default gen_random_uuid(),
  date date not null references public.att_contact_days(date) on delete cascade,
  sort_order integer not null default 0,
  title text not null check (char_length(btrim(title)) > 0),
  category text not null default 'homework' check (category in ('homework', 'quiz', 'correction', 'notice')),
  period text not null default 'all' check (period in ('all', 'am', 'pm')),
  requires_makeup boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_att_contact_items_date
  on public.att_contact_items (date, sort_order);

create table if not exists public.att_absences (
  id uuid primary key default gen_random_uuid(),
  seat integer not null check (seat between 1 and 45),
  date date not null,
  leave_type text not null check (leave_type in ('personal', 'sick', 'bereavement', 'official', 'other')),
  session text not null default 'full' check (session in ('full', 'am', 'pm')),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint att_absences_seat_date_unique unique (seat, date)
);

create index if not exists idx_att_absences_date
  on public.att_absences (date, seat);

create table if not exists public.att_makeup_records (
  id uuid primary key default gen_random_uuid(),
  absence_id uuid not null references public.att_absences(id) on delete cascade,
  item_id uuid not null references public.att_contact_items(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'submitted', 'done', 'exempt')),
  note text not null default '',
  updated_at timestamptz not null default now(),
  constraint att_makeup_records_absence_item_unique unique (absence_id, item_id)
);

create index if not exists idx_att_makeup_records_absence_id
  on public.att_makeup_records (absence_id);

create index if not exists idx_att_makeup_records_item_id
  on public.att_makeup_records (item_id);

create or replace function public.set_att_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_att_settings_updated_at on public.att_settings;
create trigger trg_att_settings_updated_at
  before update on public.att_settings
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_contact_days_updated_at on public.att_contact_days;
create trigger trg_att_contact_days_updated_at
  before update on public.att_contact_days
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_contact_items_updated_at on public.att_contact_items;
create trigger trg_att_contact_items_updated_at
  before update on public.att_contact_items
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_absences_updated_at on public.att_absences;
create trigger trg_att_absences_updated_at
  before update on public.att_absences
  for each row
  execute function public.set_att_updated_at();

drop trigger if exists trg_att_makeup_records_updated_at on public.att_makeup_records;
create trigger trg_att_makeup_records_updated_at
  before update on public.att_makeup_records
  for each row
  execute function public.set_att_updated_at();

-- 最小權限原則：全面禁止匿名與一般客戶端直連，統一經由 Edge Function 以教師密碼驗證後存取
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'att_settings',
    'att_contact_days',
    'att_contact_items',
    'att_absences',
    'att_makeup_records'
  ]
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on table public.%I to service_role', tbl);
    execute format('drop policy if exists "deny_direct_client_access" on public.%I', tbl);
    execute format(
      'create policy "deny_direct_client_access" on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl
    );
  end loop;
end $$;

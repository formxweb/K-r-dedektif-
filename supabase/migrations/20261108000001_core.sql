-- KârDedektifi — çekirdek: işletmeler, üyelik, audit log, yardımcı fonksiyonlar
-- Tüm para alanları numeric(14,4), miktarlar numeric(14,3), oranlar numeric(7,4).

create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Zaman: işletme saati Europe/Istanbul. Ay = ayın ilk günü (date).
-- ---------------------------------------------------------------------------
create or replace function private.ist_start(d date)
returns timestamptz language sql immutable parallel safe
set search_path = ''
as $$ select (d::timestamp at time zone 'Europe/Istanbul') $$;

create or replace function private.ist_date(ts timestamptz)
returns date language sql immutable parallel safe
set search_path = ''
as $$ select (ts at time zone 'Europe/Istanbul')::date $$;

create or replace function private.month_of(d date)
returns date language sql immutable parallel safe
set search_path = ''
as $$ select date_trunc('month', d)::date $$;

-- Türkçe karakter duyarlı ad normalizasyonu (eşleştirme için)
create or replace function private.normalize_name(s text)
returns text language sql immutable parallel safe
set search_path = ''
as $$
  select nullif(
    trim(regexp_replace(
      regexp_replace(
        lower(translate(coalesce(s, ''), 'İIŞĞÜÖÇ', 'iışğüöç')),
        '[^a-z0-9çğıöşü,.]+', ' ', 'g'),
      '\s+', ' ', 'g')),
    '')
$$;

-- ---------------------------------------------------------------------------
-- İşletmeler
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  -- Sadece gerçek usul KDV desteklenir; alan ileride basit usul için var.
  vat_regime text not null default 'standard' check (vat_regime in ('standard')),
  margin_alert_threshold_pts numeric(7,4) not null default 5
    check (margin_alert_threshold_pts >= 0 and margin_alert_threshold_pts <= 100),
  dead_stock_days integer not null default 60 check (dead_stock_days between 7 and 730),
  price_rounding_step numeric(14,4) not null default 0.50 check (price_rounding_step > 0),
  -- Bu tarih dahil önceki tüm günler kapalı dönemdir (her zaman bir ayın son günü).
  closed_through date,
  ledger_version bigint not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

-- ---------------------------------------------------------------------------
-- Audit log: kritik tablolardaki her değişiklik (önce/sonra)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  table_name text not null,
  record_id uuid,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index audit_log_record_idx on public.audit_log (organization_id, table_name, record_id);
create index audit_log_created_idx on public.audit_log (organization_id, created_at desc);

create or replace function private.audit_row()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('UPDATE', 'INSERT') then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);
  insert into public.audit_log (organization_id, table_name, record_id, action, old_data, new_data, actor)
  values (
    coalesce((v_row ->> 'organization_id')::uuid, (v_row ->> 'id')::uuid),
    tg_table_name,
    (v_row ->> 'id')::uuid,
    tg_op,
    v_old,
    v_new,
    auth.uid()
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_organizations after insert or update or delete on public.organizations
  for each row execute function private.audit_row();
create trigger audit_organization_members after insert or update or delete on public.organization_members
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Üyelik yardımcıları (RLS politikaları bunları kullanır)
-- ---------------------------------------------------------------------------
create or replace function private.my_org_ids()
returns uuid[] language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.organization_id), '{}')
  from public.organization_members m
  where m.user_id = auth.uid()
$$;

create or replace function private.assert_member(p_org uuid)
returns void language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Oturum bulunamadı. Lütfen tekrar giriş yapın.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid()
  ) then
    raise exception 'Bu işletmeye erişim yetkiniz yok.' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.assert_admin(p_org uuid)
returns void language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.assert_member(p_org);
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid() and m.role in ('owner', 'admin')
  ) then
    raise exception 'Bu işlem için yönetici yetkisi gerekiyor.' using errcode = '42501';
  end if;
end;
$$;

-- İşletme bazlı kilit: aynı işletmede defter değiştiren işlemler sırayla çalışır.
create or replace function private.lock_org(p_org uuid)
returns void language sql volatile
set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended(p_org::text, 7331)) $$;

create or replace function private.bump_ledger(p_org uuid)
returns bigint language sql volatile
set search_path = ''
as $$
  update public.organizations set ledger_version = ledger_version + 1
  where id = p_org returning ledger_version
$$;

create or replace function private.assert_ledger_version(p_org uuid, p_expected bigint)
returns void language plpgsql volatile
set search_path = ''
as $$
declare v bigint;
begin
  select ledger_version into v from public.organizations where id = p_org;
  if p_expected is not null and v <> p_expected then
    raise exception 'Önizlemeden sonra veriler değişti. Önizlemeyi yenileyip tekrar deneyin.'
      using errcode = 'KDVER';
  end if;
end;
$$;

-- Yeni kullanıcı → profil
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

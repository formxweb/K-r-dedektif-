-- Giderler, tahmin, dönem işaretleri

create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  code text not null,
  name text not null,
  sort_order integer not null default 0,
  unique (organization_id, code)
);

create table public.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  category_id uuid not null references public.expense_categories (id) on delete restrict,
  description text not null check (length(trim(description)) between 1 and 200),
  amount numeric(14,4) not null check (amount > 0),
  vat_amount numeric(14,4) not null default 0 check (vat_amount >= 0),
  start_month date not null check (extract(day from start_month) = 1),
  end_month date check (end_month is null or extract(day from end_month) = 1),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check (end_month is null or end_month >= start_month)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  category_id uuid not null references public.expense_categories (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  -- KDV hariç tutar (kâr tablosuna giren). İndirilecek KDV ayrıca tutulur.
  amount numeric(14,4) not null check (amount > 0),
  vat_amount numeric(14,4) not null default 0 check (vat_amount >= 0),
  description text,
  -- pending: tekrarlayan giderden otomatik oluştu, onay bekliyor; skipped: bu ay yok sayıldı
  status text not null default 'approved' check (status in ('pending', 'approved', 'skipped')),
  recurring_expense_id uuid references public.recurring_expenses (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index expenses_month_idx on public.expenses (organization_id, month);
create unique index expenses_recurring_uq on public.expenses (recurring_expense_id, month)
  where recurring_expense_id is not null;

create trigger audit_expenses after insert or update or delete on public.expenses
  for each row execute function private.audit_row();
create trigger audit_recurring_expenses after insert or update or delete on public.recurring_expenses
  for each row execute function private.audit_row();

-- Kapalı aya gider / prim eklenemez, değiştirilemez, silinemez.
create or replace function private.guard_closed_month()
returns trigger language plpgsql
set search_path = ''
as $$
declare
  v_closed date;
  v_month date;
begin
  select o.closed_through into v_closed from public.organizations o
  where o.id = coalesce(new.organization_id, old.organization_id);
  if v_closed is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.month <= v_closed then
    raise exception 'Bu ay kapalı (% ve öncesi). Kapalı dönemin kayıtları değiştirilemez.',
      to_char(v_closed, 'DD.MM.YYYY') using errcode = 'KDCLS';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_month := new.month;
    if v_month <= v_closed then
      raise exception 'Bu ay kapalı (% ve öncesi). Kapalı döneme kayıt eklenemez.',
        to_char(v_closed, 'DD.MM.YYYY') using errcode = 'KDCLS';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger guard_expenses_closed before insert or update or delete on public.expenses
  for each row execute function private.guard_closed_month();
create trigger guard_rebates_closed before insert or update or delete on public.supplier_rebates
  for each row execute function private.guard_closed_month();

-- Tahmin çalıştırmaları ve öneri satırları
create table public.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  algorithm_version text not null,
  params jsonb not null default '{}'::jsonb,
  data_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index forecast_runs_org_idx on public.forecast_runs (organization_id, created_at desc);

create table public.forecast_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  run_id uuid not null references public.forecast_runs (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  supplier_id uuid references public.suppliers (id) on delete set null,
  weekly_demand numeric(14,3),
  trend_pct numeric(7,4),
  weeks_of_data integer not null default 0,
  observations integer not null default 0,
  stock_on_hand numeric(14,3),
  on_order numeric(14,3) not null default 0,
  safety_stock numeric(14,3),
  suggested_qty numeric(14,3) not null default 0,
  order_unit_name text,
  order_unit_factor numeric(14,3),
  suggested_units numeric(14,3) not null default 0,
  range_low_units numeric(14,3),
  range_high_units numeric(14,3),
  confidence text not null check (confidence in ('insufficient', 'low', 'medium', 'high')),
  reason text not null,
  inputs jsonb not null default '{}'::jsonb,
  ordered_at timestamptz,
  ordered_qty numeric(14,3)
);
create index forecast_items_run_idx on public.forecast_items (run_id);
create index forecast_items_ordered_idx on public.forecast_items (organization_id, supplier_id, ordered_at)
  where ordered_at is not null;

create table public.period_markers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  start_date date not null,
  end_date date not null,
  multiplier numeric(7,4) not null check (multiplier > 0 and multiplier <= 10),
  category_id uuid references public.categories (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

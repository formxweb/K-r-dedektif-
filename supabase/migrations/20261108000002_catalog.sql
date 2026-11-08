-- Ürün, birim, KDV, fiyat, tedarikçi

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create unique index categories_name_uq on public.categories (organization_id, lower(name));

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  name_norm text generated always as (private.normalize_name(name)) stored,
  barcode text check (barcode is null or length(barcode) between 1 and 64),
  code text check (code is null or length(code) between 1 and 64),
  base_unit text not null check (base_unit in ('adet', 'kg', 'lt')),
  category_id uuid references public.categories (id) on delete set null,
  is_weighed boolean not null default false,
  shelf_life_days integer check (shelf_life_days is null or shelf_life_days > 0),
  is_active boolean not null default true,
  created_by_import_job_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index products_barcode_uq on public.products (organization_id, barcode) where barcode is not null;
create unique index products_code_uq on public.products (organization_id, code) where code is not null;
create index products_org_idx on public.products (organization_id);
create index products_name_trgm on public.products using gin (name_norm extensions.gin_trgm_ops);

-- Alış birimleri: 1 <name> = factor × temel birim
create table public.product_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  factor numeric(14,3) not null check (factor > 0),
  barcode text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index product_units_name_uq on public.product_units (product_id, lower(name));
create unique index product_units_barcode_uq on public.product_units (organization_id, barcode) where barcode is not null;

-- KDV oranları: ürün × tarih aralığı (valid_to dahil; null = açık uçlu)
create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  rate numeric(7,4) not null check (rate >= 0 and rate < 100),
  valid_from date not null,
  valid_to date,
  import_job_id uuid,
  closed_by_import_job_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check (valid_to is null or valid_to >= valid_from),
  constraint tax_rates_no_overlap exclude using gist (
    product_id with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);
create index tax_rates_product_idx on public.tax_rates (product_id, valid_from);

create or replace function private.vat_rate_at(p_product uuid, p_date date)
returns numeric language sql stable
set search_path = ''
as $$
  select t.rate from public.tax_rates t
  where t.product_id = p_product and t.valid_from <= p_date
    and (t.valid_to is null or t.valid_to >= p_date)
  limit 1
$$;

-- Raf (satış) fiyatı geçmişi. Fiyat KDV dahildir.
create table public.product_price_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  sale_price_gross numeric(14,4) check (sale_price_gross is null or sale_price_gross >= 0),
  -- POS listesindeki alış fiyatı (KDV hariç). Kâr hesabında kullanılmaz.
  list_purchase_price_net numeric(14,4) check (list_purchase_price_net is null or list_purchase_price_net >= 0),
  valid_from date not null,
  import_job_id uuid,
  created_at timestamptz not null default now()
);
create index product_price_history_idx on public.product_price_history (product_id, valid_from desc, created_at desc);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  name_norm text generated always as (private.normalize_name(name)) stored,
  tax_number text check (tax_number is null or tax_number ~ '^[0-9]{10,11}$'),
  lead_time_days integer not null default 2 check (lead_time_days between 0 and 90),
  order_interval_days integer not null default 7 check (order_interval_days between 1 and 90),
  min_order_amount numeric(14,4) check (min_order_amount is null or min_order_amount >= 0),
  phone text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index suppliers_tax_uq on public.suppliers (organization_id, tax_number) where tax_number is not null;
create unique index suppliers_name_uq on public.suppliers (organization_id, name_norm);

-- Onaylanmış eşleşmeler: tedarikçinin ürün kodu/adı + birimi → ürün + birim katsayısı
create table public.supplier_product_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  supplier_code text,
  name_norm text not null,
  unit_code text not null default '',
  product_id uuid not null references public.products (id) on delete cascade,
  unit_factor numeric(14,3) not null check (unit_factor > 0),
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid default auth.uid()
);
create unique index supplier_aliases_code_uq on public.supplier_product_aliases (supplier_id, supplier_code, unit_code)
  where supplier_code is not null;
create unique index supplier_aliases_name_uq on public.supplier_product_aliases (supplier_id, name_norm, unit_code)
  where supplier_code is null;

create table public.product_suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  is_primary boolean not null default false,
  -- Sipariş birimi (koli vb.) ve minimum sipariş miktarı (temel birimde)
  order_unit_name text,
  order_unit_factor numeric(14,3) check (order_unit_factor is null or order_unit_factor > 0),
  min_order_qty numeric(14,3) check (min_order_qty is null or min_order_qty >= 0),
  created_at timestamptz not null default now(),
  unique (product_id, supplier_id)
);
create unique index product_suppliers_primary_uq on public.product_suppliers (product_id) where is_primary;

-- Tedarikçi primleri (dönem sonu / ciro primi): ilgili ayın kârına eklenir.
create table public.supplier_rebates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  amount numeric(14,4) not null check (amount > 0),
  description text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index supplier_rebates_month_idx on public.supplier_rebates (organization_id, month);

create trigger audit_products after insert or update or delete on public.products
  for each row execute function private.audit_row();
create trigger audit_product_units after insert or update or delete on public.product_units
  for each row execute function private.audit_row();
create trigger audit_tax_rates after insert or update or delete on public.tax_rates
  for each row execute function private.audit_row();
create trigger audit_suppliers after insert or update or delete on public.suppliers
  for each row execute function private.audit_row();
create trigger audit_supplier_aliases after insert or update or delete on public.supplier_product_aliases
  for each row execute function private.audit_row();
create trigger audit_product_suppliers after insert or update or delete on public.product_suppliers
  for each row execute function private.audit_row();
create trigger audit_supplier_rebates after insert or update or delete on public.supplier_rebates
  for each row execute function private.audit_row();

-- Ürünün temel birimi, hareketi varsa değiştirilemez (geçmiş miktarlar anlamını yitirir).
create or replace function private.guard_product_base_unit()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if new.base_unit is distinct from old.base_unit and exists (
    select 1 from public.inventory_movements m where m.product_id = old.id and m.voided_at is null
  ) then
    raise exception 'Stok hareketi olan ürünün temel birimi değiştirilemez.' using errcode = 'KDVAL';
  end if;
  return new;
end;
$$;

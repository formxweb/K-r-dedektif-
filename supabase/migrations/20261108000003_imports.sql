-- Aktarım altyapısı: profiller, işler, satırlar

create table public.import_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  source_system text,
  kind text not null check (kind in ('product_list', 'sales_summary', 'sales_receipts', 'purchase_invoice_table')),
  -- Normalize edilmiş başlık listesinin özeti: aynı başlıklı dosyalar profili otomatik bulur.
  header_signature text not null,
  headers jsonb not null,
  header_row integer not null default 0 check (header_row >= 0),
  sheet_name text,
  -- { "<hedef alan>": "<kaynak sütun başlığı>" }
  column_map jsonb not null,
  -- { decimal_separator, thousands_separator, date_format, encoding, vat_included: { field: bool }, qty_scale }
  options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index import_profiles_sig_uq on public.import_profiles (organization_id, kind, header_signature);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('product_list', 'sales_summary', 'sales_receipts',
                                     'purchase_invoice_xml', 'purchase_invoice_table')),
  profile_id uuid references public.import_profiles (id) on delete set null,
  file_name text not null,
  storage_path text,
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  file_size bigint,
  status text not null default 'staged' check (status in ('staged', 'committed', 'reverted', 'cancelled')),
  -- period_start, period_end (satış), stock_date (ürün listesi), supplier_id (tablo fatura) ...
  params jsonb not null default '{}'::jsonb,
  row_count integer not null default 0,
  ok_count integer not null default 0,
  warning_count integer not null default 0,
  error_count integer not null default 0,
  result jsonb,
  committed_at timestamptz,
  committed_by uuid,
  reverted_at timestamptz,
  reverted_by uuid,
  revert_reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
-- Aynı dosya (hash) aynı türde, aktifken (hazırlanmış veya işlenmiş) ikinci kez yüklenemez.
create unique index import_jobs_hash_uq on public.import_jobs (organization_id, kind, file_hash)
  where status in ('staged', 'committed');
create index import_jobs_org_idx on public.import_jobs (organization_id, created_at desc);

alter table public.products
  add constraint products_created_by_job_fk foreign key (created_by_import_job_id)
  references public.import_jobs (id) on delete set null;
alter table public.tax_rates
  add constraint tax_rates_job_fk foreign key (import_job_id) references public.import_jobs (id) on delete set null,
  add constraint tax_rates_closed_job_fk foreign key (closed_by_import_job_id) references public.import_jobs (id) on delete set null;
alter table public.product_price_history
  add constraint price_history_job_fk foreign key (import_job_id) references public.import_jobs (id) on delete set null;

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  job_id uuid not null references public.import_jobs (id) on delete cascade,
  row_number integer not null,
  raw jsonb not null,
  parsed jsonb,
  status text not null check (status in ('ok', 'warning', 'error', 'duplicate', 'needs_review', 'skipped')),
  messages jsonb not null default '[]'::jsonb,
  product_id uuid references public.products (id) on delete set null,
  target_type text,
  target_id uuid,
  unique (job_id, row_number)
);
create index import_rows_job_idx on public.import_rows (job_id, status);

create trigger audit_import_profiles after insert or update or delete on public.import_profiles
  for each row execute function private.audit_row();
create trigger audit_import_jobs after insert or update or delete on public.import_jobs
  for each row execute function private.audit_row();

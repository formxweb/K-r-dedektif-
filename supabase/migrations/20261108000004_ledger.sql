-- Alış, satış, stok hareketleri, maliyet zinciri, uyarılar

-- ---------------------------------------------------------------------------
-- Alış faturaları
-- ---------------------------------------------------------------------------
create table public.purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  import_job_id uuid not null references public.import_jobs (id) on delete restrict,
  invoice_no text not null check (length(trim(invoice_no)) between 1 and 64),
  ettn uuid,
  invoice_date date not null,
  invoice_type text,
  currency text not null default 'TRY' check (currency = 'TRY'),
  doc_total_excl_vat numeric(14,4),
  doc_total_vat numeric(14,4),
  doc_total_incl_vat numeric(14,4),
  calc_total_excl_vat numeric(14,4) not null,
  calc_total_vat numeric(14,4) not null,
  calc_total_incl_vat numeric(14,4) not null,
  total_mismatch boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'posted', 'cancelled', 'reversed')),
  posted_at timestamptz,
  posted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index purchase_invoices_no_uq on public.purchase_invoices (organization_id, supplier_id, invoice_no)
  where status in ('draft', 'posted');
create unique index purchase_invoices_ettn_uq on public.purchase_invoices (organization_id, ettn)
  where ettn is not null and status in ('draft', 'posted');
create index purchase_invoices_org_idx on public.purchase_invoices (organization_id, invoice_date desc);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  invoice_id uuid not null references public.purchase_invoices (id) on delete cascade,
  import_row_id uuid references public.import_rows (id) on delete set null,
  line_no integer not null,
  raw_name text not null,
  raw_name_norm text generated always as (private.normalize_name(raw_name)) stored,
  raw_code text,
  raw_barcode text,
  unit_code text not null default '',
  unit_name text,
  -- Faturadaki birimin türü: base (adet/kg/lt), scaled (gram/ml), package (koli, paket...), unknown
  unit_kind text not null default 'unknown' check (unit_kind in ('base', 'scaled', 'package', 'unknown')),
  unit_base text check (unit_base is null or unit_base in ('adet', 'kg', 'lt')),
  unit_scale numeric(14,3),
  qty numeric(14,3) not null check (qty > 0),
  unit_price numeric(14,4) not null,
  discount_amount numeric(14,4) not null default 0,
  -- KDV hariç, satır ve belge iskontoları düşülmüş net tutar
  line_net numeric(14,4) not null check (line_net >= 0),
  vat_rate numeric(7,4) not null,
  vat_amount numeric(14,4) not null,
  product_id uuid references public.products (id) on delete restrict,
  unit_factor numeric(14,3) check (unit_factor is null or unit_factor > 0),
  base_qty numeric(14,3),
  unit_cost_base numeric(14,4),
  match_method text check (match_method in ('barcode', 'unit_barcode', 'alias', 'manual')),
  match_status text not null default 'unmatched' check (match_status in ('matched', 'suggested', 'unmatched', 'ignored')),
  suggested_product_id uuid references public.products (id) on delete set null,
  suggestion_score numeric(5,4),
  created_at timestamptz not null default now(),
  unique (invoice_id, line_no)
);
create index purchase_items_product_idx on public.purchase_items (product_id);

-- ---------------------------------------------------------------------------
-- Satış: dönemlik toplamlar ve fiş satırları
-- ---------------------------------------------------------------------------
create table public.sales_period_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  import_job_id uuid not null references public.import_jobs (id) on delete restrict,
  import_row_id uuid references public.import_rows (id) on delete set null,
  product_id uuid not null references public.products (id) on delete restrict,
  period_start date not null,
  period_end date not null,
  qty numeric(14,3) not null,
  gross_amount numeric(14,4) not null,
  net_amount numeric(14,4) not null,
  vat_amount numeric(14,4) not null,
  vat_rate numeric(7,4) not null,
  -- Satış anındaki maliyet (hareketli ağırlıklı ortalama). Kapalı dönemde asla değişmez.
  unit_cost numeric(14,4),
  total_cost numeric(14,4),
  cost_known boolean not null default false,
  movement_id uuid,
  status text not null default 'active' check (status in ('active', 'reversed')),
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  constraint sales_summaries_no_overlap exclude using gist (
    product_id with =,
    daterange(period_start, period_end, '[]') with &&
  ) where (status = 'active')
);
create index sales_summaries_org_idx on public.sales_period_summaries (organization_id, period_end);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  import_job_id uuid not null references public.import_jobs (id) on delete restrict,
  import_row_id uuid references public.import_rows (id) on delete set null,
  product_id uuid not null references public.products (id) on delete restrict,
  receipt_no text,
  line_no integer,
  sold_at timestamptz not null,
  qty numeric(14,3) not null,
  gross_amount numeric(14,4) not null,
  net_amount numeric(14,4) not null,
  vat_amount numeric(14,4) not null,
  vat_rate numeric(7,4) not null,
  unit_cost numeric(14,4),
  total_cost numeric(14,4),
  cost_known boolean not null default false,
  movement_id uuid,
  fingerprint text not null,
  status text not null default 'active' check (status in ('active', 'reversed')),
  created_at timestamptz not null default now()
);
create unique index sale_items_fp_uq on public.sale_items (organization_id, fingerprint) where status = 'active';
create index sale_items_product_idx on public.sale_items (product_id, sold_at);
create index sale_items_movement_idx on public.sale_items (movement_id);

-- ---------------------------------------------------------------------------
-- Stok hareketleri: stok = hareketlerin toplamı
--   qty / unit_cost / total_cost / cost_known   → kayda geçen (kâr tablosu bunları kullanır)
--   calc_*                                      → güncel maliyet zinciri hesabı
-- Açık dönemde ikisi her zaman eşittir. Kapalı dönemde kayıtlı değerler donar,
-- fark "maliyet düzeltmesi" hareketiyle ilk açık aya yazılır.
-- total_cost işaretlidir: stoka giriş +, çıkış −. Kâr tablosundaki gider = −total_cost.
-- ---------------------------------------------------------------------------
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  seq bigint generated always as identity,
  occurred_at timestamptz not null,
  priority smallint not null,
  movement_type text not null check (movement_type in (
    'opening', 'purchase', 'sale', 'customer_return', 'supplier_return',
    'waste', 'spoilage', 'count_adjustment', 'cost_adjustment')),
  snapshot_qty numeric(14,3),
  input_unit_cost numeric(14,4),
  input_total_cost numeric(14,4),
  qty numeric(14,3) not null default 0,
  unit_cost numeric(14,4),
  total_cost numeric(14,4),
  cost_known boolean not null default false,
  calc_qty numeric(14,3),
  calc_unit_cost numeric(14,4),
  calc_total_cost numeric(14,4),
  calc_cost_known boolean not null default false,
  stock_after numeric(14,3),
  avg_cost_after numeric(14,4),
  source_type text,
  source_id uuid,
  import_job_id uuid references public.import_jobs (id) on delete restrict,
  note text,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check ((movement_type in ('opening', 'count_adjustment')) = (snapshot_qty is not null)),
  check (movement_type <> 'purchase' or (qty > 0 and input_total_cost is not null and input_total_cost >= 0))
);
create index inventory_movements_chain_idx on public.inventory_movements
  (product_id, occurred_at, priority, seq) where voided_at is null;
create index inventory_movements_org_time_idx on public.inventory_movements (organization_id, occurred_at)
  where voided_at is null;
create index inventory_movements_job_idx on public.inventory_movements (import_job_id);

alter table public.sales_period_summaries
  add constraint sales_summaries_movement_fk foreign key (movement_id) references public.inventory_movements (id);
alter table public.sale_items
  add constraint sale_items_movement_fk foreign key (movement_id) references public.inventory_movements (id);

create trigger guard_product_base_unit before update of base_unit on public.products
  for each row execute function private.guard_product_base_unit();

-- Maliyet revizyonları: açık dönemde, geçmiş tarihli bir kayıt veya geri alma
-- nedeniyle kayıtlı maliyeti değişen her hareket burada iz bırakır.
create table public.cost_revisions (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  movement_id uuid not null references public.inventory_movements (id) on delete cascade,
  product_id uuid not null,
  occurred_at timestamptz not null,
  movement_type text not null,
  old_total_cost numeric(14,4),
  new_total_cost numeric(14,4),
  old_cost_known boolean not null,
  new_cost_known boolean not null,
  cause_type text not null,
  cause_job_id uuid,
  created_at timestamptz not null default now()
);
create index cost_revisions_cause_idx on public.cost_revisions (cause_job_id, cause_type);
create index cost_revisions_product_idx on public.cost_revisions (product_id, created_at desc);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  alert_type text not null check (alert_type in (
    'margin_drop', 'invoice_total_mismatch', 'cost_revision', 'closed_period_adjustment')),
  product_id uuid references public.products (id) on delete cascade,
  source_type text,
  source_id uuid,
  import_job_id uuid references public.import_jobs (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'dismissed', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index alerts_org_open_idx on public.alerts (organization_id, created_at desc) where status = 'open';

create trigger audit_purchase_invoices after insert or update or delete on public.purchase_invoices
  for each row execute function private.audit_row();
create trigger audit_purchase_items after insert or update or delete on public.purchase_items
  for each row execute function private.audit_row();
create trigger audit_sales_summaries after insert or update or delete on public.sales_period_summaries
  for each row execute function private.audit_row();
-- Fiş satırları çok sayıda olabilir: sadece durum ve maliyet değişikliği izlenir.
create trigger audit_sale_items_upd after update on public.sale_items
  for each row when (old.status is distinct from new.status or old.total_cost is distinct from new.total_cost)
  execute function private.audit_row();
create trigger audit_movements_ins_del after insert or delete on public.inventory_movements
  for each row execute function private.audit_row();
create trigger audit_movements_upd after update on public.inventory_movements
  for each row when (
    old.qty is distinct from new.qty or old.total_cost is distinct from new.total_cost
    or old.cost_known is distinct from new.cost_known or old.voided_at is distinct from new.voided_at)
  execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Maliyet zinciri
-- ---------------------------------------------------------------------------
create or replace function private.movement_priority(t text)
returns smallint language sql immutable parallel safe
set search_path = ''
as $$
  select (case t
    when 'purchase' then 1 when 'customer_return' then 2 when 'sale' then 3
    when 'supplier_return' then 4 when 'waste' then 5 when 'spoilage' then 5
    when 'opening' then 8 when 'count_adjustment' then 9 when 'cost_adjustment' then 10
  end)::smallint
$$;

-- Kâr tablosuna giren hareket türleri (kayıtlı maliyetleri gider/indirim olarak)
create or replace function private.is_pnl_type(t text)
returns boolean language sql immutable parallel safe
set search_path = ''
as $$ select t in ('sale', 'customer_return', 'waste', 'spoilage', 'count_adjustment') $$;

create or replace function private.day_end(d date)
returns timestamptz language sql immutable parallel safe
set search_path = ''
as $$ select private.ist_start(d + 1) - interval '1 second' $$;

create or replace function private.closed_end(p_org uuid)
returns timestamptz language sql stable
set search_path = ''
as $$
  select case when o.closed_through is null then null else private.ist_start(o.closed_through + 1) end
  from public.organizations o where o.id = p_org
$$;

-- Bir ürünün zincirini p_from anından itibaren yeniden hesaplar.
-- Dönen değer: kapalı döneme ait kâr etkisi için oluşturulan düzeltme tutarı (total_cost işaretiyle).
create or replace function private.recompute_chain(
  p_product uuid, p_from timestamptz, p_cause_type text, p_cause_job uuid)
returns numeric language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
  v_closed_end timestamptz;
  v_first_open date;
  v_stock numeric(14,3);
  v_avg numeric(14,4);
  r record;
  n_qty numeric(14,3);
  n_unit numeric(14,4);
  n_total numeric(14,4);
  n_known boolean;
  v_delta numeric(14,4) := 0;
  f_old numeric(14,4);
  f_new numeric(14,4);
begin
  select p.organization_id into v_org from public.products p where p.id = p_product;
  select private.closed_end(v_org) into v_closed_end;
  select o.closed_through + 1 into v_first_open from public.organizations o where o.id = v_org;

  select m.stock_after, m.avg_cost_after into v_stock, v_avg
  from public.inventory_movements m
  where m.product_id = p_product and m.voided_at is null
    and m.movement_type <> 'cost_adjustment' and m.occurred_at < p_from
  order by m.occurred_at desc, m.priority desc, m.seq desc
  limit 1;
  if not found then
    v_stock := 0;
    v_avg := null;
  end if;

  for r in
    select m.* from public.inventory_movements m
    where m.product_id = p_product and m.voided_at is null
      and m.movement_type <> 'cost_adjustment' and m.occurred_at >= p_from
    order by m.occurred_at, m.priority, m.seq
    for update
  loop
    if r.movement_type = 'purchase' then
      n_qty := r.qty;
      n_total := r.input_total_cost;
      n_unit := round(r.input_total_cost / r.qty, 4);
      n_known := true;
      if v_avg is null or v_stock <= 0 then
        v_avg := n_unit;
      else
        v_avg := round((v_stock * v_avg + r.input_total_cost) / (v_stock + r.qty), 4);
      end if;
      v_stock := v_stock + r.qty;
    elsif r.movement_type = 'opening' then
      n_qty := r.snapshot_qty - v_stock;
      v_stock := r.snapshot_qty;
      if r.input_unit_cost is not null then
        v_avg := r.input_unit_cost;
      end if;
      n_unit := v_avg;
      n_total := case when v_avg is null then null else round(r.snapshot_qty * v_avg, 4) end;
      n_known := v_avg is not null;
    elsif r.movement_type = 'count_adjustment' then
      n_qty := r.snapshot_qty - v_stock;
      v_stock := r.snapshot_qty;
      n_unit := v_avg;
      n_total := case when v_avg is null then null else round(n_qty * v_avg, 4) end;
      n_known := v_avg is not null;
    else
      -- satış, iade, fire, bozulma: ortalama maliyetten; ortalama değişmez
      n_qty := r.qty;
      n_unit := v_avg;
      n_total := case when v_avg is null then null else round(r.qty * v_avg, 4) end;
      n_known := v_avg is not null;
      v_stock := v_stock + r.qty;
    end if;

    if v_closed_end is not null and r.occurred_at < v_closed_end then
      -- Kapalı dönem: kayıtlı değerler donuk. Sadece hesap alanları güncellenir.
      if private.is_pnl_type(r.movement_type) and r.cost_known then
        f_old := case when r.calc_cost_known then r.calc_total_cost else r.total_cost end;
        f_new := case when n_known then n_total else r.total_cost end;
        v_delta := v_delta + (f_new - f_old);
      end if;
      update public.inventory_movements set
        calc_qty = n_qty, calc_unit_cost = n_unit, calc_total_cost = n_total, calc_cost_known = n_known,
        stock_after = v_stock, avg_cost_after = v_avg
      where id = r.id;
    else
      if r.calc_qty is not null and private.is_pnl_type(r.movement_type)
         and (r.total_cost is distinct from n_total or r.cost_known is distinct from n_known) then
        insert into public.cost_revisions (organization_id, movement_id, product_id, occurred_at, movement_type,
          old_total_cost, new_total_cost, old_cost_known, new_cost_known, cause_type, cause_job_id)
        values (v_org, r.id, p_product, r.occurred_at, r.movement_type,
          r.total_cost, n_total, r.cost_known, n_known, p_cause_type, p_cause_job);
      end if;
      if r.calc_qty is null or r.qty is distinct from n_qty or r.unit_cost is distinct from n_unit
         or r.total_cost is distinct from n_total or r.cost_known is distinct from n_known
         or r.stock_after is distinct from v_stock or r.avg_cost_after is distinct from v_avg then
        update public.inventory_movements set
          qty = n_qty, unit_cost = n_unit, total_cost = n_total, cost_known = n_known,
          calc_qty = n_qty, calc_unit_cost = n_unit, calc_total_cost = n_total, calc_cost_known = n_known,
          stock_after = v_stock, avg_cost_after = v_avg
        where id = r.id;
        -- satış satırlarına satış anındaki maliyeti yaz
        if r.source_type = 'sales_period_summary' then
          update public.sales_period_summaries s set
            unit_cost = n_unit,
            total_cost = case when n_total is null then null else -n_total end,
            cost_known = n_known
          where s.id = r.source_id;
        elsif r.source_type = 'sale_items_day' then
          update public.sale_items s set
            unit_cost = n_unit,
            total_cost = case when n_unit is null then null else round(s.qty * n_unit, 4) end,
            cost_known = n_known
          where s.movement_id = r.id;
        end if;
      end if;
    end if;
  end loop;

  if v_delta <> 0 then
    insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
      qty, unit_cost, total_cost, cost_known, calc_qty, calc_total_cost, calc_cost_known,
      source_type, import_job_id, note)
    values (v_org, p_product, private.ist_start(v_first_open), private.movement_priority('cost_adjustment'),
      'cost_adjustment', 0, null, v_delta, true, 0, v_delta, true,
      p_cause_type, p_cause_job, 'Kapalı döneme ait maliyet farkı');
  end if;
  return v_delta;
end;
$$;

-- Birden çok ürünü, her biri için en erken etkilenen andan itibaren yeniden hesaplar.
create or replace function private.recompute_many(
  p_products uuid[], p_froms timestamptz[], p_cause_type text, p_cause_job uuid)
returns void language plpgsql
set search_path = ''
as $$
declare r record;
begin
  for r in
    select u.product_id, min(u.from_ts) as from_ts
    from unnest(p_products, p_froms) as u(product_id, from_ts)
    group by u.product_id
  loop
    perform private.recompute_chain(r.product_id, r.from_ts, p_cause_type, p_cause_job);
  end loop;
end;
$$;

-- Bir işin kâr etkisi özeti (önizleme ve sonuç ekranı için)
create or replace function private.job_effects(p_job uuid, p_cause_type text)
returns jsonb language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', x.month, 'profit_delta', x.profit_delta::text, 'count', x.cnt,
        'became_known', x.became_known, 'became_unknown', x.became_unknown) order by x.month)
      from (
        select private.month_of(private.ist_date(c.occurred_at)) as month,
               sum(case when c.old_cost_known and c.new_cost_known
                        then c.new_total_cost - c.old_total_cost else 0 end) as profit_delta,
               count(*) as cnt,
               count(*) filter (where not c.old_cost_known and c.new_cost_known) as became_known,
               count(*) filter (where c.old_cost_known and not c.new_cost_known) as became_unknown
        from public.cost_revisions c
        where c.cause_job_id = p_job and c.cause_type = p_cause_type
        group by 1
      ) x), '[]'::jsonb),
    'closed_adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('month', y.month, 'profit_delta', y.amount::text, 'products', y.cnt))
      from (
        select private.month_of(private.ist_date(m.occurred_at)) as month,
               sum(m.total_cost) as amount, count(distinct m.product_id) as cnt
        from public.inventory_movements m
        where m.import_job_id = p_job and m.movement_type = 'cost_adjustment'
          and m.source_type = p_cause_type and m.voided_at is null
        group by 1
      ) y), '[]'::jsonb)
  )
$$;

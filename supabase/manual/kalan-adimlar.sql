-- KârDedektifi — kalan kurulum adımları (Supabase SQL Editor için)
-- İçerik: geri alma fonksiyonları + 007 raporlar + 008 güvenlik/RLS + 009 depolama.
-- Tamamı tek transaction: bir hata olursa hiçbir şey uygulanmaz.

begin;

-- 006 (devamı): geri alma
create or replace function private.apply_revert(p_job uuid, p_reason text)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  j public.import_jobs;
  v_closed date;
  v_closed_end timestamptz;
  v_products uuid[];
  v_froms timestamptz[];
  v_voided int;
  v_ver bigint;
  v_res jsonb;
begin
  select * into j from public.import_jobs where id = p_job for update;
  if not found then
    raise exception 'Aktarım bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(j.organization_id);
  perform private.lock_org(j.organization_id);
  if j.status <> 'committed' then
    raise exception 'Sadece işlenmiş aktarımlar geri alınabilir (durum: %).', j.status using errcode = 'KDSTA';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Geri alma nedeni yazın (en az 3 karakter).' using errcode = 'KDVAL';
  end if;
  select o.closed_through into v_closed from public.organizations o where o.id = j.organization_id;
  v_closed_end := private.closed_end(j.organization_id);
  if v_closed_end is not null and (
    exists (select 1 from public.inventory_movements m where m.import_job_id = j.id and m.voided_at is null
            and private.is_pnl_type(m.movement_type) and m.occurred_at < v_closed_end)
    or exists (select 1 from public.sales_period_summaries s where s.import_job_id = j.id and s.status = 'active'
               and s.period_start <= v_closed)) then
    raise exception 'Bu aktarım kapalı bir döneme ait satış veya sayım kaydı içeriyor. Geri almak için önce o dönemi yeniden açın.'
      using errcode = 'KDCLS';
  end if;

  select array_agg(m.product_id), array_agg(m.occurred_at) into v_products, v_froms
  from public.inventory_movements m
  where m.import_job_id = j.id and m.voided_at is null and m.movement_type <> 'cost_adjustment';

  -- Kapalı dönem düzeltmeleri iptal edilmez: zincir yeniden hesaplanınca karşı düzeltme oluşur.
  update public.inventory_movements set voided_at = now(), voided_by = auth.uid(),
    void_reason = 'Aktarım geri alındı: ' || trim(p_reason)
  where import_job_id = j.id and voided_at is null and movement_type <> 'cost_adjustment';
  get diagnostics v_voided = row_count;

  if j.kind = 'product_list' then
    delete from public.tax_rates where import_job_id = j.id;
    update public.tax_rates set valid_to = null, closed_by_import_job_id = null where closed_by_import_job_id = j.id;
    delete from public.product_price_history where import_job_id = j.id;
    update public.products p set is_active = false
    where p.created_by_import_job_id = j.id
      and not exists (select 1 from public.inventory_movements m where m.product_id = p.id and m.voided_at is null)
      and not exists (select 1 from public.purchase_items it join public.purchase_invoices pi on pi.id = it.invoice_id
                      where it.product_id = p.id and pi.status in ('draft', 'posted'))
      and not exists (select 1 from public.sales_period_summaries s where s.product_id = p.id and s.status = 'active')
      and not exists (select 1 from public.sale_items si where si.product_id = p.id and si.status = 'active');
  elsif j.kind = 'sales_summary' then
    update public.sales_period_summaries set status = 'reversed' where import_job_id = j.id and status = 'active';
  elsif j.kind = 'sales_receipts' then
    update public.sale_items set status = 'reversed' where import_job_id = j.id and status = 'active';
  else
    update public.purchase_invoices set status = 'reversed' where import_job_id = j.id and status = 'posted';
  end if;
  update public.alerts set status = 'resolved', resolved_at = now()
  where import_job_id = j.id and status = 'open';

  if v_products is not null then
    perform private.recompute_many(v_products, v_froms, 'revert', j.id);
  end if;

  v_ver := private.bump_ledger(j.organization_id);
  v_res := jsonb_build_object('voided_movements', v_voided) || private.job_effects(j.id, 'revert')
           || jsonb_build_object('ledger_version', v_ver);
  update public.import_jobs set status = 'reverted', reverted_at = now(), reverted_by = auth.uid(),
    revert_reason = trim(p_reason), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('revert', v_res)
  where id = j.id;
  perform private.create_revision_alert(j.organization_id, j.id, 'revert', v_res);
  return v_res;
end;
$$;

create or replace function public.preview_revert(p_job uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_ver bigint;
  v_res jsonb;
begin
  select ij.organization_id into v_org from public.import_jobs ij where ij.id = p_job;
  if v_org is null then
    raise exception 'Aktarım bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(v_org);
  select o.ledger_version into v_ver from public.organizations o where o.id = v_org;
  begin
    v_res := private.apply_revert(p_job, 'önizleme');
    raise exception 'preview-rollback' using errcode = 'KDPRV';
  exception when sqlstate 'KDPRV' then
    null;
  end;
  return v_res || jsonb_build_object('ledger_version', v_ver, 'preview', true);
end;
$$;

create or replace function public.revert_import(p_job uuid, p_reason text, p_expected_version bigint)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_org uuid;
begin
  select ij.organization_id into v_org from public.import_jobs ij where ij.id = p_job;
  if v_org is null then
    raise exception 'Aktarım bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(v_org);
  perform private.lock_org(v_org);
  perform private.assert_ledger_version(v_org, p_expected_version);
  return private.apply_revert(p_job, p_reason);
end;
$$;



-- ===== 20261108000007_reports.sql =====
-- Raporlar. Hepsi security invoker: RLS geçerli, kullanıcı sadece kendi işletmesini görür.
-- Para/miktar değerleri metin olarak döner (JSON number hassasiyet kaybını önlemek için).

create or replace view public.product_overview with (security_invoker = true) as
select
  p.id, p.organization_id, p.name, p.barcode, p.code, p.base_unit, p.category_id, c.name as category_name,
  p.is_active, p.is_weighed, p.shelf_life_days, p.created_at,
  st.stock_after::text as stock_qty,
  st.avg_cost_after::text as avg_cost,
  case when st.stock_after > 0 and st.avg_cost_after is not null
       then round(st.stock_after * st.avg_cost_after, 4)::text end as stock_value,
  lp.input_unit_cost::text as last_purchase_cost,
  lp.occurred_at as last_purchase_at,
  pr.sale_price_gross::text as sale_price_gross,
  pr.valid_from as sale_price_date,
  pr.list_purchase_price_net::text as list_purchase_price_net,
  vr.rate::text as vat_rate,
  ls.last_sale_at,
  fm.first_movement_at,
  -- sıralama anahtarları (istemci bunları okumaz, sadece order by için)
  coalesce(st.stock_after, 0) as stock_sort,
  case when st.stock_after > 0 and st.avg_cost_after is not null
       then st.stock_after * st.avg_cost_after else 0 end as value_sort
from public.products p
left join public.categories c on c.id = p.category_id
left join lateral (
  select m.stock_after, m.avg_cost_after from public.inventory_movements m
  where m.product_id = p.id and m.voided_at is null and m.movement_type <> 'cost_adjustment'
  order by m.occurred_at desc, m.priority desc, m.seq desc limit 1) st on true
left join lateral (
  select m.input_unit_cost, m.occurred_at from public.inventory_movements m
  where m.product_id = p.id and m.voided_at is null and m.movement_type = 'purchase'
  order by m.occurred_at desc, m.seq desc limit 1) lp on true
left join lateral (
  select h.sale_price_gross, h.valid_from, h.list_purchase_price_net from public.product_price_history h
  where h.product_id = p.id order by h.valid_from desc, h.created_at desc limit 1) pr on true
left join lateral (
  select t.rate from public.tax_rates t
  where t.product_id = p.id and t.valid_from <= (now() at time zone 'Europe/Istanbul')::date
    and (t.valid_to is null or t.valid_to >= (now() at time zone 'Europe/Istanbul')::date)
  limit 1) vr on true
left join lateral (
  select max(m.occurred_at) as last_sale_at from public.inventory_movements m
  where m.product_id = p.id and m.voided_at is null and m.movement_type = 'sale' and m.qty < 0) ls on true
left join lateral (
  select min(m.occurred_at) as first_movement_at from public.inventory_movements m
  where m.product_id = p.id and m.voided_at is null and m.movement_type <> 'cost_adjustment') fm on true;

-- Kâr tablosu girdileri (birleştirme TypeScript'te decimal.js ile yapılır)
create or replace function public.pnl_summary(p_org uuid, p_from date, p_to date)
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  with b as (
    select (p_from::timestamp at time zone 'Europe/Istanbul') as s,
           ((p_to + 1)::timestamp at time zone 'Europe/Istanbul') as e
  ),
  sales as (
    select coalesce(sum(x.net), 0) as net_total,
           coalesce(sum(x.net) filter (where x.known), 0) as net_known,
           coalesce(sum(x.net) filter (where not x.known), 0) as net_unknown,
           coalesce(sum(x.gross), 0) as gross_total,
           count(*) filter (where not x.known) as unknown_rows,
           count(*) as rows
    from (
      select s.net_amount as net, s.gross_amount as gross, s.cost_known as known
      from public.sales_period_summaries s
      where s.organization_id = p_org and s.status = 'active' and s.period_end between p_from and p_to
      union all
      select i.net_amount, i.gross_amount, i.cost_known
      from public.sale_items i, b
      where i.organization_id = p_org and i.status = 'active' and i.sold_at >= b.s and i.sold_at < b.e
    ) x
  ),
  mv as (
    select
      coalesce(-sum(m.total_cost) filter (where m.movement_type in ('sale', 'customer_return') and m.cost_known), 0) as cogs,
      coalesce(-sum(m.total_cost) filter (where m.movement_type = 'waste' and m.cost_known), 0) as waste,
      coalesce(-sum(m.total_cost) filter (where m.movement_type = 'spoilage' and m.cost_known), 0) as spoilage,
      coalesce(-sum(m.total_cost) filter (where m.movement_type = 'count_adjustment' and m.cost_known), 0) as count_diff,
      coalesce(-sum(m.total_cost) filter (where m.movement_type = 'cost_adjustment'), 0) as cost_adjustment,
      count(*) filter (where m.movement_type in ('waste', 'spoilage', 'count_adjustment') and not m.cost_known) as shrink_unknown
    from public.inventory_movements m, b
    where m.organization_id = p_org and m.voided_at is null and m.occurred_at >= b.s and m.occurred_at < b.e
  ),
  rb as (
    select coalesce(sum(r.amount), 0) as rebates
    from public.supplier_rebates r
    where r.organization_id = p_org and r.month >= date_trunc('month', p_from)::date and r.month <= p_to
  ),
  ex as (
    select coalesce(sum(e.amount) filter (where e.status = 'approved'), 0) as expenses,
           count(*) filter (where e.status = 'pending') as pending
    from public.expenses e
    where e.organization_id = p_org and e.month >= date_trunc('month', p_from)::date and e.month <= p_to
  ),
  sv as (
    select coalesce(sum(case when l.stock_after > 0 and l.avg_cost_after is not null
                             then round(l.stock_after * l.avg_cost_after, 4) else 0 end), 0) as stock_value,
           count(*) filter (where l.stock_after > 0 and l.avg_cost_after is null) as stock_unknown_cost
    from public.products p, b
    cross join lateral (
      select m.stock_after, m.avg_cost_after from public.inventory_movements m
      where m.product_id = p.id and m.voided_at is null and m.movement_type <> 'cost_adjustment' and m.occurred_at < b.e
      order by m.occurred_at desc, m.priority desc, m.seq desc limit 1) l
    where p.organization_id = p_org
  ),
  cov as (
    select count(distinct d) as days
    from (
      select generate_series(greatest(s.period_start, p_from), least(s.period_end, p_to), interval '1 day')::date as d
      from public.sales_period_summaries s
      where s.organization_id = p_org and s.status = 'active' and s.period_end between p_from and p_to
      union
      select (i.sold_at at time zone 'Europe/Istanbul')::date
      from public.sale_items i, b
      where i.organization_id = p_org and i.status = 'active' and i.sold_at >= b.s and i.sold_at < b.e
    ) z
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'net_sales', sales.net_total::text, 'net_sales_known_cost', sales.net_known::text,
    'net_sales_unknown_cost', sales.net_unknown::text, 'gross_sales', sales.gross_total::text,
    'sales_rows', sales.rows, 'unknown_cost_rows', sales.unknown_rows,
    'cogs', mv.cogs::text, 'waste', mv.waste::text, 'spoilage', mv.spoilage::text,
    'count_diff', mv.count_diff::text, 'cost_adjustment', mv.cost_adjustment::text,
    'shrink_unknown_rows', mv.shrink_unknown,
    'rebates', rb.rebates::text, 'expenses', ex.expenses::text, 'pending_expenses', ex.pending,
    'stock_value', sv.stock_value::text, 'stock_unknown_cost_products', sv.stock_unknown_cost,
    'covered_days', cov.days, 'period_days', (p_to - p_from + 1))
  from sales, mv, rb, ex, sv, cov
$$;

-- Ürün bazında kârlılık (sadece maliyeti bilinen satışlar kâra girer)
create or replace function public.product_profit(p_org uuid, p_from date, p_to date)
returns table (product_id uuid, name text, base_unit text, qty text, net_sales text, cogs text,
               gross_profit text, margin_pct text, unknown_cost_net text)
language sql stable security invoker
set search_path = ''
as $$
  with b as (
    select (p_from::timestamp at time zone 'Europe/Istanbul') as s,
           ((p_to + 1)::timestamp at time zone 'Europe/Istanbul') as e
  ),
  x as (
    select s.product_id, s.qty, s.net_amount as net, s.total_cost as cost, s.cost_known as known
    from public.sales_period_summaries s
    where s.organization_id = p_org and s.status = 'active' and s.period_end between p_from and p_to
    union all
    select i.product_id, i.qty, i.net_amount, i.total_cost, i.cost_known
    from public.sale_items i, b
    where i.organization_id = p_org and i.status = 'active' and i.sold_at >= b.s and i.sold_at < b.e
  ),
  agg as (
    select x.product_id,
      sum(x.qty) as qty,
      coalesce(sum(x.net) filter (where x.known), 0) as net_known,
      coalesce(sum(x.cost) filter (where x.known), 0) as cogs,
      coalesce(sum(x.net) filter (where not x.known), 0) as net_unknown
    from x group by x.product_id
  )
  select p.id, p.name, p.base_unit, agg.qty::text, agg.net_known::text, agg.cogs::text,
    (agg.net_known - agg.cogs)::text,
    case when agg.net_known > 0 then round((agg.net_known - agg.cogs) / agg.net_known * 100, 2)::text end,
    agg.net_unknown::text
  from agg join public.products p on p.id = agg.product_id
$$;

-- Gider karşılaştırması: bu ay, önceki ay, geçen yılın aynı ayı (onaylı giderler)
create or replace function public.expense_comparison(p_org uuid, p_month date)
returns table (category_id uuid, code text, name text, sort_order integer,
               this_month text, prev_month text, last_year text)
language sql stable security invoker
set search_path = ''
as $$
  with m as (select date_trunc('month', p_month)::date as cur)
  select c.id, c.code, c.name, c.sort_order,
    coalesce(sum(e.amount) filter (where e.month = m.cur), 0)::text,
    coalesce(sum(e.amount) filter (where e.month = (m.cur - interval '1 month')::date), 0)::text,
    coalesce(sum(e.amount) filter (where e.month = (m.cur - interval '1 year')::date), 0)::text
  from public.expense_categories c
  cross join m
  left join public.expenses e on e.category_id = c.id and e.status = 'approved'
    and e.month in (m.cur, (m.cur - interval '1 month')::date, (m.cur - interval '1 year')::date)
  where c.organization_id = p_org
  group by c.id, c.code, c.name, c.sort_order
$$;

-- Tahmin girdisi: ürün bazlı satış miktarları (özetler olduğu gibi, fişler günlük toplam)
create or replace function public.sales_history(p_org uuid, p_from date)
returns table (product_id uuid, period_start date, period_end date, qty text)
language sql stable security invoker
set search_path = ''
as $$
  select s.product_id, s.period_start, s.period_end, s.qty::text
  from public.sales_period_summaries s
  where s.organization_id = p_org and s.status = 'active' and s.period_end >= p_from
  union all
  select i.product_id, d, d, sum(i.qty)::text
  from public.sale_items i
  cross join lateral (select (i.sold_at at time zone 'Europe/Istanbul')::date as d) dd
  where i.organization_id = p_org and i.status = 'active' and dd.d >= p_from
  group by i.product_id, d
$$;

-- Belirli bir günün sonundaki hesaplanan stok (ürün listesi karşılaştırması için)
create or replace function public.stock_levels_at(p_org uuid, p_date date)
returns table (product_id uuid, stock text, has_opening boolean)
language sql stable security invoker
set search_path = ''
as $$
  select p.id, l.stock_after::text,
    exists (select 1 from public.inventory_movements o where o.product_id = p.id
            and o.movement_type = 'opening' and o.voided_at is null)
  from public.products p
  left join lateral (
    select m.stock_after from public.inventory_movements m
    where m.product_id = p.id and m.voided_at is null and m.movement_type <> 'cost_adjustment'
      and m.occurred_at < ((p_date + 1)::timestamp at time zone 'Europe/Istanbul')
    order by m.occurred_at desc, m.priority desc, m.seq desc limit 1) l on true
  where p.organization_id = p_org
$$;

-- Yoldaki siparişler: "sipariş verildi" işaretlenmiş, sonrasında o tedarikçiden o ürün için
-- fatura işlenmemiş öneri satırları (son 45 gün).
create or replace function public.on_order_quantities(p_org uuid)
returns table (product_id uuid, qty text)
language sql stable security invoker
set search_path = ''
as $$
  select f.product_id, sum(f.ordered_qty)::text
  from public.forecast_items f
  where f.organization_id = p_org and f.ordered_at is not null and f.ordered_qty > 0
    and f.ordered_at > now() - interval '45 days'
    and not exists (
      select 1 from public.purchase_items it
      join public.purchase_invoices pi on pi.id = it.invoice_id
      where it.product_id = f.product_id and pi.status = 'posted'
        and (f.supplier_id is null or pi.supplier_id = f.supplier_id)
        and pi.invoice_date >= (f.ordered_at at time zone 'Europe/Istanbul')::date)
  group by f.product_id
$$;

-- Ürün maliyet geçmişi (detay ekranı)
create or replace function public.product_cost_history(p_product uuid)
returns table (occurred_at timestamptz, movement_type text, qty text, unit_cost text,
               avg_cost_after text, stock_after text, invoice_no text, supplier text)
language sql stable security invoker
set search_path = ''
as $$
  select m.occurred_at, m.movement_type, m.qty::text, coalesce(m.input_unit_cost, m.unit_cost)::text,
    m.avg_cost_after::text, m.stock_after::text, pi.invoice_no, s.name
  from public.inventory_movements m
  left join public.purchase_items it on m.source_type = 'purchase_item' and it.id = m.source_id
  left join public.purchase_invoices pi on pi.id = it.invoice_id
  left join public.suppliers s on s.id = pi.supplier_id
  where m.product_id = p_product and m.voided_at is null and m.movement_type in ('opening', 'purchase')
  order by m.occurred_at, m.seq
$$;

-- ===== 20261108000008_security.sql =====
-- Güvenlik: RLS politikaları ve yetkiler.
-- Kural: bir işletme başka işletmenin verisini hiçbir yoldan göremez.
-- Defteri etkileyen tablolar istemciden sadece okunur; yazma RPC fonksiyonlarıyla olur.

-- ---------------------------------------------------------------------------
-- Önce her şeyi kapat
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

grant usage on schema public to authenticated;
grant usage on schema private to authenticated;
grant execute on function private.my_org_ids() to authenticated;
-- Üretilen sütunlar ve tetikleyiciler için gereken saf yardımcılar
grant execute on function private.normalize_name(text) to authenticated;
grant execute on function private.ist_start(date), private.ist_date(timestamptz), private.month_of(date),
  private.day_end(date) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: tüm tablolar
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    -- FORCE kullanılmaz: tablo sahibi olarak çalışan security definer RPC'ler kendi
    -- üyelik kontrollerini yapar (private.assert_member).
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- organizations: sadece üyesi olunan işletmeler, sadece okuma
create policy organizations_select on public.organizations for select to authenticated
  using (id = any ((select private.my_org_ids())::uuid[]));
grant select on public.organizations to authenticated;

-- profiles: kişi kendi profilini görür ve düzenler
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy organization_members_select on public.organization_members for select to authenticated
  using (organization_id = any ((select private.my_org_ids())::uuid[]));
grant select on public.organization_members to authenticated;

-- Yardımcı: standart "işletme üyesi" politikaları
do $$
declare
  t text;
begin
  -- sadece okunan tablolar
  foreach t in array array[
    'audit_log', 'tax_rates', 'product_price_history', 'purchase_invoices', 'purchase_items',
    'sales_period_summaries', 'sale_items', 'inventory_movements', 'cost_revisions', 'expense_categories'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (organization_id = any ((select private.my_org_ids())::uuid[]))',
      t || '_select', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;

  -- okunup yazılabilen tablolar (değişmez kurallar trigger ve kısıtlarla korunur)
  foreach t in array array[
    'categories', 'products', 'product_units', 'suppliers', 'supplier_product_aliases', 'product_suppliers',
    'supplier_rebates', 'import_profiles', 'alerts', 'expenses', 'recurring_expenses',
    'forecast_runs', 'forecast_items', 'period_markers'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (organization_id = any ((select private.my_org_ids())::uuid[]))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (organization_id = any ((select private.my_org_ids())::uuid[]))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (organization_id = any ((select private.my_org_ids())::uuid[])) with check (organization_id = any ((select private.my_org_ids())::uuid[]))',
      t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (organization_id = any ((select private.my_org_ids())::uuid[]))',
      t || '_delete', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;

-- Sütun bazlı yazma yetkileri
grant insert (organization_id, name) on public.categories to authenticated;
grant update (name) on public.categories to authenticated;
grant delete on public.categories to authenticated;

grant insert (organization_id, name, barcode, code, base_unit, category_id, is_weighed, shelf_life_days)
  on public.products to authenticated;
grant update (name, barcode, code, base_unit, category_id, is_weighed, shelf_life_days, is_active)
  on public.products to authenticated;

grant insert (organization_id, product_id, name, factor, barcode) on public.product_units to authenticated;
grant update (name, barcode) on public.product_units to authenticated;
grant delete on public.product_units to authenticated;

grant insert (organization_id, name, tax_number, lead_time_days, order_interval_days, min_order_amount, phone, notes)
  on public.suppliers to authenticated;
grant update (name, tax_number, lead_time_days, order_interval_days, min_order_amount, phone, notes, is_active)
  on public.suppliers to authenticated;

grant delete on public.supplier_product_aliases to authenticated;

grant insert (organization_id, product_id, supplier_id, is_primary, order_unit_name, order_unit_factor, min_order_qty)
  on public.product_suppliers to authenticated;
grant update (is_primary, order_unit_name, order_unit_factor, min_order_qty) on public.product_suppliers to authenticated;
grant delete on public.product_suppliers to authenticated;

grant insert (organization_id, supplier_id, month, amount, description) on public.supplier_rebates to authenticated;
grant delete on public.supplier_rebates to authenticated;

grant insert (organization_id, name, source_system, kind, header_signature, headers, header_row, sheet_name,
              column_map, options) on public.import_profiles to authenticated;
grant update (name, source_system, header_row, sheet_name, column_map, options, updated_at)
  on public.import_profiles to authenticated;
grant delete on public.import_profiles to authenticated;

grant update (status, resolved_at) on public.alerts to authenticated;

grant insert (organization_id, category_id, month, amount, vat_amount, description) on public.expenses to authenticated;
grant update (category_id, month, amount, vat_amount, description, status, approved_at) on public.expenses to authenticated;
grant delete on public.expenses to authenticated;

grant insert (organization_id, category_id, description, amount, vat_amount, start_month, end_month)
  on public.recurring_expenses to authenticated;
grant update (category_id, description, amount, vat_amount, end_month, is_active) on public.recurring_expenses to authenticated;
grant delete on public.recurring_expenses to authenticated;

grant insert (organization_id, algorithm_version, params, data_summary) on public.forecast_runs to authenticated;
grant insert (organization_id, run_id, product_id, supplier_id, weekly_demand, trend_pct, weeks_of_data, observations,
              stock_on_hand, on_order, safety_stock, suggested_qty, order_unit_name, order_unit_factor,
              suggested_units, range_low_units, range_high_units, confidence, reason, inputs)
  on public.forecast_items to authenticated;
grant update (ordered_at, ordered_qty) on public.forecast_items to authenticated;

grant insert (organization_id, name, start_date, end_date, multiplier, category_id) on public.period_markers to authenticated;
grant update (name, start_date, end_date, multiplier, category_id) on public.period_markers to authenticated;
grant delete on public.period_markers to authenticated;

-- Ürün silinmez (pasife alınır); bu yüzden products için delete yetkisi yok.
-- Alias / ürün-tedarikçi gibi yazılabilir tablolarda kimlik alanları değiştirilemez (sütun yetkisi verilmedi).

-- Aktarım işleri: sadece "staged" durumda oluşturulur ve düzenlenir; durum geçişleri RPC ile.
create policy import_jobs_select on public.import_jobs for select to authenticated
  using (organization_id = any ((select private.my_org_ids())::uuid[]));
create policy import_jobs_insert on public.import_jobs for insert to authenticated
  with check (organization_id = any ((select private.my_org_ids())::uuid[]) and status = 'staged');
create policy import_jobs_update on public.import_jobs for update to authenticated
  using (organization_id = any ((select private.my_org_ids())::uuid[]) and status = 'staged')
  with check (organization_id = any ((select private.my_org_ids())::uuid[]) and status = 'staged');
grant select on public.import_jobs to authenticated;
grant insert (organization_id, kind, profile_id, file_name, storage_path, file_hash, file_size, params,
              row_count, ok_count, warning_count, error_count) on public.import_jobs to authenticated;
grant update (profile_id, storage_path, params, row_count, ok_count, warning_count, error_count)
  on public.import_jobs to authenticated;

create policy import_rows_select on public.import_rows for select to authenticated
  using (organization_id = any ((select private.my_org_ids())::uuid[]));
create policy import_rows_insert on public.import_rows for insert to authenticated
  with check (organization_id = any ((select private.my_org_ids())::uuid[]) and exists (
    select 1 from public.import_jobs j where j.id = job_id and j.organization_id = import_rows.organization_id
      and j.status = 'staged'));
create policy import_rows_update on public.import_rows for update to authenticated
  using (organization_id = any ((select private.my_org_ids())::uuid[]) and exists (
    select 1 from public.import_jobs j where j.id = job_id and j.status = 'staged'))
  with check (organization_id = any ((select private.my_org_ids())::uuid[]) and exists (
    select 1 from public.import_jobs j where j.id = job_id and j.organization_id = import_rows.organization_id
      and j.status = 'staged'));
create policy import_rows_delete on public.import_rows for delete to authenticated
  using (organization_id = any ((select private.my_org_ids())::uuid[]) and exists (
    select 1 from public.import_jobs j where j.id = job_id and j.status = 'staged'));
grant select, delete on public.import_rows to authenticated;
grant insert (organization_id, job_id, row_number, raw, parsed, status, messages, product_id) on public.import_rows to authenticated;
grant update (parsed, status, messages, product_id) on public.import_rows to authenticated;

-- İlişkili kayıtlar başka işletmeye bağlanamasın: yazılabilir tablolarda yabancı anahtarlar
-- aynı işletmeye ait olmalı.
create or replace function private.guard_same_org()
returns trigger language plpgsql
set search_path = ''
as $$
declare
  v_col text;
  v_table text;
  v_id uuid;
  v_ok boolean;
begin
  foreach v_col in array tg_argv loop
    v_table := split_part(v_col, ':', 2);
    v_id := (to_jsonb(new) ->> split_part(v_col, ':', 1))::uuid;
    if v_id is not null then
      execute format('select exists (select 1 from public.%I where id = $1 and organization_id = $2)', v_table)
        into v_ok using v_id, new.organization_id;
      if not v_ok then
        raise exception 'İlişkili kayıt bu işletmeye ait değil.' using errcode = '42501';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

create trigger same_org_products before insert or update on public.products
  for each row execute function private.guard_same_org('category_id:categories');
create trigger same_org_product_units before insert or update on public.product_units
  for each row execute function private.guard_same_org('product_id:products');
create trigger same_org_product_suppliers before insert or update on public.product_suppliers
  for each row execute function private.guard_same_org('product_id:products', 'supplier_id:suppliers');
create trigger same_org_rebates before insert or update on public.supplier_rebates
  for each row execute function private.guard_same_org('supplier_id:suppliers');
create trigger same_org_expenses before insert or update on public.expenses
  for each row execute function private.guard_same_org('category_id:expense_categories', 'recurring_expense_id:recurring_expenses');
create trigger same_org_recurring before insert or update on public.recurring_expenses
  for each row execute function private.guard_same_org('category_id:expense_categories');
create trigger same_org_forecast_items before insert or update on public.forecast_items
  for each row execute function private.guard_same_org('run_id:forecast_runs', 'product_id:products', 'supplier_id:suppliers');
create trigger same_org_period_markers before insert or update on public.period_markers
  for each row execute function private.guard_same_org('category_id:categories');
create trigger same_org_import_jobs before insert or update on public.import_jobs
  for each row execute function private.guard_same_org('profile_id:import_profiles');
create trigger same_org_import_rows before insert or update on public.import_rows
  for each row execute function private.guard_same_org('job_id:import_jobs', 'product_id:products');

-- guard_same_org dinamik SQL çalıştırır; tetikleyen kullanıcının RLS'i altında çalışır,
-- yani başka işletmenin kaydı zaten görünmez ve kontrol başarısız olur.

-- ---------------------------------------------------------------------------
-- RPC ve rapor fonksiyonları
-- ---------------------------------------------------------------------------
grant select on public.product_overview to authenticated;

grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.update_organization_settings(uuid, text, text, integer, text) to authenticated;
grant execute on function public.preview_commit(uuid) to authenticated;
grant execute on function public.commit_import(uuid, bigint) to authenticated;
grant execute on function public.preview_revert(uuid) to authenticated;
grant execute on function public.revert_import(uuid, text, bigint) to authenticated;
grant execute on function public.cancel_import(uuid) to authenticated;
grant execute on function public.stage_purchase_invoice(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.match_purchase_item(uuid, uuid, text, text, boolean) to authenticated;
grant execute on function public.ignore_purchase_item(uuid, boolean) to authenticated;
grant execute on function public.create_product_for_item(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.add_manual_movement(uuid, text, text, date, text) to authenticated;
grant execute on function public.void_manual_movement(uuid, text) to authenticated;
grant execute on function public.set_vat_rate(uuid, uuid[], text, date) to authenticated;
grant execute on function public.close_period(uuid, date) to authenticated;
grant execute on function public.reopen_period(uuid, date) to authenticated;
grant execute on function public.generate_recurring_expenses(uuid, date) to authenticated;
grant execute on function public.pnl_summary(uuid, date, date) to authenticated;
grant execute on function public.product_profit(uuid, date, date) to authenticated;
grant execute on function public.expense_comparison(uuid, date) to authenticated;
grant execute on function public.sales_history(uuid, date) to authenticated;
grant execute on function public.stock_levels_at(uuid, date) to authenticated;
grant execute on function public.on_order_quantities(uuid) to authenticated;
grant execute on function public.product_cost_history(uuid) to authenticated;

-- ===== 20261108000009_storage.sql =====
-- Yüklenen kaynak dosyalar: özel bucket, yol = <organization_id>/<job_id>/<dosya>
-- Yerel test veritabanında storage şeması yoktur; bu durumda atlanır.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('imports', 'imports', false, 10485760, null)
    on conflict (id) do update set public = false, file_size_limit = 10485760;

    execute $p$
      create policy imports_select on storage.objects for select to authenticated
      using (bucket_id = 'imports'
             and (storage.foldername(name))[1]::uuid = any ((select private.my_org_ids())::uuid[]))
    $p$;
    execute $p$
      create policy imports_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'imports'
             and (storage.foldername(name))[1]::uuid = any ((select private.my_org_ids())::uuid[]))
    $p$;
  end if;
end;
$$;

commit;

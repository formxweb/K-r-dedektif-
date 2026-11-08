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

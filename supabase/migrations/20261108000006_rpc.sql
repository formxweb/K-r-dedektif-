-- İş kuralları: işletme oluşturma, aktarım işleme/geri alma, fatura eşleştirme,
-- elle stok hareketi, KDV, dönem kapatma, tekrarlayan giderler.
-- Defteri değiştiren her işlem: üyelik kontrolü → işletme kilidi → işlem → ledger_version++

-- ---------------------------------------------------------------------------
-- İşletme
-- ---------------------------------------------------------------------------
create or replace function public.create_organization(p_name text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'Oturum bulunamadı. Lütfen tekrar giriş yapın.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'İşletme adı en az 2 karakter olmalı.' using errcode = 'KDVAL';
  end if;
  if (select count(*) from public.organization_members m where m.user_id = v_uid and m.role = 'owner') >= 5 then
    raise exception 'Bir hesapla en fazla 5 işletme oluşturulabilir.' using errcode = 'KDVAL';
  end if;
  insert into public.organizations (name, created_by) values (trim(p_name), v_uid) returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.expense_categories (organization_id, code, name, sort_order) values
    (v_org, 'rent', 'Kira', 1), (v_org, 'staff', 'Personel', 2), (v_org, 'sgk', 'SGK', 3),
    (v_org, 'electricity', 'Elektrik', 4), (v_org, 'water', 'Su', 5), (v_org, 'gas', 'Doğalgaz', 6),
    (v_org, 'telecom', 'İnternet / telefon', 7), (v_org, 'accounting', 'Muhasebe', 8),
    (v_org, 'tax', 'Vergi / harç', 9), (v_org, 'shipping', 'Nakliye', 10),
    (v_org, 'pos_fee', 'POS / banka komisyonu', 11), (v_org, 'maintenance', 'Bakım-onarım', 12),
    (v_org, 'other', 'Diğer', 13);
  return v_org;
end;
$$;

create or replace function public.update_organization_settings(
  p_org uuid, p_name text, p_margin_threshold text, p_dead_stock_days integer, p_rounding_step text)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.assert_admin(p_org);
  update public.organizations set
    name = coalesce(nullif(trim(p_name), ''), name),
    margin_alert_threshold_pts = coalesce(nullif(p_margin_threshold, '')::numeric, margin_alert_threshold_pts),
    dead_stock_days = coalesce(p_dead_stock_days, dead_stock_days),
    price_rounding_step = coalesce(nullif(p_rounding_step, '')::numeric, price_rounding_step)
  where id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Aktarım: ürün / stok listesi
-- ---------------------------------------------------------------------------
create or replace function private.apply_product_list(j public.import_jobs)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := j.organization_id;
  v_date date := (j.params ->> 'stock_date')::date;
  v_closed date;
  v_ts timestamptz;
  r record;
  p jsonb;
  v_pid uuid;
  v_cat uuid;
  v_unit text;
  v_rate numeric;
  v_cur public.tax_rates;
  v_last record;
  v_sale numeric;
  v_list numeric;
  v_stock numeric;
  v_products uuid[] := '{}';
  v_froms timestamptz[] := '{}';
  v_created int := 0; v_updated int := 0; v_prices int := 0; v_vat int := 0;
  v_openings int := 0; v_counts int := 0;
begin
  if v_date is null then
    raise exception 'Listenin hangi tarihin stoğunu gösterdiği seçilmedi.' using errcode = 'KDVAL';
  end if;
  if v_date > private.ist_date(now()) then
    raise exception 'Stok tarihi gelecekte olamaz.' using errcode = 'KDVAL';
  end if;
  select o.closed_through into v_closed from public.organizations o where o.id = v_org;
  v_ts := private.day_end(v_date);

  for r in
    select * from public.import_rows ir
    where ir.job_id = j.id and ir.status in ('ok', 'warning')
    order by ir.row_number
  loop
    p := r.parsed;
    v_pid := null;
    if nullif(p ->> 'barcode', '') is not null then
      select id into v_pid from public.products where organization_id = v_org and barcode = p ->> 'barcode';
    end if;
    if v_pid is null and nullif(p ->> 'code', '') is not null then
      select id into v_pid from public.products where organization_id = v_org and code = p ->> 'code';
    end if;
    if v_pid is null and r.product_id is not null then
      select id into v_pid from public.products where organization_id = v_org and id = r.product_id;
    end if;

    v_cat := null;
    if nullif(trim(p ->> 'category'), '') is not null then
      insert into public.categories (organization_id, name) values (v_org, trim(p ->> 'category'))
      on conflict (organization_id, lower(name)) do nothing;
      select id into v_cat from public.categories
      where organization_id = v_org and lower(name) = lower(trim(p ->> 'category'));
    end if;

    v_unit := coalesce(nullif(p ->> 'base_unit', ''), 'adet');
    if v_pid is null then
      insert into public.products (organization_id, name, barcode, code, base_unit, category_id, is_weighed,
                                   created_by_import_job_id)
      values (v_org, trim(p ->> 'name'), nullif(p ->> 'barcode', ''), nullif(p ->> 'code', ''), v_unit, v_cat,
              v_unit = 'kg', j.id)
      returning id into v_pid;
      v_created := v_created + 1;
    else
      update public.products set
        name = coalesce(nullif(trim(p ->> 'name'), ''), name),
        barcode = coalesce(barcode, nullif(p ->> 'barcode', '')),
        code = coalesce(code, nullif(p ->> 'code', '')),
        category_id = coalesce(v_cat, category_id),
        is_active = true
      where id = v_pid and (
        name is distinct from coalesce(nullif(trim(p ->> 'name'), ''), name)
        or (barcode is null and nullif(p ->> 'barcode', '') is not null)
        or (code is null and nullif(p ->> 'code', '') is not null)
        or (v_cat is not null and category_id is distinct from v_cat)
        or not is_active);
      if found then v_updated := v_updated + 1; end if;
    end if;

    -- KDV oranı (tarih aralıklı)
    if nullif(p ->> 'vat_rate', '') is not null then
      v_rate := (p ->> 'vat_rate')::numeric;
      select * into v_cur from public.tax_rates t where t.product_id = v_pid and t.valid_to is null;
      if not found then
        if not exists (select 1 from public.tax_rates t where t.product_id = v_pid) then
          -- İlk bilinen oran geçmişe dönük geçerli kabul edilir (önceki satış aktarımları için).
          insert into public.tax_rates (organization_id, product_id, rate, valid_from, import_job_id)
          values (v_org, v_pid, v_rate, date '2000-01-01', j.id);
          v_vat := v_vat + 1;
        end if;
      elsif v_cur.rate <> v_rate and v_cur.valid_from < v_date then
        update public.tax_rates set valid_to = v_date - 1, closed_by_import_job_id = j.id where id = v_cur.id;
        insert into public.tax_rates (organization_id, product_id, rate, valid_from, import_job_id)
        values (v_org, v_pid, v_rate, v_date, j.id);
        v_vat := v_vat + 1;
      end if;
    end if;

    -- Satış fiyatı ve liste alış fiyatı geçmişi
    v_sale := nullif(p ->> 'sale_price_gross', '')::numeric;
    v_list := nullif(p ->> 'list_purchase_price_net', '')::numeric;
    if v_sale is not null or v_list is not null then
      select h.sale_price_gross, h.list_purchase_price_net into v_last
      from public.product_price_history h where h.product_id = v_pid
      order by h.valid_from desc, h.created_at desc limit 1;
      if not found then
        insert into public.product_price_history (organization_id, product_id, sale_price_gross,
          list_purchase_price_net, valid_from, import_job_id)
        values (v_org, v_pid, v_sale, v_list, v_date, j.id);
        v_prices := v_prices + 1;
      elsif v_last.sale_price_gross is distinct from v_sale or v_last.list_purchase_price_net is distinct from v_list then
        insert into public.product_price_history (organization_id, product_id, sale_price_gross,
          list_purchase_price_net, valid_from, import_job_id)
        values (v_org, v_pid, v_sale, v_list, v_date, j.id);
        v_prices := v_prices + 1;
      end if;
    end if;

    -- Stok: ilk liste açılış stoğudur; sonrakiler sadece onaylanan sayım farklarını yazar.
    if nullif(p ->> 'stock_qty', '') is not null then
      v_stock := greatest((p ->> 'stock_qty')::numeric, 0);
      if not exists (
        select 1 from public.inventory_movements m
        where m.product_id = v_pid and m.movement_type = 'opening' and m.voided_at is null
      ) then
        insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
          snapshot_qty, input_unit_cost, source_type, source_id, import_job_id, note)
        values (v_org, v_pid, v_ts, private.movement_priority('opening'), 'opening',
          v_stock, v_list, 'import_row', r.id, j.id, 'Açılış stoğu');
        v_products := v_products || v_pid;
        v_froms := v_froms || v_ts;
        v_openings := v_openings + 1;
      elsif coalesce((p ->> 'apply_count')::boolean, false) then
        if v_closed is not null and v_date <= v_closed then
          raise exception 'Sayım farkı kapalı döneme (% ve öncesi) yazılamaz.', to_char(v_closed, 'DD.MM.YYYY')
            using errcode = 'KDCLS';
        end if;
        insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
          snapshot_qty, source_type, source_id, import_job_id, note)
        values (v_org, v_pid, v_ts, private.movement_priority('count_adjustment'), 'count_adjustment',
          v_stock, 'import_row', r.id, j.id, 'Sayım farkı (ürün listesi)');
        v_products := v_products || v_pid;
        v_froms := v_froms || v_ts;
        v_counts := v_counts + 1;
      end if;
    end if;

    update public.import_rows set product_id = v_pid, target_type = 'product', target_id = v_pid where id = r.id;
  end loop;

  perform private.recompute_many(v_products, v_froms, 'commit', j.id);

  return jsonb_build_object('kind', j.kind, 'stock_date', v_date,
    'products_created', v_created, 'products_updated', v_updated, 'prices_recorded', v_prices,
    'vat_changes', v_vat, 'openings', v_openings, 'count_adjustments', v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Aktarım: dönemlik satış özeti
-- ---------------------------------------------------------------------------
create or replace function private.apply_sales_summary(j public.import_jobs)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := j.organization_id;
  v_start date := (j.params ->> 'period_start')::date;
  v_end date := (j.params ->> 'period_end')::date;
  v_closed date;
  v_ts timestamptz;
  v_dup int;
  r record;
  p jsonb;
  v_sid uuid;
  v_mid uuid;
  v_qty numeric;
  v_products uuid[] := '{}';
  v_froms timestamptz[] := '{}';
  v_n int := 0;
  v_net numeric := 0;
  v_gross numeric := 0;
begin
  if v_start is null or v_end is null or v_end < v_start then
    raise exception 'Satış raporunun tarih aralığı geçersiz.' using errcode = 'KDVAL';
  end if;
  if v_end > private.ist_date(now()) then
    raise exception 'Dönem sonu bugünden ileri olamaz.' using errcode = 'KDVAL';
  end if;
  select o.closed_through into v_closed from public.organizations o where o.id = v_org;
  if v_closed is not null and v_start <= v_closed then
    raise exception 'Bu tarih aralığı kapalı döneme (% ve öncesi) düşüyor. Önce dönemi yeniden açın.',
      to_char(v_closed, 'DD.MM.YYYY') using errcode = 'KDCLS';
  end if;
  if exists (select 1 from public.import_rows ir where ir.job_id = j.id and ir.status in ('ok', 'warning')
             and ir.product_id is null) then
    raise exception 'Ürünü eşleşmemiş satırlar var. Önizlemede bu satırları çözün veya atlayın.' using errcode = 'KDVAL';
  end if;

  select count(distinct ir.product_id) into v_dup
  from public.import_rows ir
  join public.sales_period_summaries s on s.product_id = ir.product_id and s.status = 'active'
    and daterange(s.period_start, s.period_end, '[]') && daterange(v_start, v_end, '[]')
  where ir.job_id = j.id and ir.status in ('ok', 'warning');
  if v_dup > 0 then
    raise exception '% ürün için bu tarih aralığıyla çakışan satış verisi zaten yüklü. Aynı dönemi iki kez yüklemeyin; gerekiyorsa önce eski aktarımı geri alın.', v_dup
      using errcode = 'KDDUP';
  end if;
  select count(distinct ir.product_id) into v_dup
  from public.import_rows ir
  join public.sale_items si on si.product_id = ir.product_id and si.status = 'active'
    and private.ist_date(si.sold_at) between v_start and v_end
  where ir.job_id = j.id and ir.status in ('ok', 'warning');
  if v_dup > 0 then
    raise exception '% ürün için bu tarih aralığında fiş bazlı satış verisi zaten var. Aynı satışlar iki kez sayılır.', v_dup
      using errcode = 'KDDUP';
  end if;

  v_ts := private.day_end(v_end);
  for r in
    select * from public.import_rows ir
    where ir.job_id = j.id and ir.status in ('ok', 'warning')
    order by ir.row_number
  loop
    p := r.parsed;
    v_qty := (p ->> 'qty')::numeric;
    insert into public.sales_period_summaries (organization_id, import_job_id, import_row_id, product_id,
      period_start, period_end, qty, gross_amount, net_amount, vat_amount, vat_rate)
    values (v_org, j.id, r.id, r.product_id, v_start, v_end, v_qty,
      (p ->> 'gross_amount')::numeric, (p ->> 'net_amount')::numeric, (p ->> 'vat_amount')::numeric,
      (p ->> 'vat_rate')::numeric)
    returning id into v_sid;
    if v_qty <> 0 then
      insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
        qty, source_type, source_id, import_job_id)
      values (v_org, r.product_id, v_ts, private.movement_priority('sale'), 'sale', -v_qty,
        'sales_period_summary', v_sid, j.id)
      returning id into v_mid;
      update public.sales_period_summaries set movement_id = v_mid where id = v_sid;
      v_products := v_products || r.product_id;
      v_froms := v_froms || v_ts;
    end if;
    update public.import_rows set target_type = 'sales_period_summary', target_id = v_sid where id = r.id;
    v_n := v_n + 1;
    v_net := v_net + (p ->> 'net_amount')::numeric;
    v_gross := v_gross + (p ->> 'gross_amount')::numeric;
  end loop;

  perform private.recompute_many(v_products, v_froms, 'commit', j.id);

  return jsonb_build_object('kind', j.kind, 'period_start', v_start, 'period_end', v_end,
    'rows', v_n, 'net_sales', v_net::text, 'gross_sales', v_gross::text,
    'cost_known_rows', (select count(*) from public.sales_period_summaries s where s.import_job_id = j.id and s.cost_known),
    'cogs', coalesce((select sum(s.total_cost) from public.sales_period_summaries s
                      where s.import_job_id = j.id and s.cost_known), 0)::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Aktarım: fiş bazlı satış
-- ---------------------------------------------------------------------------
create or replace function private.apply_sales_receipts(j public.import_jobs)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := j.organization_id;
  v_closed date;
  v_min date;
  v_max date;
  v_dup int;
  g record;
  v_mid uuid;
  v_ts timestamptz;
  v_products uuid[] := '{}';
  v_froms timestamptz[] := '{}';
  v_n int;
begin
  if exists (select 1 from public.import_rows ir where ir.job_id = j.id and ir.status in ('ok', 'warning')
             and ir.product_id is null) then
    raise exception 'Ürünü eşleşmemiş satırlar var. Önizlemede bu satırları çözün veya atlayın.' using errcode = 'KDVAL';
  end if;
  select min(private.ist_date((ir.parsed ->> 'sold_at')::timestamptz)),
         max(private.ist_date((ir.parsed ->> 'sold_at')::timestamptz))
    into v_min, v_max
  from public.import_rows ir where ir.job_id = j.id and ir.status in ('ok', 'warning');
  if v_min is null then
    raise exception 'İşlenecek satır yok.' using errcode = 'KDVAL';
  end if;
  if v_max > private.ist_date(now()) then
    raise exception 'Gelecek tarihli satış satırı var.' using errcode = 'KDVAL';
  end if;
  select o.closed_through into v_closed from public.organizations o where o.id = v_org;
  if v_closed is not null and v_min <= v_closed then
    raise exception 'Bazı satışlar kapalı döneme (% ve öncesi) düşüyor. Önce dönemi yeniden açın.',
      to_char(v_closed, 'DD.MM.YYYY') using errcode = 'KDCLS';
  end if;

  select count(distinct ir.product_id) into v_dup
  from public.import_rows ir
  join public.sales_period_summaries s on s.product_id = ir.product_id and s.status = 'active'
    and private.ist_date((ir.parsed ->> 'sold_at')::timestamptz) between s.period_start and s.period_end
  where ir.job_id = j.id and ir.status in ('ok', 'warning');
  if v_dup > 0 then
    raise exception '% ürün için bu tarihlerde dönemlik satış toplamı zaten yüklü. Aynı satışlar iki kez sayılır.', v_dup
      using errcode = 'KDDUP';
  end if;
  select count(*) into v_dup
  from public.import_rows ir
  join public.sale_items si on si.organization_id = v_org and si.fingerprint = ir.parsed ->> 'fingerprint'
    and si.status = 'active'
  where ir.job_id = j.id and ir.status in ('ok', 'warning');
  if v_dup > 0 then
    raise exception '% satış satırı daha önce yüklenmiş. Aynı fişleri iki kez yüklemeyin.', v_dup using errcode = 'KDDUP';
  end if;

  insert into public.sale_items (organization_id, import_job_id, import_row_id, product_id, receipt_no, line_no,
    sold_at, qty, gross_amount, net_amount, vat_amount, vat_rate, fingerprint)
  select v_org, j.id, ir.id, ir.product_id, ir.parsed ->> 'receipt_no', (ir.parsed ->> 'line_no')::int,
    (ir.parsed ->> 'sold_at')::timestamptz, (ir.parsed ->> 'qty')::numeric, (ir.parsed ->> 'gross_amount')::numeric,
    (ir.parsed ->> 'net_amount')::numeric, (ir.parsed ->> 'vat_amount')::numeric, (ir.parsed ->> 'vat_rate')::numeric,
    ir.parsed ->> 'fingerprint'
  from public.import_rows ir
  where ir.job_id = j.id and ir.status in ('ok', 'warning');
  get diagnostics v_n = row_count;

  -- Ürün × gün başına tek stok hareketi (faturalar gün bazlı olduğundan gün içi sıra maliyeti değiştirmez)
  for g in
    select si.product_id, private.ist_date(si.sold_at) as d, sum(si.qty) as q
    from public.sale_items si where si.import_job_id = j.id
    group by 1, 2
  loop
    if g.q <> 0 then
      v_ts := private.day_end(g.d);
      insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
        qty, source_type, import_job_id)
      values (v_org, g.product_id, v_ts, private.movement_priority('sale'), 'sale', -g.q, 'sale_items_day', j.id)
      returning id into v_mid;
      update public.sale_items set movement_id = v_mid
      where import_job_id = j.id and product_id = g.product_id and private.ist_date(sold_at) = g.d;
      v_products := v_products || g.product_id;
      v_froms := v_froms || v_ts;
    end if;
  end loop;

  update public.import_rows ir set target_type = 'sale_item', target_id = si.id
  from public.sale_items si where si.import_row_id = ir.id and si.import_job_id = j.id;

  perform private.recompute_many(v_products, v_froms, 'commit', j.id);

  return jsonb_build_object('kind', j.kind, 'rows', v_n, 'first_day', v_min, 'last_day', v_max,
    'net_sales', coalesce((select sum(si.net_amount) from public.sale_items si where si.import_job_id = j.id), 0)::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Aktarım: alış faturaları (taslaktan kesinleştirme)
-- ---------------------------------------------------------------------------
create or replace function private.create_invoice_alerts(p_invoice uuid)
returns void language plpgsql
set search_path = ''
as $$
declare
  inv record;
  r record;
  v_prev record;
  v_price record;
  v_threshold numeric;
  v_step numeric;
  v_new numeric;
  v_vat numeric;
  v_sale_net numeric;
  v_old_m numeric;
  v_new_m numeric;
  v_sugg numeric;
begin
  select pi.*, s.name as supplier_name into inv
  from public.purchase_invoices pi join public.suppliers s on s.id = pi.supplier_id
  where pi.id = p_invoice;
  select o.margin_alert_threshold_pts, o.price_rounding_step into v_threshold, v_step
  from public.organizations o where o.id = inv.organization_id;

  if inv.total_mismatch then
    insert into public.alerts (organization_id, alert_type, source_type, source_id, import_job_id, payload)
    values (inv.organization_id, 'invoice_total_mismatch', 'purchase_invoice', p_invoice, inv.import_job_id,
      jsonb_build_object('invoice_no', inv.invoice_no, 'supplier', inv.supplier_name, 'invoice_date', inv.invoice_date,
        'doc_total_incl_vat', inv.doc_total_incl_vat::text, 'calc_total_incl_vat', inv.calc_total_incl_vat::text,
        'doc_total_excl_vat', inv.doc_total_excl_vat::text, 'calc_total_excl_vat', inv.calc_total_excl_vat::text));
  end if;

  for r in
    select it.product_id, sum(it.line_net) as net, sum(it.base_qty) as qty,
           min(m.occurred_at) as ts, min(m.seq) as seq
    from public.purchase_items it
    join public.inventory_movements m on m.source_type = 'purchase_item' and m.source_id = it.id and m.voided_at is null
    where it.invoice_id = p_invoice and it.match_status = 'matched'
    group by it.product_id
  loop
    v_new := round(r.net / r.qty, 4);
    select m.input_unit_cost, m.occurred_at into v_prev
    from public.inventory_movements m
    where m.product_id = r.product_id and m.voided_at is null
      and m.movement_type in ('purchase', 'opening') and m.input_unit_cost is not null and m.input_unit_cost > 0
      and m.import_job_id is distinct from inv.import_job_id
      and (m.occurred_at, m.priority, m.seq) < (r.ts, 1::smallint, r.seq)
    order by m.occurred_at desc, m.priority desc, m.seq desc
    limit 1;
    if not found then continue; end if;
    if v_new <= v_prev.input_unit_cost then continue; end if;

    select h.sale_price_gross, h.valid_from into v_price
    from public.product_price_history h
    where h.product_id = r.product_id and h.sale_price_gross is not null and h.sale_price_gross > 0
    order by h.valid_from desc, h.created_at desc
    limit 1;
    if not found then continue; end if;

    v_vat := coalesce(private.vat_rate_at(r.product_id, private.ist_date(now())), 0);
    v_sale_net := v_price.sale_price_gross / (1 + v_vat / 100);
    v_old_m := (v_sale_net - v_prev.input_unit_cost) / v_sale_net * 100;
    v_new_m := (v_sale_net - v_new) / v_sale_net * 100;
    if v_old_m - v_new_m <= v_threshold then continue; end if;

    -- Eski marj oranını korumak için: yeni fiyat = satış fiyatı × yeni maliyet / eski maliyet
    v_sugg := null;
    if v_old_m > 0 then
      v_sugg := ceil(v_price.sale_price_gross * v_new / v_prev.input_unit_cost / v_step) * v_step;
    end if;

    insert into public.alerts (organization_id, alert_type, product_id, source_type, source_id, import_job_id, payload)
    values (inv.organization_id, 'margin_drop', r.product_id, 'purchase_invoice', p_invoice, inv.import_job_id,
      jsonb_build_object(
        'invoice_no', inv.invoice_no, 'supplier', inv.supplier_name, 'invoice_date', inv.invoice_date,
        'prev_cost', v_prev.input_unit_cost::text, 'prev_cost_date', private.ist_date(v_prev.occurred_at),
        'new_cost', v_new::text,
        'cost_increase_pct', round((v_new / v_prev.input_unit_cost - 1) * 100, 2)::text,
        'sale_price_gross', v_price.sale_price_gross::text, 'sale_price_date', v_price.valid_from,
        'sale_price_changed_since_prev', v_price.valid_from > private.ist_date(v_prev.occurred_at),
        'vat_rate', v_vat::text,
        'old_margin_pct', round(v_old_m, 2)::text, 'new_margin_pct', round(v_new_m, 2)::text,
        'suggested_price_gross', v_sugg::text, 'rounding_step', v_step::text));
  end loop;
end;
$$;

create or replace function private.apply_purchase_invoices(j public.import_jobs)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  inv record;
  li record;
  v_bad int;
  v_ts timestamptz;
  v_products uuid[] := '{}';
  v_froms timestamptz[] := '{}';
  v_n int := 0;
  v_lines int := 0;
  v_total numeric := 0;
begin
  if not exists (select 1 from public.purchase_invoices pi where pi.import_job_id = j.id and pi.status = 'draft') then
    raise exception 'Bu aktarımda kesinleştirilecek fatura yok.' using errcode = 'KDVAL';
  end if;
  for inv in
    select * from public.purchase_invoices pi where pi.import_job_id = j.id and pi.status = 'draft'
    order by pi.invoice_date, pi.invoice_no
    for update
  loop
    select count(*) into v_bad from public.purchase_items it
    where it.invoice_id = inv.id and (
      it.match_status in ('suggested', 'unmatched')
      or (it.match_status = 'matched' and (it.product_id is null or it.unit_factor is null
                                            or it.base_qty is null or it.base_qty <= 0)));
    if v_bad > 0 then
      raise exception 'Fatura % içinde % satır eşleştirilmedi veya birim dönüşümü eksik.', inv.invoice_no, v_bad
        using errcode = 'KDVAL';
    end if;
    v_ts := private.ist_start(inv.invoice_date);
    for li in
      select * from public.purchase_items x where x.invoice_id = inv.id and x.match_status = 'matched'
      order by x.line_no
    loop
      insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
        qty, input_unit_cost, input_total_cost, unit_cost, total_cost, cost_known,
        source_type, source_id, import_job_id)
      values (j.organization_id, li.product_id, v_ts, private.movement_priority('purchase'), 'purchase',
        li.base_qty, round(li.line_net / li.base_qty, 4), li.line_net, round(li.line_net / li.base_qty, 4),
        li.line_net, true, 'purchase_item', li.id, j.id);
      v_products := v_products || li.product_id;
      v_froms := v_froms || v_ts;

      insert into public.product_suppliers (organization_id, product_id, supplier_id, is_primary,
        order_unit_name, order_unit_factor)
      values (j.organization_id, li.product_id, inv.supplier_id,
        not exists (select 1 from public.product_suppliers ps where ps.product_id = li.product_id and ps.is_primary),
        case when li.unit_factor > 1 then coalesce(nullif(li.unit_name, ''), nullif(li.unit_code, '')) end,
        case when li.unit_factor > 1 then li.unit_factor end)
      on conflict (product_id, supplier_id) do update set
        order_unit_name = coalesce(excluded.order_unit_name, public.product_suppliers.order_unit_name),
        order_unit_factor = coalesce(excluded.order_unit_factor, public.product_suppliers.order_unit_factor);
      v_lines := v_lines + 1;
    end loop;
    update public.purchase_invoices set status = 'posted', posted_at = now(), posted_by = auth.uid() where id = inv.id;
    v_n := v_n + 1;
    v_total := v_total + inv.calc_total_excl_vat;
  end loop;

  perform private.recompute_many(v_products, v_froms, 'commit', j.id);

  for inv in select pi.id from public.purchase_invoices pi where pi.import_job_id = j.id and pi.status = 'posted' loop
    perform private.create_invoice_alerts(inv.id);
  end loop;

  return jsonb_build_object('kind', j.kind, 'invoices', v_n, 'lines', v_lines, 'total_excl_vat', v_total::text,
    'margin_alerts', (select count(*) from public.alerts a where a.import_job_id = j.id and a.alert_type = 'margin_drop'));
end;
$$;

-- ---------------------------------------------------------------------------
-- İşleme, önizleme, geri alma
-- ---------------------------------------------------------------------------
create or replace function private.create_revision_alert(p_org uuid, p_job uuid, p_cause text, p_res jsonb)
returns void language plpgsql
set search_path = ''
as $$
declare
  v_past jsonb;
begin
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_past
  from jsonb_array_elements(coalesce(p_res -> 'revisions', '[]'::jsonb)) e
  where (e ->> 'month')::date < private.month_of(private.ist_date(now()));
  if jsonb_array_length(v_past) > 0 or jsonb_array_length(coalesce(p_res -> 'closed_adjustments', '[]'::jsonb)) > 0 then
    insert into public.alerts (organization_id, alert_type, source_type, source_id, import_job_id, payload)
    values (p_org,
      case when jsonb_array_length(coalesce(p_res -> 'closed_adjustments', '[]'::jsonb)) > 0
           then 'closed_period_adjustment' else 'cost_revision' end,
      'import_job', p_job, p_job,
      jsonb_build_object('cause', p_cause,
        'file_name', (select ij.file_name from public.import_jobs ij where ij.id = p_job),
        'revisions', v_past, 'closed_adjustments', coalesce(p_res -> 'closed_adjustments', '[]'::jsonb)));
  end if;
end;
$$;

create or replace function private.apply_commit(p_job uuid)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  j public.import_jobs;
  v_res jsonb;
  v_ver bigint;
begin
  select * into j from public.import_jobs where id = p_job for update;
  if not found then
    raise exception 'Aktarım bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(j.organization_id);
  perform private.lock_org(j.organization_id);
  if j.status <> 'staged' then
    raise exception 'Bu aktarım zaten işlenmiş, geri alınmış veya iptal edilmiş (durum: %).', j.status
      using errcode = 'KDSTA';
  end if;
  begin
    if j.kind = 'product_list' then
      v_res := private.apply_product_list(j);
    elsif j.kind = 'sales_summary' then
      v_res := private.apply_sales_summary(j);
    elsif j.kind = 'sales_receipts' then
      v_res := private.apply_sales_receipts(j);
    else
      v_res := private.apply_purchase_invoices(j);
    end if;
  exception
    when exclusion_violation then
      raise exception 'Aynı ürün için çakışan bir kayıt var (aynı dönem veya aynı tarih aralığı iki kez). Dosyadaki tekrar eden satırları kontrol edin.'
        using errcode = 'KDDUP';
    when unique_violation then
      raise exception 'Bu kayıtların bir kısmı daha önce işlenmiş. Mükerrer kayıt oluşmaması için işlem durduruldu.'
        using errcode = 'KDDUP';
  end;
  v_ver := private.bump_ledger(j.organization_id);
  v_res := v_res || private.job_effects(p_job, 'commit') || jsonb_build_object('ledger_version', v_ver);
  update public.import_jobs set status = 'committed', committed_at = now(), committed_by = auth.uid(), result = v_res
  where id = p_job;
  perform private.create_revision_alert(j.organization_id, p_job, 'commit', v_res);
  return v_res;
end;
$$;

create or replace function public.preview_commit(p_job uuid)
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
    v_res := private.apply_commit(p_job);
    raise exception 'preview-rollback' using errcode = 'KDPRV';
  exception when sqlstate 'KDPRV' then
    null; -- tüm değişiklikler geri alındı; v_res elimizde
  end;
  return v_res || jsonb_build_object('ledger_version', v_ver, 'preview', true);
end;
$$;

create or replace function public.commit_import(p_job uuid, p_expected_version bigint)
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
  return private.apply_commit(p_job);
end;
$$;

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

create or replace function public.cancel_import(p_job uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
declare j public.import_jobs;
begin
  select * into j from public.import_jobs where id = p_job for update;
  if not found then
    raise exception 'Aktarım bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(j.organization_id);
  if j.status <> 'staged' then
    raise exception 'Sadece işlenmemiş aktarımlar iptal edilebilir.' using errcode = 'KDSTA';
  end if;
  update public.purchase_invoices set status = 'cancelled' where import_job_id = j.id and status = 'draft';
  update public.import_jobs set status = 'cancelled' where id = j.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Alış faturası hazırlama ve eşleştirme
-- ---------------------------------------------------------------------------
-- Fatura birimi → ürünün temel birimine katsayı. Bilinmiyorsa null (kullanıcıya sorulur).
create or replace function private.auto_unit_factor(
  p_product uuid, p_unit_kind text, p_unit_base text, p_unit_scale numeric, p_unit_name text, p_unit_code text)
returns numeric language plpgsql stable
set search_path = ''
as $$
declare
  v_base text;
  v_factor numeric;
begin
  select p.base_unit into v_base from public.products p where p.id = p_product;
  if p_unit_kind = 'base' and (p_unit_base is null or p_unit_base = v_base) then
    return 1;
  end if;
  if p_unit_kind = 'scaled' and p_unit_base = v_base and p_unit_scale is not null then
    return p_unit_scale;
  end if;
  select u.factor into v_factor from public.product_units u
  where u.product_id = p_product
    and (lower(u.name) = lower(coalesce(p_unit_name, '')) or lower(u.name) = lower(coalesce(p_unit_code, '')))
  limit 1;
  return v_factor;
end;
$$;

create or replace function private.refresh_item_quantities(p_item uuid)
returns void language sql
set search_path = ''
as $$
  update public.purchase_items set
    base_qty = case when unit_factor is null then null else round(qty * unit_factor, 3) end,
    unit_cost_base = case when unit_factor is null or round(qty * unit_factor, 3) = 0 then null
                          else round(line_net / round(qty * unit_factor, 3), 4) end
  where id = p_item
$$;

create or replace function public.stage_purchase_invoice(p_job uuid, p_header jsonb, p_lines jsonb)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  j public.import_jobs;
  v_org uuid;
  v_sup uuid;
  v_inv uuid;
  v_existing record;
  l jsonb;
  v_norm text;
  v_pid uuid;
  v_factor numeric;
  v_method text;
  v_status text;
  v_sugg uuid;
  v_score numeric;
  v_item uuid;
  v_ettn uuid;
begin
  select * into j from public.import_jobs where id = p_job for update;
  if not found then
    raise exception 'Aktarım bulunamadı.' using errcode = 'KDNF0';
  end if;
  v_org := j.organization_id;
  perform private.assert_member(v_org);
  if j.status <> 'staged' or j.kind not in ('purchase_invoice_xml', 'purchase_invoice_table') then
    raise exception 'Bu aktarım fatura hazırlamaya uygun değil.' using errcode = 'KDSTA';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Faturada satır bulunamadı.' using errcode = 'KDVAL';
  end if;

  -- Tedarikçi: seçilen → VKN → ad → yeni kayıt
  if nullif(p_header ->> 'supplier_id', '') is not null then
    select id into v_sup from public.suppliers where id = (p_header ->> 'supplier_id')::uuid and organization_id = v_org;
    if v_sup is null then
      raise exception 'Seçilen tedarikçi bulunamadı.' using errcode = 'KDNF0';
    end if;
  else
    if nullif(p_header ->> 'supplier_tax_number', '') is not null then
      select id into v_sup from public.suppliers
      where organization_id = v_org and tax_number = p_header ->> 'supplier_tax_number';
    end if;
    if v_sup is null and nullif(p_header ->> 'supplier_name', '') is not null then
      select id into v_sup from public.suppliers
      where organization_id = v_org and name_norm = private.normalize_name(p_header ->> 'supplier_name');
    end if;
    if v_sup is null then
      if nullif(trim(p_header ->> 'supplier_name'), '') is null then
        raise exception 'Faturada tedarikçi adı yok. Tedarikçiyi elle seçin.' using errcode = 'KDVAL';
      end if;
      insert into public.suppliers (organization_id, name, tax_number)
      values (v_org, trim(p_header ->> 'supplier_name'), nullif(p_header ->> 'supplier_tax_number', ''))
      returning id into v_sup;
    end if;
  end if;

  v_ettn := nullif(p_header ->> 'ettn', '')::uuid;
  select pi.invoice_no, pi.invoice_date, pi.status into v_existing
  from public.purchase_invoices pi
  where pi.organization_id = v_org and pi.status in ('draft', 'posted')
    and ((pi.supplier_id = v_sup and pi.invoice_no = p_header ->> 'invoice_no') or (v_ettn is not null and pi.ettn = v_ettn))
  limit 1;
  if found then
    raise exception 'Bu fatura (% / %) zaten %. Aynı fatura iki kez işlenemez.',
      v_existing.invoice_no, to_char(v_existing.invoice_date, 'DD.MM.YYYY'),
      case v_existing.status when 'posted' then 'işlenmiş' else 'eşleştirme bekliyor' end
      using errcode = 'KDDUP';
  end if;

  insert into public.purchase_invoices (organization_id, supplier_id, import_job_id, invoice_no, ettn, invoice_date,
    invoice_type, doc_total_excl_vat, doc_total_vat, doc_total_incl_vat,
    calc_total_excl_vat, calc_total_vat, calc_total_incl_vat, total_mismatch)
  values (v_org, v_sup, p_job, p_header ->> 'invoice_no', v_ettn, (p_header ->> 'invoice_date')::date,
    nullif(p_header ->> 'invoice_type', ''),
    nullif(p_header ->> 'doc_total_excl_vat', '')::numeric, nullif(p_header ->> 'doc_total_vat', '')::numeric,
    nullif(p_header ->> 'doc_total_incl_vat', '')::numeric,
    (p_header ->> 'calc_total_excl_vat')::numeric, (p_header ->> 'calc_total_vat')::numeric,
    (p_header ->> 'calc_total_incl_vat')::numeric, coalesce((p_header ->> 'total_mismatch')::boolean, false))
  returning id into v_inv;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_pid := null; v_factor := null; v_method := null; v_sugg := null; v_score := null;
    v_norm := private.normalize_name(l ->> 'name');

    if nullif(l ->> 'barcode', '') is not null then
      select u.product_id, u.factor into v_pid, v_factor from public.product_units u
      where u.organization_id = v_org and u.barcode = l ->> 'barcode';
      if v_pid is not null then
        v_method := 'unit_barcode';
      else
        select p.id into v_pid from public.products p where p.organization_id = v_org and p.barcode = l ->> 'barcode';
        if v_pid is not null then
          v_method := 'barcode';
          v_factor := private.auto_unit_factor(v_pid, l ->> 'unit_kind', nullif(l ->> 'unit_base', ''),
            nullif(l ->> 'unit_scale', '')::numeric, l ->> 'unit_name', l ->> 'unit_code');
        end if;
      end if;
    end if;

    if v_pid is null or v_factor is null then
      select a.product_id, a.unit_factor into v_sugg, v_score
      from public.supplier_product_aliases a
      where a.supplier_id = v_sup and a.unit_code = coalesce(l ->> 'unit_code', '')
        and ((a.supplier_code is not null and a.supplier_code = nullif(l ->> 'code', ''))
             or (a.supplier_code is null and a.name_norm = v_norm))
        and (v_pid is null or a.product_id = v_pid)
      order by (a.supplier_code is not null) desc
      limit 1;
      if v_sugg is not null then
        if v_pid is null then v_method := 'alias'; end if;
        v_pid := v_sugg;
        v_factor := v_score;
      end if;
      v_sugg := null; v_score := null;
    end if;

    if v_pid is not null then
      v_status := 'matched';
    else
      select p.id, extensions.similarity(p.name_norm, v_norm) into v_sugg, v_score
      from public.products p
      where p.organization_id = v_org and p.is_active and v_norm is not null
        and extensions.similarity(p.name_norm, v_norm) >= 0.35
      order by extensions.similarity(p.name_norm, v_norm) desc, p.name
      limit 1;
      v_status := case when v_sugg is not null then 'suggested' else 'unmatched' end;
    end if;

    insert into public.purchase_items (organization_id, invoice_id, import_row_id, line_no, raw_name, raw_code,
      raw_barcode, unit_code, unit_name, unit_kind, unit_base, unit_scale, qty, unit_price, discount_amount,
      line_net, vat_rate, vat_amount, product_id, unit_factor, match_method, match_status,
      suggested_product_id, suggestion_score)
    values (v_org, v_inv, nullif(l ->> 'import_row_id', '')::uuid, (l ->> 'line_no')::int, l ->> 'name',
      nullif(l ->> 'code', ''), nullif(l ->> 'barcode', ''), coalesce(l ->> 'unit_code', ''), nullif(l ->> 'unit_name', ''),
      coalesce(l ->> 'unit_kind', 'unknown'), nullif(l ->> 'unit_base', ''), nullif(l ->> 'unit_scale', '')::numeric,
      (l ->> 'qty')::numeric, (l ->> 'unit_price')::numeric, coalesce(nullif(l ->> 'discount_amount', '')::numeric, 0),
      (l ->> 'line_net')::numeric, (l ->> 'vat_rate')::numeric, (l ->> 'vat_amount')::numeric,
      v_pid, v_factor, v_method, v_status, v_sugg, round(v_score, 4))
    returning id into v_item;
    perform private.refresh_item_quantities(v_item);
  end loop;

  return v_inv;
end;
$$;

create or replace function private.item_context(p_item uuid)
returns table (item_id uuid, organization_id uuid, invoice_status text, supplier_id uuid)
language sql stable
set search_path = ''
as $$
  select it.id, it.organization_id, pi.status, pi.supplier_id
  from public.purchase_items it join public.purchase_invoices pi on pi.id = it.invoice_id
  where it.id = p_item
$$;

create or replace function public.match_purchase_item(
  p_item uuid, p_product uuid, p_unit_factor text, p_unit_name text, p_save_alias boolean)
returns void language plpgsql security definer
set search_path = ''
as $$
declare
  c record;
  it public.purchase_items;
  v_factor numeric;
  v_pname text;
begin
  select * into c from private.item_context(p_item);
  if c.item_id is null then
    raise exception 'Fatura satırı bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(c.organization_id);
  if c.invoice_status <> 'draft' then
    raise exception 'Kesinleşmiş faturanın satırı değiştirilemez. Değişiklik için aktarımı geri alın.' using errcode = 'KDSTA';
  end if;
  if not exists (select 1 from public.products p where p.id = p_product and p.organization_id = c.organization_id) then
    raise exception 'Ürün bulunamadı.' using errcode = 'KDNF0';
  end if;
  select * into it from public.purchase_items where id = p_item;
  v_factor := nullif(trim(coalesce(p_unit_factor, '')), '')::numeric;
  if v_factor is null then
    v_factor := private.auto_unit_factor(p_product, it.unit_kind, it.unit_base, it.unit_scale, it.unit_name, it.unit_code);
  end if;
  if v_factor is not null and v_factor <= 0 then
    raise exception 'Birim katsayısı sıfırdan büyük olmalı.' using errcode = 'KDVAL';
  end if;

  update public.purchase_items set product_id = p_product, unit_factor = v_factor,
    match_method = case when match_method is not null and product_id = p_product then match_method else 'manual' end,
    match_status = 'matched', suggested_product_id = null, suggestion_score = null
  where id = p_item;
  perform private.refresh_item_quantities(p_item);

  if coalesce(p_save_alias, true) and v_factor is not null then
    if it.raw_code is not null then
      insert into public.supplier_product_aliases (organization_id, supplier_id, supplier_code, name_norm, unit_code,
        product_id, unit_factor)
      values (c.organization_id, c.supplier_id, it.raw_code, coalesce(it.raw_name_norm, ''), it.unit_code, p_product, v_factor)
      on conflict (supplier_id, supplier_code, unit_code) where supplier_code is not null
      do update set product_id = excluded.product_id, unit_factor = excluded.unit_factor,
        confirmed_at = now(), confirmed_by = auth.uid();
    else
      insert into public.supplier_product_aliases (organization_id, supplier_id, supplier_code, name_norm, unit_code,
        product_id, unit_factor)
      values (c.organization_id, c.supplier_id, null, coalesce(it.raw_name_norm, ''), it.unit_code, p_product, v_factor)
      on conflict (supplier_id, name_norm, unit_code) where supplier_code is null
      do update set product_id = excluded.product_id, unit_factor = excluded.unit_factor,
        confirmed_at = now(), confirmed_by = auth.uid();
    end if;
  end if;

  v_pname := nullif(trim(coalesce(p_unit_name, '')), '');
  if v_pname is not null and v_factor is not null and v_factor <> 1 then
    insert into public.product_units (organization_id, product_id, name, factor)
    values (c.organization_id, p_product, v_pname, v_factor)
    on conflict (product_id, lower(name)) do nothing;
  end if;
end;
$$;

create or replace function public.ignore_purchase_item(p_item uuid, p_ignored boolean)
returns void language plpgsql security definer
set search_path = ''
as $$
declare c record;
begin
  select * into c from private.item_context(p_item);
  if c.item_id is null then
    raise exception 'Fatura satırı bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(c.organization_id);
  if c.invoice_status <> 'draft' then
    raise exception 'Kesinleşmiş faturanın satırı değiştirilemez.' using errcode = 'KDSTA';
  end if;
  if p_ignored then
    update public.purchase_items set match_status = 'ignored', product_id = null, unit_factor = null,
      base_qty = null, unit_cost_base = null, match_method = null
    where id = p_item;
  else
    update public.purchase_items set match_status = 'unmatched' where id = p_item and match_status = 'ignored';
  end if;
end;
$$;

create or replace function public.create_product_for_item(
  p_item uuid, p_name text, p_base_unit text, p_barcode text, p_unit_factor text, p_unit_name text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  c record;
  it public.purchase_items;
  v_pid uuid;
begin
  select * into c from private.item_context(p_item);
  if c.item_id is null then
    raise exception 'Fatura satırı bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(c.organization_id);
  if c.invoice_status <> 'draft' then
    raise exception 'Kesinleşmiş faturanın satırı değiştirilemez.' using errcode = 'KDSTA';
  end if;
  select * into it from public.purchase_items where id = p_item;
  if p_base_unit not in ('adet', 'kg', 'lt') then
    raise exception 'Temel birim adet, kg veya lt olmalı.' using errcode = 'KDVAL';
  end if;
  if nullif(trim(p_barcode), '') is not null and exists (
    select 1 from public.products p where p.organization_id = c.organization_id and p.barcode = trim(p_barcode)) then
    raise exception 'Bu barkodla kayıtlı bir ürün zaten var. Yeni ürün açmak yerine onu seçin.' using errcode = 'KDDUP';
  end if;
  insert into public.products (organization_id, name, barcode, base_unit, is_weighed)
  values (c.organization_id, trim(p_name), nullif(trim(p_barcode), ''), p_base_unit, p_base_unit = 'kg')
  returning id into v_pid;
  insert into public.tax_rates (organization_id, product_id, rate, valid_from)
  values (c.organization_id, v_pid, it.vat_rate, date '2000-01-01');
  perform public.match_purchase_item(p_item, v_pid, p_unit_factor, p_unit_name, true);
  return v_pid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Elle stok hareketi: fire, bozulma, tedarikçiye iade, sayım
-- ---------------------------------------------------------------------------
create or replace function public.add_manual_movement(
  p_product uuid, p_type text, p_qty text, p_date date, p_note text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_closed date;
  v_qty numeric;
  v_ts timestamptz;
  v_id uuid;
begin
  select p.organization_id into v_org from public.products p where p.id = p_product;
  if v_org is null then
    raise exception 'Ürün bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(v_org);
  perform private.lock_org(v_org);
  if p_type not in ('waste', 'spoilage', 'supplier_return', 'count_adjustment') then
    raise exception 'Geçersiz hareket türü.' using errcode = 'KDVAL';
  end if;
  if p_date is null or p_date > private.ist_date(now()) then
    raise exception 'Tarih boş veya gelecekte olamaz.' using errcode = 'KDVAL';
  end if;
  select o.closed_through into v_closed from public.organizations o where o.id = v_org;
  if v_closed is not null and p_date <= v_closed then
    raise exception 'Bu tarih kapalı döneme (% ve öncesi) düşüyor.', to_char(v_closed, 'DD.MM.YYYY') using errcode = 'KDCLS';
  end if;
  v_qty := nullif(trim(coalesce(p_qty, '')), '')::numeric;
  if v_qty is null then
    raise exception 'Miktar girin.' using errcode = 'KDVAL';
  end if;
  v_ts := private.day_end(p_date);
  if p_type = 'count_adjustment' then
    if v_qty < 0 then
      raise exception 'Sayılan miktar eksi olamaz.' using errcode = 'KDVAL';
    end if;
    insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
      snapshot_qty, source_type, note)
    values (v_org, p_product, v_ts, private.movement_priority(p_type), p_type, v_qty, 'manual', nullif(trim(p_note), ''))
    returning id into v_id;
  else
    if v_qty <= 0 then
      raise exception 'Miktar sıfırdan büyük olmalı.' using errcode = 'KDVAL';
    end if;
    insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
      qty, source_type, note)
    values (v_org, p_product, v_ts, private.movement_priority(p_type), p_type, -v_qty, 'manual', nullif(trim(p_note), ''))
    returning id into v_id;
  end if;
  perform private.recompute_chain(p_product, v_ts, 'manual', null);
  perform private.bump_ledger(v_org);
  return v_id;
end;
$$;

create or replace function public.void_manual_movement(p_movement uuid, p_reason text)
returns void language plpgsql security definer
set search_path = ''
as $$
declare
  m public.inventory_movements;
  v_closed_end timestamptz;
begin
  select * into m from public.inventory_movements where id = p_movement;
  if not found then
    raise exception 'Hareket bulunamadı.' using errcode = 'KDNF0';
  end if;
  perform private.assert_member(m.organization_id);
  perform private.lock_org(m.organization_id);
  if m.source_type <> 'manual' or m.voided_at is not null then
    raise exception 'Sadece elle girilmiş ve iptal edilmemiş hareketler silinebilir. Aktarım kayıtları için aktarımı geri alın.'
      using errcode = 'KDSTA';
  end if;
  v_closed_end := private.closed_end(m.organization_id);
  if v_closed_end is not null and m.occurred_at < v_closed_end then
    raise exception 'Kapalı döneme ait hareket iptal edilemez.' using errcode = 'KDCLS';
  end if;
  update public.inventory_movements set voided_at = now(), voided_by = auth.uid(),
    void_reason = coalesce(nullif(trim(p_reason), ''), 'Elle iptal')
  where id = p_movement;
  perform private.recompute_chain(m.product_id, m.occurred_at, 'manual', null);
  perform private.bump_ledger(m.organization_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- KDV oranı değişikliği (tarihten itibaren)
-- ---------------------------------------------------------------------------
create or replace function public.set_vat_rate(p_org uuid, p_products uuid[], p_rate text, p_valid_from date)
returns integer language plpgsql security definer
set search_path = ''
as $$
declare
  v_rate numeric := nullif(trim(coalesce(p_rate, '')), '')::numeric;
  v_pid uuid;
  v_cur public.tax_rates;
  v_n int := 0;
begin
  perform private.assert_member(p_org);
  if v_rate is null or v_rate < 0 or v_rate >= 100 then
    raise exception 'KDV oranı 0 ile 99 arasında olmalı.' using errcode = 'KDVAL';
  end if;
  if p_valid_from is null then
    raise exception 'Geçerlilik tarihi seçin.' using errcode = 'KDVAL';
  end if;
  foreach v_pid in array coalesce(p_products, '{}') loop
    if not exists (select 1 from public.products p where p.id = v_pid and p.organization_id = p_org) then
      raise exception 'Ürün bulunamadı.' using errcode = 'KDNF0';
    end if;
    if exists (select 1 from public.tax_rates t where t.product_id = v_pid and t.valid_from > p_valid_from) then
      raise exception 'Seçilen tarihten sonra başlayan bir KDV oranı tanımlı. Daha geç bir tarih seçin.' using errcode = 'KDVAL';
    end if;
    select * into v_cur from public.tax_rates t
    where t.product_id = v_pid and t.valid_from <= p_valid_from and (t.valid_to is null or t.valid_to >= p_valid_from);
    if found then
      if v_cur.rate = v_rate then continue; end if;
      if v_cur.valid_from = p_valid_from then
        update public.tax_rates set rate = v_rate where id = v_cur.id;
      else
        update public.tax_rates set valid_to = p_valid_from - 1 where id = v_cur.id;
        insert into public.tax_rates (organization_id, product_id, rate, valid_from, valid_to)
        values (p_org, v_pid, v_rate, p_valid_from, v_cur.valid_to);
      end if;
    else
      insert into public.tax_rates (organization_id, product_id, rate, valid_from)
      values (p_org, v_pid, v_rate, p_valid_from);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dönem kapatma / yeniden açma
-- ---------------------------------------------------------------------------
create or replace function public.close_period(p_org uuid, p_month date)
returns void language plpgsql security definer
set search_path = ''
as $$
declare
  v_month date := private.month_of(p_month);
  v_end date;
  v_closed date;
  v_pending int;
begin
  perform private.assert_admin(p_org);
  perform private.lock_org(p_org);
  v_end := (v_month + interval '1 month' - interval '1 day')::date;
  if v_end >= private.ist_date(now()) then
    raise exception 'Ay bitmeden kapatılamaz.' using errcode = 'KDVAL';
  end if;
  select o.closed_through into v_closed from public.organizations o where o.id = p_org;
  if v_closed is not null and v_end <= v_closed then
    raise exception 'Bu ay zaten kapalı.' using errcode = 'KDVAL';
  end if;
  select count(*) into v_pending from public.expenses e
  where e.organization_id = p_org and e.status = 'pending' and e.month <= v_month;
  if v_pending > 0 then
    raise exception 'Kapatılacak dönemde onay bekleyen % gider var. Önce onaylayın veya bu ay için yok sayın.', v_pending
      using errcode = 'KDVAL';
  end if;
  if exists (select 1 from public.import_jobs ij where ij.organization_id = p_org and ij.status = 'staged') then
    raise exception 'İşlenmeyi bekleyen aktarım var. Önce işleyin veya iptal edin.' using errcode = 'KDVAL';
  end if;
  update public.organizations set closed_through = v_end where id = p_org;
  perform private.bump_ledger(p_org);
end;
$$;

create or replace function public.reopen_period(p_org uuid, p_month date)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_month date := private.month_of(p_month);
  v_old_closed date;
  v_new_end timestamptz;
  v_old_end timestamptz;
  m record;
  r record;
  v_revisions int := 0;
  v_adjusted int := 0;
  v_needed numeric;
begin
  perform private.assert_admin(p_org);
  perform private.lock_org(p_org);
  select o.closed_through into v_old_closed from public.organizations o where o.id = p_org;
  if v_old_closed is null or v_month > v_old_closed then
    raise exception 'Bu ay zaten açık.' using errcode = 'KDVAL';
  end if;
  v_old_end := private.ist_start(v_old_closed + 1);
  v_new_end := private.ist_start(v_month);
  update public.organizations set closed_through = v_month - 1 where id = p_org;

  -- 1) Artık açık aylarda duran kapalı dönem düzeltmeleri iptal edilir (aşağıda yeniden hesaplanır).
  update public.inventory_movements set voided_at = now(), voided_by = auth.uid(), void_reason = 'Dönem yeniden açıldı'
  where organization_id = p_org and movement_type = 'cost_adjustment' and voided_at is null and occurred_at >= v_new_end;

  -- 2) Açılan aylarda kayıtlı değer := güncel hesap (revizyon izi bırakarak)
  for m in
    select * from public.inventory_movements x
    where x.organization_id = p_org and x.voided_at is null and x.movement_type <> 'cost_adjustment'
      and x.occurred_at >= v_new_end and x.occurred_at < v_old_end and x.calc_qty is not null
      and (x.qty, x.unit_cost, x.total_cost, x.cost_known)
          is distinct from (x.calc_qty, x.calc_unit_cost, x.calc_total_cost, x.calc_cost_known)
    for update
  loop
    if private.is_pnl_type(m.movement_type) then
      insert into public.cost_revisions (organization_id, movement_id, product_id, occurred_at, movement_type,
        old_total_cost, new_total_cost, old_cost_known, new_cost_known, cause_type, cause_job_id)
      values (p_org, m.id, m.product_id, m.occurred_at, m.movement_type,
        m.total_cost, m.calc_total_cost, m.cost_known, m.calc_cost_known, 'reopen', null);
      v_revisions := v_revisions + 1;
    end if;
    update public.inventory_movements set qty = calc_qty, unit_cost = calc_unit_cost,
      total_cost = calc_total_cost, cost_known = calc_cost_known
    where id = m.id;
    if m.source_type = 'sales_period_summary' then
      update public.sales_period_summaries s set unit_cost = m.calc_unit_cost,
        total_cost = case when m.calc_total_cost is null then null else -m.calc_total_cost end,
        cost_known = m.calc_cost_known
      where s.id = m.source_id;
    elsif m.source_type = 'sale_items_day' then
      update public.sale_items s set unit_cost = m.calc_unit_cost,
        total_cost = case when m.calc_unit_cost is null then null else round(s.qty * m.calc_unit_cost, 4) end,
        cost_known = m.calc_cost_known
      where s.movement_id = m.id;
    end if;
  end loop;

  -- 3) Hâlâ kapalı aylardaki fark = mevcut düzeltmelerin toplamı olmalı; eksik kalan ilk açık aya yazılır.
  for r in
    select x.product_id,
      coalesce(sum(case when private.is_pnl_type(x.movement_type) and x.occurred_at < v_new_end
                         and x.cost_known and x.calc_cost_known
                        then x.calc_total_cost - x.total_cost else 0 end), 0)
      - coalesce(sum(case when x.movement_type = 'cost_adjustment' then x.total_cost else 0 end), 0) as needed
    from public.inventory_movements x
    where x.organization_id = p_org and x.voided_at is null
    group by x.product_id
  loop
    v_needed := r.needed;
    if v_needed <> 0 then
      insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
        qty, total_cost, cost_known, calc_qty, calc_total_cost, calc_cost_known, source_type, note)
      values (p_org, r.product_id, v_new_end, private.movement_priority('cost_adjustment'), 'cost_adjustment',
        0, v_needed, true, 0, v_needed, true, 'reopen', 'Kapalı döneme ait maliyet farkı (dönem yeniden açıldı)');
      v_adjusted := v_adjusted + 1;
    end if;
  end loop;

  perform private.bump_ledger(p_org);
  return jsonb_build_object('revisions', v_revisions, 'adjustments', v_adjusted);
end;
$$;

-- ---------------------------------------------------------------------------
-- Tekrarlayan giderler: ay için bekleyen kayıt üret (kullanıcı onaylar)
-- ---------------------------------------------------------------------------
create or replace function public.generate_recurring_expenses(p_org uuid, p_month date)
returns integer language plpgsql security definer
set search_path = ''
as $$
declare
  v_month date := private.month_of(p_month);
  v_closed date;
  v_n int;
begin
  perform private.assert_member(p_org);
  select o.closed_through into v_closed from public.organizations o where o.id = p_org;
  if v_closed is not null and v_month <= v_closed then
    return 0;
  end if;
  if v_month > private.month_of(private.ist_date(now())) then
    return 0;
  end if;
  insert into public.expenses (organization_id, category_id, month, amount, vat_amount, description, status,
    recurring_expense_id)
  select r.organization_id, r.category_id, v_month, r.amount, r.vat_amount, r.description, 'pending', r.id
  from public.recurring_expenses r
  where r.organization_id = p_org and r.is_active and r.start_month <= v_month
    and (r.end_month is null or r.end_month >= v_month)
  on conflict (recurring_expense_id, month) where recurring_expense_id is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

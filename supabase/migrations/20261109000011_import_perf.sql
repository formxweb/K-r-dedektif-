-- Performans: ürün listesi aktarımı
-- 1) Hiç hareketi olmayan üründe açılış stoğu, maliyet zincirinin vereceği değerlerle doğrudan yazılır
--    (önceki hareketi olan ürünlerde eski yol: ekle + zinciri yeniden hesapla).
-- 2) Kategori kimlikleri aktarım boyunca önbellekte tutulur; bu aktarımda yeni açılan ürün için
--    KDV / fiyat / hareket geçmişi sorgulanmaz (yoktur).
-- 3) Satırların ürüne bağlanması döngü sonunda tek toplu güncellemeyle yapılır.
-- 4) guard_same_org sadece istemciden gelen doğrudan yazmalarda çalışır; RPC içi yazmalar
--    zaten işletme doğrulamasından geçmiştir.
-- 5) Depolama: işletme klasöründeki kendi dosyasını silebilme (başarısız yüklemeleri temizlemek için).

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
  v_cat_cache jsonb := '{}'::jsonb;
  v_cat_key text;
  v_new boolean;
  v_row_ids uuid[] := '{}';
  v_row_pids uuid[] := '{}';
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
    v_cat_key := lower(nullif(trim(p ->> 'category'), ''));
    if v_cat_key is not null then
      -- Aynı kategori her satırda tekrar sorgulanmaz
      v_cat := (v_cat_cache ->> v_cat_key)::uuid;
      if v_cat is null then
        insert into public.categories (organization_id, name) values (v_org, trim(p ->> 'category'))
        on conflict (organization_id, lower(name)) do nothing;
        select id into v_cat from public.categories
        where organization_id = v_org and lower(name) = v_cat_key;
        v_cat_cache := v_cat_cache || jsonb_build_object(v_cat_key, v_cat);
      end if;
    end if;

    v_unit := coalesce(nullif(p ->> 'base_unit', ''), 'adet');
    v_new := v_pid is null;
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
      if v_new then
        insert into public.tax_rates (organization_id, product_id, rate, valid_from, import_job_id)
        values (v_org, v_pid, v_rate, date '2000-01-01', j.id);
        v_vat := v_vat + 1;
      else
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
    end if;

    -- Satış fiyatı ve liste alış fiyatı geçmişi
    v_sale := nullif(p ->> 'sale_price_gross', '')::numeric;
    v_list := nullif(p ->> 'list_purchase_price_net', '')::numeric;
    if v_sale is not null or v_list is not null then
      if not v_new then
        select h.sale_price_gross, h.list_purchase_price_net into v_last
        from public.product_price_history h where h.product_id = v_pid
        order by h.valid_from desc, h.created_at desc limit 1;
      end if;
      if v_new or not found then
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
      if v_new or not exists (
        select 1 from public.inventory_movements m
        where m.product_id = v_pid and m.voided_at is null and m.movement_type <> 'cost_adjustment'
      ) then
        -- Hiç hareketi olmayan ürün: zincir bu tek hareketten ibaret. recompute_chain ile aynı sonuç
        -- doğrudan yazılır (stok = sayılan, ortalama = liste alış fiyatı); yeniden hesap gerekmez.
        insert into public.inventory_movements (organization_id, product_id, occurred_at, priority, movement_type,
          snapshot_qty, input_unit_cost, qty, unit_cost, total_cost, cost_known,
          calc_qty, calc_unit_cost, calc_total_cost, calc_cost_known, stock_after, avg_cost_after,
          source_type, source_id, import_job_id, note)
        values (v_org, v_pid, v_ts, private.movement_priority('opening'), 'opening',
          v_stock, v_list, v_stock, v_list,
          case when v_list is null then null else round(v_stock * v_list, 4) end, v_list is not null,
          v_stock, v_list, case when v_list is null then null else round(v_stock * v_list, 4) end, v_list is not null,
          v_stock, v_list, 'import_row', r.id, j.id, 'Açılış stoğu');
        v_openings := v_openings + 1;
      elsif not exists (
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

    v_row_ids := v_row_ids || r.id;
    v_row_pids := v_row_pids || v_pid;
  end loop;

  update public.import_rows ir set product_id = u.pid, target_type = 'product', target_id = u.pid
  from unnest(v_row_ids, v_row_pids) as u(rid, pid)
  where ir.id = u.rid;

  perform private.recompute_many(v_products, v_froms, 'commit', j.id);

  return jsonb_build_object('kind', j.kind, 'stock_date', v_date,
    'products_created', v_created, 'products_updated', v_updated, 'prices_recorded', v_prices,
    'vat_changes', v_vat, 'openings', v_openings, 'count_adjustments', v_counts);
end;
$$;


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
  -- RPC fonksiyonları (tablo sahibi olarak) kendi doğrulamasını yapar; kontrol sadece istemci yazmaları için.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
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


do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'objects')
     and not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'imports_delete') then
    execute $p$
      create policy imports_delete on storage.objects for delete to authenticated
      using (bucket_id = 'imports'
             and (storage.foldername(name))[1]::uuid = any ((select private.my_org_ids())::uuid[]))
    $p$;
  end if;
end;
$$;

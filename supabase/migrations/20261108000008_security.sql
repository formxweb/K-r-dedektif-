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

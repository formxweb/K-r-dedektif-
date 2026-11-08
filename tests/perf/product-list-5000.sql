-- Performans ölçümü: 5.000 ürünlük ilk ürün listesi (önizleme + kayıt).
-- Çalıştırma: ./tests/db/reset-db.sh && psql "$KD_TEST_DB_URL" -f tests/perf/product-list-5000.sql
\timing on
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'perf@test');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001"}', false);
select public.create_organization('Perf') as org \gset
insert into public.import_jobs (organization_id, kind, file_name, file_hash, params)
  values (:'org', 'product_list', 'p.csv', md5('a')||md5('b'), '{"stock_date":"2026-11-01"}') returning id as job \gset
insert into public.import_rows (organization_id, job_id, row_number, raw, parsed, status)
select :'org', :'job', g, '{}', jsonb_build_object('name','Ürün '||g,'barcode','869'||lpad(g::text,10,'0'),'base_unit','adet',
  'vat_rate','1','sale_price_gross','10','list_purchase_price_net','7','stock_qty', (g%50)::text, 'category', 'Kat '||(g%30)), 'ok'
from generate_series(1,5000) g;
select (public.preview_commit(:'job'))->>'openings' as preview_openings;
select (public.commit_import(:'job', null))->>'openings' as openings;

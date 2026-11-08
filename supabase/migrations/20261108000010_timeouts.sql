-- Büyük aktarımlar (ör. 5.000 ürünlük ilk liste) Supabase'in varsayılan 8 sn sınırını aşabiliyor.
-- Ölçüm: 5.000 ürün yerelde ~7,7 sn; ücretsiz plan sunucusunda daha uzun.
alter role authenticated set statement_timeout = '60s';
notify pgrst, 'reload config';

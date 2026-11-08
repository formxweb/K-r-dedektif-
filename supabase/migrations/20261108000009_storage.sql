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

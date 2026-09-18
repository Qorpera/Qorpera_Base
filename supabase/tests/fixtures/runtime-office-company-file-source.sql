-- Actual native mutation gateway creates a canonical binary source. Only the
-- immutable storage catalog is seeded here; combined acceptance stores bytes.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
do $$
declare v_bytes bytea:=decode('00ff800d0a01','hex'); v_hash text; v_manifest text; v_manifest_hash text; v_entry jsonb; v_read jsonb;
begin
 v_hash:=encode(extensions.digest(v_bytes,'sha256'),'hex');
 v_manifest:=jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,'bytes',octet_length(v_bytes),
  'mediaType','application/octet-stream','chunks',jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(v_bytes))))::text;
 v_manifest_hash:=encode(extensions.digest(convert_to(v_manifest,'UTF8'),'sha256'),'hex');
 insert into storage.objects(bucket_id,name,metadata) values
  ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/'||v_hash,jsonb_build_object('size',octet_length(v_bytes))),
  ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/'||v_manifest_hash,jsonb_build_object('size',octet_length(v_manifest)));
 perform public.qorpera_verify_company_path_file('30000000-0000-4000-8000-000000000010',v_manifest);
 v_entry:=jsonb_build_object('path','source.bin','kind','file','executable',false,'file',jsonb_build_object(
  'manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(v_bytes),'mediaType','application/octet-stream'));
 perform pg_temp.path_commit(pg_temp.path_plan('company-import-source','source.bin',v_entry));
 v_read:=public.qorpera_read_company_path('30000000-0000-4000-8000-000000000020','source.bin',current_setting('qorpera_test.wake_binding')::jsonb);
 perform set_config('qorpera_test.company_import_source',jsonb_build_object('source',jsonb_build_object('realm','company_file','path','source.bin','version',v_read->'version'),
  'file',v_entry->'file','manifest',v_manifest,'bytesBase64',encode(v_bytes,'base64'))::text,true);
end
$$;
reset role;

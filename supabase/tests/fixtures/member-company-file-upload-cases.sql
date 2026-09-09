-- Follows 295_member_company_file_commands.test.sql inside its transaction.
-- Catalog rows are storage fixtures; admission, grants, retention and commits
-- use the real database functions.
reset role;
create function pg_temp.member_upload(p_key text,p_path text,p_bytes bytea)
returns jsonb language plpgsql security definer as $$
declare v_chunk bytea; v_hash text; v_chunks jsonb:='[]'; v_manifest text; v_file_hash text;
 v_manifest_hash text; v_offset integer:=0; v_source jsonb; v_plan jsonb;
begin
 v_file_hash:=encode(extensions.digest(p_bytes,'sha256'),'hex');
 while v_offset<octet_length(p_bytes) loop
  v_chunk:=substring(p_bytes from v_offset+1 for 4194304);v_offset:=v_offset+octet_length(v_chunk);
  v_hash:=encode(extensions.digest(v_chunk,'sha256'),'hex');
  insert into storage.objects(bucket_id,name,metadata) values('qorpera-profile-objects',
   '29500000-0000-4000-8000-000000000010/'||v_hash,jsonb_build_object('size',octet_length(v_chunk))) on conflict do nothing;
  v_chunks:=v_chunks||jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(v_chunk)));
 end loop;
 v_manifest:=jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_file_hash,
  'bytes',octet_length(p_bytes),'mediaType','application/octet-stream','chunks',v_chunks)::text;
 v_manifest_hash:=encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
 insert into storage.objects(bucket_id,name,metadata) values('qorpera-profile-objects',
  '29500000-0000-4000-8000-000000000010/'||v_manifest_hash,jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
 perform public.qorpera_verify_company_path_file('29500000-0000-4000-8000-000000000010',v_manifest);
 v_plan:=pg_temp.member_plan(p_key,p_path,jsonb_build_object('path',p_path,'kind','file','executable',false,'file',
  jsonb_build_object('fileSha256',v_file_hash,'manifestSha256',v_manifest_hash,'bytes',octet_length(p_bytes),'mediaType','application/octet-stream')));
 v_source:=jsonb_build_object('realm','member_file','name','selected.bin','sha256',v_file_hash,'bytes',octet_length(p_bytes),'mediaType','application/octet-stream');
 return jsonb_build_object('plan',v_plan,'manifest',v_manifest,'source',v_source);
end $$;

-- Invalid chunk layouts, stale destinations and retained resource authority.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.upload_protected',pg_temp.member_upload('protected-member-upload','protected-upload.bin',decode('00ff80','hex'))::text,true);
select set_config('qorpera_test.upload_revoked',pg_temp.member_upload('revoked-member-upload','revoked-upload.bin',decode('00ff81','hex'))::text,true);
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001'); set local role authenticated;
select public.qorpera_set_company_path_resource('29500000-0000-4000-8000-000000000020','protected-upload.bin','exact','company_shared','protected');
select set_config('qorpera_test.upload_resource',public.qorpera_set_company_path_resource('29500000-0000-4000-8000-000000000020','revoked-upload.bin','exact','company_shared','normal')::text,true);
do $$ declare v jsonb:=current_setting('qorpera_test.upload_protected')::jsonb; c jsonb; m jsonb; bad_plan jsonb; begin
 c:=public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source');
 if c->>'state'<>'review_required' then raise exception 'Protected upload became live without review'; end if;
 perform set_config('qorpera_test.protected_upload_command',c::text,true);
 v:=current_setting('qorpera_test.upload_revoked')::jsonb;
 c:=public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source');
 perform set_config('qorpera_test.revoked_upload_command',c::text,true);
 begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',jsonb_set(v->'plan','{entry,executable}','true'),v->>'manifest',v->'source');
  raise exception 'Executable upload accepted'; exception when invalid_parameter_value then null; end;
 m:=jsonb_set((v->>'manifest')::jsonb,'{chunks,0,bytes}','0');
 bad_plan:=jsonb_set(v->'plan','{entry,file,manifestSha256}',to_jsonb(encode(extensions.digest(convert_to(m::text,'utf8'),'sha256'),'hex')));
 begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',bad_plan,m::text,v->'source');
  raise exception 'Invalid zero chunk admitted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',m::text,v->'source');
  raise exception 'Changed manifest digest admitted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',jsonb_set(v->'plan','{expectedVersion}','"00000000-0000-4000-8000-000000000001"'),v->>'manifest',v->'source');
  raise exception 'Stale destination accepted'; exception when unique_violation then null; end;
end $$;
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
do $$ declare c jsonb:=current_setting('qorpera_test.protected_upload_command')::jsonb; begin
 begin perform pg_temp.member_apply(c); raise exception 'Unreviewed upload applied'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001'); set local role authenticated;
select public.qorpera_review_member_company_path_command((current_setting('qorpera_test.protected_upload_command')::jsonb->>'commandId')::uuid,current_setting('qorpera_test.protected_upload_command')::jsonb->>'planSha256','approve');
select public.qorpera_set_company_path_resource('29500000-0000-4000-8000-000000000020','revoked-upload.bin','exact','company_shared','protected',(current_setting('qorpera_test.upload_resource')::jsonb->>'version')::uuid);
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.member_apply(current_setting('qorpera_test.protected_upload_command')::jsonb);
do $$ declare c jsonb:=current_setting('qorpera_test.revoked_upload_command')::jsonb; v jsonb:=current_setting('qorpera_test.upload_revoked')::jsonb; begin
 begin perform public.qorpera_stage_member_company_path_object((c->>'commandId')::uuid,c->>'planSha256',v#>>'{source,sha256}',3,false,false);
  raise exception 'Changed resource retained upload staging'; exception when insufficient_privilege then null; end;
 begin perform pg_temp.member_apply(c); raise exception 'Changed resource retained upload publication'; exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ declare v_role text; begin
 foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
  if has_table_privilege(v_role,'public.qorpera_member_company_file_uploads','SELECT,INSERT,UPDATE,DELETE') then raise exception 'Upload metadata exposed'; end if;
  if has_function_privilege(v_role,'public.qorpera_begin_member_company_path_intent(uuid,jsonb)','EXECUTE') then raise exception 'Private command admission exposed'; end if;
 end loop;
 if has_function_privilege('service_role','public.qorpera_begin_member_company_file_upload(uuid,jsonb,text,jsonb)','EXECUTE') or
  has_function_privilege('anon','public.qorpera_begin_member_company_file_upload(uuid,jsonb,text,jsonb)','EXECUTE') then raise exception 'Non-member upload admission exposed'; end if;
end $$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.upload',pg_temp.member_upload('binary-member-upload','uploads.bin',decode(repeat('61',4194304)||'00ff80','hex'))::text,true);
select set_config('qorpera_test.upload_small',pg_temp.member_upload('small-member-upload','small-upload.bin',decode('00ff80','hex'))::text,true);
select set_config('qorpera_test.upload_empty',pg_temp.member_upload('empty-member-upload','empty-upload.bin',''::bytea)::text,true);
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare v jsonb:=current_setting('qorpera_test.upload')::jsonb; c jsonb; altered jsonb; begin
 begin perform public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',v->'plan');
  raise exception 'Text lane admitted a large binary'; exception when invalid_parameter_value then null; end;
 c:=public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source');
 if c->>'state'<>'ready' then raise exception 'Ordinary upload requires unnecessary review'; end if;
 perform set_config('qorpera_test.upload_command',c::text,true);
 if c<>public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source') then raise exception 'Upload retry changed command'; end if;
 begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',jsonb_set(v->'source','{name}','"other.bin"'));
  raise exception 'Same bytes substituted another source'; exception when unique_violation then null; end;
 foreach altered in array array[jsonb_set(v->'source','{realm}','"company_computer"'),jsonb_set(v->'source','{name}','"../file.bin"'),
  jsonb_set(v->'source','{bytes}','8'),(v->'source')||'{"localPath":"/private/file"}'::jsonb] loop
  begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',altered);
   raise exception 'Malformed upload source admitted'; exception when invalid_parameter_value then null; end;
 end loop;
end $$;
reset role;
do $$ declare v jsonb:=current_setting('qorpera_test.upload')::jsonb; part jsonb; begin
 for part in select value from jsonb_array_elements((v->>'manifest')::jsonb->'chunks') loop
  if not exists(select 1 from public.qorpera_company_additional_retained_object_hashes('29500000-0000-4000-8000-000000000010') where object_sha256=part->>'sha256') then raise exception 'Pending upload chunk not retained'; end if;
 end loop;
end $$;
select pg_temp.path_claims('service_role'); set local role service_role;
do $$ declare v jsonb:=current_setting('qorpera_test.upload')::jsonb; c jsonb:=current_setting('qorpera_test.upload_command')::jsonb; part jsonb; result jsonb; begin
 for part in select value from jsonb_array_elements((v->>'manifest')::jsonb->'chunks') loop
  perform public.qorpera_stage_member_company_path_object((c->>'commandId')::uuid,c->>'planSha256',part->>'sha256',(part->>'bytes')::bigint,false,false);
 end loop;
 begin perform public.qorpera_stage_member_company_path_object((c->>'commandId')::uuid,c->>'planSha256',v#>>'{source,sha256}',(v#>>'{source,bytes}')::bigint,false,false);
  raise exception 'Unselected whole-file object staged'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_stage_member_company_path_object((c->>'commandId')::uuid,c->>'planSha256',repeat('a',64),1,false,false);
  raise exception 'Unrelated object staged'; exception when invalid_parameter_value then null; end;
 result:=pg_temp.member_apply(c); if result->>'state'<>'applied' then raise exception 'Upload not applied'; end if;
 if result<>pg_temp.member_apply(c) then raise exception 'Applied upload replay changed'; end if;
 perform set_config('qorpera_test.upload_applied',result::text,true);
end $$;
reset role;
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001'); set local role authenticated;
do $$ declare v jsonb:=current_setting('qorpera_test.upload')::jsonb; c jsonb; begin
 c:=public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source');
 if c<>current_setting('qorpera_test.upload_applied')::jsonb then raise exception 'Lost upload response failed replay'; end if;
 v:=current_setting('qorpera_test.upload_small')::jsonb;
 c:=public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',v->'plan');
 begin perform public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source');
  raise exception 'Existing text command decorated as upload'; exception when unique_violation then null; end;
 v:=current_setting('qorpera_test.upload_empty')::jsonb;
 c:=public.qorpera_begin_member_company_file_upload('29500000-0000-4000-8000-000000000020',v->'plan',v->>'manifest',v->'source');
 perform set_config('qorpera_test.upload_empty_command',c::text,true);
 begin perform public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',v->'plan');
  raise exception 'Upload replayed through text lane'; exception when unique_violation then null; end;
end $$;
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.member_apply(current_setting('qorpera_test.upload_empty_command')::jsonb);
reset role;
-- Preserve original producer identity and the original canonical receipt.
do $$ declare c jsonb:=current_setting('qorpera_test.upload_applied')::jsonb; begin
 if not exists(select 1 from public.qorpera_member_company_file_uploads u join public.qorpera_member_company_path_commands cmd on cmd.id=u.command_id
  where u.command_id=(c->>'commandId')::uuid and cmd.user_id='29500000-0000-4000-8000-000000000001' and cmd.result=c->'result'
   and u.source=current_setting('qorpera_test.upload')::jsonb->'source') then raise exception 'Upload source/receipt provenance absent'; end if;
end $$;

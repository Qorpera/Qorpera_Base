-- Metadata-only descriptor regression using real human path authority and
-- publication. Only verified Storage objects are fixtures; no helper is replaced.
begin;

insert into auth.users(id,email) values
	('34000000-0000-4000-8000-000000000001','snapshot-owner@example.test'),
	('34000000-0000-4000-8000-000000000002','snapshot-member@example.test'),
	('34000000-0000-4000-8000-000000000003','snapshot-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('34000000-0000-4000-8000-000000000010','Member snapshot fixture','34000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('34000000-0000-4000-8000-000000000010','34000000-0000-4000-8000-000000000001','snapshot-owner@example.test','Owner','owner'),
	('34000000-0000-4000-8000-000000000010','34000000-0000-4000-8000-000000000002','snapshot-member@example.test','Member','contributor'),
	('34000000-0000-4000-8000-000000000010','34000000-0000-4000-8000-000000000003','snapshot-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('34000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000010','Environment',1,'34000000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','34000000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','34000000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('34000000-0000-4000-8000-000000000010',v_manifest);
	return jsonb_build_object('path',p_path,'kind','file','executable',false,'file',jsonb_build_object(
		'manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),'mediaType','application/octet-stream'));
end
$$;

create function pg_temp.path_stage_tree(p_entries jsonb)
returns text language plpgsql security definer as $$
declare v_manifest text; v_sha text;
begin
	v_manifest := jsonb_build_object('schema','qorpera.company-tree/v1','contractVersion',3,'omittedLayers',
		'["company-git-history","session-trail","staff-registry","product-git-checkouts","dependency-caches","staff-instructions","system-metadata"]'::jsonb,
		'entries',p_entries)::text;
	v_sha := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','34000000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('34000000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.path_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '34000000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'34000000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '34000000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('34000000-0000-4000-8000-000000000025','34000000-0000-4000-8000-000000000010',
	'34000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000023',
	'34000000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'34000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '34000000-0000-4000-8000-000000000027',profile_id,'34000000-0000-4000-8000-000000000020','company_snapshot',
	'34000000-0000-4000-8000-000000000023','34000000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'34000000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where profile_id = '34000000-0000-4000-8000-000000000010' and sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '34000000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where profile_id = '34000000-0000-4000-8000-000000000010' and sha256 = current_setting('qorpera_test.path_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '34000000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('34000000-0000-4000-8000-000000000027','34000000-0000-4000-8000-000000000010',
	'34000000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'34000000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '34000000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '34000000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '34000000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '34000000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('34000000-0000-4000-8000-000000000020',
	'34000000-0000-4000-8000-000000000023','34000000-0000-4000-8000-000000000001');
reset role;

-- The canonical file is a human command; it does not require a run, sponsor,
-- model, native identity or model account.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.snapshot_entry',pg_temp.path_stage_file('note.md','Human snapshot fixture')::text,true);
select pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.snapshot_command',public.qorpera_begin_member_company_path_command(
	'34000000-0000-4000-8000-000000000020',jsonb_build_object(
		'schema','qorpera.company-path-mutation/v1','operationKey','snapshot-create',
		'path','note.md','expectedVersion',null,'entry',current_setting('qorpera_test.snapshot_entry')::jsonb))::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_command jsonb := current_setting('qorpera_test.snapshot_command')::jsonb;
	v_prepared jsonb; v_tree text; v_result jsonb;
begin
	v_prepared := public.qorpera_prepare_member_company_path_command((v_command ->> 'commandId')::uuid,v_command ->> 'planSha256');
	v_tree := pg_temp.path_stage_tree(jsonb_build_array(current_setting('qorpera_test.snapshot_entry')::jsonb));
	v_result := public.qorpera_apply_member_company_path_command_v3((v_command ->> 'commandId')::uuid,
		v_command ->> 'planSha256',(v_prepared ->> 'snapshotId')::uuid,v_tree,null);
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'Human fixture did not publish'; end if;
	perform set_config('qorpera_test.snapshot_version',v_result #>> '{result,version}',true);
end
$$;
reset role;


select set_config('qorpera_test.old_snapshot',(select head_snapshot_id::text from public.qorpera_company_files
 where environment_id='34000000-0000-4000-8000-000000000020'),true);

-- Advance the canonical head with the real human publication route. History
-- must select the old file, never substitute the new current path version.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.new_entry',pg_temp.path_stage_file('note.md','New current file')::text,true);
select pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.new_command',public.qorpera_begin_member_company_path_command(
 '34000000-0000-4000-8000-000000000020',jsonb_build_object(
 'schema','qorpera.company-path-mutation/v1','operationKey','history-next',
 'path','note.md','expectedVersion',current_setting('qorpera_test.snapshot_version')::uuid,
 'entry',current_setting('qorpera_test.new_entry')::jsonb))::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare command jsonb:=current_setting('qorpera_test.new_command')::jsonb; prepared jsonb; tree text; result jsonb;
begin
 prepared:=public.qorpera_prepare_member_company_path_command((command->>'commandId')::uuid,command->>'planSha256');
 tree:=pg_temp.path_stage_tree(jsonb_build_array(current_setting('qorpera_test.new_entry')::jsonb));
 result:=public.qorpera_apply_member_company_path_command_v3((command->>'commandId')::uuid,
  command->>'planSha256',(prepared->>'snapshotId')::uuid,tree,null);
 if result->>'state' is distinct from 'applied' then raise exception 'Second publication failed'; end if;
end
$$;
reset role;

do $$
declare fn regprocedure; role_name text;
begin
 foreach fn in array array[
  'public.qorpera_list_member_company_snapshot_paths(uuid,uuid,text,integer)'::regprocedure,
  'public.qorpera_read_member_company_snapshot_path(uuid,uuid,text)'::regprocedure,
  'public.qorpera_authorize_member_company_snapshot_object(uuid,text,uuid,text)'::regprocedure] loop
  if not has_function_privilege('authenticated',fn,'execute') then raise exception 'Missing member execute'; end if;
  foreach role_name in array array['anon','service_role'] loop
   if has_function_privilege(role_name,fn,'execute') then raise exception 'Snapshot exposed to %',role_name; end if;
  end loop;
 end loop;
 if has_function_privilege('authenticated','public.qorpera_member_company_snapshot_tree(jsonb,uuid)','execute')
  or has_function_privilege('service_role','public.qorpera_member_company_snapshot_tree(jsonb,uuid)','execute')
 then raise exception 'Unfiltered tree helper exposed'; end if;
end
$$;

-- Historical roots retain verified closure after the seven-day recovery
-- proof expires. Reading one historical path must not depend on weekly
-- full-company restoration (ARTIFACT-GC.md).
select pg_temp.path_claims('service_role');
update public.qorpera_object_restore_proofs
set verified_at=statement_timestamp()-interval '8 days',valid_until=statement_timestamp()-interval '1 day'
where graph_id in (select id from public.qorpera_object_reachability_graphs
 where root_kind='company_snapshot' and root_id=current_setting('qorpera_test.old_snapshot')::uuid);
do $$ begin
 if public.qorpera_object_root_has_current_proof('company_snapshot',current_setting('qorpera_test.old_snapshot')::uuid)
 then raise exception 'Historical fixture proof did not expire'; end if;
end $$;

do $$
declare user_id uuid; env uuid:='34000000-0000-4000-8000-000000000020';
 snap uuid:=current_setting('qorpera_test.old_snapshot')::uuid;
 old_entry jsonb:=current_setting('qorpera_test.snapshot_entry')::jsonb;
 value jsonb; hash text;
begin
 foreach user_id in array array['34000000-0000-4000-8000-000000000001'::uuid,
  '34000000-0000-4000-8000-000000000002'::uuid,'34000000-0000-4000-8000-000000000003'::uuid] loop
  perform pg_temp.path_claims('authenticated',user_id);
  set local role authenticated;
  value:=public.qorpera_list_member_company_snapshot_paths(env,snap,null,1);
  if value->'items' is distinct from jsonb_build_array(old_entry)
   or value->>'snapshotId' is distinct from snap::text or (value->>'hasMore')::boolean
   or value->'nextAfter' <> 'null'::jsonb then raise exception 'Historical page differs'; end if;
  value:=public.qorpera_list_member_company_snapshot_paths(env,snap,'note.md',1);
  if value->'items' <> '[]'::jsonb then raise exception 'Cursor repeated entry'; end if;
  value:=public.qorpera_read_member_company_snapshot_path(env,snap,'note.md');
  if value->'entry' is distinct from old_entry or value->>'version' is distinct from snap::text
   then raise exception 'History substituted current file'; end if;
  foreach hash in array array[old_entry#>>'{file,manifestSha256}',old_entry#>>'{file,fileSha256}'] loop
   value:=public.qorpera_authorize_member_company_snapshot_object(env,'note.md',snap,hash);
   if value->>'actorUserId' is distinct from user_id::text or value->>'version' is distinct from snap::text
    or value->>'sha256' is distinct from hash then raise exception 'Snapshot identity was not preserved'; end if;
  end loop;
  begin
   perform public.qorpera_authorize_member_company_snapshot_object(env,'note.md',snap,current_setting('qorpera_test.new_entry')::jsonb#>>'{file,fileSha256}');
   raise exception 'Current bytes admitted to old snapshot';
  exception when insufficient_privilege then null; end;
  begin
   perform public.qorpera_authorize_member_company_snapshot_object(env,'other.md',snap,hash);
   raise exception 'Sibling path admitted';
  exception when insufficient_privilege then null; end;
  begin
   perform public.qorpera_authorize_member_company_snapshot_object(env,'NOTE.md',snap,hash);
   raise exception 'Alias admitted';
  exception when insufficient_privilege then null; end;
  begin
   perform public.qorpera_list_member_company_snapshot_paths(env,snap,null,101);
   raise exception 'Unbounded page admitted';
  exception when invalid_parameter_value then null; end;
  reset role;
 end loop;
end
$$;

select pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_path_resource('34000000-0000-4000-8000-000000000020',
 'note.md','exact','company_shared','normal',null);
reset role;
do $$
declare probe text; env uuid:='34000000-0000-4000-8000-000000000020';
 snap uuid:=current_setting('qorpera_test.old_snapshot')::uuid;
 hash text:=current_setting('qorpera_test.snapshot_entry')::jsonb#>>'{file,fileSha256}';
 page jsonb;
begin
 foreach probe in array array['private','revoked','member-removed','missing-human','service-role','unpublished','missing-graph','unverified-closure','missing-tree-cache','wrong-snapshot','wrong-environment'] loop
  begin
   perform pg_temp.path_claims('service_role');
   if probe='private' then
    update public.qorpera_company_path_resources set scope='member_private',owner_user_id='34000000-0000-4000-8000-000000000001'
     where environment_id=env and path='note.md';
   elsif probe='revoked' then
    update public.qorpera_company_path_resources set revoked_at=clock_timestamp() where environment_id=env and path='note.md';
   elsif probe='member-removed' then
    delete from public.qorpera_profile_members where profile_id='34000000-0000-4000-8000-000000000010'
     and user_id='34000000-0000-4000-8000-000000000003';
   elsif probe='unpublished' then
    update public.qorpera_company_snapshot_publications set status='prepared',published_at=null where snapshot_id=snap;
   elsif probe='missing-graph' then
    delete from public.qorpera_object_reachability_graphs where root_kind='company_snapshot' and root_id=snap;
   elsif probe='unverified-closure' then
    update public.qorpera_object_reachability_graphs set closure_verified=false where root_kind='company_snapshot' and root_id=snap;
   elsif probe='missing-tree-cache' then
    delete from public.qorpera_company_path_tree_cache where profile_id='34000000-0000-4000-8000-000000000010'
     and sha256=(select tree_manifest_sha256 from public.qorpera_company_snapshots where id=snap);
   end if;
   perform pg_temp.path_claims(case when probe='service-role' then 'service_role' else 'authenticated' end,
    case when probe='missing-human' then null else '34000000-0000-4000-8000-000000000003'::uuid end);
   set local role authenticated;
   if probe in ('private','revoked') then
    page:=public.qorpera_list_member_company_snapshot_paths(env,snap);
    if page->'items' <> '[]'::jsonb or (page->>'hasMore')::boolean then raise exception 'Hidden path leaked through history'; end if;
   end if;
   begin
    perform public.qorpera_authorize_member_company_snapshot_object(
     case when probe='wrong-environment' then '34000000-0000-4000-8000-000000000019'::uuid else env end,
     'note.md',case when probe='wrong-snapshot' then env else snap end,hash);
    raise exception 'Snapshot read accepted denied case %',probe;
   exception when insufficient_privilege then null; when object_not_in_prerequisite_state then
    if probe<>'wrong-environment' then raise; end if;
   end;
   raise exception using errcode='QTC01';
  exception when sqlstate 'QTC01' then null; end;
 end loop;
end
$$;

-- Exercise real pagination across currently hidden entries and UTF-8 ordering.
-- Each directory is published through the same human command route as files.
do $$
declare env uuid:='34000000-0000-4000-8000-000000000020'; target text;
 command jsonb; prepared jsonb; result jsonb; entries jsonb; tree text; snap uuid;
 page jsonb; cursor text:=null; expected text; actual text[]:='{}';
begin
 foreach target in array array['a-visible','z-hidden',chr(57344),chr(65536)] loop
  perform pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000001');
  set local role authenticated;
  command:=public.qorpera_begin_member_company_path_command(env,jsonb_build_object(
   'schema','qorpera.company-path-mutation/v1','operationKey','page-'||md5(target),
   'path',target,'expectedVersion',null,'entry',jsonb_build_object('path',target,'kind','directory')));
  reset role;
  perform pg_temp.path_claims('service_role');
  set local role service_role;
  prepared:=public.qorpera_prepare_member_company_path_command((command->>'commandId')::uuid,command->>'planSha256');
  reset role;
  select cache.manifest->'entries' into entries from public.qorpera_company_files file
   join public.qorpera_company_snapshots snapshot on snapshot.id=file.head_snapshot_id
   join public.qorpera_company_path_tree_cache cache on cache.profile_id=snapshot.profile_id and cache.sha256=snapshot.tree_manifest_sha256
   where file.environment_id=env;
  select jsonb_agg(entry order by (entry->>'path') collate "C") into entries
   from jsonb_array_elements(entries||jsonb_build_array(jsonb_build_object('path',target,'kind','directory'))) entry;
  set local role service_role;
  tree:=pg_temp.path_stage_tree(entries);
  result:=public.qorpera_apply_member_company_path_command_v3((command->>'commandId')::uuid,
   command->>'planSha256',(prepared->>'snapshotId')::uuid,tree,null);
  if result->>'state' is distinct from 'applied' then raise exception 'Directory publication failed'; end if;
  reset role;
 end loop;
 select head_snapshot_id into snap from public.qorpera_company_files where environment_id=env;
 perform pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000001');
 set local role authenticated;
 perform public.qorpera_set_company_path_resource(env,'z-hidden','exact','member_private','normal',null);
 reset role;
 perform pg_temp.path_claims('authenticated','34000000-0000-4000-8000-000000000003');
 set local role authenticated;
 foreach expected in array array['a-visible','note.md',chr(57344),chr(65536)] loop
  page:=public.qorpera_list_member_company_snapshot_paths(env,snap,cursor,1);
  if jsonb_array_length(page->'items')<>1 or page#>>'{items,0,path}' is distinct from expected
   then raise exception 'Filtered snapshot page order differs: %',page; end if;
  actual:=array_append(actual,page#>>'{items,0,path}');
  if expected=chr(65536) then
   if (page->>'hasMore')::boolean or page->'nextAfter'<>'null'::jsonb then raise exception 'Final page cursor differs'; end if;
  else
   if not (page->>'hasMore')::boolean or page->>'nextAfter' is distinct from expected then raise exception 'Continuation cursor differs'; end if;
  end if;
  cursor:=expected;
 end loop;
 if cardinality(actual)<>4 then raise exception 'Pagination was incomplete'; end if;
 reset role;
end
$$;
set constraints all immediate;
rollback;

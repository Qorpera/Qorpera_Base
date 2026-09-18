-- Real admission, assignment and native-lease contracts; no substituted
-- authority helper. Storage fixtures below stand in only for verified bytes.
begin;

insert into auth.users(id,email) values
	('29500000-0000-4000-8000-000000000001','path-owner@example.test'),
	('29500000-0000-4000-8000-000000000002','path-member@example.test'),
	('29500000-0000-4000-8000-000000000003','path-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('29500000-0000-4000-8000-000000000010','Path gateway fixture','29500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('29500000-0000-4000-8000-000000000010','29500000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('29500000-0000-4000-8000-000000000010','29500000-0000-4000-8000-000000000002','path-member@example.test','Member','contributor'),
	('29500000-0000-4000-8000-000000000010','29500000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('29500000-0000-4000-8000-000000000020','29500000-0000-4000-8000-000000000010','Environment',1,'29500000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29500000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29500000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('29500000-0000-4000-8000-000000000010',v_manifest);
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
	values ('qorpera-profile-objects','29500000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('29500000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.path_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '29500000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'29500000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '29500000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('29500000-0000-4000-8000-000000000025','29500000-0000-4000-8000-000000000010',
	'29500000-0000-4000-8000-000000000020','29500000-0000-4000-8000-000000000023',
	'29500000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'29500000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '29500000-0000-4000-8000-000000000027',profile_id,'29500000-0000-4000-8000-000000000020','company_snapshot',
	'29500000-0000-4000-8000-000000000023','29500000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'29500000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '29500000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where sha256 = current_setting('qorpera_test.path_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '29500000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('29500000-0000-4000-8000-000000000027','29500000-0000-4000-8000-000000000010',
	'29500000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'29500000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '29500000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '29500000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '29500000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '29500000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('29500000-0000-4000-8000-000000000020',
	'29500000-0000-4000-8000-000000000023','29500000-0000-4000-8000-000000000001');
reset role;


-- Human commands never mint a native run, lease or tool binding.
create function pg_temp.member_apply(p_command jsonb)
returns jsonb language plpgsql as $$
declare v_prepared jsonb; v_entries jsonb; v_tree text;
begin
	v_prepared := public.qorpera_prepare_member_company_path_command((p_command ->> 'commandId')::uuid,p_command ->> 'planSha256');
	if v_prepared ->> 'state' = 'applied' then
		return public.qorpera_apply_member_company_path_command((p_command ->> 'commandId')::uuid,p_command ->> 'planSha256',null,null);
	end if;
	select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
		select value from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> v_prepared #>> '{plan,path}'
		union all select v_prepared #> '{plan,entry}' where v_prepared #> '{plan,entry}' <> 'null'::jsonb
	) entries;
	v_tree := pg_temp.path_stage_tree(v_entries);
	return public.qorpera_apply_member_company_path_command((p_command ->> 'commandId')::uuid,
		p_command ->> 'planSha256',(v_prepared ->> 'snapshotId')::uuid,v_tree);
end
$$;

create function pg_temp.member_plan(p_key text,p_path text,p_entry jsonb,p_version uuid default null)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.company-path-mutation/v1','operationKey',p_key,'path',p_path,
		'expectedVersion',p_version,'entry',p_entry)
$$;

create function pg_temp.member_revision_count()
returns bigint language sql security definer as $$ select count(*) from public.qorpera_company_path_revisions $$;

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_table_privilege(v_role,'public.qorpera_member_company_path_commands','SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Human command ledger is exposed to %',v_role; end if;
		foreach v_function in array array[
			'public.qorpera_member_company_path_command_actor(uuid,text,boolean)',
			'public.qorpera_member_company_path_command_value(public.qorpera_member_company_path_commands)'
		] loop
			if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Private human helper exposed'; end if;
		end loop;
	end loop;
	if has_function_privilege('authenticated','public.qorpera_apply_member_company_path_command(uuid,text,uuid,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_begin_member_company_path_command(uuid,jsonb)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_review_member_company_path_command(uuid,text,text)','EXECUTE') then
		raise exception 'Human intent and cloud publication authority are not separate'; end if;
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.member_entry',pg_temp.path_stage_file('note.md','Live human edit')::text,true);
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_mode jsonb;
begin
	v_mode := public.qorpera_member_company_file_mode('29500000-0000-4000-8000-000000000010');
	if v_mode <> '{"companyId":"29500000-0000-4000-8000-000000000010","environmentId":"29500000-0000-4000-8000-000000000020","mode":"governed"}'::jsonb then
		raise exception 'Member mode identity changed'; end if;
end
$$;
select set_config('qorpera_test.member_command',public.qorpera_begin_member_company_path_command(
	'29500000-0000-4000-8000-000000000020',pg_temp.member_plan('human-1','note.md',current_setting('qorpera_test.member_entry')::jsonb))::text,true);
do $$
declare v_command jsonb := current_setting('qorpera_test.member_command')::jsonb; v_page jsonb;
begin
	if v_command ->> 'state' <> 'ready' then raise exception 'Ordinary human edit did not become ready'; end if;
	if public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',v_command -> 'plan') <> v_command then
		raise exception 'Repeated human intent did not recover its exact command'; end if;
	v_page := public.qorpera_list_member_company_path_commands('29500000-0000-4000-8000-000000000020');
	if jsonb_array_length(v_page -> 'items') <> 1 then raise exception 'Pending human edit was lost'; end if;
	begin
		perform public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',
			(v_command -> 'plan') || '{"entry":null}'::jsonb);
		raise exception 'Human operation key was repurposed';
	exception when unique_violation then null; end;
	begin
		perform public.qorpera_review_member_company_path_command((v_command ->> 'commandId')::uuid,v_command ->> 'planSha256','approve');
		raise exception 'Unprotected command accepted an approval verb';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.member_applied',pg_temp.member_apply(current_setting('qorpera_test.member_command')::jsonb)::text,true);
do $$
declare v_result jsonb := current_setting('qorpera_test.member_applied')::jsonb; v_before bigint;
begin
	v_before := pg_temp.member_revision_count();
	if v_result ->> 'state' <> 'applied' or v_result #>> '{result,path}' <> 'note.md' then raise exception 'Human edit did not publish'; end if;
	if pg_temp.member_apply(current_setting('qorpera_test.member_command')::jsonb) <> v_result then raise exception 'Lost human receipt did not replay'; end if;
	if pg_temp.member_revision_count() <> v_before then raise exception 'Replay repeated a human effect'; end if;
end
$$;
reset role;

select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_result jsonb := current_setting('qorpera_test.member_applied')::jsonb;
begin
	if public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',v_result -> 'plan') <> v_result then
		raise exception 'Applied retry failed obsolete expectedVersion'; end if;
	if public.qorpera_read_company_path('29500000-0000-4000-8000-000000000020','note.md') ->> 'version' <> v_result #>> '{result,version}' then
		raise exception 'Human edit did not update live path'; end if;
	begin
		perform public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',
			(v_result -> 'plan') || '{"operationKey":"stale-version"}'::jsonb);
		raise exception 'Stale human edit silently overwrote';
	exception when sqlstate 'PT412' then null; end;
end
$$;
reset role;

select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000003');
set local role authenticated;
do $$
begin
	perform public.qorpera_read_company_path('29500000-0000-4000-8000-000000000020','note.md');
	if jsonb_array_length(public.qorpera_list_member_company_path_commands('29500000-0000-4000-8000-000000000020') -> 'items') <> 0 then
		raise exception 'Another member can list private human intent'; end if;
	begin
		perform public.qorpera_get_member_company_path_command((current_setting('qorpera_test.member_command')::jsonb ->> 'commandId')::uuid);
		raise exception 'Another member can retrieve private human intent';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_begin_member_company_path_command('29500000-0000-4000-8000-000000000020',
			pg_temp.member_plan('viewer-write','viewer',jsonb_build_object('path','viewer','kind','directory')));
		raise exception 'Viewer can write';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

-- A contributor cannot create a protected intent that only its original
-- author may approve, nor quietly turn its ordinary edit grant into delete.
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
	begin
		perform public.qorpera_begin_member_company_path_command(
			'29500000-0000-4000-8000-000000000020',pg_temp.member_plan('member-delete','note.md',null,
			(current_setting('qorpera_test.member_applied')::jsonb #>> '{result,version}')::uuid));
		raise exception 'Contributor admitted protected human intent';
	exception when insufficient_privilege then null; end;
	if jsonb_array_length(public.qorpera_list_member_company_path_commands('29500000-0000-4000-8000-000000000020') -> 'items') <> 0 then
		raise exception 'Unreviewable intent was left pending'; end if;
end
$$;
reset role;

select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.member_delete',public.qorpera_begin_member_company_path_command(
	'29500000-0000-4000-8000-000000000020',pg_temp.member_plan('human-delete','note.md',null,
	(current_setting('qorpera_test.member_applied')::jsonb #>> '{result,version}')::uuid))::text,true);
do $$
declare v_command jsonb := current_setting('qorpera_test.member_delete')::jsonb;
begin
	if v_command ->> 'state' <> 'review_required' then raise exception 'Delete did not require review'; end if;
	begin
		perform public.qorpera_review_member_company_path_command((v_command ->> 'commandId')::uuid,repeat('0',64),'approve');
		raise exception 'Wrong digest approved';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform pg_temp.member_apply(current_setting('qorpera_test.member_delete')::jsonb);
		raise exception 'Unreviewed delete applied';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.member_delete')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.member_delete')::jsonb ->> 'planSha256','skip');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform pg_temp.member_apply(current_setting('qorpera_test.member_delete')::jsonb);
		raise exception 'Dismissal became consent';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.member_delete',public.qorpera_begin_member_company_path_command(
	'29500000-0000-4000-8000-000000000020',pg_temp.member_plan('human-delete-approved','note.md',null,
	(current_setting('qorpera_test.member_applied')::jsonb #>> '{result,version}')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.member_delete')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.member_delete')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.member_apply(current_setting('qorpera_test.member_delete')::jsonb);
reset role;

-- Admission and application are independently checked. Revoke or expire
-- after the first transaction without allowing a stale stored human intent.
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.member_revoke',public.qorpera_begin_member_company_path_command(
	'29500000-0000-4000-8000-000000000020',pg_temp.member_plan('member-revoke','member',jsonb_build_object('path','member','kind','directory')))::text,true);
reset role;
delete from public.qorpera_profile_members where profile_id = '29500000-0000-4000-8000-000000000010' and user_id = '29500000-0000-4000-8000-000000000002';
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform pg_temp.member_apply(current_setting('qorpera_test.member_revoke')::jsonb);
		raise exception 'Removed member retained edit authority';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29500000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.member_expire',public.qorpera_begin_member_company_path_command(
	'29500000-0000-4000-8000-000000000020',pg_temp.member_plan('member-expire','expired',jsonb_build_object('path','expired','kind','directory')))::text,true);
reset role;
update public.qorpera_member_company_path_commands set expires_at = clock_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.member_expire')::jsonb ->> 'commandId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform pg_temp.member_apply(current_setting('qorpera_test.member_expire')::jsonb);
		raise exception 'Expired edit retained authority';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

-- Exact pending file content participates in the existing cleanup fence.
do $$
begin
	if not exists(select 1 from public.qorpera_company_additional_retained_object_hashes('29500000-0000-4000-8000-000000000010')
		where object_sha256 = current_setting('qorpera_test.member_entry')::jsonb #>> '{file,fileSha256}') then
		raise exception 'Pending human bytes are not retained'; end if;
	if exists(select 1 from public.qorpera_execution_runs where profile_id = '29500000-0000-4000-8000-000000000010') then
		raise exception 'Human File editing requires a model run'; end if;
end
$$;
rollback;

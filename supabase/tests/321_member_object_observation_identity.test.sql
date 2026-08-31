-- Metadata-only descriptor regression using real human path authority and
-- publication. Only verified Storage objects are fixtures; no helper is replaced.
begin;

insert into auth.users(id,email) values
	('32100000-0000-4000-8000-000000000001','observation-owner@example.test'),
	('32100000-0000-4000-8000-000000000002','observation-member@example.test'),
	('32100000-0000-4000-8000-000000000003','observation-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('32100000-0000-4000-8000-000000000010','Member observation fixture','32100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('32100000-0000-4000-8000-000000000010','32100000-0000-4000-8000-000000000001','observation-owner@example.test','Owner','owner'),
	('32100000-0000-4000-8000-000000000010','32100000-0000-4000-8000-000000000002','observation-member@example.test','Member','contributor'),
	('32100000-0000-4000-8000-000000000010','32100000-0000-4000-8000-000000000003','observation-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('32100000-0000-4000-8000-000000000020','32100000-0000-4000-8000-000000000010','Environment',1,'32100000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','32100000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','32100000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('32100000-0000-4000-8000-000000000010',v_manifest);
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
	values ('qorpera-profile-objects','32100000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('32100000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.path_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','32100000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '32100000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'32100000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '32100000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('32100000-0000-4000-8000-000000000025','32100000-0000-4000-8000-000000000010',
	'32100000-0000-4000-8000-000000000020','32100000-0000-4000-8000-000000000023',
	'32100000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'32100000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '32100000-0000-4000-8000-000000000027',profile_id,'32100000-0000-4000-8000-000000000020','company_snapshot',
	'32100000-0000-4000-8000-000000000023','32100000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'32100000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where profile_id = '32100000-0000-4000-8000-000000000010' and sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '32100000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where profile_id = '32100000-0000-4000-8000-000000000010' and sha256 = current_setting('qorpera_test.path_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '32100000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('32100000-0000-4000-8000-000000000027','32100000-0000-4000-8000-000000000010',
	'32100000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'32100000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '32100000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '32100000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '32100000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '32100000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('32100000-0000-4000-8000-000000000020',
	'32100000-0000-4000-8000-000000000023','32100000-0000-4000-8000-000000000001');
reset role;

-- The canonical file is a human command; it does not require a run, sponsor,
-- model, native identity or model account.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.observation_entry',pg_temp.path_stage_file('note.md','Human observation fixture')::text,true);
select pg_temp.path_claims('authenticated','32100000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.observation_command',public.qorpera_begin_member_company_path_command(
	'32100000-0000-4000-8000-000000000020',jsonb_build_object(
		'schema','qorpera.company-path-mutation/v1','operationKey','observation-create',
		'path','note.md','expectedVersion',null,'entry',current_setting('qorpera_test.observation_entry')::jsonb))::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_command jsonb := current_setting('qorpera_test.observation_command')::jsonb;
	v_prepared jsonb; v_tree text; v_result jsonb;
begin
	v_prepared := public.qorpera_prepare_member_company_path_command((v_command ->> 'commandId')::uuid,v_command ->> 'planSha256');
	v_tree := pg_temp.path_stage_tree(jsonb_build_array(current_setting('qorpera_test.observation_entry')::jsonb));
	v_result := public.qorpera_apply_member_company_path_command_v3((v_command ->> 'commandId')::uuid,
		v_command ->> 'planSha256',(v_prepared ->> 'snapshotId')::uuid,v_tree,null);
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'Human fixture did not publish'; end if;
	perform set_config('qorpera_test.observation_version',v_result #>> '{result,version}',true);
end
$$;
reset role;

do $$
declare v_role text; v_function regprocedure := 'public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text)'::regprocedure;
begin
	foreach v_role in array array['anon','service_role'] loop
		if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Human descriptor exposed to %',v_role; end if;
	end loop;
	if not has_function_privilege('authenticated',v_function,'EXECUTE')
		or exists(select 1 from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) acl
			where p.oid = v_function and acl.grantee = 0 and acl.privilege_type = 'EXECUTE') then
		raise exception 'Human descriptor EXECUTE boundary changed'; end if;
	if not exists(select 1 from pg_catalog.pg_proc where oid = v_function and prosecdef
		and proconfig = array['search_path=""']) then raise exception 'Human descriptor definer fence changed'; end if;
end
$$;

do $$
declare v_user uuid; v_hash text; v_result jsonb; v_keys text[];
	v_environment uuid := '32100000-0000-4000-8000-000000000020';
	v_version uuid := current_setting('qorpera_test.observation_version')::uuid;
	v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into strict v_resource from public.qorpera_company_path_resources where environment_id = v_environment and path = '';
	foreach v_user in array array['32100000-0000-4000-8000-000000000001'::uuid,
		'32100000-0000-4000-8000-000000000002'::uuid,'32100000-0000-4000-8000-000000000003'::uuid] loop
		perform pg_temp.path_claims('authenticated',v_user);
		set local role authenticated;
		foreach v_hash in array array[current_setting('qorpera_test.observation_entry')::jsonb #>> '{file,fileSha256}',
			current_setting('qorpera_test.observation_entry')::jsonb #>> '{file,manifestSha256}'] loop
			v_result := public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_version,v_hash);
			select array_agg(key order by key) into v_keys from jsonb_object_keys(v_result) key;
			if v_keys <> array['actorUserId','backend','bytes','companyId','environmentId','path','resourceId','resourceVersion','schema','sha256','version']
				or v_result ->> 'schema' is distinct from 'qorpera.member-company-object/v2'
				or v_result ->> 'actorUserId' is distinct from v_user::text
				or v_result ->> 'companyId' is distinct from '32100000-0000-4000-8000-000000000010'
				or v_result ->> 'environmentId' is distinct from v_environment::text
				or v_result ->> 'resourceId' is distinct from v_resource.id::text
				or v_result ->> 'resourceVersion' is distinct from v_resource.version::text
				or v_result ->> 'version' is distinct from v_version::text
				or v_result ->> 'path' is distinct from 'note.md' or v_result ->> 'sha256' is distinct from v_hash
				or (v_result ->> 'bytes')::bigint not between 1 and 8388608 then
				raise exception 'Descriptor identity was not the authorized actor/resource'; end if;
		end loop;
		reset role;
	end loop;
end
$$;

-- A narrower live boundary must change observation identity. The caller's
-- path/version is never substituted for the resolved policy resource/version.
select pg_temp.path_claims('authenticated','32100000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.observation_resource',public.qorpera_set_company_path_resource(
	'32100000-0000-4000-8000-000000000020','note.md','exact','company_shared','normal',null)::text,true);
reset role;
do $$
declare v_resource jsonb := current_setting('qorpera_test.observation_resource')::jsonb;
	v_hash text := current_setting('qorpera_test.observation_entry')::jsonb #>> '{file,fileSha256}';
	v_version uuid := current_setting('qorpera_test.observation_version')::uuid; v_result jsonb;
	v_environment uuid := '32100000-0000-4000-8000-000000000020';
begin
	perform pg_temp.path_claims('authenticated','32100000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_version,v_hash);
	if v_result ->> 'resourceId' is distinct from v_resource ->> 'resourceId'
		or v_result ->> 'resourceVersion' is distinct from v_resource ->> 'version' then
		raise exception 'Exact resource identity was replaced by path version or root'; end if;
	begin
		perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_environment,v_hash);
		raise exception 'Stale path version accepted';
	exception when sqlstate 'PT412' then null; end;
	begin
		perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md',null,v_hash);
		raise exception 'Missing path version accepted';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_version,'invalid');
		raise exception 'Malformed object hash accepted';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_version,repeat('a',64));
		raise exception 'Non-closure object accepted';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md-sibling',v_version,v_hash);
		raise exception 'Known bytes admitted sibling path';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_authorize_member_company_path_object(v_environment,'NOTE.md',v_version,v_hash);
		raise exception 'Alias spelling admitted a second path';
	exception when insufficient_privilege then null; end;
	reset role;
	-- A resource version change is observed on the next authorized request.
	update public.qorpera_company_path_resources set version = extensions.gen_random_uuid()
	where id = (v_resource ->> 'resourceId')::uuid returning version into v_version;
	set local role authenticated;
	v_result := public.qorpera_authorize_member_company_path_object(v_environment,'note.md',
		current_setting('qorpera_test.observation_version')::uuid,v_hash);
	if v_result ->> 'resourceVersion' is distinct from v_version::text then raise exception 'Stale resource identity returned'; end if;
	reset role;
end
$$;

-- Authorization must precede stale-version/closure disclosure even with the
-- extra metadata. Revoked/private/member-loss cases return no descriptor.
do $$
declare v_hash text := current_setting('qorpera_test.observation_entry')::jsonb #>> '{file,fileSha256}';
	v_version uuid := current_setting('qorpera_test.observation_version')::uuid;
	v_environment uuid := '32100000-0000-4000-8000-000000000020'; v_probe text; v_before jsonb; v_after jsonb;
begin
	select jsonb_build_object('entries',count(*),'versions',jsonb_agg(version order by path)) into v_before
	from public.qorpera_company_path_entries where environment_id = v_environment;
	foreach v_probe in array array['private','revoked','member-removed','missing-human','service-role'] loop
		begin
			if v_probe = 'private' then
				update public.qorpera_company_path_resources set scope = 'member_private',owner_user_id = '32100000-0000-4000-8000-000000000001'
				where environment_id = v_environment and path = 'note.md';
			elsif v_probe = 'revoked' then
				update public.qorpera_company_path_resources set revoked_at = clock_timestamp()
				where environment_id = v_environment and path = 'note.md';
			elsif v_probe = 'member-removed' then
				delete from public.qorpera_profile_members where profile_id = '32100000-0000-4000-8000-000000000010'
					and user_id = '32100000-0000-4000-8000-000000000003';
			end if;
			perform pg_temp.path_claims(case when v_probe = 'service-role' then 'service_role' else 'authenticated' end,
				case when v_probe = 'missing-human' then null else '32100000-0000-4000-8000-000000000003'::uuid end);
			set local role authenticated;
			begin
				perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_environment,v_hash);
				raise exception 'Denied human obtained metadata for %',v_probe;
			exception when insufficient_privilege then null; end;
			raise exception using errcode = 'QTC01';
		exception when sqlstate 'QTC01' then null; end;
	end loop;
	select jsonb_build_object('entries',count(*),'versions',jsonb_agg(version order by path)) into v_after
	from public.qorpera_company_path_entries where environment_id = v_environment;
	if v_before is distinct from v_after then raise exception 'Metadata reads mutated canonical paths'; end if;
	if exists(select 1 from public.qorpera_execution_runs where profile_id = '32100000-0000-4000-8000-000000000010') then
		raise exception 'Human descriptor unexpectedly depended on an execution run'; end if;
end
$$;
set constraints all immediate;
rollback;

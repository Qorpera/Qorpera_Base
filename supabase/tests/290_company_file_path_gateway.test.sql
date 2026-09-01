-- Real admission, assignment and native-lease contracts; no substituted
-- authority helper. Storage fixtures below stand in only for verified bytes.
begin;

insert into auth.users(id,email) values
	('29000000-0000-4000-8000-000000000001','path-owner@example.test'),
	('29000000-0000-4000-8000-000000000002','path-member@example.test'),
	('29000000-0000-4000-8000-000000000003','path-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('29000000-0000-4000-8000-000000000010','Path gateway fixture','29000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000002','path-member@example.test','Member','contributor'),
	('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('29000000-0000-4000-8000-000000000020','29000000-0000-4000-8000-000000000010','Environment',1,'29000000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29000000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29000000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('29000000-0000-4000-8000-000000000010',v_manifest);
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
	values ('qorpera-profile-objects','29000000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('29000000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.path_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '29000000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'29000000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '29000000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('29000000-0000-4000-8000-000000000025','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020','29000000-0000-4000-8000-000000000023',
	'29000000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'29000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '29000000-0000-4000-8000-000000000027',profile_id,'29000000-0000-4000-8000-000000000020','company_snapshot',
	'29000000-0000-4000-8000-000000000023','29000000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'29000000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '29000000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where sha256 = current_setting('qorpera_test.path_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '29000000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('29000000-0000-4000-8000-000000000027','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'29000000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '29000000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '29000000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '29000000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('29000000-0000-4000-8000-000000000020',
	'29000000-0000-4000-8000-000000000023','29000000-0000-4000-8000-000000000001');
reset role;

insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000030','Agent','Research','Read and change the Company File.',
	'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,staff_agent_id,staff_version,execution_scope)
values ('29000000-0000-4000-8000-000000000040','29000000-0000-4000-8000-000000000041',
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020','Path session','open',
	'29000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000030',1,'{}');

select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.path_identity',public.qorpera_upsert_member_compute_identity(
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000050','Path identity','qorpera-member-linux','v1',
	'["agent_turn","company_substrate"]','{"network":"provider-native-only","credentialExport":false}')::text,true);
select set_config('qorpera_test.path_login',public.qorpera_begin_native_provider_login(
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000051','29000000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('a',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.path_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.path_login')::jsonb ->> 'login_id')::uuid,repeat('a',64),'29000000-0000-4000-8000-000000000060',
	'object://native-capsules/29000000-0000-4000-8000-000000000060',repeat('b',64),'fixture-openai-account','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}')::text,true);
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.path_sponsor',public.qorpera_create_member_execution_sponsor(
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid,1,false)::text,true);
select set_config('qorpera_test.path_turn',public.qorpera_request_session_turn_v2(
	'29000000-0000-4000-8000-000000000040','29000000-0000-4000-8000-000000000070','29000000-0000-4000-8000-000000000071',
	'{"schema":"qorpera.session-prompt/v1","text":"Update the company note.","images":[]}','member_connection',
	(current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,
	(current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid,
	null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
select public.qorpera_register_runner_orchestrator('29000000-0000-4000-8000-000000000092','Path fixture','process',repeat('0',64),3600);
do $$
declare v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb;
	v_run uuid := (current_setting('qorpera_test.path_turn')::jsonb ->> 'turn_request_id')::uuid;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('29000000-0000-4000-8000-000000000092','29000000-0000-4000-8000-000000000093',120);
	if v_claim #>> '{work,run_id}' is distinct from v_run::text then raise exception 'Wrong path fixture run'; end if;
	v_runner := public.qorpera_provision_execution_runner(v_run,'29000000-0000-4000-8000-000000000094','process',repeat('1',64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid,repeat('1',64),repeat('2',64),'linux','path-fixture');
	v_assignment := public.qorpera_assign_runner_job('29000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid,'29000000-0000-4000-8000-000000000095',repeat('3',64),120);
	perform public.qorpera_accept_runner_assignment((v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,(v_claim #>> '{work,job_id}')::uuid,repeat('3',64));
	v_lease := public.qorpera_acquire_native_provider_connection_lease(v_run,(v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('3',64),120);
	perform set_config('qorpera_test.path_binding',jsonb_build_object('leaseId',v_lease ->> 'lease_id','runId',v_run,
		'jobId',v_claim #>> '{work,job_id}','runnerId',v_runner ->> 'runner_id','assignmentId',v_assignment ->> 'assignment_id',
		'credentialCapsuleId',v_lease ->> 'credential_capsule_id','computeIdentityId',v_lease ->> 'compute_identity_id',
		'provider','openai','nativeHarness','codex-cli','model','gpt-native')::text,true);
end
$$;
reset role;

create function pg_temp.path_plan(p_key text,p_path text,p_entry jsonb,p_version uuid default null)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.company-path-mutation/v1','operationKey',p_key,'path',p_path,
		'expectedVersion',p_version,'entry',p_entry)
$$;
create function pg_temp.path_commit(p_plan jsonb)
returns jsonb language plpgsql as $$
declare v_prepared jsonb; v_entries jsonb; v_tree text; v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	v_prepared := public.qorpera_prepare_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,p_plan);
	if v_prepared ->> 'state' = 'completed' then return v_prepared -> 'result'; end if;
	if v_prepared ->> 'state' = 'ready' then
		select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
			select value from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> p_plan ->> 'path'
			union all select p_plan -> 'entry' where p_plan -> 'entry' <> 'null'::jsonb
		) entries;
		v_tree := pg_temp.path_stage_tree(v_entries);
	end if;
	return public.qorpera_commit_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,p_plan,
		(v_prepared ->> 'snapshotId')::uuid,v_tree);
end
$$;

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		foreach v_function in array array['public.qorpera_company_path_actor(uuid,jsonb)',
			'public.qorpera_publish_company_path(jsonb,jsonb,jsonb,uuid,text,uuid,uuid)',
			'public.qorpera_company_path_approved_actor(uuid,text)'] loop
			if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Private helper exposed to %: %',v_role,v_function; end if;
		end loop;
		if has_table_privilege(v_role,'public.qorpera_company_path_entries','SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role,'public.qorpera_company_path_revisions','INSERT,UPDATE,DELETE') then raise exception 'Path index bypass exposed to %',v_role; end if;
	end loop;
	if has_function_privilege('authenticated','public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_review_company_path_proposal(uuid,text,text)','EXECUTE') then
		raise exception 'Agent and human approval surfaces are not separate'; end if;
end
$$;

-- No default employee access, even for an owner-sponsored native turn.
set local role service_role;
do $$
begin
	begin
		perform public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020','note.md',current_setting('qorpera_test.path_binding')::jsonb);
		raise exception 'Employee inherited root access without a grant';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
select set_config('qorpera_test.path_resource',(select jsonb_build_object('id',id,'version',version)::text
	from public.qorpera_company_path_resources where environment_id = '29000000-0000-4000-8000-000000000020' and path = ''),true);
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.path_grant',public.qorpera_grant_company_path(
	(current_setting('qorpera_test.path_resource')::jsonb ->> 'id')::uuid,
	(current_setting('qorpera_test.path_resource')::jsonb ->> 'version')::uuid,
	'staff_agent','29000000-0000-4000-8000-000000000030',array['read','write'])::text,true);
reset role;
select pg_temp.path_claims('service_role');
-- Admission is durable across hosts, and prevents a pristine retry even when
-- the native process dies before its first tool or public send. Roll back the
-- probe so subsequent path tests retain the original admitted fixture.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_started jsonb; v_terminal jsonb; v_status text;
begin
	if has_function_privilege('authenticated','public.qorpera_begin_native_company_execution(jsonb,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)','EXECUTE') then
		raise exception 'Native start or recovery bypass exposed'; end if;
	set local role service_role;
	v_started := public.qorpera_begin_native_company_execution(v_binding,repeat('a',64));
	if v_started <> jsonb_build_object('schema','qorpera.native-company-execution-start/v1',
		'runId',v_binding ->> 'runId','jobId',v_binding ->> 'jobId','leaseId',v_binding ->> 'leaseId','binarySha256',repeat('a',64)) then
		raise exception 'Native start receipt is not bound'; end if;
	begin
		perform public.qorpera_begin_native_company_execution(v_binding,repeat('a',64));
		raise exception 'Native turn restarted after a lost acknowledgement';
	exception when object_not_in_prerequisite_state then null; end;
	begin
		perform public.qorpera_begin_native_company_execution(v_binding,repeat('b',64));
		raise exception 'Another native artifact restarted an uncertain turn';
	exception when object_not_in_prerequisite_state then null; end;
	reset role;
	foreach v_status in array array['failed','cancelled'] loop
		begin
			-- Cancellation retains the requesting human; infrastructure failure has no human actor.
			perform pg_temp.path_claims('service_role',case when v_status = 'cancelled'
				then '29000000-0000-4000-8000-000000000001'::uuid else null end);
			set local role service_role;
			v_terminal := public.qorpera_terminalize_runner_attempt((v_binding ->> 'jobId')::uuid,
				v_status,'Fixture native host disappeared',true);
			reset role;
			if v_terminal ->> 'status' is distinct from v_status
				or not exists(select 1 from public.qorpera_execution_run_events where run_id = (v_binding ->> 'runId')::uuid
					and event_type = 'review_pending' and payload ->> 'reason' = 'native_execution_uncertain') then
				raise exception 'Started native run was retried or lost its review state'; end if;
			raise exception using errcode = 'QTC01';
		exception when sqlstate 'QTC01' then null; end;
	end loop;
	raise exception using errcode = 'QTC01';
exception when sqlstate 'QTC01' then null;
end
$$;
select set_config('qorpera_test.path_note',pg_temp.path_plan('create-note','note.md',pg_temp.path_stage_file('note.md','Initial company note'))::text,true);
set local role service_role;
select set_config('qorpera_test.path_result',pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb)::text,true);
reset role;

-- Human content reads bind a current path/version and its verified closure,
-- not merely a company id and a known immutable object hash. Model usage or
-- subscription sponsorship is not required for a human to read company data.
do $$
declare v_user uuid; v_hash text; v_probe text;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
	v_version uuid := (current_setting('qorpera_test.path_result')::jsonb ->> 'version')::uuid;
	v_file jsonb := current_setting('qorpera_test.path_note')::jsonb #> '{entry,file}'; v_result jsonb;
begin
	if has_function_privilege('anon','public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text)','EXECUTE') then
		raise exception 'Member path objects expose a service/anonymous bypass'; end if;
	foreach v_user in array array['29000000-0000-4000-8000-000000000001'::uuid,'29000000-0000-4000-8000-000000000003'::uuid] loop
		perform pg_temp.path_claims('authenticated',v_user);
		set local role authenticated;
		foreach v_hash in array array[v_file ->> 'manifestSha256',v_file ->> 'fileSha256'] loop
			v_result := public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_version,v_hash);
			if v_result ->> 'schema' <> 'qorpera.member-company-object/v1'
				or v_result ->> 'companyId' <> '29000000-0000-4000-8000-000000000010'
				or v_result ->> 'environmentId' <> v_environment::text or v_result ->> 'version' <> v_version::text
				or v_result ->> 'path' <> 'note.md' or v_result ->> 'sha256' <> v_hash then
				raise exception 'Member content authority lost its exact path identity'; end if;
		end loop;
		foreach v_probe in array array['other-object','other-path','alias','secret','old-version'] loop
			begin
				perform public.qorpera_authorize_member_company_path_object(v_environment,
					case v_probe when 'other-path' then 'other.md' when 'alias' then 'NOTE.md' when 'secret' then 'secrets/credential' else 'note.md' end,
					case when v_probe = 'old-version' then extensions.gen_random_uuid() else v_version end,
					case when v_probe = 'other-object' then current_setting('qorpera_test.path_tree') else v_file ->> 'fileSha256' end);
				raise exception 'Member object route ignored %',v_probe;
			 exception when insufficient_privilege or serialization_failure then null; end;
		end loop;
		reset role;
	end loop;
	begin
		delete from public.qorpera_profile_members where profile_id = '29000000-0000-4000-8000-000000000010'
			and user_id = '29000000-0000-4000-8000-000000000003';
		set local role authenticated;
		begin
			perform public.qorpera_authorize_member_company_path_object(v_environment,'note.md',v_version,v_file ->> 'fileSha256');
			raise exception 'Departed member retained content authority';
		exception when insufficient_privilege then null; end;
		raise exception using errcode = 'QTH01';
	exception when sqlstate 'QTH01' then null; end;
	reset role;
	perform pg_temp.path_claims('service_role');
end
$$;

-- The revision, projection, receipt, restore proof and both live heads must
-- describe the same effect; no whole-run completion is required for delivery.
do $$
declare v_result jsonb := current_setting('qorpera_test.path_result')::jsonb; v_head uuid := (v_result ->> 'snapshotId')::uuid;
begin
	if v_result ->> 'state' <> 'applied' or (select head_snapshot_id from public.qorpera_company_files
		where environment_id = '29000000-0000-4000-8000-000000000020') is distinct from v_head
		or not exists (select 1 from public.qorpera_company_files f join public.qorpera_company_workspaces w on w.id = f.canonical_workspace_id
			where f.environment_id = '29000000-0000-4000-8000-000000000020' and f.path_index_snapshot_id = v_head and w.head_snapshot_id = v_head)
		or not public.qorpera_object_root_has_current_proof('company_snapshot',v_head)
		or not exists (select 1 from public.qorpera_company_path_revisions where snapshot_id = v_head and receipt_id = (v_result ->> 'receiptId')::uuid)
		or not exists (select 1 from public.qorpera_run_operation_receipts where id = (v_result ->> 'receiptId')::uuid
			and status = 'completed' and result = v_result and output_snapshot_id = v_head)
		or not exists (select 1 from public.qorpera_company_path_entries where path = 'note.md' and version = (v_result ->> 'version')::uuid) then
		raise exception 'Company mutation was not one durable, verified transaction'; end if;
	set local role service_role;
	if pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb) <> v_result then raise exception 'Lost-response retry changed the receipt'; end if;
	begin
		perform pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb || '{"entry":{"kind":"directory","path":"note.md"}}');
		raise exception 'Operation key accepted different work';
	exception when unique_violation then null; end;
	begin
		perform pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb || '{"operationKey":"stale-absence"}');
		raise exception 'Old absence precondition overwrote an existing file';
	exception when serialization_failure then null; end;
	reset role;
	if (select count(*) from public.qorpera_company_path_revisions) <> 1 then raise exception 'Retry duplicated a revision'; end if;
end
$$;

-- Prepare is not permission to apply later. Recheck exact current authority.
do $$
declare v_probe text; v_plan jsonb; v_prepared jsonb; v_tree text; v_head uuid; v_before bigint; v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	v_plan := pg_temp.path_plan('revocation-probe','next.md',pg_temp.path_stage_file('next.md','Do not publish this'));
	set local role service_role;
	v_prepared := public.qorpera_prepare_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,v_plan);
	v_tree := pg_temp.path_stage_tree((v_prepared -> 'entries') || jsonb_build_array(v_plan -> 'entry'));
	reset role;
	v_head := (v_prepared ->> 'snapshotId')::uuid;
	select count(*) into v_before from public.qorpera_run_operation_receipts;
	foreach v_probe in array array['grant','resource','staff','requester','sponsor','lease','assignment','expired-during-turn','missing-blob'] loop
		begin
			if v_probe = 'grant' then
				update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = current_setting('qorpera_test.path_grant')::uuid;
			elsif v_probe = 'resource' then
				update public.qorpera_company_path_resources set version = extensions.gen_random_uuid() where path = '';
			elsif v_probe = 'staff' then
				update public.qorpera_profile_staff set employment_status = 'archived' where staff_agent_id = '29000000-0000-4000-8000-000000000030';
			elsif v_probe = 'requester' then
				update public.qorpera_profile_members set role = 'viewer' where user_id = '29000000-0000-4000-8000-000000000001';
			elsif v_probe = 'sponsor' then
				update public.qorpera_execution_sponsor_bindings set status = 'revoked'
				where id = (current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid;
			elsif v_probe = 'lease' then
				update public.qorpera_native_provider_connection_leases set status = 'revoked',released_at = clock_timestamp() where id = (v_binding ->> 'leaseId')::uuid;
			elsif v_probe = 'assignment' then
				update public.qorpera_runner_assignments set expires_at = clock_timestamp() - interval '1 second' where id = (v_binding ->> 'assignmentId')::uuid;
			elsif v_probe = 'expired-during-turn' then
				update public.qorpera_company_path_grants set expires_at = clock_timestamp() + interval '20 milliseconds'
				where id = current_setting('qorpera_test.path_grant')::uuid;
				perform pg_sleep(0.03);
			else
				delete from storage.objects where name = '29000000-0000-4000-8000-000000000010/' || (v_plan #>> '{entry,file,fileSha256}');
			end if;
			set local role service_role;
			begin
				perform public.qorpera_commit_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,v_plan,v_head,v_tree);
				raise exception 'Apply ignored %',v_probe;
			exception when insufficient_privilege or object_not_in_prerequisite_state then null; end;
			reset role;
			if (select head_snapshot_id from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020') <> v_head
				or exists (select 1 from public.qorpera_company_path_entries where path = 'next.md')
				or (select count(*) from public.qorpera_run_operation_receipts) <> v_before then
				raise exception 'Rejected % left a partial effect',v_probe; end if;
			raise exception using errcode = 'QTP01';
		exception when sqlstate 'QTP01' then null; end;
	end loop;
	-- A candidate with an extra path is not a valid implementation of one edit.
	v_tree := pg_temp.path_stage_tree((v_prepared -> 'entries') || jsonb_build_array(v_plan -> 'entry',jsonb_build_object('kind','directory','path','injected')));
	set local role service_role;
	begin
		perform public.qorpera_commit_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,v_plan,v_head,v_tree);
		raise exception 'Extra candidate path was accepted';
	exception when invalid_parameter_value then null; end;
	reset role;
	if exists (select 1 from public.qorpera_company_path_entries where path in ('next.md','injected'))
		or (select count(*) from public.qorpera_run_operation_receipts) <> v_before then raise exception 'Failed candidate left partial state'; end if;
end
$$;

-- A head conflict is distinguishable from a changed path. Rebase only the
-- trusted one-path candidate; never relax the original path precondition.
do $$
declare v_a jsonb; v_b jsonb; v_prepared jsonb; v_tree text; v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	v_a := pg_temp.path_plan('disjoint-a','a',jsonb_build_object('kind','directory','path','a'));
	v_b := pg_temp.path_plan('disjoint-b','b',jsonb_build_object('kind','directory','path','b'));
	set local role service_role;
	v_prepared := public.qorpera_prepare_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,v_a);
	v_tree := pg_temp.path_stage_tree((v_prepared -> 'entries') || jsonb_build_array(v_a -> 'entry'));
	perform pg_temp.path_commit(v_b);
	begin
		perform public.qorpera_commit_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,v_a,(v_prepared ->> 'snapshotId')::uuid,v_tree);
		raise exception 'Stale candidate removed another writer''s path';
	exception when sqlstate 'PT409' then null; end;
	perform pg_temp.path_commit(v_a);
	reset role;
	if (select count(*) from public.qorpera_company_path_entries where path in ('a','b') and entry is not null) <> 2 then
		raise exception 'Disjoint writes failed to preserve both effects'; end if;
end
$$;

-- Privacy is independent of the sponsoring owner's access. Scoped model
-- context cannot acquire owner-private data, even through case aliases.
set local role service_role;
select public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020','note.md',current_setting('qorpera_test.path_binding')::jsonb);
select set_config('qorpera_test.context_copy_plan',pg_temp.path_plan('context-copy','copy-of-private',jsonb_build_object('kind','directory','path','copy-of-private'))::text,true);
select set_config('qorpera_test.context_copy_prepared',public.qorpera_prepare_company_path_mutation(
	'29000000-0000-4000-8000-000000000020',current_setting('qorpera_test.path_binding')::jsonb,current_setting('qorpera_test.context_copy_plan')::jsonb)::text,true);
select set_config('qorpera_test.context_copy_tree',pg_temp.path_stage_tree(
	(current_setting('qorpera_test.context_copy_prepared')::jsonb -> 'entries') ||
	jsonb_build_array(current_setting('qorpera_test.context_copy_plan')::jsonb -> 'entry')),true);
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.private_resource',public.qorpera_set_company_path_resource(
	'29000000-0000-4000-8000-000000000020','note.md','exact','member_private','normal')::text,true);
select public.qorpera_grant_company_path((current_setting('qorpera_test.private_resource')::jsonb ->> 'resourceId')::uuid,
	(current_setting('qorpera_test.private_resource')::jsonb ->> 'version')::uuid,'staff_agent','29000000-0000-4000-8000-000000000030',array['read','write']);
do $$
begin
	if public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020','note.md') -> 'entry' = 'null'::jsonb then
		raise exception 'Private owner lost their human access'; end if;
	perform public.qorpera_authorize_member_company_path_object('29000000-0000-4000-8000-000000000020','note.md',
		(current_setting('qorpera_test.path_result')::jsonb ->> 'version')::uuid,
		current_setting('qorpera_test.path_note')::jsonb #>> '{entry,file,fileSha256}');
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin
	begin
		perform public.qorpera_authorize_member_company_path_object('29000000-0000-4000-8000-000000000020','note.md',
			(current_setting('qorpera_test.path_result')::jsonb ->> 'version')::uuid,
			current_setting('qorpera_test.path_note')::jsonb #>> '{entry,file,fileSha256}');
		raise exception 'Coworker read another human''s private file by known hash';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_path text; v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_page jsonb;
begin
	foreach v_path in array array['note.md','NOTE.md','members/29000000-0000-4000-8000-000000000001/private/future.txt',
		'members/29000000-0000-4000-8000-000000000002/private/future.txt'] loop
		begin
			perform public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020',v_path,v_binding);
			raise exception 'Shared agent context read private path %',v_path;
		exception when insufficient_privilege then null; end;
	end loop;
	v_page := public.qorpera_list_company_paths('29000000-0000-4000-8000-000000000020','',null,null,100,v_binding);
	if exists (select 1 from jsonb_array_elements(v_page -> 'items') where value ->> 'path' = 'note.md') then
		raise exception 'Listing leaked a private filename'; end if;
	begin
		perform public.qorpera_assert_company_path_reads('29000000-0000-4000-8000-000000000020',v_binding,array['note.md']);
		raise exception 'Previously read context survived privacy revocation';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_assert_company_path_reads('29000000-0000-4000-8000-000000000020',v_binding,'{}');
		raise exception 'Restarted host forgot the durable context read set';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_commit_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,
			current_setting('qorpera_test.context_copy_plan')::jsonb,
			(current_setting('qorpera_test.context_copy_prepared')::jsonb ->> 'snapshotId')::uuid,current_setting('qorpera_test.context_copy_tree'));
		raise exception 'Revoked context leaked through a separately permitted path';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_send_native_agent_message((v_binding ->> 'leaseId')::uuid,(v_binding ->> 'runId')::uuid,
			(v_binding ->> 'jobId')::uuid,(v_binding ->> 'runnerId')::uuid,(v_binding ->> 'assignmentId')::uuid,
			(v_binding ->> 'credentialCapsuleId')::uuid,(v_binding ->> 'computeIdentityId')::uuid,
			'openai','codex-cli','context-leak','Private source bytes','progress');
		raise exception 'Revoked context leaked through the public mouth';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
do $$ begin
	if exists (select 1 from public.qorpera_agent_sends where idempotency_key = 'context-leak')
		or exists (select 1 from public.qorpera_company_path_entries where path = 'copy-of-private')
		or exists (select 1 from public.qorpera_run_operation_receipts where logical_operation_key = 'company_path:context-copy') then
		raise exception 'Revoked context left a public side effect'; end if;
end $$;
-- Restore this fixture's policy directly; production cannot convert private
-- data back to shared via an incidental agent/tool call.
delete from public.qorpera_company_path_grants where resource_id = (current_setting('qorpera_test.private_resource')::jsonb ->> 'resourceId')::uuid;
delete from public.qorpera_company_path_resources where id = (current_setting('qorpera_test.private_resource')::jsonb ->> 'resourceId')::uuid;

-- A protected write becomes an exact proposal. Dismissal is not approval;
-- an approval is single-use, version-bound and does not revive model work.
set local role service_role;
select set_config('qorpera_test.path_delete',pg_temp.path_plan('delete-note','note.md',null,
	(current_setting('qorpera_test.path_result')::jsonb ->> 'version')::uuid)::text,true);
select set_config('qorpera_test.path_proposal_result',pg_temp.path_commit(current_setting('qorpera_test.path_delete')::jsonb)::text,true);
reset role;
select set_config('qorpera_test.path_proposal',(select jsonb_build_object('id',id,'digest',plan_sha256)::text
	from public.qorpera_company_path_proposals where id = (current_setting('qorpera_test.path_proposal_result')::jsonb ->> 'proposalId')::uuid),true);
do $$
begin
	if current_setting('qorpera_test.path_proposal_result')::jsonb ->> 'state' <> 'proposed'
		or not exists (select 1 from public.qorpera_company_path_entries where path = 'note.md' and entry is not null) then
		raise exception 'Protected deletion changed live data before approval'; end if;
end
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
	begin
		perform public.qorpera_review_company_path_proposal((current_setting('qorpera_test.path_proposal')::jsonb ->> 'id')::uuid,
			current_setting('qorpera_test.path_proposal')::jsonb ->> 'digest','approve');
		raise exception 'Contributor approved a protected company change';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_id uuid := (current_setting('qorpera_test.path_proposal')::jsonb ->> 'id')::uuid;
	v_digest text := current_setting('qorpera_test.path_proposal')::jsonb ->> 'digest';
begin
	begin
		perform public.qorpera_review_company_path_proposal(v_id,repeat('f',64),'approve');
		raise exception 'Approval accepted another plan digest';
	exception when invalid_parameter_value then null; end;
	perform public.qorpera_review_company_path_proposal(v_id,v_digest,'approve');
	perform public.qorpera_review_company_path_proposal(v_id,v_digest,'skip');
end
$$;
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform public.qorpera_prepare_company_path_approval((current_setting('qorpera_test.path_proposal')::jsonb ->> 'id')::uuid,
			current_setting('qorpera_test.path_proposal')::jsonb ->> 'digest');
		raise exception 'Dismissed proposal retained approval';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_review_company_path_proposal((current_setting('qorpera_test.path_proposal')::jsonb ->> 'id')::uuid,
	current_setting('qorpera_test.path_proposal')::jsonb ->> 'digest','approve');
reset role;
select pg_temp.path_claims('service_role');
do $$
declare v_id uuid := (current_setting('qorpera_test.path_proposal')::jsonb ->> 'id')::uuid;
	v_digest text := current_setting('qorpera_test.path_proposal')::jsonb ->> 'digest'; v_prepared jsonb; v_tree text; v_result jsonb; v_version uuid;
begin
	begin
		update public.qorpera_company_path_proposals set approval_expires_at = clock_timestamp() - interval '1 second' where id = v_id;
		set local role service_role;
		begin
			perform public.qorpera_prepare_company_path_approval(v_id,v_digest);
			raise exception 'Expired approval was accepted';
		exception when insufficient_privilege then null; end;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null; end;
	set local role service_role;
	v_prepared := public.qorpera_prepare_company_path_approval(v_id,v_digest);
	v_tree := pg_temp.path_stage_tree((select jsonb_agg(value) from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> 'note.md'));
	v_result := public.qorpera_apply_company_path_approval(v_id,v_digest,(v_prepared ->> 'snapshotId')::uuid,v_tree);
	if public.qorpera_apply_company_path_approval(v_id,v_digest,(v_prepared ->> 'snapshotId')::uuid,v_tree) <> v_result then
		raise exception 'Approval retry duplicated or changed its effect'; end if;
	reset role;
	select version into v_version from public.qorpera_company_path_entries where path = 'note.md' and entry is null;
	if v_version is null or v_version = (current_setting('qorpera_test.path_result')::jsonb ->> 'version')::uuid
		or (select count(*) from public.qorpera_company_path_revisions where proposal_id = v_id) <> 1 then
		raise exception 'Deletion lost its tombstone or applied more than once'; end if;
	set local role service_role;
	begin
		perform pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb || '{"operationKey":"stale-null-after-delete"}');
		raise exception 'Deletion revived an old absence version';
	exception when serialization_failure then null; end;
	perform pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb || jsonb_build_object('operationKey','recreate-note','expectedVersion',v_version));
	reset role;
end
$$;

-- Path identity and legacy paths fail closed without deleting old snapshots.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
	begin
		perform public.qorpera_authorize_member_company_path_object('29000000-0000-4000-8000-000000000020','note.md',
			(current_setting('qorpera_test.path_result')::jsonb ->> 'version')::uuid,
			current_setting('qorpera_test.path_note')::jsonb #>> '{entry,file,fileSha256}');
		raise exception 'Delete/recreate revived an old member content capability';
	exception when serialization_failure then null; end;
end $$;
reset role;
select pg_temp.path_claims('service_role');
do $$
declare v_path text; v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	set local role service_role;
	foreach v_path in array array['../note.md','a//child','a/../note.md','a\\child','a%2fchild','NUL','a./child',U&'n\006F\0308te.md'] loop
		begin
			perform public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020',v_path,v_binding);
			raise exception 'Unsafe path accepted: %',v_path;
		exception when insufficient_privilege then null; end;
	end loop;
	begin
		perform public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020','NOTE.md',v_binding);
		raise exception 'Case alias acquired a second path identity';
	exception when insufficient_privilege then null; end;
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('shadow-parent','note.md/child',jsonb_build_object('kind','directory','path','note.md/child')));
		raise exception 'File was accepted as a parent directory';
	exception when invalid_parameter_value then null; end;
	reset role;
	begin
		update public.qorpera_company_files set head_snapshot_id = '29000000-0000-4000-8000-000000000023'
		where environment_id = '29000000-0000-4000-8000-000000000020';
		raise exception 'Legacy whole-tree writer bypassed the path gateway';
	exception when insufficient_privilege then null; end;
	begin
		update public.qorpera_company_files set path_gateway_version = null,path_index_snapshot_id = null
		where environment_id = '29000000-0000-4000-8000-000000000020';
		raise exception 'Legacy caller disabled the governed mode';
	exception when insufficient_privilege then null; end;
end
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
	begin
		perform public.qorpera_authorize_profile_object_download('29000000-0000-4000-8000-000000000010',current_setting('qorpera_test.path_tree'));
		raise exception 'Raw-hash download bypass remained open';
	exception when insufficient_privilege then null; end;
	if exists (select 1 from storage.objects where bucket_id = 'qorpera-profile-objects'
		and name like '29000000-0000-4000-8000-000000000010/%') then raise exception 'Storage RLS bypass remained open'; end if;
end
$$;
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_context jsonb; v_input jsonb; v_page jsonb;
begin
	v_context := public.qorpera_describe_company_run_context(v_binding);
	if v_context ->> 'schema' <> 'qorpera.native-company-context/v1'
		or v_context #>> '{identity,runId}' <> v_binding ->> 'runId'
		or v_context #>> '{company,id}' <> '29000000-0000-4000-8000-000000000010'
		or v_context #>> '{agent,id}' <> '29000000-0000-4000-8000-000000000030'
		or jsonb_array_length(v_context -> 'currentInputs') <> 1
		or jsonb_array_length(v_context -> 'history') <> 0
		or v_context::text ~ 'credentialCapsule|encryptedCapsule|session_token|lease_token|attestation' then
		raise exception 'Cloud context did not derive its closed identity and audience'; end if;
	v_input := v_context #> '{currentInputs,0}';
	if v_input ->> 'kind' <> 'current_human_request' or v_input ->> 'authorUserId' <> '29000000-0000-4000-8000-000000000001'
		or v_input #>> '{content,text}' <> 'Update the company note.' then
		raise exception 'Current request attribution was lost'; end if;
	v_page := public.qorpera_read_company_run_context(v_binding,'input',(v_input ->> 'id')::uuid,v_input #>> '{content,sha256}',0,8);
	if v_page #>> '{content,text}' <> 'Update t' or (v_page #>> '{content,nextOffset}')::integer <> 8
		or v_page ->> 'kind' <> v_input ->> 'kind' then raise exception 'Cloud context paging lost its provenance'; end if;
	begin
		perform public.qorpera_read_company_run_context(v_binding,'input','29000000-0000-4000-8000-000000000001',v_input #>> '{content,sha256}',0,8);
		raise exception 'Context reader accessed an unadmitted input';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_read_company_run_context(v_binding,'input',(v_input ->> 'id')::uuid,repeat('f',64),0,8);
		raise exception 'Context paging accepted a different body';
	exception when serialization_failure then null; end;
	begin
		perform public.qorpera_runner_broker_authorize_input_object((v_binding ->> 'runnerId')::uuid,repeat('2',64),
			(v_binding ->> 'jobId')::uuid,repeat('3',64),current_setting('qorpera_test.path_tree'));
		raise exception 'Raw runner hash capability bypassed the Company File gateway';
	exception when insufficient_privilege then null; end;
	if has_function_privilege('service_role','public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_runner_broker_authorize_legacy_input_object(uuid,text,uuid,text,text)','EXECUTE') then
		raise exception 'Private context/storage helper was exposed'; end if;
end
$$;
reset role;
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_probe text;
begin
	foreach v_probe in array array['input-author','session','staff-version'] loop
		begin
			if v_probe = 'input-author' then
				update public.qorpera_session_inputs set author_user_id = '29000000-0000-4000-8000-000000000002'
				where execution_run_id = (v_binding ->> 'runId')::uuid;
			elsif v_probe = 'session' then
				update public.qorpera_shared_sessions set status = 'closed' where id = '29000000-0000-4000-8000-000000000040';
			else
				update public.qorpera_profile_staff set charter = 'Changed job specification',version = version + 1
				where staff_agent_id = '29000000-0000-4000-8000-000000000030';
			end if;
			set local role service_role;
			begin
				perform public.qorpera_describe_company_run_context(v_binding);
				raise exception 'Context reconstruction ignored %',v_probe;
			exception when insufficient_privilege then null; end;
			begin
				perform public.qorpera_assert_company_path_reads('29000000-0000-4000-8000-000000000020',v_binding,'{}');
				raise exception 'Pre-model context check ignored %',v_probe;
			exception when insufficient_privilege then null; end;
			raise exception using errcode = 'QTC01';
		exception when sqlstate 'QTC01' then null; end;
	end loop;
end
$$;
-- Native immutable staging is cloud/run-bound and cannot itself publish a
-- Company File mutation. Its separate final confirmation rechecks authority.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_profile uuid := '29000000-0000-4000-8000-000000000010'; v_before uuid; v_role text;
begin
	select head_snapshot_id into v_before from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020';
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_native_company_object_actor(jsonb,uuid)','EXECUTE') then
			raise exception 'Native object authority helper is exposed'; end if;
	end loop;
	if has_function_privilege('authenticated','public.qorpera_confirm_native_company_object_upload(jsonb,uuid,text,bigint)','EXECUTE')
		or has_function_privilege('anon','public.qorpera_authorize_native_company_object_download(jsonb,uuid,text)','EXECUTE') then
		raise exception 'Raw native object route was granted to an end user'; end if;
	set local role service_role;
	perform public.qorpera_authorize_native_company_object_upload(v_binding,v_profile,repeat('e',64),13);
	perform public.qorpera_confirm_native_company_object_upload(v_binding,v_profile,repeat('e',64),13);
	perform public.qorpera_confirm_native_company_object_upload(v_binding,v_profile,repeat('e',64),13);
	if public.qorpera_authorize_native_company_object_download(v_binding,v_profile,repeat('e',64)) <>
		'{"backend":"nas-object-gateway","bytes":13}'::jsonb then raise exception 'Wrong native object receipt'; end if;
	begin
		perform public.qorpera_confirm_native_company_object_upload(v_binding,v_profile,repeat('e',64),14);
		raise exception 'Native object address was rebound';
	exception when unique_violation then null; end;
	begin
		perform public.qorpera_authorize_native_company_object_upload(v_binding,'29000000-0000-4000-8000-000000000099',repeat('e',64),13);
		raise exception 'Native run crossed its company boundary';
	exception when insufficient_privilege then null; end;
	reset role;
	begin
		update public.qorpera_native_provider_connection_leases set created_at = clock_timestamp() - interval '1 minute',expires_at = clock_timestamp() - interval '1 second'
		where id = (v_binding ->> 'leaseId')::uuid;
		set local role service_role;
		begin
			perform public.qorpera_confirm_native_company_object_upload(v_binding,v_profile,repeat('f',64),13);
			raise exception 'Expired staging authority confirmed an object';
		exception when insufficient_privilege then null; end;
		raise exception using errcode = 'QTC01';
	exception when sqlstate 'QTC01' then null; end;
	if (select head_snapshot_id from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020') <> v_before
		or exists(select 1 from public.qorpera_profile_objects where profile_id = v_profile and sha256 = repeat('f',64)) then
		raise exception 'Native staging published a company mutation or expired object'; end if;
end
$$;
create function pg_temp.path_complete(p_result jsonb,p_snapshot uuid default null)
returns jsonb language sql as $$
	select public.qorpera_complete_runner_job_v6(
		(current_setting('qorpera_test.path_binding')::jsonb ->> 'runnerId')::uuid,repeat('2',64),
		(current_setting('qorpera_test.path_binding')::jsonb ->> 'jobId')::uuid,repeat('3',64),
		'29000000-0000-4000-8000-000000000096','29000000-0000-4000-8000-000000000097',p_snapshot,p_result)
$$;

-- Completion is receipt-only, including when a human has changed the live
-- head after the agent's last path operation. The subtransaction preserves
-- this fixture's active run for the separate concurrent-writer acceptance.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_head uuid; v_last_agent_head uuid; v_result jsonb; v_completed jsonb; v_send jsonb; v_probe text;
	v_proposal jsonb; v_plan jsonb; v_prepared jsonb; v_digest text; v_tree text;
begin
	v_plan := pg_temp.path_plan('completion-human-edit','note.md',null,
		(select version from public.qorpera_company_path_entries where path = 'note.md'));
	set local role service_role;
	v_proposal := pg_temp.path_commit(v_plan);
	reset role;
	select plan_sha256 into v_digest from public.qorpera_company_path_proposals where id = (v_proposal ->> 'proposalId')::uuid;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_review_company_path_proposal((v_proposal ->> 'proposalId')::uuid,v_digest,'approve');
	reset role;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_prepared := public.qorpera_prepare_company_path_approval((v_proposal ->> 'proposalId')::uuid,v_digest);
	v_tree := pg_temp.path_stage_tree((select jsonb_agg(value) from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> 'note.md'));
	perform public.qorpera_apply_company_path_approval((v_proposal ->> 'proposalId')::uuid,v_digest,(v_prepared ->> 'snapshotId')::uuid,v_tree);
	reset role;
	select head_snapshot_id into v_head from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020';
	select output_snapshot_id into v_last_agent_head from public.qorpera_run_operation_receipts
	where run_id = (v_binding ->> 'runId')::uuid and output_snapshot_id is not null order by completed_at desc,id desc limit 1;
	if v_head is not distinct from v_last_agent_head or (select count(*) from public.qorpera_run_operation_receipts
		where run_id = (v_binding ->> 'runId')::uuid and output_snapshot_id is not null) < 2 then
		raise exception 'Completion fixture must include multiple writes and a newer human revision'; end if;
	if has_function_privilege('service_role','public.qorpera_complete_runner_job_v4(uuid,text,uuid,text,uuid,uuid,jsonb)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_complete_runner_job_before_path_runtime(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)','EXECUTE') then
		raise exception 'An older completion RPC can bypass the governed lane'; end if;
	set local role service_role;
	if public.qorpera_runner_broker_describe((v_binding ->> 'runnerId')::uuid,repeat('2',64),
		(v_binding ->> 'jobId')::uuid,repeat('3',64)) ->> 'company_runtime' <> 'company-path-v1' then
		raise exception 'Cloud broker did not select the governed runtime'; end if;
	v_result := jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
		'native_lease_id',v_binding ->> 'leaseId','substrate_version_id','29000000-0000-4000-8000-000000000025',
		'output_count',0,'output_bytes',0,'publication',null,
		'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',v_binding ->> 'runId',
			'message_count',0,'final_message_id',null,'provider_session_id','governed-native-fixture'),
		'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
			"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
				"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb);
	begin
		perform pg_temp.path_complete(v_result);
		raise exception 'Governed completion accepted no durable native start';
	exception when object_not_in_prerequisite_state then
		if sqlerrm <> 'Native execution has no matching durable admission' then raise; end if;
	end;
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('a',64));
	begin
		perform pg_temp.path_complete(v_result,v_head);
		raise exception 'Governed completion accepted a whole-tree publication';
	exception when invalid_parameter_value then null; end;
	begin
		perform pg_temp.path_complete(v_result);
		raise exception 'Governed conversation completed without its final send';
	exception when object_not_in_prerequisite_state then null; end;
	v_send := public.qorpera_send_native_agent_message((v_binding ->> 'leaseId')::uuid,(v_binding ->> 'runId')::uuid,
		(v_binding ->> 'jobId')::uuid,(v_binding ->> 'runnerId')::uuid,(v_binding ->> 'assignmentId')::uuid,
		(v_binding ->> 'credentialCapsuleId')::uuid,(v_binding ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','path-completion-final','The authorized changes are recorded.','final');
	v_result := jsonb_set(v_result,'{backend_result,message_count}','1');
	v_result := jsonb_set(v_result,'{backend_result,final_message_id}',v_send -> 'messageId');
	reset role;
	foreach v_probe in array array['context-revoked','native-released'] loop
		begin
			if v_probe = 'context-revoked' then
				update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = current_setting('qorpera_test.path_grant')::uuid;
			else
				update public.qorpera_native_provider_connection_leases set status = 'released',released_at = clock_timestamp()
				where id = (v_binding ->> 'leaseId')::uuid;
			end if;
			set local role service_role;
			begin
				perform pg_temp.path_complete(v_result);
				raise exception 'Governed completion ignored %',v_probe;
			exception when insufficient_privilege then null; end;
			raise exception using errcode = 'QTC01';
		exception when sqlstate 'QTC01' then null; end;
	end loop;
	set local role service_role;
	v_completed := pg_temp.path_complete(v_result);
	if pg_temp.path_complete(v_result) <> v_completed then raise exception 'Completion response replay changed its receipt'; end if;
	begin
		perform pg_temp.path_complete(jsonb_set(v_result,'{usage,execution_ms}','51'));
		raise exception 'Completion accepted different replay data';
	exception when unique_violation then null; end;
	reset role;
	if v_completed ->> 'status' <> 'completed'
		or v_completed #>> '{result,company_file,native_binary_sha256}' <> repeat('a',64)
		or v_completed #>> '{result,company_file,output_snapshot_id}' <> v_last_agent_head::text
		or jsonb_array_length(v_completed #> '{result,company_file,applied_receipt_ids}') < 2
		or jsonb_array_length(v_completed #> '{result,company_file,proposal_receipt_ids}') < 1
		or (select head_snapshot_id from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020') <> v_head
		or (select count(*) from public.qorpera_execution_run_results where run_id = (v_binding ->> 'runId')::uuid) <> 1
		or (select count(*) from public.qorpera_agent_sends where run_id = (v_binding ->> 'runId')::uuid) <> 1
		or exists(select 1 from public.qorpera_native_provider_connection_leases where id = (v_binding ->> 'leaseId')::uuid and status = 'active')
		or not exists(select 1 from public.qorpera_execution_provider_sessions where run_id = (v_binding ->> 'runId')::uuid
			and provider_session_id = 'governed-native-fixture') then
		raise exception 'Governed completion republished, duplicated delivery or omitted durable receipts'; end if;
	raise exception using errcode = 'QTC01';
exception when sqlstate 'QTC01' then null;
end
$$;
-- Step 6 source-fence component checks. The candidate projection and verified
-- storage rows are synthetic fixtures, not a production import. Admission,
-- native lease, ACLs, versions, durable retention and transactions are real.
-- Canonical publication/CAS/proposals are exercised independently above.
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
	v_run uuid := (v_binding ->> 'runId')::uuid;
	v_template jsonb; v_page jsonb; v_metadata jsonb; v_sources jsonb;
	v_paths text[]; v_before text[]; v_after text[]; v_retain text[];
	v_cursor text := null; v_snapshot uuid := null; v_scanned integer := 0;
	v_path text; v_role text; v_function text; v_probe text; v_version uuid;
	v_resource jsonb; v_count integer;
begin
	perform pg_temp.path_claims('service_role');
	foreach v_role in array array['anon','authenticated','service_role'] loop
		foreach v_function in array array['public.qorpera_company_path_metadata(jsonb,text)',
			'public.qorpera_company_path_page(jsonb,text,text,uuid,integer)'] loop
			if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Candidate helper exposed'; end if;
		end loop;
		if v_role <> 'service_role' then
			foreach v_function in array array['public.qorpera_read_company_path_candidates(uuid,jsonb,text[])',
				'public.qorpera_list_company_path_candidates(uuid,jsonb,text,text,uuid,integer)',
				'public.qorpera_retain_company_path_sources(uuid,jsonb,text[],jsonb,text[])'] loop
				if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Candidate RPC exposed to end user'; end if;
			end loop;
		end if;
	end loop;
	select array_agg(path order by path) into v_before from public.qorpera_company_run_read_paths where run_id = v_run;
	if cardinality(v_before) < 1 then raise exception 'Fixture must retain prior native context'; end if;
	v_template := pg_temp.path_stage_file('knowledge/fact-000.json','{"schema":"qorpera.company-memory/v1","state":"active","kind":"fact","title":"Fixture","text":"Synthetic"}');
	insert into public.qorpera_company_path_entries(environment_id,path,entry)
	values (v_environment,'knowledge','{"path":"knowledge","kind":"directory"}');
	for i in 0..159 loop
		v_path := 'knowledge/fact-' || lpad(i::text,3,'0') || '.json';
		insert into public.qorpera_company_path_entries(environment_id,path,entry)
		values (v_environment,v_path,jsonb_set(v_template,'{path}',to_jsonb(v_path)));
	end loop;
	loop
		set local role service_role;
		v_page := public.qorpera_list_company_path_candidates(v_environment,v_binding,'knowledge',v_cursor,v_snapshot,32);
		v_snapshot := (v_page ->> 'snapshotId')::uuid;
		v_scanned := v_scanned + jsonb_array_length(v_page -> 'items');
		if jsonb_array_length(v_page -> 'items') > 32 or v_scanned > 160 then raise exception 'Unbounded candidate page'; end if;
		select array_agg(value ->> 'path' order by value ->> 'path') into v_paths from jsonb_array_elements(v_page -> 'items');
		v_metadata := public.qorpera_read_company_path_candidates(v_environment,v_binding,v_paths);
		select jsonb_agg(jsonb_build_object('path',value -> 'path','version',value -> 'version')) into v_sources
		from jsonb_array_elements(v_metadata);
		v_retain := case when (v_page ->> 'hasMore')::boolean then array[]::text[] else array['knowledge/fact-159.json'] end;
		perform public.qorpera_retain_company_path_sources(v_environment,v_binding,array['knowledge'] || v_paths,v_sources,v_retain);
		reset role;
		select array_agg(path order by path) into v_after from public.qorpera_company_run_read_paths where run_id = v_run;
		if cardinality(v_after) <> cardinality(v_before) + cardinality(v_retain)
			or not (v_before <@ v_after) then raise exception 'Candidate scan accumulated paths or forgot prior context'; end if;
		exit when not (v_page ->> 'hasMore')::boolean;
		v_cursor := v_page ->> 'nextAfter';
	end loop;
	if v_scanned <> 160 or not ('knowledge/fact-159.json' = any(v_after)) then raise exception 'Candidate traversal stopped early'; end if;
	-- An empty retained set validates a rebuild but does not create model context.
	set local role service_role;
	perform public.qorpera_retain_company_path_sources(v_environment,v_binding,v_paths,v_sources,'{}');
	perform public.qorpera_read_company_path(v_environment,'knowledge/fact-000.json',v_binding);
	reset role;
	if not exists (select 1 from public.qorpera_company_run_read_paths where run_id = v_run and path = 'knowledge/fact-000.json') then
		raise exception 'Normal native reads lost durable retention'; end if;

	-- A private candidate is hidden even from an owner-sponsored company turn.
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_resource := public.qorpera_set_company_path_resource(v_environment,'knowledge/fact-001.json','exact','member_private','normal');
	perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,
		'staff_agent','29000000-0000-4000-8000-000000000030',array['read']);
	reset role;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_page := public.qorpera_list_company_path_candidates(v_environment,v_binding,'knowledge',null,null,32);
	if exists (select 1 from jsonb_array_elements(v_page -> 'items') where value ->> 'path' = 'knowledge/fact-001.json') then
		raise exception 'Candidate listing leaked private metadata'; end if;
	foreach v_path in array array['knowledge/fact-001.json','knowledge/FACT-000.json','secrets/credential'] loop
		begin
			perform public.qorpera_read_company_path_candidates(v_environment,v_binding,array[v_path]);
			raise exception 'Candidate read ignored private scope or path identity';
		exception when insufficient_privilege then null; end;
	end loop;
	begin
		perform public.qorpera_read_company_path_candidates('29000000-0000-4000-8000-000000000099',v_binding,array['note.md']);
		raise exception 'Candidate read crossed the bound environment';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_read_company_path_candidates(v_environment,null,array['note.md']);
		raise exception 'Candidate read accepted no run binding';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_read_company_path_candidates(v_environment,v_binding,array_fill('note.md'::text,array[33]));
		raise exception 'Candidate batch exceeded its bound';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_list_company_path_candidates(v_environment,v_binding,'knowledge',null,null,33);
		raise exception 'Candidate page exceeded its bound';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_list_company_path_candidates(v_environment,v_binding,'knowledge',null,extensions.gen_random_uuid(),32);
		raise exception 'Candidate listing accepted a stale snapshot';
	exception when serialization_failure then null; end;
	reset role;

	-- Revalidation and retention are one transaction, including when a discarded
	-- candidate or previously emitted native source loses access.
	select version into v_version from public.qorpera_company_path_entries where environment_id = v_environment and path = 'knowledge/fact-002.json';
	v_paths := array['knowledge/fact-002.json'];
	v_sources := jsonb_build_array(jsonb_build_object('path',v_paths[1],'version',v_version));
	select array_agg(path order by path) into v_before from public.qorpera_company_run_read_paths where run_id = v_run;
	foreach v_probe in array array['version','deleted','candidate-revoked','prior-context','lease'] loop
		begin
			if v_probe in ('version','deleted') then
				update public.qorpera_company_path_entries set version = extensions.gen_random_uuid(),
					entry = case when v_probe = 'deleted' then null else entry end
				where environment_id = v_environment and path = v_paths[1];
			elsif v_probe = 'lease' then
				update public.qorpera_native_provider_connection_leases set status = 'revoked',released_at = clock_timestamp()
				where id = (v_binding ->> 'leaseId')::uuid;
			else
				perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
				set local role authenticated;
				perform public.qorpera_set_company_path_resource(v_environment,
					case when v_probe = 'prior-context' then 'knowledge/fact-159.json' else v_paths[1] end,
					'exact','member_private','normal');
				reset role;
			end if;
			perform pg_temp.path_claims('service_role');
			set local role service_role;
			begin
				perform public.qorpera_retain_company_path_sources(v_environment,v_binding,v_paths,v_sources,v_paths);
				raise exception 'Source retention ignored %',v_probe;
			exception when serialization_failure or insufficient_privilege then null; end;
			if v_probe in ('prior-context','lease') then
				begin
					perform public.qorpera_read_company_path_candidates(v_environment,v_binding,'{}');
					raise exception 'Restarted preparation forgot old context or lease';
				exception when insufficient_privilege then null; end;
			end if;
			reset role;
			select array_agg(path order by path) into v_after from public.qorpera_company_run_read_paths where run_id = v_run;
			if v_after <> v_before then raise exception 'Rejected retention changed durable context'; end if;
			raise exception using errcode = 'QTK02';
		exception when sqlstate 'QTK02' then null; end;
	end loop;
	set local role service_role;
	begin
		perform public.qorpera_retain_company_path_sources(v_environment,v_binding,v_paths,v_sources,array['unprepared']);
		raise exception 'Unprepared source entered context';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_retain_company_path_sources(v_environment,v_binding,v_paths,
			jsonb_build_array(jsonb_build_object('path',v_paths[1],'version',jsonb_build_array(v_version))),v_paths);
		raise exception 'Array version discriminator accepted';
	exception when invalid_parameter_value then null; end;
	reset role;
	-- Preserve the 128-source native ceiling and prove overflow rolls back the
	-- whole promotion, rather than retaining just the first selected source.
	select count(*) into v_count from public.qorpera_company_run_read_paths where run_id = v_run;
	select array_agg('native-slot-' || i::text) into v_paths from generate_series(1,127-v_count) as slots(i);
	set local role service_role;
	perform public.qorpera_assert_company_path_reads(v_environment,v_binding,v_paths);
	reset role;
	v_paths := array['knowledge/fact-002.json','knowledge/fact-003.json'];
	select jsonb_agg(jsonb_build_object('path',path,'version',version)) into v_sources
	from public.qorpera_company_path_entries where environment_id = v_environment and path = any(v_paths);
	set local role service_role;
	begin
		perform public.qorpera_retain_company_path_sources(v_environment,v_binding,v_paths,v_sources,v_paths);
		raise exception 'Source promotion reset or exceeded the native context bound';
	exception when program_limit_exceeded then null; end;
	reset role;
	if (select count(*) from public.qorpera_company_run_read_paths where run_id = v_run) <> 127
		or exists (select 1 from public.qorpera_company_run_read_paths where run_id = v_run and path = any(v_paths)) then
		raise exception 'Failed source promotion partially committed'; end if;
	raise notice 'PASS: Step 6 candidate traversal, batch fences, native retention, isolation, revocation and atomic overflow';
	raise exception using errcode = 'QTK01';
exception when sqlstate 'QTK01' then null;
end
$$;
-- Schema and durable load integration uses the real path publisher and run
-- ledger. Only immutable storage contents and the admitted fixture are synthetic.
create function pg_temp.path_stage_knowledge(p_path text,p_kind text,p_text text)
returns jsonb language plpgsql as $$
declare v_entry jsonb;
begin
	v_entry := pg_temp.path_stage_file(p_path,p_text);
	perform public.qorpera_verify_company_knowledge_file('29000000-0000-4000-8000-000000000010',
		v_entry #>> '{file,manifestSha256}',p_kind,p_text);
	return v_entry;
end
$$;
create function pg_temp.path_skill_text(p_body text,p_newline text default E'\n')
returns text language sql as $$
	select '---' || p_newline || jsonb_build_object('schema','qorpera.company-skill/v1','state','active',
		'name','Review','useWhen','When reviewing synthetic evidence','bodySha256',
		encode(extensions.digest(convert_to(p_body,'utf8'),'sha256'),'hex'),'bodyBytes',octet_length(p_body))::text ||
		p_newline || '---' || p_newline || p_body
$$;
create function pg_temp.path_skill_record(p_reference jsonb,p_source jsonb,p_body text,p_bundle text default 'step6-fixture-v1')
returns jsonb language plpgsql as $$
declare v_run jsonb := jsonb_build_object('companyId','29000000-0000-4000-8000-000000000010',
	'environmentId','29000000-0000-4000-8000-000000000020','runId',current_setting('qorpera_test.path_binding')::jsonb -> 'runId',
	'runtimeBundleVersion',p_bundle);
	v_hash text := encode(extensions.digest(convert_to(p_body,'utf8'),'sha256'),'hex'); v_key text;
begin
	-- Wire identity specified by companySkillLoadKey; delimiters are not JSON encoding.
	v_key := encode(extensions.digest(convert_to(array_to_string(array['qorpera.skill-load/v1',v_run ->> 'companyId',
		v_run ->> 'environmentId',v_run ->> 'runId',p_bundle,p_reference ->> 'kind',coalesce(p_reference ->> 'collectionId',''),
		p_reference ->> 'id',p_source ->> 'version',v_hash],E'\n'),'utf8'),'sha256'),'hex');
	return jsonb_build_object('schema','qorpera.skill-load/v1','loadKey',v_key,'run',v_run,'reference',p_reference,
		'source',p_source,'name','Review','useWhen','When reviewing synthetic evidence',
		'bodySha256',v_hash,'bodyBytes',octet_length(p_body));
end
$$;
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
	v_profile uuid := '29000000-0000-4000-8000-000000000010'; v_run uuid := (v_binding ->> 'runId')::uuid;
	v_owner uuid := '29000000-0000-4000-8000-000000000001'; v_agent uuid := '29000000-0000-4000-8000-000000000030';
	v_memory_text text := '{"schema":"qorpera.company-memory/v1","state":"active","kind":"fact","title":"Fact","text":"Synthetic evidence"}';
	v_body text := E'Read the current authorized Company File.\nAttribute each source.';
	v_memory jsonb; v_skill jsonb; v_bad jsonb; v_result jsonb; v_memory_result jsonb;
	v_memory_resource jsonb; v_skill_resource jsonb; v_registration jsonb; v_collection jsonb; v_collections jsonb;
	v_record jsonb; v_platform jsonb; v_changed jsonb; v_reference jsonb; v_source jsonb;
	v_tombstone text; v_probe text; v_role text; v_function text; v_text text; v_count integer; v_paths integer;
	v_descriptor jsonb;
	v_policy jsonb := '{"id":"explicit-fixture-policy","version":"1","history":"preserve"}';
begin
	insert into public.qorpera_profiles(id,name,created_by_user_id)
	values ('29000000-0000-4000-8000-000000000099','Other knowledge company',v_owner);
	foreach v_role in array array['anon','authenticated','service_role'] loop
		foreach v_function in array array['public.qorpera_company_knowledge_metadata(text,text)',
			'public.qorpera_company_knowledge_entry(uuid,jsonb)','public.qorpera_company_skill_load(uuid,jsonb,jsonb,boolean)',
			'public.qorpera_company_path_plan_before_knowledge(jsonb,jsonb,boolean,boolean)',
			'public.qorpera_company_knowledge_retention_policy(uuid,text,jsonb)',
			'public.qorpera_company_knowledge_history_entry(uuid,text,jsonb)',
			'public.qorpera_company_knowledge_preserve_revision()',
			'public.qorpera_company_retained_extras_before_knowledge(uuid)'] loop
			if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Private knowledge helper exposed'; end if;
		end loop;
		if v_role <> 'service_role' then
			foreach v_function in array array['public.qorpera_verify_company_knowledge_file(uuid,text,text,text)',
				'public.qorpera_retain_company_path_sources(uuid,jsonb,text[],jsonb,text[],jsonb)',
				'public.qorpera_record_company_skill_load(uuid,jsonb,jsonb)','public.qorpera_assert_company_skill_load(uuid,jsonb,jsonb)'] loop
				if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception 'Knowledge service RPC exposed to end user'; end if;
			end loop;
		end if;
		if v_role <> 'authenticated' and has_function_privilege(v_role,'public.qorpera_set_company_knowledge_schema(uuid,text,text,uuid,jsonb)','EXECUTE') then
			raise exception 'Knowledge registration is not human-only'; end if;
	end loop;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	perform pg_temp.path_commit(pg_temp.path_plan('knowledge-memory-directory','memory6','{"path":"memory6","kind":"directory"}'));
	perform pg_temp.path_commit(pg_temp.path_plan('knowledge-skills-directory','skills6','{"path":"skills6","kind":"directory"}'));
	-- An existing ordinary file is not silently adopted into the schema registry.
	v_memory := pg_temp.path_stage_file('memory6/fact.json',v_memory_text);
	v_memory_result := pg_temp.path_commit(pg_temp.path_plan('knowledge-existing','memory6/fact.json',v_memory));
	reset role;
	perform pg_temp.path_claims('authenticated',v_owner);
	set local role authenticated;
	v_memory_resource := public.qorpera_set_company_path_resource(v_environment,'memory6','subtree','company_shared','normal');
	perform public.qorpera_grant_company_path((v_memory_resource ->> 'resourceId')::uuid,(v_memory_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
	begin
		perform public.qorpera_set_company_knowledge_schema(v_environment,'memory6','memory',(v_memory_resource ->> 'version')::uuid);
		raise exception 'Unverified existing content was adopted';
	exception when invalid_parameter_value then null; end;
	reset role;
	if exists(select 1 from public.qorpera_company_path_resources where path = 'memory6'
		and (knowledge_kind is not null or version::text <> v_memory_resource ->> 'version')) then
		raise exception 'Failed schema adoption partially changed a resource'; end if;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	perform public.qorpera_verify_company_knowledge_file(v_profile,v_memory #>> '{file,manifestSha256}','memory',v_memory_text);
	begin
		perform public.qorpera_verify_company_knowledge_file(v_profile,v_memory #>> '{file,manifestSha256}','memory',replace(v_memory_text,'Synthetic evidence','Different content'));
		raise exception 'Semantic proof was attached to different bytes';
	exception when object_not_in_prerequisite_state then null; end;
	begin
		perform public.qorpera_verify_company_knowledge_file('29000000-0000-4000-8000-000000000099',v_memory #>> '{file,manifestSha256}','memory',v_memory_text);
		raise exception 'Semantic proof crossed the company partition';
	exception when object_not_in_prerequisite_state then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
	set local role authenticated;
	begin
		perform public.qorpera_set_company_knowledge_schema(v_environment,'memory6','memory',(v_memory_resource ->> 'version')::uuid);
		raise exception 'Contributor changed a shared schema resource';
	exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated',v_owner);
	set local role authenticated;
	v_registration := public.qorpera_set_company_knowledge_schema(v_environment,'memory6','memory',(v_memory_resource ->> 'version')::uuid,v_policy);
	begin
		perform public.qorpera_set_company_knowledge_schema(v_environment,'memory6','skills',(v_memory_resource ->> 'version')::uuid);
		raise exception 'Schema registration ignored its CAS precondition';
	exception when serialization_failure then null; end;
	reset role;
	v_collection := '{"id":"memory","path":"memory6","kind":"memory","scope":{"kind":"company_shared"}}';
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	begin
		perform public.qorpera_retain_company_path_sources(v_environment,v_binding,'{}','[]','{}',jsonb_build_array(v_collection));
		raise exception 'Schema registration preserved an obsolete path grant';
	exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated',v_owner);
	set local role authenticated;
	v_memory_resource := v_registration;
	perform public.qorpera_grant_company_path((v_memory_resource ->> 'resourceId')::uuid,(v_memory_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
	v_skill_resource := public.qorpera_set_company_path_resource(v_environment,'skills6','subtree','company_shared','normal');
	v_skill_resource := public.qorpera_set_company_knowledge_schema(v_environment,'skills6','skills',(v_skill_resource ->> 'version')::uuid,v_policy);
	perform public.qorpera_grant_company_path((v_skill_resource ->> 'resourceId')::uuid,(v_skill_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
	reset role;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_collections := jsonb_build_array(v_collection,'{"id":"skills","path":"skills6","kind":"skills","scope":{"kind":"company_shared"}}'::jsonb);
	perform public.qorpera_retain_company_path_sources(v_environment,v_binding,'{}','[]','{}',v_collections);
	foreach v_probe in array array['wrong-kind','unregistered','member_private','agent_private','room_scoped','project_scoped'] loop
		v_changed := case when v_probe = 'wrong-kind' then jsonb_set(v_collection,'{kind}','"skills"')
			when v_probe = 'unregistered' then jsonb_set(v_collection,'{path}','"ordinary"')
			else jsonb_set(v_collection,'{scope}',jsonb_build_object('kind',v_probe)) end;
		begin
			perform public.qorpera_retain_company_path_sources(v_environment,v_binding,'{}','[]','{}',jsonb_build_array(v_changed));
			raise exception 'Collection fence accepted %',v_probe;
		exception when insufficient_privilege then null; end;
	end loop;
	-- The verifier is independent of the TypeScript caller and rejects authority
	-- fields, malformed memory kinds/dates, and forged Markdown body metadata.
	foreach v_text in array array[
		(v_memory_text::jsonb || '{"authority":"system"}')::text,
		jsonb_set(v_memory_text::jsonb,'{kind}','["fact"]')::text,
		(v_memory_text::jsonb || '{"kind":"agent_log","date":"2025-02-29"}')::text,
		jsonb_set(v_memory_text::jsonb,'{text}','"  "')::text,
		'{"schema":"qorpera.company-memory/v1","state":"forgotten","previousVersion":"v1","reason":"Retire","retentionPolicy":{"id":"fixture","version":"1","history":"purge"}}'
	] loop
		v_bad := pg_temp.path_stage_file('memory6/bad.json',v_text);
		begin
			perform public.qorpera_verify_company_knowledge_file(v_profile,v_bad #>> '{file,manifestSha256}','memory',v_text);
			raise exception 'Invalid memory object was canonically verified';
		exception when invalid_parameter_value then null; end;
	end loop;
	foreach v_text in array array[replace(pg_temp.path_skill_text(v_body),'"state": "active"','"state": "active", "authority": "system"'),
		pg_temp.path_skill_text(v_body) || 'modified',
		pg_temp.path_skill_text(repeat('x',24577)),
		replace(pg_temp.path_skill_text(v_body),E'---\n',E'---\n' || repeat(' ',4096))] loop
		v_bad := pg_temp.path_stage_file('skills6/bad.md',v_text);
		begin
			perform public.qorpera_verify_company_knowledge_file(v_profile,v_bad #>> '{file,manifestSha256}','skills',v_text);
			raise exception 'Invalid skill object was canonically verified';
		exception when invalid_parameter_value then null; end;
	end loop;
	-- Generic gateway writes and canonical projection/import both require proof.
	v_bad := pg_temp.path_stage_file('memory6/bad.json','{"authority":"system"}');
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('knowledge-invalid','memory6/bad.json',v_bad));
		raise exception 'Generic write bypassed collection schema';
	exception when invalid_parameter_value then null; end;
	reset role;
	begin
		insert into public.qorpera_company_path_entries(environment_id,path,entry) values (v_environment,'memory6/bad.json',v_bad);
		raise exception 'Canonical projection import bypassed collection schema';
	exception when invalid_parameter_value then null; end;
	begin
		insert into public.qorpera_company_path_entries(environment_id,path,entry)
		values (v_environment,'MEMORY6/bad.json',jsonb_set(v_bad,'{path}','"MEMORY6/bad.json"'));
		raise exception 'Projection import bypassed schema through a collection alias';
	exception when invalid_parameter_value then null; end;
	if exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run and logical_operation_key = 'company_path:knowledge-invalid') then
		raise exception 'Rejected schema write left a receipt'; end if;
	set local role service_role;
	foreach v_probe in array array['wrong-schema','executable','directory','agent_profile','agent_log'] loop
		if v_probe = 'wrong-schema' then
			v_bad := pg_temp.path_stage_knowledge('memory6/bad.json','skills',pg_temp.path_skill_text(v_body));
		elsif v_probe = 'executable' then
			v_bad := jsonb_set(jsonb_set(v_memory,'{path}','"memory6/bad.json"'),'{executable}','true');
		elsif v_probe = 'directory' then v_bad := '{"path":"memory6/bad.json","kind":"directory"}';
		else
			v_text := (jsonb_set(v_memory_text::jsonb,'{kind}',to_jsonb(v_probe)) ||
				case when v_probe = 'agent_log' then '{"date":"2024-02-29"}'::jsonb else '{}'::jsonb end)::text;
			v_bad := pg_temp.path_stage_knowledge('memory6/bad.json','memory',v_text);
		end if;
		begin
			perform pg_temp.path_commit(pg_temp.path_plan('knowledge-' || v_probe,'memory6/bad.json',v_bad));
			raise exception 'Canonical collection accepted %',v_probe;
		exception when invalid_parameter_value or insufficient_privilege then null; end;
	end loop;
	-- Governed forget is a schema-valid CAS tombstone. History stays reachable;
	-- no period or automatic purge is introduced by the service or migration.
	v_tombstone := jsonb_build_object('schema','qorpera.company-memory/v1','state','forgotten',
		'previousVersion',v_memory_result -> 'version','reason','Synthetic retirement',
		'retentionPolicy',jsonb_build_object('id','explicit-fixture-policy','version','1','history','preserve'))::text;
	v_bad := pg_temp.path_stage_knowledge('memory6/fact.json','memory',jsonb_set(v_tombstone::jsonb,'{previousVersion}','"different-version"')::text);
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('knowledge-forget-wrong-lineage','memory6/fact.json',v_bad,(v_memory_result ->> 'version')::uuid));
		raise exception 'Tombstone claimed a different predecessor';
	exception when serialization_failure then null; end;
	v_bad := pg_temp.path_stage_knowledge('memory6/fact.json','memory',v_tombstone);
	v_result := pg_temp.path_commit(pg_temp.path_plan('knowledge-forget','memory6/fact.json',v_bad,(v_memory_result ->> 'version')::uuid));
	if v_result ->> 'state' <> 'applied' or v_result ->> 'version' = v_memory_result ->> 'version' then
		raise exception 'Forget did not publish a new version'; end if;
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('knowledge-stale-revise','memory6/fact.json',v_memory,(v_memory_result ->> 'version')::uuid));
		raise exception 'Memory revision accepted a stale write';
	exception when serialization_failure then null; end;
	reset role;
	if not exists(select 1 from public.qorpera_company_path_revisions where snapshot_id = (v_memory_result ->> 'snapshotId')::uuid)
		or not exists(select 1 from public.qorpera_profile_objects where profile_id = v_profile and sha256 = v_memory #>> '{file,fileSha256}') then
		raise exception 'Forget purged historical Company File data'; end if;
	set local role service_role;
	v_skill := pg_temp.path_stage_knowledge('skills6/review.md','skills',pg_temp.path_skill_text(v_body,E'\r\n'));
	v_result := pg_temp.path_commit(pg_temp.path_plan('knowledge-skill','skills6/review.md',v_skill));
	v_reference := '{"kind":"company","collectionId":"skills","id":"review"}';
	v_source := jsonb_build_object('kind','company_file','companyId',v_profile,'environmentId',v_environment,
		'collectionId','skills','objectId','review','path','skills6/review.md','version',v_result -> 'version',
		'scope',jsonb_build_object('kind','company_shared'),'trust','untrusted_data','authority','none');
	v_record := pg_temp.path_skill_record(v_reference,v_source,v_body);
	-- Even the first record must match the canonical header, not just its body.
	foreach v_probe in array array['name','useWhen'] loop
		begin
			perform public.qorpera_record_company_skill_load(v_environment,v_binding,
				jsonb_set(v_record,array[v_probe],'"Forged instructions"'));
			raise exception 'Recorder accepted forged catalog metadata: %',v_probe;
		exception when invalid_parameter_value then null; end;
	end loop;
	begin
		perform public.qorpera_assert_company_skill_load(v_environment,v_binding,v_record);
		raise exception 'Replay created an unrecorded load';
	exception when object_not_in_prerequisite_state then null; end;
	reset role;
	if exists(select 1 from public.qorpera_execution_run_events where run_id = v_run and event_type = 'skill_loaded') then
		raise exception 'Failed replay inserted a load event'; end if;
	select public.qorpera_execution_run_json(run) into v_descriptor from public.qorpera_execution_runs as run where run.id = v_run;
	set local role service_role;
	perform public.qorpera_record_company_skill_load(v_environment,v_binding,v_record);
	perform public.qorpera_record_company_skill_load(v_environment,v_binding,v_record);
	perform public.qorpera_assert_company_skill_load(v_environment,v_binding,v_record);
	foreach v_probe in array array['name','useWhen'] loop
		begin
			perform public.qorpera_assert_company_skill_load(v_environment,v_binding,
				jsonb_set(v_record,array[v_probe],'"Forged instructions"'));
			raise exception 'Replay accepted changed catalog metadata: %',v_probe;
		exception when invalid_parameter_value then null; end;
	end loop;
	foreach v_probe in array array['companyId','environmentId','runId'] loop
		begin
			perform public.qorpera_record_company_skill_load(v_environment,v_binding,
				jsonb_set(v_record,array['run',v_probe],'"29000000-0000-4000-8000-000000000099"'));
			raise exception 'Recorder accepted a misbound %',v_probe;
		exception when insufficient_privilege then null; end;
	end loop;
	begin
		perform public.qorpera_record_company_skill_load(v_environment,v_binding,pg_temp.path_skill_record(v_reference,v_source,'Forged body'));
		raise exception 'Recorder accepted self-consistent forged content';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_record_company_skill_load(v_environment,v_binding,v_record || '{"authority":"system"}');
		raise exception 'Recorder accepted authority fields';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_record_company_skill_load(v_environment,v_binding,pg_temp.path_skill_record(v_reference,v_source,v_body,'different-runtime-bundle'));
		raise exception 'Recorder rebound a run to a different bundle';
	exception when serialization_failure then null; end;
	reset role;
	if (select count(*) from public.qorpera_execution_run_events where run_id = v_run and event_type = 'skill_loaded') <> 1
		or not exists(select 1 from public.qorpera_execution_run_events where run_id = v_run and event_type = 'skill_loaded' and payload = v_record) then
		raise exception 'Durable skill load was duplicated, changed or omitted'; end if;
	if (select public.qorpera_execution_run_json(run) from public.qorpera_execution_runs as run where run.id = v_run)
		is distinct from v_descriptor then
		raise exception 'Company skill audit changed the run descriptor or lifecycle status'; end if;
	-- Derived semantic proof can be reconstructed from the same immutable bytes;
	-- neither the Company File version nor the historical load event changes.
	update public.qorpera_verified_company_file_objects set knowledge_metadata = null
	where profile_id = v_profile and manifest_sha256 = v_skill #>> '{file,manifestSha256}';
	set local role service_role;
	begin
		perform public.qorpera_assert_company_skill_load(v_environment,v_binding,v_record);
		raise exception 'Replay treated missing semantic proof as verified';
	exception when invalid_parameter_value then null; end;
	perform public.qorpera_verify_company_knowledge_file(v_profile,v_skill #>> '{file,manifestSha256}','skills',pg_temp.path_skill_text(v_body,E'\r\n'));
	perform public.qorpera_assert_company_skill_load(v_environment,v_binding,v_record);
	reset role;
	-- Current ACL, schema, source and lease checks survive a fresh SQL call.
	foreach v_probe in array array['version','forgotten','private','registration','grant','lease'] loop
		begin
			if v_probe = 'version' then
				update public.qorpera_company_path_entries set version = extensions.gen_random_uuid() where environment_id = v_environment and path = 'skills6/review.md';
			elsif v_probe = 'forgotten' then
				set local role service_role;
				v_text := '---' || E'\n' || jsonb_build_object('schema','qorpera.company-skill/v1','state','forgotten',
					'previousVersion',v_source -> 'version','reason','Retired fixture','retentionPolicy',
					jsonb_build_object('id','explicit-fixture-policy','version','1','history','preserve'))::text || E'\n---\n';
				v_bad := pg_temp.path_stage_knowledge('skills6/review.md','skills',v_text);
				perform pg_temp.path_commit(pg_temp.path_plan('knowledge-forget-skill','skills6/review.md',v_bad,(v_source ->> 'version')::uuid));
				reset role;
			elsif v_probe = 'private' then
				perform pg_temp.path_claims('authenticated',v_owner);
				set local role authenticated;
				v_registration := public.qorpera_set_company_path_resource(v_environment,'skills6/review.md','exact','member_private','normal');
				perform public.qorpera_grant_company_path((v_registration ->> 'resourceId')::uuid,(v_registration ->> 'version')::uuid,'staff_agent',v_agent,array['read']);
				-- The owner still has human access; the sponsored company audience does not.
				perform public.qorpera_read_company_path(v_environment,'skills6/review.md');
				reset role;
			elsif v_probe = 'registration' then
				perform pg_temp.path_claims('authenticated',v_owner);
				set local role authenticated;
				perform public.qorpera_set_company_knowledge_schema(v_environment,'skills6',null,(v_skill_resource ->> 'version')::uuid);
				reset role;
			elsif v_probe = 'grant' then
				update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where resource_id = (v_skill_resource ->> 'resourceId')::uuid;
			else
				update public.qorpera_native_provider_connection_leases set status = 'revoked',released_at = clock_timestamp() where id = (v_binding ->> 'leaseId')::uuid;
			end if;
			perform pg_temp.path_claims('service_role');
			set local role service_role;
			begin
				perform public.qorpera_assert_company_skill_load(v_environment,v_binding,v_record);
				raise exception 'Durable replay ignored %',v_probe;
			exception when insufficient_privilege or serialization_failure then null; end;
			raise exception using errcode = 'QKG02';
		exception when sqlstate 'QKG02' then null; end;
	end loop;
	-- Platform records share the ledger and run/bundle fence but cannot create
	-- Company File permissions, paths or an editable platform-skill surface.
	-- Existing lifecycle events still advance status; subsequent audit loads do not.
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values (v_run,'lease_renewed','{"synthetic":true}');
	select public.qorpera_execution_run_json(run) into v_descriptor from public.qorpera_execution_runs as run where run.id = v_run;
	if v_descriptor ->> 'status' <> 'lease_renewed' then raise exception 'Existing run lifecycle status stopped advancing'; end if;
	select count(*) into v_paths from public.qorpera_company_run_read_paths where run_id = v_run;
	v_platform := pg_temp.path_skill_record('{"kind":"platform","id":"review"}',
		'{"kind":"runtime_bundle","runtimeBundleVersion":"step6-fixture-v1","path":"skills/review","version":"platform-1","scope":{"kind":"platform"},"trust":"untrusted_data","authority":"none"}',v_body);
	set local role service_role;
	perform public.qorpera_record_company_skill_load(v_environment,v_binding,v_platform);
	perform public.qorpera_assert_company_skill_load(v_environment,v_binding,v_platform);
	foreach v_probe in array array['name','useWhen'] loop
		begin
			perform public.qorpera_assert_company_skill_load(v_environment,v_binding,
				jsonb_set(v_platform,array[v_probe],'"Forged instructions"'));
			raise exception 'Platform replay accepted changed catalog metadata: %',v_probe;
		exception when unique_violation then null; end;
	end loop;
	begin
		perform public.qorpera_record_company_skill_load(v_environment,v_binding,jsonb_set(v_platform,'{bodyBytes}','1'));
		raise exception 'Same load key accepted different record content';
	exception when unique_violation then null; end;
	reset role;
	if (select count(*) from public.qorpera_company_run_read_paths where run_id = v_run) <> v_paths then
		raise exception 'Platform recording invented Company File authority'; end if;
	if (select public.qorpera_execution_run_json(run) from public.qorpera_execution_runs as run where run.id = v_run)
		is distinct from v_descriptor then
		raise exception 'Platform skill audit replaced the latest lifecycle status'; end if;
	set local role service_role;
	for i in 1..62 loop
		v_reference := jsonb_build_object('kind','platform','id','skill-' || i);
		v_source := jsonb_set(v_platform -> 'source','{path}',to_jsonb('skills/skill-' || i));
		perform public.qorpera_record_company_skill_load(v_environment,v_binding,pg_temp.path_skill_record(v_reference,v_source,v_body));
	end loop;
	-- Count is durable, not a fresh process's empty in-memory load set.
	v_changed := pg_temp.path_skill_record('{"kind":"platform","id":"overflow"}',
		jsonb_set(v_platform -> 'source','{path}','"skills/overflow"'),v_body);
	begin
		perform public.qorpera_record_company_skill_load(v_environment,v_binding,v_changed);
		raise exception 'Restarted recorder exceeded the run load bound';
	exception when program_limit_exceeded then null; end;
	perform public.qorpera_record_company_skill_load(v_environment,v_binding,v_record);
	reset role;
	select count(*) into v_count from public.qorpera_execution_run_events where run_id = v_run and event_type = 'skill_loaded';
	if v_count <> 64 then raise exception 'Load bound purged or duplicated existing events'; end if;
	if (select public.qorpera_execution_run_json(run) from public.qorpera_execution_runs as run where run.id = v_run)
		is distinct from v_descriptor then
		raise exception 'Repeated skill audit events changed the run descriptor'; end if;
	raise notice 'PASS: Step 6 canonical schemas, explicit registration, scope gates, CAS forget, complete load/replay provenance, lifecycle status and run limits';
	raise exception using errcode = 'QKG01';
exception when sqlstate 'QKG01' then null;
end
$$;

create function pg_temp.path_tombstone(p_path text,p_kind text,p_version uuid,p_policy jsonb)
returns jsonb language plpgsql as $$
declare v_text text;
begin
	v_text := jsonb_build_object('schema',case when p_kind = 'memory' then 'qorpera.company-memory/v1' else 'qorpera.company-skill/v1' end,
		'state','forgotten','previousVersion',p_version,'reason','Synthetic preservation regression','retentionPolicy',p_policy)::text;
	if p_kind = 'skills' then v_text := E'---\n' || v_text || E'\n---\n'; end if;
	return pg_temp.path_stage_knowledge(p_path,p_kind,v_text);
end
$$;
create function pg_temp.path_apply_approval(p_proposal_id uuid,p_digest text)
returns jsonb language plpgsql as $$
declare v_prepared jsonb; v_entries jsonb; v_tree text;
begin
	v_prepared := public.qorpera_prepare_company_path_approval(p_proposal_id,p_digest);
	if v_prepared ->> 'state' = 'applied' then
		return jsonb_build_object('state','applied','proposalId',p_proposal_id,'snapshotId',v_prepared -> 'outputSnapshotId');
	end if;
	select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
		select value from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> v_prepared #>> '{plan,path}'
		union all select v_prepared #> '{plan,entry}' where v_prepared #> '{plan,entry}' <> 'null'::jsonb
	) entries;
	v_tree := pg_temp.path_stage_tree(v_entries);
	return public.qorpera_apply_company_path_approval(p_proposal_id,p_digest,(v_prepared ->> 'snapshotId')::uuid,v_tree);
end
$$;

-- Preservation uses the actual immutable publisher, approved policies and GC
-- selector/authorization protocol. Only stored bytes and the passage of time
-- are synthetic; no retention predicate or authority helper is substituted.
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
	v_profile uuid := '29000000-0000-4000-8000-000000000010';
	v_other_profile uuid := '29000000-0000-4000-8000-0000000000b0';
	v_owner uuid := '29000000-0000-4000-8000-000000000001';
	v_agent uuid := '29000000-0000-4000-8000-000000000030';
	v_policy jsonb := '{"id":"explicit-preservation-policy","version":"1","history":"preserve"}';
	v_policy_next jsonb := '{"id":"explicit-preservation-policy","version":"2","history":"preserve"}';
	v_resources jsonb := '{}'; v_forgotten jsonb := '{}';
	v_resource jsonb; v_entry jsonb; v_old jsonb; v_first jsonb; v_initial jsonb; v_result jsonb; v_forget jsonb;
	v_unrelated jsonb; v_proposal jsonb; v_gc jsonb; v_candidate jsonb; v_orphan jsonb;
	v_prepared jsonb; v_entries jsonb;
	v_kind text; v_schema_kind text; v_path text; v_text text; v_probe text; v_hash text; v_digest text; v_tree text;
	v_version uuid; v_head uuid; v_imported_version uuid; v_origin_snapshot uuid; v_count integer; v_bytes bigint;
	v_preserved text[] := '{}'; v_reclaim text[] := '{}'; v_claimed text[];
begin
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_unrelated := pg_temp.path_stage_file('retention-unrelated.txt','Unrelated historical Company File content');
	perform pg_temp.path_commit(pg_temp.path_plan('retention-unrelated-create','retention-unrelated.txt',v_unrelated));
	v_reclaim := array[v_unrelated #>> '{file,fileSha256}',v_unrelated #>> '{file,manifestSha256}'];
	reset role;
	foreach v_kind in array array['memory','skills','pending','policy'] loop
		v_path := 'retain-' || v_kind;
		v_schema_kind := case when v_kind = 'skills' then 'skills' else 'memory' end;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		perform pg_temp.path_commit(pg_temp.path_plan('retention-directory-' || v_kind,v_path,jsonb_build_object('path',v_path,'kind','directory')));
		reset role;
		perform pg_temp.path_claims('authenticated',v_owner);
		set local role authenticated;
		v_resource := public.qorpera_set_company_path_resource(v_environment,v_path,'subtree','company_shared','normal');
		v_resource := public.qorpera_set_company_knowledge_schema(v_environment,v_path,v_schema_kind,(v_resource ->> 'version')::uuid,
			case when v_kind = 'policy' then null else v_policy end);
		perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
		v_resources := jsonb_set(v_resources,array[v_kind],v_resource);
		reset role;
	end loop;
	-- Both governed formats preserve two distinct historical versions and the
	-- tombstone, with an exact predecessor and no imported-origin shortcut.
	foreach v_kind in array array['memory','skills'] loop
		v_path := 'retain-' || v_kind || case when v_kind = 'memory' then '/fact.json' else '/procedure.md' end;
		v_version := null;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		for i in 1..2 loop
			v_text := case when v_kind = 'memory' then jsonb_build_object('schema','qorpera.company-memory/v1','state','active',
				'kind','fact','title','Preserved fact','text','Historical memory version ' || i)::text
				else pg_temp.path_skill_text('Historical skill instructions version ' || i) end;
			v_entry := pg_temp.path_stage_knowledge(v_path,v_kind,v_text);
			v_result := pg_temp.path_commit(pg_temp.path_plan('retention-' || v_kind || '-v' || i,v_path,v_entry,v_version));
			if i = 1 then v_first := v_result; v_initial := v_entry; end if;
			v_version := (v_result ->> 'version')::uuid;
			v_preserved := v_preserved || array[v_entry #>> '{file,fileSha256}',v_entry #>> '{file,manifestSha256}'];
		end loop;
		v_forget := pg_temp.path_tombstone(v_path,v_kind,v_version,v_policy);
		begin
			perform pg_temp.path_commit(pg_temp.path_plan('retention-stale-' || v_kind,v_path,v_forget,(v_first ->> 'version')::uuid));
			raise exception 'Preservation accepted a stale % version',v_kind;
		exception when serialization_failure then null; end;
		v_result := pg_temp.path_commit(pg_temp.path_plan('retention-forget-' || v_kind,v_path,v_forget,v_version));
		if pg_temp.path_commit(pg_temp.path_plan('retention-forget-' || v_kind,v_path,v_forget,v_version)) <> v_result then
			raise exception 'Preservation retry changed its receipt'; end if;
		v_forgotten := jsonb_set(v_forgotten,array[v_kind],v_result);
		v_preserved := v_preserved || array[v_forget #>> '{file,fileSha256}',v_forget #>> '{file,manifestSha256}'];
		reset role;
		if not exists(select 1 from public.qorpera_company_path_revisions where snapshot_id = (v_result ->> 'snapshotId')::uuid
			and change -> 'knowledgeRetention' = jsonb_build_object('schema','qorpera.knowledge-retention/v1','path',v_path,
				'policy',v_policy,'resourceId',v_resources #> array[v_kind,'resourceId'],
				'resourceVersion',v_resources #> array[v_kind,'version'],'throughVersion',v_version,'origin',null))
			or exists(select 1 from public.qorpera_run_operation_receipts
				where logical_operation_key = 'company_path:retention-stale-' || v_kind) then
			raise exception 'Preservation was not bound exactly once to its committed path/version/policy'; end if;
		-- A committed preservation checkpoint remains usable after an older
		-- proof is evicted. Revalidate the new segment, not that derived cache.
		delete from public.qorpera_verified_company_file_objects
		where profile_id = v_profile and manifest_sha256 = v_initial #>> '{file,manifestSha256}';
		set local role service_role;
		v_version := (v_result ->> 'version')::uuid;
		v_entry := pg_temp.path_stage_knowledge(v_path,v_kind,case when v_kind = 'memory' then replace(v_text,'version 2','version 3')
			else pg_temp.path_skill_text('Historical skill instructions version 3') end);
		v_result := pg_temp.path_commit(pg_temp.path_plan('retention-reopen-' || v_kind,v_path,v_entry,v_version));
		v_preserved := v_preserved || array[v_entry #>> '{file,fileSha256}',v_entry #>> '{file,manifestSha256}'];
		v_version := (v_result ->> 'version')::uuid;
		reset role;
		delete from public.qorpera_verified_company_file_objects
		where profile_id = v_profile and manifest_sha256 = v_forget #>> '{file,manifestSha256}';
		set local role service_role;
		v_forget := pg_temp.path_tombstone(v_path,v_kind,v_version,v_policy);
		v_result := pg_temp.path_commit(pg_temp.path_plan('retention-reforget-' || v_kind,v_path,v_forget,v_version));
		v_forgotten := jsonb_set(v_forgotten,array[v_kind],v_result);
		v_preserved := v_preserved || array[v_forget #>> '{file,fileSha256}',v_forget #>> '{file,manifestSha256}'];
		reset role;
	end loop;
	-- The unrelated file was present in those snapshots. Keeping every object
	-- in the old snapshot would make its superseded bytes immortal as well.
	select version into v_version from public.qorpera_company_path_entries where environment_id = v_environment and path = 'retention-unrelated.txt';
	set local role service_role;
	perform pg_temp.path_commit(pg_temp.path_plan('retention-unrelated-replace','retention-unrelated.txt',
		pg_temp.path_stage_file('retention-unrelated.txt','Current unrelated content'),v_version));
	reset role;

	-- A previously published ordinary tombstone has no preservation promise.
	-- Schema adoption must not retroactively claim its missing history exists.
	begin
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		perform pg_temp.path_commit(pg_temp.path_plan('retention-legacy-directory','retain-legacy',
			'{"path":"retain-legacy","kind":"directory"}'));
		v_entry := pg_temp.path_tombstone('retain-legacy/fact.json','memory','29000000-0000-4000-8000-00000000ee01',v_policy);
		perform pg_temp.path_commit(pg_temp.path_plan('retention-legacy-forgotten','retain-legacy/fact.json',v_entry));
		reset role;
		perform pg_temp.path_claims('authenticated',v_owner);
		set local role authenticated;
		v_resource := public.qorpera_set_company_path_resource(v_environment,'retain-legacy','subtree','company_shared','normal');
		begin
			perform public.qorpera_set_company_knowledge_schema(v_environment,'retain-legacy','memory',(v_resource ->> 'version')::uuid,v_policy);
			raise exception 'Legacy unbound tombstone was adopted as preserved history';
		exception when object_not_in_prerequisite_state then null; end;
		reset role;
		if not exists(select 1 from public.qorpera_company_path_resources where id = (v_resource ->> 'resourceId')::uuid
			and version = (v_resource ->> 'version')::uuid and knowledge_kind is null and knowledge_retention_policy is null)
			or not exists(select 1 from public.qorpera_company_path_entries where environment_id = v_environment
				and path = 'retain-legacy/fact.json' and entry = v_entry)
			or exists(select 1 from public.qorpera_company_path_revisions where change #>> '{knowledgeRetention,path}' = 'retain-legacy/fact.json') then
			raise exception 'Rejected legacy adoption changed authority, content or historical promises'; end if;
		raise exception using errcode = 'QKR02';
	exception when sqlstate 'QKR02' then null; end;

	-- Synthetic enrolled-version fixture: the verified prior tree and entry
	-- already exist, but the imported opaque version has no path revision.
	-- This exercises origin recovery, not acceptance of the full cutover flow.
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_path := 'retain-origin/fact.json';
	perform pg_temp.path_commit(pg_temp.path_plan('retention-origin-directory','retain-origin',
		'{"path":"retain-origin","kind":"directory"}'));
	v_text := '{"schema":"qorpera.company-memory/v1","state":"active","kind":"fact","title":"Imported fact","text":"Imported historical content"}';
	v_initial := pg_temp.path_stage_knowledge(v_path,'memory',v_text);
	v_result := pg_temp.path_commit(pg_temp.path_plan('retention-origin-fixture',v_path,v_initial));
	v_origin_snapshot := (v_result ->> 'snapshotId')::uuid;
	reset role;
	v_imported_version := extensions.gen_random_uuid();
	update public.qorpera_company_path_entries set version = v_imported_version where environment_id = v_environment and path = v_path;
	if exists(select 1 from public.qorpera_company_path_revisions where environment_id = v_environment and change ->> 'version' = v_imported_version::text) then
		raise exception 'Synthetic enrollment did not establish a version without a revision'; end if;
	perform pg_temp.path_claims('authenticated',v_owner);
	set local role authenticated;
	v_resource := public.qorpera_set_company_path_resource(v_environment,'retain-origin','subtree','company_shared','normal');
	v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-origin','memory',(v_resource ->> 'version')::uuid,v_policy);
	perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
	reset role;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_entry := pg_temp.path_stage_knowledge(v_path,'memory',replace(v_text,'Imported historical content','Revised after enrollment'));
	v_result := pg_temp.path_commit(pg_temp.path_plan('retention-origin-revise',v_path,v_entry,v_imported_version));
	v_version := (v_result ->> 'version')::uuid;
	v_head := (v_result ->> 'snapshotId')::uuid;
	v_forget := pg_temp.path_tombstone(v_path,'memory',v_version,v_policy);
	reset role;
	begin
		delete from public.qorpera_company_path_tree_cache where profile_id = v_profile and sha256 = (
			select tree_manifest_sha256 from public.qorpera_company_snapshots where id = v_origin_snapshot);
		set local role service_role;
		begin
			perform pg_temp.path_commit(pg_temp.path_plan('retention-origin-unavailable',v_path,v_forget,v_version));
			raise exception 'Preservation guessed an origin without its verified parent tree';
		exception when object_not_in_prerequisite_state then null; end;
		reset role;
		if (select head_snapshot_id from public.qorpera_company_files where environment_id = v_environment) <> v_head
			or exists(select 1 from public.qorpera_company_path_revisions where change #>> '{knowledgeRetention,path}' = v_path)
			or exists(select 1 from public.qorpera_run_operation_receipts where logical_operation_key = 'company_path:retention-origin-unavailable') then
			raise exception 'Missing origin partially published a preservation promise'; end if;
		raise exception using errcode = 'QKR02';
	exception when sqlstate 'QKR02' then null; end;
	set local role service_role;
	v_result := pg_temp.path_commit(pg_temp.path_plan('retention-origin-forget',v_path,v_forget,v_version));
	reset role;
	if not exists(select 1 from public.qorpera_company_path_revisions where snapshot_id = (v_result ->> 'snapshotId')::uuid
		and change #> '{knowledgeRetention,origin}' = jsonb_build_object('version',v_imported_version,'entry',v_initial)
		and change #>> '{knowledgeRetention,throughVersion}' = v_version::text) then
		raise exception 'Imported historical descriptor was not captured exactly'; end if;
	v_preserved := v_preserved || array[v_initial #>> '{file,fileSha256}',v_initial #>> '{file,manifestSha256}',
		v_entry #>> '{file,fileSha256}',v_entry #>> '{file,manifestSha256}',v_forget #>> '{file,fileSha256}',v_forget #>> '{file,manifestSha256}'];

	-- Earlier ordinary files can exceed the knowledge codec's bounded format.
	-- Adopting a valid current object does not make that older history supported.
	begin
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		v_path := 'retain-oversized/fact.json';
		perform pg_temp.path_commit(pg_temp.path_plan('retention-oversized-directory','retain-oversized',
			'{"path":"retain-oversized","kind":"directory"}'));
		v_result := pg_temp.path_commit(pg_temp.path_plan('retention-oversized-original',v_path,
			pg_temp.path_stage_file(v_path,repeat('x',32769))));
		v_entry := pg_temp.path_stage_knowledge(v_path,'memory',replace(v_text,'Imported historical content','Valid current content after large history'));
		v_result := pg_temp.path_commit(pg_temp.path_plan('retention-oversized-revise',v_path,v_entry,(v_result ->> 'version')::uuid));
		v_version := (v_result ->> 'version')::uuid;
		v_head := (v_result ->> 'snapshotId')::uuid;
		reset role;
		perform pg_temp.path_claims('authenticated',v_owner);
		set local role authenticated;
		v_resource := public.qorpera_set_company_path_resource(v_environment,'retain-oversized','subtree','company_shared','normal');
		v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-oversized','memory',(v_resource ->> 'version')::uuid,v_policy);
		perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
		reset role;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		v_forget := pg_temp.path_tombstone(v_path,'memory',v_version,v_policy);
		begin
			perform pg_temp.path_commit(pg_temp.path_plan('retention-oversized-forget',v_path,v_forget,v_version));
			raise exception 'Unsupported historical object acquired a preservation promise';
		exception when object_not_in_prerequisite_state then null; end;
		reset role;
		if (select head_snapshot_id from public.qorpera_company_files where environment_id = v_environment) <> v_head
			or exists(select 1 from public.qorpera_company_path_revisions where change #>> '{knowledgeRetention,path}' = v_path)
			or exists(select 1 from public.qorpera_run_operation_receipts where logical_operation_key = 'company_path:retention-oversized-forget') then
			raise exception 'Unsupported history partially published a preservation promise'; end if;
		raise exception using errcode = 'QKR02';
	exception when sqlstate 'QKR02' then null; end;

	-- A policy label supplied in file contents is not human approval.
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_path := 'retain-policy/guard.json';
	v_text := '{"schema":"qorpera.company-memory/v1","state":"active","kind":"fact","title":"Policy guard","text":"Original guarded history"}';
	v_old := pg_temp.path_stage_knowledge(v_path,'memory',v_text);
	v_result := pg_temp.path_commit(pg_temp.path_plan('retention-policy-source',v_path,v_old));
	v_version := (v_result ->> 'version')::uuid;
	v_forget := pg_temp.path_tombstone(v_path,'memory',v_version,v_policy);
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('retention-unapproved-policy',v_path,v_forget,v_version));
		raise exception 'Unapproved policy label created a preservation binding';
	exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
	set local role authenticated;
	begin
		perform public.qorpera_set_company_knowledge_schema(v_environment,'retain-policy','memory',
			(v_resources #>> '{policy,version}')::uuid,v_policy);
		raise exception 'Contributor approved a company retention policy';
	exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated',v_owner);
	set local role authenticated;
	v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-policy','memory',
		(v_resources #>> '{policy,version}')::uuid,v_policy);
	begin
		perform public.qorpera_set_company_knowledge_schema(v_environment,'retain-policy','memory',
			(v_resources #>> '{policy,version}')::uuid,v_policy_next);
		raise exception 'Retention policy replacement ignored the resource CAS';
	exception when serialization_failure then null; end;
	v_resources := jsonb_set(v_resources,'{policy}',v_resource);
	perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
	reset role;
	if not exists(select 1 from public.qorpera_company_path_resources where id = (v_resource ->> 'resourceId')::uuid
		and version = (v_resource ->> 'version')::uuid and knowledge_retention_policy = v_policy) then
		raise exception 'Failed policy CAS partially replaced the approved policy'; end if;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_entry := pg_temp.path_tombstone(v_path,'memory',v_version,v_policy_next);
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('retention-mismatched-policy',v_path,v_entry,v_version));
		raise exception 'Another policy version was accepted without approval';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_prepare_company_path_mutation('29000000-0000-4000-8000-0000000000b1',v_binding,
			pg_temp.path_plan('retention-other-company',v_path,v_forget,v_version));
		raise exception 'Preservation crossed the admitted company environment';
	exception when insufficient_privilege then null; end;
	reset role;
	foreach v_probe in array array['policy','grant'] loop
		begin
			perform pg_temp.path_claims('service_role');
			set local role service_role;
			v_prepared := public.qorpera_prepare_company_path_mutation(v_environment,v_binding,
				pg_temp.path_plan('retention-revoked-' || v_probe,v_path,v_forget,v_version));
			if v_prepared ->> 'state' <> 'ready' then raise exception 'Revocation probe was not prepared'; end if;
			select jsonb_agg(value order by value ->> 'path') into v_entries from (
				select value from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> v_path
				union all select v_forget
			) entries;
			v_tree := pg_temp.path_stage_tree(v_entries);
			reset role;
			perform pg_temp.path_claims('authenticated',v_owner);
			set local role authenticated;
			if v_probe = 'policy' then
				v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-policy','memory',
					(v_resources #>> '{policy,version}')::uuid,null);
				perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
			else
				perform public.qorpera_revoke_company_path((v_resources #>> '{policy,resourceId}')::uuid,(v_resources #>> '{policy,version}')::uuid);
			end if;
			reset role;
			perform pg_temp.path_claims('service_role');
			set local role service_role;
			begin
				perform public.qorpera_commit_company_path_mutation(v_environment,v_binding,
					pg_temp.path_plan('retention-revoked-' || v_probe,v_path,v_forget,v_version),
					(v_prepared ->> 'snapshotId')::uuid,v_tree);
				raise exception 'Preservation ignored revoked %',v_probe;
			exception when insufficient_privilege then null; end;
			raise exception using errcode = 'QKR02';
		exception when sqlstate 'QKR02' then null; end;
	end loop;
	if exists(select 1 from public.qorpera_company_path_revisions where change #>> '{knowledgeRetention,path}' = v_path)
		or exists(select 1 from public.qorpera_run_operation_receipts where logical_operation_key in (
			'company_path:retention-unapproved-policy','company_path:retention-mismatched-policy',
			'company_path:retention-revoked-policy','company_path:retention-revoked-grant')) then
		raise exception 'Rejected preservation left a binding or receipt'; end if;
	-- An older version may already be missing while its successor is live.
	-- Such a history cannot acquire a truthful preservation receipt.
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_entry := pg_temp.path_stage_knowledge(v_path,'memory',replace(v_text,'Original guarded history','Current guarded history'));
	v_result := pg_temp.path_commit(pg_temp.path_plan('retention-policy-revise',v_path,v_entry,v_version));
	v_version := (v_result ->> 'version')::uuid;
	v_forget := pg_temp.path_tombstone(v_path,'memory',v_version,v_policy);
	reset role;
	select head_snapshot_id into v_head from public.qorpera_company_files where environment_id = v_environment;
	foreach v_probe in array array['body','proof'] loop
		begin
			if v_probe = 'body' then
				delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name = v_profile::text || '/' || (v_old #>> '{file,fileSha256}');
			else
				delete from public.qorpera_verified_company_file_objects where profile_id = v_profile and manifest_sha256 = v_old #>> '{file,manifestSha256}';
			end if;
			set local role service_role;
			begin
				perform pg_temp.path_commit(pg_temp.path_plan('retention-missing-' || v_probe,v_path,v_forget,v_version));
				raise exception 'Preservation accepted a missing historical %',v_probe;
			exception when object_not_in_prerequisite_state then null; end;
			reset role;
			if (select head_snapshot_id from public.qorpera_company_files where environment_id = v_environment) <> v_head
				or exists(select 1 from public.qorpera_company_path_revisions where change #>> '{knowledgeRetention,path}' = v_path)
				or exists(select 1 from public.qorpera_run_operation_receipts where logical_operation_key = 'company_path:retention-missing-' || v_probe) then
				raise exception 'Rejected missing history partially published'; end if;
			raise exception using errcode = 'QKR02';
		exception when sqlstate 'QKR02' then null; end;
	end loop;
	-- GC winning the fence prevents a new preservation operation from racing
	-- an outstanding deletion lease. The nested transaction releases the probe.
	v_orphan := pg_temp.path_stage_file('retention-orphan.txt','Synthetic abandoned staging for GC fencing');
	begin
		update public.qorpera_profile_objects set created_at = statement_timestamp() - interval '31 days'
		where profile_id = v_profile and sha256 = v_orphan #>> '{file,fileSha256}';
		set local role service_role;
		v_gc := public.qorpera_claim_company_object_gc(1,'29000000-0000-4000-8000-00000000ca10');
		if v_gc ->> 'profile_id' is distinct from v_profile::text then raise exception 'GC fencing probe had no candidate'; end if;
		begin
			perform pg_temp.path_commit(pg_temp.path_plan('retention-during-gc',v_path,v_forget,v_version));
			raise exception 'Preservation raced an active GC lease';
		exception when serialization_failure then null; end;
		raise exception using errcode = 'QKR02';
	exception when sqlstate 'QKR02' then null; end;

	-- A proposal is not a committed preservation promise. Policy rotation
	-- invalidates old approval; only a fresh approved publication adds a hold.
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_path := 'retain-pending/fact.json';
	v_old := pg_temp.path_stage_knowledge(v_path,'memory',replace(v_text,'Original guarded history','Protected historical fact'));
	v_result := pg_temp.path_commit(pg_temp.path_plan('retention-protected-source',v_path,v_old));
	v_version := (v_result ->> 'version')::uuid;
	v_preserved := v_preserved || array[v_old #>> '{file,fileSha256}',v_old #>> '{file,manifestSha256}'];
	reset role;
	perform pg_temp.path_claims('authenticated',v_owner);
	set local role authenticated;
	v_resource := public.qorpera_set_company_path_resource(v_environment,'retain-pending','subtree','company_shared','protected',
		(v_resources #>> '{pending,version}')::uuid);
	perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
	v_resources := jsonb_set(v_resources,'{pending}',v_resource);
	reset role;
	foreach v_probe in array array['rejected','rotated','applied'] loop
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		v_forget := pg_temp.path_tombstone(v_path,'memory',v_version,case when v_probe = 'applied' then v_policy_next else v_policy end);
		v_proposal := pg_temp.path_commit(pg_temp.path_plan('retention-proposal-' || v_probe,v_path,v_forget,v_version));
		reset role;
		if v_proposal ->> 'state' <> 'proposed'
			or exists(select 1 from public.qorpera_company_path_revisions where change #>> '{knowledgeRetention,path}' = v_path) then
			raise exception 'An unapproved proposal created a preservation binding'; end if;
		select plan_sha256 into v_digest from public.qorpera_company_path_proposals where id = (v_proposal ->> 'proposalId')::uuid;
		perform pg_temp.path_claims('authenticated',v_owner);
		set local role authenticated;
		perform public.qorpera_review_company_path_proposal((v_proposal ->> 'proposalId')::uuid,v_digest,
			case when v_probe = 'rejected' then 'reject' else 'approve' end);
		if v_probe = 'rotated' then
			v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-pending','memory',
				(v_resources #>> '{pending,version}')::uuid,v_policy_next);
			perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
			v_resources := jsonb_set(v_resources,'{pending}',v_resource);
		end if;
		reset role;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		if v_probe <> 'applied' then
			begin
				perform pg_temp.path_apply_approval((v_proposal ->> 'proposalId')::uuid,v_digest);
				raise exception 'Rejected or policy-stale approval preserved history';
			exception when insufficient_privilege then null; end;
		else
			v_result := pg_temp.path_apply_approval((v_proposal ->> 'proposalId')::uuid,v_digest);
			if pg_temp.path_apply_approval((v_proposal ->> 'proposalId')::uuid,v_digest) <> v_result then
				raise exception 'Approved preservation replay changed its result'; end if;
			v_preserved := v_preserved || array[v_forget #>> '{file,fileSha256}',v_forget #>> '{file,manifestSha256}'];
		end if;
		reset role;
	end loop;
	if not exists(select 1 from public.qorpera_company_path_revisions where snapshot_id = (v_result ->> 'snapshotId')::uuid
		and proposal_id = (v_proposal ->> 'proposalId')::uuid and change #> '{knowledgeRetention,policy}' = v_policy_next)
		or (select count(*) from public.qorpera_company_path_revisions where change ? 'knowledgeRetention') <> 6 then
		raise exception 'Preservation did not follow exact approved publication'; end if;

	-- Existing holds survive policy rotation, schema removal, an ordinary
	-- replacement and an approved deletion. Future replacements are not added
	-- to a historical hold merely because they reuse the same path.
	foreach v_kind in array array['memory','skills'] loop
		v_path := 'retain-' || v_kind || case when v_kind = 'memory' then '/fact.json' else '/procedure.md' end;
		perform pg_temp.path_claims('authenticated',v_owner);
		set local role authenticated;
		v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-' || v_kind,v_kind,
			(v_resources #>> array[v_kind,'version'])::uuid,v_policy_next);
		v_resource := public.qorpera_set_company_knowledge_schema(v_environment,'retain-' || v_kind,null,(v_resource ->> 'version')::uuid);
		perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,'staff_agent',v_agent,array['read','write']);
		reset role;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		v_entry := pg_temp.path_stage_file(v_path,'Post-preservation ordinary replacement for ' || v_kind);
		v_result := pg_temp.path_commit(pg_temp.path_plan('retention-generic-replace-' || v_kind,v_path,v_entry,
			(v_forgotten #>> array[v_kind,'version'])::uuid));
		v_reclaim := v_reclaim || array[v_entry #>> '{file,fileSha256}',v_entry #>> '{file,manifestSha256}'];
		v_proposal := pg_temp.path_commit(pg_temp.path_plan('retention-generic-delete-' || v_kind,v_path,null,(v_result ->> 'version')::uuid));
		reset role;
		select plan_sha256 into v_digest from public.qorpera_company_path_proposals where id = (v_proposal ->> 'proposalId')::uuid;
		perform pg_temp.path_claims('authenticated',v_owner);
		set local role authenticated;
		perform public.qorpera_review_company_path_proposal((v_proposal ->> 'proposalId')::uuid,v_digest,'approve');
		reset role;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		perform pg_temp.path_apply_approval((v_proposal ->> 'proposalId')::uuid,v_digest);
		reset role;
	end loop;

	-- Identical content-address hashes in another company confer no retention
	-- there, and cleared derived caches cannot erase an existing promise.
	insert into public.qorpera_profiles(id,name,created_by_user_id) values (v_other_profile,'Other retention company',v_owner);
	select bytes into v_bytes from public.qorpera_profile_objects where profile_id = v_profile and sha256 = v_preserved[1];
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',v_other_profile::text || '/' || v_preserved[1],jsonb_build_object('size',v_bytes));
	if exists(select 1 from public.qorpera_company_retained_object_hashes(v_other_profile) where object_sha256 = any(v_preserved)) then
		raise exception 'Preservation crossed the company partition'; end if;
	delete from public.qorpera_verified_company_file_objects where profile_id = v_profile and manifest_sha256 = any(v_preserved);
	delete from public.qorpera_company_path_tree_cache where profile_id = v_profile;
	update public.qorpera_company_snapshots set created_at = statement_timestamp() - interval '31 days' where profile_id = v_profile;
	update public.qorpera_profile_objects set created_at = statement_timestamp() - interval '31 days'
	where profile_id = v_profile and sha256 = any(v_preserved || v_reclaim);
	foreach v_hash in array v_preserved loop
		if not exists(select 1 from public.qorpera_company_retained_object_hashes(v_profile) where object_sha256 = v_hash) then
			raise exception 'Aged or subsequently replaced history lost preserved object %',v_hash; end if;
	end loop;
	foreach v_hash in array v_reclaim loop
		if exists(select 1 from public.qorpera_company_retained_object_hashes(v_profile) where object_sha256 = v_hash) then
			raise exception 'Preservation pinned unrelated or later content %',v_hash; end if;
	end loop;
	select count(*) into v_count from public.qorpera_company_path_revisions where change ? 'knowledgeRetention';
	if v_count <> 6 then raise exception 'Later operations removed or invented preservation bindings'; end if;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_gc := public.qorpera_claim_company_object_gc(100,'29000000-0000-4000-8000-00000000ca11');
	select array_agg(value ->> 'sha256') into v_claimed from jsonb_array_elements(v_gc -> 'objects');
	if v_gc ->> 'profile_id' is distinct from v_profile::text or not (v_reclaim <@ v_claimed)
		or v_preserved && v_claimed then raise exception 'Actual GC claim did not honor exact preserved roots'; end if;
	select value into v_candidate from jsonb_array_elements(v_gc -> 'objects') where value ->> 'sha256' = v_unrelated #>> '{file,fileSha256}';
	v_result := public.qorpera_authorize_profile_object_deletion(v_profile,v_candidate ->> 'sha256',
		(v_candidate ->> 'bytes')::bigint,v_candidate ->> 'backend',(v_gc ->> 'lease_id')::uuid);
	if v_result ->> 'state' is distinct from 'authorized' then raise exception 'Unrelated history lost its existing GC behavior'; end if;
	reset role;
	raise notice 'PASS: approved preservation, historical memory/skill roots after 31 days, GC fencing, cache clearing, policy/proposal failures, exact scope and surviving later mutations';
	raise exception using errcode = 'QKR01';
exception when sqlstate 'QKR01' then null;
end
$$;
set constraints all immediate;
rollback;

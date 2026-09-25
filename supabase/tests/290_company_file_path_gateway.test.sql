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
select set_config('qorpera_test.runtime_native_sha',(select bundle.manifest ->> 'nativeBinarySha256'
	from public.qorpera_active_runtime_bundle active join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),true);

create function pg_temp.path_begin(p_binding jsonb,p_binary_sha text default null)
returns jsonb language plpgsql as $$
declare v_identity jsonb := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
begin
	return public.qorpera_begin_native_company_execution_v2(p_binding,
		coalesce(p_binary_sha,current_setting('qorpera_test.runtime_native_sha')),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c',64),10);
end
$$;
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
			or has_table_privilege(v_role,'public.qorpera_company_path_revisions','INSERT') then raise exception 'Path index bypass exposed to %',v_role; end if;
	end loop;
	if has_function_privilege('authenticated','public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_review_company_path_proposal(uuid,text,text)','EXECUTE') then
		raise exception 'Agent and human approval surfaces are not separate'; end if;
end
$$;

-- Shared reads have an explicit, revocable default grant (20260828020700).
-- Verify both the default and the owner's ability to remove it; sponsorship
-- alone must not replace the revoked resource grant.
select set_config('qorpera_test.default_read_grant', (
	select jsonb_build_object('id',g.id,'resourceId',r.id,'version',r.version)::text
	from public.qorpera_company_path_grants g join public.qorpera_company_path_resources r on r.id = g.resource_id
	where r.environment_id = '29000000-0000-4000-8000-000000000020' and r.path = ''
		and g.principal_id = '29000000-0000-4000-8000-000000000030'
		and g.origin = 'default_agent_read' and g.permissions = array['read']::text[] and g.revoked_at is null
), true);
set local role service_role;
select public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020','note.md',current_setting('qorpera_test.path_binding')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_grant jsonb := current_setting('qorpera_test.default_read_grant')::jsonb;
begin
	if v_grant is null then raise exception 'New staff has no ordinary default read grant'; end if;
	perform public.qorpera_revoke_company_path((v_grant ->> 'resourceId')::uuid,
		(v_grant ->> 'version')::uuid,(v_grant ->> 'id')::uuid);
end $$;
reset role;
select pg_temp.path_claims('service_role');
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
		or has_function_privilege('service_role','public.qorpera_begin_native_company_execution(jsonb,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)','EXECUTE') then
		raise exception 'Native start or recovery bypass exposed'; end if;
	set local role service_role;
	v_started := pg_temp.path_begin(v_binding);
	if v_started - array['runtimeBundleSha256','reasoningEffort','reasoningPolicySha256','toolCatalogSha256','contextSha256','contextBytes'] <> jsonb_build_object('schema','qorpera.native-company-execution-start/v1',
		'runId',v_binding ->> 'runId','jobId',v_binding ->> 'jobId','leaseId',v_binding ->> 'leaseId','binarySha256',current_setting('qorpera_test.runtime_native_sha'))
		or v_started ->> 'reasoningEffort' <> 'low' or v_started ->> 'runtimeBundleSha256' is null then
		raise exception 'Native start receipt is not bound'; end if;
	begin
		perform pg_temp.path_begin(v_binding);
		raise exception 'Native turn restarted after a lost acknowledgement';
	exception when object_not_in_prerequisite_state then null; end;
	begin
		perform pg_temp.path_begin(v_binding,repeat('b',64));
		raise exception 'Another native artifact restarted an uncertain turn';
	exception when insufficient_privilege then null; end;
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
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','path-ack','I am checking the requested changes.','progress');
end $$;
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
			if v_result ->> 'schema' <> 'qorpera.member-company-object/v2'
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
		exception when insufficient_privilege or sqlstate 'PT412' then null; end;
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
	exception when sqlstate 'PT412' then null; end;
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
                -- Revoking a requester must preserve the company's remaining
                -- founder and explicitly transfer Computer Usage responsibility.
                update public.qorpera_profile_members set role='owner' where profile_id='29000000-0000-4000-8000-000000000010'
                    and user_id='29000000-0000-4000-8000-000000000002';
                perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
                perform public.qorpera_accept_computer_usage_ownership('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000001');
                perform pg_temp.path_claims('service_role');
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
				-- Simulate a Storage-owned object loss in this rolled-back
				-- fixture. Managed Storage requires its own delete context;
				-- leave all Qorpera retention/authority triggers enabled.
				perform set_config('storage.allow_delete_query','true',true);
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
	begin
		perform public.qorpera_set_company_path_resource('29000000-0000-4000-8000-000000000020',
			'note.md','exact','member_private','normal',extensions.gen_random_uuid());
		raise exception 'Stale resource version changed its access policy';
	exception when sqlstate 'PT412' then null; end;
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
	exception when sqlstate 'PT412' then null; end;
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
	exception when sqlstate 'PT412' then null; end;
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
	if v_context ->> 'schema' <> 'qorpera.native-company-context/v2'
		or v_context ->> 'agentKind' <> 'employee'
		or v_context -> 'initialAcknowledgementSatisfied' is distinct from 'true'::jsonb
		or v_context #>> '{identity,runId}' <> v_binding ->> 'runId'
		or v_context #>> '{company,id}' <> '29000000-0000-4000-8000-000000000010'
		or v_context #>> '{agent,id}' <> '29000000-0000-4000-8000-000000000030'
		or v_context #>> '{audience,kind}' <> 'company'
		or v_context #>> '{audience,userId}' is not null
		or v_context #>> '{runtimeBundle,id}' is distinct from v_context #>> '{identity,runtimeBundleId}'
		or v_context #>> '{runtimeBundle,sha256}' is distinct from v_context #>> '{identity,runtimeBundleSha256}'
		or jsonb_array_length(v_context -> 'currentInputs') <> 1
		or jsonb_array_length(v_context -> 'history') <> 0
		or v_context::text ~ 'credentialCapsule|encryptedCapsule|session_token|lease_token|attestation' then
		raise exception 'Cloud context did not derive its closed identity and audience'; end if;
	v_input := v_context #> '{currentInputs,0}';
	if v_input ->> 'kind' <> 'current_human_request' or v_input ->> 'actorKind' <> 'human'
		or v_input ->> 'authorUserId' <> '29000000-0000-4000-8000-000000000001'
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
	exception when sqlstate 'PT412' then null; end;
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
				-- Attachment authority makes canonical input identity immutable.
				-- The forged author must now fail at the write, before a later
				-- context reconstruction can observe it. Never disable that guard
				-- to manufacture the older corrupted-input fixture.
				begin
					update public.qorpera_session_inputs set author_user_id = '29000000-0000-4000-8000-000000000002'
					where execution_run_id = (v_binding ->> 'runId')::uuid;
					raise exception 'Canonical input author was replaced';
				exception when insufficient_privilege then
					if sqlerrm <> 'Canonical input identity cannot change' then raise; end if;
				end;
				set local role service_role;
				if public.qorpera_describe_company_run_context(v_binding) #>> '{currentInputs,0,authorUserId}'
					is distinct from '29000000-0000-4000-8000-000000000001' then
					raise exception 'Rejected author replacement changed canonical context'; end if;
				perform public.qorpera_assert_company_path_reads('29000000-0000-4000-8000-000000000020',v_binding,'{}');
				raise exception using errcode = 'QTC01';
			elsif v_probe = 'session' then
				update public.qorpera_shared_sessions set status = 'closed' where id = '29000000-0000-4000-8000-000000000040';
			else
				update public.qorpera_profile_staff set charter = 'Changed job specification',version = version + 1
				where staff_agent_id = '29000000-0000-4000-8000-000000000030';
			end if;
			set local role service_role;
			if v_probe = 'staff-version' then
				-- An edit applies from the agent's next run. The run in flight is not
				-- refused and is not handed the edited charter: it keeps describing its
				-- agent and its job specification as of its own version.
				if (select c #>> '{jobSpecification,content,text}' = 'Changed job specification'
						or (c #>> '{agent,version}')::bigint is distinct from (select staff_version
							from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid)
					from public.qorpera_describe_company_run_context(v_binding) c) then
					raise exception 'An agent edit reached into the run in flight'; end if;
				perform public.qorpera_assert_company_path_reads('29000000-0000-4000-8000-000000000020',v_binding,'{}');
				raise exception using errcode = 'QTC01';
			end if;
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
	v_next_turn jsonb; v_next_run uuid; v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb; v_context jsonb;
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
	perform pg_temp.path_begin(v_binding);
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
	v_result := jsonb_set(v_result,'{backend_result,message_count}','2');
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
		or v_completed #>> '{result,company_file,native_binary_sha256}' <> current_setting('qorpera_test.runtime_native_sha')
		or v_completed #>> '{result,company_file,output_snapshot_id}' <> v_last_agent_head::text
		or jsonb_array_length(v_completed #> '{result,company_file,applied_receipt_ids}') < 2
		or jsonb_array_length(v_completed #> '{result,company_file,proposal_receipt_ids}') < 1
		or (select head_snapshot_id from public.qorpera_company_files where environment_id = '29000000-0000-4000-8000-000000000020') <> v_head
		or (select count(*) from public.qorpera_execution_run_results where run_id = (v_binding ->> 'runId')::uuid) <> 1
		or (select count(*) from public.qorpera_agent_sends where run_id = (v_binding ->> 'runId')::uuid) <> 2
		or exists(select 1 from public.qorpera_native_provider_connection_leases where id = (v_binding ->> 'leaseId')::uuid and status = 'active')
		or not exists(select 1 from public.qorpera_execution_provider_sessions where run_id = (v_binding ->> 'runId')::uuid
			and provider_session_id = 'governed-native-fixture') then
			raise exception 'Governed completion republished, duplicated delivery or omitted durable receipts'; end if;
	-- Step 2 uses the canonical human-turn producer, not the later wake bus.
	-- After writes and a human-approved revision, the next human turn must pin
	-- the current live head and deliver through the unchanged required mouth.
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_next_turn := public.qorpera_request_session_turn_v2(
		'29000000-0000-4000-8000-000000000040','29000000-0000-4000-8000-000000000110','29000000-0000-4000-8000-000000000111',
		'{"schema":"qorpera.session-prompt/v1","text":"Read the updated company.","images":[]}','member_connection',
		(current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,
		(current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}');
	reset role;
	v_next_run := (v_next_turn ->> 'turn_request_id')::uuid;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	perform public.qorpera_materialize_session_turn_requests(32);
	reset role;
	if v_next_run is null or not exists (
		select 1 from public.qorpera_execution_runs run
		join public.qorpera_shared_sessions session on session.id = run.session_id
		where run.id = v_next_run and run.source_kind = 'session_turn'
			and run.company_snapshot_id = v_head and session.company_snapshot_id = v_head
			and session.staff_version = run.staff_version
			and run.id <> (v_binding ->> 'runId')::uuid
	) then raise exception 'The next human turn did not refresh the live Company File pin'; end if;
	set local role service_role;
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('29000000-0000-4000-8000-000000000092',
		'29000000-0000-4000-8000-000000000112',120);
	if v_claim #>> '{work,run_id}' is distinct from v_next_run::text then raise exception 'Wrong second human run'; end if;
	v_runner := public.qorpera_provision_execution_runner(v_next_run,'29000000-0000-4000-8000-000000000113','process',repeat('1',64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid,repeat('1',64),repeat('2',64),'linux','path-next-human-fixture');
	v_assignment := public.qorpera_assign_runner_job('29000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid,'29000000-0000-4000-8000-000000000114',repeat('3',64),120);
	perform public.qorpera_accept_runner_assignment((v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,(v_claim #>> '{work,job_id}')::uuid,repeat('3',64));
	v_lease := public.qorpera_acquire_native_provider_connection_lease(v_next_run,(v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('3',64),120);
	v_binding := jsonb_build_object('leaseId',v_lease ->> 'lease_id','runId',v_next_run,
		'jobId',v_claim #>> '{work,job_id}','runnerId',v_runner ->> 'runner_id','assignmentId',v_assignment ->> 'assignment_id',
		'credentialCapsuleId',v_lease ->> 'credential_capsule_id','computeIdentityId',v_lease ->> 'compute_identity_id',
		'provider','openai','nativeHarness','codex-cli','model','gpt-native');
	v_context := public.qorpera_describe_company_run_context(v_binding);
	if v_context -> 'initialAcknowledgementSatisfied' is distinct from 'false'::jsonb
		or v_context #>> '{identity,runId}' <> v_next_run::text
		or v_context #>> '{currentInputs,0,kind}' <> 'current_human_request'
		or v_context #>> '{currentInputs,0,content,text}' <> 'Read the updated company.' then
		raise exception 'Second human turn did not compose its own admitted input'; end if;
	perform pg_temp.path_begin(v_binding);
	perform public.qorpera_send_native_agent_message((v_binding ->> 'leaseId')::uuid,v_next_run,
		(v_binding ->> 'jobId')::uuid,(v_binding ->> 'runnerId')::uuid,(v_binding ->> 'assignmentId')::uuid,
		(v_binding ->> 'credentialCapsuleId')::uuid,(v_binding ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','next-human-ack','I am checking the live company.','progress');
	v_send := public.qorpera_send_native_agent_message((v_binding ->> 'leaseId')::uuid,v_next_run,
		(v_binding ->> 'jobId')::uuid,(v_binding ->> 'runnerId')::uuid,(v_binding ->> 'assignmentId')::uuid,
		(v_binding ->> 'credentialCapsuleId')::uuid,(v_binding ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','next-human-final','The live company is available.','final');
	reset role;
	if v_send ->> 'runId' <> v_next_run::text or not exists (
		select 1 from public.qorpera_agent_sends send join public.qorpera_session_events event on event.event_id = send.event_id
		where send.run_id = v_next_run and send.phase = 'final'
			and event.execution_id = v_next_run and event.session_id = '29000000-0000-4000-8000-000000000040'
	) then raise exception 'Second human turn could not deliver without wake integration'; end if;
	raise exception using errcode = 'QTC01';
exception when sqlstate 'QTC01' then null;
end
$$;
set constraints all immediate;
rollback;

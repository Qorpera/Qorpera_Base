-- Canonical coding admission, two native turns, and rollback emergency-stop probe.
-- Setup reused from 290_company_file_path_gateway.test.sql through native
-- admission; standalone so the disposable SQL harness can run this file alone.
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
select public.qorpera_consent_provider_connection_autonomous('29000000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid,true);
select set_config('qorpera_test.path_sponsor',public.qorpera_create_member_execution_sponsor(
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true);
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

-- Reuse the canonical runner lifecycle for the completion continuation and
-- its second coding turn. Every call provisions a distinct decision runner.
create function pg_temp.coding_fixture_start(p_run uuid,p_coding_request uuid default null,p_token uuid default null)
returns jsonb language plpgsql as $$
declare claim jsonb; runner jsonb; assignment jsonb; lease jsonb;
begin
 if p_coding_request is null then
  claim:=public.qorpera_claim_runner_job_for_orchestrator('29000000-0000-4000-8000-000000000092',extensions.gen_random_uuid(),120);
 else
  claim:=public.qorpera_claim_coding_execution(p_coding_request,p_token,'29000000-0000-4000-8000-000000000092',extensions.gen_random_uuid());
 end if;
 if claim#>>'{work,run_id}' is distinct from p_run::text then raise exception 'Wrong continuation runner claim: %',claim; end if;
 runner:=public.qorpera_provision_execution_runner(p_run,extensions.gen_random_uuid(),'process',repeat('4',64));
 perform public.qorpera_activate_runner((runner->>'runner_id')::uuid,repeat('4',64),repeat('5',64),'linux','coding-followup-fixture');
 assignment:=public.qorpera_assign_runner_job('29000000-0000-4000-8000-000000000092',(claim->>'claim_id')::uuid,
  (runner->>'runner_id')::uuid,extensions.gen_random_uuid(),repeat('6',64),120);
 perform public.qorpera_accept_runner_assignment((runner->>'runner_id')::uuid,repeat('5',64),(assignment->>'assignment_id')::uuid,
  (claim#>>'{work,job_id}')::uuid,repeat('6',64));
 lease:=public.qorpera_acquire_native_provider_connection_lease(p_run,(runner->>'runner_id')::uuid,repeat('5',64),
  (assignment->>'assignment_id')::uuid,repeat('6',64),120);
 return jsonb_build_object('claim',claim,'binding',jsonb_build_object('leaseId',lease->>'lease_id','runId',p_run,
  'jobId',claim#>>'{work,job_id}','runnerId',runner->>'runner_id','assignmentId',assignment->>'assignment_id',
  'credentialCapsuleId',lease->>'credential_capsule_id','computeIdentityId',lease->>'compute_identity_id',
  'provider','openai','nativeHarness','codex-cli','model','gpt-native'));
end $$;

-- A real child agent wake, model reservation, runner assignment and native lease.
do $$
declare b jsonb:=current_setting('qorpera_test.path_binding')::jsonb; cb jsonb;
 env uuid:='29000000-0000-4000-8000-000000000020'; agent uuid:='29000000-0000-4000-8000-000000000030';
 repo jsonb:='{"host":"github.com","owner":"Qorpera","name":"platform","baseBranch":"main"}';
 vm uuid:='37200000-0000-4000-8000-000000000001'; worker uuid; request uuid; token uuid;
 d jsonb; w jsonb; q jsonb; admission jsonb; descriptor jsonb; sent jsonb; result jsonb;
 claim jsonb; runner jsonb; assignment jsonb; lease jsonb; authority jsonb; catalog text; finish jsonb;
 second_parent jsonb; second_fixture jsonb; second_binding jsonb; second_scope jsonb; second_q jsonb; second_descriptor jsonb;
 event_id uuid; continuation_run uuid; second_request uuid; second_token uuid; allocation_count bigint;
 plan jsonb; nas jsonb; storage jsonb; storage_root text; plan_text text; machine jsonb; scope jsonb; cmd uuid:='37200000-0000-4000-8000-000000000088';
begin
 set local role service_role;
 perform public.qorpera_send_native_agent_message((b->>'leaseId')::uuid,(b->>'runId')::uuid,(b->>'jobId')::uuid,
  (b->>'runnerId')::uuid,(b->>'assignmentId')::uuid,(b->>'credentialCapsuleId')::uuid,(b->>'computeIdentityId')::uuid,
  'openai','codex-cli','ack','I will delegate the code change.','progress');
 perform pg_temp.path_begin(b);
 perform pg_temp.path_commit(pg_temp.path_plan('coding-todo','note.md',pg_temp.path_stage_file('note.md','Durable coding todo')));
 perform public.qorpera_configure_coding_executor(env,'native-coding-fixture',true);
 perform public.qorpera_bind_coding_executor_orchestrator(env,'native-coding-fixture','29000000-0000-4000-8000-000000000092');
 perform public.qorpera_set_coding_repository_grant(env,agent,repo,true);
 d:=jsonb_build_object('operationKey','native-dispatch','repository',repo,'goal','Implement a bounded fix',
  'definitionOfDone','Tests pass and a draft PR exists','context','Explicit task context','sourceReadIds','[]'::jsonb,
  'todoPath','note.md','cancellationPolicy','retain-workspace','completionPolicy','notify-parent','publication','draft-pr');
 w:=public.qorpera_dispatch_coding_worker(b,d); worker:=(w->>'id')::uuid;
 -- Cancelling before any physical admission must finish from explicit SQL
 -- absence proof, never an arbitrary LXD missing-instance observation.
 declare cancel_claim jsonb; current_worker jsonb; absent jsonb;
 begin
  perform public.qorpera_cancel_coding_worker(b,worker,(w->>'version')::bigint,'cancel-before-provision');
  cancel_claim:=public.qorpera_claim_coding_request('native-coding-fixture',300);
  absent:=public.qorpera_describe_coding_cleanup((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid,
   'native-coding-fixture',repeat('c',64));
  if absent is distinct from jsonb_build_object('schema','qorpera.coding-cleanup-absent/v1','requestId',cancel_claim->>'requestId','workerId',worker,'allocationId',null) then
   raise exception 'Pre-provision cancellation lacked exact absence proof: %',absent; end if;
  begin
   -- Explicit corruption/partial-intent fault injection, not fake authority.
   reset role;
   insert into public.qorpera_coding_vm_plans(worker_id,allocation_id,binding,instance_sha256)
    values(worker,'37400000-0000-4000-8000-000000000021','{}',repeat('a',64));
   set local role service_role;
   begin perform public.qorpera_describe_coding_cleanup((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid,
    'native-coding-fixture',repeat('c',64));
    raise exception 'Partial VM intent reported absent'; exception when insufficient_privilege then null; end;
   raise exception using errcode='P3744';
  exception when sqlstate 'P3744' then null; end;
  current_worker:=public.qorpera_describe_coding_cancellation((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid);
  current_worker:=public.qorpera_complete_coding_request((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid,
   (current_worker->>'version')::bigint,'cancelled','{"summary":"Cancelled before repository VM admission"}');
  if current_worker->>'state'<>'cancelled' or current_worker->'vmId'<>'null'::jsonb then raise exception 'Pre-provision cancellation failed'; end if;
  raise exception using errcode='P3743',message='rollback pre-provision cancel';
 exception when sqlstate 'P3743' then null; end;
 q:=public.qorpera_claim_coding_request('native-coding-fixture',300); request:=(q->>'requestId')::uuid; token:=(q->>'leaseToken')::uuid;
 begin perform public.qorpera_describe_coding_cleanup(request,token,'native-coding-fixture',repeat('c',64));
  raise exception 'Ordinary dispatch claimed pre-provision stop'; exception when insufficient_privilege then null; end;
 admission:=public.qorpera_prepare_coding_execution(request,token);
 if public.qorpera_prepare_coding_execution(request,token)<>admission then raise exception 'Admission replay differs'; end if;
 sent:=public.qorpera_send_native_agent_message((b->>'leaseId')::uuid,(b->>'runId')::uuid,(b->>'jobId')::uuid,
  (b->>'runnerId')::uuid,(b->>'assignmentId')::uuid,(b->>'credentialCapsuleId')::uuid,(b->>'computeIdentityId')::uuid,
  'openai','codex-cli','final','The coding work is durably delegated.','final');
 result:=jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
  'native_lease_id',b->>'leaseId','substrate_version_id','29000000-0000-4000-8000-000000000025','output_count',0,'output_bytes',0,'publication',null,
  'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',b->>'runId','message_count',2,'final_message_id',sent->>'messageId','provider_session_id','coding-parent'),
  'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb);
 perform public.qorpera_complete_runner_job_v6((b->>'runnerId')::uuid,repeat('2',64),(b->>'jobId')::uuid,repeat('3',64),
  '29000000-0000-4000-8000-000000000096','29000000-0000-4000-8000-000000000097',null,result);
 perform public.qorpera_materialize_wake_execution_runs(32);
 descriptor:=public.qorpera_describe_coding_execution(request,token);
 if descriptor->>'runId' is null or descriptor->>'runId'=b->>'runId' or descriptor->>'jobId'=b->>'jobId' then
  raise exception 'Coding did not acquire a distinct run: %',descriptor; end if;
 authority:=public.qorpera_runtime_wake_policy((descriptor->>'runId')::uuid);
 if authority->>'kind'<>'agent' or authority->>'initial'<>'forbidden' or authority->>'final'<>'forbidden' or authority->>'maxPublicSends'<>'0' then raise exception 'Coding inherited human mouth: %',authority; end if;
 if public.qorpera_claim_runner_job_for_orchestrator('29000000-0000-4000-8000-000000000092','37200000-0000-4000-8000-000000000002',120) is distinct from 'null'::jsonb then
  raise exception 'Generic orchestrator stole coding execution'; end if;
 claim:=public.qorpera_claim_coding_execution(request,token,'29000000-0000-4000-8000-000000000092','37200000-0000-4000-8000-000000000003');
 if claim#>>'{work,run_id}'<>descriptor->>'runId' then raise exception 'Wrong coding job'; end if;
 runner:=public.qorpera_provision_execution_runner((descriptor->>'runId')::uuid,'37200000-0000-4000-8000-000000000005','process',repeat('4',64));
 plan:=jsonb_build_object('providerId','coding-fixture','providerPolicySha256',repeat('f',64),'project','coding','imageFingerprint',repeat('a',64),
  'bootstrapSha256',repeat('b',64),'storagePool','coding','network','coding','cpus',2,'memoryBytes',2147483648,'rootDiskBytes',4294967296);
 nas:=jsonb_build_object('schema','qorpera.coding-nas-policy/v1','mountPoint','/srv/coding','rootPath','/srv/coding/executor',
  'source','192.168.1.40:/coding','serverAddress','192.168.1.40');
 storage_root:='/srv/coding/executor/workers/29000000-0000-4000-8000-000000000010/'||env::text||'/'||worker::text;
 storage:=jsonb_build_object('schema','qorpera.coding-storage/v1','volumeId',worker,'workerId',worker,
  'companyId','29000000-0000-4000-8000-000000000010','environmentId',env,'writerGeneration',1,'machineIdSha256',repeat('c',64),
  'policy',nas,'dataSource',storage_root||'/data','custodySource',storage_root||'/guest-state',
  'dataTarget','/workspace','custodyTarget','/var/lib/qorpera-coding');
 plan_text:=(plan||jsonb_build_object('storage',storage,'schema','qorpera.lxd-coding-vm/v2','workerId',worker,'allocationId',vm,'companyId',
  '29000000-0000-4000-8000-000000000010','environmentId',env,'repository',repo))::text;
 begin perform public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run');
  raise exception 'Missing coding deployment policy admitted'; exception when insufficient_privilege then null; end;
 perform public.qorpera_configure_coding_vm_policy(env,'native-coding-fixture',plan);
 begin perform public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run');
  raise exception 'Missing NAS policy admitted'; exception when insufficient_privilege then null; end;
 perform public.qorpera_configure_coding_nas_policy(env,'native-coding-fixture',repeat('c',64),nas);
 machine:=public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run');
 if machine->>'reason'<>'NODE_PROVIDER_UNCONFIGURED' then raise exception 'Missing coding node admitted: %',machine; end if;
 w:=jsonb_set(w,'{version}',to_jsonb((w->>'version')::bigint+1));
 perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
  'nodeId','37200000-0000-4000-8000-000000000010','machineIdSha256',repeat('c',64),'label','coding-fixture',
  'cpuMillis',6000,'memoryBytes',8589934592,'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,
  'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',true),0);
 perform public.qorpera_enroll_runtime_node_provider('37200000-0000-4000-8000-000000000010',repeat('c',64),'coding','coding-fixture',repeat('f',64),2000,2147483648);
 machine:=public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run');
 if machine->>'reason'<>'NODE_OBSERVATION_UNAVAILABLE' then raise exception 'Missing coding node observation admitted'; end if;
 perform public.qorpera_observe_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
  'nodeId','37200000-0000-4000-8000-000000000010','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'));
 machine:=public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run');
 begin perform public.qorpera_configure_coding_nas_policy(env,'native-coding-fixture',repeat('d',64),nas);
  raise exception 'NAS writer host replaced without physical fence'; exception when sqlstate '55000' then null; end;
 begin perform public.qorpera_authorize_coding_machine(request,token,jsonb_set(plan_text::jsonb,'{storage,writerGeneration}','2')::text,repeat('c',64),'run');
  raise exception 'NAS generation replaced by queue lease'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('d',64),'run');
  raise exception 'Foreign host acquired NAS writer'; exception when insufficient_privilege then null; end;
 if has_function_privilege('service_role','public.qorpera_assert_coding_storage(uuid,text,jsonb,text)','EXECUTE')
  or has_table_privilege('service_role','public.qorpera_coding_storage_volumes','INSERT,UPDATE,DELETE') then
  raise exception 'NAS authority bypass exposed'; end if;
 if machine->>'schema'<>'qorpera.coding-vm-admission/v1' or machine->>'allocationId'<>vm::text then raise exception 'Coding VM receipt unavailable: %',machine; end if;
 begin perform public.qorpera_authorize_coding_machine(request,token,(plan_text::jsonb||jsonb_build_object('network','drift'))::text,repeat('c',64),'run');
  raise exception 'Coding VM plan drift accepted'; exception when insufficient_privilege then null; end;
 if public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'stop')->>'intent'<>'stop' then raise exception 'Coding cleanup receipt unavailable'; end if;
 perform public.qorpera_activate_runner((runner->>'runner_id')::uuid,repeat('4',64),repeat('5',64),'linux','coding-fixture');
 assignment:=public.qorpera_assign_runner_job('29000000-0000-4000-8000-000000000092',(claim->>'claim_id')::uuid,
  (runner->>'runner_id')::uuid,'37200000-0000-4000-8000-000000000004',repeat('6',64),120);
 perform public.qorpera_accept_runner_assignment((runner->>'runner_id')::uuid,repeat('5',64),(assignment->>'assignment_id')::uuid,
  (claim#>>'{work,job_id}')::uuid,repeat('6',64));
 lease:=public.qorpera_acquire_native_provider_connection_lease((descriptor->>'runId')::uuid,(runner->>'runner_id')::uuid,repeat('5',64),
  (assignment->>'assignment_id')::uuid,repeat('6',64),120);
 cb:=jsonb_build_object('leaseId',lease->>'lease_id','runId',descriptor->>'runId','jobId',descriptor->>'jobId','runnerId',runner->>'runner_id',
  'assignmentId',assignment->>'assignment_id','credentialCapsuleId',lease->>'credential_capsule_id','computeIdentityId',lease->>'compute_identity_id',
  'provider','openai','nativeHarness','codex-cli','model','gpt-native');
 w:=public.qorpera_record_coding_progress(request,token,(w->>'version')::bigint,'provisioning',vm);
 w:=public.qorpera_record_coding_progress(request,token,(w->>'version')::bigint,'ready',vm);
 w:=public.qorpera_record_coding_progress(request,token,(w->>'version')::bigint,'running',vm);
 authority:=public.qorpera_resolve_native_coding_scope(cb);
 scope:=jsonb_build_object('requestId',request,'workerId',worker,'vmId',vm,'turn',1);
 if authority#>>'{coding,parentRunId}'<>b->>'runId' or authority#>>'{coding,goal}'<>d->>'goal' then raise exception 'Coding descriptor lost delegation'; end if;
 reset role;
 begin
  update public.qorpera_coding_requests set lease_until=clock_timestamp()+interval '10 seconds' where id=request;
  set local role service_role;
  if (public.qorpera_authorize_native_coding_execution(cb,request,worker,vm,1)->>'validForMs')::integer>10000 then
   raise exception 'Native authority outlived coding queue lease'; end if;
  raise exception using errcode='P3722';
 exception when sqlstate 'P3722' then null; end;
 set local role service_role;

 begin perform public.qorpera_authorize_native_coding_execution(cb,request,worker,'37200000-0000-4000-8000-000000000099',1);
  raise exception 'Unallocated VM accepted'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_send_native_agent_message((cb->>'leaseId')::uuid,(cb->>'runId')::uuid,(cb->>'jobId')::uuid,
  (cb->>'runnerId')::uuid,(cb->>'assignmentId')::uuid,(cb->>'credentialCapsuleId')::uuid,(cb->>'computeIdentityId')::uuid,
  'openai','codex-cli','bad-mouth','Coding must not speak to the human.','progress');
  raise exception 'Coding run acquired mouth'; exception when insufficient_privilege then null; end;
 select jsonb_build_object('type','namespace','name','qorpera','description','Coding tools','tools',jsonb_agg(jsonb_build_object(
  'type','function','name',name,'description','Bounded coding action','inputSchema',jsonb_build_object('type','object','additionalProperties',false))))::text into catalog
  from unnest(array['coding_run_command','coding_read_command','coding_cancel_command','coding_finish']) name;
 perform public.qorpera_begin_native_coding_execution(cb,request,worker,vm,1,current_setting('qorpera_test.runtime_native_sha'),
  authority#>>'{identity,runtimeBundleSha256}',authority#>>'{identity,reasoningPolicySha256}',catalog,repeat('b',64),10);
 perform public.qorpera_record_coding_context_view(cb,request,worker,vm,1,
  '{"schema":"qorpera.native-context-view/v1","requestId":"coding-prewarm","threadId":"coding-thread","turnId":null,"purpose":"prewarm","outputs":[]}');
 perform public.qorpera_begin_native_tool_operation(cb,cmd,'coding_run_command:command',repeat('d',64),repeat('d',64),false);
 authority:=public.qorpera_authorize_coding_command(cb,scope,'start',cmd,repeat('d',64));
 if authority->>'inputSha256'<>repeat('d',64) or authority->>'operationKey'<>'command'
  or authority#>>'{authority,coding,workerId}'<>worker::text then raise exception 'Command receipt provenance missing'; end if;
 begin perform public.qorpera_authorize_coding_command(cb,scope,'start',cmd,repeat('e',64));
  raise exception 'Command digest mismatch accepted'; exception when insufficient_privilege then null; end;
 perform public.qorpera_complete_native_tool_operation(cb,cmd,repeat('d',64),'{"summary":"Protected guest fixture command completed"}');
 perform public.qorpera_authorize_coding_command(cb,scope,'read',cmd,null);
 finish:=public.qorpera_finish_native_coding_execution(cb,request,worker,vm,1,jsonb_build_object('operationKey','finish','summary','Ready for trusted publication','headSha',repeat('a',40)));
 if public.qorpera_finish_native_coding_execution(cb,request,worker,vm,1,jsonb_build_object('operationKey','finish','summary','Ready for trusted publication','headSha',repeat('a',40)))<>finish then raise exception 'Finish replay changed'; end if;
 begin perform public.qorpera_authorize_coding_command(cb,scope,'start',cmd,repeat('d',64));
  raise exception 'Command started after durable finish'; exception when insufficient_privilege then null; end;
 perform public.qorpera_authorize_coding_command(cb,scope,'cancel',cmd,null);
 if public.qorpera_describe_coding_execution(request,token)->'finish'<>finish then raise exception 'Finish not durable'; end if;
 if public.qorpera_authorize_native_coding_execution(cb,request,worker,vm,1)#>'{coding,finish}'<>finish then raise exception 'Postfinish effect authority omitted finish'; end if;
 begin perform public.qorpera_finish_native_coding_execution(cb,request,worker,vm,1,jsonb_build_object('operationKey','finish','summary','Changed','headSha',repeat('a',40)));
  raise exception 'Conflicting finish accepted'; exception when unique_violation then null; end;
 begin
  perform public.qorpera_set_coding_repository_grant(env,agent,repo,false);
  begin perform public.qorpera_authorize_native_coding_execution(cb,request,worker,vm,1);
   raise exception 'Revoked coding authority survived'; exception when insufficient_privilege then null; end;
  raise exception using errcode='P3721';
 exception when sqlstate 'P3721' then null; end;
 result:=result||jsonb_build_object('native_lease_id',cb->>'leaseId','substrate_version_id',claim#>>'{work,substrate_version_id}',
  'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',cb->>'runId','message_count',0,
   'final_message_id',null,'provider_session_id','coding-child'));
 perform public.qorpera_complete_runner_job_v6((cb->>'runnerId')::uuid,repeat('5',64),(cb->>'jobId')::uuid,repeat('6',64),
  '37200000-0000-4000-8000-000000000096','37200000-0000-4000-8000-000000000097',null,result);
 if public.qorpera_describe_coding_execution(request,token)->'finish'<>finish then raise exception 'Native completion lost durable finish'; end if;
 if public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run')->>'allocationId'<>vm::text then
  raise exception 'Settled native reservation blocked trusted publication'; end if;
 w:=public.qorpera_complete_coding_request(request,token,(w->>'version')::bigint,'completed',
  '{"summary":"Trusted verifier found no repository change","noChange":true}');
 if w->>'state'<>'completed' or w->>'vmId'<>vm::text then raise exception 'Worker completion lost retained VM'; end if;
 -- A confirmed completion resumes the company parent, which can steer the same
 -- durable repository into a second native turn with a new credential lease.
 reset role;
 select id into strict event_id from public.qorpera_coding_completions where request_id=request;
 select count(*) into allocation_count from public.qorpera_runtime_machine_allocations where profile_id='29000000-0000-4000-8000-000000000010';
 set local role service_role;
 machine:=public.qorpera_deliver_coding_completion(event_id);
 if machine->>'status'<>'delivered' then raise exception 'First native completion did not resume parent: %',machine; end if;
 perform public.qorpera_materialize_wake_execution_runs(32);
 reset role;
 select run_id into strict continuation_run from public.qorpera_wake_occurrences where id=(machine->>'occurrenceId')::uuid;
 set local role service_role;
 if continuation_run is null then raise exception 'Completion continuation was not admitted'; end if;
 second_fixture:=pg_temp.coding_fixture_start(continuation_run); second_parent:=second_fixture->'binding';
 perform pg_temp.path_begin(second_parent);
 w:=public.qorpera_followup_coding_worker(second_parent,jsonb_build_object('operationKey','second-native-turn','workerId',worker,
  'expectedVersion',(w->>'version')::bigint,'goal','Apply the review feedback in the retained repository'));
 second_q:=public.qorpera_claim_coding_request('native-coding-fixture',300);
 second_request:=(second_q->>'requestId')::uuid; second_token:=(second_q->>'leaseToken')::uuid;
 perform public.qorpera_prepare_coding_execution(second_request,second_token);
 -- A still-live company parent can cancel while an older emergency stop is
 -- pending. Its separate cancellation custody reconciles, never redispatches.
 declare cancel_claim jsonb; current_worker jsonb; stop_receipt jsonb;
 begin
  perform public.qorpera_claim_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),plan_text,'37400000-0000-4000-8000-000000000011');
  perform public.qorpera_record_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000011','37400000-0000-4000-8000-000000000012','accepted');
  current_worker:=public.qorpera_read_coding_worker(second_parent,worker);
  perform public.qorpera_cancel_coding_worker(second_parent,worker,(current_worker->>'version')::bigint,'cancel-after-emergency');
  cancel_claim:=public.qorpera_claim_coding_request('native-coding-fixture',300);
  if cancel_claim->>'kind'<>'cancel' then raise exception 'Emergency cancellation did not acquire its own lease'; end if;
  stop_receipt:=public.qorpera_claim_coding_emergency_stop((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid,
   'native-coding-fixture',repeat('c',64),plan_text,'37400000-0000-4000-8000-000000000013');
  if stop_receipt->>'dispatch'<>'false' or stop_receipt->>'requestId'<>second_request::text
   or stop_receipt->>'claimId'<>'37400000-0000-4000-8000-000000000011'
   or stop_receipt->>'operationId'<>'37400000-0000-4000-8000-000000000012' then
   raise exception 'Cancellation took over emergency intent'; end if;
  perform public.qorpera_record_coding_emergency_stop((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid,
   'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000011','37400000-0000-4000-8000-000000000012','stopped');
  current_worker:=public.qorpera_describe_coding_cancellation((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid);
  if current_worker->>'id'<>worker::text then raise exception 'Cancellation snapshot changed worker'; end if;
  current_worker:=public.qorpera_complete_coding_request((cancel_claim->>'requestId')::uuid,(cancel_claim->>'leaseToken')::uuid,
   (current_worker->>'version')::bigint,'cancelled','{"summary":"Emergency operation confirmed stopped; retained workspace remains fenced"}');
  if current_worker->>'state'<>'cancelled' then raise exception 'Permanent fence prevented confirmed cancellation'; end if;
  reset role;
  if not exists(select 1 from public.qorpera_coding_emergency_stops where worker_id=worker and request_id=second_request and state='stopped')
   or not exists(select 1 from public.qorpera_runtime_machine_allocations where id=vm and released_at is null) then
   raise exception 'Cancellation removed emergency intent or retained capacity'; end if;
  set local role service_role;
  raise exception using errcode='P3742',message='rollback emergency cancellation';
 exception when sqlstate 'P3742' then null; end;
 result:=result||jsonb_build_object('native_lease_id',second_parent->>'leaseId','substrate_version_id',second_fixture#>>'{claim,work,substrate_version_id}',
  'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',second_parent->>'runId',
   'message_count',0,'final_message_id',null,'provider_session_id','coding-continuation-parent'));
 perform public.qorpera_complete_runner_job_v6((second_parent->>'runnerId')::uuid,repeat('5',64),(second_parent->>'jobId')::uuid,repeat('6',64),
  extensions.gen_random_uuid(),extensions.gen_random_uuid(),null,result);
 perform public.qorpera_materialize_wake_execution_runs(32);
 second_descriptor:=public.qorpera_describe_coding_execution(second_request,second_token);
 if second_descriptor->>'runId' is null or second_descriptor->>'runId'=descriptor->>'runId'
  or second_descriptor->>'parentRunId'<>second_parent->>'runId' or second_descriptor->>'vmId'<>vm::text
  or second_descriptor->>'turn'<>'2' then raise exception 'Second native admission rebound delegation: %',second_descriptor; end if;
 machine:=public.qorpera_authorize_coding_machine(second_request,second_token,plan_text,repeat('c',64),'run');
 if machine->>'allocationId'<>vm::text then raise exception 'Followup replaced retained allocation'; end if;
 reset role;
 if (select count(*) from public.qorpera_runtime_machine_allocations where profile_id='29000000-0000-4000-8000-000000000010')<>allocation_count
  or not exists(select 1 from public.qorpera_runtime_machine_allocations where id=vm and run_id=(descriptor->>'runId')::uuid
   and coding_worker_id=worker and runner_id is null and login_compute_identity_id is null) then
  raise exception 'Followup duplicated capacity or relabelled retained allocation'; end if;
 set local role service_role;
 begin perform public.qorpera_authorize_coding_cleanup(request,token,'native-coding-fixture',plan_text,repeat('c',64));
  raise exception 'Old cleanup interrupted new native turn'; exception when insufficient_privilege then null; end;
 second_fixture:=pg_temp.coding_fixture_start((second_descriptor->>'runId')::uuid,second_request,second_token);
 second_binding:=second_fixture->'binding';
 if second_binding->>'runnerId'=cb->>'runnerId' or second_binding->>'leaseId'=cb->>'leaseId' then raise exception 'Followup reused native identity lease'; end if;
 w:=public.qorpera_record_coding_progress(second_request,second_token,(w->>'version')::bigint,'running',vm);
 authority:=public.qorpera_resolve_native_coding_scope(second_binding);
 if authority#>>'{coding,parentRunId}'<>second_parent->>'runId' or authority#>>'{coding,goal}'<>'Apply the review feedback in the retained repository'
  or authority#>>'{coding,vmId}'<>vm::text or w->>'parentRunId'<>b->>'runId' then raise exception 'Followup scope lost current or original parent'; end if;
 perform public.qorpera_begin_native_coding_execution(second_binding,second_request,worker,vm,2,current_setting('qorpera_test.runtime_native_sha'),
  authority#>>'{identity,runtimeBundleSha256}',authority#>>'{identity,reasoningPolicySha256}',catalog,repeat('b',64),10);
 second_scope:=jsonb_build_object('requestId',second_request,'workerId',worker,'vmId',vm,'turn',2);
 perform public.qorpera_authorize_coding_command(second_binding,second_scope,'read',cmd,null);

 -- Emergency NAS-independent cleanup is tested inside a rollback scope so the
 -- ordinary second-turn fixture still proves its successful path afterward.
 begin
  authority:=public.qorpera_describe_coding_cleanup(second_request,second_token,'native-coding-fixture',repeat('c',64));
  if authority->'binding' is distinct from plan_text::jsonb or authority#>>'{admission,allocationId}'<>vm::text then
   raise exception 'Emergency descriptor did not preserve original plan'; end if;
  begin perform public.qorpera_describe_coding_cleanup(second_request,extensions.gen_random_uuid(),'native-coding-fixture',repeat('c',64));
   raise exception 'Wrong token described cleanup'; exception when insufficient_privilege then null; end;
  begin perform public.qorpera_describe_coding_cleanup(second_request,second_token,'other-owner',repeat('c',64));
   raise exception 'Wrong owner described cleanup'; exception when insufficient_privilege then null; end;
  begin perform public.qorpera_describe_coding_cleanup(second_request,second_token,'native-coding-fixture',repeat('d',64));
   raise exception 'Wrong machine described cleanup'; exception when insufficient_privilege then null; end;
  begin perform public.qorpera_describe_coding_cleanup(request,token,'native-coding-fixture',repeat('c',64));
   raise exception 'Old request interrupted newer native turn'; exception when insufficient_privilege then null; end;
  machine:=public.qorpera_claim_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),plan_text,'37400000-0000-4000-8000-000000000001');
  if machine->>'dispatch'<>'true' or machine->>'state'<>'dispatching' then raise exception 'First emergency stop not claimed'; end if;
  authority:=public.qorpera_claim_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),plan_text,'37400000-0000-4000-8000-000000000001');
  if authority->>'dispatch'<>'false' then raise exception 'Same emergency claim replayed'; end if;
  authority:=public.qorpera_claim_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),plan_text,'37400000-0000-4000-8000-000000000002');
  if authority->>'dispatch'<>'false' or authority->>'claimId'<>'37400000-0000-4000-8000-000000000001' then raise exception 'Competing emergency claim won'; end if;
  begin perform public.qorpera_record_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000002',null,'recovery-required');
   raise exception 'Losing claimant wrote emergency journal'; exception when insufficient_privilege then null; end;
  begin perform public.qorpera_record_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000001','37400000-0000-4000-8000-000000000003','stopped');
   raise exception 'Unknown dispatch skipped acceptance custody'; exception when insufficient_privilege then null; end;
  begin perform public.qorpera_authorize_native_coding_execution(second_binding,second_request,worker,vm,2);
   raise exception 'Emergency fence allowed native coding'; exception when sqlstate '55000' then null; end;
  begin perform public.qorpera_authorize_coding_machine(second_request,second_token,plan_text,repeat('c',64),'run');
   raise exception 'Emergency fence resumed repository'; exception when sqlstate '55000' then null; end;
  begin perform public.qorpera_complete_coding_request(second_request,second_token,(w->>'version')::bigint,'completed','{"summary":"unconfirmed","noChange":true}');
   raise exception 'Emergency fence reported normal completion'; exception when sqlstate '55000' then null; end;
  perform public.qorpera_record_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000001','37400000-0000-4000-8000-000000000003','accepted');
  begin perform public.qorpera_record_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000001','37400000-0000-4000-8000-000000000004','accepted');
   raise exception 'Emergency operation rebound'; exception when insufficient_privilege then null; end;
  -- Trusted physical adapter reports an observed stop, never model output.
  authority:=public.qorpera_record_coding_emergency_stop(second_request,second_token,'native-coding-fixture',repeat('c',64),'37400000-0000-4000-8000-000000000001','37400000-0000-4000-8000-000000000003','stopped');
  if authority->>'state'<>'stopped' then raise exception 'Emergency stop not retained'; end if;
  begin perform public.qorpera_authorize_coding_machine(second_request,second_token,plan_text,repeat('c',64),'run');
   raise exception 'Physical stop implicitly allowed ordinary recovery'; exception when sqlstate '55000' then null; end;
  perform public.qorpera_set_coding_repository_grant(env,agent,repo,false);
  perform public.qorpera_configure_coding_executor(env,'native-coding-fixture',false);
  if public.qorpera_describe_coding_cleanup(second_request,second_token,'native-coding-fixture',repeat('c',64))#>>'{admission,intent}'<>'stop' then
   raise exception 'Revocation removed emergency cleanup custody'; end if;
  reset role;
  if not exists(select 1 from public.qorpera_runtime_machine_allocations where id=vm and released_at is null)
   or not exists(select 1 from public.qorpera_runtime_node_demands where allocation_id=vm and released_at is null)
   or not exists(select 1 from public.qorpera_coding_workers where id=worker and state='recovery-required') then
   raise exception 'Emergency stop released capacity or cleared recovery'; end if;
  set local role service_role;
  raise exception using errcode='P3741',message='rollback emergency probe';
 exception when sqlstate 'P3741' then null; end;
 perform public.qorpera_finish_native_coding_execution(second_binding,second_request,worker,vm,2,
  jsonb_build_object('operationKey','second-finish','summary','Second turn ready for trusted verification','headSha',repeat('b',40)));
 result:=result||jsonb_build_object('native_lease_id',second_binding->>'leaseId','substrate_version_id',second_fixture#>>'{claim,work,substrate_version_id}',
  'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',second_binding->>'runId',
   'message_count',0,'final_message_id',null,'provider_session_id','coding-child-second'));
 perform public.qorpera_complete_runner_job_v6((second_binding->>'runnerId')::uuid,repeat('5',64),(second_binding->>'jobId')::uuid,repeat('6',64),
  extensions.gen_random_uuid(),extensions.gen_random_uuid(),null,result);
 w:=public.qorpera_complete_coding_request(second_request,second_token,(w->>'version')::bigint,'completed',
  '{"summary":"Trusted verifier confirmed review needed no changes","noChange":true}');
 if w->>'turn'<>'2' or w->>'vmId'<>vm::text then raise exception 'Second turn did not retain workspace'; end if;

 perform public.qorpera_set_coding_repository_grant(env,agent,repo,false);
 perform public.qorpera_configure_coding_executor(env,'native-coding-fixture',false);
 if public.qorpera_authorize_coding_cleanup(request,token,'native-coding-fixture',plan_text,repeat('c',64))->>'intent'<>'stop' then
  raise exception 'Cleanup custody failed after completion and revocation'; end if;
 begin perform public.qorpera_authorize_coding_cleanup(request,extensions.gen_random_uuid(),'native-coding-fixture',plan_text,repeat('c',64));
  raise exception 'Wrong old token acquired cleanup custody'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_authorize_coding_cleanup(request,token,'different-owner',plan_text,repeat('c',64));
  raise exception 'Wrong owner acquired cleanup custody'; exception when insufficient_privilege then null; end;
 reset role;
 -- Expiry is an explicit fault injection; custody must still be stop-only.
 update public.qorpera_coding_requests set lease_until=clock_timestamp()-interval '1 second' where id=request;
 set local role service_role;
 if public.qorpera_authorize_coding_cleanup(request,token,'native-coding-fixture',plan_text,repeat('c',64))->>'intent'<>'stop' then
  raise exception 'Expired request lost cleanup custody'; end if;
 begin perform public.qorpera_authorize_coding_machine(request,token,plan_text,repeat('c',64),'run');
  raise exception 'Cleanup custody revived execution'; exception when insufficient_privilege then null; end;

end $$;
rollback;

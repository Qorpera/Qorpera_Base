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

do $$
<<coding>>
declare b jsonb:=current_setting('qorpera_test.path_binding')::jsonb;
	 env uuid:='29000000-0000-4000-8000-000000000020'; agent uuid:='29000000-0000-4000-8000-000000000030';
	 repo jsonb:='{"host":"github.com","owner":"Qorpera","name":"platform","baseBranch":"main"}';
	 d jsonb; w jsonb; original jsonb; q jsonb; read_result jsonb; followup jsonb; completed jsonb;
	 event_id uuid; latest_event_id uuid; delivery jsonb; result jsonb; sent jsonb; first_page jsonb; second_page jsonb;
	 wake public.qorpera_wake_occurrences%rowtype;
	 worker_id uuid; request_id uuid; token uuid; vm uuid:='37100000-0000-4000-8000-000000000001'; v_version bigint;
begin
	set local role service_role;
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','coding-ack','I am preparing the coding worker.','progress');
	perform pg_temp.path_begin(b);
	perform pg_temp.path_commit(pg_temp.path_plan('coding-todo','note.md',pg_temp.path_stage_file('note.md','Durable coding todo')));
	read_result:=public.qorpera_read_company_path_v2(env,'note.md',0,8,b);
	perform public.qorpera_confirm_company_path_read(env,b,(read_result ->> 'readObservationId')::uuid,8,repeat('a',64));
	d:=jsonb_build_object('operationKey','coding-dispatch','repository',repo,'goal','Implement one bounded fix',
		'definitionOfDone','Tests pass and a draft PR exists','context','Explicit bounded context',
		'sourceReadIds',jsonb_build_array(read_result ->> 'readObservationId'),'todoPath','note.md',
		'cancellationPolicy','retain-workspace','completionPolicy','notify-parent','publication','draft-pr');
	begin perform public.qorpera_dispatch_coding_worker(b,d);
		raise exception 'Dispatch bypassed unprovisioned executor and repo grant'; exception when insufficient_privilege then null; end;
	perform public.qorpera_set_coding_repository_grant(env,agent,repo,true);
	begin perform public.qorpera_dispatch_coding_worker(b,d);
		raise exception 'Repository grant alone enabled coding execution'; exception when insufficient_privilege then null; end;
	perform public.qorpera_configure_coding_executor(env,'coding-fixture',true);
	begin perform public.qorpera_dispatch_coding_worker(b,d||'{"companyId":"37100000-0000-4000-8000-000000000002"}');
		raise exception 'Dispatch accepted spoofed company'; exception when invalid_parameter_value then null; end;
	begin perform public.qorpera_dispatch_coding_worker(b,d||'{"sourceReadIds":["37100000-0000-4000-8000-000000000003"]}');
		raise exception 'Dispatch accepted unconfirmed source'; exception when insufficient_privilege then null; end;
	w:=public.qorpera_dispatch_coding_worker(b,d); original:=w; worker_id:=(w ->> 'id')::uuid;
	if public.qorpera_dispatch_coding_worker(b,d)<>w then raise exception 'Dispatch replay changed'; end if;
	begin perform public.qorpera_dispatch_coding_worker(b,d||'{"goal":"Different work"}');
		raise exception 'Dispatch key accepted different work'; exception when unique_violation then null; end;
	if public.qorpera_read_coding_worker(b,worker_id)<>w then raise exception 'Worker read differs'; end if;
	q:=public.qorpera_claim_coding_request('coding-fixture'); request_id:=(q ->> 'requestId')::uuid; token:=(q ->> 'leaseToken')::uuid;
	if q ->> 'kind'<>'dispatch' or q -> 'worker'<>w then raise exception 'Wrong coding request claimed'; end if;
	if public.qorpera_claim_coding_request('coding-fixture') is not null then raise exception 'Duplicate coding claim'; end if;
	reset role;
	begin
		update public.qorpera_coding_requests request set lease_until=clock_timestamp()-interval '1 second' where request.id=coding.request_id;
		set local role service_role;
		if public.qorpera_claim_coding_request('coding-fixture') is not null then raise exception 'Expired coding operation replayed'; end if;
		reset role;
		if not exists(select 1 from public.qorpera_coding_workers worker where worker.id=coding.worker_id and state='recovery-required')
			or not exists(select 1 from public.qorpera_coding_completions event where event.request_id=coding.request_id and payload ->> 'reason'='executor-lease-expired') then
			raise exception 'Expired coding claim lost its recovery event'; end if;
		raise exception using errcode='QCD01';
	exception when sqlstate 'QCD01' then null; end;
	set local role service_role;
	perform public.qorpera_heartbeat_coding_request(request_id,token);
	w:=public.qorpera_record_coding_progress(request_id,token,(w ->> 'version')::bigint,'provisioning',vm);
	w:=public.qorpera_record_coding_progress(request_id,token,(w ->> 'version')::bigint,'ready',vm);
	v_version:=(w ->> 'version')::bigint;
	w:=public.qorpera_record_coding_progress(request_id,token,v_version,'running',vm);
	if public.qorpera_record_coding_progress(request_id,token,v_version,'running',vm)<>w then raise exception 'Progress retry changed'; end if;
	begin perform public.qorpera_complete_coding_request(request_id,token,(w ->> 'version')::bigint,'completed','{"summary":"Done"}');
		raise exception 'Completion claimed unverified publication'; exception when invalid_parameter_value then null; end;
	v_version:=(w ->> 'version')::bigint;
	w:=public.qorpera_complete_coding_request(request_id,token,v_version,'completed','{"summary":"No change needed","noChange":true}'); completed:=w;
	if public.qorpera_complete_coding_request(request_id,token,v_version,'completed','{"summary":"No change needed","noChange":true}')<>w then
		raise exception 'Completion retry changed'; end if;
	begin perform public.qorpera_complete_coding_request(request_id,token,v_version,'completed','{"summary":"Different result","noChange":true}');
		raise exception 'Completion replay accepted different result'; exception when unique_violation then null; end;
	reset role;
	if (select count(*) from public.qorpera_coding_completions event where event.request_id=coding.request_id) <> 1 then
		raise exception 'Coding completion lost durable listener event'; end if;
	if not exists(select 1 from public.qorpera_coding_requests cr join public.qorpera_run_operation_receipts receipt on receipt.id=cr.receipt_id
		where cr.worker_id=coding.worker_id and receipt.status='completed') then raise exception 'Coding dispatch lost operation receipt'; end if;
	select id into event_id from public.qorpera_coding_completions event where event.request_id=coding.request_id;
	set local role service_role;
	if public.qorpera_deliver_coding_completion(event_id) ->> 'status'<>'pending' then
		raise exception 'Coding completion woke a still-running parent'; end if;
	followup:=jsonb_build_object('operationKey','coding-followup','workerId',worker_id,'expectedVersion',(w ->> 'version')::bigint,'goal','Follow up on the same branch');
	begin perform public.qorpera_followup_coding_worker(b,followup||'{"expectedVersion":1}');
		raise exception 'Stale worker version accepted'; exception when serialization_failure then null; end;
	w:=public.qorpera_followup_coding_worker(b,followup);
	if w ->> 'id'<>original ->> 'id' or w ->> 'branch'<>original ->> 'branch' or w ->> 'vmId'<>vm::text or w ->> 'turn'<>'2' then
		raise exception 'Followup replaced worker, VM or branch'; end if;
	if public.qorpera_followup_coding_worker(b,followup)<>w then raise exception 'Followup replay changed'; end if;
	q:=public.qorpera_claim_coding_request('coding-fixture'); request_id:=(q ->> 'requestId')::uuid; token:=(q ->> 'leaseToken')::uuid;
	perform public.qorpera_set_coding_repository_grant(env,agent,repo,false);
	begin perform public.qorpera_heartbeat_coding_request(request_id,token);
		raise exception 'Revoked repository authority renewed'; exception when insufficient_privilege then null; end;
	-- Cleanup remains authorized by parent ownership after repository revocation.
	w:=public.qorpera_cancel_coding_worker(b,worker_id,(w ->> 'version')::bigint,'coding-cancel');
	begin perform public.qorpera_record_coding_progress(request_id,token,(w ->> 'version')::bigint,'running',vm);
		raise exception 'Cancelled claim retained authority'; exception when insufficient_privilege then null; end;
	q:=public.qorpera_claim_coding_request('coding-fixture');
	if q ->> 'kind'<>'cancel' then raise exception 'Cancellation was not durably claimed'; end if;
	w:=public.qorpera_complete_coding_request((q ->> 'requestId')::uuid,(q ->> 'leaseToken')::uuid,(w ->> 'version')::bigint,
		'cancelled','{"summary":"Executor confirmed stop; workspace retained"}');
	if w ->> 'state'<>'cancelled' or w ->> 'vmId'<>vm::text or w ->> 'branch'<>original ->> 'branch' then
		raise exception 'Cancellation lost retained workspace'; end if;
	perform public.qorpera_set_coding_repository_grant(env,agent,repo,true);
	reset role;
	select id into latest_event_id from public.qorpera_coding_completions event where event.request_id=(q ->> 'requestId')::uuid;
	set local role service_role;
	first_page:=public.qorpera_read_coding_completions('coding-fixture',1);
	second_page:=public.qorpera_read_coding_completions('coding-fixture',1);
	if jsonb_array_length(first_page)<>1 or jsonb_array_length(second_page)<>1 or first_page #>> '{0,id}'=second_page #>> '{0,id}' then
		raise exception 'Pending coding listener head starved later events'; end if;
	if public.qorpera_deliver_coding_completion((first_page #>> '{0,id}')::uuid) ->> 'status'<>'pending'
		or public.qorpera_deliver_coding_completion((second_page #>> '{0,id}')::uuid) ->> 'status'<>'pending' then
		raise exception 'Listener scan consumed an undeliverable completion'; end if;
	reset role;
	if (select count(*) from public.qorpera_coding_completions event where event.worker_id=coding.worker_id and delivery_state='pending')<>2 then
		raise exception 'Listener scan discarded pending completions'; end if;
	set local role service_role;
	begin
		perform public.qorpera_fail_runner_job((b ->> 'runnerId')::uuid,repeat('2',64),(b ->> 'jobId')::uuid,repeat('3',64),
			'coding-parent-fixture-failure',false);
		if public.qorpera_deliver_coding_completion(latest_event_id) ->> 'status'<>'cancelled' then
			raise exception 'Failed coding parent revived'; end if;
		raise exception using errcode='P3715',message='rollback failed-parent probe';
	exception when sqlstate 'P3715' then null; end;
	sent:=public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','coding-final','The coding worker is durably tracked and its workspace retained.','final');
	result:=jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
		'native_lease_id',b ->> 'leaseId','substrate_version_id','29000000-0000-4000-8000-000000000025',
		'output_count',0,'output_bytes',0,'publication',null,
		'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',b ->> 'runId',
			'message_count',2,'final_message_id',sent ->> 'messageId','provider_session_id','coding-native-fixture'),
		'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
			"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
				"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb);
	perform public.qorpera_complete_runner_job_v6((b ->> 'runnerId')::uuid,repeat('2',64),(b ->> 'jobId')::uuid,repeat('3',64),
		'29000000-0000-4000-8000-000000000096','29000000-0000-4000-8000-000000000097',null,result);
	-- The older completed turn was superseded by a real followup before parent
	-- completion; it cannot revive the parent with a stale worker snapshot.
	if public.qorpera_deliver_coding_completion(event_id) ->> 'status'<>'cancelled' then
		raise exception 'Stale coding turn woke its parent'; end if;
	reset role;
	select id into event_id from public.qorpera_coding_completions event where event.request_id=(q ->> 'requestId')::uuid;
	set local role service_role;
	begin
		perform public.qorpera_set_coding_repository_grant(env,agent,repo,false);
		if public.qorpera_deliver_coding_completion(event_id) ->> 'status'<>'cancelled' then
			raise exception 'Revoked repository admitted completion wake'; end if;
		raise exception using errcode='QCD02';
	exception when sqlstate 'QCD02' then null; end;
	delivery:=public.qorpera_deliver_coding_completion(event_id);
	if delivery ->> 'status'<>'delivered' or delivery ->> 'occurrenceId' is null then
		raise exception 'Coding completion did not create a parent wake: %',delivery; end if;
	if public.qorpera_deliver_coding_completion(event_id)<>delivery then raise exception 'Coding delivery retry changed'; end if;
	if public.qorpera_read_coding_completions('coding-fixture')<>'[]'::jsonb then raise exception 'Listener still exposes delivered or cancelled events'; end if;
	reset role;
	if (select count(*) from public.qorpera_wake_occurrences occurrence where occurrence.source_kind='coding-completion' and occurrence.source_id=event_id)<>1 then
		raise exception 'Coding completion created duplicate parent wakes'; end if;
	select * into strict wake from public.qorpera_wake_occurrences where id=(delivery ->> 'occurrenceId')::uuid;
	set local role service_role;
	perform public.qorpera_set_coding_repository_grant(env,agent,repo,false);
	reset role;
	if public.qorpera_wake_authorized(wake) then raise exception 'Coding wake retained revoked repository authority'; end if;
end $$;
rollback;

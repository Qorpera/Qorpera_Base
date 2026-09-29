-- Diagnostic regression setup reuses the real native admission and first
-- Company File mutation fixture from SQL290. No authority helper is replaced.
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
from public.qorpera_company_path_tree_cache where sha256 = current_setting('qorpera_test.path_tree')
	and profile_id = '29000000-0000-4000-8000-000000000010';
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '29000000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where sha256 = current_setting('qorpera_test.path_tree') and profile_id = '29000000-0000-4000-8000-000000000010';
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

-- Order 1 (contract section 17): the native adapter's typed usage signal is
-- recorded against the run's exact sponsor and connection version, notifies
-- the connection owner exactly once per open limit, and is replay-safe. Rate
-- limiting and outage are recorded without notifying. Only native host
-- authority with the run's current lease may record; only the addressed
-- member may read or acknowledge.
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_receipt jsonb; v_replay jsonb;
	v_connection uuid := (current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid;
begin
	v_receipt := public.qorpera_record_provider_usage_signal(v_binding,'usage_limit',clock_timestamp() + interval '2 hours');
	v_replay := public.qorpera_record_provider_usage_signal(v_binding,'usage_limit',null);
	if v_receipt ->> 'signalId' <> v_replay ->> 'signalId' or (v_replay ->> 'replayed')::boolean is not true
		or (v_receipt ->> 'replayed')::boolean is not false
		or (v_receipt ->> 'providerConnectionId')::uuid <> v_connection
		or (v_receipt ->> 'providerConnectionVersion')::bigint <> 1
		or v_receipt ->> 'resetsAt' is null
		or v_receipt -> 'notifiedUserIds' <> jsonb_build_array('29000000-0000-4000-8000-000000000001') then
		raise exception 'Usage-limit signal receipt is inexact'; end if;
	perform public.qorpera_record_provider_usage_signal(v_binding,'rate_limited',null);
	perform public.qorpera_record_provider_usage_signal(v_binding,'provider_outage',null);
	begin
		perform public.qorpera_record_provider_usage_signal(v_binding,'quota',null);
		raise exception 'Unknown usage signal kind accepted';
	exception when invalid_parameter_value then null; end;
	begin
		perform public.qorpera_record_provider_usage_signal(
			v_binding || '{"runId":"29000000-0000-4000-8000-0000000000ff"}'::jsonb,'usage_limit',null);
		raise exception 'Foreign run binding recorded a usage signal';
	exception when insufficient_privilege or no_data_found or invalid_parameter_value then null; end;
end
$$;
reset role;
-- Table assertions run as the test superuser: the API and service roles have
-- no direct access to the signal or notification tables.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_connection uuid := (current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid;
begin
	if (select count(*) from public.qorpera_provider_connection_usage_signals
			where run_id = (v_binding ->> 'runId')::uuid and provider_connection_id = v_connection
				and sponsor_binding_id = (current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid
				and sponsor_version = 1 and source = 'native_adapter') <> 3
		or (select count(*) from public.qorpera_member_notifications
			where profile_id = '29000000-0000-4000-8000-000000000010') <> 1
		or not exists (select 1 from public.qorpera_member_notifications notification
			where notification.user_id = '29000000-0000-4000-8000-000000000001'
				and notification.kind = 'provider_usage_limit' and notification.acknowledged_at is null
				and (notification.subject ->> 'connectionId')::uuid = v_connection
				and notification.subject ->> 'runId' = v_binding ->> 'runId'
				and notification.subject::text !~ 'token|capsule|secret|prompt') then
		raise exception 'Usage-limit signal did not notify the connection owner exactly once'; end if;
	perform set_config('qorpera_test.usage_notification',(select id::text from public.qorpera_member_notifications
		where profile_id = '29000000-0000-4000-8000-000000000010'),true);
end
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_list jsonb; v_acknowledged jsonb;
begin
	v_list := public.qorpera_list_member_notifications('29000000-0000-4000-8000-000000000010');
	if jsonb_array_length(v_list) <> 1 or v_list #>> '{0,kind}' <> 'provider_usage_limit'
		or v_list #>> '{0,subject,schema}' <> 'qorpera.member-notification.provider-usage-limit/v1'
		or v_list #>> '{0,notification_id}' <> current_setting('qorpera_test.usage_notification')
		or v_list #>> '{0,acknowledged_at}' is not null then
		raise exception 'Member did not receive the usage-limit notification'; end if;
	v_acknowledged := public.qorpera_acknowledge_member_notification(current_setting('qorpera_test.usage_notification')::uuid);
	if v_acknowledged ->> 'acknowledged_at' is null
		or (public.qorpera_list_member_notifications('29000000-0000-4000-8000-000000000010') #>> '{0,acknowledged_at}') is null then
		raise exception 'Acknowledgement was not durable'; end if;
	begin
		perform public.qorpera_record_provider_usage_signal(current_setting('qorpera_test.path_binding')::jsonb,'usage_limit',null);
		raise exception 'Non-service caller recorded a usage signal';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_list_member_notifications('29000000-0000-4000-8000-000000000010',0);
		raise exception 'Invalid notification limit accepted';
	exception when invalid_parameter_value then null; end;
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
	if jsonb_array_length(public.qorpera_list_member_notifications('29000000-0000-4000-8000-000000000010')) <> 0 then
		raise exception 'Another member read the connection owner notification'; end if;
	begin
		perform public.qorpera_acknowledge_member_notification(current_setting('qorpera_test.usage_notification')::uuid);
		raise exception 'Another member acknowledged the connection owner notification';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
-- The per-connection concurrency policy replaces the exclusive lease: the
-- global provider policy is uncapped by default (the schema maximum), and a
-- login still cannot consent to more than the global ceiling.
do $$
begin
	if (select max_native_concurrency from public.qorpera_provider_execution_policies
		where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli') <> 64 then
		raise exception 'Provider concurrency policy still enforces the exclusive lease'; end if;
end
$$;
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_table_privilege(v_role,'public.qorpera_provider_connection_usage_signals','SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role,'public.qorpera_member_notifications','SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Usage signal or notification table exposed to %',v_role; end if;
	end loop;
	if has_function_privilege('authenticated','public.qorpera_record_provider_usage_signal(jsonb,text,timestamptz)','EXECUTE')
		or not has_function_privilege('service_role','public.qorpera_record_provider_usage_signal(jsonb,text,timestamptz)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_list_member_notifications(uuid,integer)','EXECUTE')
		or not has_function_privilege('authenticated','public.qorpera_acknowledge_member_notification(uuid)','EXECUTE') then
		raise exception 'Usage signal authority is exposed or unavailable'; end if;
end
$$;

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
		and g.origin = 'default_agent_read' and g.permissions = array['read','write']::text[] and g.revoked_at is null
), true);
select pg_temp.path_claims('service_role');
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
		'openai','codex-cli','observation-progress','PRIVATE_TRANSCRIPT_FIXTURE_NOT_IN_DIAGNOSTICS','progress');
end
$$;
select set_config('qorpera_test.path_result',pg_temp.path_commit(current_setting('qorpera_test.path_note')::jsonb)::text,true);
reset role;

create function pg_temp.observation(p_attempt uuid default extensions.gen_random_uuid())
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',p_attempt,
		'parentAttemptId',null,'assignmentId',current_setting('qorpera_test.path_binding')::jsonb -> 'assignmentId',
		'phase','start','operation','company_write','logicalOperationSha256',repeat('7',64),
		'observedAt','2026-08-31T12:00:00.000Z','durationMs',null,'status','started','errorCategory',null,
		'receiptId',null,'readId',null,'inputBytes',null,'outputBytes',null,'inputTokens',null,'outputTokens',null,
		'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,'totalTokens',null)
$$;
create function pg_temp.reject_observation(p_event jsonb,p_code text default '22023')
returns void language plpgsql as $$
begin
	begin
		perform public.qorpera_record_runtime_observation((current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid,p_event);
		raise exception 'Invalid diagnostic accepted' using errcode='QTO01';
	exception when others then
		if sqlstate is distinct from p_code then raise; end if;
	end;
end
$$;

-- Operator RPCs are not a member, model, runner, or broker inspection surface.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_table_privilege(v_role,'public.qorpera_runtime_observations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
			or has_sequence_privilege(v_role,'public.qorpera_runtime_observations_id_seq','USAGE,SELECT,UPDATE') then
			raise exception 'Diagnostic table bypass exposed to %',v_role; end if;
		foreach v_function in array array['public.qorpera_runtime_observation_immutable()',
			'public.qorpera_operational_page(jsonb,integer)'] loop
			if has_function_privilege(v_role,v_function,'EXECUTE') then
				raise exception 'Private diagnostic helper exposed to %',v_role; end if;
		end loop;
		foreach v_function in array array['public.qorpera_record_runtime_observation(uuid,jsonb)',
			'public.qorpera_get_runtime_operational_run(uuid,integer)',
			'public.qorpera_get_company_operational_commands(uuid,integer)',
			'public.qorpera_purge_runtime_observations(integer)'] loop
			if has_function_privilege(v_role,v_function,'EXECUTE') is distinct from (v_role='service_role') then
				raise exception 'Diagnostic operator boundary is incorrect for %',v_role; end if;
		end loop;
	end loop;
end
$$;

set local role service_role;
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid; v_query jsonb;
begin
	v_query := public.qorpera_get_runtime_operational_run(v_run);
	if v_query #>> '{identity,runId}' <> v_run::text or v_query #>> '{canonicalJob,status}' <> 'leased'
		or v_query #> '{coverage,diagnosticsMissing}' <> 'true'::jsonb
		or v_query #>> '{coverage,ledgerCompleteness}' <> 'not_claimed_optional_delivery'
		or v_query #> '{coverage,emptyDoesNotMeanHealthy}' <> 'true'::jsonb
		or v_query #>> '{coverage,providerRequestTiming}' <> 'unavailable'
		or v_query #> '{sections,diagnostics,items}' <> '[]'::jsonb
		or v_query #> '{identity,physicalNodeId}' <> 'null'::jsonb
		or v_query #> '{nativeLaunch}' <> 'null'::jsonb
		or v_query #> '{sections,assignments,items,0,runnerVersion}' <> 'null'::jsonb
		or v_query #>> '{admissionRequest,requestId}' <> v_run::text
		or v_query #> '{admissionRequest,materializedAt}' = 'null'::jsonb
		or jsonb_array_length(v_query #> '{sections,operationReceipts,items}') <> 1
		or jsonb_array_length(v_query #> '{sections,revisions,items}') <> 1 then
		raise exception 'Missing diagnostics were fabricated or hid canonical work'; end if;
	perform set_config('qorpera_test.obs_initial_query',v_query::text,true);
end
$$;
reset role;

-- Real durable native admission, read confirmation, and canonical progress send.
set local role service_role;
select pg_temp.path_begin(current_setting('qorpera_test.path_binding')::jsonb);
select set_config('qorpera_test.obs_read',public.qorpera_read_company_path_v2(
	'29000000-0000-4000-8000-000000000020','note.md',0,8,current_setting('qorpera_test.path_binding')::jsonb)::text,true);
select public.qorpera_confirm_company_path_read('29000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.path_binding')::jsonb,(current_setting('qorpera_test.obs_read')::jsonb ->> 'readObservationId')::uuid,8,repeat('d',64));

reset role;
select set_config('qorpera_test.obs_canonical_before',jsonb_build_object(
	'events',(select count(*) from public.qorpera_execution_run_events),
	'receipts',(select count(*) from public.qorpera_run_operation_receipts),
	'revisions',(select count(*) from public.qorpera_company_path_revisions),
	'sends',(select count(*) from public.qorpera_agent_sends),
	'reads',(select count(*) from public.qorpera_company_read_observations))::text,true);

-- Start/finish are immutable independent events, including delivery out of order.
set local role service_role;
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_start jsonb := pg_temp.observation('32000000-0000-4000-8000-000000000001'); v_finish jsonb; v_first jsonb; v_replay jsonb; v_query jsonb;
begin
	v_start := v_start || jsonb_build_object('parentAttemptId','32000000-0000-4000-8000-000000000002');
	v_finish := v_start || jsonb_build_object('phase','finish','status','proposed','durationMs',27,
		'observedAt','2026-08-31T12:00:00.027Z','receiptId',current_setting('qorpera_test.path_result')::jsonb -> 'receiptId',
		'readId',current_setting('qorpera_test.obs_read')::jsonb -> 'readObservationId','inputBytes',0);
	v_first := public.qorpera_record_runtime_observation(v_run,v_finish);
	v_query := public.qorpera_get_runtime_operational_run(v_run);
	if v_query #> '{sections,diagnostics,items,0,startMissing}' <> 'true'::jsonb
		or v_query #> '{sections,diagnostics,items,0,finishMissing}' <> 'false'::jsonb
		or v_query #> '{sections,diagnostics,items,0,parentMissing}' <> 'true'::jsonb then
		raise exception 'Out-of-order or missing-parent diagnostic coverage was hidden'; end if;
	perform pg_temp.reject_observation(v_start || '{"operation":"company_read"}'::jsonb,'23505');
	perform pg_temp.reject_observation(v_start || '{"assignmentId":null}'::jsonb,'23505');
	perform pg_temp.reject_observation(v_start || '{"parentAttemptId":null}'::jsonb,'23505');
	perform pg_temp.reject_observation(v_start || '{"logicalOperationSha256":null}'::jsonb,'23505');
	v_replay := public.qorpera_record_runtime_observation(v_run,v_finish);
	if v_replay - 'replayed' <> v_first - 'replayed' or v_replay -> 'replayed' <> 'true'::jsonb then
		raise exception 'Exact event replay changed its immutable receipt'; end if;
	perform public.qorpera_record_runtime_observation(v_run,v_start);
	perform pg_temp.reject_observation(v_finish || '{"durationMs":28}'::jsonb,'23505');
	perform pg_temp.reject_observation(v_start || '{"operation":"company_read"}'::jsonb,'23505');
	v_query := public.qorpera_get_runtime_operational_run(v_run);
	if jsonb_array_length(v_query #> '{sections,diagnostics,items}') <> 2
		or v_query #> '{sections,diagnostics,items,0,startMissing}' <> 'false'::jsonb
		or v_query #> '{sections,diagnostics,items,0,finishMissing}' <> 'false'::jsonb
		or v_query #>> '{sections,diagnostics,items,0,assignmentRunnerId}' <> current_setting('qorpera_test.path_binding')::jsonb ->> 'runnerId'
		or v_query #>> '{canonicalJob,status}' <> 'leased'
		or v_query #>> '{sections,operationReceipts,items,0,status}' <> 'completed'
		or v_query #>> '{sections,diagnostics,items,1,event,status}' <> 'proposed'
		or v_query #> '{sections,diagnostics,items,1,event,inputBytes}' <> '0'::jsonb
		or v_query #> '{sections,diagnostics,items,1,event,inputTokens}' <> 'null'::jsonb
		or v_query #> '{sections,reads,items,0,confirmed}' <> 'true'::jsonb
		or v_query #>> '{sections,reads,items,0,includedBytes}' <> '8'
		or v_query #> '{sections,publicSends,items,0,canonicalEventMatched}' <> 'true'::jsonb
		or v_query #> '{sections,revisions,items,0,resourceId}' = 'null'::jsonb then
		raise exception 'Operator query conflated diagnostics and canonical outcomes or lost exact linkage'; end if;
	perform set_config('qorpera_test.obs_finish',v_finish::text,true);
end
$$;
reset role;

-- Validate the closed wire contract, including every required nullable key.
set local role service_role;
do $$
declare v_base jsonb := pg_temp.observation(); v_key text; v_value jsonb; v_time text;
begin
	for v_key in select jsonb_object_keys(v_base) loop perform pg_temp.reject_observation(v_base-v_key); end loop;
	perform pg_temp.reject_observation(null);
	perform pg_temp.reject_observation('[]'::jsonb);
	perform pg_temp.reject_observation(v_base || '{"path":"PRIVATE_PATH_NOT_ALLOWED"}');
	perform pg_temp.reject_observation(v_base || '{"error":"PRIVATE_ERROR_NOT_ALLOWED"}');
	perform pg_temp.reject_observation(v_base || jsonb_build_object('extra',repeat('x',8192)));
	foreach v_key in array array['durationMs','inputBytes','outputBytes','inputTokens','outputTokens',
		'cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] loop
		for v_value in select value from jsonb_array_elements('[-1,0.5,9007199254740992,"1",true,[],{}]'::jsonb) loop
			perform pg_temp.reject_observation(v_base || jsonb_build_object('phase','finish','status','failed',v_key,v_value));
		end loop;
	end loop;
	foreach v_key in array array['attemptId','parentAttemptId','assignmentId','receiptId','readId'] loop
		for v_value in select value from jsonb_array_elements('[1,true,[],{},"not-a-uuid","00000000-0000-0000-0000-000000000000"]'::jsonb) loop
			perform pg_temp.reject_observation(v_base || jsonb_build_object(v_key,v_value));
		end loop;
	end loop;
	perform pg_temp.reject_observation(v_base || '{"attemptId":null}');
	foreach v_key in array array['schema','operation','phase','status'] loop
		for v_value in select value from jsonb_array_elements('[1,true,[],{},null,"unexpected"]'::jsonb) loop
			perform pg_temp.reject_observation(v_base || jsonb_build_object(v_key,v_value));
		end loop;
	end loop;
	for v_value in select value from jsonb_array_elements('[1,true,[],{},"RAW_PROVIDER_MESSAGE"]'::jsonb) loop
		perform pg_temp.reject_observation(v_base || jsonb_build_object('phase','finish','status','failed','errorCategory',v_value));
	end loop;
	for v_value in select value from jsonb_array_elements('[1,true,[],{},"bad","AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]'::jsonb) loop
		perform pg_temp.reject_observation(v_base || jsonb_build_object('logicalOperationSha256',v_value));
	end loop;
	foreach v_time in array array['infinity','2026-02-30T00:00:00.000Z','2026-08-31','2026-08-31T12:00:00Z',
		'2026-08-31T12:00:00.000+00:00','2026-08-31T24:00:00.000Z','0000-01-01T00:00:00.000Z',
		'2026-08-31T12:00:60.000Z','2026-13-01T00:00:00.000Z',''] loop
		perform pg_temp.reject_observation(v_base || jsonb_build_object('observedAt',v_time));
	end loop;
	perform pg_temp.reject_observation(v_base || '{"phase":"finish","status":"started"}');
	perform pg_temp.reject_observation(v_base || '{"status":"failed"}');
	perform pg_temp.reject_observation(v_base || '{"durationMs":0}');
	perform pg_temp.reject_observation(v_base || '{"errorCategory":"unknown"}');
	foreach v_key in array array['assignmentId','receiptId','readId'] loop
		perform pg_temp.reject_observation(v_base || jsonb_build_object(v_key,extensions.gen_random_uuid()),'42501');
	end loop;
	begin
		perform public.qorpera_record_runtime_observation(extensions.gen_random_uuid(),v_base);
		raise exception 'Unadmitted run acquired diagnostics';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

-- Unknown remains null; every safe integer, nullable link, operation and terminal
-- category is supported. Thread-total updates are not summed into a billing row.
set local role service_role;
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_event jsonb; v_operation text; v_status text; v_category text; v_query jsonb;
begin
	foreach v_operation in array array['model_turn','model_request','company_read','company_list','company_write',
		'company_mkdir','company_delete','send_message','ask_member','read_context','send_coworker_message','computer_start','computer_screen',
		'computer_browser','computer_desktop','computer_shell','computer_screenshot','computer_transfer','hire_agent',
		'create_group_chat','manage_routine','decide_routine','report_work','manage_todo','manage_worker','company_context','message_composition',
		'connector','unknown_tool','run_authority',
		'context_authority','native_result_fence','diagnostic_export','action_review',
		'coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask',
		'update_memory','recall_memory','read_skill','search_skills','update_skill','organize_sidebar','add_review_rule','list_hooks','read_event'] loop
		v_event := pg_temp.observation() || jsonb_build_object('operation',v_operation,'assignmentId',null,
			'phase','finish','status','succeeded','logicalOperationSha256',null,'observedAt','0001-01-01T00:00:00.000Z',
			'durationMs',9007199254740991,'inputBytes',9007199254740991,'outputBytes',0,'inputTokens',0,'outputTokens',1,
			'cachedInputTokens',2,'cacheWriteInputTokens',3,'reasoningOutputTokens',4,'totalTokens',9007199254740991);
		perform public.qorpera_record_runtime_observation(v_run,v_event);
	end loop;
	foreach v_status in array array['succeeded','failed','cancelled','denied','unconfirmed','proposed','replayed'] loop
		perform public.qorpera_record_runtime_observation(v_run,pg_temp.observation() || jsonb_build_object('phase','finish','status',v_status));
	end loop;
	foreach v_category in array array['invalid_arguments','unavailable_tool','call_id_reused','budget_exhausted',
		'authority_unavailable','stale_version','protected_path','ambiguous_effect','cancelled','timeout','provider_failed',
		'transport_unavailable','invalid_response','unknown','export_unavailable'] loop
		perform public.qorpera_record_runtime_observation(v_run,pg_temp.observation() || jsonb_build_object('phase','finish',
			'status','failed','errorCategory',v_category,'operation','diagnostic_export'));
	end loop;
	-- Same logical work, separate transport attempts. Missing start is visible.
	perform public.qorpera_record_runtime_observation(v_run,pg_temp.observation() || '{"phase":"finish","status":"replayed"}');
	-- Future sender clock and reversed wall clocks must not rewrite duration/status.
	v_event := pg_temp.observation() || '{"observedAt":"9999-01-01T00:00:00.000Z"}';
	perform public.qorpera_record_runtime_observation(v_run,v_event);
	perform public.qorpera_record_runtime_observation(v_run,v_event || '{"phase":"finish","status":"unconfirmed","observedAt":"2026-08-31T12:00:00.000Z","durationMs":2}');
	v_query := public.qorpera_get_runtime_operational_run(v_run);
	if v_query #> '{sections,diagnostics,items,0,boundaryClockOrderConflict}' <> 'true'::jsonb
		or v_query #> '{sections,diagnostics,items,1,senderClockAhead}' <> 'true'::jsonb
		or v_query #> '{sections,diagnostics,items,0,anotherAttemptWithSameLogicalKey}' <> 'true'::jsonb
		or v_query #> '{coverage,diagnosticExportGapReported}' <> 'true'::jsonb then
		raise exception 'Clock gaps, retries, or failed optional export were hidden'; end if;
	if not exists(select 1 from jsonb_array_elements(v_query #> '{sections,diagnostics,items}') e
		where e #>> '{event,operation}'='model_turn'
			and e ->> 'counterSemantics'='latest_native_thread_totals_may_include_estimates_do_not_sum_or_bill'
			and e ->> 'timingSemantics'='logical_turn_including_tools_and_retries')
		or not exists(select 1 from jsonb_array_elements(v_query #> '{sections,diagnostics,items}') e
		where e #>> '{event,operation}'='native_result_fence'
			and e ->> 'timingSemantics'='pre_request_authorization_not_confirmed_delivery') then
		raise exception 'Model counter/timing semantics were misrepresented'; end if;
	v_query := public.qorpera_get_runtime_operational_run(v_run,1);
	if jsonb_array_length(v_query #> '{sections,diagnostics,items}') <> 1
		or v_query #> '{sections,diagnostics,truncated}' <> 'true'::jsonb then
		raise exception 'Diagnostic page bound or truncation flag was lost'; end if;
end
$$;
reset role;

-- Diagnostic writes did not append canonical run events, receipts or sends.
do $$
declare v_version text; v_query jsonb; b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	foreach v_version in array array[repeat('a',40),'1.2.3','12345.12345.12345-alpha.1',
		'PRIVATE_CONFIGURED_TEXT_NOT_RETURNED',repeat('z',64),'v1.2.3','1.2','1.2.3+private','999999.2.3'] loop
		begin
			update public.qorpera_runners set runner_version=v_version where id=(b ->> 'runnerId')::uuid;
			set local role service_role;
			v_query := public.qorpera_get_runtime_operational_run((b ->> 'runId')::uuid);
			reset role;
			if v_version in (repeat('a',40),'1.2.3','12345.12345.12345-alpha.1') then
				if v_query #>> '{sections,assignments,items,0,runnerVersion}' is distinct from v_version then
					raise exception 'Public build version was lost'; end if;
			elsif v_query #> '{sections,assignments,items,0,runnerVersion}' <> 'null'::jsonb then
				raise exception 'Arbitrary configured runner version was returned';
			end if;
			raise exception using errcode='QTO02';
		exception when sqlstate 'QTO02' then null; end;
	end loop;
end
$$;

do $$
declare v_now jsonb;
begin
	v_now := jsonb_build_object('events',(select count(*) from public.qorpera_execution_run_events),
		'receipts',(select count(*) from public.qorpera_run_operation_receipts),
		'revisions',(select count(*) from public.qorpera_company_path_revisions),
		'sends',(select count(*) from public.qorpera_agent_sends),
		'reads',(select count(*) from public.qorpera_company_read_observations));
	if v_now <> current_setting('qorpera_test.obs_canonical_before')::jsonb then
		raise exception 'Optional diagnostics changed canonical work'; end if;
	begin
		update public.qorpera_runtime_observations set observed_at=clock_timestamp();
		raise exception 'Diagnostic event could be rewritten';
	exception when insufficient_privilege then null; end;
end
$$;

-- A real successful completion remains distinct from optional diagnostic claims.
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_send jsonb; v_result jsonb; v_query jsonb;
begin
	set local role service_role;
	v_send := public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','observation-final','PRIVATE_FINAL_NOT_IN_DIAGNOSTICS','final');
	v_result := jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
		'native_lease_id',b ->> 'leaseId','substrate_version_id','29000000-0000-4000-8000-000000000025',
		'output_count',0,'output_bytes',0,'publication',null,
		'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',b ->> 'runId',
			'message_count',2,'final_message_id',v_send -> 'messageId','provider_session_id','observability-native-fixture'),
		'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
			"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
				"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb);
	perform public.qorpera_complete_runner_job_v6((b ->> 'runnerId')::uuid,repeat('2',64),(b ->> 'jobId')::uuid,repeat('3',64),
		'32000000-0000-4000-8000-000000000120','32000000-0000-4000-8000-000000000121',null,v_result);
	perform public.qorpera_record_runtime_observation((b ->> 'runId')::uuid,pg_temp.observation() || '{"phase":"finish","status":"unconfirmed"}');
	v_query := public.qorpera_get_runtime_operational_run((b ->> 'runId')::uuid);
	if v_query #>> '{canonicalJob,status}' <> 'completed'
		or v_query #>> '{canonicalResult,assignmentId}' <> b ->> 'assignmentId'
		or v_query #>> '{nativeLease,status}' <> 'released'
		or v_query #>> '{runnerUsage,executionMs}' <> '50'
		or v_query #>> '{runnerUsage,limitSemantics}' <> 'configured_capacity_not_measured_consumption'
		or v_query #>> '{sections,diagnostics,items,0,event,status}' <> 'unconfirmed'
		or v_query::text ~ 'PRIVATE_FINAL|observability-native-fixture' then
		raise exception 'Successful job was conflated with a diagnostic outcome, billing, or private result'; end if;
	raise exception using errcode='QTO02';
exception when sqlstate 'QTO02' then null;
end
$$;

-- Late diagnostics remain recordable after cancellation/failure, without
-- changing terminal status, releasing work, or reviving authority.
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_state text; v_before bigint; v_query jsonb;
begin
	foreach v_state in array array['failed','cancelled'] loop
		begin
			perform pg_temp.path_claims('service_role',case when v_state='cancelled' then '29000000-0000-4000-8000-000000000001'::uuid else null end);
			set local role service_role;
			perform public.qorpera_terminalize_runner_attempt((b ->> 'jobId')::uuid,v_state,'PRIVATE_FAILURE_NOT_IN_QUERY',false);
			reset role;
			select count(*) into v_before from public.qorpera_execution_run_events;
			set local role service_role;
			perform public.qorpera_record_runtime_observation((b ->> 'runId')::uuid,pg_temp.observation() || '{"phase":"finish","status":"succeeded"}');
			v_query := public.qorpera_get_runtime_operational_run((b ->> 'runId')::uuid);
			reset role;
			if v_query #>> '{canonicalJob,status}' <> v_state
				or (select count(*) from public.qorpera_execution_run_events) <> v_before
				or v_query::text like '%PRIVATE_FAILURE_NOT_IN_QUERY%' then
				raise exception 'Late diagnostic changed terminal work or exposed raw errors'; end if;
			raise exception using errcode='QTO02';
		exception when sqlstate 'QTO02' then null; end;
	end loop;
end
$$;

-- A privileged disposable fixture supplies old server-ingest rows, never
-- weakening the immutable update guard just to age a production record.
insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
	operation,logical_operation_sha256,observed_at,ingested_at,observation)
select (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid,
	('32000000-0000-4000-8000-00000000010' || n)::uuid,'start',null,null,'model_turn',null,
	clock_timestamp(),clock_timestamp()-interval '31 days',pg_temp.observation(('32000000-0000-4000-8000-00000000010' || n)::uuid)
		|| '{"operation":"model_turn","logicalOperationSha256":null,"assignmentId":null}'
from generate_series(1,2) n;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_result jsonb; v_before bigint;
	v_events bigint; v_receipts bigint; v_reads bigint; v_sends bigint;
begin
	set local role service_role;
	v_result := public.qorpera_purge_runtime_observations(1);
	reset role;
	if v_result ->> 'deleted' <> '0' then raise exception 'Retention pruned an active job'; end if;
	begin
		set local role service_role;
		perform public.qorpera_terminalize_runner_attempt((b ->> 'jobId')::uuid,'failed','Retention fixture',false);
		reset role;
		select count(*) into v_before from public.qorpera_runtime_observations;
		select count(*) into v_events from public.qorpera_execution_run_events;
		select count(*) into v_receipts from public.qorpera_run_operation_receipts;
		select count(*) into v_reads from public.qorpera_company_read_observations;
		select count(*) into v_sends from public.qorpera_agent_sends;
		set local role service_role;
		v_result := public.qorpera_purge_runtime_observations(1);
		if v_result ->> 'deleted' <> '1' or v_result -> 'moreEligible' <> 'true'::jsonb then
			raise exception 'Diagnostic purge exceeded its bound or hid remaining work'; end if;
		v_result := public.qorpera_purge_runtime_observations(1);
		if v_result ->> 'deleted' <> '1' or v_result -> 'moreEligible' <> 'false'::jsonb then
			raise exception 'Diagnostic purge did not converge'; end if;
		reset role;
		if (select count(*) from public.qorpera_runtime_observations) <> v_before-2
			or (select count(*) from public.qorpera_execution_run_events) <> v_events
			or (select count(*) from public.qorpera_run_operation_receipts) <> v_receipts
			or (select count(*) from public.qorpera_company_read_observations) <> v_reads
			or (select count(*) from public.qorpera_agent_sends) <> v_sends then
			raise exception 'Diagnostic retention touched canonical authority or fresh rows'; end if;
		raise exception using errcode='QTO02';
	exception when sqlstate 'QTO02' then null; end;
end
$$;

-- Canonical member commands have no invented run/model/sponsor. The applied
-- timestamp is the exact governed revision time, not elapsed execution time.
select set_config('qorpera_test.obs_member_plan',pg_temp.path_plan('PRIVATE_OPERATION_KEY_NOT_IN_QUERY','member-note.md',
	pg_temp.path_stage_file('member-note.md','PRIVATE_MEMBER_TEXT_NOT_IN_QUERY'))::text,true);
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.obs_command',public.qorpera_begin_member_company_path_command(
	'29000000-0000-4000-8000-000000000020',current_setting('qorpera_test.obs_member_plan')::jsonb)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_command jsonb := current_setting('qorpera_test.obs_command')::jsonb; v_prepared jsonb; v_tree text; v_query jsonb;
begin
	v_query := public.qorpera_get_company_operational_commands('29000000-0000-4000-8000-000000000010');
	if v_query #> '{commands,items,0,appliedAt}' <> 'null'::jsonb
		or v_query #> '{commands,items,0,runId}' <> 'null'::jsonb
		or v_query #> '{commands,items,0,sponsorUserId}' <> 'null'::jsonb then
		raise exception 'Pending member command acquired invented model/run/timing'; end if;
	v_prepared := public.qorpera_prepare_member_company_path_command((v_command ->> 'commandId')::uuid,v_command ->> 'planSha256');
	v_tree := pg_temp.path_stage_tree((v_prepared -> 'entries') || jsonb_build_array(current_setting('qorpera_test.obs_member_plan')::jsonb -> 'entry'));
	perform public.qorpera_apply_member_company_path_command((v_command ->> 'commandId')::uuid,v_command ->> 'planSha256',
		(v_prepared ->> 'snapshotId')::uuid,v_tree);
	v_query := public.qorpera_get_company_operational_commands('29000000-0000-4000-8000-000000000010');
	if v_query #>> '{commands,items,0,status}' <> 'applied' or v_query #> '{commands,items,0,revisionMatched}' <> 'true'::jsonb
		or v_query #> '{commands,items,0,appliedAt}' = 'null'::jsonb or v_query #> '{commands,items,0,applyDurationMs}' <> 'null'::jsonb
		or v_query #>> '{commands,items,0,actorUserId}' <> '29000000-0000-4000-8000-000000000001'
		or v_query #> '{commands,items,0,runtimeBundleId}' = 'null'::jsonb then
		raise exception 'Member result lost exact canonical revision linkage'; end if;
	if v_query::text ~ 'PRIVATE_OPERATION_KEY|PRIVATE_MEMBER_TEXT|member-note.md|planSha256|"plan"|"result"' then
		raise exception 'Operator member projection exposed a payload'; end if;
end
$$;
reset role;

-- Output is closed metadata. Access-check failures themselves do not leak the
-- existence/content of a private run to end users or the narrowly scoped broker.
do $$
declare v_query jsonb; v_limit integer; v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
begin
	set local role service_role;
	v_query := public.qorpera_get_runtime_operational_run(v_run);
	if v_query::text ~ 'PRIVATE_TRANSCRIPT|Initial company note|note.md|"payload"|"source"|"body"|"path"|"plan"|"result"|capability_sha256|lease_token|credentialCapsule|downstream_idempotency' then
		raise exception 'Operational query exposed forbidden payload or capability metadata'; end if;
	foreach v_limit in array array[null,0,201] loop
		begin perform public.qorpera_get_runtime_operational_run(v_run,v_limit); raise exception 'Invalid query bound accepted';
		exception when invalid_parameter_value then null; end;
		begin perform public.qorpera_get_company_operational_commands('29000000-0000-4000-8000-000000000010',v_limit); raise exception 'Invalid member query bound accepted';
		exception when invalid_parameter_value then null; end;
		begin perform public.qorpera_purge_runtime_observations(v_limit); raise exception 'Invalid purge bound accepted';
		exception when invalid_parameter_value then null; end;
	end loop;
	begin perform public.qorpera_get_runtime_operational_run(extensions.gen_random_uuid()); raise exception 'Unknown run queried';
	exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	-- Also prove the internal role guard, not just EXECUTE revocation.
	begin perform public.qorpera_record_runtime_observation(v_run,pg_temp.observation()); raise exception 'Nonservice event accepted';
	exception when insufficient_privilege then null; end;
	begin perform public.qorpera_get_runtime_operational_run(v_run); raise exception 'Nonservice run queried';
	exception when insufficient_privilege then null; end;
	begin perform public.qorpera_get_company_operational_commands('29000000-0000-4000-8000-000000000010'); raise exception 'Nonservice company queried';
	exception when insufficient_privilege then null; end;
	begin perform public.qorpera_purge_runtime_observations(); raise exception 'Nonservice purge accepted';
	exception when insufficient_privilege then null; end;
end
$$;
-- Members get only a presentation phase for the selected active run, never
-- diagnostics, tool arguments, or provider text. Each read exercises the real
-- authenticated RPC while the disposable fixture alone owns diagnostic writes.
create function pg_temp.member_staff_activity()
returns jsonb language plpgsql as $$
declare v_activity jsonb;
begin
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_activity := public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020') -> 0;
	reset role;
	perform pg_temp.path_claims('service_role');
	return v_activity;
end
$$;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_run uuid := (b ->> 'runId')::uuid; v_start jsonb; v_other jsonb; v_activity jsonb;
begin
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
		raise exception 'Absent composition telemetry fabricated writing'; end if;
	-- A delivery may remain in flight after composition has already finished.
	-- Its transport span must never put the agent into the writing state.
	v_other := pg_temp.observation() || jsonb_build_object('operation','send_message',
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
	set local role service_role;
	perform public.qorpera_record_runtime_observation(v_run,v_other);
	reset role;
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
		raise exception 'Send transport telemetry fabricated writing'; end if;
	v_start := pg_temp.observation() || jsonb_build_object('operation','message_composition',
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
	set local role service_role;
	perform public.qorpera_record_runtime_observation(v_run,v_start);
	reset role;
	v_activity := pg_temp.member_staff_activity();
	if v_activity ->> 'phase' is distinct from 'writing' or v_activity ->> 'activity' <> 'working'
		or v_activity ->> 'run_id' <> v_run::text
		or v_activity - array['run_id','staff_agent_id','source_kind','job_status','activity','updated_at','phase'] <> '{}'::jsonb then
		raise exception 'Current composition was not projected as closed presentation metadata'; end if;
	-- Finished composition never lingers as typing, even while delivery is pending.
	set local role service_role;
	perform public.qorpera_record_runtime_observation(v_run,v_start || '{"phase":"finish","status":"succeeded","durationMs":1}');
	reset role;
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
		raise exception 'Completed composition kept the writing phase'; end if;
	-- A finish delivered before its start is still terminal for that attempt.
	v_other := v_start || jsonb_build_object('attemptId',extensions.gen_random_uuid());
	set local role service_role;
	perform public.qorpera_record_runtime_observation(v_run,v_other || '{"phase":"finish","status":"failed","durationMs":1}');
	perform public.qorpera_record_runtime_observation(v_run,v_other);
	reset role;
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
		raise exception 'Out-of-order start revived finished composition'; end if;
	-- Cancellation also closes the presentation span without waiting for expiry.
	v_other := v_start || jsonb_build_object('attemptId',extensions.gen_random_uuid());
	set local role service_role;
	perform public.qorpera_record_runtime_observation(v_run,v_other);
	perform public.qorpera_record_runtime_observation(v_run,v_other || '{"phase":"finish","status":"cancelled","durationMs":1}');
	reset role;
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
		raise exception 'Cancelled composition kept the writing phase'; end if;
	-- Freshly ingested old work and old ingestion with a fresh sender clock
	-- both expire. Unknown/previous assignments cannot animate the current run.
	insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,
		operation,observed_at,ingested_at,observation)
	values
		(v_run,extensions.gen_random_uuid(),'start',(b ->> 'assignmentId')::uuid,
			'message_composition',clock_timestamp()-interval '21 seconds',clock_timestamp(),v_start),
		(v_run,extensions.gen_random_uuid(),'start',(b ->> 'assignmentId')::uuid,
			'message_composition',clock_timestamp(),clock_timestamp()-interval '21 seconds',v_start),
		(v_run,extensions.gen_random_uuid(),'start',extensions.gen_random_uuid(),
			'message_composition',clock_timestamp(),clock_timestamp(),v_start),
		(v_run,extensions.gen_random_uuid(),'start',null,
			'message_composition',clock_timestamp(),clock_timestamp(),v_start);
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
		raise exception 'Stale or unbound composition telemetry animated the current assignment'; end if;
	v_other := v_start || jsonb_build_object('attemptId',extensions.gen_random_uuid());
	set local role service_role;
	perform public.qorpera_record_runtime_observation(v_run,v_other);
	reset role;
	if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'writing' then
		raise exception 'An older finished composition masked the current composition'; end if;
	begin
		update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp()-interval '1 second'
		where id = (b ->> 'jobId')::uuid;
		if pg_temp.member_staff_activity() ->> 'phase' is distinct from 'working' then
			raise exception 'Expired execution lease retained writing'; end if;
		raise exception using errcode='QTO02';
	exception when sqlstate 'QTO02' then null; end;
	begin
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		perform public.qorpera_terminalize_runner_attempt((b ->> 'jobId')::uuid,'failed','Writing fixture',false);
		reset role;
		v_activity := pg_temp.member_staff_activity();
		if v_activity ->> 'activity' is distinct from 'needs_attention' or v_activity ? 'phase' then
			raise exception 'Optional writing phase overrode terminal execution state'; end if;
		raise exception using errcode='QTO02';
	exception when sqlstate 'QTO02' then null; end;
	perform pg_temp.path_claims('authenticated',extensions.gen_random_uuid());
	set local role authenticated;
	begin
		perform public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020');
		raise exception 'Activity phase leaked outside company membership';
	exception when insufficient_privilege then null; end;
	reset role;
	-- Keep this projection fixture independent of the preceding diagnostic suite.
	raise exception using errcode='QTO02';
exception when sqlstate 'QTO02' then null;
end
$$;
set constraints all immediate;
rollback;

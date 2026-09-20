-- Real admission, assignment and native-lease contracts; no substituted
-- authority helper. Storage fixtures below stand in only for verified bytes.
begin;

insert into auth.users(id,email) values
	('30000000-0000-4000-8000-000000000001','path-owner@example.test'),
	('30000000-0000-4000-8000-000000000002','path-member@example.test'),
	('30000000-0000-4000-8000-000000000003','path-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('30000000-0000-4000-8000-000000000010','Path gateway fixture','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000002','path-member@example.test','Member','contributor'),
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000010','Environment',1,'30000000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('30000000-0000-4000-8000-000000000010',v_manifest);
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
	values ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('30000000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
-- Disposable policy fixture only; no hosted provider or deployment is used.
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
	'supported','enabled',32,null,'wake-component-fixture');
select set_config('qorpera_test.wake_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '30000000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'30000000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '30000000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.wake_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('30000000-0000-4000-8000-000000000025','30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000023',
	'30000000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'30000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '30000000-0000-4000-8000-000000000027',profile_id,'30000000-0000-4000-8000-000000000020','company_snapshot',
	'30000000-0000-4000-8000-000000000023','30000000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'30000000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where sha256 = current_setting('qorpera_test.wake_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '30000000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where sha256 = current_setting('qorpera_test.wake_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '30000000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('30000000-0000-4000-8000-000000000027','30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000029',current_setting('qorpera_test.wake_tree'),0,'30000000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '30000000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '30000000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '30000000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '30000000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('30000000-0000-4000-8000-000000000020',
	'30000000-0000-4000-8000-000000000023','30000000-0000-4000-8000-000000000001');
reset role;

insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000030','Agent','Research','Read and change the Company File.',
	'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'30000000-0000-4000-8000-000000000001');
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,staff_agent_id,staff_version,execution_scope)
values ('30000000-0000-4000-8000-000000000040','30000000-0000-4000-8000-000000000041',
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020','Path session','open',
	'30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000030',1,'{}');

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.wake_identity',public.qorpera_upsert_member_compute_identity(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000050','Path identity','qorpera-member-linux','v1',
	'["agent_turn","company_substrate"]','{"network":"provider-native-only","credentialExport":false}')::text,true);
select set_config('qorpera_test.wake_login',public.qorpera_begin_native_provider_login(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000051','30000000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('a',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.wake_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.wake_login')::jsonb ->> 'login_id')::uuid,repeat('a',64),'30000000-0000-4000-8000-000000000060',
	'object://native-capsules/30000000-0000-4000-8000-000000000060',repeat('b',64),'fixture-openai-account','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true);
reset role;
-- The pinned baseline has no native autonomous-consent producer. Seed a
-- consented immutable version only in this fixture; production integration
-- must supply that authorized producer, never flip the existing version.
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.wake_sponsor',public.qorpera_create_member_execution_sponsor(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true);
select set_config('qorpera_test.wake_turn',public.qorpera_request_session_turn_v2(
	'30000000-0000-4000-8000-000000000040','30000000-0000-4000-8000-000000000070','30000000-0000-4000-8000-000000000071',
	'{"schema":"qorpera.session-prompt/v1","text":"Update the company note.","images":[]}','member_connection',
	(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,
	(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,
	null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
select public.qorpera_register_runner_orchestrator('30000000-0000-4000-8000-000000000092','Path fixture','process',repeat('0',64),3600);
do $$
declare v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb;
	v_run uuid := (current_setting('qorpera_test.wake_turn')::jsonb ->> 'turn_request_id')::uuid;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',120);
	if v_claim #>> '{work,run_id}' is distinct from v_run::text then raise exception 'Wrong path fixture run'; end if;
	v_runner := public.qorpera_provision_execution_runner(v_run,'30000000-0000-4000-8000-000000000094','process',repeat('1',64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid,repeat('1',64),repeat('2',64),'linux','path-fixture');
	v_assignment := public.qorpera_assign_runner_job('30000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid,'30000000-0000-4000-8000-000000000095',repeat('3',64),120);
	perform public.qorpera_accept_runner_assignment((v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,(v_claim #>> '{work,job_id}')::uuid,repeat('3',64));
	v_lease := public.qorpera_acquire_native_provider_connection_lease(v_run,(v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('3',64),120);
	perform set_config('qorpera_test.wake_binding',jsonb_build_object('leaseId',v_lease ->> 'lease_id','runId',v_run,
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
declare v_prepared jsonb; v_entries jsonb; v_tree text; v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
begin
	v_prepared := public.qorpera_prepare_company_path_mutation('30000000-0000-4000-8000-000000000020',v_binding,p_plan);
	if v_prepared ->> 'state' = 'completed' then return v_prepared -> 'result'; end if;
	if v_prepared ->> 'state' = 'ready' then
		select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
			select value from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> p_plan ->> 'path'
			union all select p_plan -> 'entry' where p_plan -> 'entry' <> 'null'::jsonb
		) entries;
		v_tree := pg_temp.path_stage_tree(v_entries);
	end if;
	return public.qorpera_commit_company_path_mutation('30000000-0000-4000-8000-000000000020',v_binding,p_plan,
		(v_prepared ->> 'snapshotId')::uuid,v_tree);
end
$$;

-- BEGIN WAKE HELPERS
create function pg_temp.wake_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Wake assertion: %',p_message; end if; end
$$;
create function pg_temp.wake_error(p_sql text,p_state text,p_message text default null)
returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		if p_message is not null then
			raise exception 'Expected SQLSTATE % with message %, got %: %',p_state,p_message,sqlstate,sqlerrm;
		end if;
		raise exception 'Expected SQLSTATE %, got %: %',p_state,sqlstate,sqlerrm;
	end;
	raise exception 'Expected SQLSTATE %, call succeeded',p_state;
end
$$;
create function pg_temp.wake_routine(p_staff uuid,p_trigger jsonb,p_client uuid default extensions.gen_random_uuid())
returns jsonb language plpgsql as $$
declare v_result jsonb; v_claims text := current_setting('request.jwt.claims');
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_upsert_cloud_routine('30000000-0000-4000-8000-000000000020',p_client,
		extensions.gen_random_uuid(),p_staff,'Wake fixture','Examine the authorized change.',jsonb_build_array(p_trigger),
		'low',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn',
		'agent_turn',true,'automatic',null,'{}');
	perform set_config('request.jwt.claims',v_claims,true);
	return v_result;
end
$$;
create function pg_temp.wake_schedule(p_routine jsonb,p_key text,p_at timestamptz default null)
returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_at timestamptz := coalesce(p_at,statement_timestamp()-interval '5 minutes');
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
begin
	select * into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors
	where routine_id = (p_routine ->> 'routine_id')::uuid and routine_version = (p_routine ->> 'version')::bigint;
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,v_id,p_key,v_cursor.trigger_id,
		v_at,v_cursor.last_scheduled_for,v_at+interval '5 minutes','{}');
	return v_id;
end
$$;
create function pg_temp.wake_start(p_run uuid)
returns jsonb language plpgsql as $$
declare v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('30000000-0000-4000-8000-000000000092',extensions.gen_random_uuid(),120);
	-- NULL is used only by the restart fixture to accept the queue's selection.
	p_run := coalesce(p_run,(v_claim #>> '{work,run_id}')::uuid);
	perform pg_temp.wake_assert(v_claim #>> '{work,run_id}' = p_run::text,'Wrong fixture run selected');
	v_runner := public.qorpera_provision_execution_runner(p_run,extensions.gen_random_uuid(),'process',repeat('1',64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid,repeat('1',64),repeat('2',64),'linux','wake-fixture');
	v_assignment := public.qorpera_assign_runner_job('30000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid,extensions.gen_random_uuid(),repeat('3',64),120);
	perform public.qorpera_accept_runner_assignment((v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,(v_claim #>> '{work,job_id}')::uuid,repeat('3',64));
	v_lease := public.qorpera_acquire_native_provider_connection_lease(p_run,(v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('3',64),120);
	return jsonb_build_object('leaseId',v_lease ->> 'lease_id','runId',p_run,'jobId',v_claim #>> '{work,job_id}',
		'runnerId',v_runner ->> 'runner_id','assignmentId',v_assignment ->> 'assignment_id',
		'credentialCapsuleId',v_lease ->> 'credential_capsule_id','computeIdentityId',v_lease ->> 'compute_identity_id',
		'provider','openai','nativeHarness','codex-cli','model','gpt-native');
end
$$;
create function pg_temp.wake_public_send(p_binding jsonb,p_phase text,p_key text default null)
returns jsonb language sql as $$
	select public.qorpera_send_native_agent_message((p_binding ->> 'leaseId')::uuid,(p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid,(p_binding ->> 'runnerId')::uuid,(p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid,(p_binding ->> 'computeIdentityId')::uuid,'openai','codex-cli',
		coalesce(p_key,p_phase),'A material result or acknowledgement.',p_phase)
$$;
-- A canonical batch fixture with real sponsor reservation, native provenance,
-- input claims and queued event. The legacy batch producer predates native
-- compute identities; the current v2 producer handles one input at a time.
create function pg_temp.wake_input_run(p_inputs uuid[])
returns uuid language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_id uuid := extensions.gen_random_uuid(); v_job uuid;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,'30000000-0000-4000-8000-000000000042',v_base.substrate_version_id,
		v_id,'agent_turn','agent_turn','{}',v_base.requested_by_user_id) returning id into v_job;
	insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
		substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
		required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
	values(v_id,v_base.profile_id,v_base.environment_id,'session_turn',v_id,'30000000-0000-4000-8000-000000000042',v_job,
		v_base.substrate_version_id,v_base.company_snapshot_id,'30000000-0000-4000-8000-000000000031',1,p_inputs,
		v_base.sponsor_binding_id,v_base.sponsor_version,'agent_turn','agent_turn',repeat('e',64),v_base.compute_identity_id,0,v_base.requested_by_user_id);
	update public.qorpera_runner_jobs set run_id = v_id where id = v_job;
	if not public.qorpera_reserve_execution_sponsor_authority(v_id) then
		update public.qorpera_runner_jobs set run_id = null where id = v_job;
		delete from public.qorpera_execution_runs where id = v_id;
		delete from public.qorpera_runner_jobs where id = v_job;
		return null;
	end if;
	update public.qorpera_session_inputs set execution_run_id = v_id where id = any(p_inputs) and execution_run_id is null;
	perform public.qorpera_append_execution_input_events('30000000-0000-4000-8000-000000000042',p_inputs);
	insert into public.qorpera_execution_run_events(run_id,event_type) values(v_id,'queued');
	return v_id;
end
$$;

-- END WAKE HELPERS

insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
	employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
select profile_id,staff_id,name,role,charter,appearance_color,appearance_shape,employment_status,lifecycle_state,
	model_provider,model_id,created_at,updated_at,updated_by_user_id from public.qorpera_profile_staff,
	(values ('30000000-0000-4000-8000-000000000031'::uuid,'Bob'),('30000000-0000-4000-8000-000000000032'::uuid,'Carol')) b(staff_id,name)
where staff_agent_id = '30000000-0000-4000-8000-000000000030';
-- This file exercises wake mechanics with each agent's plain company conversation as its public
-- audience. The agents' shared threads (created with the staff rows, 2026-09-17 amendment) are
-- retired here; the final block reopens one and proves it is the first public audience.
update public.qorpera_shared_sessions set status = 'closed'
where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true';
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,staff_agent_id,staff_version,execution_scope)
select session_id,extensions.gen_random_uuid(),profile_id,'30000000-0000-4000-8000-000000000020',display_name,'open',
	'30000000-0000-4000-8000-000000000001',s.staff_agent_id::text,s.version,'{}'
from public.qorpera_profile_staff s join (values
	('30000000-0000-4000-8000-000000000031'::uuid,'30000000-0000-4000-8000-000000000042'::uuid),
	('30000000-0000-4000-8000-000000000032'::uuid,'30000000-0000-4000-8000-000000000043'::uuid)) b(staff_id,session_id)
	on b.staff_id = s.staff_agent_id;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
do $$
declare v_staff uuid; v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into strict v_resource from public.qorpera_company_path_resources
	where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	foreach v_staff in array array['30000000-0000-4000-8000-000000000030'::uuid,
		'30000000-0000-4000-8000-000000000031'::uuid,'30000000-0000-4000-8000-000000000032'::uuid] loop
		perform public.qorpera_grant_company_path(v_resource.id,v_resource.version,'staff_agent',v_staff,array['read','write']);
		perform public.qorpera_configure_staff_execution_authority('30000000-0000-4000-8000-000000000010',v_staff,
			(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null);
	end loop;
	perform public.qorpera_configure_session_execution('30000000-0000-4000-8000-000000000042',
		(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn','agent_turn');
end
$$;
select pg_temp.path_claims('service_role');

-- END WAKE FIXTURE

-- Policies for all five kinds; a room wake without its room, input, member and sponsor identity is refused (20260828022000).
do $$
declare v_kind text; v_policy jsonb; v_run uuid := (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
begin
	foreach v_kind in array array['human','first-run','routine','agent','room'] loop
		v_policy := public.qorpera_wake_policy_value(v_kind,'optional');
		perform pg_temp.wake_assert(v_policy ->> 'kind' = v_kind,'Policy kind');
		perform pg_temp.wake_assert((v_policy ->> 'silenceAllowed')::boolean = (v_kind in ('routine','agent','room')),'Silence rule');
	end loop;
	perform pg_temp.wake_assert(public.qorpera_wake_policy_value('routine') = public.qorpera_wake_policy_value('routine','required'),
		'Omitted reporting never grants silence');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('human'),'Admitted human policy');
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',v_run),'55000');
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_completion(%L)',v_run),'55000');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(extensions.gen_random_uuid()) = public.qorpera_wake_policy_value(null),'Missing policy keeps initial and final');
	insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run,'queued'),(v_run,'queued');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences where run_id = v_run),'Repeated queued events are idempotent');
	perform pg_temp.wake_error($q$insert into public.qorpera_wake_occurrences(profile_id,environment_id,wake_kind,source_kind,
		trigger_id,occurrence_key,scheduled_for,not_before) values('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020','room','room','room','room-test',now(),now())$q$,'42501');
end
$$;
savepoint final_without_ack;
-- A composed component backstop works both before and after send-admission
-- integration: either the send is rejected, or completion rejects its missing
-- acknowledgement. Strict admission rejection is a separate acceptance case.
select pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,''final''); select public.qorpera_assert_wake_completion(%L)',
	current_setting('qorpera_test.wake_binding'),current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId'),'55000');
rollback to final_without_ack;
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select public.qorpera_assert_wake_work_allowed((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid);
savepoint final_closes_work;
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'final');
select public.qorpera_assert_wake_completion((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid);
select pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',
	current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId'),'55000');
rollback to final_closes_work;

savepoint first_run;
insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
values('30000000-0000-4000-8000-000000000100','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
	'kickoff','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}');
do $$
declare v_run uuid; v_wake public.qorpera_wake_occurrences%rowtype; v_binding jsonb;
begin
	v_run := pg_temp.wake_input_run(array['30000000-0000-4000-8000-000000000100'::uuid]);
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run;
	perform pg_temp.wake_assert(v_wake.wake_kind = 'first-run','Typed kickoff is a first-run wake');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('first-run'),'First-run obligations');
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',v_run),'55000');
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_completion(%L)',v_run),'55000');
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform public.qorpera_assert_wake_work_allowed(v_run);
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_completion(%L)',v_run),'55000');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform public.qorpera_assert_wake_completion(v_run);
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',v_run),'55000');
end
$$;
rollback to first_run;

savepoint mixed_input;
insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body) values
	('30000000-0000-4000-8000-000000000100','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
	'kickoff','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}'),
	('30000000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
	'user_message','30000000-0000-4000-8000-000000000001','{"schema":"qorpera.session-prompt/v1","text":"Work","images":[]}');
do $$
declare v_run uuid; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	v_run := pg_temp.wake_input_run(array['30000000-0000-4000-8000-000000000100'::uuid,'30000000-0000-4000-8000-000000000101'::uuid]);
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run;
	perform pg_temp.wake_assert(v_wake.wake_kind = 'human' and v_wake.source_id = '30000000-0000-4000-8000-000000000101','Mixed input remains human even when kickoff sorts first');
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',v_run),'55000');
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_completion(%L)',v_run),'55000');
	perform pg_temp.wake_assert(jsonb_array_length(v_wake.payload -> 'inputIds') = 2 and cardinality(v_wake.causal_agent_ids) = 1
		and v_wake.causal_agent_ids[1] = v_wake.staff_agent_id and v_wake.causal_root_id = v_wake.id,'Mixed inputs retain ancestry');
	perform pg_temp.wake_assert(public.qorpera_wake_ancestry(v_run,v_wake.staff_agent_id,'30000000-0000-4000-8000-000000000032',null)
		->> 'rootId' = v_wake.id::text,'Mixed batch propagates causal root');
	delete from public.qorpera_wake_occurrences where id = v_wake.id;
	update public.qorpera_session_inputs set execution_run_id = null where id = '30000000-0000-4000-8000-000000000100';
	perform pg_temp.wake_error(format('insert into public.qorpera_execution_run_events(run_id,event_type) values(%L,''queued'')',v_run),'42501');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),'Unclaimed input never grants silence');
end
$$;
rollback to mixed_input;

savepoint mismatched_input;
insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body) values
	('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff','30000000-0000-4000-8000-000000000001','{}'),
	('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'user_message','30000000-0000-4000-8000-000000000002','{}');
select pg_temp.wake_error($q$select pg_temp.wake_input_run(array(select id from public.qorpera_session_inputs
	where session_id = '30000000-0000-4000-8000-000000000042'))$q$,'42501');
select pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences),'Partially matching batch leaves no occurrence');
rollback to mismatched_input;

savepoint sponsor_denied;
insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff','30000000-0000-4000-8000-000000000001','{}');
-- The existing human run occupies the one allowed native execution slot.
-- Native subscriptions do not use monetary reservation ceilings.
update public.qorpera_provider_connection_versions
set quota_policy = jsonb_set(quota_policy,'{max_concurrent_runs}','1'::jsonb)
where connection_id = (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid
	and version = 2;
select pg_temp.wake_assert(pg_temp.wake_input_run(array(select id from public.qorpera_session_inputs
	where session_id = '30000000-0000-4000-8000-000000000042')) is null,'Sponsor denies provisional run');
select pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences),'Sponsor denial leaves no occurrence');
select pg_temp.wake_assert((select count(*) = 1 from public.qorpera_execution_runs),'Sponsor denial cleans provisional run');
rollback to sponsor_denied;

savepoint routine_policy;
do $$
declare v_routine jsonb; v_wake uuid; v_run uuid; v_binding jsonb; v_kind text; v_policy jsonb;
	v_original public.qorpera_execution_runs%rowtype; v_patch jsonb; v_other_sponsor uuid;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}');
	v_wake := pg_temp.wake_schedule(v_routine,'tick-1');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1)) = 1,'Schedule materializes through existing queue');
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake;
	v_policy := public.qorpera_runtime_wake_policy(v_run);
	perform pg_temp.wake_assert(v_policy = public.qorpera_wake_policy_value('routine','optional'),'Explicit optional routine permits silence');
	perform public.qorpera_assert_wake_completion(v_run);
	perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(1) = '[]'::jsonb,'Materializer does not duplicate an admitted run');
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) #>> '{routine,intent}' = 'Examine the authorized change.','Routine context uses immutable intent');
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform pg_temp.wake_error(format('select public.qorpera_assert_wake_completion(%L)',v_run),'55000');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform public.qorpera_assert_wake_completion(v_run);
	select * into strict v_original from public.qorpera_execution_runs where id = v_run;
	-- Deliberately corrupt bindings as the fixture owner to verify the accessor
	-- is defensive independently of the immutable occurrence writer.
	for v_patch in select value from jsonb_array_elements(jsonb_build_array(
		jsonb_build_object('source_kind','session_turn'),jsonb_build_object('source_id',extensions.gen_random_uuid()),
		jsonb_build_object('staff_version',v_original.staff_version+1),
		jsonb_build_object('session_id','30000000-0000-4000-8000-000000000042'),
		jsonb_build_object('requested_by_user_id','30000000-0000-4000-8000-000000000002'))) loop
		begin
			update public.qorpera_execution_runs set
				source_kind = coalesce(v_patch ->> 'source_kind',v_original.source_kind),
				input_ids = case when v_patch ->> 'source_kind' = 'session_turn'
					then array[(current_setting('qorpera_test.wake_turn')::jsonb ->> 'input_id')::uuid] else v_original.input_ids end,
				source_id = coalesce((v_patch ->> 'source_id')::uuid,v_original.source_id),
				staff_version = coalesce((v_patch ->> 'staff_version')::bigint,v_original.staff_version),
				session_id = coalesce((v_patch ->> 'session_id')::uuid,v_original.session_id),
				requested_by_user_id = coalesce((v_patch ->> 'requested_by_user_id')::uuid,v_original.requested_by_user_id)
			where id = v_run;
			perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),'Wrongly attached occurrence keeps human obligations: ' || v_patch::text);
			raise sqlstate 'PZ001';
		exception when sqlstate 'PZ001' then null; end;
	end loop;
	insert into public.qorpera_execution_sponsor_versions
	select (jsonb_populate_record(null::public.qorpera_execution_sponsor_versions,to_jsonb(s)||'{"version":2}'::jsonb)).*
	from public.qorpera_execution_sponsor_versions s where binding_id = v_original.sponsor_binding_id and version = 1;
	update public.qorpera_execution_runs set sponsor_version = 2 where id = v_run;
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),'Sponsor version mismatch fails closed');
	update public.qorpera_execution_runs set sponsor_version = 1 where id = v_run;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_other_sponsor := (public.qorpera_create_member_execution_sponsor(v_original.profile_id,extensions.gen_random_uuid(),
		(current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid,2,true) ->> 'binding_id')::uuid;
	perform pg_temp.path_claims('service_role');
	update public.qorpera_execution_runs set sponsor_binding_id = v_other_sponsor where id = v_run;
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),'Sponsor binding mismatch fails closed');
	update public.qorpera_execution_runs set sponsor_binding_id = v_original.sponsor_binding_id where id = v_run;
	update public.qorpera_cloud_routine_versions set triggers = '[{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"unknown"}]'
	where routine_id = (v_routine ->> 'routine_id')::uuid and version = 1;
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value(null),'Malformed stored policy keeps required acknowledgement and final');
end
$$;
rollback to routine_policy;

savepoint routine_reporting;
do $$
declare v_reporting text; v_routine jsonb; v_wake uuid; v_run uuid; v_binding jsonb; v_phase text; v_count integer;
begin
	foreach v_reporting in array array['omitted','required','silent'] loop
		v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
			jsonb_build_object('id','tick','kind','schedule','intervalMinutes',5) ||
			case when v_reporting = 'omitted' then '{}'::jsonb else jsonb_build_object('replyPolicy',v_reporting) end);
		v_wake := pg_temp.wake_schedule(v_routine,'report-' || v_reporting);
		perform public.qorpera_materialize_wake_execution_runs(1);
		select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake;
		v_binding := pg_temp.wake_start(v_run);
		perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) =
			public.qorpera_wake_policy_value('routine',case when v_reporting = 'omitted' then 'required' else v_reporting end),
			'Admitted reporting policy: ' || v_reporting);
		perform public.qorpera_assert_wake_work_allowed(v_run);
		if v_reporting in ('omitted','required') then
			perform pg_temp.wake_error(format('select public.qorpera_assert_wake_completion(%L)',v_run),'55000');
			-- A required routine report does not require an initial acknowledgement.
			perform pg_temp.wake_public_send(v_binding,'final');
			perform public.qorpera_assert_wake_completion(v_run);
			perform pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',v_run),'55000');
		else
			perform public.qorpera_assert_wake_completion(v_run);
			foreach v_phase in array array['progress','final'] loop
				-- Component completion backstop only. Actual send-admission rejection
				-- is checked separately by acceptance/runtime_wake_bus.sql.
				perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L); select public.qorpera_assert_wake_completion(%L)',
					v_binding,v_phase,v_run),'55000');
			end loop;
			perform public.qorpera_assert_wake_completion(v_run);
		end if;
	end loop;
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}');
	v_wake := pg_temp.wake_schedule(v_routine,'budget');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake;
	v_binding := pg_temp.wake_start(v_run);
	for v_count in 1..64 loop
		perform pg_temp.wake_public_send(v_binding,'progress','budget-' || v_count);
	end loop;
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,''final''); select public.qorpera_assert_wake_completion(%L)',
		v_binding,v_run),'55000');
end
$$;
rollback to routine_reporting;

savepoint routine_audience_admission;
do $$
declare v_reporting text; v_routine jsonb; v_wake uuid; v_run uuid;
	v_runs integer; v_jobs integer; v_reservations integer; v_patch jsonb;
begin
	-- A company label, closed conversation or stale staff pin is not a usable
	-- audience. The immutable schedule cursor must not advance on denial.
	for v_patch in select value from jsonb_array_elements('[{"status":"closed"},
		{"execution_scope":{"roomId":"not-cloud-room-authority"}},{"staff_version":2}]') loop
		begin
			update public.qorpera_shared_sessions set status = coalesce((v_patch ->> 'status')::public.qorpera_session_status,status),
				execution_scope = coalesce(v_patch -> 'execution_scope',execution_scope),
				staff_version = coalesce((v_patch ->> 'staff_version')::bigint,staff_version)
			where id = '30000000-0000-4000-8000-000000000042';
			foreach v_reporting in array array['omitted','required'] loop
				v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
					jsonb_build_object('id','tick','kind','schedule','intervalMinutes',5) ||
					case when v_reporting = 'omitted' then '{}'::jsonb else jsonb_build_object('replyPolicy',v_reporting) end);
				select count(*) into v_runs from public.qorpera_execution_runs;
				select count(*) into v_jobs from public.qorpera_runner_jobs;
				select count(*) into v_reservations from public.qorpera_execution_sponsor_reservations;
				perform pg_temp.wake_error(format('select pg_temp.wake_schedule(%L,%L)',v_routine,'no-audience-' || v_reporting),
					'42501','Wake public audience is unavailable');
				perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences
					where routine_id = (v_routine ->> 'routine_id')::uuid),'Missing audience leaves no occurrence: ' || v_reporting);
				perform pg_temp.wake_assert((select last_scheduled_for is null from public.qorpera_cloud_routine_schedule_cursors
					where routine_id = (v_routine ->> 'routine_id')::uuid),'Denied schedule does not consume its durable slot');
				perform pg_temp.wake_assert((select count(*) = v_runs from public.qorpera_execution_runs)
					and (select count(*) = v_jobs from public.qorpera_runner_jobs)
					and (select count(*) = v_reservations from public.qorpera_execution_sponsor_reservations),
					'Missing audience admits no compute or sponsor reservation');
			end loop;
			raise sqlstate 'PZ001';
		exception when sqlstate 'PZ001' then null; end;
	end loop;
	-- An explicit permission to finish privately still permits sessionless
	-- routines; this check does not manufacture a conversation for them.
	update public.qorpera_shared_sessions set status = 'closed' where id = '30000000-0000-4000-8000-000000000042';
	foreach v_reporting in array array['optional','silent'] loop
		v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
			jsonb_build_object('id','tick','kind','schedule','intervalMinutes',5,'replyPolicy',v_reporting));
		v_wake := pg_temp.wake_schedule(v_routine,'private-' || v_reporting);
		perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1)) = 1,
			'Explicit private completion permission does not require an invented audience');
		select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake and session_id is null;
		perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy(v_run) = public.qorpera_wake_policy_value('routine',v_reporting),
			'Sessionless routine retains its explicit reporting policy');
		perform public.qorpera_assert_wake_completion(v_run);
	end loop;
end
$$;
rollback to routine_audience_admission;

savepoint routine_audience_binding;
do $$
declare v_routine jsonb; v_id uuid := extensions.gen_random_uuid(); v_wake public.qorpera_wake_occurrences%rowtype;
	v_candidate public.qorpera_wake_occurrences%rowtype; v_patch jsonb; v_runs integer; v_reservations integer;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"required"}');
	-- Fixture-owner insertion tests the pin trigger itself. Supplied identity
	-- must not replace the authoritative Bob conversation with Carol's session.
	insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,routine_id,routine_version,
		trigger_id,occurrence_key,scheduled_for,not_before,session_id)
	values(v_id,'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		(v_routine ->> 'routine_id')::uuid,(v_routine ->> 'version')::bigint,'tick','supplied-audience',now(),now(),
		'30000000-0000-4000-8000-000000000043') returning * into v_wake;
	perform pg_temp.wake_assert(v_wake.session_id = '30000000-0000-4000-8000-000000000042'
		and public.qorpera_wake_authorized(v_wake),'Routine uses the current authorized company/staff conversation');
	for v_patch in select value from jsonb_array_elements('[{"session_id":"30000000-0000-4000-8000-000000000043"},
		{"environment_id":"30000000-0000-4000-8000-000000000999"}]') loop
		v_candidate := jsonb_populate_record(v_wake,v_patch);
		perform pg_temp.wake_assert(not public.qorpera_wake_authorized(v_candidate),
			'A supplied audience must match staff and environment');
	end loop;
	select count(*) into v_runs from public.qorpera_execution_runs;
	select count(*) into v_reservations from public.qorpera_execution_sponsor_reservations;
	for v_patch in select value from jsonb_array_elements('[{"status":"closed"},
		{"execution_scope":{"roomId":"not-cloud-room-authority"}},{"staff_version":2}]') loop
		begin
			update public.qorpera_shared_sessions set status = coalesce((v_patch ->> 'status')::public.qorpera_session_status,status),
				execution_scope = coalesce(v_patch -> 'execution_scope',execution_scope),
				staff_version = coalesce((v_patch ->> 'staff_version')::bigint,staff_version)
			where id = v_wake.session_id;
			perform pg_temp.wake_assert(not public.qorpera_wake_authorized(v_wake),'Pinned audience is checked against current context');
			perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(1) = '[]'::jsonb,
				'Unusable admitted audience does not start execution');
			perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null
				from public.qorpera_wake_occurrences where id = v_id),'Unusable admitted audience cancels durably');
			perform pg_temp.wake_assert((select count(*) = v_runs from public.qorpera_execution_runs)
				and (select count(*) = v_reservations from public.qorpera_execution_sponsor_reservations),
				'Canceled audience creates no execution or sponsor reservation');
			raise sqlstate 'PZ001';
		exception when sqlstate 'PZ001' then null; end;
	end loop;
end
$$;
rollback to routine_audience_binding;

savepoint file_listener_audience;
do $$
declare v_reporting text; v_routine jsonb; v_result jsonb; v_change jsonb;
	v_routines uuid[] := '{}'; v_runs integer; v_jobs integer; v_reservations integer;
begin
	foreach v_reporting in array array['omitted','required'] loop
		v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
			'{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC"}'::jsonb ||
			case when v_reporting = 'omitted' then '{}'::jsonb else jsonb_build_object('replyPolicy',v_reporting) end);
		v_routines := array_append(v_routines,(v_routine ->> 'routine_id')::uuid);
	end loop;
	update public.qorpera_shared_sessions set status = 'closed' where id = '30000000-0000-4000-8000-000000000042';
	v_change := pg_temp.path_commit(pg_temp.path_plan('missing-file-audience','audience.md',
		pg_temp.path_stage_file('audience.md','Committed event with no report audience')));
	select count(*) into v_runs from public.qorpera_execution_runs;
	select count(*) into v_jobs from public.qorpera_runner_jobs;
	select count(*) into v_reservations from public.qorpera_execution_sponsor_reservations;
	v_result := public.qorpera_drain_company_file_wakes(1);
	perform pg_temp.wake_assert(v_result = '{"schema":"qorpera.file-wake-drain/v1","scanned":1,"examined":1,"admitted":0}'::jsonb,
		'No-audience listener consumes one bounded candidate');
	perform public.qorpera_drain_company_file_wakes(1);
	perform pg_temp.wake_assert((select count(*) = 2 from public.qorpera_company_file_wake_claims
		where event_id = (v_change ->> 'snapshotId')::uuid and routine_id = any(v_routines)
			and outcome = 'denied' and occurrence_id is null),'Required and omitted audience denials remain private');
	perform pg_temp.wake_assert((select count(*) = 2 from public.qorpera_company_file_wake_cursors
		where routine_id = any(v_routines) and processed_head = (v_change ->> 'snapshotId')::uuid),
		'No-audience denials advance both durable cursors');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id = any(v_routines)),
		'Denied event metadata never reaches an execution occurrence');
	perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(2) = '[]'::jsonb
		and (select count(*) = v_runs from public.qorpera_execution_runs)
		and (select count(*) = v_jobs from public.qorpera_runner_jobs)
		and (select count(*) = v_reservations from public.qorpera_execution_sponsor_reservations),
		'Denied listener consumes no execution or sponsor reservation');
	update public.qorpera_shared_sessions set status = 'open' where id = '30000000-0000-4000-8000-000000000042';
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(2) ->> 'examined' = '0',
		'Restoring an audience does not replay a privately denied event');
	perform pg_temp.path_commit(pg_temp.path_plan('restored-file-audience','after-audience.md',
		pg_temp.path_stage_file('after-audience.md','A later authorized event')));
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(2) ->> 'admitted' = '2',
		'Future events remain deliverable after the audience is restored');
end
$$;
rollback to file_listener_audience;

savepoint coworker_delivery;
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_first jsonb; v_again jsonb; v_bob_run uuid; v_bob jsonb; v_routine jsonb; v_result jsonb;
begin
	v_first := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','handoff-1','Examine the note.');
	v_again := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','handoff-1','Examine the note.');
	perform pg_temp.wake_assert(v_first = v_again and v_first ->> 'status' = 'queued','Duplicate coworker delivery returns one durable receipt');
	perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,%L,%L)',v_binding,
		'30000000-0000-4000-8000-000000000031','handoff-1','Different text'),'23505');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_bob_run from public.qorpera_wake_occurrences where id = (v_first ->> 'occurrenceId')::uuid;
	perform pg_temp.wake_assert(v_bob_run is not null,'Coworker wake gets fresh admission');
	v_bob := pg_temp.wake_start(v_bob_run);
	v_result := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.wake_assert(v_result #>> '{payload,text}' = 'Examine the note.' and v_result #>> '{policy,final}' = 'forbidden','Durable addressed message is private to recipient');
	perform pg_temp.wake_assert(v_result #> '{causal,agentIds}' = '["30000000-0000-4000-8000-000000000030","30000000-0000-4000-8000-000000000031"]'::jsonb,'Coworker retains ancestry');
	perform public.qorpera_assert_wake_completion(v_bob_run);
	v_result := public.qorpera_send_coworker_message(v_bob,'30000000-0000-4000-8000-000000000030','thanks','Thanks.');
	perform pg_temp.wake_assert(v_result ->> 'status' = 'causal-fence' and v_result -> 'occurrenceId' = 'null'::jsonb,'Acknowledgement cycle is fenced');
	perform pg_temp.wake_assert((select count(*) = 2 from public.qorpera_wake_occurrences),'Cycle creates no new occurrence');
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"changes","kind":"listener","source":"company-file","path":"note.md","match":"exact","timeZone":"Europe/Copenhagen","replyPolicy":"optional"}');
	perform set_config('qorpera_test.wake_binding',v_bob::text,true);
	perform pg_temp.path_commit(pg_temp.path_plan('bob-note','note.md',pg_temp.path_stage_file('note.md','From Bob')));
	v_result := public.qorpera_drain_company_file_wakes(1);
	perform pg_temp.wake_assert(v_result ->> 'examined' = '1' and v_result ->> 'admitted' = '0','Message to file to ancestor does not loop');
	perform pg_temp.wake_assert((select outcome = 'causal-fence' from public.qorpera_company_file_wake_claims
		where routine_id = (v_routine ->> 'routine_id')::uuid),'Cycle decision is durable');
end
$$;
rollback to coworker_delivery;

savepoint revoked_coworker;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,
		'30000000-0000-4000-8000-000000000031','revoked-recipient','Please examine.');
	update public.qorpera_profile_staff set employment_status = 'archived'
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';
	perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(1) = '[]'::jsonb,'Revoked recipient does not execute');
	perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences
		where id = (v_result ->> 'occurrenceId')::uuid),'Queued delivery cancels durably on revocation');
end
$$;
rollback to revoked_coworker;

savepoint inherited_read_authority;
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_send jsonb; v_bob_run uuid; v_bob jsonb;
	v_resource public.qorpera_company_path_resources%rowtype; v_grant uuid;
begin
	perform public.qorpera_read_company_path('30000000-0000-4000-8000-000000000020','note.md',v_binding);
	v_send := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','tainted','Context based on note.');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_bob_run from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	v_bob := pg_temp.wake_start(v_bob_run);
	perform public.qorpera_read_native_wake(v_bob);
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_company_run_read_paths where run_id = v_bob_run and path = 'note.md'),'Recipient inherits durable read constraints');
	select * into strict v_resource from public.qorpera_company_path_resources where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	-- Every active grant of the recipient on the root, including the default agent read grant (20260828020700).
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	for v_grant in select id from public.qorpera_company_path_grants where resource_id = v_resource.id
		and principal_id = '30000000-0000-4000-8000-000000000031' and revoked_at is null loop
		perform public.qorpera_revoke_company_path(v_resource.id,v_resource.version,v_grant);
	end loop;
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_error(format('select public.qorpera_read_native_wake(%L)',v_bob),'42501');
	perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,%L,%L)',v_binding,
		'30000000-0000-4000-8000-000000000031','denied-before-delivery','Context based on note.'),'42501');
end
$$;
rollback to inherited_read_authority;

savepoint file_listener;
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_routine jsonb; v_result jsonb; v_change jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype; v_bob jsonb; v_head uuid; v_proposal jsonb; v_digest text; v_prepared jsonb; v_tree text;
	v_trigger jsonb := '{"id":"changes","kind":"listener","source":"company-file","path":"note.md","match":"exact","timeZone":"Europe/Copenhagen","replyPolicy":"optional"}';
begin
	perform pg_temp.path_commit(pg_temp.path_plan('older','older.md',pg_temp.path_stage_file('older.md','Before activation')));
	select head_snapshot_id into strict v_head from public.qorpera_company_files where environment_id = '30000000-0000-4000-8000-000000000020';
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',v_trigger,v_client);
	perform pg_temp.wake_assert((select activation_head = v_head and processed_head = v_head from public.qorpera_company_file_wake_cursors
		where routine_id = (v_routine ->> 'routine_id')::uuid),'Activation captures current head');
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(1) ->> 'examined' = '0','Activation does not replay company history');
	perform pg_temp.path_commit(pg_temp.path_plan('unmatched','note.md.extra',pg_temp.path_stage_file('note.md.extra','Not exact')));
	v_result := public.qorpera_drain_company_file_wakes(1);
	perform pg_temp.wake_assert(v_result ->> 'examined' = '1' and v_result ->> 'admitted' = '0','Exact selector excludes prefix matches');
	v_change := pg_temp.path_commit(pg_temp.path_plan('matched','note.md',pg_temp.path_stage_file('note.md','New event')));
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(1) ->> 'admitted' = '1','Authorized committed revision wakes once');
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(1) ->> 'examined' = '0','Duplicate drain does not repeat delivery');
	select * into strict v_wake from public.qorpera_wake_occurrences where routine_id = (v_routine ->> 'routine_id')::uuid;
	perform pg_temp.wake_assert(v_wake.file_event_id = (v_change ->> 'snapshotId')::uuid
		and not (v_wake.payload ?| array['entry','file','tree_manifest_sha256','resourceVersion']),'Metadata uses revision identity without object authority');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	v_bob := pg_temp.wake_start(v_wake.run_id);
	v_result := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.wake_assert(v_result #>> '{source,kind}' = 'company-file' and v_result #>> '{payload,path}' = 'note.md','File event enters routine context');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_company_run_read_paths where run_id = v_wake.run_id and path = 'note.md'),'Event path enters existing read-set fence');
	perform pg_temp.wake_assert(public.qorpera_send_coworker_message(v_bob,'30000000-0000-4000-8000-000000000030','file-reply','Acknowledged.')
		->> 'status' = 'causal-fence','File to coworker causal cycle is fenced');
	-- A proposed deletion is not a live event. Only the separately authorized
	-- publication enters the same immutable revision stream.
	v_proposal := pg_temp.path_commit(pg_temp.path_plan('delete-proposed','note.md',null,(v_change ->> 'version')::uuid));
	perform pg_temp.wake_assert(v_proposal ->> 'state' = 'proposed','Deletion waits for approval');
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(1) ->> 'examined' = '0','Proposed-only change is not a live event');
	select plan_sha256 into strict v_digest from public.qorpera_company_path_proposals where id = (v_proposal ->> 'proposalId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_review_company_path_proposal((v_proposal ->> 'proposalId')::uuid,v_digest,'approve');
	perform pg_temp.path_claims('service_role');
	v_prepared := public.qorpera_prepare_company_path_approval((v_proposal ->> 'proposalId')::uuid,v_digest);
	v_tree := pg_temp.path_stage_tree((select jsonb_agg(value) from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> 'note.md'));
	perform public.qorpera_apply_company_path_approval((v_proposal ->> 'proposalId')::uuid,v_digest,(v_prepared ->> 'snapshotId')::uuid,v_tree);
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(1) ->> 'admitted' = '1','Approved deletion emits one authorized event');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_wake_occurrences where routine_id = (v_routine ->> 'routine_id')::uuid
		and payload ->> 'operation' = 'delete' and payload ->> 'previousVersion' = v_change ->> 'version'),'Deletion retains version and operation metadata');
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',v_trigger,v_client);
	perform pg_temp.wake_assert(v_routine ->> 'version' = '2' and public.qorpera_drain_company_file_wakes(1) ->> 'examined' = '0','Edited listener is also future-only');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_company_file_wake_cursors where routine_id = (v_routine ->> 'routine_id')::uuid and active),'Retired versions leave the bounded scan index');
end
$$;
rollback to file_listener;

savepoint denied_scan;
do $$
declare v_routine jsonb; v_result jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_grant uuid; v_count integer;
begin
	for v_count in 1..6 loop
		v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
			'{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}');
	end loop;
	for v_count in 1..4 loop
		perform pg_temp.path_commit(pg_temp.path_plan('bounded-' || v_count,'bounded-' || v_count || '.md',
			pg_temp.path_stage_file('bounded-' || v_count || '.md','Bounded event')));
	end loop;
	select * into strict v_resource from public.qorpera_company_path_resources where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	-- Every active grant of the recipient on the root, including the default agent read grant (20260828020700).
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	for v_grant in select id from public.qorpera_company_path_grants where resource_id = v_resource.id
		and principal_id = '30000000-0000-4000-8000-000000000031' and revoked_at is null loop
		perform public.qorpera_revoke_company_path(v_resource.id,v_resource.version,v_grant);
	end loop;
	perform pg_temp.path_claims('service_role');
	v_result := public.qorpera_drain_company_file_wakes(2);
	perform pg_temp.wake_assert(v_result = '{"schema":"qorpera.file-wake-drain/v1","scanned":2,"examined":2,"admitted":0}'::jsonb,'Denied history is bounded before candidate examination');
	perform pg_temp.wake_assert((select count(*) = 2 from public.qorpera_company_file_wake_claims where outcome = 'denied'),'Denied claims are terminal, private and bounded');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_wake_occurrences),'No denied event payload reaches the execution queue');
	perform public.qorpera_drain_company_file_wakes(2);
	perform pg_temp.wake_assert((select count(*) = 4 from public.qorpera_company_file_wake_claims),'Drain makes bounded fair progress over listeners');
end
$$;
rollback to denied_scan;

savepoint file_materialization_recheck;
do $$
declare v_routine jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_grant uuid;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}');
	perform pg_temp.path_commit(pg_temp.path_plan('revoke-after-match','note.md',pg_temp.path_stage_file('note.md','Event')));
	perform public.qorpera_drain_company_file_wakes(1);
	select * into strict v_resource from public.qorpera_company_path_resources where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	-- Every active grant of the recipient on the root, including the default agent read grant (20260828020700).
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	for v_grant in select id from public.qorpera_company_path_grants where resource_id = v_resource.id
		and principal_id = '30000000-0000-4000-8000-000000000031' and revoked_at is null loop
		perform public.qorpera_revoke_company_path(v_resource.id,v_resource.version,v_grant);
	end loop;
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(1) = '[]'::jsonb,'File permission rechecked at materialization');
	perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences
		where routine_id = (v_routine ->> 'routine_id')::uuid),'Revoked matched occurrence is terminal');
end
$$;
rollback to file_materialization_recheck;

savepoint requester_revoked;
do $$
declare v_result jsonb;
begin
	perform pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}');
	perform pg_temp.path_commit(pg_temp.path_plan('requester-check','note.md',pg_temp.path_stage_file('note.md','Event')));
	delete from public.qorpera_profile_members where profile_id = '30000000-0000-4000-8000-000000000010'
		and user_id = '30000000-0000-4000-8000-000000000001';
	v_result := public.qorpera_drain_company_file_wakes(1);
	perform pg_temp.wake_assert(v_result ->> 'examined' = '1' and v_result ->> 'admitted' = '0','Current requester membership is checked independently of recipient');
end
$$;
rollback to requester_revoked;

savepoint private_audience;
do $$
declare v_resource jsonb;
begin
	perform pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}');
	perform pg_temp.path_commit(pg_temp.path_plan('private-after-commit','note.md',pg_temp.path_stage_file('note.md','Private now')));
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_resource := public.qorpera_set_company_path_resource('30000000-0000-4000-8000-000000000020','note.md','exact','member_private','normal');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(public.qorpera_drain_company_file_wakes(1) ->> 'admitted' = '0','Owner membership cannot move private events into company audience');
end
$$;
rollback to private_audience;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_company_file_wake_claims','SELECT'), 'Claims are private to ' || v_role);
		perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_company_file_wake_cursors','SELECT'), 'Cursors are private to ' || v_role);
	end loop;
	perform pg_temp.wake_assert(not public.qorpera_cloud_routine_trigger_valid(
		'{"id":"semantic","kind":"listener","source":"company-file","path":"","match":"semantic","timeZone":"UTC"}'),'No semantic matcher is claimed');
	perform pg_temp.wake_error('select public.qorpera_drain_company_file_wakes(65)','42501');
	perform pg_temp.wake_error('select public.qorpera_drain_company_file_wakes(null)','42501');
end
$$;

-- The agent's shared thread is its first public audience; a routine wake is admitted into it.
select pg_temp.path_claims('service_role');
savepoint thread_audience;
do $$
declare v_thread uuid; v_routine jsonb; v_wake uuid;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	update public.qorpera_shared_sessions set status = 'open' where id = '30000000-0000-4000-8000-000000000042';
	perform pg_temp.wake_assert(public.qorpera_wake_public_session('30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000031',null) = v_thread,
		'The agent thread precedes the plain company conversation as the public audience');
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		jsonb_build_object('id','tick','kind','schedule','intervalMinutes',5,'replyPolicy','required'));
	v_wake := pg_temp.wake_schedule(v_routine,'thread-audience');
	perform pg_temp.wake_assert((select session_id from public.qorpera_wake_occurrences where id = v_wake) = v_thread,
		'A reporting routine wake is pinned to the agent thread');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1)) = 1,
		'A routine wake into the agent thread is authorised and materializes');
end
$$;

rollback to thread_audience;

-- A failed post into an agent's thread can be tried again: the member's message stays once, the
-- failed run leaves recovery, and the same input wakes the same agent under a new occurrence key.
savepoint room_retry;
do $$
declare v_thread uuid; v_room uuid; v_result jsonb; v_run uuid; v_binding jsonb; v_retry jsonb; v_retry_run uuid;
	v_base public.qorpera_execution_runs%rowtype; v_member jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_inputs bigint;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	select id into strict v_room from public.qorpera_company_rooms where session_id = v_thread and status = 'active';
	select * into strict v_base from public.qorpera_execution_runs where id = (v_member ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_post_company_room_message(v_room,extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"Bob, are you there?"}',v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_result #>> '{occurrenceIds,0}')::uuid;
	v_binding := pg_temp.wake_start(v_run);
	select count(*) into v_inputs from public.qorpera_session_inputs where session_id = v_thread;

	-- Only a failed delivery can be retried, and only by the author of the post.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select public.qorpera_retry_room_delivery(%L,%L,%s)',v_run,v_base.sponsor_binding_id,
		v_base.sponsor_version),'55000','execution recovery action is unavailable');
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid,repeat('2',64),(v_binding ->> 'jobId')::uuid,
		repeat('3',64),'Native provider bridge request failed (422)',false);
	perform pg_temp.wake_assert((select status = 'failed' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid),
		'The delivery failed the way a runner reports it');
	perform pg_temp.wake_error(format('select public.qorpera_retry_room_delivery(%L,%L,%s)',v_run,v_base.sponsor_binding_id,
		v_base.sponsor_version),'42501','Room retry requires a member');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
	perform pg_temp.wake_error(format('select public.qorpera_retry_room_delivery(%L,%L,%s)',v_run,v_base.sponsor_binding_id,
		v_base.sponsor_version),'42501');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select public.qorpera_retry_room_delivery(%L,%L,%s)',v_run,extensions.gen_random_uuid(),1),
		'42501','Room sponsor is unavailable');

	v_retry := public.qorpera_retry_room_delivery(v_run,v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.wake_assert(v_retry ->> 'inputId' = v_result ->> 'inputId' and v_retry ->> 'runId' = v_run::text,
		'The retry is bound to the failed run and the same input');
	perform pg_temp.wake_error(format('select public.qorpera_retry_room_delivery(%L,%L,%s)',v_run,v_base.sponsor_binding_id,
		v_base.sponsor_version),'55000','execution recovery was already resolved');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_session_inputs where session_id = v_thread) = v_inputs,
		'The member''s message stays once');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_execution_run_events
		where run_id = v_run and event_type = 'recovery_released'),'The failed run leaves recovery');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_retry_run from public.qorpera_wake_occurrences where id = (v_retry ->> 'occurrenceId')::uuid;
	perform pg_temp.wake_assert((select r.source_kind = 'room_delivery' and r.session_id = v_thread and r.id <> v_run
		and r.staff_agent_id = '30000000-0000-4000-8000-000000000031'
		from public.qorpera_execution_runs r where r.id = v_retry_run),'The same agent is woken again for the same post');
	v_binding := pg_temp.wake_start(v_retry_run);
	perform pg_temp.wake_public_send(v_binding,'final','answer-after-retry');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_agent_sends where run_id = v_retry_run),
		'The retried delivery answers in the thread');
end
$$;
rollback to room_retry;

-- An agent edit never ends a run and applies from the agent's next run. A wake admitted at the
-- agent's later version answers in the thread opened at the earlier one; a thread that claims a
-- version its agent never had stays unusable; a member turn keeps its exact version. A run in
-- flight through an edit keeps sending, writing the Company File and reading the charter of its
-- own version; a wake queued through an edit is admitted at the current version. Archiving still
-- ends the agent's runs.
do $$
declare v_thread uuid; v_routine jsonb; v_wake uuid; v_run uuid; v_binding jsonb; v_result jsonb; v_room uuid;
	v_delivery_run uuid; v_delivery jsonb; v_base public.qorpera_execution_runs%rowtype;
	v_charter text; v_row public.qorpera_execution_runs%rowtype; v_queued uuid; v_queued_run uuid; v_queued_binding jsonb;
	v_member jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	update public.qorpera_profile_staff set version = version + 1
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		jsonb_build_object('id','after-edit','kind','schedule','intervalMinutes',5,'replyPolicy','required'));
	v_wake := pg_temp.wake_schedule(v_routine,'thread-after-edit');
	perform pg_temp.wake_assert((select session_id from public.qorpera_wake_occurrences where id = v_wake) = v_thread,
		'An edited agent keeps its thread as the public audience');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake;
	perform pg_temp.wake_assert((select r.session_id = v_thread and r.staff_version > s.staff_version
		from public.qorpera_execution_runs r join public.qorpera_shared_sessions s on s.id = r.session_id where r.id = v_run),
		'The wake runs at the edited agent version inside the thread opened at the earlier one');
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_public_send(v_binding,'progress','thread-after-edit');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_events
		where session_id = v_thread and execution_kind = 'run' and execution_id = v_run),
		'The transcript accepts the wake run although the thread records an earlier agent version');

	-- A member's post into the thread is a room delivery, the path that failed in production. Its
	-- wake authority has no session clause, so the refusal further down is the transcript's own.
	select id into strict v_room from public.qorpera_company_rooms where session_id = v_thread and status = 'active';
	select * into strict v_base from public.qorpera_execution_runs where id = (v_member ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_post_company_room_message(v_room,extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"Bob, are you there?"}',v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_delivery_run from public.qorpera_wake_occurrences where id = (v_result #>> '{occurrenceIds,0}')::uuid;
	perform pg_temp.wake_assert((select r.source_kind = 'room_delivery' and r.session_id = v_thread and r.staff_version > s.staff_version
		from public.qorpera_execution_runs r join public.qorpera_shared_sessions s on s.id = r.session_id where r.id = v_delivery_run),
		'A post into the thread of an edited agent is delivered at the agent''s current version');
	v_delivery := pg_temp.wake_start(v_delivery_run);
	perform pg_temp.wake_public_send(v_delivery,'progress','delivery-after-edit');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_events
		where session_id = v_thread and execution_kind = 'run' and execution_id = v_delivery_run),
		'An edited agent answers a member in its thread');
	update public.qorpera_shared_sessions set staff_version = staff_version + 2 where id = v_thread;
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L,%L)',v_delivery,'progress','thread-ahead-delivery'),
		'PGRST');
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L,%L)',v_binding,'progress','thread-ahead-routine'),
		'42501','Admitted wake authority is unavailable');
	update public.qorpera_shared_sessions set staff_version = staff_version - 2 where id = v_thread;

	update public.qorpera_shared_sessions set staff_version = staff_version + 1
	where id = (select session_id from public.qorpera_execution_runs where id = (v_member ->> 'runId')::uuid);
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L,%L)',v_member,'progress','member-turn-pin'),
		'PGRST');

	select charter into strict v_charter from public.qorpera_profile_staff
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';
	v_queued := pg_temp.wake_schedule(pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		jsonb_build_object('id','queued','kind','schedule','intervalMinutes',5,'replyPolicy','required')),'queued-through-edit');
	update public.qorpera_profile_staff set charter = 'An edited charter that applies from the next run.',display_name = 'Robert',version = version + 1
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';

	-- The run in flight: send, Company File write and its own charter all survive the edit.
	perform pg_temp.wake_public_send(v_binding,'progress','edited-in-flight');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_agent_sends where run_id = v_run
		and idempotency_key = 'edited-in-flight') = 1,'An edit does not end the run in flight');
	perform pg_temp.wake_assert((select speaker.display_name = 'Bob' and speaker.staff_version = send_run.staff_version
		from public.qorpera_agent_sends send join public.qorpera_session_event_speakers speaker on speaker.event_id = send.event_id
		join public.qorpera_execution_runs send_run on send_run.id = send.run_id
		where send.run_id = v_run and send.idempotency_key = 'edited-in-flight'),
		'A run whose agent was renamed meanwhile speaks under the name of its own version');
	perform set_config('qorpera_test.wake_binding',v_binding::text,true);
	perform pg_temp.path_commit(pg_temp.path_plan('edited-in-flight','edited-note.md',
		pg_temp.path_stage_file('edited-note.md','Written by a run whose agent was edited meanwhile.')));
	perform set_config('qorpera_test.wake_binding',v_member::text,true);
	select * into strict v_row from public.qorpera_execution_runs where id = v_run;
	perform pg_temp.wake_assert(public.qorpera_company_context_source(v_row,'job_spec',v_row.staff_agent_id) ->> 'text' = v_charter,
		'A run in flight keeps the charter of its own version');
	perform pg_temp.wake_assert((select (c #>> '{agent,version}')::bigint = v_row.staff_version and c #>> '{agent,name}' = 'Bob'
		from public.qorpera_describe_company_run_context(v_binding) c),
		'A run in flight describes its agent as of its own version');

	-- The wake that waited through the edit is the agent's next run.
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_queued_run from public.qorpera_wake_occurrences where id = v_queued;
	perform pg_temp.wake_assert((select r.staff_version = a.version and r.staff_version > w.staff_version
		from public.qorpera_execution_runs r join public.qorpera_wake_occurrences w on w.run_id = r.id
		join public.qorpera_profile_staff a on a.profile_id = r.profile_id and a.staff_agent_id = r.staff_agent_id
		where r.id = v_queued_run),'A wake queued through an edit is admitted at the current version');
	v_queued_binding := pg_temp.wake_start(v_queued_run);
	perform pg_temp.wake_public_send(v_queued_binding,'progress','queued-through-edit');
	select * into strict v_row from public.qorpera_execution_runs where id = v_queued_run;
	perform pg_temp.wake_assert(public.qorpera_company_context_source(v_row,'job_spec',v_row.staff_agent_id) ->> 'text'
		= 'An edited charter that applies from the next run.','The next run reads the edited charter');
	perform pg_temp.wake_assert((select c #>> '{agent,name}' = 'Robert' from public.qorpera_describe_company_run_context(v_queued_binding) c),
		'The next run describes the edited agent');

	-- Archiving is not an edit: it ends the agent's runs.
	update public.qorpera_profile_staff set employment_status = 'archived',version = version + 1
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L,%L)',v_queued_binding,'progress','after-archive'),
		'42501');
end
$$;
rollback;

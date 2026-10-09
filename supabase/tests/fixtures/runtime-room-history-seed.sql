-- A frozen copy of the wake fixture of 300_runtime_wake_bus.test.sql (its part before "-- END WAKE FIXTURE"), kept because
-- test-runtime-room-history.mjs replays the 13 Sep room-history upgrade on that schema; the legacy sweep deletes 300 in D3.
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
	end loop;
	-- No standing authority: agent wakes are paid by the member who started them (20260928230000).
	perform public.qorpera_configure_session_execution('30000000-0000-4000-8000-000000000042',
		(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn','agent_turn');
end
$$;
select pg_temp.path_claims('service_role');


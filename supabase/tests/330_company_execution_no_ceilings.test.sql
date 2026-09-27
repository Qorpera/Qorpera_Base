-- No company execution ceilings (2026-09-24). A company has no monthly spend,
-- monthly token or hourly wake ceiling: their tables, trip records and member
-- RPCs are gone, and run admission holds only the sponsor's own quota. The
-- company pause remains as an operator brake that members cannot call and
-- that notifies no one. The company fixture reuses the real Company File,
-- staff and session setup from SQL320; the sponsor is a company API-billing
-- connection whose per-run reservation (300 USD) and token budget (110M) are
-- both above the removed kernel defaults (250 USD, 100M tokens).
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


-- A company-owned compute identity and a company API-billing sponsor. The
-- connection version is inserted directly because API-key connection
-- authorization UX is Order 7; its schema and sponsor contracts are real.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.company_identity',public.qorpera_upsert_scoped_compute_identity(
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000150','company',null,'Company API compute',
	'qorpera-company-linux','v1','["agent_turn","company_substrate"]','{"network":"provider-native-only","credentialExport":false}')::text,true);
reset role;
insert into public.qorpera_provider_connections(id,profile_id,client_connection_id,owner_user_id,provider,status,created_by_user_id)
values ('29000000-0000-4000-8000-000000000160','29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000161',
	null,'openai','active','29000000-0000-4000-8000-000000000001');
insert into public.qorpera_provider_connection_versions(connection_id,version,authentication_mode,native_harness,secret_reference,
	provider_account_reference,billing_source,consent_version,consented_by_user_id,allow_autonomous,quota_policy,created_by_user_id)
values ('29000000-0000-4000-8000-000000000160',1,'api_key','api','secret://fixture/company-openai-api-key',null,
	'company_api_billing','qorpera-company-api-consent/v1','29000000-0000-4000-8000-000000000001',false,
	'{"monthly_microusd":1000000000,"reservation_microusd":300000000,"max_calls_per_run":32,"max_input_tokens_per_run":90000000,"max_output_tokens_per_run":20000000,"max_concurrent_runs":4}',
	'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_bindings(id,profile_id,client_binding_id,status,created_by_user_id)
values ('29000000-0000-4000-8000-000000000170','29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000171',
	'active','29000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id,version,sponsor_kind,provider_connection_id,
	provider_connection_version,allow_autonomous,created_by_user_id)
values ('29000000-0000-4000-8000-000000000170',1,'company_api_billing','29000000-0000-4000-8000-000000000160',1,false,
	'29000000-0000-4000-8000-000000000001');

create function pg_temp.company_turn(p_input uuid,p_request uuid)
returns jsonb language sql as $$
	select public.qorpera_request_session_turn_v2(
		'29000000-0000-4000-8000-000000000040',p_input,p_request,
		'{"schema":"qorpera.session-prompt/v1","text":"Summarize the company note.","images":[]}','company_connection',
		'29000000-0000-4000-8000-000000000170',1,null,
		(current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')
$$;

-- The ceilings are gone as policy: no table, no trip record, no RPC, and no
-- running function names them.
do $$
begin
	if to_regclass('public.qorpera_company_execution_ceilings') is not null
		or to_regclass('public.qorpera_company_ceiling_trips') is not null
		or to_regprocedure('public.qorpera_company_execution_ceiling(uuid)') is not null
		or to_regprocedure('public.qorpera_company_execution_ceiling_json(uuid)') is not null
		or to_regprocedure('public.qorpera_company_wakes_last_hour(uuid)') is not null
		or to_regprocedure('public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint)') is not null then
		raise exception 'A company ceiling object still exists'; end if;
	if exists (select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public' and (procedure.prosrc like '%ceiling_trips%'
			or procedure.prosrc like '%qorpera_company_execution_ceiling%' or procedure.prosrc like '%wakes_last_hour%'
			or procedure.prosrc like '%company-ceiling-tripped%')) then
		raise exception 'A function still enforces or reports a company ceiling'; end if;
	if exists (select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and procedure.proname in ('qorpera_pin_wake_occurrence','qorpera_drain_worker_wakes')
			and procedure.prosrc not like '%qorpera_company_execution_paused%') then
		raise exception 'Wake admission lost the pause'; end if;
end
$$;

-- A run whose reservation and token budget are both above the old kernel
-- defaults is admitted with its exact reservation, and nobody is notified.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.company_turn_1',pg_temp.company_turn(
	'29000000-0000-4000-8000-000000000180','29000000-0000-4000-8000-000000000181')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_request uuid := (current_setting('qorpera_test.company_turn_1')::jsonb ->> 'turn_request_id')::uuid;
begin
	if not exists (select 1 from public.qorpera_execution_runs run
		join public.qorpera_execution_sponsor_reservations reservation on reservation.run_id = run.id
		join public.qorpera_runner_model_policies policy on policy.job_id = reservation.job_id
		where run.source_id = v_request and reservation.status = 'reserved' and reservation.reserved_microusd = 300000000
			and reservation.provider_connection_id = '29000000-0000-4000-8000-000000000160'
			and policy.max_input_tokens + policy.max_output_tokens = 110000000)
		or exists (select 1 from public.qorpera_member_notifications
			where profile_id = '29000000-0000-4000-8000-000000000010') then
		raise exception 'A run above the old company ceiling defaults was refused or notified'; end if;
end
$$;

-- An API-billing connection has no monthly budget either (runtime v92): the
-- first run already holds the whole 300,000,000-unit monthly figure of
-- version 2, and a second run is still admitted. Its concurrency still holds:
-- version 3 allows two runs at once, and a third request is refused.
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
 to_jsonb(v)||jsonb_build_object('version',2,'quota_policy',v.quota_policy||'{"monthly_microusd":300000000}'::jsonb))).*
from public.qorpera_provider_connection_versions v
where connection_id='29000000-0000-4000-8000-000000000160' and version=1;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
 to_jsonb(v)||jsonb_build_object('version',3,'quota_policy',v.quota_policy||'{"max_concurrent_runs":2}'::jsonb))).*
from public.qorpera_provider_connection_versions v
where connection_id='29000000-0000-4000-8000-000000000160' and version=1;
insert into public.qorpera_execution_sponsor_versions
select (jsonb_populate_record(null::public.qorpera_execution_sponsor_versions,
 to_jsonb(v)||jsonb_build_object('version',n,'provider_connection_version',n))).*
from public.qorpera_execution_sponsor_versions v, generate_series(2,3) n
where binding_id='29000000-0000-4000-8000-000000000170' and version=1;
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
 appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000031','Quota agent','Research','Check API quota.',
 'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'29000000-0000-4000-8000-000000000001'),
 ('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000032','Second quota agent','Research','Check API concurrency.',
 'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
 created_by_user_id,staff_agent_id,staff_version,execution_scope)
values ('29000000-0000-4000-8000-000000000190','29000000-0000-4000-8000-000000000191',
 '29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020','Quota session','open',
 '29000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000031',1,'{}'),
 ('29000000-0000-4000-8000-000000000192','29000000-0000-4000-8000-000000000193',
 '29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020','Concurrency session','open',
 '29000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000032',1,'{}');
create function pg_temp.quota_turn(p_session uuid,p_sponsor_version bigint)
returns jsonb language sql as $$
	select public.qorpera_request_session_turn_v2(
		p_session,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"Check API quota.","images":[]}','company_connection',
		'29000000-0000-4000-8000-000000000170',p_sponsor_version,null,
		(current_setting('qorpera_test.company_identity')::jsonb->>'compute_identity_id')::uuid,
		null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.connection_quota_request',
 pg_temp.quota_turn('29000000-0000-4000-8000-000000000190',2)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_request uuid:=(current_setting('qorpera_test.connection_quota_request')::jsonb->>'turn_request_id')::uuid;
begin
 if not exists(select 1 from public.qorpera_execution_runs run
   join public.qorpera_execution_sponsor_reservations reservation on reservation.run_id=run.id
   where run.source_id=v_request and reservation.status='reserved')
  or (select count(*) from public.qorpera_execution_sponsor_reservations
   where provider_connection_id='29000000-0000-4000-8000-000000000160' and status='reserved')<>2 then
  raise exception 'An API connection still refused a run over its monthly figure'; end if;
end $$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.connection_concurrency_request',
 pg_temp.quota_turn('29000000-0000-4000-8000-000000000192',3)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_request uuid:=(current_setting('qorpera_test.connection_concurrency_request')::jsonb->>'turn_request_id')::uuid;
begin
 if not exists(select 1 from public.qorpera_session_turn_requests where id=v_request and status='failed')
  or exists(select 1 from public.qorpera_execution_runs where source_id=v_request)
  or (select count(*) from public.qorpera_execution_sponsor_reservations
   where provider_connection_id='29000000-0000-4000-8000-000000000160' and status='reserved')<>2 then
  raise exception 'API connection concurrency was bypassed'; end if;
end $$;

-- The pause is an operator brake. No API role may call it; an operator
-- session acting with a founder's claims pauses and resumes as the runtime
-- cut does, a contributor's claims are still refused, and no member is
-- notified either way. The removed notice kinds are refused outright.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_set_company_execution_pause(uuid,boolean,text)','EXECUTE') then
			raise exception 'Company pause is callable by %',v_role; end if;
	end loop;
end
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
	perform public.qorpera_set_company_execution_pause('29000000-0000-4000-8000-000000000010',true,'member');
	raise exception 'A member paused the company';
exception when insufficient_privilege then null;
end
$$;
reset role;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_set_company_execution_pause('29000000-0000-4000-8000-000000000010',true,'runtime update');
	if not (v_result ->> 'paused')::boolean or not (v_result ->> 'changed')::boolean
		or not public.qorpera_company_execution_paused('29000000-0000-4000-8000-000000000010') then
		raise exception 'Operator pause did not hold'; end if;
	v_result := public.qorpera_set_company_execution_pause('29000000-0000-4000-8000-000000000010',false,'runtime update');
	if (v_result ->> 'paused')::boolean or public.qorpera_company_execution_paused('29000000-0000-4000-8000-000000000010') then
		raise exception 'Operator resume did not hold'; end if;
	if exists (select 1 from public.qorpera_member_notifications where profile_id = '29000000-0000-4000-8000-000000000010') then
		raise exception 'Pause or resume notified a member'; end if;
end
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
do $$
begin
	perform public.qorpera_set_company_execution_pause('29000000-0000-4000-8000-000000000010',true,'contributor');
	raise exception 'A contributor paused the company';
exception when insufficient_privilege then null;
end
$$;
do $$
declare v_kind text;
begin
	foreach v_kind in array array['company_execution_paused','company_execution_resumed'] loop
		begin
			insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
			values ('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000001',v_kind,'{}','removed-kind');
			raise exception 'Removed notice kind % was accepted',v_kind;
		exception when check_violation then null; end;
	end loop;
end
$$;
set constraints all immediate;
rollback;

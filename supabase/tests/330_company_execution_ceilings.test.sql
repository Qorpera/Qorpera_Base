-- Contract section 7.4: kernel-owned per-company spend and token ceilings for
-- sponsors without a provider-side usage wall, enforced at run admission by
-- the control plane, with trip evidence and founder notification. The company
-- fixture below reuses the real Company File, staff and session setup from
-- SQL320; the sponsor is a company API-billing connection, which has no
-- provider usage wall. No authority helper is replaced.
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
	'{"monthly_microusd":100000000,"reservation_microusd":5000000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":4}',
	'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_bindings(id,profile_id,client_binding_id,status,created_by_user_id)
values ('29000000-0000-4000-8000-000000000170','29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000171',
	'active','29000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id,version,sponsor_kind,provider_connection_id,
	provider_connection_version,allow_autonomous,created_by_user_id)
values ('29000000-0000-4000-8000-000000000170',1,'company_api_billing','29000000-0000-4000-8000-000000000160',1,false,
	'29000000-0000-4000-8000-000000000001');

create function pg_temp.ceiling_turn(p_input uuid,p_request uuid)
returns jsonb language sql as $$
	select public.qorpera_request_session_turn_v2(
		'29000000-0000-4000-8000-000000000040',p_input,p_request,
		'{"schema":"qorpera.session-prompt/v1","text":"Summarize the company note.","images":[]}','company_connection',
		'29000000-0000-4000-8000-000000000170',1,null,
		(current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id')::uuid,
		null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')
$$;

-- Every company has ceilings: unconfigured companies report the kernel
-- default; only founders can change them, with exact version control.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_ceiling jsonb;
begin
	v_ceiling := public.qorpera_company_execution_ceiling_json('29000000-0000-4000-8000-000000000010');
	if (v_ceiling ->> 'configured')::boolean or (v_ceiling ->> 'spend_microusd_per_period')::bigint <> 250000000
		or (v_ceiling ->> 'tokens_per_period')::bigint <> 100000000 or (v_ceiling ->> 'version')::bigint <> 0
		or (v_ceiling ->> 'spend_microusd_used')::bigint <> 0 or (v_ceiling ->> 'trips')::bigint <> 0 then
		raise exception 'Unconfigured company did not report the kernel default ceiling'; end if;
	begin
		perform public.qorpera_set_company_execution_ceiling('29000000-0000-4000-8000-000000000010',1000000,100,7);
		raise exception 'Stale ceiling version accepted';
	exception when sqlstate 'PT412' then null; end;
	v_ceiling := public.qorpera_set_company_execution_ceiling('29000000-0000-4000-8000-000000000010',1000000,100,0);
	if not (v_ceiling ->> 'configured')::boolean or (v_ceiling ->> 'version')::bigint <> 1
		or (v_ceiling ->> 'spend_microusd_per_period')::bigint <> 1000000 then
		raise exception 'Founder ceiling was not recorded'; end if;
end
$$;
select set_config('qorpera_test.ceiling_turn_1',pg_temp.ceiling_turn(
	'29000000-0000-4000-8000-000000000180','29000000-0000-4000-8000-000000000181')::text,true);
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
	begin
		perform public.qorpera_set_company_execution_ceiling('29000000-0000-4000-8000-000000000010',1,1,1);
		raise exception 'Contributor changed the company ceiling';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

-- Admission refuses the run at the spend ceiling: no reservation, no run,
-- a durable trip record, and one notification to each founder from the
-- control plane. The contributor and viewer are not notified.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_request uuid := (current_setting('qorpera_test.ceiling_turn_1')::jsonb ->> 'turn_request_id')::uuid;
begin
	if not exists (select 1 from public.qorpera_session_turn_requests request
		where request.id = v_request and request.status = 'failed' and request.failure_reason is not null)
		or exists (select 1 from public.qorpera_execution_sponsor_reservations reservation
			where reservation.profile_id = '29000000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs run where run.source_id = v_request)
		or (select count(*) from public.qorpera_company_ceiling_trips trip
			where trip.profile_id = '29000000-0000-4000-8000-000000000010' and trip.dimension = 'spend'
				and trip.attempted = 5000000 and trip.used = 0 and trip.ceiling = 1000000
				and trip.period_start = date_trunc('month',statement_timestamp())) <> 1
		or (select count(*) from public.qorpera_member_notifications notification
			where notification.profile_id = '29000000-0000-4000-8000-000000000010'
				and notification.kind = 'company_ceiling_tripped') <> 1
		or not exists (select 1 from public.qorpera_member_notifications notification
			where notification.user_id = '29000000-0000-4000-8000-000000000001'
				and notification.kind = 'company_ceiling_tripped' and notification.acknowledged_at is null
				and notification.subject ->> 'dimension' = 'spend'
				and (notification.subject ->> 'connectionId')::uuid = '29000000-0000-4000-8000-000000000160'
				and notification.subject::text !~ 'secret|api-key|token|prompt') then
		raise exception 'Spend ceiling did not refuse admission with trip evidence and founder notification'; end if;
end
$$;

-- Raising the ceiling admits the next run; the reservation and its token
-- policy count against the period, and the ceiling view shows the use.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_execution_ceiling('29000000-0000-4000-8000-000000000010',1000000000,100000000,1);
select set_config('qorpera_test.ceiling_turn_2',pg_temp.ceiling_turn(
	'29000000-0000-4000-8000-000000000182','29000000-0000-4000-8000-000000000183')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_request uuid := (current_setting('qorpera_test.ceiling_turn_2')::jsonb ->> 'turn_request_id')::uuid;
begin
	if not exists (select 1 from public.qorpera_execution_runs run
		join public.qorpera_execution_sponsor_reservations reservation on reservation.run_id = run.id
		where run.source_id = v_request and reservation.status = 'reserved' and reservation.reserved_microusd = 5000000
			and reservation.provider_connection_id = '29000000-0000-4000-8000-000000000160')
		or (select count(*) from public.qorpera_company_ceiling_trips trip
			where trip.profile_id = '29000000-0000-4000-8000-000000000010') <> 1 then
		raise exception 'Raised ceiling did not admit the run with an exact reservation'; end if;
end
$$;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_ceiling jsonb := public.qorpera_company_execution_ceiling_json('29000000-0000-4000-8000-000000000010');
begin
	if (v_ceiling ->> 'version')::bigint <> 2 or (v_ceiling ->> 'spend_microusd_used')::bigint <> 5000000
		or (v_ceiling ->> 'tokens_used')::bigint <> 2500000 or (v_ceiling ->> 'trips')::bigint <> 1 then
		raise exception 'Ceiling view did not reflect period use and trips'; end if;
	if jsonb_array_length(public.qorpera_list_member_notifications('29000000-0000-4000-8000-000000000010')) <> 1 then
		raise exception 'Founder did not receive exactly one ceiling notification'; end if;
end
$$;
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
	if jsonb_array_length(public.qorpera_list_member_notifications('29000000-0000-4000-8000-000000000010')) <> 0 then
		raise exception 'A non-founder member received a ceiling notification'; end if;
end
$$;
reset role;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_table_privilege(v_role,'public.qorpera_company_execution_ceilings','SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role,'public.qorpera_company_ceiling_trips','SELECT,INSERT,UPDATE,DELETE')
			or has_function_privilege(v_role,'public.qorpera_company_execution_ceiling(uuid)','EXECUTE') then
			raise exception 'Company ceiling table or helper exposed to %',v_role; end if;
	end loop;
	if has_function_privilege('service_role','public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint)','EXECUTE')
		or not has_function_privilege('authenticated','public.qorpera_company_execution_ceiling_json(uuid)','EXECUTE') then
		raise exception 'Company ceiling authority is exposed or unavailable'; end if;
end
$$;
set constraints all immediate;
rollback;

-- Account wall regression reuses the isolated company fixture from SQL320.
-- Real admission, assignment and native-lease contracts; no substituted
-- authority helper. Storage fixtures below stand in only for verified bytes.
begin;

insert into auth.users(id,email) values
	('16400000-0000-4000-8000-000000000001','path-owner@example.test'),
	('16400000-0000-4000-8000-000000000002','path-member@example.test'),
	('16400000-0000-4000-8000-000000000003','path-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('16400000-0000-4000-8000-000000000010','Path gateway fixture','16400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000002','path-member@example.test','Member','contributor'),
	('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('16400000-0000-4000-8000-000000000020','16400000-0000-4000-8000-000000000010','Environment',1,'16400000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','16400000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','16400000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('16400000-0000-4000-8000-000000000010',v_manifest);
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
	values ('qorpera-profile-objects','16400000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('16400000-0000-4000-8000-000000000010',v_manifest);
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
select pg_temp.path_claims('authenticated','16400000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '16400000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'16400000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '16400000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('16400000-0000-4000-8000-000000000025','16400000-0000-4000-8000-000000000010',
	'16400000-0000-4000-8000-000000000020','16400000-0000-4000-8000-000000000023',
	'16400000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'16400000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '16400000-0000-4000-8000-000000000027',profile_id,'16400000-0000-4000-8000-000000000020','company_snapshot',
	'16400000-0000-4000-8000-000000000023','16400000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'16400000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where sha256 = current_setting('qorpera_test.path_tree')
	and profile_id = '16400000-0000-4000-8000-000000000010';
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '16400000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where sha256 = current_setting('qorpera_test.path_tree') and profile_id = '16400000-0000-4000-8000-000000000010';
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '16400000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('16400000-0000-4000-8000-000000000027','16400000-0000-4000-8000-000000000010',
	'16400000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'16400000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '16400000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '16400000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '16400000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '16400000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('16400000-0000-4000-8000-000000000020',
	'16400000-0000-4000-8000-000000000023','16400000-0000-4000-8000-000000000001');
reset role;

insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000030','Agent','Research','Read and change the Company File.',
	'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'16400000-0000-4000-8000-000000000001');
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,staff_agent_id,staff_version,execution_scope)
values ('16400000-0000-4000-8000-000000000040','16400000-0000-4000-8000-000000000041',
	'16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000020','Path session','open',
	'16400000-0000-4000-8000-000000000001','16400000-0000-4000-8000-000000000030',1,'{}');

select pg_temp.path_claims('authenticated','16400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.path_identity',public.qorpera_upsert_member_compute_identity(
	'16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000050','Path identity','qorpera-member-linux','v1',
	'["agent_turn","company_substrate"]','{"network":"provider-native-only","credentialExport":false}')::text,true);
select set_config('qorpera_test.path_login',public.qorpera_begin_native_provider_login(
	'16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000051','16400000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('a',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.path_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.path_login')::jsonb ->> 'login_id')::uuid,repeat('a',64),'16400000-0000-4000-8000-000000000060',
	'object://native-capsules/16400000-0000-4000-8000-000000000060',repeat('b',64),'fixture-openai-account','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}')::text,true);
reset role;
select pg_temp.path_claims('authenticated','16400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.path_sponsor',public.qorpera_create_member_execution_sponsor(
	'16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid,1,false)::text,true);
reset role;

-- These synthetic queued records only satisfy the signal's immutable foreign
-- keys. No orchestrator, model call, global queue drain or live account is used.
insert into public.qorpera_runner_jobs(id,profile_id,environment_id,substrate_version_id,client_job_id,
    required_capability,job_type,payload,created_by_user_id)
values ('16400000-0000-4000-8000-000000000070','16400000-0000-4000-8000-000000000010',
    '16400000-0000-4000-8000-000000000020','16400000-0000-4000-8000-000000000025',
    '16400000-0000-4000-8000-000000000070','agent_turn','agent_turn','{}','16400000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,job_id,
    substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,sponsor_binding_id,sponsor_version,
    required_capability,job_type,payload_sha256,transcript_start_sequence,created_by_user_id,compute_identity_id)
values ('16400000-0000-4000-8000-000000000071','16400000-0000-4000-8000-000000000010',
    '16400000-0000-4000-8000-000000000020','system','16400000-0000-4000-8000-000000000071',
    '16400000-0000-4000-8000-000000000070','16400000-0000-4000-8000-000000000025',
    '16400000-0000-4000-8000-000000000023','16400000-0000-4000-8000-000000000030',1,
    (current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid,1,
    'agent_turn','agent_turn',repeat('a',64),0,'16400000-0000-4000-8000-000000000001',
    (current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid);
insert into public.qorpera_provider_connection_usage_signals(profile_id,run_id,job_id,sponsor_binding_id,sponsor_version,
    provider_connection_id,provider_connection_version,provider,signal_kind,source,resets_at)
values ('16400000-0000-4000-8000-000000000010','16400000-0000-4000-8000-000000000071',
    '16400000-0000-4000-8000-000000000070',(current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid,1,
    (current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid,1,'openai','usage_limit','native_adapter',
    clock_timestamp()+interval '2 hours');
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_identity)
values ((current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid,1,repeat('a',64));

create function pg_temp.wall_account(p_profile uuid,p_user uuid,p_identity uuid,p_client uuid,p_hash text)
returns uuid language plpgsql as $$
declare login jsonb; connection jsonb;
begin
    perform pg_temp.path_claims('authenticated',p_user);
    login := public.qorpera_begin_native_provider_login(p_profile,extensions.gen_random_uuid(),p_client,p_identity,
        'openai','codex-cli',repeat('a',64),900);
    perform pg_temp.path_claims('service_role');
    connection := public.qorpera_complete_native_provider_login((login ->> 'login_id')::uuid,repeat('a',64),
        extensions.gen_random_uuid(),'object://wall-fixture/' || p_client,repeat('b',64),'same-display-reference',
        'personal-subscription','qorpera-native-provider-consent/v1',
        '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
    perform pg_temp.path_claims('authenticated',p_user);
    perform public.qorpera_create_member_execution_sponsor(p_profile,extensions.gen_random_uuid(),
        (connection ->> 'connection_id')::uuid,(connection ->> 'version')::bigint,false);
    insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_identity,provider_account_usage)
    values ((connection ->> 'connection_id')::uuid,(connection ->> 'version')::bigint,p_hash,
        jsonb_build_object('observedAt',clock_timestamp(),'windows',jsonb_build_array(
            jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));
    return (connection ->> 'connection_id')::uuid;
end $$;

do $$
declare profile_id uuid := '16400000-0000-4000-8000-000000000010';
    owner_id uuid := '16400000-0000-4000-8000-000000000001';
    identity_id uuid := (current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid;
    original_id uuid := (current_setting('qorpera_test.path_connection')::jsonb ->> 'connection_id')::uuid;
    duplicate_id uuid; different_id uuid; foreign_id uuid; foreign_identity uuid;
    rotated_version public.qorpera_provider_connection_versions%rowtype;
begin
    duplicate_id := pg_temp.wall_account(profile_id,owner_id,identity_id,extensions.gen_random_uuid(),repeat('a',64));
    different_id := pg_temp.wall_account(profile_id,owner_id,identity_id,extensions.gen_random_uuid(),repeat('b',64));
    if public.qorpera_native_account_remaining(original_id,1) <> 0
      or public.qorpera_native_account_remaining(duplicate_id,1) <> 0 then
        raise exception 'Usage wall did not propagate to another login for the same account'; end if;
    if public.qorpera_native_account_remaining(different_id,1) <> 80 then
        raise exception 'Display-reference equality was mistaken for provider account identity'; end if;
    if exists(select 1 from public.qorpera_eligible_member_accounts(profile_id,owner_id) where connection_id=duplicate_id) then
        raise exception 'Same-account duplicate remained eligible after a usage wall'; end if;

    perform pg_temp.path_claims('authenticated','16400000-0000-4000-8000-000000000002');
    foreign_identity := (public.qorpera_upsert_member_compute_identity(profile_id,extensions.gen_random_uuid(),
        'Other member','qorpera-member-linux','v1','["agent_turn"]','{}') ->> 'compute_identity_id')::uuid;
    foreign_id := pg_temp.wall_account(profile_id,'16400000-0000-4000-8000-000000000002',foreign_identity,
        extensions.gen_random_uuid(),repeat('a',64));
    if public.qorpera_native_account_remaining(foreign_id,1) <> 80 then
        raise exception 'Usage wall leaked across members'; end if;

    insert into public.qorpera_profiles(id,name,created_by_user_id)
    values ('16400000-0000-4000-8000-000000000110','Other company',owner_id);
    insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
    values ('16400000-0000-4000-8000-000000000110',owner_id,'path-owner@example.test','Owner','owner');
    perform pg_temp.path_claims('authenticated',owner_id);
    foreign_identity := (public.qorpera_upsert_member_compute_identity('16400000-0000-4000-8000-000000000110',
        extensions.gen_random_uuid(),'Other company','qorpera-member-linux','v1','["agent_turn"]','{}') ->> 'compute_identity_id')::uuid;
    foreign_id := pg_temp.wall_account('16400000-0000-4000-8000-000000000110',owner_id,foreign_identity,
        extensions.gen_random_uuid(),repeat('a',64));
    if public.qorpera_native_account_remaining(foreign_id,1) <> 80 then
        raise exception 'Usage wall leaked across companies'; end if;

    -- Version the original connection onto account B's separately issued
    -- capsule. Login client correlation itself is intentionally single-use.
    select * into strict rotated_version from public.qorpera_provider_connection_versions
        where connection_id=different_id and version=1;
    rotated_version.connection_id := original_id;
    rotated_version.version := 2;
    insert into public.qorpera_provider_connection_versions select rotated_version.*;
    insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_identity,provider_account_usage)
    select original_id,2,provider_account_identity,provider_account_usage
        from public.qorpera_native_provider_account_metadata where connection_id=different_id and connection_version=1;
    perform pg_temp.path_claims('authenticated',owner_id);
    perform public.qorpera_create_member_execution_sponsor(profile_id,extensions.gen_random_uuid(),original_id,2,false);
    if public.qorpera_native_account_remaining(original_id,2) <> 80
      or public.qorpera_native_account_remaining(different_id,1) <> 80 then
        raise exception 'Historical account wall blocked the new provider account'; end if;
    if public.qorpera_native_account_remaining(duplicate_id,1) <> 0 then
        raise exception 'Rotation erased the still-current old account wall'; end if;
    if not exists(select 1 from public.qorpera_eligible_member_accounts(profile_id,owner_id) where connection_id=original_id) then
        raise exception 'Redundant usage predicate excluded the rotated account'; end if;
end $$;
set constraints all immediate;
rollback;

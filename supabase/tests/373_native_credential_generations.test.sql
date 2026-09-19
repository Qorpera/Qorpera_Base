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
	'native-capsule/29000000-0000-4000-8000-000000000060',repeat('b',64),'fixture-openai-account','personal-subscription',
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
reset role;
create function pg_temp.credential_start_fixture() returns void language plpgsql as $$
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
select set_config('qorpera_test.credential_bundle',(select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle where singleton),true);
-- Probe admission and drain in a disposable subtransaction. The later positive
-- path adopts before its first lease; no terminal lease is ever revived.
savepoint credential_adoption_probe;
set local role service_role;
select pg_temp.credential_start_fixture();
reset role;

-- No VM/provider process exists in this fixture. The digest below stands in
-- only for an operator's physical-drain evidence, never a live acceptance proof.
set local role service_role;
do $$
declare b jsonb:=current_setting('qorpera_test.path_binding')::jsonb||'{"computeIdentityEpoch":0}';
 capsule uuid:=(b->>'credentialCapsuleId')::uuid; bundle text:=current_setting('qorpera_test.credential_bundle');
begin
 begin
  perform public.qorpera_read_native_credential_generation(b);
  raise exception 'Unadopted credential restored';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_adopt_native_credential_generations(capsule,0,bundle,null);
  raise exception 'Missing physical drain accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_adopt_native_credential_generations(capsule,1,bundle,repeat('d',64));
  raise exception 'Old identity epoch adopted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_adopt_native_credential_generations(capsule,0,repeat('f',64),repeat('d',64));
  raise exception 'Unaccepted runtime adopted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_adopt_native_credential_generations(capsule,0,bundle,repeat('d',64));
  raise exception 'Active lease adopted without drain';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
update public.qorpera_native_provider_connection_leases
set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute'
where id=(current_setting('qorpera_test.path_binding')::jsonb->>'leaseId')::uuid;
set local role service_role;
do $$
begin
 begin
  perform public.qorpera_adopt_native_credential_generations('29000000-0000-4000-8000-000000000060',0,
   current_setting('qorpera_test.credential_bundle'),repeat('d',64));
  raise exception 'Expired active lease adopted without physical drain';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
update public.qorpera_native_provider_connection_leases set status='revoked',released_at=clock_timestamp()
where id=(current_setting('qorpera_test.path_binding')::jsonb->>'leaseId')::uuid;
set local role service_role;
do $$
begin
 begin
  perform public.qorpera_read_native_credential_generation(current_setting('qorpera_test.path_binding')::jsonb||'{"computeIdentityEpoch":0}');
  raise exception 'Revoked probe lease read generation';
 exception when insufficient_privilege then null; end;
end $$;
-- Discard only the negative-probe execution. Canonical claim/provision/assign
-- run again after adoption to establish a fresh first lease for the real test.
rollback to savepoint credential_adoption_probe;
release savepoint credential_adoption_probe;
set local role service_role;
do $$
declare capsule uuid:='29000000-0000-4000-8000-000000000060';
 bundle text:=current_setting('qorpera_test.credential_bundle'); receipt jsonb;
begin
 receipt:=public.qorpera_adopt_native_credential_generations(capsule,0,bundle,repeat('d',64));
 if receipt is distinct from public.qorpera_adopt_native_credential_generations(capsule,0,bundle,repeat('d',64)) then
  raise exception 'Adoption receipt changed'; end if;
 begin
  perform public.qorpera_adopt_native_credential_generations(capsule,0,bundle,repeat('e',64));
  raise exception 'Conflicting physical drain replaced';
 exception when insufficient_privilege then null; end;
end $$;
select pg_temp.credential_start_fixture();
reset role;

do $$
begin
 if has_table_privilege('service_role','public.qorpera_native_credential_adoptions','UPDATE')
  or has_function_privilege('qorpera_secret_broker','public.qorpera_adopt_native_credential_generations(uuid,bigint,text,text)','EXECUTE')
  or has_table_privilege('service_role','public.qorpera_native_credential_generations','UPDATE')
  or has_table_privilege('qorpera_secret_broker','public.qorpera_native_credential_generations','SELECT')
  or has_function_privilege('service_role','public.qorpera_assert_native_credential_binding(jsonb)','EXECUTE')
  or has_function_privilege('qorpera_secret_broker','public.qorpera_read_native_credential_generation(jsonb)','EXECUTE') then
  raise exception 'Credential ownership privilege boundary differs'; end if;
end $$;
-- All authority below is the real admitted native lease, not a replaced validator.
set local role service_role;
do $$
declare b jsonb:=current_setting('qorpera_test.path_binding')::jsonb || '{"computeIdentityEpoch":0}'::jsonb;
 v_snapshot jsonb; owner uuid:='37300000-0000-4000-8000-000000000001';
 candidate text:='native-capsule/29000000-0000-4000-8000-000000000060/generations/37300000-0000-4000-8000-000000000001';
begin
 v_snapshot:=public.qorpera_read_native_credential_generation(b);
 if v_snapshot->>'state'<>'ready' or (v_snapshot->>'generation')::integer<>0 then raise exception 'Initial generation differs'; end if;
 begin
  perform public.qorpera_read_native_credential_generation(b||'{"computeIdentityEpoch":1}');
  raise exception 'Old identity epoch accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_read_native_credential_generation(b||'{"arbitrary":true}');
  raise exception 'Unknown credential binding accepted';
 exception when insufficient_privilege then null; end;
 v_snapshot:=public.qorpera_claim_native_credential_refresh(b,0,owner,repeat('1',64),candidate);
 if v_snapshot->>'state'<>'refreshing' or v_snapshot->>'ownerId'<>owner::text then raise exception 'Owner not acquired'; end if;
 -- A reply lost after claim cannot be treated as a fresh authorization.
 begin
  perform public.qorpera_claim_native_credential_refresh(b,0,owner,repeat('1',64),candidate);
  raise exception 'Ambiguous claim replay admitted';
 exception when object_not_in_prerequisite_state then null; end;
 begin
  perform public.qorpera_claim_native_credential_refresh(b,0,'37300000-0000-4000-8000-000000000002',repeat('2',64),
   'native-capsule/29000000-0000-4000-8000-000000000060/generations/37300000-0000-4000-8000-000000000002');
  raise exception 'Concurrent owner acquired refresh';
 exception when object_not_in_prerequisite_state then null; end;
 begin
  perform public.qorpera_publish_native_credential_generation(b,0,owner,repeat('2',64),candidate,repeat('a',64));
  raise exception 'Wrong owner token published';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_publish_native_credential_generation(b||'{"computeIdentityEpoch":1}',0,owner,repeat('1',64),candidate,repeat('a',64));
  raise exception 'Stale identity published';
 exception when insufficient_privilege then null; end;
 v_snapshot:=public.qorpera_publish_native_credential_generation(b,0,owner,repeat('1',64),candidate,repeat('a',64));
 if v_snapshot->>'state'<>'ready' or (v_snapshot->>'generation')::integer<>1 or v_snapshot->>'reference'<>candidate
  or v_snapshot->>'ciphertextSha256'<>repeat('a',64) or v_snapshot->'ownerId'<>'null'::jsonb then raise exception 'Publication differs'; end if;
 if public.qorpera_publish_native_credential_generation(b,0,owner,repeat('1',64),candidate,repeat('a',64))<>v_snapshot then
  raise exception 'Lost publication response not idempotent'; end if;
 begin
  perform public.qorpera_publish_native_credential_generation(b,0,owner,repeat('1',64),candidate,repeat('b',64));
  raise exception 'Conflicting publication accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.qorpera_claim_native_credential_refresh(b,0,owner,repeat('1',64),candidate);
  raise exception 'Stale generation restored';
 exception when object_not_in_prerequisite_state then null; end;
 v_snapshot:=public.qorpera_claim_native_credential_refresh(b,1,owner,repeat('1',64),candidate);
 perform public.qorpera_fail_native_credential_refresh(b,1,owner,repeat('1',64),candidate);
 v_snapshot:=public.qorpera_read_native_credential_generation(b);
 if v_snapshot->>'state'<>'recovery-required' then raise exception 'Unknown refresh did not retain fence'; end if;
 begin
  perform public.qorpera_claim_native_credential_refresh(b,1,owner,repeat('1',64),candidate);
  raise exception 'Unknown refresh replayed';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
-- Revoked or expired authority cannot recover a candidate or read a generation.
update public.qorpera_native_provider_connection_leases set status='revoked',released_at=clock_timestamp()
where id=(current_setting('qorpera_test.path_binding')::jsonb->>'leaseId')::uuid;
set local role service_role;
do $$
begin
 begin
  perform public.qorpera_read_native_credential_generation(current_setting('qorpera_test.path_binding')::jsonb||'{"computeIdentityEpoch":0}');
  raise exception 'Revoked lease read generation';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
 begin
  perform public.qorpera_read_native_credential_generation(current_setting('qorpera_test.path_binding')::jsonb||'{"computeIdentityEpoch":0}');
  raise exception 'Member directly read credential generation';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;

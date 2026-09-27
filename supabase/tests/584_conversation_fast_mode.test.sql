-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Thread fast mode (2026-09-27): a member's Codex turn in a conversation runs
-- on the Fast tier unless that conversation's Model menu turned it off. Other
-- work runs at standard speed, and a bundle without fast mode pins no tier.
reset role;

-- Two copies of the active bundle, one declaring fast mode and one not, so
-- the test holds both before and after the release that declares it.
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
select 'qorpera.fast-mode-test',copy.version,copy.manifest,
	encode(extensions.digest(convert_to(copy.manifest::text,'utf8'),'sha256'),'hex')
from public.qorpera_active_runtime_bundle active
join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
cross join lateral (values
	(1,jsonb_set(bundle.manifest,'{modelPolicy,fastMode}','"thread"')),
	(2,bundle.manifest #- '{modelPolicy,fastMode}')) copy(version,manifest)
where active.singleton;
select set_config('qorpera_test.fast_bundle',(select id::text from public.qorpera_runtime_bundles
	where bundle_key = 'qorpera.fast-mode-test' and version = 1),false);
select set_config('qorpera_test.plain_bundle',(select id::text from public.qorpera_runtime_bundles
	where bundle_key = 'qorpera.fast-mode-test' and version = 2),false);
create function pg_temp.fast_activate(p_setting text)
returns void language sql as $$
	update public.qorpera_active_runtime_bundle active
	set runtime_bundle_id = bundle.id,runtime_bundle_sha256 = bundle.sha256
	from public.qorpera_runtime_bundles bundle
	where active.singleton and bundle.id = current_setting(p_setting)::uuid;
$$;

-- A bundle declares fast mode for thread turns or not at all.
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_manifest jsonb; v_bundle uuid;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
	if (v_run.service_tier is null)
		<> (public.qorpera_execution_runtime_manifest(v_run) #>> '{modelPolicy,fastMode}' is null) then
		raise exception 'the fixture run''s tier disagrees with its bundle: %', v_run.service_tier; end if;
	select manifest into strict v_manifest from public.qorpera_runtime_bundles
	where id = current_setting('qorpera_test.fast_bundle')::uuid;
	v_manifest := jsonb_set(v_manifest,'{modelPolicy,fastMode}','"always"');
	insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
	values('qorpera.fast-mode-test',3,v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text,'utf8'),'sha256'),'hex'))
	returning id,sha256 into v_run.runtime_bundle_id,v_run.runtime_bundle_sha256;
	begin
		perform public.qorpera_execution_runtime_manifest(v_run);
		raise exception 'an unknown fast mode was admitted';
	exception when insufficient_privilege then null; end;
	select id,sha256 into v_run.runtime_bundle_id,v_run.runtime_bundle_sha256 from public.qorpera_runtime_bundles
	where id = current_setting('qorpera_test.fast_bundle')::uuid;
	if public.qorpera_execution_runtime_manifest(v_run) #>> '{modelPolicy,fastMode}' <> 'thread' then
		raise exception 'fast mode bundle was not admitted'; end if;
end $$;

-- A conversation reports Fast by default, and only under a bundle that honours it.
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
select set_config('qorpera_test.fast_room_session',(
	select session_id::text from public.qorpera_company_rooms
	where profile_id = '16000000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '16000000-0000-4000-8000-000000000030'),false);
reset role;
select pg_temp.fast_activate('qorpera_test.plain_bundle');
set role authenticated;
do $$
declare v_session uuid := current_setting('qorpera_test.fast_room_session')::uuid; v_result jsonb;
begin
	if public.qorpera_get_session_model(v_session) ? 'service_tier' then
		raise exception 'a bundle without fast mode reported a conversation speed'; end if;
end $$;
reset role;
select pg_temp.fast_activate('qorpera_test.fast_bundle');
set role authenticated;
do $$
declare v_session uuid := current_setting('qorpera_test.fast_room_session')::uuid; v_result jsonb;
	v_bad text; v_message text;
begin
	v_result := public.qorpera_get_session_model(v_session);
	if v_result ->> 'service_tier' <> 'fast' or (v_result ->> 'version')::bigint <> 0 then
		raise exception 'a conversation did not start on Fast: %', v_result; end if;
	foreach v_bad in array array['priority','default','','Fast'] loop
		begin
			perform public.qorpera_set_session_service_tier(v_session,v_bad,0);
			raise exception 'an unsupported conversation speed was accepted: %', v_bad;
		exception when invalid_parameter_value then null; end;
	end loop;
	begin
		perform public.qorpera_set_session_service_tier(v_session,null,0);
		raise exception 'an empty conversation speed was accepted';
	exception when invalid_parameter_value then null; end;
	-- Turning Fast off keeps the default model path and effort.
	v_result := public.qorpera_set_session_service_tier(v_session,'standard',0);
	if v_result <> jsonb_build_object('session_id',v_session,'model_id','gpt-native','reasoning_effort','low',
		'service_tier','standard','version',1) then
		raise exception 'turning Fast off did not persist alone: %', v_result; end if;
	-- The speed shares the model's version: a stale switch gets the conflict.
	begin
		perform public.qorpera_set_session_service_tier(v_session,'fast',0);
		raise exception 'a stale conversation speed was accepted';
	exception when sqlstate 'PGRST' then
		get stacked diagnostics v_message = message_text;
		if v_message::jsonb ->> 'code' <> 'QRC01' then
			raise exception 'a stale speed did not use the application conflict envelope'; end if;
	end;
	-- The model and effort setter keeps the speed.
	v_result := public.qorpera_set_session_model(v_session,'gpt-6-sol',1);
	if v_result ->> 'model_id' <> 'gpt-6-sol' or v_result ->> 'service_tier' <> 'standard' then
		raise exception 'a model pick dropped the conversation speed: %', v_result; end if;
	v_result := public.qorpera_set_session_model(v_session,null,2,'high');
	if v_result ->> 'reasoning_effort' <> 'high' or v_result ->> 'service_tier' <> 'standard' then
		raise exception 'an effort pick dropped the conversation speed: %', v_result; end if;
end $$;
reset role;
do $$ begin
	if (select service_tier from public.qorpera_session_models
		where session_id = current_setting('qorpera_test.fast_room_session')::uuid) <> 'standard' then
		raise exception 'the conversation speed was not stored'; end if;
	-- Only members call the setters; the shared writer is private.
	if has_function_privilege('authenticated','public.qorpera_session_model_writer(uuid)','EXECUTE')
		or has_function_privilege('anon','public.qorpera_set_session_service_tier(uuid,text,bigint)','EXECUTE')
		or not has_function_privilege('authenticated','public.qorpera_set_session_service_tier(uuid,text,bigint)','EXECUTE')
		or to_regprocedure('public.qorpera_set_session_model(uuid,text,bigint,text)') is null then
		raise exception 'conversation speed setters have the wrong privileges or signatures'; end if;
end $$;
-- A viewer or a stranger cannot change the speed.
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '16000000-0000-4000-8000-000000000010' and user_id = '16000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
do $$ begin
	begin
		perform public.qorpera_set_session_service_tier(current_setting('qorpera_test.fast_room_session')::uuid,'fast',3);
		raise exception 'a viewer changed the conversation speed';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '16000000-0000-4000-8000-000000000010' and user_id = '16000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims',
	'{"sub":"58400000-0000-4000-8000-000000000099","role":"authenticated"}',false);
set role authenticated;
do $$ begin
	begin
		perform public.qorpera_set_session_service_tier(current_setting('qorpera_test.fast_room_session')::uuid,'fast',3);
		raise exception 'a stranger changed the conversation speed';
	exception when insufficient_privilege then null; end;
end $$;
reset role;

-- The real request, materialization and claim path: a new conversation's
-- first turn runs Fast, and the host learns it with the run's identity.
insert into public.qorpera_shared_sessions (
	id, client_session_id, profile_id, environment_id, title, status,
	created_by_user_id, staff_agent_id, staff_version, execution_scope, created_at,
	audience_kind, audience_user_id
) values (
	'58400000-0000-4000-8000-000000000040', '58400000-0000-4000-8000-000000000041',
	'16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020',
	'Fast session', 'open', '16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000030', 1, '{}', statement_timestamp(),
	'member_private', '16000000-0000-4000-8000-000000000001'
);
-- The fixture's queued turn holds the connection's single concurrent run slot.
update public.qorpera_execution_sponsor_reservations
set status = 'settled', actual_microusd = 0, settled_at = clock_timestamp()
where provider_connection_id = (current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid
	and status = 'reserved';
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select set_config('qorpera_test.fast_turn',public.qorpera_request_session_turn_v2(
	'58400000-0000-4000-8000-000000000040',
	'58400000-0000-4000-8000-000000000070',
	'58400000-0000-4000-8000-000000000071',
	'{"schema":"qorpera.session-prompt/v1","text":"Quick one.","images":[]}',
	'member_connection',
	(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
	1, null,
	(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
	null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
)::text,false);
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.fast_turn')::jsonb ->> 'turn_request_id')::uuid;
	if v_run.runtime_bundle_id <> current_setting('qorpera_test.fast_bundle')::uuid
		or v_run.source_kind <> 'session_turn' or v_run.service_tier <> 'fast' then
		raise exception 'a conversation turn under fast mode: bundle %, source %, tier %',
			v_run.runtime_bundle_id, v_run.source_kind, v_run.service_tier; end if;
	begin
		update public.qorpera_execution_runs set service_tier = 'standard' where id = v_run.id;
		raise exception 'an admitted run changed its tier';
	exception when insufficient_privilege then null; end;
	-- Claim this run before the fixture's older queued turn.
	update public.qorpera_runner_jobs set created_at = created_at - interval '2 hours' where run_id = v_run.id;
end $$;
-- The run context is read through the Company File path gateway.
update public.qorpera_company_files set path_gateway_version = 1,path_index_snapshot_id = head_snapshot_id
where environment_id = '16000000-0000-4000-8000-000000000020';
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
do $$
declare v_run_id uuid := (current_setting('qorpera_test.fast_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_native jsonb; v_binding jsonb; v_identity jsonb;
	v_context jsonb;
	v_runner_id uuid; v_job_id uuid;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'16000000-0000-4000-8000-000000000092','58400000-0000-4000-8000-0000000000d1',120);
	if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run_id then
		raise exception 'fixture did not claim the fast conversation turn'; end if;
	v_job_id := (v_claim -> 'work' ->> 'job_id')::uuid;
	v_runner := public.qorpera_provision_execution_runner(v_run_id,'58400000-0000-4000-8000-0000000000d2','process',repeat('4',64));
	v_runner_id := (v_runner ->> 'runner_id')::uuid;
	perform public.qorpera_activate_runner(v_runner_id,repeat('4',64),repeat('5',64),'linux','fast-mode-test');
	v_assignment := public.qorpera_assign_runner_job('16000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		v_runner_id,'58400000-0000-4000-8000-0000000000d3',repeat('6',64),120);
	perform public.qorpera_accept_runner_assignment(v_runner_id,repeat('5',64),(v_assignment ->> 'assignment_id')::uuid,
		v_job_id,repeat('6',64));
	v_native := public.qorpera_acquire_native_provider_connection_lease(v_run_id,v_runner_id,repeat('5',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('6',64),120);
	v_binding := jsonb_build_object('runId',v_run_id,'jobId',v_job_id,'runnerId',v_runner_id,
		'assignmentId',v_assignment ->> 'assignment_id','leaseId',v_native ->> 'lease_id',
		'credentialCapsuleId',v_native ->> 'credential_capsule_id','computeIdentityId',v_native ->> 'compute_identity_id',
		'provider','openai','nativeHarness','codex-cli','model','gpt-native');
	-- The shared tool identity is unchanged (company computers read it and
	-- refuse unknown fields); the tier travels in the run's company context.
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	if v_identity ? 'serviceTier'
		or v_identity ->> 'runtimeBundleId' <> current_setting('qorpera_test.fast_bundle') then
		raise exception 'the shared tool identity changed: %', v_identity; end if;
	v_context := public.qorpera_describe_company_run_context(v_binding);
	if v_context ->> 'serviceTier' is distinct from 'fast' or v_context -> 'identity' <> v_identity then
		raise exception 'the run context did not carry its tier: %', v_context ->> 'serviceTier'; end if;
	perform set_config('qorpera_test.fast_binding',v_binding::text,false);
end $$;
reset role;

-- A tier that disagrees with the run's bundle is refused.
alter table public.qorpera_execution_runs disable trigger qorpera_execution_run_service_tier;
update public.qorpera_execution_runs set service_tier = null
where id = (current_setting('qorpera_test.fast_turn')::jsonb ->> 'turn_request_id')::uuid;
alter table public.qorpera_execution_runs enable trigger qorpera_execution_run_service_tier;
set role service_role;
do $$ begin
	begin
		perform public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.fast_binding')::jsonb);
		raise exception 'a run without a tier under a fast mode bundle kept its authority';
	exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Only a member's Codex turn in a conversation takes its speed. Each case is
-- a copy of an admitted turn with its own job, through every production
-- trigger; a caller's tier is never taken. A session turn keeps its input's
-- bundle; other work is admitted under the active (fast mode) bundle.
create function pg_temp.fast_copy(p_turn text, p_patch jsonb)
returns public.qorpera_execution_runs language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_job_id uuid := gen_random_uuid(); v_result public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting(p_turn)::jsonb ->> 'turn_request_id')::uuid;
	-- A queued job: the claimed turn's own job is leased by now.
	select job.* into strict v_job from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.job_id = job.id
	where run.id = (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
	insert into public.qorpera_runner_jobs
	select * from jsonb_populate_record(null::public.qorpera_runner_jobs, to_jsonb(v_job)
		|| jsonb_build_object('id',v_job_id,'client_job_id',gen_random_uuid(),'run_id',null));
	insert into public.qorpera_execution_runs
	select * from jsonb_populate_record(null::public.qorpera_execution_runs, to_jsonb(v_run)
		|| jsonb_build_object('id',gen_random_uuid(),'job_id',v_job_id,'source_id',gen_random_uuid(),
			'reasoning_effort',null,'reasoning_policy_sha256',null,'service_tier','fast')
		|| p_patch)
	returning * into v_result;
	return v_result;
end
$$;
do $$
declare v_result public.qorpera_execution_runs%rowtype;
	v_room jsonb := jsonb_build_object('session_id',current_setting('qorpera_test.fast_room_session'));
begin
	v_result := pg_temp.fast_copy('qorpera_test.own_turn', v_room || '{"source_kind":"room_delivery","input_ids":[]}');
	if v_result.runtime_bundle_id <> current_setting('qorpera_test.fast_bundle')::uuid
		or v_result.service_tier <> 'standard' then
		raise exception 'a room delivery ignored the conversation speed: %', v_result.service_tier; end if;
	v_result := pg_temp.fast_copy('qorpera_test.own_turn', '{"source_kind":"wake","input_ids":[]}');
	if v_result.service_tier <> 'standard' then
		raise exception 'autonomous work ran Fast: %', v_result.service_tier; end if;
	v_result := pg_temp.fast_copy('qorpera_test.fast_turn', jsonb_build_object('sponsor_version',1,
		'sponsor_binding_id',current_setting('qorpera_test.anthropic_sponsor')::jsonb ->> 'binding_id'));
	if v_result.model_provider <> 'anthropic' or v_result.service_tier <> 'standard' then
		raise exception 'the Codex speed leaked into another provider: % %',
			v_result.model_provider, v_result.service_tier; end if;
	v_result := pg_temp.fast_copy('qorpera_test.fast_turn', '{"service_tier":"standard"}');
	if v_result.service_tier <> 'fast' then
		raise exception 'a caller hint chose the tier: %', v_result.service_tier; end if;
end $$;
-- Work admitted under a bundle without fast mode pins no tier.
select pg_temp.fast_activate('qorpera_test.plain_bundle');
do $$
declare v_result public.qorpera_execution_runs%rowtype;
begin
	v_result := pg_temp.fast_copy('qorpera_test.own_turn', '{"source_kind":"wake","input_ids":[]}');
	if v_result.runtime_bundle_id <> current_setting('qorpera_test.plain_bundle')::uuid
		or v_result.service_tier is not null then
		raise exception 'a bundle without fast mode pinned a tier: %', v_result.service_tier; end if;
end $$;
rollback;

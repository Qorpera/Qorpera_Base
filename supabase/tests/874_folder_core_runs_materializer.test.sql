-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"
-- Company folder core, C4 (P28 part 1; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-RUNS.md): runs on folder-v2. After a
-- real creation (856's fixture: the Co-Founder, its thread, the kickoff and Anna's queued turn request), the due list
-- names the company; the per-company materializer refuses a request whose login is gone (failed, nothing written),
-- turns the first run's request into a run (no substrate, the folder clock's pin, the reservation, the first-run wake
-- under one admission) in a pass that leaves a founder's post in the thread waiting, since a conversation runs one run at
-- a time (20260930538000); answers that post with a room delivery, admitted, once the first run is done; leaves a later
-- post waiting while the thread's run lives (not due, nothing written) and runs it after; cancels a wake whose authority
-- is gone; answers paused, not_folder and idle without writing. Both functions are the service role's alone. A run has
-- exactly one pin. The reconcile RPC no longer runs the legacy materializers. (A full login's wait is 465's: this
-- company has one conversation, whose own run would hold the login's slot.)

-- Each pass as its own transaction would start it: no admission mark from an earlier statement (a post sets it).
create function pg_temp.materialize(p_profile uuid, p_limit integer default 16) returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;
create function pg_temp.admitted(p_profile uuid) returns bigint language sql as $$
	select admitted from public.qorpera_folder_admissions where profile_id = p_profile
$$;
create function pg_temp.due(p_after uuid default null, p_limit integer default 100) returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	return public.qorpera_folder_materialize_due(p_after, p_limit);
end $$;
create function pg_temp.listed(p_profile uuid) returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(pg_temp.due() -> 'items') as item(value)
		where item.value ->> 'profile_id' = p_profile::text)
$$;
-- A run is done: its job fails, as a runner reports it (the trigger settles its reservation).
create function pg_temp.end_run(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: the run is done'
	where run_id = p_run
$$;
-- Anna posts in the Co-Founder's thread with her own login; answers the post's wake.
create function pg_temp.post(p_client uuid, p_text text) returns uuid language plpgsql as $$
declare v_post jsonb;
begin
	perform pg_temp.as_user('85600000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_post := public.qorpera_post_company_room_message(current_setting('qorpera_test.room')::uuid, p_client,
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		current_setting('qorpera_test.binding')::uuid, current_setting('qorpera_test.binding_version')::bigint);
	reset role;
	if jsonb_array_length(v_post -> 'occurrenceIds') <> 1 then raise exception 'The post woke % agents', v_post -> 'occurrenceIds'; end if;
	return (v_post -> 'occurrenceIds' ->> 0)::uuid;
end $$;

do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_request public.qorpera_session_turn_requests;
begin
	select * into strict v_request from public.qorpera_session_turn_requests where profile_id = (v_claim ->> 'profileId')::uuid;
	perform set_config('qorpera_test.request', v_request.id::text, true);
	perform set_config('qorpera_test.binding', v_request.sponsor_binding_id::text, true);
	perform set_config('qorpera_test.binding_version', v_request.sponsor_version::text, true);
	perform set_config('qorpera_test.room', (select id::text from public.qorpera_company_rooms
		where profile_id = (v_claim ->> 'profileId')::uuid and bound_staff_agent_id = (v_claim ->> 'cofounderId')::uuid), true);
	perform set_config('qorpera_test.connection', (select provider_connection_id::text from public.qorpera_execution_sponsor_versions
		where binding_id = v_request.sponsor_binding_id and version = v_request.sponsor_version), true);
end $$;

-- 0. Who may call what -------------------------------------------------------------------------------------------------

do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_folder_materialize_due(uuid,integer)',
		'public.qorpera_folder_materialize_company(uuid,integer)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE') or has_function_privilege('authenticated', v_function, 'EXECUTE')
			or not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% is not the control plane''s call', v_function; end if;
	end loop;
end $$;
select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
select pg_temp.refused($$select public.qorpera_folder_materialize_due(null, 10)$$, '42501');
select pg_temp.refused($$select public.qorpera_folder_materialize_company(current_setting('qorpera_test.table')::uuid, 4)$$, '42501');
select pg_temp.as_service();
select pg_temp.refused($$select public.qorpera_folder_materialize_company(current_setting('qorpera_test.table')::uuid, 17)$$, '22023');
select pg_temp.refused($$select public.qorpera_folder_materialize_due(null, 0)$$, '22023');

-- The reconcile RPC no longer runs the legacy materializers; it keeps the heartbeat and the lease reconciliation.
do $$
declare v_reconcile text := pg_get_functiondef('public.qorpera_reconcile_runner_orchestrator(uuid)'::regprocedure)
	|| pg_get_functiondef('public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure);
begin
	if v_reconcile ~ 'perform public\.qorpera_materialize_(session_turn_requests|session_execution_runs|wake_execution_runs|company_proposal_review_runs)\('
		or position('set last_heartbeat_at = statement_timestamp()' in v_reconcile) = 0
		or position('perform public.qorpera_retire_stale_managed_runners();' in v_reconcile) = 0 then
		raise exception 'The reconcile RPC still materializes legacy work, or lost its own steps'; end if;
end $$;

-- 1. The due list ------------------------------------------------------------------------------------------------------

do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_page jsonb;
begin
	-- The creation's queued first run makes the company due; the snapshot-v1 company and Cy's (no work) are not.
	v_page := pg_temp.due();
	if v_page -> 'items' is distinct from jsonb_build_array(jsonb_build_object('profile_id', v_profile))
		or (v_page ->> 'has_more')::boolean or v_page -> 'next_after_profile_id' <> 'null'::jsonb then
		raise exception 'The due list is not the one company: %', v_page; end if;
	if jsonb_array_length(pg_temp.due(v_profile) -> 'items') <> 0 then raise exception 'Paging past the company lists it'; end if;
	if public.qorpera_folder_materialize_company(current_setting('qorpera_test.old')::uuid, 4) ->> 'state' is distinct from 'not_folder' then
		raise exception 'A snapshot-v1 company is materialized here'; end if;
end $$;

-- 2. A request whose login is gone fails, and nothing of its run stays -----------------------------------------------

update public.qorpera_execution_sponsor_bindings set status = 'revoked' where id = current_setting('qorpera_test.binding')::uuid;
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb;
	v_request public.qorpera_session_turn_requests; v_input public.qorpera_session_inputs;
begin
	v_result := pg_temp.materialize(v_profile);
	select * into strict v_request from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.request')::uuid;
	select * into strict v_input from public.qorpera_session_inputs where id = v_request.input_id;
	if v_result -> 'run_ids' <> '[]'::jsonb or (v_result ->> 'failed')::integer <> 1 or v_request.status <> 'failed'
		or v_request.failure_reason is distinct from 'The selected execution sponsor or computer is no longer available'
		or v_input.failed_at is null or v_input.execution_run_id is not null then
		raise exception 'A request on a revoked login did not fail: % % %', v_result, to_jsonb(v_request), to_jsonb(v_input); end if;
	if public.qorpera_folder_company_first_run_state(v_profile) is distinct from 'failed' then
		raise exception 'The table does not show the failed first run'; end if;
	if exists (select 1 from public.qorpera_execution_runs where profile_id = v_profile)
		or exists (select 1 from public.qorpera_runner_jobs where profile_id = v_profile)
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = v_profile) then
		raise exception 'A refused request left a run, job or wake'; end if;
end $$;
-- The login back, and the request queued again (as a restart of a dead first run will).
update public.qorpera_execution_sponsor_bindings set status = 'active' where id = current_setting('qorpera_test.binding')::uuid;
update public.qorpera_session_turn_requests set status = 'queued', failure_reason = null
where id = current_setting('qorpera_test.request')::uuid;
update public.qorpera_session_inputs set failed_at = null, failure_reason = null
where id = (select input_id from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.request')::uuid);

-- 3. The first run; a founder's post beside it waits -----------------------------------------------------------------

select set_config('qorpera_test.first_post', pg_temp.post('87400000-0000-4000-8000-000000000005', 'Welcome aboard.')::text, true);
do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid := (v_claim ->> 'environmentId')::uuid; v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid;
	v_request public.qorpera_session_turn_requests; v_run public.qorpera_execution_runs; v_job public.qorpera_runner_jobs;
	v_wake public.qorpera_wake_occurrences; v_result jsonb; v_admitted bigint;
begin
	v_admitted := pg_temp.admitted(v_profile);
	v_result := pg_temp.materialize(v_profile);
	-- Oldest scan first: the request (scanned in §2), then the post's wake, which the pass skips under the thread's lock:
	-- the first run is now the conversation's one run (20260930538000). One admission for the pass.
	if v_result ->> 'state' is distinct from 'done' or v_result -> 'run_ids' is distinct from jsonb_build_array(current_setting('qorpera_test.request'))
		or (v_result ->> 'failed')::integer <> 0 or (v_result ->> 'skipped')::integer <> 1 then
		raise exception 'The first run was not materialized, or the post beside it did not wait: %', v_result; end if;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.first_post')::uuid;
	if v_wake.status <> 'queued' or v_wake.run_id is not null or v_wake.blocked_reason is not null then
		raise exception 'The post''s wake does not wait, queued and with no reason: %', to_jsonb(v_wake); end if;
	select * into strict v_request from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.request')::uuid;
	select * into strict v_run from public.qorpera_execution_runs where id = v_request.id;
	-- No substrate or snapshot: the folder clock's pin. The model is the Co-Founder's: its agent.md names none, so the
	-- platform's default by the agent's mapping (20260930081000), not the provider's default.
	if v_run.source_kind <> 'session_turn' or v_run.source_id <> v_request.id or v_run.substrate_version_id is not null
		or v_run.company_snapshot_id is not null or v_run.company_seq is null or v_run.company_seq < 1
		or v_run.company_seq is distinct from (select last_seq from public.qorpera_folder_clocks where environment_id = v_env)
		or v_run.environment_id <> v_env or v_run.session_id <> v_request.session_id or v_run.staff_agent_id <> v_cofounder
		or v_run.staff_version <> (select version from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = v_cofounder)
		or v_run.input_ids <> array[v_request.input_id] or v_run.requested_by_user_id <> '85600000-0000-4000-8000-000000000001'
		or v_run.model_id is distinct from 'gpt-6-astra' or v_run.model_selection is distinct from 'provider_mapping'
		or v_run.compute_identity_id is distinct from v_request.compute_identity_id then
		raise exception 'The first run is not pinned as agreed: %', to_jsonb(v_run); end if;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	if v_job.substrate_version_id is not null or v_job.run_id <> v_run.id or v_job.status <> 'queued' or v_job.client_job_id <> v_request.id
		or v_job.payload ->> 'schema' <> 'qorpera.sponsored-session-turn/v1' then
		raise exception 'The first run''s job is not as agreed: %', to_jsonb(v_job); end if;
	-- Its reservation, budget (the folder tool's run mutex) and model policy.
	if not exists (select 1 from public.qorpera_execution_sponsor_reservations where run_id = v_run.id and status = 'reserved')
		or not exists (select 1 from public.qorpera_execution_run_budgets where run_id = v_run.id)
		or not exists (select 1 from public.qorpera_runner_model_policies where job_id = v_job.id) then
		raise exception 'The first run has no reservation, budget or model policy'; end if;
	if v_request.status <> 'materialized' or v_request.run_id <> v_run.id
		or (select execution_run_id from public.qorpera_session_inputs where id = v_request.input_id) is distinct from v_run.id then
		raise exception 'The request and its kickoff are not the run''s: %', to_jsonb(v_request); end if;
	-- The first-run wake, inserted under admission by the queued event, and authorized as the run will check it.
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if v_wake.wake_kind <> 'first-run' or v_wake.status <> 'materialized' or v_wake.source_id <> v_request.input_id
		or v_wake.staff_agent_id <> v_cofounder or v_wake.session_id <> v_request.session_id
		or v_wake.requested_by_user_id <> '85600000-0000-4000-8000-000000000001'
		or not public.qorpera_folder_wake_authorized(v_wake) then
		raise exception 'The first-run wake is not as agreed: %', to_jsonb(v_wake); end if;
	if pg_temp.admitted(v_profile) <> v_admitted + 1
		or not exists (select 1 from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'queued') then
		raise exception 'The pass was not admitted once'; end if;
	if public.qorpera_folder_company_first_run_state(v_profile) is distinct from 'started' then
		raise exception 'The table does not show the first run started'; end if;
	-- Nothing more is due: the post waits for the first run.
	if pg_temp.listed(v_profile) or pg_temp.materialize(v_profile) ->> 'state' is distinct from 'idle' then
		raise exception 'The company is still due after its first run'; end if;
	-- The runner's description carries the pin.
	if position($p$'company_seq', v_run.company_seq$p$ in pg_get_functiondef(
		'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)'::regprocedure)) = 0 then
		raise exception 'The broker''s description does not carry company_seq'; end if;
end $$;

-- 4. Once the first run is done, the founder's post is answered ------------------------------------------------------

select pg_temp.end_run(current_setting('qorpera_test.request')::uuid);
select set_config('qorpera_test.wake', current_setting('qorpera_test.first_post'), true);
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_wake public.qorpera_wake_occurrences;
	v_run public.qorpera_execution_runs; v_job public.qorpera_runner_jobs; v_result jsonb; v_admitted bigint;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid;
	if v_wake.status <> 'queued' or v_wake.wake_kind <> 'room' or not pg_temp.listed(v_profile) then
		raise exception 'The post did not leave a due room wake: %', to_jsonb(v_wake); end if;
	v_admitted := pg_temp.admitted(v_profile);
	v_result := pg_temp.materialize(v_profile);
	-- A wake-only pass admits too (core §3 step 10: the materializer).
	if pg_temp.admitted(v_profile) <> v_admitted + 1 then raise exception 'The wake''s pass was not admitted'; end if;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	if v_result -> 'run_ids' is distinct from jsonb_build_array(v_run.id) or v_wake.status <> 'materialized'
		or v_run.source_kind <> 'room_delivery' or v_run.source_id <> v_wake.id or v_run.session_id <> v_wake.session_id
		or v_run.input_ids <> '{}'::uuid[] or v_run.substrate_version_id is not null or v_run.company_snapshot_id is not null
		or v_run.company_seq is distinct from (select last_seq from public.qorpera_folder_clocks
			where environment_id = (select environment_id from public.qorpera_company_files where profile_id = v_profile))
		or v_run.transcript_start_sequence < 1 or v_job.substrate_version_id is not null or v_job.run_id <> v_run.id
		or not exists (select 1 from public.qorpera_execution_sponsor_reservations where run_id = v_run.id) then
		raise exception 'The post was not answered with a room delivery: % % %', v_result, to_jsonb(v_wake), to_jsonb(v_run); end if;
end $$;

-- 5. A later post waits while the thread's run lives, with nothing written; it runs after ----------------------------

select set_config('qorpera_test.wake', pg_temp.post('87400000-0000-4000-8000-000000000002', 'Are you there?')::text, true);
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_wake public.qorpera_wake_occurrences; v_result jsonb;
	v_runs bigint := (select count(*) from public.qorpera_execution_runs where profile_id = current_setting('qorpera_test.table')::uuid);
	v_jobs bigint := (select count(*) from public.qorpera_runner_jobs where profile_id = current_setting('qorpera_test.table')::uuid);
begin
	-- §4's room delivery is the thread's one run: the wake is not due and not scanned, and keeps no reason.
	v_result := pg_temp.materialize(v_profile);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid;
	if v_result ->> 'state' is distinct from 'idle' or pg_temp.listed(v_profile) or v_wake.status <> 'queued'
		or v_wake.run_id is not null or v_wake.blocked_reason is not null then
		raise exception 'The post did not wait for the thread''s run: % %', v_result, to_jsonb(v_wake); end if;
	if (select count(*) from public.qorpera_execution_runs where profile_id = v_profile) <> v_runs
		or (select count(*) from public.qorpera_runner_jobs where profile_id = v_profile) <> v_jobs then
		raise exception 'A waiting wake left a run or job'; end if;
end $$;
select pg_temp.end_run((select run_id from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.first_post')::uuid));
do $$
declare v_wake public.qorpera_wake_occurrences; v_result jsonb := pg_temp.materialize(current_setting('qorpera_test.table')::uuid);
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid;
	if v_result -> 'run_ids' is distinct from jsonb_build_array(v_wake.run_id) or v_wake.status <> 'materialized'
		or v_wake.blocked_reason is not null then
		raise exception 'The waiting wake did not run once the thread''s run was done: % %', v_result, to_jsonb(v_wake); end if;
end $$;

-- 6. A wake whose authority is gone is cancelled ---------------------------------------------------------------------

-- §5's run is done first, so the next post is scanned.
select pg_temp.end_run((select run_id from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid));
select set_config('qorpera_test.wake', pg_temp.post('87400000-0000-4000-8000-000000000003', 'One more thing.')::text, true);
update public.qorpera_execution_sponsor_bindings set status = 'revoked' where id = current_setting('qorpera_test.binding')::uuid;
do $$
declare v_wake public.qorpera_wake_occurrences; v_result jsonb := pg_temp.materialize(current_setting('qorpera_test.table')::uuid);
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid;
	if v_result -> 'run_ids' <> '[]'::jsonb or (v_result ->> 'cancelled')::integer <> 1 or v_wake.status <> 'cancelled'
		or v_wake.finished_at is null or v_wake.run_id is not null or v_wake.blocked_reason is null then
		raise exception 'A wake without authority was not cancelled: % %', v_result, to_jsonb(v_wake); end if;
end $$;
update public.qorpera_execution_sponsor_bindings set status = 'active' where id = current_setting('qorpera_test.binding')::uuid;

-- 7. Paused: nothing is written, and the company is not due ----------------------------------------------------------

select set_config('qorpera_test.wake', pg_temp.post('87400000-0000-4000-8000-000000000004', 'After the stop.')::text, true);
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
values (current_setting('qorpera_test.table')::uuid, '85600000-0000-4000-8000-000000000001', 'P28 test');
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid;
begin
	if pg_temp.materialize(v_profile) ->> 'state' is distinct from 'paused' or pg_temp.listed(v_profile)
		or (select status from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid) <> 'queued' then
		raise exception 'A paused company was materialized or listed'; end if;
end $$;
delete from public.qorpera_company_execution_pauses where profile_id = current_setting('qorpera_test.table')::uuid;
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb;
begin
	if not pg_temp.listed(v_profile) then raise exception 'A resumed company with a queued wake is not due'; end if;
	v_result := pg_temp.materialize(v_profile, 1);
	if jsonb_array_length(v_result -> 'run_ids') <> 1
		or (select status from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.wake')::uuid) <> 'materialized' then
		raise exception 'The resumed company''s wake did not run: %', v_result; end if;
end $$;

-- 8. A run has exactly one pin ---------------------------------------------------------------------------------------

-- The check alone (the run triggers off): no pin, both pins, or a snapshot without its substrate.
set local session_replication_role = replica;
select pg_temp.refused($$update public.qorpera_execution_runs set company_seq = null
	where id = current_setting('qorpera_test.request')::uuid$$, '23514');
select pg_temp.refused($$update public.qorpera_execution_runs set company_snapshot_id = extensions.gen_random_uuid(),
	substrate_version_id = extensions.gen_random_uuid() where id = current_setting('qorpera_test.request')::uuid$$, '23514');
select pg_temp.refused($$update public.qorpera_execution_runs set company_snapshot_id = extensions.gen_random_uuid(), company_seq = null
	where id = current_setting('qorpera_test.request')::uuid$$, '23514');
set local session_replication_role = origin;

rollback;

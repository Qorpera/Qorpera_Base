-- Company folder core, C1b-1: run actors under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md §2,
-- §6, §7, §8). Other connections race real commits. The fixture is committed so they can see it, and removed at
-- the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values ('63300000-0000-4000-8000-000000000001','agents-race-owner@example.test'),
	('63300000-0000-4000-8000-000000000002','agents-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('63300000-0000-4000-8000-000000000010','Folder agents race fixture','63300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('63300000-0000-4000-8000-000000000010','63300000-0000-4000-8000-000000000001','agents-race-owner@example.test','Owner','owner'),
	('63300000-0000-4000-8000-000000000010','63300000-0000-4000-8000-000000000002','agents-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('63300000-0000-4000-8000-000000000020','63300000-0000-4000-8000-000000000010','Environment',1,'63300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values
	('63300000-0000-4000-8000-000000000010','63300000-0000-4000-8000-0000000000a1','Agent A','QA','Test.','green','round','active','active',
		statement_timestamp(), statement_timestamp(), '63300000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.qorpera_folder_enable('63300000-0000-4000-8000-000000000020');
-- The runs' sponsor (binding id = agent A's id): a company login, which pays for any member's work (20260928230000).
set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, provider, created_by_user_id)
values ('63300000-0000-4000-8000-0000000000b3', '63300000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'openai', '63300000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('63300000-0000-4000-8000-0000000000a1', '63300000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), '63300000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id)
values ('63300000-0000-4000-8000-0000000000a1', 1, 'company_service_account', '63300000-0000-4000-8000-0000000000b3', 1, '63300000-0000-4000-8000-000000000001');
set session_replication_role = origin;

-- A hand-built leased human run of agent A for the member (see 632), committed. Returns the run actor.
create function pg_temp.run() returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63300000-0000-4000-8000-000000000010'; v_env uuid := '63300000-0000-4000-8000-000000000020';
	v_staff uuid := '63300000-0000-4000-8000-0000000000a1'; v_requester uuid := '63300000-0000-4000-8000-000000000002';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid; v_input uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	select id into v_session from public.qorpera_shared_sessions where profile_id = v_profile and staff_agent_id = v_staff::text and status = 'open';
	if v_session is null then
		insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version)
		values (extensions.gen_random_uuid(), v_profile, v_env, 'Agent thread', v_requester, v_staff::text, 1) returning id into v_session;
	end if;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_staff, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_staff, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester, 'openai', 'gpt-test',
		'provider_default', 'company', v_staff, repeat('b', 64), v_session, array[v_input]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, v_staff, 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

select set_config('qorpera_test.run_one', pg_temp.run()::text, false);
select set_config('qorpera_test.run_two', pg_temp.run()::text, false);
select set_config('qorpera_test.run_three', pg_temp.run()::text, false);

create function pg_temp.sql_commit(p_actor jsonb, p_key text, p_units jsonb, p_review uuid default null) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L, %L)', '63300000-0000-4000-8000-000000000020',
		p_actor::text, p_key, p_units::text, p_review)
$$;
create function pg_temp.actor(p_name text) returns jsonb language sql as $$ select current_setting('qorpera_test.' || p_name)::jsonb $$;
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- Reads a sent statement's error state (or 'ok') and drains the connection.
create function pg_temp.outcome(p_conn text) returns text language plpgsql as $$
declare v_state text := 'ok';
begin
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then v_state := sqlstate;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_state;
end $$;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['arace_one','arace_two']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['arace_one','arace_two']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['arace_one','arace_two']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.finishes_unblocked(p_conn text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer))
			or clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;

-- A. A run's commit holds its job KEY SHARE: a lease-ending FOR UPDATE waits for it, a claim's SKIP LOCKED passes it
-- by, and a renewal at FOR NO KEY UPDATE does not wait. Two commits of one run do not block each other.
do $$
declare v jsonb := pg_temp.actor('run_one'); r jsonb;
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', pg_temp.sql_commit(v, 'race-a-1', '[{"op":"mkdir","path":"a-one"}]')) as t(r jsonb);
	perform dblink_send_query('arace_two', format('select 1 from public.qorpera_runner_jobs where id = %L for no key update', v ->> 'jobId'));
	if not pg_temp.finishes_unblocked('arace_two', 'arace_one') then raise exception 'A renewal waited for a commit'; end if;
	perform pg_temp.outcome('arace_two');
	perform dblink_send_query('arace_two', format('select count(*) from (select 1 from public.qorpera_runner_jobs where id = %L for update skip locked) s',
		v ->> 'jobId'));
	if not pg_temp.finishes_unblocked('arace_two', 'arace_one') then raise exception 'A claim waited instead of skipping'; end if;
	perform pg_temp.outcome('arace_two');
	perform dblink_send_query('arace_two', format('select 1 from public.qorpera_runner_jobs where id = %L for update', v ->> 'jobId'));
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'A lease-ending FOR UPDATE did not wait for the commit'; end if;
	perform dblink_exec('arace_one', 'commit');
	perform pg_temp.outcome('arace_two');

	-- Two commits of one run share the job and the fence: the second runs to its end while the first holds both, as it
	-- does before its paths. (Commits of one company still meet at the clock, last, by design.)
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', format('select 1 from public.qorpera_runner_jobs where id = %L for key share', v ->> 'jobId')) as t(x integer);
	perform * from dblink('arace_one', $q$select 1 from public.qorpera_folder_fences where profile_id = '63300000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform dblink_send_query('arace_two', pg_temp.sql_commit(v, 'race-a-2', '[{"op":"mkdir","path":"a-two"}]'));
	if not pg_temp.finishes_unblocked('arace_two', 'arace_one') then raise exception 'Two commits of one run blocked each other'; end if;
	r := pg_temp.result('arace_two');
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The second commit of the run: %', r; end if;
	perform dblink_exec('arace_one', 'rollback');
end $$;

-- B. Staff archive (a plain status update) does not wait for a commit in flight.
do $$
declare v jsonb := pg_temp.actor('run_one');
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', pg_temp.sql_commit(v, 'race-b-1', '[{"op":"mkdir","path":"b-one"}]')) as t(r jsonb);
	perform dblink_exec('arace_two', 'begin');
	perform dblink_send_query('arace_two', $q$update public.qorpera_profile_staff set updated_at = clock_timestamp()
		where staff_agent_id = '63300000-0000-4000-8000-0000000000a1'$q$);
	if not pg_temp.finishes_unblocked('arace_two', 'arace_one') then raise exception 'A staff status update waited for a commit'; end if;
	perform pg_temp.outcome('arace_two');
	perform dblink_exec('arace_two', 'rollback');
	perform dblink_exec('arace_one', 'commit');
end $$;

-- C. Stop: phase 2 waits for a commit that was past its first pause read; a commit after phase 1 refuses at once.
do $$
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', pg_temp.sql_commit(pg_temp.actor('run_two'), 'race-c-1', '[{"op":"mkdir","path":"c-one"}]')) as t(r jsonb);
end $$;
-- Phase 1 commits on its own, before anything else looks.
select public.qorpera_folder_pause('63300000-0000-4000-8000-000000000010', '63300000-0000-4000-8000-000000000001', 'race');
do $$
declare v_state text;
begin
	perform dblink_send_query('arace_two', pg_temp.sql_commit(pg_temp.actor('run_three'), 'race-c-2', '[{"op":"mkdir","path":"c-two"}]'));
	if not pg_temp.finishes_unblocked('arace_two', 'arace_one') then raise exception 'A commit after the pause waited'; end if;
	v_state := pg_temp.outcome('arace_two');
	if v_state <> '55000' then raise exception 'A commit after the pause must refuse with 55000, got %', v_state; end if;
	perform dblink_send_query('arace_two', $q$select public.qorpera_folder_pause_drain('63300000-0000-4000-8000-000000000010')$q$);
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'Stop phase 2 did not wait for the commit in flight'; end if;
	perform dblink_exec('arace_one', 'commit');
	if pg_temp.outcome('arace_two') <> 'ok' then raise exception 'Stop phase 2 failed'; end if;
	perform public.qorpera_folder_resume('63300000-0000-4000-8000-000000000010');
end $$;

-- D. Review races, both ways: an answer waits for a commit holding the review, and a commit waits for an answer.
with ins as (
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63300000-0000-4000-8000-000000000020', (pg_temp.actor('run_three') ->> 'runId')::uuid,
		public.qorpera_folder_change_set_sha256('[{"op":"mkdir","path":"d-plain"}]'), '{1}', 'ask')
	returning id)
select set_config('qorpera_test.review', id::text, false) from ins;
do $$
declare v jsonb := pg_temp.actor('run_three'); v_review uuid := current_setting('qorpera_test.review')::uuid;
	u jsonb := '[{"op":"mkdir","path":"d-plain"}]'; r jsonb;
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', pg_temp.sql_commit(v, 'race-d-1', u, v_review)) as t(r jsonb);
	perform dblink_send_query('arace_two', format($q$update public.qorpera_folder_reviews set answer = 'allow',
		answered_by_user_id = '63300000-0000-4000-8000-000000000001', answered_at = clock_timestamp() where id = %L$q$, v_review));
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'An answer did not wait for a commit holding the review'; end if;
	perform dblink_exec('arace_one', 'commit');
	perform pg_temp.outcome('arace_two');
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', format('select 1 from public.qorpera_folder_reviews where id = %L for no key update', v_review)) as t(x integer);
	perform dblink_send_query('arace_two', pg_temp.sql_commit(v, 'race-d-2', '[{"op":"mkdir","path":"d-two"}]', v_review));
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'A commit did not wait for an answer in flight'; end if;
	perform dblink_exec('arace_one', 'rollback');
	r := pg_temp.result('arace_two');
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The commit after the answer: %', r; end if;
end $$;

-- E. The hook's lock merges one row asked for twice into its stronger mode: a room member asked for KEY SHARE and
-- FOR UPDATE is locked once, FOR UPDATE, so a KEY SHARE elsewhere waits.
do $$
declare v_room uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_room_members(room_id, principal_kind, principal_id, status, source_path_version)
	values (v_room, 'member', '63300000-0000-4000-8000-000000000002', 'active', extensions.gen_random_uuid());
	set local session_replication_role = origin;
	perform set_config('qorpera_test.room', v_room::text, false);
end $$;
do $$
declare v_key text := current_setting('qorpera_test.room') || ':member:63300000-0000-4000-8000-000000000002';
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', format($q$select public.qorpera_folder_structured_lock('63300000-0000-4000-8000-000000000020', %L::jsonb,
		4::smallint, 4::smallint)::text$q$, jsonb_build_array(
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members', 'key', v_key, 'mode', 'keyshare'),
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members', 'key', v_key, 'mode', 'update')))) as t(x text);
	perform dblink_send_query('arace_two', format('select 1 from public.qorpera_company_room_members where room_id = %L for key share',
		current_setting('qorpera_test.room')));
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'The merged lock was not taken in its stronger mode'; end if;
	perform dblink_exec('arace_one', 'rollback');
	perform pg_temp.outcome('arace_two');
end $$;

-- F. The commit's own ranks lock a hook's member row in its merged mode: asked for KEY SHARE and FOR UPDATE, the
-- member row is held FOR UPDATE, so a KEY SHARE elsewhere waits.
do $$
declare v_key text := '63300000-0000-4000-8000-000000000010:63300000-0000-4000-8000-000000000002';
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', format($q$select public.qorpera_folder_lock_commit_rank('63300000-0000-4000-8000-000000000020',
		%L::jsonb, 1::smallint)::text$q$, jsonb_build_array(
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_key, 'mode', 'keyshare', 'required', true),
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_key, 'mode', 'update')))) as t(x text);
	perform dblink_send_query('arace_two', $q$select 1 from public.qorpera_profile_members where profile_id = '63300000-0000-4000-8000-000000000010'
		and user_id = '63300000-0000-4000-8000-000000000002' for key share$q$);
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'The member row was not taken in its merged mode'; end if;
	perform dblink_exec('arace_one', 'rollback');
	perform pg_temp.outcome('arace_two');
end $$;

-- G. The real terminalize waits for a commit holding the job (its first statement takes the job FOR UPDATE).
do $$
declare v jsonb := pg_temp.actor('run_one');
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', pg_temp.sql_commit(v, 'race-g-1', '[{"op":"mkdir","path":"g-one"}]')) as t(r jsonb);
	perform dblink_send_query('arace_two', format($q$select public.qorpera_terminalize_runner_attempt(%L, 'cancelled', 'race', false)::text$q$,
		v ->> 'jobId'));
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'Terminalize did not wait for the commit'; end if;
	perform dblink_exec('arace_one', 'commit');
	perform pg_temp.outcome('arace_two');
end $$;

-- H. A hook target at rank 1 is locked by the real commit: while another session holds that member row FOR UPDATE,
-- a member's commit whose hook names the row waits, then saves (review probe r432impl/rank1wait.sql). The hook is
-- replaced for this company only, and the stub comes back after.
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
	select 1::smallint, 'qorpera_profile_members', '63300000-0000-4000-8000-000000000010:63300000-0000-4000-8000-000000000002', 'keyshare'
	where p_environment_id = '63300000-0000-4000-8000-000000000020'
$f$;
do $$
declare r jsonb;
begin
	perform dblink_exec('arace_one', 'begin');
	perform * from dblink('arace_one', $q$select 1 from public.qorpera_profile_members where profile_id = '63300000-0000-4000-8000-000000000010'
		and user_id = '63300000-0000-4000-8000-000000000002' for update$q$) as t(x integer);
	perform dblink_send_query('arace_two', pg_temp.sql_commit('{"kind":"member","userId":"63300000-0000-4000-8000-000000000001"}',
		'race-h-1', '[{"op":"mkdir","path":"h-one"}]'));
	if not pg_temp.waits_for('arace_two', 'arace_one') then raise exception 'A hook target at rank 1 was not locked by the commit'; end if;
	perform dblink_exec('arace_one', 'rollback');
	r := pg_temp.result('arace_two');
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The commit after the hook row was free: %', r; end if;
end $$;
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $f$
	select null::smallint, null::text, null::text, null::text where false
$f$;

select dblink_disconnect(name) from unnest(array['arace_one','arace_two']) name;

-- Every function that ends a job lease starts with an explicit FOR UPDATE on the job: the whole guarantee that it
-- waits for commits holding KEY SHARE (a plain UPDATE of non-key columns would not).
do $$
declare v_missing text;
begin
	if (select prosrc from pg_proc where proname = 'qorpera_terminalize_runner_attempt') !~* 'from public\.qorpera_runner_jobs where id = p_job_id for update' then
		raise exception 'Terminalize must take the job FOR UPDATE'; end if;
	-- The functions that end a lease themselves (the design review's list of the live job writers).
	select string_agg(f, ', ') into v_missing from unnest(array['qorpera_terminalize_runner_attempt_before_native_start',
		'qorpera_complete_runner_job_v6','qorpera_complete_runner_job_before_path_runtime','qorpera_complete_runner_job',
		'qorpera_fail_runner_job','qorpera_handoff_run_sponsor','qorpera_revoke_runner','qorpera_reissue_runner_activation',
		'qorpera_resolve_failed_execution_run','qorpera_retry_room_delivery','qorpera_claim_runner_job',
		'qorpera_reconcile_runner_orchestrator_without_sponsored_turns']) f
	where not exists (select 1 from pg_proc where proname = f and prosrc ~* '\mfor\s+update\M');
	if v_missing is not null then raise exception 'Lease-ending functions without FOR UPDATE: %', v_missing; end if;
end $$;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_journal where environment_id = '63300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '63300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63300000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '63300000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '63300000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '63300000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '63300000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions where profile_id = '63300000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '63300000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id = '63300000-0000-4000-8000-0000000000a1';
delete from public.qorpera_execution_sponsor_bindings where id = '63300000-0000-4000-8000-0000000000a1';
delete from public.qorpera_provider_connections where id = '63300000-0000-4000-8000-0000000000b3';
delete from public.qorpera_company_room_members where room_id = current_setting('qorpera_test.room')::uuid;
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '63300000-0000-4000-8000-000000000010';
delete from auth.users where id in ('63300000-0000-4000-8000-000000000001','63300000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '63300000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;

-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- One Stop ends a whole chain (20260930533000), under concurrency. A Stop takes its chain's lock before the job it names,
-- so a second Stop of the same chain waits for the first holding no job, and the two never deadlock. The materializer
-- takes the chain's lock shared without waiting: a run it made just before a Stop is found and cancelled by that Stop,
-- which waits for it, and a wake admitted while a Stop is in flight is left queued, then refused once the Stop
-- committed. 648's committed fixture (Ada's leased human run f1 in conversation f7, its wake f3 the chain's root), with
-- three chains of hand-built runs in the same conversation, removed at the end. Waits are read from pg_blocking_pids and
-- pg_locks, never from wall-clock time.

-- A run of Ada's in conversation f7 for member 2, its job queued, with its wake when one is named; committed, with
-- foreign keys and triggers off while the rows go in (as 648 builds its run).
create function pg_temp.cs_run(p_run uuid, p_job uuid, p_wake uuid, p_root uuid, p_parent uuid) returns void
language plpgsql as $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000a1'; v_requester uuid := '64800000-0000-4000-8000-000000000002';
	v_session uuid := '64800000-0000-4000-8000-0000000000f7';
begin
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, session_id, substrate_version_id, client_job_id,
		required_capability, job_type, payload, created_by_user_id, status, run_id)
	values (p_job, v_profile, v_env, v_session, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn',
		'agent_turn', '{}', v_requester, 'queued', p_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, compute_identity_id)
	values (p_run, v_profile, v_env, case when p_parent is null then 'room_delivery' else 'wake' end, coalesce(p_wake, p_run), p_job,
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), v_staff, 1, '64800000-0000-4000-8000-0000000000b1', 1,
		'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester, 'openai', 'gpt-test', 'provider_default', 'company',
		'64800000-0000-4000-8000-0000000000f9', repeat('b', 64), v_session, '{}', '64800000-0000-4000-8000-0000000000d1');
	if p_wake is not null then
		perform pg_temp.cs_wake(p_wake, p_root, p_parent, p_run);
	end if;
end $$;
-- A wake of Ada's in f7: a member's post when it has no parent (its own root), else a coworker message carrying its
-- parent's root; materialized with its run, or queued.
create function pg_temp.cs_wake(p_wake uuid, p_root uuid, p_parent uuid, p_run uuid) returns void language sql as $$
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for,
		not_before, wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id,
		sponsor_binding_id, sponsor_version, session_id, parent_run_id, causal_root_id, causal_agent_ids, causal_hop_count, payload)
	values (p_wake, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		case when p_parent is null then 'room' else 'coworker' end, 'chain-stop:' || p_wake, clock_timestamp(), clock_timestamp(),
		case when p_parent is null then 'room' else 'agent' end, case when p_parent is null then 'room' else 'coworker' end, p_wake,
		p_run, case when p_run is null then 'queued' else 'materialized' end, '64800000-0000-4000-8000-0000000000a1', 1,
		'64800000-0000-4000-8000-000000000002', '64800000-0000-4000-8000-0000000000b1', 1, '64800000-0000-4000-8000-0000000000f7',
		p_parent, p_root, array['64800000-0000-4000-8000-0000000000a1']::uuid[], case when p_parent is null then 0 else 1 end, '{}')
$$;
set session_replication_role = replica;
-- Chain A: 648's run f1 (root f3), its job in its conversation as a turn's job is, and a queued run Y its message woke.
update public.qorpera_runner_jobs set session_id = '64800000-0000-4000-8000-0000000000f7'
where id = '64800000-0000-4000-8000-0000000000f2';
select pg_temp.cs_run('79100000-0000-4000-8000-0000000000a1', '79100000-0000-4000-8000-0000000000a2',
	'79100000-0000-4000-8000-0000000000a3', '64800000-0000-4000-8000-0000000000f3', '64800000-0000-4000-8000-0000000000f1');
-- Chain B: a queued post run XB, a wake of it still queued (WB), and the run the materializer makes of WB (ZB).
select pg_temp.cs_run('79100000-0000-4000-8000-0000000000b1', '79100000-0000-4000-8000-0000000000b2',
	'79100000-0000-4000-8000-0000000000b3', '79100000-0000-4000-8000-0000000000b3', null);
select pg_temp.cs_wake('79100000-0000-4000-8000-0000000000b4', '79100000-0000-4000-8000-0000000000b3',
	'79100000-0000-4000-8000-0000000000b1', null);
select pg_temp.cs_run('79100000-0000-4000-8000-0000000000b5', '79100000-0000-4000-8000-0000000000b6', null, null,
	'79100000-0000-4000-8000-0000000000b1');
-- Chain C: a queued post run XC, and the run the materializer would make of a wake admitted during its Stop (ZC).
select pg_temp.cs_run('79100000-0000-4000-8000-0000000000c1', '79100000-0000-4000-8000-0000000000c2',
	'79100000-0000-4000-8000-0000000000c3', '79100000-0000-4000-8000-0000000000c3', null);
select pg_temp.cs_run('79100000-0000-4000-8000-0000000000c5', '79100000-0000-4000-8000-0000000000c6', null, null,
	'79100000-0000-4000-8000-0000000000c1');
set session_replication_role = origin;

-- The owner's Stop in f7, as a statement for a connection.
create function pg_temp.sql_stop(p_run uuid) returns text language sql as $$
	select format('select public.qorpera_cancel_session_run(%L, %L)::text', '64800000-0000-4000-8000-0000000000f7', p_run)
$$;
-- The materializer's own update of a wake into its run, as a statement for a connection.
create function pg_temp.sql_materialize(p_wake uuid, p_run uuid) returns text language sql as $$
	select format('update public.qorpera_wake_occurrences set status = %L, run_id = %L, blocked_reason = null where id = %L',
		'materialized', p_run, p_wake)
$$;
-- A sent statement's one text value, or its error (state and message); drains the connection.
create function pg_temp.answer(p_conn text) returns text language plpgsql as $$
declare v_answer text;
begin
	begin
		select r into v_answer from dblink_get_result(p_conn) as t(r text);
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_answer;
end $$;
create function pg_temp.job(p_run uuid) returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.job_id = job.id where run.id = p_run
$$;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}'$q$)
from unnest(array['fence_one','fence_two']) name;

-- A. Two Stops of one chain. The second waits for the chain's lock holding no job (its run's job stays free to lock),
--    then reads back the cancellation the first made: neither Stop waits for a job the other holds.
do $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select pg_advisory_xact_lock(public.qorpera_causal_chain_key(%L, %L))::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000f3')) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_stop('79100000-0000-4000-8000-0000000000a1'));
	if not pg_temp.waits_for('fence_two', 'fence_one') or not exists (select 1 from pg_locks
		where pid = current_setting('qorpera_test.pid_fence_two')::integer and locktype = 'advisory' and not granted) then
		raise exception 'The second Stop waits for the chain''s lock'; end if;
end $$;
-- It holds no job meanwhile: its run's job is free (taken and let go here, before the first Stop needs it).
select 1 from public.qorpera_runner_jobs where id = '79100000-0000-4000-8000-0000000000a2' for update nowait \g /dev/null
do $$
declare v_two text;
begin
	-- The first Stop ends the chain under the lock it holds, and commits.
	perform * from dblink('fence_one', pg_temp.sql_stop('64800000-0000-4000-8000-0000000000f1')) as t(r text);
	perform dblink_exec('fence_one', 'commit');
	v_two := pg_temp.answer('fence_two');
	if v_two is null or v_two::jsonb ->> 'status' is distinct from 'cancelled' then
		raise exception 'The second Stop reads back its run''s cancellation: %', v_two; end if;
end $$;
do $$
begin
	if (pg_temp.job('64800000-0000-4000-8000-0000000000f1')).status <> 'cancelled'
		or (pg_temp.job('79100000-0000-4000-8000-0000000000a1')).status <> 'cancelled'
		or (pg_temp.job('79100000-0000-4000-8000-0000000000a1')).cancelled_by_user_id <> '64800000-0000-4000-8000-000000000001'
		or (select count(*) from public.qorpera_runner_audit_receipts
			where job_id = '79100000-0000-4000-8000-0000000000a2' and event_type = 'job_cancelled') <> 1
		or (select count(*) from public.qorpera_stopped_chains where profile_id = '64800000-0000-4000-8000-000000000010'
			and causal_root_id = '64800000-0000-4000-8000-0000000000f3' and stopped_run_id = '64800000-0000-4000-8000-0000000000f1') <> 1
	then raise exception 'One Stop ended chain A once: %', (select jsonb_agg(to_jsonb(j)) from public.qorpera_runner_jobs j
		where j.id in ('64800000-0000-4000-8000-0000000000f2', '79100000-0000-4000-8000-0000000000a2')); end if;
end $$;

-- B. The materializer first: it made a run of chain B's queued wake and has not committed. The owner's Stop of B waits
--    for it, then finds that run and cancels it; without the lock the run would outlive the Stop.
do $$
declare v_one text;
begin
	perform dblink_exec('fence_three', 'begin');
	perform dblink_exec('fence_three', pg_temp.sql_materialize('79100000-0000-4000-8000-0000000000b4',
		'79100000-0000-4000-8000-0000000000b5'));
	perform dblink_send_query('fence_one', pg_temp.sql_stop('79100000-0000-4000-8000-0000000000b1'));
	if not pg_temp.waits_for('fence_one', 'fence_three') then raise exception 'The Stop waits for the materializer'; end if;
	perform dblink_exec('fence_three', 'commit');
	v_one := pg_temp.answer('fence_one');
	if v_one is null or v_one::jsonb ->> 'status' is distinct from 'cancelled' then
		raise exception 'The Stop of chain B ends: %', v_one; end if;
end $$;
do $$
begin
	if (pg_temp.job('79100000-0000-4000-8000-0000000000b5')).status <> 'cancelled'
		or (pg_temp.job('79100000-0000-4000-8000-0000000000b5')).cancelled_by_user_id <> '64800000-0000-4000-8000-000000000001'
		or (select status from public.qorpera_wake_occurrences where id = '79100000-0000-4000-8000-0000000000b4') <> 'cancelled'
		or (pg_temp.job('79100000-0000-4000-8000-0000000000b1')).status <> 'cancelled' then
		raise exception 'The run made beside the Stop is cancelled with its chain: %', to_jsonb(pg_temp.job('79100000-0000-4000-8000-0000000000b5'));
	end if;
end $$;

-- C. A wake admitted while chain C's Stop is in flight (the Stop's record not yet visible to its admission). The
--    materializer meets the Stop's lock and leaves the wake queued at once, without waiting; once the Stop committed, it
--    is refused (the materializer cancels a wake that raises 42501).
do $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_stop('79100000-0000-4000-8000-0000000000c1')) as t(r text);
	set local session_replication_role = replica;
	perform pg_temp.cs_wake('79100000-0000-4000-8000-0000000000c4', '79100000-0000-4000-8000-0000000000c3',
		'79100000-0000-4000-8000-0000000000c1', null);
	set local session_replication_role = origin;
end $$;
do $$
declare v_three text;
begin
	perform dblink_send_query('fence_three', pg_temp.sql_materialize('79100000-0000-4000-8000-0000000000c4',
		'79100000-0000-4000-8000-0000000000c5'));
	if not pg_temp.finishes_unblocked('fence_three', 'fence_one') then
		raise exception 'The materializer never waits for a Stop'; end if;
	v_three := pg_temp.answer('fence_three');
	if v_three not like '55P03 %A member is stopping this chain of agent work%' then
		raise exception 'While the Stop is in flight the wake stays queued: %', v_three; end if;
	perform dblink_exec('fence_one', 'commit');
	perform dblink_send_query('fence_three', pg_temp.sql_materialize('79100000-0000-4000-8000-0000000000c4',
		'79100000-0000-4000-8000-0000000000c5'));
	v_three := pg_temp.answer('fence_three');
	if v_three not like '42501 %A member stopped this chain of agent work%' then
		raise exception 'Once the Stop committed the wake is refused: %', v_three; end if;
	if (select status from public.qorpera_wake_occurrences where id = '79100000-0000-4000-8000-0000000000c4') <> 'queued'
		or (pg_temp.job('79100000-0000-4000-8000-0000000000c1')).status <> 'cancelled' then
		raise exception 'Only the refusals touched the late wake'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: every row of the company, its environment, its runs, jobs, sessions, rooms and login (as 648).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_wake_occurrences where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_stopped_chains where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;

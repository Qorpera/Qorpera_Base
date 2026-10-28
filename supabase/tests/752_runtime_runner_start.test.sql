-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Runner start on folder-v2: qorpera_start_runner_assignment (acceptance, broker description and native authority in
-- one transaction) is a security definer with a pinned search path, and it refuses every stale or foreign authority
-- exactly as acceptance does: another session, a malformed or another capability, an unknown assignment, another job or
-- runner, an expired runner session, offer or claim, a revoked sponsor connection and an API client. A superseded
-- assignment (its job lease ran out and the sweep re-queued the run) gets nothing again: no start, no lease, no renewal,
-- no execution check, while the next assignment starts with a lease of its own. The run is the owner's post to Bob on
-- 924's company (ported from snapshot-v1 in the legacy sweep).

-- The owner's post to Bob becomes a run; the real orchestrator claims it and assigns it to a fresh runner.
do $$
declare
	v_pass jsonb;
	v_run uuid;
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Check the runner start.');
	v_pass := pg_temp.base_materialize();
	if jsonb_array_length(v_pass -> 'run_ids') <> 1 then
		raise exception 'the post to Bob was not materialized: %', v_pass; end if;
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'92400000-0000-4000-8000-000000000092', '75200000-0000-4000-8000-000000000001', 120);
	if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run then
		raise exception 'the orchestrator did not claim Bob''s run: %', v_claim; end if;
	v_runner := public.qorpera_provision_execution_runner(
		v_run, '75200000-0000-4000-8000-000000000002', 'process', repeat('1', 64));
	perform public.qorpera_activate_runner(
		(v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'runner-start-test');
	v_assignment := public.qorpera_assign_runner_job(
		'92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid, (v_runner ->> 'runner_id')::uuid,
		'75200000-0000-4000-8000-000000000003', repeat('3', 64), 120);
	perform set_config('qorpera_test.rs_start', jsonb_build_object(
		'run', v_run,
		'job', v_claim -> 'work' ->> 'job_id',
		'claim', v_claim ->> 'claim_id',
		'runner', v_runner ->> 'runner_id',
		'assignment', v_assignment ->> 'assignment_id'
	)::text, true);
end $$;

-- The outcome of one call, always rolled back: its result, or its SQLSTATE and message.
create function pg_temp.rs_outcome(p_call text, p_setup text default null)
returns jsonb language plpgsql as $$
declare v_result jsonb; v_state text; v_message text;
begin
	begin
		if p_setup is not null then
			begin
				execute p_setup;
			exception when others then
				raise exception 'scenario setup failed: %', sqlerrm using errcode = 'QTS09';
			end;
		end if;
		execute p_call into v_result;
		raise exception using errcode = 'QTS01', message = coalesce(v_result, 'null'::jsonb)::text;
	exception
		when sqlstate 'QTS01' then
			get stacked diagnostics v_message = message_text;
			return jsonb_build_object('result', v_message::jsonb);
		when sqlstate 'QTS09' then
			raise;
		when others then
			get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
			return jsonb_build_object('state', v_state, 'message', v_message);
	end;
end $$;

-- `%1$s` runner, `%2$s` session token hash, `%3$s` assignment, `%4$s` job, `%5$s` capability hash.
create function pg_temp.rs_call(p_function text, p_args jsonb default '{}', p_native text default '120')
returns text language sql as $$
	select format(
		case p_function
			when 'accept' then 'select public.qorpera_accept_runner_assignment(%1$L::uuid,%2$L,%3$L::uuid,%4$L::uuid,%5$L)'
			else 'select public.qorpera_start_runner_assignment(%1$L::uuid,%2$L,%3$L::uuid,%4$L::uuid,%5$L,%6$s)'
		end,
		coalesce(p_args ->> 'runner', s.value ->> 'runner'),
		coalesce(p_args ->> 'session', repeat('2', 64)),
		coalesce(p_args ->> 'assignment', s.value ->> 'assignment'),
		coalesce(p_args ->> 'job', s.value ->> 'job'),
		coalesce(p_args ->> 'capability', repeat('3', 64)),
		p_native
	)
	from (select current_setting('qorpera_test.rs_start')::jsonb as value) s;
$$;

-- 1. The start is a security definer with a pinned search path (who may execute it: 001's final block).
do $$ begin
	if (select prosecdef from pg_proc where oid = 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)'::regprocedure) is not true
		or (select proconfig from pg_proc where oid = 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)'::regprocedure) <> array['search_path=""'] then
		raise exception 'runner start has the wrong configuration'; end if;
end $$;

-- 2. Every refusal of acceptance is the start's refusal: same SQLSTATE, same message. The probes change rows directly,
-- so they run as the table owner; the service role claim stays.
do $$
declare
	v_start jsonb := current_setting('qorpera_test.rs_start')::jsonb;
	v_case record;
	v_accept jsonb;
	v_started jsonb;
begin
	for v_case in select * from (values
		('another session', jsonb_build_object('session', repeat('9', 64)), null, '42501'),
		('a malformed capability', jsonb_build_object('capability', 'not-a-hash'), null, '42501'),
		('another capability', jsonb_build_object('capability', repeat('8', 64)), null, '42501'),
		('an unknown assignment', jsonb_build_object('assignment', gen_random_uuid()), null, '42501'),
		('another job', jsonb_build_object('job', gen_random_uuid()), null, '42501'),
		('another runner', jsonb_build_object('runner', gen_random_uuid()), null, '42501'),
		('an expired runner session', '{}'::jsonb, format(
			'update public.qorpera_runners set session_expires_at = statement_timestamp() - interval ''1 second'' where id = %L',
			v_start ->> 'runner'), '42501'),
		('an expired offer', '{}'::jsonb, format(
			'update public.qorpera_runner_assignments set expires_at = statement_timestamp() - interval ''1 second'' where id = %L',
			v_start ->> 'assignment'), 'PGRST'),
		('an expired claim', '{}'::jsonb, format(
			'update public.qorpera_runner_job_claims set lease_expires_at = statement_timestamp() - interval ''1 second'' where id = %L',
			v_start ->> 'claim'), '55000'),
		('a revoked sponsor connection', '{}'::jsonb, format(
			'update public.qorpera_provider_connections set status = %L where id = %L', 'revoked',
			current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'), '42501'),
		('an API client', '{}'::jsonb,
			'select set_config(''request.jwt.claims'', ''{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}'', true)',
			'42501')
	) as scenario(label, args, setup, expected)
	loop
		v_accept := pg_temp.rs_outcome(pg_temp.rs_call('accept', v_case.args), v_case.setup);
		v_started := pg_temp.rs_outcome(pg_temp.rs_call('start', v_case.args), v_case.setup);
		if v_accept ->> 'state' is distinct from v_case.expected or v_started is distinct from v_accept then
			raise exception 'start refused % differently from acceptance: % vs %', v_case.label, v_started, v_accept;
		end if;
	end loop;
end $$;

-- 3. The real start takes the run's native lease.
set local role service_role;
do $$
declare v_start jsonb := current_setting('qorpera_test.rs_start')::jsonb; v_started jsonb;
begin
	v_started := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_start ->> 'assignment')::uuid, (v_start ->> 'job')::uuid, repeat('3', 64), 120);
	if v_started #>> '{job,status}' <> 'leased' or v_started -> 'native_authority' = 'null'::jsonb
		or not exists (select 1 from public.qorpera_native_provider_connection_leases
			where id = (v_started #>> '{native_authority,lease_id}')::uuid and run_id = (v_start ->> 'run')::uuid
				and status = 'active') then
		raise exception 'the start did not lease the run: %', v_started;
	end if;
end $$;
reset role;

-- 4. A start whose response is lost: the runner never replays, its job lease runs out, and the sweep re-queues the run.
-- The superseded assignment's runner is refused before and after the sweep; the next assignment starts with its own lease.
update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.rs_start')::jsonb ->> 'job')::uuid;
set local role service_role;
do $$
declare
	v_start jsonb := current_setting('qorpera_test.rs_start')::jsonb;
	v_old public.qorpera_native_provider_connection_leases%rowtype;
	v_outcome jsonb;
begin
	select * into strict v_old from public.qorpera_native_provider_connection_leases
	where run_id = (v_start ->> 'run')::uuid;
	-- A late start of the old assignment before the sweep is refused like a late acceptance.
	v_outcome := pg_temp.rs_outcome(pg_temp.rs_call('start'));
	if v_outcome ? 'result' or v_outcome is distinct from pg_temp.rs_outcome(pg_temp.rs_call('accept')) then
		raise exception 'a late start of an expired assignment was not refused like acceptance: %', v_outcome;
	end if;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	if (select status from public.qorpera_runner_jobs where id = (v_start ->> 'job')::uuid) <> 'queued'
		or (select status from public.qorpera_runner_assignments where id = (v_start ->> 'assignment')::uuid) <> 'failed'
		or exists (select 1 from public.qorpera_native_provider_connection_leases
			where run_id = (v_start ->> 'run')::uuid) then
		raise exception 'the pristine retry did not release the unstarted native lease';
	end if;
	-- After the sweep the old assignment's runner gets nothing: no start, no lease, no renewal, no execution check.
	v_outcome := pg_temp.rs_outcome(pg_temp.rs_call('start'));
	if v_outcome ? 'result' or v_outcome is distinct from pg_temp.rs_outcome(pg_temp.rs_call('accept')) then
		raise exception 'the superseded assignment started again: %', v_outcome;
	end if;
	foreach v_outcome in array array[
		pg_temp.rs_outcome(format('select public.qorpera_acquire_native_provider_connection_lease(%L::uuid,%L::uuid,%L,%L::uuid,%L,120)',
			v_start ->> 'run', v_start ->> 'runner', repeat('2', 64), v_start ->> 'assignment', repeat('3', 64))),
		pg_temp.rs_outcome(format('select public.qorpera_renew_native_provider_connection_lease(%L::uuid,%L::uuid,%L,%L::uuid,%L,120)',
			v_old.id, v_start ->> 'runner', repeat('2', 64), v_start ->> 'job', repeat('3', 64))),
		pg_temp.rs_outcome(format('select public.qorpera_validate_native_provider_execution_lease(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L,%L)',
			v_old.id, v_start ->> 'run', v_start ->> 'job', v_start ->> 'runner', v_start ->> 'assignment',
			v_old.credential_capsule_id, v_old.compute_identity_id, 'openai', 'codex-cli'))
	] loop
		if v_outcome ? 'result' then
			raise exception 'the superseded assignment still holds native authority: %', v_outcome;
		end if;
	end loop;
	-- The pristine retry waits first (20260930537000).
	if public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
		'75200000-0000-4000-8000-000000000006', 120) #>> '{work,job_id}' is not null then
		raise exception 'the pristine retry did not wait';
	end if;
	perform set_config('qorpera_test.rs_old_lease', v_old.id::text, true);
end $$;
reset role;

-- The wait is over, and the job is queued again from its end.
update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp(), queued_at = statement_timestamp()
where id = (current_setting('qorpera_test.rs_start')::jsonb ->> 'job')::uuid;
set local role service_role;
do $$
declare
	v_start jsonb := current_setting('qorpera_test.rs_start')::jsonb;
	v_old_lease uuid := current_setting('qorpera_test.rs_old_lease')::uuid;
	v_claim jsonb;
	v_assignment jsonb;
	v_started jsonb;
begin
	-- The next assignment of the same run starts with a lease of its own.
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'92400000-0000-4000-8000-000000000092', '75200000-0000-4000-8000-000000000004', 120);
	if (v_claim -> 'work' ->> 'job_id')::uuid is distinct from (v_start ->> 'job')::uuid then
		raise exception 'the re-queued run was not claimed again: %', v_claim;
	end if;
	v_assignment := public.qorpera_assign_runner_job(
		'92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid, (v_start ->> 'runner')::uuid,
		'75200000-0000-4000-8000-000000000005', repeat('4', 64), 120);
	v_started := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, (v_start ->> 'job')::uuid, repeat('4', 64), 120);
	if v_started -> 'native_authority' = 'null'::jsonb
		or (v_started #>> '{native_authority,lease_id}')::uuid = v_old_lease
		or v_started #>> '{native_authority,assignment_id}' <> v_assignment ->> 'assignment_id'
		or (select count(*) from public.qorpera_native_provider_connection_leases
			where run_id = (v_start ->> 'run')::uuid and status = 'active') <> 1 then
		raise exception 'the retry did not start with its own native lease: %', v_started;
	end if;
end $$;
reset role;

rollback;

-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Runner start (2026-09-29 stack audit): qorpera_start_runner_assignment is acceptance, broker
-- description and native authority in one transaction. It refuses what acceptance refuses, with the
-- same error; it returns what the separate calls return; a refusal after acceptance leaves the
-- acceptance committed and returns neither description nor authority, so the runner makes the
-- separate calls; and it holds acceptance's locks only under a short lock_timeout.

-- A claimed native turn assigned to a fresh runner (the fixture's real orchestrator path).
do $$
declare
	v_run_id uuid := (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'16000000-0000-4000-8000-000000000092', '73100000-0000-4000-8000-000000000001', 120);
	if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run_id then
		raise exception 'the fixture did not claim the native turn'; end if;
	v_runner := public.qorpera_provision_execution_runner(
		v_run_id, '73100000-0000-4000-8000-000000000002', 'process', repeat('1', 64));
	perform public.qorpera_activate_runner(
		(v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'runner-start-test');
	v_assignment := public.qorpera_assign_runner_job(
		'16000000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid, (v_runner ->> 'runner_id')::uuid,
		'73100000-0000-4000-8000-000000000003', repeat('3', 64), 120);
	perform set_config('qorpera_test.start', jsonb_build_object(
		'run', v_run_id,
		'job', v_claim -> 'work' ->> 'job_id',
		'claim', v_claim ->> 'claim_id',
		'runner', v_runner ->> 'runner_id',
		'assignment', v_assignment ->> 'assignment_id'
	)::text, false);
end $$;

-- The outcome of one call, always rolled back: its result, or its SQLSTATE and message.
create function pg_temp.start_outcome(p_call text, p_setup text default null)
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
create function pg_temp.start_call(p_function text, p_args jsonb default '{}', p_native text default '120')
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
	from (select current_setting('qorpera_test.start')::jsonb as value) s;
$$;

-- Only the service role may start a runner, as only it may accept, describe or take authority.
do $$ begin
	if has_function_privilege('anon', 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)', 'EXECUTE')
		or (select prosecdef from pg_proc where oid = 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)'::regprocedure) is not true
		or (select proconfig from pg_proc where oid = 'public.qorpera_start_runner_assignment(uuid,text,uuid,uuid,text,integer)'::regprocedure) <> array['search_path=""'] then
		raise exception 'runner start has the wrong privileges or configuration'; end if;
end $$;

-- Every refusal of acceptance is the start's refusal: same SQLSTATE, same message. The probes
-- change rows directly, so they run as the table owner; the service role claim stays.
reset role;
-- The run's Company File snapshot is closure-verified, which the broker description requires.
insert into public.qorpera_object_reachability_graphs (
	id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count,
	storage_bytes, status, created_by_user_id, completed_at, closure_verified
) values (
	'73100000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020', 'company_snapshot', '16000000-0000-4000-8000-000000000023',
	'73100000-0000-4000-8000-000000000011', repeat('c', 64), 1, repeat('b', 64), 1, 2, 'complete',
	'16000000-0000-4000-8000-000000000001', statement_timestamp(), true
);
do $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
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
			current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id'), '42501'),
		('an API client', '{}'::jsonb,
			'select set_config(''request.jwt.claims'', ''{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}'', true)',
			'42501')
	) as scenario(label, args, setup, expected)
	loop
		v_accept := pg_temp.start_outcome(pg_temp.start_call('accept', v_case.args), v_case.setup);
		v_started := pg_temp.start_outcome(pg_temp.start_call('start', v_case.args), v_case.setup);
		if v_accept ->> 'state' is distinct from v_case.expected or v_started is distinct from v_accept then
			raise exception 'start refused % differently from acceptance: % vs %', v_case.label, v_started, v_accept;
		end if;
	end loop;
end $$;

-- It returns what the separate calls return in the same instant, as the runner asks for them.
create function pg_temp.separate_start(p_native boolean)
returns jsonb language plpgsql as $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
	v_job jsonb;
	v_description jsonb;
	v_authority jsonb;
begin
	v_job := public.qorpera_accept_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_start ->> 'assignment')::uuid, (v_start ->> 'job')::uuid, repeat('3', 64));
	v_description := public.qorpera_runner_broker_describe((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_start ->> 'job')::uuid, repeat('3', 64));
	if p_native then
		v_authority := public.qorpera_acquire_native_provider_connection_lease((v_description #>> '{run,run_id}')::uuid,
			(v_start ->> 'runner')::uuid, repeat('2', 64), (v_start ->> 'assignment')::uuid, repeat('3', 64), 120)
			|| jsonb_build_object('model', public.qorpera_native_run_model_authority(
				(v_description #>> '{run,run_id}')::uuid, (v_start ->> 'runner')::uuid, repeat('2', 64),
				(v_start ->> 'job')::uuid, repeat('3', 64)));
	end if;
	return jsonb_build_object('job', v_job, 'description', v_description, 'native_authority', v_authority);
end $$;

do $$
declare
	v_separate jsonb;
	v_started jsonb;
begin
	foreach v_separate in array array[
		pg_temp.start_outcome('select pg_temp.separate_start(true)'),
		pg_temp.start_outcome('select pg_temp.separate_start(false)')
	] loop
		if not v_separate ? 'result' then
			raise exception 'the separate calls refused the fixture run: %', v_separate; end if;
	end loop;
	v_separate := pg_temp.start_outcome('select pg_temp.separate_start(true)') -> 'result';
	v_started := pg_temp.start_outcome(pg_temp.start_call('start')) -> 'result';
	if v_started -> 'description' ->> 'company_runtime' is null
		or v_started #>> '{description,sponsor,authentication_mode}' <> 'native_subscription'
		or v_started -> 'job' <> v_separate -> 'job'
		or v_started -> 'description' <> v_separate -> 'description'
		-- A new lease row has a new id; everything else is the separate acquisition's.
		or (v_started -> 'native_authority') - 'lease_id' <> (v_separate -> 'native_authority') - 'lease_id'
		or v_started #>> '{native_authority,model,model}' <> 'gpt-native' then
		raise exception 'start differs from the separate calls: % vs %', v_started, v_separate;
	end if;
	-- Without a native lease length it takes no authority, as a runner without a native bridge.
	v_separate := pg_temp.start_outcome('select pg_temp.separate_start(false)') -> 'result';
	v_started := pg_temp.start_outcome(pg_temp.start_call('start', '{}', 'null')) -> 'result';
	if v_started <> v_separate or v_started -> 'native_authority' <> 'null'::jsonb then
		raise exception 'a start without native authority differs: % vs %', v_started, v_separate;
	end if;
end $$;

-- A refusal after acceptance defers the reads: the acceptance stays, nothing of step 2 does.
-- Each probe replaces the model authority inside a subtransaction that is rolled back.
do $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
	v_started jsonb;
	v_code text;
	v_lock_timeout text := current_setting('lock_timeout');
begin
	foreach v_code in array array['55P03', '40P01', '42501', '55000'] loop
		begin
			execute format($f$
				create or replace function public.qorpera_native_run_model_authority(
					p_run_id uuid, p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text)
				returns jsonb language plpgsql security definer set search_path = '' as $b$
				begin raise exception 'synthetic step 2 refusal' using errcode = %L; end $b$
			$f$, v_code);
			v_started := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
				(v_start ->> 'assignment')::uuid, (v_start ->> 'job')::uuid, repeat('3', 64), 120);
			if v_started -> 'description' <> 'null'::jsonb or v_started -> 'native_authority' <> 'null'::jsonb
				or v_started #>> '{job,status}' <> 'leased'
				or not exists (select 1 from public.qorpera_runner_jobs job
					where job.id = (v_start ->> 'job')::uuid and job.status = 'leased'
						and job.runner_id = (v_start ->> 'runner')::uuid)
				or not exists (select 1 from public.qorpera_runner_assignments assignment
					where assignment.id = (v_start ->> 'assignment')::uuid and assignment.status = 'accepted')
				or exists (select 1 from public.qorpera_native_provider_connection_leases lease
					where lease.run_id = (v_start ->> 'run')::uuid)
				or current_setting('lock_timeout') <> v_lock_timeout then
				raise exception 'a % refusal after acceptance was not deferred cleanly: %', v_code, v_started;
			end if;
			-- The runner's separate call then takes the lease; nothing was left behind.
			perform public.qorpera_acquire_native_provider_connection_lease((v_start ->> 'run')::uuid,
				(v_start ->> 'runner')::uuid, repeat('2', 64), (v_start ->> 'assignment')::uuid, repeat('3', 64), 120);
			raise exception using errcode = 'QTS02';
		exception when sqlstate 'QTS02' then null;
		end;
	end loop;
end $$;

-- Step 2 runs with the short lock_timeout, and the caller's setting is restored after it.
do $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
	v_started jsonb;
begin
	perform set_config('lock_timeout', '7s', true);
	begin
		create or replace function public.qorpera_native_run_model_authority(
			p_run_id uuid, p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text)
		returns jsonb language plpgsql security definer set search_path = '' as $b$
		begin
			perform set_config('qorpera_test.step2_lock_timeout', current_setting('lock_timeout'), false);
			return jsonb_build_object('provider', 'openai', 'model', 'gpt-native');
		end $b$;
		v_started := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
			(v_start ->> 'assignment')::uuid, (v_start ->> 'job')::uuid, repeat('3', 64), 120);
		if v_started -> 'native_authority' = 'null'::jsonb
			or current_setting('qorpera_test.step2_lock_timeout') <> '50ms'
			or current_setting('lock_timeout') <> '7s' then
			raise exception 'step 2 lock_timeout % (after: %), start %',
				current_setting('qorpera_test.step2_lock_timeout'), current_setting('lock_timeout'), v_started;
		end if;
		raise exception using errcode = 'QTS02';
	exception when sqlstate 'QTS02' then null;
	end;
end $$;
reset lock_timeout;

-- The real start, then a replay: the same lease and authority, one start event, one lease row.
set role service_role;
do $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
	v_first jsonb;
	v_replay jsonb;
	v_separate jsonb;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
begin
	v_first := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_start ->> 'assignment')::uuid, (v_start ->> 'job')::uuid, repeat('3', 64), 120);
	select * into strict v_lease from public.qorpera_native_provider_connection_leases
	where run_id = (v_start ->> 'run')::uuid;
	if v_first #>> '{job,status}' <> 'leased'
		or (v_first #>> '{native_authority,lease_id}')::uuid <> v_lease.id
		or v_lease.status <> 'active' or v_lease.runner_id <> (v_start ->> 'runner')::uuid
		or v_lease.assignment_id <> (v_start ->> 'assignment')::uuid
		or v_lease.lease_token_sha256 <> repeat('3', 64)
		or v_lease.expires_at <> statement_timestamp() + interval '120 seconds'
		or (select status from public.qorpera_runner_job_claims where id = (v_start ->> 'claim')::uuid) <> 'accepted'
		or (select count(*) from public.qorpera_execution_run_events
			where run_id = (v_start ->> 'run')::uuid and event_type = 'runner_started') <> 1 then
		raise exception 'the start did not accept and lease exactly once: %', v_first;
	end if;
	-- The runner replays after a lost response: acceptance's and acquisition's own replay paths.
	v_replay := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_start ->> 'assignment')::uuid, (v_start ->> 'job')::uuid, repeat('3', 64), 120);
	v_separate := pg_temp.start_outcome('select pg_temp.separate_start(true)') -> 'result';
	if v_replay <> v_first or v_replay <> v_separate
		or (select count(*) from public.qorpera_native_provider_connection_leases
			where run_id = (v_start ->> 'run')::uuid) <> 1
		or (select count(*) from public.qorpera_execution_run_events
			where run_id = (v_start ->> 'run')::uuid and event_type = 'runner_started') <> 1 then
		raise exception 'a replayed start differs: % vs % vs %', v_replay, v_first, v_separate;
	end if;
	-- After the start, the runner's later calls see the same lease.
	perform public.qorpera_renew_native_provider_connection_lease(v_lease.id, (v_start ->> 'runner')::uuid,
		repeat('2', 64), (v_start ->> 'job')::uuid, repeat('3', 64), 120);
	perform public.qorpera_validate_native_provider_execution_lease(v_lease.id, (v_start ->> 'run')::uuid,
		(v_start ->> 'job')::uuid, (v_start ->> 'runner')::uuid, (v_start ->> 'assignment')::uuid,
		v_lease.credential_capsule_id, v_lease.compute_identity_id, 'openai', 'codex-cli');
end $$;
reset role;

-- A started native execution keeps its lease when its job lease runs out: it follows today's
-- recovery path (no pristine retry), and the re-queue release never touches it.
do $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
	v_lease uuid := (select id from public.qorpera_native_provider_connection_leases
		where run_id = (v_start ->> 'run')::uuid);
begin
	begin
		insert into public.qorpera_execution_run_events(run_id, event_type, payload)
		values ((v_start ->> 'run')::uuid, 'runner_started', jsonb_build_object(
			'schema', 'qorpera.native-company-execution-start/v1', 'runId', v_start ->> 'run',
			'jobId', v_start ->> 'job', 'leaseId', v_lease, 'binarySha256', repeat('a', 64)));
		update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second'
		where id = (v_start ->> 'job')::uuid;
		perform public.qorpera_reconcile_runner_orchestrator('16000000-0000-4000-8000-000000000092');
		if (select status from public.qorpera_runner_jobs where id = (v_start ->> 'job')::uuid) = 'queued'
			or not exists (select 1 from public.qorpera_native_provider_connection_leases where id = v_lease)
			or exists (select 1 from public.qorpera_native_provider_connection_lease_history where lease_id = v_lease) then
			raise exception 'a started native execution lost its lease to the re-queue release';
		end if;
		raise exception using errcode = 'QTS02';
	exception when sqlstate 'QTS02' then null;
	end;
end $$;

-- A start whose response is lost: the runner never replays, its job lease runs out, and the sweep
-- re-queues the run as a pristine retry. The superseded assignment's runner is refused before and
-- after the sweep (both orders serialise on the job row); the next assignment starts with its own lease.
update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.start')::jsonb ->> 'job')::uuid;
set role service_role;
do $$
declare
	v_start jsonb := current_setting('qorpera_test.start')::jsonb;
	v_old public.qorpera_native_provider_connection_leases%rowtype;
	v_outcome jsonb;
	v_claim jsonb;
	v_assignment jsonb;
	v_started jsonb;
begin
	select * into strict v_old from public.qorpera_native_provider_connection_leases
	where run_id = (v_start ->> 'run')::uuid;
	-- A late start of the old assignment before the sweep is refused like a late acceptance.
	v_outcome := pg_temp.start_outcome(pg_temp.start_call('start'));
	if v_outcome ? 'result' or v_outcome is distinct from pg_temp.start_outcome(pg_temp.start_call('accept')) then
		raise exception 'a late start of an expired assignment was not refused like acceptance: %', v_outcome;
	end if;
	perform public.qorpera_reconcile_runner_orchestrator('16000000-0000-4000-8000-000000000092');
	if (select status from public.qorpera_runner_jobs where id = (v_start ->> 'job')::uuid) <> 'queued'
		or (select status from public.qorpera_runner_assignments where id = (v_start ->> 'assignment')::uuid) <> 'failed'
		or exists (select 1 from public.qorpera_native_provider_connection_leases
			where run_id = (v_start ->> 'run')::uuid) then
		raise exception 'the pristine retry did not release the unstarted native lease';
	end if;
	perform set_config('qorpera_test.released_lease', v_old.id::text, false);
	-- After the sweep the old assignment's runner gets nothing: no start, no lease, no renewal,
	-- no execution check.
	v_outcome := pg_temp.start_outcome(pg_temp.start_call('start'));
	if v_outcome ? 'result' or v_outcome is distinct from pg_temp.start_outcome(pg_temp.start_call('accept')) then
		raise exception 'the superseded assignment started again: %', v_outcome;
	end if;
	foreach v_outcome in array array[
		pg_temp.start_outcome(format('select public.qorpera_acquire_native_provider_connection_lease(%L::uuid,%L::uuid,%L,%L::uuid,%L,120)',
			v_start ->> 'run', v_start ->> 'runner', repeat('2', 64), v_start ->> 'assignment', repeat('3', 64))),
		pg_temp.start_outcome(format('select public.qorpera_renew_native_provider_connection_lease(%L::uuid,%L::uuid,%L,%L::uuid,%L,120)',
			v_old.id, v_start ->> 'runner', repeat('2', 64), v_start ->> 'job', repeat('3', 64))),
		pg_temp.start_outcome(format('select public.qorpera_validate_native_provider_execution_lease(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L,%L)',
			v_old.id, v_start ->> 'run', v_start ->> 'job', v_start ->> 'runner', v_start ->> 'assignment',
			v_old.credential_capsule_id, v_old.compute_identity_id, 'openai', 'codex-cli'))
	] loop
		if v_outcome ? 'result' then
			raise exception 'the superseded assignment still holds native authority: %', v_outcome;
		end if;
	end loop;
	-- The next assignment of the same run starts with a lease of its own.
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'16000000-0000-4000-8000-000000000092', '73100000-0000-4000-8000-000000000004', 120);
	if (v_claim -> 'work' ->> 'job_id')::uuid is distinct from (v_start ->> 'job')::uuid then
		raise exception 'the re-queued run was not claimed again: %', v_claim;
	end if;
	v_assignment := public.qorpera_assign_runner_job(
		'16000000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid, (v_start ->> 'runner')::uuid,
		'73100000-0000-4000-8000-000000000005', repeat('4', 64), 120);
	v_started := public.qorpera_start_runner_assignment((v_start ->> 'runner')::uuid, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, (v_start ->> 'job')::uuid, repeat('4', 64), 120);
	if v_started -> 'native_authority' = 'null'::jsonb
		or (v_started #>> '{native_authority,lease_id}')::uuid = v_old.id
		or v_started #>> '{native_authority,assignment_id}' <> v_assignment ->> 'assignment_id'
		or (select count(*) from public.qorpera_native_provider_connection_leases
			where run_id = (v_start ->> 'run')::uuid and status = 'active') <> 1 then
		raise exception 'the retry did not start with its own native lease: %', v_started;
	end if;
end $$;
reset role;
-- The released lease is kept in the lease history, which only its owner reads.
do $$ begin
	if not exists (select 1 from public.qorpera_native_provider_connection_lease_history as history
		where history.lease_id = current_setting('qorpera_test.released_lease')::uuid
			and history.assignment_id = (current_setting('qorpera_test.start')::jsonb ->> 'assignment')::uuid
			and history.status = 'revoked' and history.released_at is not null) then
		raise exception 'the released native lease is missing from the lease history';
	end if;
end $$;

rollback;

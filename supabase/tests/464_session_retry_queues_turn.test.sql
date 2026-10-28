-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"
-- WB F4 (20260930536000): Try again on a failed folder-v2 turn queues a new turn. After a real creation (856's fixture:
-- the Co-Founder's first run queued on Anna's login), the first run materializes and fails. Try again on a run with a
-- completed operation, or in a closed conversation, is refused, and nothing is released or queued. Anna's Try again
-- releases the kickoff and queues a new request for it (its own id; the old request's payer, computer and policy), the
-- newest in the thread, so a turn queued before it runs first; the materializer then makes the retry a new run, with its
-- own job and first-run wake. The same run cannot be tried again twice. A retried run that fails is tried again, and the
-- materializer refuses that retry once its login is gone, failing the kickoff with the reason.

-- Each pass as its own transaction would start it.
create function pg_temp.materialize(p_profile uuid, p_limit integer default 16) returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;
-- A member's Try again: 'ok', or the refusal's SQLSTATE and message.
create function pg_temp.retry(p_run uuid, p_user uuid default '85600000-0000-4000-8000-000000000001') returns text
language plpgsql as $$
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	perform public.qorpera_resolve_failed_execution_run(p_run, 'retry');
	reset role;
	return 'ok';
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
-- Anna's start of the Co-Founder's first run, as the web asks for it.
create function pg_temp.start() returns jsonb language plpgsql as $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_start jsonb;
begin
	perform pg_temp.as_user('85600000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_start := public.qorpera_start_agent_first_run((v_claim ->> 'environmentId')::uuid, (v_claim ->> 'cofounderId')::uuid);
	reset role;
	return v_start;
end $$;
create function pg_temp.fail_job(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'F4 test'
	where run_id = p_run
$$;
create function pg_temp.state() returns text language sql as $$
	select public.qorpera_folder_company_first_run_state(current_setting('qorpera_test.table')::uuid)
$$;

do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_request public.qorpera_session_turn_requests;
begin
	select * into strict v_request from public.qorpera_session_turn_requests where profile_id = (v_claim ->> 'profileId')::uuid;
	perform set_config('qorpera_test.request', v_request.id::text, true);
	perform set_config('qorpera_test.input', v_request.input_id::text, true);
	perform set_config('qorpera_test.session', v_request.session_id::text, true);
	perform set_config('qorpera_test.binding', v_request.sponsor_binding_id::text, true);
end $$;

-- 1. The first run materializes and fails ---------------------------------------------------------------------------

do $$
declare v_result jsonb := pg_temp.materialize(current_setting('qorpera_test.table')::uuid);
begin
	if v_result -> 'run_ids' is distinct from jsonb_build_array(current_setting('qorpera_test.request'))
		or pg_temp.state() is distinct from 'started' then
		raise exception 'The first run did not start: %', v_result; end if;
end $$;
select pg_temp.fail_job(current_setting('qorpera_test.request')::uuid);

-- 2. A run with a completed operation, or in a closed conversation, is refused; nothing is released or queued ---------

do $$
declare v_run uuid := current_setting('qorpera_test.request')::uuid; v_receipt text; v_closed text;
begin
	begin
		set local session_replication_role = replica;
		insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
			input_sha256, downstream_idempotency_sha256, status, result, completed_at)
		select extensions.gen_random_uuid(), run.id, run.job_id, extensions.gen_random_uuid(), 'f4-sent', 'cloud_tool',
			repeat('a', 64), repeat('e', 64), 'completed', '{}', clock_timestamp()
		from public.qorpera_execution_runs as run where run.id = v_run;
		set local session_replication_role = origin;
		v_receipt := pg_temp.retry(v_run);
		raise exception using errcode = 'QT464', message = v_receipt;
	exception when sqlstate 'QT464' then v_receipt := sqlerrm;
	end;
	begin
		update public.qorpera_shared_sessions set status = 'closed' where id = current_setting('qorpera_test.session')::uuid;
		v_closed := pg_temp.retry(v_run);
		raise exception using errcode = 'QT464', message = v_closed;
	exception when sqlstate 'QT464' then v_closed := sqlerrm;
	end;
	if v_receipt is distinct from '55000:execution recovery cannot retry work with a durable operation outcome or open proposal'
		or v_closed is distinct from '55000:execution recovery action is unavailable' then
		raise exception 'Try again was not refused: % / %', v_receipt, v_closed; end if;
	if (select execution_run_id from public.qorpera_session_inputs where id = current_setting('qorpera_test.input')::uuid)
			is distinct from v_run
		or exists (select 1 from public.qorpera_session_turn_requests where retry_of_request_id is not null)
		or exists (select 1 from public.qorpera_execution_run_events where run_id = v_run and event_type = 'recovery_released') then
		raise exception 'A refused Try again released or queued something'; end if;
end $$;

-- The input keeps one first request: a second one for the kickoff is refused.
select pg_temp.refused($$insert into public.qorpera_session_turn_requests(profile_id, session_id, client_request_id, input_id,
	requested_by_user_id, sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id, compute_identity_id,
	worker_class, status, sponsored_at)
	select profile_id, session_id, extensions.gen_random_uuid(), input_id, requested_by_user_id, sponsor_mode, sponsor_binding_id,
		sponsor_version, sponsored_by_user_id, compute_identity_id, worker_class, 'queued', sponsored_at
	from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.request')::uuid$$, '23505');

-- 3. A newer turn is queued in the thread before Anna tries again ----------------------------------------------------

insert into public.qorpera_session_inputs(id, session_id, client_input_id, kind, author_user_id, body)
values ('46400000-0000-4000-8000-000000000001', current_setting('qorpera_test.session')::uuid,
	'46400000-0000-4000-8000-000000000002', 'user_message', '85600000-0000-4000-8000-000000000001',
	jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'And the price list?'));
insert into public.qorpera_session_turn_requests(id, profile_id, session_id, client_request_id, input_id, requested_by_user_id,
	sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id, compute_identity_id, worker_class, status, sponsored_at)
select '46400000-0000-4000-8000-000000000003', profile_id, session_id, '46400000-0000-4000-8000-000000000003',
	'46400000-0000-4000-8000-000000000001', requested_by_user_id, sponsor_mode, sponsor_binding_id, sponsor_version,
	sponsored_by_user_id, compute_identity_id, worker_class, 'queued', statement_timestamp()
from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.request')::uuid;

-- 4. Anna tries again: the kickoff is released and a new request queued for it, the newest in the thread --------------

select set_config('qorpera_test.outcome', pg_temp.retry(current_setting('qorpera_test.request')::uuid), true);
do $$
declare v_old public.qorpera_session_turn_requests; v_retry public.qorpera_session_turn_requests; v_event jsonb;
	v_same text[] := array['id', 'client_request_id', 'status', 'run_id', 'materialized_at', 'created_at', 'admission_scan_at',
		'retry_of_request_id'];
	v_start jsonb;
begin
	if current_setting('qorpera_test.outcome') <> 'ok' then
		raise exception 'Anna''s Try again was refused: %', current_setting('qorpera_test.outcome'); end if;
	select * into strict v_old from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.request')::uuid;
	select * into strict v_retry from public.qorpera_session_turn_requests where retry_of_request_id = v_old.id;
	select payload into strict v_event from public.qorpera_execution_run_events
	where run_id = v_old.id and event_type = 'recovery_released';
	-- Its own id (so the run, job and runner are new), and the old request's requester, payer, computer and policy.
	if v_retry.id = v_old.id or v_retry.client_request_id <> v_retry.id or v_retry.status <> 'queued'
		or v_retry.run_id is not null or v_retry.materialized_at is not null
		or to_jsonb(v_retry) - v_same is distinct from to_jsonb(v_old) - v_same
		or v_event ->> 'retry_turn_request_id' is distinct from v_retry.id::text
		or v_event ->> 'resolved_by_user_id' is distinct from '85600000-0000-4000-8000-000000000001' then
		raise exception 'The Try again did not queue the run''s request again: % % %', to_jsonb(v_old), to_jsonb(v_retry), v_event; end if;
	if v_old.status <> 'materialized' or v_old.run_id <> v_old.id
		or (select execution_run_id from public.qorpera_session_inputs where id = v_old.input_id) is not null then
		raise exception 'The old request or the kickoff is not as agreed: %', to_jsonb(v_old); end if;
	-- The newest request in the thread: after the turn queued before the Try again.
	if v_retry.created_at <= (select created_at from public.qorpera_session_turn_requests
		where id = '46400000-0000-4000-8000-000000000003') then
		raise exception 'The retry is not after the newer turn'; end if;
	-- The table and the first run's start read the retry.
	v_start := pg_temp.start();
	if pg_temp.state() is distinct from 'queued' or v_start ->> 'state' is distinct from 'started'
		or v_start ->> 'turnRequestId' is distinct from v_retry.id::text then
		raise exception 'The first run does not read its retry: % %', pg_temp.state(), v_start; end if;
	perform set_config('qorpera_test.retry', v_retry.id::text, true);
end $$;

-- 5. The same run cannot be tried again twice ------------------------------------------------------------------------

do $$
declare v_outcome text := pg_temp.retry(current_setting('qorpera_test.request')::uuid);
begin
	if v_outcome is distinct from '55000:execution recovery was already resolved'
		or (select count(*) from public.qorpera_session_turn_requests
			where input_id = current_setting('qorpera_test.input')::uuid) <> 2 then
		raise exception 'A second Try again of the same run was not refused: %', v_outcome; end if;
end $$;

-- 6. The newer turn runs first; the retry runs once that run is done, as a new run ----------------------------------

do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb := pg_temp.materialize(v_profile);
begin
	if v_result -> 'run_ids' is distinct from '["46400000-0000-4000-8000-000000000003"]'::jsonb
		or (select status from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.retry')::uuid) <> 'queued' then
		raise exception 'The newer turn did not run first: %', v_result; end if;
	v_result := pg_temp.materialize(v_profile);
	if coalesce(v_result -> 'run_ids', '[]') <> '[]'
		or (select status from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.retry')::uuid) <> 'queued' then
		raise exception 'The retry ran beside the newer turn: %', v_result; end if;
end $$;
select pg_temp.fail_job('46400000-0000-4000-8000-000000000003');
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb := pg_temp.materialize(v_profile);
	v_old public.qorpera_execution_runs; v_retry public.qorpera_session_turn_requests; v_run public.qorpera_execution_runs;
	v_job public.qorpera_runner_jobs; v_wake public.qorpera_wake_occurrences; v_start jsonb;
begin
	select * into strict v_old from public.qorpera_execution_runs where id = current_setting('qorpera_test.request')::uuid;
	select * into strict v_retry from public.qorpera_session_turn_requests where id = current_setting('qorpera_test.retry')::uuid;
	if v_result -> 'run_ids' is distinct from jsonb_build_array(v_retry.id) then
		raise exception 'The retry did not run: %', v_result; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = v_retry.id;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	if v_retry.status <> 'materialized' or v_retry.run_id <> v_run.id or v_run.source_kind <> 'session_turn'
		or v_run.source_id <> v_retry.id or v_run.input_ids <> array[v_retry.input_id] or v_run.session_id <> v_old.session_id
		or v_run.staff_agent_id <> v_old.staff_agent_id or v_run.requested_by_user_id <> v_old.requested_by_user_id
		or v_run.sponsor_binding_id <> v_old.sponsor_binding_id or v_run.sponsor_version <> v_old.sponsor_version
		or v_run.compute_identity_id is distinct from v_old.compute_identity_id
		or v_job.id = v_old.job_id or v_job.client_job_id <> v_retry.id or v_job.status <> 'queued'
		or (select execution_run_id from public.qorpera_session_inputs where id = v_retry.input_id) is distinct from v_run.id
		or not exists (select 1 from public.qorpera_execution_sponsor_reservations where run_id = v_run.id and status = 'reserved') then
		raise exception 'The retry is not a new run of the kickoff: % % %', to_jsonb(v_retry), to_jsonb(v_run), to_jsonb(v_job); end if;
	-- Its own first-run wake, beside the first one, authorized as the run will check it.
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if v_wake.wake_kind <> 'first-run' or v_wake.status <> 'materialized' or v_wake.source_id <> v_retry.input_id
		or v_wake.occurrence_key <> 'input:' || v_retry.input_id || ':retry:' || v_run.id
		or not public.qorpera_folder_wake_authorized(v_wake)
		or not exists (select 1 from public.qorpera_wake_occurrences where run_id = v_old.id and wake_kind = 'first-run'
			and occurrence_key = 'input:' || v_retry.input_id) then
		raise exception 'The retry''s wake is not as agreed: %', to_jsonb(v_wake); end if;
	v_start := pg_temp.start();
	if pg_temp.state() is distinct from 'started' or v_start ->> 'state' is distinct from 'started'
		or v_start ->> 'turnRequestId' is distinct from v_retry.id::text then
		raise exception 'The first run does not show its retry started: % %', pg_temp.state(), v_start; end if;
	-- The retry's run is not failed yet: nothing to try again.
	if pg_temp.retry(v_run.id) is distinct from '55000:execution recovery action is unavailable' then
		raise exception 'A queued run was tried again'; end if;
end $$;

-- 7. A retried run that fails is tried again; the materializer refuses that retry once its login is gone -------------

select pg_temp.fail_job(current_setting('qorpera_test.retry')::uuid);
select set_config('qorpera_test.outcome', pg_temp.retry(current_setting('qorpera_test.retry')::uuid), true);
update public.qorpera_execution_sponsor_bindings set status = 'revoked' where id = current_setting('qorpera_test.binding')::uuid;
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb := pg_temp.materialize(v_profile);
	v_again public.qorpera_session_turn_requests; v_input public.qorpera_session_inputs;
begin
	if current_setting('qorpera_test.outcome') <> 'ok' then
		raise exception 'The retried run''s Try again was refused: %', current_setting('qorpera_test.outcome'); end if;
	select * into strict v_again from public.qorpera_session_turn_requests
	where retry_of_request_id = current_setting('qorpera_test.retry')::uuid;
	select * into strict v_input from public.qorpera_session_inputs where id = v_again.input_id;
	if v_result -> 'run_ids' <> '[]'::jsonb or (v_result ->> 'failed')::integer <> 1 or v_again.status <> 'failed'
		or v_again.failure_reason is distinct from 'The selected execution sponsor or computer is no longer available'
		or v_input.failed_at is null or v_input.failure_reason is distinct from v_again.failure_reason
		or v_input.execution_run_id is not null
		or exists (select 1 from public.qorpera_execution_runs where id = v_again.id) then
		raise exception 'A retry on a revoked login was not refused: % % %', v_result, to_jsonb(v_again), to_jsonb(v_input); end if;
	if pg_temp.state() is distinct from 'failed' then
		raise exception 'The table does not show the refused retry: %', pg_temp.state(); end if;
end $$;

rollback;

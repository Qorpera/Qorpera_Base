-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3l part 2 (20260930030100): the office-activation wake on folder-v2. Ada starts the company's
-- computer and the provider brings it up; once her turn has ended, the company is due (not while paused) and the
-- per-company drain delivers one queued office-activation wake, waiting behind a folder stop and a member change while
-- holding neither the waiter nor the admission; the wake's authority is plain reads and follows the computer; the woken
-- run is not refused for its kind; a failed start's waiter is cancelled. Folder-v2 only (the founder's decision of
-- 3 October). 648's committed fixture; everything is removed at the end.

-- A session holds a row and waits; the fences' helpers, as 850's.
create function pg_temp.hold(p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', p_sql) as t(x integer);
end $$;
create function pg_temp.release() returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'commit');
end $$;
create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
end $$;
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- Sends a call and waits up to ten seconds for it to end; its text answer, or the error as "<sqlstate> <message>".
create function pg_temp.settled(p_conn text, p_sql text) returns text language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '10 seconds'; v_answer text;
begin
	perform dblink_send_query(p_conn, p_sql);
	while dblink_is_busy(p_conn) = 1 loop
		if clock_timestamp() > v_until then return 'WAITED'; end if;
		perform pg_sleep(0.02);
	end loop;
	begin
		select r into v_answer from dblink_get_result(p_conn) as t(r text);
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return coalesce(v_answer, 'null');
end $$;
-- The company row held FOR NO KEY UPDATE: a KEY SHARE goes through, FOR SHARE, NO KEY UPDATE and FOR UPDATE wait.
create function pg_temp.company_hold(p_company text) returns text language sql as $$
	select format('select 1 from public.qorpera_profiles where id = %L for no key update', '64800000-0000-4000-8000-0000000000' || p_company)
$$;
create function pg_temp.member_hold(p_user text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_members where profile_id = %L and user_id = %L for no key update',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000' || p_user)
$$;
create function pg_temp.office_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_offices where id = %L for update',
		current_setting('qorpera_test.office_id')))
$$;

create function pg_temp.staff_hold(p_staff text, p_mode text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_staff where profile_id = %L and staff_agent_id = %L for %s',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000' || p_staff, p_mode)
$$;
create function pg_temp.no_advisory(p_conn text) returns boolean language sql as $$
	select not exists (select 1 from pg_locks where pid = current_setting('qorpera_test.pid_' || p_conn)::integer
		and locktype = 'advisory' and granted)
$$;
-- Ada's computer_start for an operation key: the envelope from the current descriptor, and its receipt begun.
create function pg_temp.start_operation(p_key text, p_receipt uuid) returns void language plpgsql as $$
declare v_descriptor jsonb := public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.binding')::jsonb, true);
	v_envelope text;
begin
	if v_descriptor ->> 'state' is distinct from 'available' then raise exception 'Setup: the descriptor is available: %', v_descriptor; end if;
	v_envelope := jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.binding')::jsonb) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'computer_start', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'arguments', '{"kind":"start"}'::jsonb,
			'target', jsonb_build_object('realm', 'company_computer', 'scope', v_descriptor -> 'scope',
				'computerGeneration', v_descriptor -> 'computerGeneration', 'resources', v_descriptor -> 'resources'),
			'requiresCompanyRevision', false))::text;
	perform set_config('qorpera_test.envelope', v_envelope, false);
	perform public.qorpera_native_office_start(current_setting('qorpera_test.binding')::jsonb, v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, p_receipt,
		'computer_start:' || p_key, encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex'), repeat('9', 64), false);
end $$;
create function pg_temp.sql_begin(p_receipt uuid) returns text language sql as $$
	select format('select public.qorpera_native_office_start(%L, %L, %L, %L, %L)::text', current_setting('qorpera_test.binding'),
		current_setting('qorpera_test.envelope'), 'begin', p_receipt, repeat('9', 64))
$$;
-- A sent call's text answer, or its error as "<sqlstate> <message>"; drains the connection.
create function pg_temp.answer(p_conn text) returns text language plpgsql as $$
declare v text;
begin
	begin
		select r into v from dblink_get_result(p_conn) as t(r text);
	exception when others then v := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return coalesce(v, 'null');
end $$;
-- Ends Ada's computer_start operation, as the runtime does once it has the answer.
create function pg_temp.complete(p_receipt uuid, p_result jsonb) returns void language sql as $$
	select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, p_receipt,
		encode(extensions.digest(convert_to(current_setting('qorpera_test.envelope'), 'UTF8'), 'sha256'), 'hex'), p_result)
$$;
create function pg_temp.clear_starts() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_runtime_office_start_waiters where intent_id in (select id from public.qorpera_runtime_office_start_intents
		where office_id = current_setting('qorpera_test.office_id')::uuid);
	delete from public.qorpera_runtime_office_start_intents where office_id = current_setting('qorpera_test.office_id')::uuid;
	delete from public.qorpera_runtime_machine_allocations where office_id = current_setting('qorpera_test.office_id')::uuid;
end $$;

-- The company's computer, registered by its owner and enrolled with its provider (893's chain); it stays provisioning,
-- so Ada's descriptor offers to start it. Ada's run gets an executable runtime bundle and acknowledges first, as a human
-- wake requires (824 B's recipe).
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
do $$
declare v_office jsonb := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
	'64800000-0000-4000-8000-000000000020', '89000000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)))::jsonb;
begin
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.scope', (v_office - 'state')::text, false);
	perform set_config('qorpera_test.generation', (select generation::text from public.qorpera_runtime_offices
		where id = (v_office ->> 'companyComputerId')::uuid), false);
	perform public.qorpera_set_runtime_office_provider(v_office - 'state', current_setting('qorpera_test.generation')::bigint,
		'89000000-0000-4000-8000-0000000000b0', repeat('f', 64), 0, true);
end $$;
set session_replication_role = replica;
update public.qorpera_execution_runs run set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256, reasoning_effort = 'low',
	reasoning_policy_sha256 = encode(extensions.digest(convert_to((bundle.manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex'),
	service_tier = 'standard'
from public.qorpera_active_runtime_bundle active join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
where run.id = '64800000-0000-4000-8000-0000000000f1';
update public.qorpera_session_inputs input set runtime_bundle_id = run.runtime_bundle_id, runtime_bundle_sha256 = run.runtime_bundle_sha256
from public.qorpera_execution_runs run where run.id = '64800000-0000-4000-8000-0000000000f1' and input.execution_run_id = run.id;
set session_replication_role = origin;
select public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
	(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
	'openai', 'codex-cli', 'office-ack', 'Starting the computer.', 'progress')
from (select current_setting('qorpera_test.binding')::jsonb b) x \g /dev/null

create function pg_temp.waiter() returns public.qorpera_runtime_office_start_waiters language sql as $$
	select * from public.qorpera_runtime_office_start_waiters where parent_run_id = '64800000-0000-4000-8000-0000000000f1'
$$;
create function pg_temp.waiter_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_office_start_waiters where id = %L for update', (pg_temp.waiter()).id))
$$;
create function pg_temp.sql_drain() returns text language sql as $$
	select format('select public.qorpera_folder_office_wakes_company(%L, 16)::text', '64800000-0000-4000-8000-000000000020')
$$;

-- Ada starts the company's computer and the provider brings it up: Ada's start (890's recipe), then the provider's
-- reservation, preparation, readiness and activation (894's chain). Ada's turn then ends: her start's waiter waits for
-- the drain.
select pg_temp.start_operation('start-wake', '89200000-0000-4000-8000-0000000000e1');
do $$
declare v_scope text := current_setting('qorpera_test.scope'); v_generation text := current_setting('qorpera_test.generation');
	v_answer text; v_intent text;
begin
	v_answer := pg_temp.settled('fence_three', pg_temp.sql_begin('89200000-0000-4000-8000-0000000000e1'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: Ada starts the computer: %', v_answer; end if;
	perform pg_temp.complete('89200000-0000-4000-8000-0000000000e1', v_answer::jsonb);
	v_intent := v_answer::jsonb ->> 'intentId';
	perform set_config('qorpera_test.intent', v_intent, false);
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		v_intent, '89200000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '89000000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves Ada''s start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		v_intent, '89200000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'89000000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '89200000-0000-4000-8000-0000000000f1', 'bootId', '89200000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '89200000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '89200000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '89200000-0000-4000-8000-0000000000f1'));
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, v_intent, '89200000-0000-4000-8000-0000000000f1', '89000000-0000-4000-8000-0000000000b0', repeat('f', 64),
		repeat('5', 32)));
	if (select state from public.qorpera_runtime_offices where id = current_setting('qorpera_test.office_id')::uuid) <> 'active' then
		raise exception 'Setup: the computer is active: %', v_answer; end if;
	if (pg_temp.waiter()).state is distinct from 'waiting' then raise exception 'Setup: Ada''s start waits for its computer'; end if;
end $$;

-- A. Nothing is due while Ada's turn runs; once it has ended the company is due, unless it is paused.
do $$
declare v_due jsonb := public.qorpera_folder_office_wakes_due(null, 100);
begin
	if v_due -> 'items' @> '[{"environment_id": "64800000-0000-4000-8000-000000000020"}]' then
		raise exception 'A: nothing is due while the start''s turn runs: %', v_due; end if;
end $$;
-- The company's login pays for unattended work, so it pays for the agent's continuation (as 657's does).
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null where id = '64800000-0000-4000-8000-0000000000f2';
set session_replication_role = origin;
do $$
declare v_due jsonb := public.qorpera_folder_office_wakes_due(null, 100);
begin
	if not v_due -> 'items' @> '[{"environment_id": "64800000-0000-4000-8000-000000000020"}]' then
		raise exception 'A: the company is due once the turn has ended: %', v_due; end if;
	set local session_replication_role = replica;
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
	values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001');
	if public.qorpera_folder_office_wakes_due(null, 100) -> 'items' @> '[{"environment_id": "64800000-0000-4000-8000-000000000020"}]'
		or public.qorpera_folder_office_wakes_company('64800000-0000-4000-8000-000000000020', 16) ->> 'state' <> 'paused'
		or (pg_temp.waiter()).state <> 'waiting' then raise exception 'A: a paused company is left alone'; end if;
	delete from public.qorpera_company_execution_pauses where profile_id = '64800000-0000-4000-8000-000000000010';
end $$;

-- B. The drain waits behind a folder stop at the fence, and behind a member change at the start's requester, holding
--    neither the waiter nor the admission each time; then it delivers the wake.
select pg_temp.hold($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
	for update$q$);
select dblink_send_query('fence_three', pg_temp.sql_drain());
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_folder_fences') or not pg_temp.waiter_free() then
		perform pg_temp.release(); raise exception 'B: the drain must wait at the fence holding no waiter'; end if;
end $$;
select pg_temp.release();
select pg_temp.outcome('fence_three');
set session_replication_role = replica;
update public.qorpera_runtime_office_start_waiters set state = 'waiting', occurrence_id = null
where parent_run_id = '64800000-0000-4000-8000-0000000000f1';
delete from public.qorpera_wake_occurrences where source_kind = 'office-activation'
	and parent_run_id = '64800000-0000-4000-8000-0000000000f1';
set session_replication_role = origin;
select pg_temp.hold(format('select 1 from public.qorpera_profile_members where profile_id = %L and user_id = %L for update',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000002'));
select dblink_send_query('fence_three', pg_temp.sql_drain());
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.waiter_free()
		or not pg_temp.row_free($q$select 1 from public.qorpera_folder_admissions
			where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$) then
		perform pg_temp.release(); raise exception 'B: the drain must wait at the requester holding no waiter and no admission'; end if;
end $$;
select pg_temp.release();
do $$
declare v_answer text := pg_temp.answer('fence_three'); v_wake public.qorpera_wake_occurrences%rowtype;
begin
	if v_answer !~ '"state": "drained"' or v_answer !~ '"delivered": 1' then raise exception 'B: the drain delivers the wake: %', v_answer; end if;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (pg_temp.waiter()).occurrence_id;
	if v_wake.status <> 'queued' or v_wake.source_kind <> 'office-activation' or v_wake.parent_run_id <> '64800000-0000-4000-8000-0000000000f1'
		or v_wake.staff_agent_id <> '64800000-0000-4000-8000-0000000000a1' or (pg_temp.waiter()).state <> 'delivered' then
		raise exception 'B: the wake is queued for Ada and the waiter delivered: %', row_to_json(v_wake); end if;
	perform set_config('qorpera_test.wake', v_wake.id::text, false);
	-- A second drain finds nothing to do.
	if public.qorpera_folder_office_wakes_company('64800000-0000-4000-8000-000000000020', 16) ->> 'state' <> 'idle' then
		raise exception 'B: the waiter is delivered once'; end if;
end $$;

-- C. The wake's authority is plain reads: with the computer held FOR UPDATE (a screen heartbeat), the folder wake check
--    answers at once that the wake is authorized; once the computer stops being active it is not.
select pg_temp.hold(format('select 1 from public.qorpera_runtime_offices where id = %L for update', current_setting('qorpera_test.office_id')));
do $$
declare v_answer text := pg_temp.settled('fence_three', format(
	'select public.qorpera_folder_wake_authorized(wake)::text from public.qorpera_wake_occurrences as wake where wake.id = %L',
	current_setting('qorpera_test.wake')));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_answer is distinct from 'true' then raise exception 'C: the office wake is authorized without a lock: %', v_answer; end if;
	set local session_replication_role = replica;
	update public.qorpera_runtime_offices set state = 'maintenance' where id = current_setting('qorpera_test.office_id')::uuid;
	if public.qorpera_folder_wake_authorized((select wake from public.qorpera_wake_occurrences as wake
		where wake.id = current_setting('qorpera_test.wake')::uuid)) then
		raise exception 'C: a wake whose computer is no longer up is not authorized'; end if;
	update public.qorpera_runtime_offices set state = 'active' where id = current_setting('qorpera_test.office_id')::uuid;
end $$;

-- D. The woken run's own tool calls are not refused for their kind: with the wake materialized into a run whose job a
--    runner holds (recorded directly), the folder run check resolves it as an agent run of Ada.
set session_replication_role = replica;
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
	job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
values ('89200000-0000-4000-8000-0000000000c2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '64800000-0000-4000-8000-000000000002',
	'leased', '64800000-0000-4000-8000-0000000000f4', '89200000-0000-4000-8000-0000000000c5', repeat('a', 64),
	clock_timestamp() + interval '1 hour', '89200000-0000-4000-8000-0000000000c1');
insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
	company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
	payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
	audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids, compute_identity_id)
select '89200000-0000-4000-8000-0000000000c1', run.profile_id, run.environment_id, 'wake', current_setting('qorpera_test.wake')::uuid,
	'89200000-0000-4000-8000-0000000000c2', run.substrate_version_id, run.company_snapshot_id, run.staff_agent_id, run.staff_version,
	run.sponsor_binding_id, run.sponsor_version, 'agent_turn', 'agent_turn', repeat('c', 64), 0, run.created_by_user_id,
	run.requested_by_user_id, run.model_provider, run.model_id, run.model_selection, 'company', run.runtime_bundle_id,
	run.runtime_bundle_sha256, '{}', run.compute_identity_id
from public.qorpera_execution_runs as run where run.id = '64800000-0000-4000-8000-0000000000f1';
update public.qorpera_wake_occurrences set status = 'materialized', run_id = '89200000-0000-4000-8000-0000000000c1'
where id = current_setting('qorpera_test.wake')::uuid;
set session_replication_role = origin;
do $$
declare v_resolved jsonb;
begin
	begin
		v_resolved := public.qorpera_folder_run_resolve('64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000010',
			jsonb_build_object('kind', 'run', 'runId', '89200000-0000-4000-8000-0000000000c1', 'jobId', '89200000-0000-4000-8000-0000000000c2',
				'runnerId', '64800000-0000-4000-8000-0000000000f4', 'assignmentId', '89200000-0000-4000-8000-0000000000c5'));
	exception when others then
		raise exception 'D: the woken run resolves: % %', sqlstate, sqlerrm;
	end;
	if v_resolved ->> 'staffAgentId' is distinct from '64800000-0000-4000-8000-0000000000a1'
		or v_resolved ->> 'causalWakeId' is distinct from current_setting('qorpera_test.wake') then
		raise exception 'D: the woken run acts as Ada for its wake: %', v_resolved; end if;
end $$;
set session_replication_role = replica;
update public.qorpera_wake_occurrences set status = 'queued', run_id = null where id = current_setting('qorpera_test.wake')::uuid;
delete from public.qorpera_execution_runs where id = '89200000-0000-4000-8000-0000000000c1';
delete from public.qorpera_runner_jobs where id = '89200000-0000-4000-8000-0000000000c2';
set session_replication_role = origin;

-- E. A start whose turn failed is cancelled, not woken.
set session_replication_role = replica;
update public.qorpera_runtime_office_start_waiters set state = 'waiting', occurrence_id = null
where parent_run_id = '64800000-0000-4000-8000-0000000000f1';
delete from public.qorpera_wake_occurrences where source_kind = 'office-activation'
	and parent_run_id = '64800000-0000-4000-8000-0000000000f1';
update public.qorpera_runner_jobs set status = 'failed', result = null, last_error = 'The turn failed.'
where id = '64800000-0000-4000-8000-0000000000f2';
set session_replication_role = origin;
do $$
declare v_answer jsonb := public.qorpera_folder_office_wakes_company('64800000-0000-4000-8000-000000000020', 16);
begin
	if v_answer ->> 'state' <> 'drained' or v_answer ->> 'cancelled' <> '1' or (pg_temp.waiter()).state <> 'cancelled'
		or exists (select 1 from public.qorpera_wake_occurrences where source_kind = 'office-activation'
			and parent_run_id = '64800000-0000-4000-8000-0000000000f1') then
		raise exception 'E: a failed start''s waiter is cancelled: %', v_answer; end if;
end $$;

-- F. Only the service role drains, and a malformed page or company limit is refused.
do $$
begin
	begin
		set local request.jwt.claims = '{"role":"authenticated","sub":"64800000-0000-4000-8000-000000000001"}';
		perform public.qorpera_folder_office_wakes_company('64800000-0000-4000-8000-000000000020', 16);
		raise exception 'F: a member cannot drain' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_folder_office_wakes_due(null, 501);
		raise exception 'F: a page over 500 is refused' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform public.qorpera_folder_office_wakes_company('64800000-0000-4000-8000-000000000020', 65);
		raise exception 'F: a company limit over 64 is refused' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
end $$;

-- G. Exactly the patched functions and the new ones name this migration.
do $$
begin
	if (select count(*) from pg_proc where prosrc ~ '20260930030100') <> 7 then
		raise exception 'G: 4 patched functions and 3 new ones name 20260930030100 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930030100'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does): the start's wakes and waiters first (they name only the run).
delete from public.qorpera_wake_occurrences where source_kind = 'office-activation' and parent_run_id = '64800000-0000-4000-8000-0000000000f1';
delete from public.qorpera_runtime_office_start_waiters where parent_run_id = '64800000-0000-4000-8000-0000000000f1';
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_offices uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	select array_agg(id) into v_offices from public.qorpera_runtime_offices where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('office_id','profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' and c.table_name <> 'qorpera_runtime_offices'
		order by c.column_name = 'office_id' desc loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'office_id' then v_offices when 'profile_id' then v_profiles
			when 'environment_id' then v_envs when 'run_id' then v_runs when 'job_id' then v_jobs
			when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_runtime_offices where id = any (v_offices);
	delete from public.qorpera_logical_computers where profile_id = any (v_profiles);
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
		or exists (select 1 from public.qorpera_runtime_offices where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_logical_computers where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;

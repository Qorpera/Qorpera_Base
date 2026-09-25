-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"
-- The company's profile row first, for every coding machine call (v123). 602's order (profile fence and
-- Company File, todo, worker, coding session, then turn or machine) goes on past the machine: storage
-- volume, allocation, node, demand. A call that needs the profile row at all takes it before any of them:
-- admission, sleep and release take the fence, a plan and the secret broker a key-share lock (their
-- inserts only need the company to exist). Each race below makes two real calls meet in the order that
-- deadlocked before, or that would have deadlocked had only the admission changed: a third connection
-- holds one row, the first call starts and waits there, the second starts and waits too, and the holder
-- lets go. The committed fixture is 602's and is removed the same way at the end.

-- Each session's lease, and the calls the races make.
create temporary table machine_leases (worker_key text primary key, lease uuid not null);
insert into pg_temp.machine_leases values ('fix-send', (current_setting('qorpera_test.coding_claim')::jsonb ->> 'leaseToken')::uuid);
create function pg_temp.machine_lease(p_key text) returns uuid language sql as $$
	select lease from pg_temp.machine_leases where worker_key = p_key
$$;
create function pg_temp.machine_claim(p_key text) returns void language plpgsql as $$
declare v_claim jsonb;
begin
	perform pg_temp.path_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-test', 300);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = (pg_temp.worker_row(p_key)).id::text,
		'The executor claims ' || p_key || ': ' || coalesce(v_claim::text, 'nothing'));
	insert into pg_temp.machine_leases values (p_key, (v_claim ->> 'leaseToken')::uuid)
	on conflict (worker_key) do update set lease = excluded.lease;
end
$$;
-- The owner writes to a session that has ended; the executor claims its next turn.
create function pg_temp.machine_next_turn(p_key text, p_text text, p_request uuid) returns void language plpgsql as $$
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session((pg_temp.worker_row(p_key)).id, p_text, p_request);
	perform pg_temp.machine_claim(p_key);
end
$$;
-- A fresh node observation: a reservation needs one from the last minute.
create function pg_temp.machine_node_seen() returns void language plpgsql as $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
end
$$;
create function pg_temp.machine_storage(p_key text) returns jsonb language sql as $$
	select current_setting('qorpera_test.coding_storage')::jsonb || jsonb_build_object('volumeId', worker.id, 'workerId', worker.id,
		'dataSource', root || '/data', 'custodySource', root || '/guest-state')
	from pg_temp.worker_row(p_key) worker,
		lateral (select '/srv/coding/executor/workers/' || worker.profile_id || '/' || worker.environment_id || '/' || worker.id as root) path
$$;
create function pg_temp.machine_cancel(p_key text, p_operation text) returns text language sql as $$
	select format('select public.qorpera_manage_agent_worker(%L::jsonb, %L::jsonb)', current_setting('qorpera_test.parent_binding'),
		jsonb_build_object('action','cancel','operationKey',p_operation,'todoKey','composer-latency','workerKey',p_key))
$$;
create function pg_temp.machine_admit(p_key text) returns text language sql as $$
	select format('select public.qorpera_authorize_coding_machine_run(%L, %L, %L, %L::jsonb, %L)', (pg_temp.worker_row(p_key)).id,
		pg_temp.machine_lease(p_key), current_setting('qorpera_test.coding_binding'), pg_temp.machine_storage(p_key), repeat('c', 64))
$$;
create function pg_temp.machine_plan(p_key text) returns text language sql as $$
	select format('select public.qorpera_plan_coding_machine(%L, %L, %L)', (pg_temp.worker_row(p_key)).id, pg_temp.machine_lease(p_key),
		repeat('c', 64))
$$;
create function pg_temp.machine_sleep() returns text language sql as $$
	select format('select public.qorpera_suspend_coding_machine(%L, ''exec-test'', %L, %L)', current_setting('qorpera_test.coding_vm'),
		current_setting('qorpera_test.coding_binding'), repeat('c', 64))
$$;
create function pg_temp.machine_release() returns text language sql as $$
	select format('select public.qorpera_release_coding_machine(%L, ''exec-test'', %L, %L)', current_setting('qorpera_test.coding_vm'),
		current_setting('qorpera_test.coding_binding'), repeat('c', 64))
$$;
create function pg_temp.machine_credential(p_key text) returns text language sql as $$
	select format('select public.qorpera_authorize_coding_repository_credential(%L, %L, %L, %L, ''exec-test'', %L::jsonb)',
		'60300000-0000-4000-8000-000000000040', repeat('c', 64), (pg_temp.worker_row(p_key)).id, pg_temp.machine_lease(p_key),
		'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}')
$$;
-- The secret broker's own login on one race connection: its calls check the session user, not the role.
create function pg_temp.machine_broker(p_connection text, p_broker boolean) returns void language sql as $$
	select dblink_exec(p_connection, case when p_broker then 'set session authorization qorpera_secret_broker'
		else 'reset session authorization' end)::void
$$;
create function pg_temp.machine_custody(p_intent text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.path_claims('service_role');
	return public.qorpera_authorize_coding_machine_custody(current_setting('qorpera_test.coding_vm')::uuid, 'exec-test',
		current_setting('qorpera_test.coding_binding'), repeat('c', 64), p_intent);
end
$$;
create function pg_temp.machine_agent_cancel(p_key text, p_operation text) returns void language plpgsql as $$
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.worker(jsonb_build_object('action','cancel','operationKey',p_operation,'todoKey','composer-latency','workerKey',p_key));
end
$$;

-- The company's broker holds its GitHub connection, as in 399: the owner connects, the broker seals.
begin;
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values ('60300000-0000-4000-8000-000000000040','30000000-0000-4000-8000-000000000010','https://secrets.qorpera.test','company-kek-1',repeat('c',64));
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.github_capture',public.qorpera_begin_cloud_secret_capture(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020','company',null,
	'github','primary','Company GitHub')::text,true);
reset role;
select set_config('qorpera_test.github_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.github_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.github_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.github_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.github_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select public.qorpera_complete_cloud_secret_capture('60300000-0000-4000-8000-000000000040',repeat('c',64),
	(current_setting('qorpera_test.github_capture')::jsonb->>'ticketId')::uuid,current_setting('qorpera_test.github_capability_sha'),
	current_setting('qorpera_test.github_envelope'),current_setting('qorpera_test.github_envelope_sha'),'qorpera-bot');
reset session authorization;
commit;

-- 1. The agent cancels while the executor admits the turn to its machine. The admission held the worker,
--    session, machine, volume and allocation, then its node reservation waited for the profile fence,
--    which the cancel held while it waited for the todo, worker and session. Now the admission waits for
--    the fence before it holds anything, and after the cancel it is refused plainly.
do $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_heartbeat_coding_session((pg_temp.worker_row('fix-send')).id, pg_temp.machine_lease('fix-send'), 300);
end $$;
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_runtime_agent_todos', 'id', v_worker.todo_id),
		pg_temp.machine_cancel('fix-send', 'machine-lock-cancel-1'), '{"role":"service_role"}',
		pg_temp.machine_admit('fix-send'), '{"role":"service_role"}');
	perform pg_temp.wake_assert(v_outcome #>> '{second,state}' = '55000' and v_outcome #>> '{second,error}' = 'Coding session was cancelled',
		'The admission is refused because the session was cancelled, not killed: ' || v_outcome::text);
	perform pg_temp.lock_race_ok(v_outcome - 'second', 'agent cancel against machine admission');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,action}' = 'cancel'
		and (pg_temp.worker_row('fix-send')).state = 'cancelled' and (pg_temp.session_row('fix-send')).phase = 'cancelled',
		'The cancel lands: ' || v_outcome::text);
end $$;

-- 2. The agent cancels while the secret broker hands the executor the repository credential. The broker
--    held the session (shared), then its audit event's key check waited for the profile row, which the
--    cancel held while it waited to change the session. Now the broker takes the profile row first.
select pg_temp.machine_next_turn('fix-send', 'Also cover the group chat composer.', '60300000-0000-4000-8000-000000000001');
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	perform pg_temp.machine_broker('lock_second', true);
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_runtime_agent_todos', 'id', v_worker.todo_id),
		pg_temp.machine_cancel('fix-send', 'machine-lock-cancel-2'), '{"role":"service_role"}',
		pg_temp.machine_credential('fix-send'), '{"role":"qorpera_secret_broker"}');
	perform pg_temp.machine_broker('lock_second', false);
	perform pg_temp.wake_assert(v_outcome #>> '{second,state}' = '42501' and v_outcome #>> '{second,error}' = 'coding session lease is unavailable',
		'The credential is refused because the session was cancelled, not killed: ' || v_outcome::text);
	perform pg_temp.lock_race_ok(v_outcome - 'second', 'agent cancel against repository credential');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,action}' = 'cancel' and (pg_temp.session_row('fix-send')).phase = 'cancelled'
		and not exists (select 1 from public.qorpera_cloud_secret_audit_events where coding_worker_id = v_worker.id),
		'The cancel lands and no credential was used: ' || v_outcome::text);
end $$;

-- 3. The broker hands out the credential while the executor admits the turn. Had only the admission
--    moved its fence first, it would hold the fence while waiting for the session the broker shared, and
--    the broker's audit event would wait for the profile row.
select pg_temp.machine_next_turn('fix-send', 'Pick the composer work up again.', '60300000-0000-4000-8000-000000000002');
select pg_temp.machine_node_seen();
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	perform pg_temp.machine_broker('lock_first', true);
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_sessions', 'worker_id', v_worker.id),
		pg_temp.machine_credential('fix-send'), '{"role":"qorpera_secret_broker"}',
		pg_temp.machine_admit('fix-send'), '{"role":"service_role"}');
	perform pg_temp.machine_broker('lock_first', false);
	perform pg_temp.lock_race_ok(v_outcome, 'repository credential against machine admission');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,schema}' = 'qorpera.coding-repository-credential-authorization/v1'
		and v_outcome #>> '{second,result,intent}' = 'run' and v_outcome #>> '{second,result,machineId}' = current_setting('qorpera_test.coding_vm'),
		'The credential is handed out and the machine admitted: ' || v_outcome::text);
end $$;

-- 4. The executor puts the member's machine to sleep while another of the member's sessions is admitted
--    to it. The sleep held the machine, then waited for the fence; an admission holding the fence first
--    would wait for that machine. Now both take the fence first.
select pg_temp.machine_agent_cancel('fix-send', 'machine-lock-cancel-3');
select pg_temp.wake_assert(pg_temp.machine_custody('stop') ->> 'intent' = 'stop', 'The idle machine may stop');
select pg_temp.machine_next_turn('fix-send-2', 'Take the second composer fix after all.', '60300000-0000-4000-8000-000000000003');
select pg_temp.machine_node_seen();
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_machines', 'id', current_setting('qorpera_test.coding_vm')::uuid),
		pg_temp.machine_sleep(), '{"role":"service_role"}',
		pg_temp.machine_admit('fix-send-2'), '{"role":"service_role"}');
	perform pg_temp.lock_race_ok(v_outcome, 'machine sleep against machine admission');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,state}' = 'suspended' and v_outcome #>> '{second,result,intent}' = 'run'
		and (pg_temp.session_row('fix-send-2')).vm_allocation_id = current_setting('qorpera_test.coding_vm')::uuid
		and exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = current_setting('qorpera_test.coding_vm')::uuid
			and reserved_at is not null and suspended_at is null and released_at is null),
		'The machine sleeps, then wakes for the admitted turn: ' || v_outcome::text);
end $$;

-- 5. The executor releases the member's deleted machine while a new session of the member plans one.
--    The release held the machine, then waited for the fence; a plan holding the profile row first
--    would wait for that machine. Now the release takes the fence first, and the plan makes a new machine.
select pg_temp.machine_agent_cancel('fix-send-2', 'machine-lock-cancel-4');
do $$
begin
	perform pg_temp.wake_assert(pg_temp.machine_custody('stop') ->> 'intent' = 'stop', 'The idle machine may stop again');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(public.qorpera_suspend_coding_machine(current_setting('qorpera_test.coding_vm')::uuid, 'exec-test',
		current_setting('qorpera_test.coding_binding'), repeat('c', 64)) ->> 'state' = 'suspended', 'The machine sleeps');
	perform public.qorpera_configure_coding_machine_lifecycle('30000000-0000-4000-8000-000000000020', 'exec-test', 60, 300);
	-- Asleep past the removal delay.
	update public.qorpera_runtime_node_demands set suspended_at = suspended_at - interval '1 hour'
	where allocation_id = current_setting('qorpera_test.coding_vm')::uuid;
	perform pg_temp.wake_assert(pg_temp.machine_custody('delete') ->> 'intent' = 'delete', 'The sleeping machine may be deleted');
	perform pg_temp.worker('{"action":"dispatch","operationKey":"machine-lock-dispatch","todoKey":"composer-latency","workerKey":"fix-send-3",
		"title":"Third","goal":"g","definitionOfDone":"d","access":"read","species":"coding","harness":"codex",
		"repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');
end $$;
select pg_temp.machine_claim('fix-send-3');
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_machines', 'id', current_setting('qorpera_test.coding_vm')::uuid),
		pg_temp.machine_release(), '{"role":"service_role"}',
		pg_temp.machine_plan('fix-send-3'), '{"role":"service_role"}');
	perform pg_temp.lock_race_ok(v_outcome, 'machine release against machine plan');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,state}' = 'released' and v_outcome #>> '{second,result,state}' = 'planned'
		and v_outcome #>> '{second,result,machineId}' <> current_setting('qorpera_test.coding_vm')
		and (select removed_at is not null from public.qorpera_coding_machines where id = current_setting('qorpera_test.coding_vm')::uuid),
		'The old machine is released and the new session plans a new one: ' || v_outcome::text);
	perform set_config('qorpera_test.machine_plan', v_outcome #>> '{second,result}', false);
end $$;

-- 6. The agent cancels while the executor plans a member's first machine. The plan held the session,
--    then the new machine row's key check waited for the profile row, which the cancel held while it
--    waited to change the session. Now the plan takes the profile row first.
do $$
begin
	perform pg_temp.path_claims('service_role');
	-- The machine planned above, never admitted, goes; the member has none again.
	perform public.qorpera_release_coding_machine((current_setting('qorpera_test.machine_plan')::jsonb ->> 'machineId')::uuid, 'exec-test',
		(current_setting('qorpera_test.machine_plan')::jsonb -> 'binding')::text, repeat('c', 64));
	perform public.qorpera_heartbeat_coding_session((pg_temp.worker_row('fix-send-3')).id, pg_temp.machine_lease('fix-send-3'), 300);
end $$;
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send-3'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_runtime_agent_todos', 'id', v_worker.todo_id),
		pg_temp.machine_cancel('fix-send-3', 'machine-lock-cancel-5'), '{"role":"service_role"}',
		pg_temp.machine_plan('fix-send-3'), '{"role":"service_role"}');
	perform pg_temp.wake_assert(v_outcome #>> '{second,state}' = '55000' and v_outcome #>> '{second,error}' = 'Coding session was cancelled',
		'The plan is refused because the session was cancelled, not killed: ' || v_outcome::text);
	perform pg_temp.lock_race_ok(v_outcome - 'second', 'agent cancel against machine plan');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,action}' = 'cancel' and (pg_temp.session_row('fix-send-3')).phase = 'cancelled'
		and not exists (select 1 from public.qorpera_coding_machines where member_user_id = v_worker.owner_user_id and removed_at is null),
		'The cancel lands and no machine was planned: ' || v_outcome::text);
end $$;

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();

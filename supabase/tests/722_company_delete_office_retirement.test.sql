-- @fixture 718_company_delete_office_power_off.test.sql until "-- Deleting the company powers the computer off"
-- 20260929320000: after a deleting company's idle power_off, the provider retires the Company Computer:
-- it asks for the retirement, takes a five-second window, deletes the VM, and retires the office, which
-- releases its machine; then the finisher purges the company. The stop acknowledgement below is
-- synthetic (the provider's inspection is not modelled); everything else is the real SQL path.
reset role;
create function pg_temp.refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.office() returns public.qorpera_runtime_offices language sql as $$
	select o from public.qorpera_runtime_offices o where o.id = (current_setting('qorpera_test.office')::jsonb ->> 'companyComputerId')::uuid
$$;
create function pg_temp.request() returns jsonb language sql as $$
	select request from public.qorpera_runtime_office_lifecycle_transitions where office_id = (pg_temp.office()).id
	order by requested_at desc limit 1
$$;
create function pg_temp.acknowledge_stop() returns void language plpgsql as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype; v_challenge uuid := extensions.gen_random_uuid();
	v_now timestamptz := clock_timestamp();
begin
	select * into strict v_transition from public.qorpera_runtime_office_lifecycle_transitions where id = (pg_temp.request() ->> 'transitionId')::uuid;
	insert into public.qorpera_runtime_office_stop_challenges(id, transition_id, command, start_completion_sha256, office_revision,
		privacy_version, drains, issued_at, expires_at)
	values (v_challenge, v_transition.id, '{}', repeat('a', 64), (pg_temp.office()).revision, 0, '[]', v_now,
		v_now + interval '5 seconds');
	insert into public.qorpera_runtime_office_stops(transition_id, challenge_id, inspection) values (v_transition.id, v_challenge, '{}');
end
$$;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated'] loop
		if has_function_privilege(v_role, 'public.qorpera_runtime_office_retirement(jsonb)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_prepare_runtime_office_retirement(jsonb,uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_retire_runtime_office(jsonb,jsonb)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_runtime_office_retirement_receipt(jsonb,bigint,uuid,text)', 'EXECUTE') then
			raise exception 'office retirement is open to %', v_role;
		end if;
	end loop;
	if has_table_privilege('service_role', 'public.qorpera_runtime_office_retirements', 'SELECT,INSERT,UPDATE,DELETE')
		or has_function_privilege('service_role', 'public.qorpera_lock_runtime_office_retirement(jsonb)', 'EXECUTE') then
		raise exception 'the retirement ledger is open to service_role';
	end if;
end
$$;

-- The office's machine is placed on a node: its demand is reserved and bound to the physical VM.
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('30000000-0000-4000-8000-000000000730', repeat('9', 64), 'retire-node', 1, 8000, 17179869184, 1000,
	1073741824, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('office', '39000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000730', repeat('f', 64), 2000, 4294967296);
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select allocation_id, '30000000-0000-4000-8000-000000000730', 'office', '39000000-0000-4000-8000-000000000001', repeat('f', 64),
	2000, 4294967296, clock_timestamp()
from public.qorpera_runtime_office_start_intents where office_id = (pg_temp.office()).id and allocation_id is not null;
insert into public.qorpera_runtime_node_instance_bindings(allocation_id, node_id, physical_id, binding)
select allocation_id, '30000000-0000-4000-8000-000000000730', extensions.gen_random_uuid(), '{}'
from public.qorpera_runtime_office_start_intents where office_id = (pg_temp.office()).id and allocation_id is not null;
create function pg_temp.allocation() returns uuid language sql as $$
	select allocation_id from public.qorpera_runtime_office_start_intents where office_id = (pg_temp.office()).id and allocation_id is not null
$$;
select pg_temp.wake_assert(pg_temp.allocation() is not null, 'The fixture office has an allocation');

-- A living company's computer that powers off when idle is kept: no retirement.
savepoint living;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.office_call('release', current_setting('qorpera_test.office_lease')::jsonb);
reset role;
select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid,
	'failed', 'Ended for the test', false);
select pg_temp.path_claims('service_role');
update public.qorpera_runtime_office_idle_policies set idle_since = clock_timestamp() - interval '2 hours';
select pg_temp.wake_assert(pg_temp.idle_poll() #>> '{request,action}' = 'power_off', 'An idle living computer powers off');
select pg_temp.acknowledge_stop();
select pg_temp.wake_assert(public.qorpera_runtime_office_retirement(pg_temp.request()) is null, 'A living company''s computer is kept');
rollback to living;

-- The company is deleted: its computer powers off, and is retired once the stop is acknowledged.
reset role;
select public.qorpera_request_company_deletion('30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(pg_temp.idle_poll() #>> '{request,action}' = 'power_off', 'A deleted company''s computer powers off');
-- Not yet: the stop is not acknowledged.
select pg_temp.refused($q$select public.qorpera_runtime_office_retirement(pg_temp.request())$q$, '55000');
select pg_temp.acknowledge_stop();
-- Not yet: the machine's node demand is still awake (the provider suspends it after its stop).
select pg_temp.refused($q$select public.qorpera_runtime_office_retirement(pg_temp.request())$q$, '55000');
update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = pg_temp.allocation();
-- Not while a resume was prepared for this power-off.
savepoint booting;
insert into public.qorpera_runtime_office_boot_intents(boot_intent_id, activation_id, transition_id, predecessor_activation_id,
	request, office_revision, privacy_state, privacy_version, prepared_at)
values (extensions.gen_random_uuid(), extensions.gen_random_uuid(), (pg_temp.request() ->> 'transitionId')::uuid,
	(pg_temp.request() ->> 'activationId')::uuid, '{}', (pg_temp.office()).revision, 'shared', 0, clock_timestamp());
select pg_temp.refused($q$select public.qorpera_runtime_office_retirement(pg_temp.request())$q$, '55000');
rollback to booting;
do $$
declare v_first jsonb := public.qorpera_runtime_office_retirement(pg_temp.request()); v_window jsonb;
begin
	perform pg_temp.wake_assert(v_first ->> 'state' = 'retiring' and v_first ->> 'deleteCommandId' is not null
		and public.qorpera_runtime_office_retirement(pg_temp.request()) = v_first,
		'The retirement is issued once, with one delete command');
	perform pg_temp.refused(format($q$select public.qorpera_prepare_runtime_office_retirement(%L, %L)$q$,
		pg_temp.request(), v_first ->> 'deleteCommandId'), '42501');
	perform pg_temp.refused(format($q$select public.qorpera_retire_runtime_office(%L, %L)$q$, pg_temp.request(),
		jsonb_build_object('schema', 'qorpera.office-retirement-evidence/v1', 'deleteCommandId', v_first ->> 'deleteCommandId',
			'deleteOperationId', '30000000-0000-4000-8000-000000000741')), '42501');
	v_window := public.qorpera_prepare_runtime_office_retirement(pg_temp.request(), '30000000-0000-4000-8000-000000000722');
	perform pg_temp.wake_assert(v_window ->> 'deleteCommandId' = v_first ->> 'deleteCommandId'
		and (v_window ->> 'expiresInMs')::integer between 1 and 5000, 'A five-second window names the delete command');
	perform set_config('qorpera_test.retirement', v_first::text, true);
end
$$;
-- A wrong delete command is refused; the right one retires the office and releases its machine.
select pg_temp.refused(format($q$select public.qorpera_retire_runtime_office(%L, %L)$q$, pg_temp.request(),
	jsonb_build_object('schema', 'qorpera.office-retirement-evidence/v1', 'deleteCommandId', extensions.gen_random_uuid(),
		'deleteOperationId', '30000000-0000-4000-8000-000000000741')), '42501');
-- At most 64 windows per retirement.
savepoint windows;
do $$
declare v_n integer;
begin
	for v_n in 2 .. 64 loop
		perform public.qorpera_prepare_runtime_office_retirement(pg_temp.request(), extensions.gen_random_uuid());
	end loop;
	perform pg_temp.refused(format($q$select public.qorpera_prepare_runtime_office_retirement(%L, %L)$q$,
		pg_temp.request(), extensions.gen_random_uuid()), '54000');
end
$$;
rollback to windows;
do $$
declare v_retirement jsonb := current_setting('qorpera_test.retirement')::jsonb; v_evidence jsonb; v_receipt jsonb;
	v_allocation uuid := (v_retirement ->> 'allocationId')::uuid;
begin
	v_evidence := jsonb_build_object('schema', 'qorpera.office-retirement-evidence/v1',
		'deleteCommandId', v_retirement ->> 'deleteCommandId', 'deleteOperationId', '30000000-0000-4000-8000-000000000742');
	v_receipt := public.qorpera_retire_runtime_office(pg_temp.request(), v_evidence);
	perform pg_temp.wake_assert(v_receipt ->> 'state' = 'retired' and v_receipt ->> 'deleteOperationId' = '30000000-0000-4000-8000-000000000742'
		and (pg_temp.office()).state = 'retired'
		and (select released_at is not null from public.qorpera_runtime_machine_allocations where id = v_allocation)
		and not exists (select 1 from public.qorpera_runtime_node_instance_bindings where allocation_id = v_allocation)
		and (select released_at is not null from public.qorpera_runtime_node_demands where allocation_id = v_allocation)
		and not exists (select 1 from public.qorpera_runtime_office_start_intents
			where office_id = (pg_temp.office()).id and state <> 'cancelled'),
		'Retired: the office, its machine and node demand released, its binding and start intent gone');
	perform pg_temp.wake_assert(public.qorpera_retire_runtime_office(pg_temp.request(), v_evidence) = v_receipt
		and public.qorpera_runtime_office_retirement(pg_temp.request()) = v_receipt,
		'A lost reply is answered with the same receipt');
	perform pg_temp.refused(format($q$select public.qorpera_retire_runtime_office(%L, %L)$q$, pg_temp.request(),
		v_evidence || '{"deleteOperationId":"30000000-0000-4000-8000-000000000743"}'), '42501');
	perform pg_temp.refused(format($q$select public.qorpera_retire_runtime_office(%L, %L)$q$, pg_temp.request(),
		v_evidence || '{"deleteOperationId":"not-an-operation"}'), '22023');
	perform set_config('qorpera_test.retired_evidence', v_evidence::text, true);
	perform set_config('qorpera_test.retire_request', pg_temp.request()::text, true);
	perform set_config('qorpera_test.retired_receipt', v_receipt::text, true);
end
$$;

-- With no machine left, the finisher purges the company; the provider still reads its receipt.
reset role;
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('30000000-0000-4000-8000-000000000010');
begin
	perform pg_temp.wake_assert(v_result ->> 'state' = 'purged'
		and not exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010'),
		'The finisher purges the company once its computer is retired: ' || v_result::text);
end
$$;
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(public.qorpera_runtime_office_retirement_receipt(
	(current_setting('qorpera_test.office')::jsonb - 'state'), 1, '39000000-0000-4000-8000-000000000001', repeat('f', 64))
	= current_setting('qorpera_test.retired_receipt')::jsonb, 'The receipt outlives the company');
select pg_temp.wake_assert(public.qorpera_runtime_office_retirement_receipt(
	(current_setting('qorpera_test.office')::jsonb - 'state'), 1, '39000000-0000-4000-8000-000000000009', repeat('f', 64)) is null,
	'Another provider reads no receipt');
select pg_temp.wake_assert(public.qorpera_runtime_office_retirement(current_setting('qorpera_test.retire_request')::jsonb) = current_setting('qorpera_test.retired_receipt')::jsonb
	and public.qorpera_retire_runtime_office(current_setting('qorpera_test.retire_request')::jsonb, current_setting('qorpera_test.retired_evidence')::jsonb)
		= current_setting('qorpera_test.retired_receipt')::jsonb,
	'After the purge a lost reply is still answered from the ledger');

rollback;

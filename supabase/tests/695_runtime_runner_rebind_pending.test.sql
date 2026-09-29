-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- A runner a provider left pending, with no machine ever reserved for it, goes to the provider that
-- runs the attempt now (20260928235000). Step 7 on 2026-09-28: the exec host provisioned the attempt's
-- runner, the node chooser then preferred node 1, and node 1's provider was refused the same client
-- runner id on every attempt. Once a machine was reserved for a runner it stays with its provider.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
create function pg_temp.rebind_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.rebind_provision(p_adapter text, p_activation text)
returns text language plpgsql as $$
begin
	return public.qorpera_provision_execution_runner(
		(current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid,
		'69500000-0000-4000-8000-0000000000c1', p_adapter, p_activation)::text;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.rebind_expect(text,text,text), pg_temp.rebind_provision(text,text) to service_role;

-- The member's native run is claimed (its job stays queued until an assignment is accepted).
set role service_role;
select pg_temp.rebind_expect((public.qorpera_claim_runner_job_for_orchestrator(
	'16000000-0000-4000-8000-000000000092','69500000-0000-4000-8000-0000000000d1',120) -> 'work' ->> 'run_id'),
	current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id', 'the fixture''s native run is claimed');

-- The exec host provisions the attempt's runner, then the node chooser refuses it (no machine).
select set_config('qorpera_test.rebind_first', pg_temp.rebind_provision('native26-phql-b1', repeat('a',64)), false);
select pg_temp.rebind_expect(current_setting('qorpera_test.rebind_first')::jsonb ->> 'status', 'pending', 'the first provider''s runner');
-- Node 1's provider acquires the same attempt: the runner is now its own, with its activation.
select set_config('qorpera_test.rebind_second', pg_temp.rebind_provision('native25-phql-a1', repeat('b',64)), false);
reset role;
select pg_temp.rebind_expect((select jsonb_build_object('same', runner.id::text = current_setting('qorpera_test.rebind_first')::jsonb ->> 'runner_id',
		'answer', current_setting('qorpera_test.rebind_second')::jsonb ->> 'runner_id' = runner.id::text,
		'adapter', runner.provider_adapter, 'activation', runner.activation_token_sha256 = repeat('b',64),
		'status', runner.status, 'expires', runner.activation_expires_at > clock_timestamp() + interval '14 minutes')::text
	from public.qorpera_runners runner
	where runner.client_runner_id = '69500000-0000-4000-8000-0000000000c1'),
	jsonb_build_object('same', true, 'answer', true, 'adapter', 'native25-phql-a1', 'activation', true,
		'status', 'pending', 'expires', true)::text,
	'a pending runner no machine was reserved for goes to the provider that acquires now');
select pg_temp.rebind_expect((select string_agg(receipt.payload ->> 'provider_adapter' || ':' || coalesce(receipt.payload ->> 'rebound', 'new'), ',' order by receipt.id)
	from public.qorpera_runner_audit_receipts receipt
	where receipt.runner_id = (current_setting('qorpera_test.rebind_first')::jsonb ->> 'runner_id')::uuid
		and receipt.event_type = 'runner_registered'),
	'native26-phql-b1:new,native25-phql-a1:true', 'each registration has its receipt');

-- The same provider again with the same activation: its own replay, unchanged.
set role service_role;
select pg_temp.rebind_expect(pg_temp.rebind_provision('native25-phql-a1', repeat('b',64))::jsonb ->> 'provider_adapter',
	'native25-phql-a1', 'a replay with the same activation');
-- The same provider after it retired the refused acquisition: a new activation for the runner.
select pg_temp.rebind_expect(pg_temp.rebind_provision('native25-phql-a1', repeat('c',64))::jsonb ->> 'status',
	'pending', 'a retry with a new activation');
reset role;
select pg_temp.rebind_expect((select activation_token_sha256 from public.qorpera_runners
	where client_runner_id = '69500000-0000-4000-8000-0000000000c1'), repeat('c',64), 'the retry''s activation');

-- Once a machine is reserved for the runner, it may hold the activation: nobody else gets it.
insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,runner_id,provider_adapter,instance_sha256)
select '69500000-0000-4000-8000-0000000000c1', runner.profile_id,
	(current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid, runner.id, runner.provider_adapter, repeat('e',64)
from public.qorpera_runners runner where runner.client_runner_id = '69500000-0000-4000-8000-0000000000c1';
set role service_role;
select pg_temp.rebind_expect(pg_temp.rebind_provision('native26-phql-b1', repeat('d',64)),
	'23505:runner client id is already bound to other compute authority', 'another provider after a reservation');
select pg_temp.rebind_expect(pg_temp.rebind_provision('native25-phql-a1', repeat('d',64)),
	'23505:runner activation is already bound to another capability', 'a new activation after a reservation');
select pg_temp.rebind_expect(pg_temp.rebind_provision('native25-phql-a1', repeat('c',64))::jsonb ->> 'provider_adapter',
	'native25-phql-a1', 'its own provider still replays');
reset role;
-- Even a released reservation keeps the runner: its machine may have run.
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = '69500000-0000-4000-8000-0000000000c1';
set role service_role;
select pg_temp.rebind_expect(pg_temp.rebind_provision('native26-phql-b1', repeat('d',64)),
	'23505:runner client id is already bound to other compute authority', 'another provider after a released reservation');
reset role;

-- A revoked runner without a machine is never given away.
delete from public.qorpera_runtime_machine_allocations where id = '69500000-0000-4000-8000-0000000000c1';
update public.qorpera_runners set status = 'revoked', revoked_at = clock_timestamp(),
	revoked_by_user_id = '16000000-0000-4000-8000-000000000001'
where client_runner_id = '69500000-0000-4000-8000-0000000000c1';
set role service_role;
select pg_temp.rebind_expect(pg_temp.rebind_provision('native26-phql-b1', repeat('d',64)),
	'23505:runner client id is already bound to other compute authority', 'a revoked runner');
reset role;

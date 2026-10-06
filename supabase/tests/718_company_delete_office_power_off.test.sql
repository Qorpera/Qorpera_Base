-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- 20260928249150 on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): a Company Computer of a company
-- being deleted powers off at its provider's next idle check. While the company lives, a held screen keeps it awake,
-- and so does a pause (the folder-v2 operator pause, qorpera_folder_pause); deleting the company turns the next check
-- into a power_off request, and the deletion waits for the computer's machine. 405's office fixture on 924's folder-v2
-- company: the owner's computer 1, with Alice's live run holding a screen lease. The provider, start and activation
-- below are the SQL policy fixture of fixtures/runtime-office-idle-cases.sql; physical activation evidence is synthetic.
reset role;
update public.qorpera_runtime_offices set state='provisioning';
select pg_temp.base_claims('service_role');
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000001',repeat('f',64),0,true);
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002');
select pg_temp.base_claims('service_role');
select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000003',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
	'39000000-0000-4000-8000-000000000001',repeat('f',64));
insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
	provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,
	state,service_invocation_id,ready_at,activated_at)
select i.id,'39000000-0000-4000-8000-000000000004',i.office_id,1,i.allocation_id,p.provider_id,p.policy_sha256,
	i.provider_binding_sha256,i.instance_sha256,i.image_sha256,i.bootstrap_sha256,
	jsonb_build_object('bootId','39000000-0000-4000-8000-000000000005','configurationSha256',repeat('e',64)),
	'[]','active',repeat('a',32),clock_timestamp(),clock_timestamp()
from public.qorpera_runtime_office_start_intents i join public.qorpera_runtime_office_providers p on p.office_id=i.office_id;
update public.qorpera_runtime_offices set state='active';
create function pg_temp.po_idle_poll() returns jsonb language sql as $$
	select public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.office_scope')::jsonb,1,
		'39000000-0000-4000-8000-000000000001',repeat('f',64),60000)
$$;
select pg_temp.base_assert((select count(*)=1 and bool_and(state='active') from public.qorpera_runtime_offices
	where profile_id='92400000-0000-4000-8000-000000000010'),'the folder-v2 company''s one computer is up');

-- The company lives: its held screen keeps the computer awake, and so does a pause without any screen.
select pg_temp.base_assert(pg_temp.po_idle_poll()->'request'='null','A held screen keeps a living company''s computer awake');
savepoint paused_only;
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.ob_call('release',current_setting('qorpera_test.office_lease')::jsonb);
reset role;
-- ...and the fixture's run, whose authorized work also keeps the computer warm, has ended.
select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.base_binding')::jsonb->>'jobId')::uuid,
	'failed','Ended for the test',false);
select public.qorpera_folder_pause('92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000001','Operator pause');
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(not public.qorpera_runtime_office_has_demand((select o from public.qorpera_runtime_offices o
	where o.id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid)),'No screen is held');
update public.qorpera_runtime_office_idle_policies set idle_since=clock_timestamp()-interval '2 hours';
select pg_temp.base_assert(pg_temp.po_idle_poll()->'request'='null','A paused company''s computer stays awake');
rollback to paused_only;

-- Deleting the company powers the computer off at the next check, held screen and pause notwithstanding.
reset role;
select public.qorpera_request_company_deletion('92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000001');
select pg_temp.base_claims('service_role');
do $$
declare v_first jsonb := pg_temp.po_idle_poll(); v_again jsonb;
begin
	perform pg_temp.base_assert(v_first#>>'{request,action}'='power_off'
		and v_first#>>'{request,activationId}'='39000000-0000-4000-8000-000000000004',
		'A deleted company''s computer is asked to power off at once');
	perform pg_temp.base_assert((select state from public.qorpera_runtime_offices
		where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid)='maintenance',
		'The computer is going down');
	v_again := pg_temp.po_idle_poll();
	perform pg_temp.base_assert(v_again->'request'=v_first->'request','The provider keeps getting the same power_off');
end
$$;
reset role;

-- Its machine is still on the node, so the deletion waits for it (the office's removal is step D3).
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('92400000-0000-4000-8000-000000000010');
begin
	perform pg_temp.base_assert(v_result->>'state'='waiting' and (v_result#>>'{holdings,machines}')::integer>=1
		and exists(select 1 from public.qorpera_profiles where id='92400000-0000-4000-8000-000000000010'),
		'The deletion waits for the computer''s machine: '||v_result::text);
end
$$;

rollback;

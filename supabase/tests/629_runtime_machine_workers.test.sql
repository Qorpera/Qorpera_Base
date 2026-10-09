-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A run looks up machines by name in its own company only (the status look of qorpera_native_machine_manage,
-- 20260928259055), on the folder-v2 runtime base (ported from snapshot-v1 in the legacy sweep). Alice's run sees its
-- company's machine; another company's machine is none to it.

select pg_temp.base_claims('service_role');
-- The company's machine, and another company's, started by Alice's run as far as the rows say.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('62900000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('62900000-0000-4000-8000-000000000020', '62900000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, desired_by)
select extensions.gen_random_uuid(), company.profile_id, company.environment_id, company.name, 'A machine',
	'92400000-0000-4000-8000-000000000030', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000001', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped', 'agent'
from (values ('92400000-0000-4000-8000-000000000010'::uuid, '92400000-0000-4000-8000-000000000020'::uuid, 'own-1'),
	('62900000-0000-4000-8000-000000000010'::uuid, '62900000-0000-4000-8000-000000000020'::uuid, 'elsewhere')) as company(profile_id, environment_id, name);

-- 1. The company's machine is the run's to see; another company's machine is none.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_own jsonb; v_other jsonb;
begin
	v_own := public.qorpera_native_machine_manage(v_binding, '{"action":"status","machine":"own-1"}');
	perform pg_temp.base_assert(v_own ->> 'schema' = 'qorpera.machine-status/v1' and v_own #>> '{machine,name}' = 'own-1',
		'The run sees its company''s machine: ' || v_own::text);
	v_other := public.qorpera_native_machine_manage(v_binding, '{"action":"status","machine":"elsewhere"}');
	perform pg_temp.base_assert(v_other = '{"schema":"qorpera.machine-status/v1","machine":null}'::jsonb,
		'Another company''s machine is none to the run: ' || v_other::text);
end
$$;

rollback;

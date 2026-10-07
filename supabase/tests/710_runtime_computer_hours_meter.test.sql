-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Computer hours, build step 2 (20260928248000_runtime_computer_hours_meter), on the folder-v2 runtime base (ported from
-- snapshot-v1 in the legacy sweep): machine time is measured from central records only; nothing is charged or stopped.
-- * A run is logged awake at its runner's acceptance and gone when its assignment leaves 'accepted'; an open run counts
--   no further than its assignment's expiry. The base's run of Alice's, through the real claim, assignment and lease.
-- * A coding machine's node demand logs awake, asleep, awake and gone, with its size factor.
-- * The meter counts awake time by size, pauses on a report that shows a machine stopped and on a node silent for five
--   minutes, resumes on a report that shows it running, and rounds each company's running total up once.
-- * Members read their company's month; nobody else does. The records are append-only.
select pg_temp.base_assert(exists (
	select 1 from public.qorpera_computer_hour_log log
	join public.qorpera_computer_hour_inbox inbox on inbox.log_id = log.id
	where log.subject_kind = 'run' and log.state = 'awake' and log.size_factor = 1
		and log.profile_id = '92400000-0000-4000-8000-000000000010'
		and log.subject_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid
		and log.at = (select accepted_at from public.qorpera_runner_assignments
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid)
), 'The base run is logged awake at its runner''s acceptance and queued for the meter');

-- The coding worker of part 2 needs a todo: the owner's todo file in Alice's folder.
select pg_temp.base_commit(pg_temp.base_owner(), 'hours-todo', jsonb_build_array(pg_temp.base_write('agents/alice/todos/hours.md', 'todo',
	E'---\nid: 71000000-0000-4000-8000-0000000000d1\ntitle: Measure computer hours\nstatus: open\n---\n\n',
	'{"kind":"todo","id":"71000000-0000-4000-8000-0000000000d1","title":"Measure computer hours","status":"open","requestedBy":null,"detail":""}'))) \g /dev/null
select pg_temp.base_assert(todo_key = 'hours' and staff_agent_id = '92400000-0000-4000-8000-000000000030', 'Alice''s todo')
from public.qorpera_runtime_agent_todos where id = '71000000-0000-4000-8000-0000000000d1';

-- Only the operator meters; members only read.
select pg_temp.base_assert(not has_function_privilege(role_name, 'public.qorpera_meter_computer_hours()', 'EXECUTE'),
	'The meter is not callable by ' || role_name) from unnest(array['anon', 'authenticated']) role_name;
select pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_meter_computer_hours()', 'EXECUTE'),
	'The service role may run the meter');
-- Nobody but the owner chooses a pass's time: a far-future pass would stop measuring.
select pg_temp.base_assert(not has_function_privilege(role_name, 'public.qorpera_meter_computer_hours_at(timestamptz)', 'EXECUTE'),
	'A timed pass is not callable by ' || role_name) from unnest(array['anon', 'authenticated', 'service_role']) role_name;
select pg_temp.base_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_usage', 'SELECT'),
	'Usage rows are not readable by ' || role_name) from unnest(array['anon', 'authenticated']) role_name;
select pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_read_company_computer_hours(uuid,date)', 'EXECUTE'),
	'Anonymous callers cannot read computer hours');
select pg_temp.base_assert(not exists (
	select 1 from pg_proc function join pg_namespace namespace on namespace.oid = function.pronamespace
	cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
	where namespace.nspname = 'public' and function.proname like 'qorpera_computer_hour%'
		and has_function_privilege(role_name, function.oid, 'EXECUTE')
), 'The meter''s helpers and triggers are callable by no API role');

create function pg_temp.hours_meter(p_now timestamptz) returns jsonb language sql as $$
	select public.qorpera_meter_computer_hours_at(p_now)
$$;
create function pg_temp.hours_usage(p_profile uuid, p_until timestamptz) returns public.qorpera_computer_hour_usage language sql as $$
	select * from public.qorpera_computer_hour_usage where profile_id = p_profile and metered_at = p_until
$$;

-- 1. Runs. The base run's assignment is accepted with a 120 s lease; five minutes on it counts only
-- up to its expiry.
select set_config('qorpera_test.hours_r1', (clock_timestamp() + interval '5 minutes')::text, true);
select pg_temp.base_assert(pg_temp.hours_meter(current_setting('qorpera_test.hours_r1')::timestamptz) ->> 'state' = 'metered',
	'First meter pass');
select pg_temp.base_assert(usage.run_seconds = round(extract(epoch from assignment.expires_at - assignment.accepted_at), 6)
	and usage.standard_seconds = ceil(usage.run_seconds) and usage.company_machine_seconds = 0 and usage.coding_machine_seconds = 0,
	'An open run counts from acceptance to its assignment''s expiry: ' || row_to_json(usage)::text)
from public.qorpera_runner_assignments assignment,
	pg_temp.hours_usage('92400000-0000-4000-8000-000000000010', current_setting('qorpera_test.hours_r1')::timestamptz - interval '30 seconds') usage
where assignment.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid;
select pg_temp.base_assert(pg_temp.hours_meter(current_setting('qorpera_test.hours_r1')::timestamptz) ->> 'state' = 'current',
	'A second pass for the same time counts nothing');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_computer_hour_inbox), 'The meter emptied its queue');

-- The run ends: its assignment leaves 'accepted'. Its end is logged; it adds nothing more.
update public.qorpera_runner_assignments set status = 'completed', finished_at = clock_timestamp()
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid;
select pg_temp.base_assert(exists (select 1 from public.qorpera_computer_hour_log
	where subject_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid and state = 'gone'
		and size_factor is null),
	'A finished assignment is logged gone');
select pg_temp.hours_meter(clock_timestamp() + interval '6 minutes');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_computer_hour_subjects
	where subject_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid),
	'A counted run leaves the working set');
select pg_temp.base_assert(total.charged_standard_seconds = (select sum(standard_seconds) from public.qorpera_computer_hour_usage
	where profile_id = '92400000-0000-4000-8000-000000000010'), 'The run added nothing after its expiry')
from public.qorpera_computer_hour_totals total where total.profile_id = '92400000-0000-4000-8000-000000000010';

-- 2. A coding machine of 8 vCPU / 16 GiB (two standard machines) on a real node.
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select '71000000-0000-4000-8000-000000000101',todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'hours-1',
	'coding','Hours 1','read','each','{}'::jsonb,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,
	(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'version')::bigint
from public.qorpera_runtime_agent_todos todo where todo.id = '71000000-0000-4000-8000-0000000000d1';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select '71000000-0000-4000-8000-000000000201',worker.profile_id,worker.id,'coding-hours',encode(extensions.digest('hours-vm-1','sha256'),'hex')
from public.qorpera_runtime_workers worker where worker.id = '71000000-0000-4000-8000-000000000101';

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
	'nodeId','71000000-0000-4000-8000-000000000010','machineIdSha256',repeat('7',64),'label','hours-fixture',
	'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',16000,'headroomMemoryBytes',34359738368,
	'standardCpuMillis',8000,'standardMemoryBytes',17179869184,'enabled',true),0);
select public.qorpera_enroll_runtime_node_provider('71000000-0000-4000-8000-000000000010',repeat('7',64),'coding','coding-hours',
	repeat('f',64),8000,17179869184);
select public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
	'nodeId','71000000-0000-4000-8000-000000000010','host',jsonb_build_object('machineIdSha256',repeat('7',64),
	'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
	'serverVersion','5.21','architecture','x86_64'),'operatingCpuMillis',2000,'operatingMemoryBytes',4294967296,'infrastructure','[]'::jsonb));
select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
	'nodeId','71000000-0000-4000-8000-000000000010','machineIdSha256',repeat('7',64),'observationId',extensions.gen_random_uuid(),
	'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'cpuMillis',32000,'memoryBytes',68719476736,'state','ready'),
	public.qorpera_runtime_node_inventory_context('71000000-0000-4000-8000-000000000010') ->> 'contextSha256',
	jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
select pg_temp.base_assert(public.qorpera_reserve_runtime_node_machine('71000000-0000-4000-8000-000000000201','coding','coding-hours',
	repeat('f',64),encode(extensions.digest('hours-vm-1','sha256'),'hex'),repeat('7',64),8000,17179869184) ->> 'state' = 'reserved',
	'The coding machine is admitted');
reset role;
select pg_temp.base_assert(exists (select 1 from public.qorpera_computer_hour_log
	where subject_id = '71000000-0000-4000-8000-000000000201' and state = 'awake' and subject_kind = 'coding_machine'
		and size_factor = 2 and node_id = '71000000-0000-4000-8000-000000000010'
		and profile_id = '92400000-0000-4000-8000-000000000010'),
	'An admitted coding machine of 8 vCPU / 16 GiB is logged awake at two standard machines');
update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = '71000000-0000-4000-8000-000000000201';
update public.qorpera_runtime_node_demands set suspended_at = null where allocation_id = '71000000-0000-4000-8000-000000000201';
update public.qorpera_runtime_node_demands set last_checked_at = clock_timestamp() where allocation_id = '71000000-0000-4000-8000-000000000201';
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = '71000000-0000-4000-8000-000000000201';
select pg_temp.base_assert(array_agg(state order by id) = array['awake','asleep','awake','gone'],
	'Sleep, wake and release are logged, and an unrelated update is not: ' || array_agg(state order by id)::text)
from public.qorpera_computer_hour_log where subject_id = '71000000-0000-4000-8000-000000000201';
select pg_temp.hours_meter(clock_timestamp() + interval '7 minutes');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_computer_hour_subjects
	where subject_id = '71000000-0000-4000-8000-000000000201'), 'A released machine leaves the working set once counted');

-- 3. Timing, with records and node reports written at chosen times one hour ahead, for a company of
-- its own. B is the moment the machine wakes.
select set_config('qorpera_test.hours_b', (clock_timestamp() + interval '1 hour')::text, true);
create function pg_temp.hours_b(p_offset interval) returns timestamptz language sql as $$
	select current_setting('qorpera_test.hours_b')::timestamptz + p_offset
$$;
-- A node report at a chosen time: the machine with the given state, or absent when p_state is null.
create function pg_temp.hours_report(p_offset interval, p_state text) returns void language sql as $$
	with observation as (
		insert into public.qorpera_runtime_node_observation_receipts (node_id, observation_id, observed_at, received_at, observation)
		values ('71000000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), pg_temp.hours_b(p_offset),
			pg_temp.hours_b(p_offset), '{"state":"ready"}'::jsonb)
		returning node_id, observation_id
	)
	insert into public.qorpera_runtime_node_inventory_receipts (node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
	select node_id, observation_id, 1, repeat('0', 64), repeat('0', 64), jsonb_build_object('schema', 'qorpera.runtime-node-inventory/v1',
		'bootId', extensions.gen_random_uuid(), 'entries', case when p_state is null then '[]'::jsonb else jsonb_build_array(
			jsonb_build_object('allocation', jsonb_build_object('allocationId', '71000000-0000-4000-8000-000000000301'),
				'state', p_state, 'category', 'managed', 'physicalId', null)) end)
	from observation
$$;
create function pg_temp.hours_pass(p_offset interval) returns public.qorpera_computer_hour_usage language plpgsql as $$
begin
	perform pg_temp.base_assert(pg_temp.hours_meter(pg_temp.hours_b(p_offset) + interval '30 seconds') ->> 'state' = 'metered',
		'Meter pass at B + ' || p_offset::text);
	return pg_temp.hours_usage('71000000-0000-4000-8000-0000000000f1', pg_temp.hours_b(p_offset));
end
$$;
select public.qorpera_computer_hour_record('71000000-0000-4000-8000-0000000000f1', 'coding_machine',
	'71000000-0000-4000-8000-000000000301', '71000000-0000-4000-8000-000000000010', 'awake', 2, pg_temp.hours_b('0'));
-- A run of 1.25 s, to see the running total rounded up once.
select public.qorpera_computer_hour_record('71000000-0000-4000-8000-0000000000f1', 'run',
	'71000000-0000-4000-8000-000000000302', null, 'awake', 1, pg_temp.hours_b('100 milliseconds'));
select public.qorpera_computer_hour_record('71000000-0000-4000-8000-0000000000f1', 'run',
	'71000000-0000-4000-8000-000000000302', null, 'gone', null, pg_temp.hours_b('1350 milliseconds'));
-- The node reported just before the machine woke, and every four minutes after.
select pg_temp.hours_report('-1 minute', 'unavailable');
select pg_temp.hours_report(n * interval '4 minutes', 'running') from generate_series(1, 7) n;

select pg_temp.base_assert(usage.coding_machine_seconds = 3600 and usage.run_seconds = 1.25 and usage.standard_seconds = 3602,
	'Thirty minutes at two standard machines plus 1.25 s of run, rounded up once: ' || row_to_json(usage)::text)
from pg_temp.hours_pass('30 minutes') usage;

-- Stopped at B+32, running again at B+36: the four minutes between are not counted.
select pg_temp.hours_report('32 minutes', 'suspended');
select pg_temp.hours_report('34 minutes', 'unavailable');
select pg_temp.hours_report('36 minutes', 'running');
select pg_temp.hours_report('38 minutes', 'running');
select pg_temp.base_assert(usage.coding_machine_seconds = 720 and usage.standard_seconds = 720,
	'B+30..32 and B+36..40 at two standard machines: ' || row_to_json(usage)::text)
from pg_temp.hours_pass('40 minutes') usage;

-- No report after B+38: the machine counts five more minutes, then pauses.
select pg_temp.base_assert(usage.coding_machine_seconds = 360 and usage.standard_seconds = 360,
	'A silent node counts five minutes after its last report: ' || row_to_json(usage)::text)
from pg_temp.hours_pass('50 minutes') usage;
select pg_temp.base_assert(pause_reason = 'node_silent' and paused_at = pg_temp.hours_b('43 minutes'),
	'Paused for a silent node at its last report plus five minutes')
from public.qorpera_computer_hour_subjects where subject_id = '71000000-0000-4000-8000-000000000301';

-- A report at B+55 shows it running: counting resumes from there.
select pg_temp.hours_report('55 minutes', 'running');
select pg_temp.hours_report('58 minutes', 'running');
select pg_temp.base_assert(usage.coding_machine_seconds = 600,
	'Resumed at the report that shows it running: ' || row_to_json(usage)::text)
from pg_temp.hours_pass('60 minutes') usage;
select pg_temp.base_assert(paused_at is null and counted_until = pg_temp.hours_b('60 minutes'), 'Counting again')
from public.qorpera_computer_hour_subjects where subject_id = '71000000-0000-4000-8000-000000000301';

-- A report without the machine pauses it too; the next one with it resumes.
select pg_temp.hours_report('61 minutes', null);
select pg_temp.hours_report('63 minutes', 'running');
select pg_temp.hours_report('66 minutes', 'running');
select public.qorpera_computer_hour_record('71000000-0000-4000-8000-0000000000f1', 'coding_machine',
	'71000000-0000-4000-8000-000000000301', '71000000-0000-4000-8000-000000000010', 'asleep', null, pg_temp.hours_b('65 minutes'));
select pg_temp.hours_report('69 minutes', 'suspended');
-- B+60..61 and B+63..65 at two standard machines; the sleep ends it; later reports change nothing.
select pg_temp.base_assert(usage.coding_machine_seconds = 360 and usage.standard_seconds = 360,
	'Absent from a report is paused, and asleep ends the count: ' || row_to_json(usage)::text)
from pg_temp.hours_pass('70 minutes') usage;
select pg_temp.base_assert(not exists (select 1 from public.qorpera_computer_hour_subjects
	where subject_id in ('71000000-0000-4000-8000-000000000301', '71000000-0000-4000-8000-000000000302')),
	'Asleep and gone subjects leave the working set');
select pg_temp.base_assert(exact_standard_seconds = 5641.25 and charged_standard_seconds = 5642,
	'The running total is exact and rounded up once: ' || row_to_json(total)::text)
from public.qorpera_computer_hour_totals total where profile_id = '71000000-0000-4000-8000-0000000000f1';
select pg_temp.base_assert(sum(standard_seconds) = 5642, 'Pass additions sum to the rounded total')
from public.qorpera_computer_hour_usage where profile_id = '71000000-0000-4000-8000-0000000000f1';

-- A report never starts a charge for a machine that is asleep.
select pg_temp.hours_report('75 minutes', 'running');
select pg_temp.base_assert(pg_temp.hours_pass('80 minutes') is null, 'An asleep machine counts nothing, whatever the reports say');

-- A second machine (one standard machine) whose node goes silent between two passes: the silence is
-- found in the reports themselves, not only at pass time. Its reports carry it as an unmanaged
-- instance, matched by its bound physical id.
insert into public.qorpera_runtime_workers(id,profile_id,environment_id,staff_agent_id,todo_id,worker_key,species,title,access,revival,
	dispatch,requested_by_user_id,steering_run_id,owner_user_id,owner_sponsor_binding_id,owner_sponsor_version)
select '71000000-0000-4000-8000-000000000102',todo.profile_id,todo.environment_id,todo.staff_agent_id,todo.id,'hours-2',
	'coding','Hours 2','read','each','{}'::jsonb,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,'92400000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,
	(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'version')::bigint
from public.qorpera_runtime_agent_todos todo where todo.id = '71000000-0000-4000-8000-0000000000d1';
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_worker_id,provider_adapter,instance_sha256)
select '71000000-0000-4000-8000-000000000303',worker.profile_id,worker.id,'coding-hours',encode(extensions.digest('hours-vm-3','sha256'),'hex')
from public.qorpera_runtime_workers worker where worker.id = '71000000-0000-4000-8000-000000000102';
insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
values ('71000000-0000-4000-8000-000000000303','71000000-0000-4000-8000-000000000010','71000000-0000-4000-8000-0000000000a3','{}');
create function pg_temp.hours_unmanaged(p_offset interval, p_state text) returns void language sql as $$
	with observation as (
		insert into public.qorpera_runtime_node_observation_receipts (node_id, observation_id, observed_at, received_at, observation)
		values ('71000000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), pg_temp.hours_b(p_offset),
			pg_temp.hours_b(p_offset), '{"state":"unavailable"}'::jsonb)
		returning node_id, observation_id
	)
	insert into public.qorpera_runtime_node_inventory_receipts (node_id, observation_id, node_version, policy_sha256, context_sha256, inventory)
	select node_id, observation_id, 1, repeat('0', 64), repeat('0', 64), jsonb_build_object('schema', 'qorpera.runtime-node-inventory/v1',
		'bootId', extensions.gen_random_uuid(), 'entries', jsonb_build_array(jsonb_build_object('allocation', null,
			'state', p_state, 'category', 'unmanaged', 'physicalId', '71000000-0000-4000-8000-0000000000a3')))
	from observation
$$;
create function pg_temp.hours_pass2(p_offset interval) returns public.qorpera_computer_hour_usage language plpgsql as $$
begin
	perform pg_temp.base_assert(pg_temp.hours_meter(pg_temp.hours_b(p_offset) + interval '30 seconds') ->> 'state' = 'metered',
		'Meter pass at B + ' || p_offset::text);
	return pg_temp.hours_usage('71000000-0000-4000-8000-0000000000f2', pg_temp.hours_b(p_offset));
end
$$;
select pg_temp.hours_unmanaged('89 minutes', 'running');
select public.qorpera_computer_hour_record('71000000-0000-4000-8000-0000000000f2', 'coding_machine',
	'71000000-0000-4000-8000-000000000303', '71000000-0000-4000-8000-000000000010', 'awake', 1, pg_temp.hours_b('90 minutes'));
select pg_temp.hours_unmanaged('92 minutes', 'running');
select pg_temp.hours_unmanaged('94 minutes', 'stopping');
-- Nothing from B+94 to B+105; no pass ran in between.
select pg_temp.hours_unmanaged('105 minutes', 'running');
select pg_temp.hours_unmanaged('108 minutes', 'running');
select pg_temp.base_assert(usage.coding_machine_seconds = 840,
	'B+90..99 (five minutes after the last report before the gap) and B+105..110: ' || row_to_json(usage)::text)
from pg_temp.hours_pass2('110 minutes') usage;
-- 'failed' pauses, 'starting' resumes.
select pg_temp.hours_unmanaged('112 minutes', 'failed');
select pg_temp.hours_unmanaged('115 minutes', 'starting');
select pg_temp.hours_unmanaged('118 minutes', 'running');
select pg_temp.base_assert(usage.coding_machine_seconds = 420, 'B+110..112 and B+115..120: ' || row_to_json(usage)::text)
from pg_temp.hours_pass2('120 minutes') usage;
-- The node goes silent after B+118 and the machine sleeps at B+125: the silence counts first.
select public.qorpera_computer_hour_record('71000000-0000-4000-8000-0000000000f2', 'coding_machine',
	'71000000-0000-4000-8000-000000000303', '71000000-0000-4000-8000-000000000010', 'asleep', null, pg_temp.hours_b('125 minutes'));
select pg_temp.base_assert(usage.coding_machine_seconds = 180,
	'B+120..123, five minutes after the last report, not up to the sleep: ' || row_to_json(usage)::text)
from pg_temp.hours_pass2('130 minutes') usage;

-- 4. Members read their company's month.
select set_config('qorpera_test.hours_month', coalesce(sum(standard_seconds), 0)::text, true)
from public.qorpera_computer_hour_usage
where profile_id = '92400000-0000-4000-8000-000000000010'
	and metered_at >= date_trunc('month', clock_timestamp() at time zone 'Europe/Copenhagen') at time zone 'Europe/Copenhagen'
	and metered_at < (date_trunc('month', clock_timestamp() at time zone 'Europe/Copenhagen') + interval '1 month') at time zone 'Europe/Copenhagen';
select pg_temp.base_assert(current_setting('qorpera_test.hours_month')::bigint > 0, 'The fixture company used some hours');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.base_assert(hours ->> 'schema' = 'qorpera.company-computer-hours/v1' and hours ->> 'timeZone' = 'Europe/Copenhagen'
	and (hours ->> 'usedStandardSeconds')::bigint = current_setting('qorpera_test.hours_month')::bigint
	and (hours -> 'awakeNow' ->> 'runs')::integer = 0,
	'A viewer reads the company''s month: ' || hours::text)
from (select public.qorpera_read_company_computer_hours('92400000-0000-4000-8000-000000000010') hours) read;
reset role;
select pg_temp.base_assert(hours ->> 'month' = to_char(date_trunc('month', clock_timestamp() at time zone 'Europe/Copenhagen')
		+ interval '1 month', 'YYYY-MM') and (hours ->> 'usedStandardSeconds')::bigint = 0,
	'A later month reads empty: ' || hours::text)
from (select public.qorpera_read_company_computer_hours('92400000-0000-4000-8000-000000000010',
	(date_trunc('month', clock_timestamp() at time zone 'Europe/Copenhagen') + interval '1 month 3 days')::date) hours) read;
-- The outsider, who is no member.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.base_error('select public.qorpera_read_company_computer_hours(''92400000-0000-4000-8000-000000000010'')', '42501');
reset role;

-- 5. The records are append-only.
select pg_temp.base_error('update public.qorpera_computer_hour_log set state = ''gone''', '42501');
select pg_temp.base_error('delete from public.qorpera_computer_hour_usage', '42501');
select pg_temp.base_error('update public.qorpera_computer_hour_usage set standard_seconds = 0', '42501');
rollback;

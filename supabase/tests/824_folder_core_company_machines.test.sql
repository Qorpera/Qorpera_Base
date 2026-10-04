-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3f (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.5): on a folder-v2 company every machine
-- path takes the folder fence and the company row KEY SHARE, never the row FOR UPDATE. A holder of the company row KEY
-- SHARE and the fence KEY SHARE (any folder effect) never makes them wait; a stop's second phase (the fence FOR UPDATE)
-- does. Covered: admission, custody (running, commands, the executor's authorization, suspend), an agent's machine_start,
-- a member's start and stop (and a member removed meanwhile), the sweep of stopped task machines and giving up an
-- executor. The snapshot-v1 company keeps the gc fence, and every patched body reversed is the definition before this
-- migration. 648's committed fixture with a machine node and executor, removed at the end.

-- Two machine node helpers, as in 628: the node, its inventory, and a fresh ready observation of its reservations.
create function pg_temp.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('82400000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','82400000-0000-4000-8000-000000000410','machineIdSha256',repeat('8',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
do $$
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','82400000-0000-4000-8000-000000000410','machineIdSha256',repeat('8',64),'label','machine-824','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','82400000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('8',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe();
	perform public.qorpera_enroll_runtime_node_provider('82400000-0000-4000-8000-000000000410',repeat('8',64),'machine','machine-824',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-824',repeat('8',64),true,jsonb_build_object('providerId','machine-824',
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;

-- Machines (committed). The folder-v2 company (10): c-run waits for room; c-member is a member's, stopped. The
-- snapshot-v1 company (11): s-member likewise. E adds the task machines stopped 40 days ago.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values
	('82400000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-run',
		'Run the suite', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000002', 2, 4294967296, 21474836480, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp()),
	('82400000-0000-4000-8000-0000000000a2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-member',
		'A member''s', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped', clock_timestamp(), clock_timestamp()),
	('82400000-0000-4000-8000-0000000000b2', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021', 's-member',
		'A member''s', extensions.gen_random_uuid(), '64800000-0000-4000-8000-0000000000e3', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000003', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped', clock_timestamp(), clock_timestamp());

-- Whether a connection waits at a row of a table (as in 665): it holds that row's tuple lock while blocked.
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
-- fence_one holds what a folder effect holds (the company row and the fence KEY SHARE), or what a stop's second phase holds
-- (the fence FOR UPDATE), or a snapshot-v1 company row KEY SHARE; until pg_temp.release().
create function pg_temp.hold(p_what text, p_profile uuid default '64800000-0000-4000-8000-000000000010') returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_what in ('effect','stop') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_folder_fences where profile_id = %L for %s', p_profile,
			case p_what when 'effect' then 'key share' else 'update' end)) as t(x integer);
	end if;
	if p_what in ('effect','row') then
		perform * from dblink('fence_one', format('select 1 from public.qorpera_profiles where id = %L for key share', p_profile)) as t(x integer);
	end if;
end $$;
create function pg_temp.release() returns void language sql as $$ select dblink_exec('fence_one', 'rollback') $$;
-- Whether nobody holds a row in a mode that blocks FOR UPDATE: probed with NOWAIT on fence_four, which is idle outside
-- any transaction (as in 665). A held row lock is not listed in pg_locks, so this is how a test sees one.
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' for update nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- Whether fence_two's statement ends within 30 s on its own (one that must give up by itself, while fence_one still holds);
-- if not, fence_one lets go, so a wrong lock fails the test instead of hanging it.
create function pg_temp.ends_alone() returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '30 seconds';
begin
	loop
		if dblink_is_busy('fence_two') = 0 then return true; end if;
		if clock_timestamp() > v_until then perform pg_temp.release(); return false; end if;
		perform pg_sleep(0.05);
	end loop;
end $$;
create function pg_temp.machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name
$$;
create function pg_temp.reserved(p_name text) returns boolean language sql as $$
	select public.qorpera_company_machine_reserved(machine) from public.qorpera_company_machines machine where machine.name = p_name
$$;
-- A custody call for the named machine's newest placement not yet removed, as the executor sends it.
create function pg_temp.sql_custody(p_fn text, p_name text, p_extra text default '') returns text language sql as $$
	select format('select public.%s(%L, %L, %L, %L%s)::text', p_fn, placement.id, placement.owner,
		public.qorpera_company_machine_binding_text(placement.binding), placement.machine_id_sha256, p_extra)
	from public.qorpera_company_machine_placements placement join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and placement.removed_at is null order by placement.created_at desc limit 1
$$;
-- Runs each statement on fence_two beside fence_one's hold: none may wait for it, and each must succeed.
create function pg_temp.unblocked(p_label text, p_sql text[]) returns void language plpgsql as $$
declare v_sql text; v_state text;
begin
	foreach v_sql in array p_sql loop
		perform dblink_send_query('fence_two', v_sql);
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception '%: waited for the hold: %', p_label, v_sql; end if;
		v_state := pg_temp.outcome('fence_two');
		if v_state <> 'ok' then raise exception '%: % failed: %', p_label, v_sql, v_state; end if;
	end loop;
end $$;
create function pg_temp.sql_admit() returns text language sql as $$
	select format('select public.qorpera_admit_executor_machines(%L, %L)::text', 'mx-824', repeat('8', 64))
$$;
create function pg_temp.sql_member(p_profile uuid, p_name text, p_action text) returns text language sql as $$
	select format('select public.qorpera_member_manage_company_machine(%L, %L, %L)::text', p_profile, (pg_temp.machine(p_name)).id, p_action)
$$;
create function pg_temp.claims(p_conn text, p_user uuid default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L', case when p_user is null then '{"role":"service_role"}'
		else jsonb_build_object('role', 'authenticated', 'sub', p_user)::text end));
end $$;

-- A. Admission. Behind a stop (the fence FOR UPDATE) it waits at the fence, at most its 2 s, and leaves the company for a
-- later pass. Beside a folder effect it places the machine without waiting. The snapshot-v1 company's brief fence is
-- still the gc fence: it waits for a holder of that company row KEY SHARE and gives up after 2 s.
select pg_temp.observe();
do $$
declare v_state text;
begin
	perform pg_temp.hold('stop');
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then raise exception 'A: admission must wait at the fence'; end if;
	if not pg_temp.ends_alone() then raise exception 'A: admission must give the company up after its brief wait'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or pg_temp.reserved('c-run') then raise exception 'A: behind a stop the company waits a pass: % %', v_state,
		pg_temp.reserved('c-run'); end if;
end $$;
select pg_temp.observe();
do $$
declare v_state text;
begin
	perform pg_temp.hold('effect');
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'A: admission must not wait for a folder effect'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or not pg_temp.reserved('c-run') or not exists (select 1 from public.qorpera_runtime_node_demands demand
			join public.qorpera_company_machine_placements placement on placement.id = demand.allocation_id
			where placement.machine_id = '82400000-0000-4000-8000-0000000000a1' and demand.reserved_at is not null) then
		raise exception 'A: c-run placed beside a folder effect: %', v_state; end if;
	-- The snapshot-v1 control.
	perform pg_temp.hold('row', '64800000-0000-4000-8000-000000000011');
	perform dblink_send_query('fence_two', format('select public.qorpera_company_machine_fence_briefly(%L)::text',
		'64800000-0000-4000-8000-000000000011'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the snapshot-v1 brief fence must wait for the row'; end if;
	if not pg_temp.ends_alone() then raise exception 'A: the snapshot-v1 brief fence must give up by itself'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state not like '55P03 %' then raise exception 'A: the snapshot-v1 brief fence gives up after 2 s: %', v_state; end if;
end $$;

-- B. An agent's machine_start serves folder-v2. Ada's run and its input get an executable runtime bundle (the active one,
-- low effort, standard tier) and the run acknowledges first, as a human wake requires; then authorize, the receipt, and the start beside a
-- folder effect: no wait, and the machine is placed with its own size.
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
	'openai', 'codex-cli', 'machine-ack', 'Starting a machine.', 'progress')
from (select current_setting('qorpera_test.binding')::jsonb b) x \g /dev/null
select set_config('qorpera_test.envelope', jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
	'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.binding')::jsonb) -> 'identity')
		- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
	'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1','logicalOperationKey','m-agent',
		'arguments','{"name":"c-agent","purpose":"Build the site","cpus":1,"memoryGiB":2,"diskGiB":10,"lifetime":"task"}'::jsonb,
		'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text, false) \g /dev/null
select set_config('qorpera_test.envelope_sha', encode(extensions.digest(convert_to(current_setting('qorpera_test.envelope'),'UTF8'),'sha256'),'hex'),
	false) \g /dev/null
select public.qorpera_native_machine_start(current_setting('qorpera_test.binding')::jsonb, current_setting('qorpera_test.envelope'), 'authorize')
	\g /dev/null
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, '82400000-0000-4000-8000-0000000000c1',
	'machine_start:m-agent', current_setting('qorpera_test.envelope_sha'), repeat('9', 64), false) \g /dev/null
select pg_temp.observe();
do $$
declare v_state text; v_result jsonb;
begin
	perform pg_temp.hold('effect');
	perform dblink_send_query('fence_two', format('select public.qorpera_native_machine_start(%L, %L, %L, %L, %L)::text',
		current_setting('qorpera_test.binding'), current_setting('qorpera_test.envelope'), 'begin', '82400000-0000-4000-8000-0000000000c1',
		repeat('9', 64)));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'B: machine_start must not wait for a folder effect'; end if;
	select x::jsonb into v_result from dblink_get_result('fence_two') as t(x text);
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_result #>> '{machine,name}' is distinct from 'c-agent' or v_result #>> '{machine,node}' is distinct from 'machine-824'
		or not pg_temp.reserved('c-agent') or (pg_temp.machine('c-agent')).profile_id <> '64800000-0000-4000-8000-000000000010'
		or (pg_temp.machine('c-agent')).notify_run_ids <> array['64800000-0000-4000-8000-0000000000f1']::uuid[] then
		raise exception 'B: machine_start on folder-v2: % %', v_result, v_state; end if;
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, '82400000-0000-4000-8000-0000000000c1',
		current_setting('qorpera_test.envelope_sha'), v_result);
end $$;

-- B2. Since C1c-3h (20260930002300) the reservation's folder branch serves the coding kind too (and since C1c-3j the
-- office kind): a coding reservation for the folder-v2 company takes the folder fence and the company row KEY SHARE, so
-- it does not wait for a holder of the row KEY SHARE, and refuses for its own reasons: a machine's placement is no
-- coding allocation, so no reservation is had.
do $$
declare v_state text;
begin
	perform pg_temp.hold('row');
	perform dblink_send_query('fence_two', format('select public.qorpera_reserve_runtime_node_machine(%L, %L, %L, %L, %L, %L, %L, %L)::text',
		(select placement.id from public.qorpera_company_machine_placements placement
			where placement.machine_id = (pg_temp.machine('c-agent')).id and placement.removed_at is null),
		'coding', 'machine-824', repeat('f', 64), repeat('0', 64), repeat('8', 64), 1000, 1073741824));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release();
		raise exception 'B2: a folder-v2 coding reservation must not wait for the company row KEY SHARE'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state not like '42501 Company machine reservation unavailable%' then
		raise exception 'B2: the coding reservation refuses after the fence: %', v_state; end if;
end $$;

-- C. Custody beside a folder effect: running, commands and the executor's authorization to run, none waiting. Suspend
-- behind a stop waits at the fence (its brief fence), before the machine or the placement. The node is observed first,
-- outside the block: an observation inside it would hold the node row that the reservation waits for.
select pg_temp.observe();
do $$
declare v_state text;
begin
	perform pg_temp.hold('effect');
	foreach v_state in array array[
		pg_temp.sql_custody('qorpera_mark_company_machine_running', 'c-run', format(', %L', '82400000-0000-4000-8000-0000000000d1')),
		pg_temp.sql_custody('qorpera_record_company_machine_commands', 'c-run',
			format(', %L, %L, %L, true', '82400000-0000-4000-8000-0000000000d1', '[]', '[]')),
		pg_temp.sql_custody('qorpera_authorize_executor_machine', 'c-run', ', ''run''')] loop
		perform dblink_send_query('fence_two', v_state);
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'C: custody waited for a folder effect: %', v_state; end if;
		if pg_temp.outcome('fence_two') <> 'ok' then raise exception 'C: custody failed: %', v_state; end if;
	end loop;
	perform pg_temp.release();
	if (select running_at from public.qorpera_company_machine_placements where machine_id = '82400000-0000-4000-8000-0000000000a1'
			and removed_at is null) is null then raise exception 'C: c-run must be running'; end if;
	perform pg_temp.hold('stop');
	perform dblink_send_query('fence_two', pg_temp.sql_custody('qorpera_suspend_company_machine', 'c-run'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then raise exception 'C: suspend must wait at the fence'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_company_machines where id = '82400000-0000-4000-8000-0000000000a1'$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_company_machine_placements
			where machine_id = '82400000-0000-4000-8000-0000000000a1' and removed_at is null$q$) then
		raise exception 'C: suspend waits at the fence before the machine and the placement'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' and v_state not like '55P03 %' then raise exception 'C: suspend after the stop: %', v_state; end if;
end $$;

-- C2. Suspend and release beside a folder effect, through to the allocation (their second fence): c-run, stopped by its
-- member, sleeps (the executor's stop, then suspend); deleted by its member, it is released (the executor's delete, then
-- release). None waits.
select pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000002');
select * from dblink('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000010', 'c-run', 'stop')) as t(x text);
select pg_temp.claims('fence_two');
select pg_temp.observe();
do $$
begin
	perform pg_temp.hold('effect');
	perform pg_temp.unblocked('C2 sleep', array[pg_temp.sql_custody('qorpera_authorize_executor_machine', 'c-run', ', ''stop'''),
		pg_temp.sql_custody('qorpera_suspend_company_machine', 'c-run')]);
	perform pg_temp.release();
	if (select demand.suspended_at from public.qorpera_runtime_node_demands demand join public.qorpera_company_machine_placements placement
			on placement.id = demand.allocation_id where placement.machine_id = '82400000-0000-4000-8000-0000000000a1'
			and placement.removed_at is null) is null then raise exception 'C2: c-run must sleep'; end if;
end $$;
select pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000002');
select * from dblink('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000010', 'c-run', 'delete')) as t(x text);
select pg_temp.claims('fence_two');
do $$
begin
	perform pg_temp.hold('effect');
	perform pg_temp.unblocked('C2 release', array[pg_temp.sql_custody('qorpera_authorize_executor_machine', 'c-run', ', ''delete'''),
		pg_temp.sql_custody('qorpera_release_company_machine', 'c-run')]);
	perform pg_temp.release();
	if exists (select 1 from public.qorpera_company_machine_placements where machine_id = '82400000-0000-4000-8000-0000000000a1'
			and removed_at is null)
		or exists (select 1 from public.qorpera_runtime_machine_allocations allocation join public.qorpera_company_machine_placements placement
			on placement.id = allocation.id where placement.machine_id = '82400000-0000-4000-8000-0000000000a1' and allocation.released_at is null)
		or (pg_temp.machine('c-run')).removed_at is null then raise exception 'C2: c-run released and removed'; end if;
end $$;

-- D. A member's start and stop beside a folder effect, none waiting; on the snapshot-v1 company the same start waits for
-- that company row (the gc fence). A non-member is refused before any lock.
do $$
declare v_state text;
begin
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000002');
	perform pg_temp.hold('effect');
	foreach v_state in array array['start', 'stop'] loop
		perform dblink_send_query('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000010', 'c-member', v_state));
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'D: a member''s % waited', v_state; end if;
		if pg_temp.outcome('fence_two') <> 'ok' then raise exception 'D: a member''s % failed', v_state; end if;
	end loop;
	perform pg_temp.release();
	if (pg_temp.machine('c-member')).desired_state <> 'stopped' or (pg_temp.machine('c-member')).desired_by <> 'member' then
		raise exception 'D: c-member stopped by its member: %', pg_temp.machine('c-member'); end if;
	-- A non-member of the folder-v2 company.
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000003');
	perform dblink_send_query('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000010', 'c-member', 'start'));
	v_state := pg_temp.outcome('fence_two');
	if v_state <> '42501 Company is unavailable' then raise exception 'D: a non-member: %', v_state; end if;
	-- The snapshot-v1 control.
	perform pg_temp.hold('row', '64800000-0000-4000-8000-000000000011');
	perform dblink_send_query('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000011', 's-member', 'start'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'D: the snapshot-v1 start must wait for the row'; end if;
	perform pg_temp.release();
	if pg_temp.outcome('fence_two') <> 'ok' then raise exception 'D: the snapshot-v1 start after the row'; end if;
	perform * from dblink('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000011', 's-member', 'stop')) as t(x text);
	perform pg_temp.claims('fence_two');
end $$;

-- E. The sweep of stopped task machines: c-sweep and s-sweep, stopped 40 days ago with no placement (committed now, so
-- that no earlier admission pass swept them).
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values
	('82400000-0000-4000-8000-0000000000a3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-sweep',
		'Long done', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped',
		clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days'),
	('82400000-0000-4000-8000-0000000000b3', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021', 's-sweep',
		'Long done', extensions.gen_random_uuid(), '64800000-0000-4000-8000-0000000000e3', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000003', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped',
		clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days');
-- The sweep. Behind a stop it leaves the folder-v2 company without waiting (the fence NOWAIT);
-- beside a folder effect it deletes c-sweep. The snapshot-v1 company's sweep still takes that row FOR UPDATE NOWAIT: a
-- holder of the row KEY SHARE makes it skip s-sweep.
do $$
declare v_state text;
begin
	perform pg_temp.hold('stop');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000011'
		for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'E: the sweep must not wait for a stop'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or (pg_temp.machine('c-sweep')).removed_at is not null or (pg_temp.machine('s-sweep')).removed_at is not null then
		raise exception 'E: behind a stop c-sweep waits a pass (and s-sweep beside its row''s holder): %', v_state; end if;
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for key share$q$) as t(x integer);
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id in ('64800000-0000-4000-8000-000000000010',
		'64800000-0000-4000-8000-000000000011') order by id for key share$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'E: the sweep must not wait for a folder effect'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or (pg_temp.machine('c-sweep')).removed_at is null or (pg_temp.machine('c-sweep')).desired_by <> 'kernel'
		or (pg_temp.machine('s-sweep')).removed_at is not null then
		raise exception 'E: c-sweep deleted beside a folder effect, s-sweep kept beside its row''s holder: % % %', v_state,
			pg_temp.machine('c-sweep'), pg_temp.machine('s-sweep'); end if;
end $$;

-- E3. The sweep takes the company row (rank 0) before the machine: behind a holder of the row stronger than KEY SHARE (until
-- C1c-3g, deletion's gc fence) it waits at the row, then deletes c-sweep2. c-sweep2 is the pass's oldest stopped machine,
-- so the pass holds no other company's row when it gets there.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('82400000-0000-4000-8000-0000000000a4', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-sweep2',
	'Long done', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped',
	clock_timestamp() - interval '41 days', clock_timestamp() - interval '41 days');
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profiles') then raise exception 'E3: the sweep must wait at the company row'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_company_machines where id = '82400000-0000-4000-8000-0000000000a4'$q$) then
		raise exception 'E3: the sweep takes the row before the machine'; end if;
	perform pg_temp.release();
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or (pg_temp.machine('c-sweep2')).removed_at is null then raise exception 'E3: c-sweep2 after the row: %', v_state; end if;
end $$;

-- E4. After the pass gives up a disk it waits for no folder-v2 company's row: a company whose machine lock it holds is not
-- swept in that pass. The executor gives machines
-- 40 GiB; c-agent holds 10 and c-sleep, asleep, 20; c-big (20) waits, so the pass gives up c-sleep's disk (its company's
-- machine lock and c-sleep's row, to the end of the pass). Behind a holder of the company row FOR UPDATE (deletion until
-- C1c-3g, which wants that lock and those machines next) the sweep then leaves c-sweep3 alone instead of waiting there.
select public.qorpera_configure_machine_executor('mx-824', repeat('8', 64), true, (select policy from public.qorpera_machine_executors
	where owner = 'mx-824'), 42949672960) \g /dev/null
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('82400000-0000-4000-8000-0000000000a5', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-sleep',
	'Sleeps', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 21474836480, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp());
select pg_temp.observe();
select public.qorpera_admit_executor_machines('mx-824', repeat('8', 64)) \g /dev/null
select public.qorpera_set_company_machine_desired(machine, 'stopped', 'member') from public.qorpera_company_machines machine
where machine.name = 'c-sleep' \g /dev/null
do $$
begin
	execute pg_temp.sql_custody('qorpera_authorize_executor_machine', 'c-sleep', ', ''stop''');
	execute pg_temp.sql_custody('qorpera_suspend_company_machine', 'c-sleep');
end $$;
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values
	('82400000-0000-4000-8000-0000000000a6', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-big',
		'Needs room', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000002', 1, 1073741824, 21474836480, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp()),
	('82400000-0000-4000-8000-0000000000a7', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-sweep3',
		'Long done', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped',
		clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days');
select pg_temp.observe();
do $$
declare v_state text;
begin
	if (select demand.suspended_at from public.qorpera_runtime_node_demands demand join public.qorpera_company_machine_placements placement
			on placement.id = demand.allocation_id where placement.machine_id = '82400000-0000-4000-8000-0000000000a5'
			and placement.removed_at is null) is null then raise exception 'E4: c-sleep must sleep on the node'; end if;
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release();
		raise exception 'E4: the sweep waited for the company row while the pass held its machine lock'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or not exists (select 1 from public.qorpera_company_machine_placements
			where machine_id = '82400000-0000-4000-8000-0000000000a5' and retired_at is not null and removed_at is null)
		or (pg_temp.machine('c-sweep3')).removed_at is not null then
		raise exception 'E4: c-sleep''s disk given up and c-sweep3 left for a later pass: %', v_state; end if;
	-- A later pass sweeps it.
	perform * from dblink('fence_two', pg_temp.sql_admit()) as t(x text);
	if (pg_temp.machine('c-sweep3')).removed_at is null then raise exception 'E4: a later pass sweeps c-sweep3'; end if;
end $$;

-- E5. A pass that holds another company's row waits for no folder-v2 company's row: s-sweep2, the oldest, is swept first
-- (its row held to the end of the pass); behind a holder of the folder-v2 company's row FOR UPDATE (a node update drain
-- locks several companies' rows in id order and may want s-sweep2's next) c-sweep4 is left for a later pass.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values
	('82400000-0000-4000-8000-0000000000b4', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021', 's-sweep2',
		'Long done', extensions.gen_random_uuid(), '64800000-0000-4000-8000-0000000000e3', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000003', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped',
		clock_timestamp() - interval '42 days', clock_timestamp() - interval '42 days'),
	('82400000-0000-4000-8000-0000000000a8', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'c-sweep4',
		'Long done', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
		'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'stopped',
		clock_timestamp() - interval '41 days', clock_timestamp() - interval '41 days');
do $$
declare v_state text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', pg_temp.sql_admit());
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform pg_temp.release();
		raise exception 'E5: the sweep waited for a folder-v2 row while it held another company''s'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or (pg_temp.machine('s-sweep2')).removed_at is null or (pg_temp.machine('c-sweep4')).removed_at is not null then
		raise exception 'E5: s-sweep2 swept and c-sweep4 left for a later pass: %', v_state; end if;
	perform * from dblink('fence_two', pg_temp.sql_admit()) as t(x text);
	if (pg_temp.machine('c-sweep4')).removed_at is null then raise exception 'E5: a later pass sweeps c-sweep4'; end if;
end $$;

-- F. Giving up a disabled executor beside a folder effect: no wait, and the folder-v2 placement left (c-agent's) is removed.
select public.qorpera_configure_machine_executor('mx-824', repeat('8', 64), false, (select policy from public.qorpera_machine_executors
	where owner = 'mx-824'), 322122547200) \g /dev/null
do $$
declare v_state text;
begin
	perform pg_temp.hold('effect');
	perform dblink_send_query('fence_two', format('select public.qorpera_abandon_machine_executor(%L, %L)::text', 'mx-824', repeat('8', 64)));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'F: giving up must not wait for a folder effect'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform pg_temp.release();
	if v_state <> 'ok' or exists (select 1 from public.qorpera_company_machine_placements where owner = 'mx-824' and removed_at is null) then
		raise exception 'F: every placement given up: %', v_state; end if;
end $$;

-- G0. A member demoted while its start waits: the same wait at the member's row, then the refusal (a viewer cannot write).
do $$
declare v_state text;
begin
	perform pg_temp.claims('fence_one', '64800000-0000-4000-8000-000000000001');
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000002');
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000002', 'viewer')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000010', 'c-member', 'start'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then raise exception 'G0: the start must wait at the member'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> '42501 Company is unavailable' or (pg_temp.machine('c-member')).desired_state <> 'stopped' then
		raise exception 'G0: a demoted member''s start: %', v_state; end if;
	perform * from dblink('fence_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000002', 'contributor')) as t(x text);
	perform pg_temp.claims('fence_one');
	perform pg_temp.claims('fence_two');
end $$;

-- G. A member removed while its start waits: the start waits at the member's row behind the removal (the fence NO KEY
-- UPDATE and the company row do not stop it), then reads its access again and refuses.
do $$
declare v_state text;
begin
	perform pg_temp.claims('fence_one', '64800000-0000-4000-8000-000000000001');
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000002');
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select public.qorpera_remove_profile_member(%L, %L)::text', '64800000-0000-4000-8000-000000000010',
		'64800000-0000-4000-8000-000000000002')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_member('64800000-0000-4000-8000-000000000010', 'c-member', 'start'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then raise exception 'G: the start must wait at the member'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> '42501 Company is unavailable' or (pg_temp.machine('c-member')).desired_state <> 'stopped' then
		raise exception 'G: a removed member''s start: %', v_state; end if;
	perform pg_temp.claims('fence_one');
	perform pg_temp.claims('fence_two');
end $$;

-- H. Snapshot-v1 keeps its text: each patched body with its folder-v2 branches reversed is byte for byte the definition
-- before this migration. The new helper refuses a company with no folder fence, is postgres-only and takes nothing
-- stronger than KEY SHARE.
create temporary table c1c3f_patches(n serial, fn text, digest text, patched text, original text) on commit preserve rows;
insert into c1c3f_patches(fn, digest, patched, original) values
		-- C1c-3n (20260930046000) added a run machine's branch after the folder one: undone first.
		('qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', '6b177644e5a6533559d1ff78dfdcbc4b',
			E' -- C1c-3n (20260930046000): a folder-v2 run''s machine (its company reservation took the identity''s machine lock).\n'
			|| E' elsif p_provider_kind = ''native'' and public.qorpera_company_is_folder_v2(v_profile) then\n'
			|| E'  perform public.qorpera_folder_machine_fence(v_profile);\n',
			''),
		-- P13 (20260930035000) widened the folder branch to the login kind on top of C1c-3j: undone next.
		('qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', '6b177644e5a6533559d1ff78dfdcbc4b',
			E' -- office kind. 20260930035000: a sign-in''s or refresh''s login machine too (the gateway''s own call, after the\n'
			|| E' -- company reservation).\n'
			|| E' if p_provider_kind in (''machine'', ''coding'', ''office'', ''login'') and public.qorpera_company_is_folder_v2(v_profile) then\n',
			E' -- office kind.\n'
			|| E' if p_provider_kind in (''machine'', ''coding'', ''office'') and public.qorpera_company_is_folder_v2(v_profile) then\n'),
		-- C1c-3j (20260930012000) widened the folder branch to offices on top of C1c-3h: undone next, then C1c-3h's
		-- patch, then C1c-3f's own.
		('qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', '6b177644e5a6533559d1ff78dfdcbc4b',
			E' -- every caller. C1c-3h (20260930002300): the coding kind takes it too, and C1c-3j (20260930012000) the\n'
			|| E' -- office kind.\n'
			|| E' if p_provider_kind in (''machine'', ''coding'', ''office'') and public.qorpera_company_is_folder_v2(v_profile) then\n',
			E' -- every caller. C1c-3h (20260930002300): the coding kind takes it too; office (C1c-3j) reservations still come\n'
			|| E' -- with the gc fence.\n'
			|| E' if p_provider_kind in (''machine'', ''coding'') and public.qorpera_company_is_folder_v2(v_profile) then\n'),
		('qorpera_company_machine_fence_briefly(uuid)', '67fbb82ff9e2ca093be14b54b9ac764a',
			E'\t-- C1c-3f (20260930002000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
			|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_machine_fence(p_profile_id);\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
			|| E'\tend if;\n',
			E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'),
		('qorpera_place_company_machine(uuid,text,uuid)', '31156e80d6fc55d9ab6c5606b491a608',
			E'\t\t-- C1c-3f (20260930002000): on folder-v2 the folder fence and the company row KEY SHARE, held by every caller.\n'
			|| E'\t\tif public.qorpera_company_is_folder_v2(v_machine.profile_id) then\n'
			|| E'\t\t\tperform public.qorpera_folder_machine_fence(v_machine.profile_id);\n'
			|| E'\t\telse\n'
			|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n'
			|| E'\t\tend if;\n',
			E'\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n'),
		-- C1c-3h (20260930002300) widened the reservation's folder branch to the coding kind: reversed first.
		('qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', '6b177644e5a6533559d1ff78dfdcbc4b',
			E' -- every caller. C1c-3h (20260930002300): the coding kind takes it too; office (C1c-3j) reservations still come\n'
			|| E' -- with the gc fence.\n'
			|| E' if p_provider_kind in (''machine'', ''coding'') and public.qorpera_company_is_folder_v2(v_profile) then\n',
			E' -- every caller; coding (C1c-3h) and office (C1c-3j) reservations still come with the gc fence.\n'
			|| E' if p_provider_kind=''machine'' and public.qorpera_company_is_folder_v2(v_profile) then\n'),
		('qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', '6b177644e5a6533559d1ff78dfdcbc4b',
			E' -- C1c-3f (20260930002000): a folder-v2 machine takes the folder fence and the company row KEY SHARE, held by\n'
			|| E' -- every caller; coding (C1c-3h) and office (C1c-3j) reservations still come with the gc fence.\n'
			|| E' if p_provider_kind=''machine'' and public.qorpera_company_is_folder_v2(v_profile) then\n'
			|| E'  perform public.qorpera_folder_machine_fence(v_profile);\n'
			|| E' else\n'
			|| E' perform public.qorpera_lock_profile_gc_fence(v_profile);\n'
			|| E' end if;\n',
			E' perform public.qorpera_lock_profile_gc_fence(v_profile);\n'),
		('qorpera_suspend_company_machine(uuid,text,text,text)', '7ce8da11954a868e0243a322af31870a',
			E'\t-- C1c-3f (20260930002000): on folder-v2 custody holds the folder fence and the company row KEY SHARE.\n'
			|| E'\tif not public.qorpera_company_is_folder_v2(v_placement.profile_id) then\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n'
			|| E'\tend if;\n',
			E'\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n'),
		('qorpera_release_company_machine(uuid,text,text,text)', 'c77b3dc5f2ed8289f322ea65d211868d',
			E'\t\t\t-- C1c-3f (20260930002000): on folder-v2 custody holds the folder fence and the company row KEY SHARE.\n'
			|| E'\t\t\tif not public.qorpera_company_is_folder_v2(v_placement.profile_id) then\n'
			|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n'
			|| E'\t\t\tend if;\n',
			E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n'),
		('qorpera_member_manage_company_machine(uuid,uuid,text)', '1ef5ec5f86e03f3ff159954b827d0811',
			E'\t-- C1c-3f (20260930002000): on folder-v2 the folder fence, the company row and the member''s row KEY SHARE, then the\n'
			|| E'\t-- member''s write access read again (a removal or a demotion that committed meanwhile refuses here).\n'
			|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
			|| E'\t\tperform public.qorpera_folder_machine_fence(p_profile_id);\n'
			|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = auth.uid() for key share;\n'
			|| E'\t\tif not public.qorpera_can_write_profile(p_profile_id) then raise exception ''Company is unavailable'' using errcode = ''42501''; end if;\n'
			|| E'\telse\n'
			|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
			|| E'\tend if;\n',
			E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'),
		('qorpera_admit_executor_machines(text,text,integer)', 'ab46ce15d32dadd7e1a33a0c1e5ef307',
			E'\t\t\t-- C1c-3f (20260930002000): on folder-v2 the fence KEY SHARE without waiting (a company being stopped is swept\n'
			|| E'\t\t\t-- on a later pass), then the company row KEY SHARE, which waits only for a holder of the row stronger. Until\n'
			|| E'\t\t\t-- C1c-3g that holder may be deletion (it wants the machine locks a disk give-up holds) or a node update drain (it\n'
			|| E'\t\t\t-- wants the other rows the sweep holds): with either held, the company waits a pass.\n'
			|| E'\t\t\tif public.qorpera_company_is_folder_v2(v_machine.profile_id) then\n'
			|| E'\t\t\t\tif cardinality(v_gave_up) > 0 or exists (select 1 from unnest(v_swept) as held(profile_id)\n'
			|| E'\t\t\t\t\twhere held.profile_id <> v_machine.profile_id) then raise sqlstate ''P0F04''; end if;\n'
			|| E'\t\t\t\tperform 1 from public.qorpera_folder_fences where profile_id = v_machine.profile_id for key share nowait;\n'
			|| E'\t\t\t\tif not found then raise sqlstate ''P0F04''; end if;\n'
			|| E'\t\t\t\tperform 1 from public.qorpera_profiles where id = v_machine.profile_id for key share;\n'
			|| E'\t\t\telse\n'
			|| E'\t\t\tperform 1 from public.qorpera_profiles where id = v_machine.profile_id for update nowait;\n'
			|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n'
			|| E'\t\t\tend if;\n'
			|| E'\t\t\tv_swept := v_swept || v_machine.profile_id; -- C1c-3f (20260930002000)\n',
			E'\t\t\tperform 1 from public.qorpera_profiles where id = v_machine.profile_id for update nowait;\n'
			|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n'),
		('qorpera_admit_executor_machines(text,text,integer)', 'ab46ce15d32dadd7e1a33a0c1e5ef307',
			E'\tv_busy uuid[] := ''{}'';\n'
			|| E'\tv_gave_up uuid[] := ''{}''; v_swept uuid[] := ''{}''; -- C1c-3f (20260930002000)\n',
			E'\tv_busy uuid[] := ''{}'';\n'),
		('qorpera_admit_executor_machines(text,text,integer)', 'ab46ce15d32dadd7e1a33a0c1e5ef307',
			E'\t\t\t\t\t-- C1c-3f (20260930002000): held to the end of the pass.\n'
			|| E'\t\t\t\t\tv_gave_up := v_gave_up || v_asleep.profile_id;\n',
			''),
		('qorpera_abandon_machine_executor(text,text)', '85ca236d08d4ef9756a9a5abf35aacc8',
			E'\t\t-- C1c-3f (20260930002000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
			|| E'\t\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
			|| E'\t\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
			|| E'\t\telse\n'
			|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
			|| E'\t\tend if;\n',
			E'\t\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'),
		('qorpera_native_machine_start(jsonb,text,text,uuid,text)', 'dbc139924cbf11ad3911f49e3f60a302',
			E'\t-- C1c-3f (20260930002000): serves folder-v2; the authority check below is then the folder tool run.\n',
			E'\tif public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n');
do $$
declare v record; p record; v_text text; v_bad text[] := '{}';
begin
	for v in select fn, min(digest) as digest from c1c3f_patches group by fn loop
		v_text := pg_get_functiondef(('public.' || v.fn)::regprocedure);
		for p in select * from c1c3f_patches where fn = v.fn order by n loop
			if position(p.patched in v_text) = 0 then v_bad := v_bad || (v.fn || ' (a patch is missing)'); end if;
			v_text := replace(v_text, p.patched, p.original);
		end loop;
		if md5(v_text) <> v.digest then v_bad := v_bad || v.fn; end if;
	end loop;
	if cardinality(v_bad) > 0 then raise exception 'H: snapshot-v1 text changed in: %', v_bad; end if;
	begin
		perform public.qorpera_folder_machine_fence(extensions.gen_random_uuid());
		raise exception 'H: the helper must refuse a company with no folder fence';
	exception when insufficient_privilege then
		if sqlerrm <> 'Company folder is unavailable' then raise; end if;
	end;
	if has_function_privilege('public', 'public.qorpera_folder_machine_fence(uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_machine_fence(uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_machine_fence(uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_machine_fence(uuid)', 'execute') then
		raise exception 'H: qorpera_folder_machine_fence must be postgres-only'; end if;
	if pg_get_functiondef('public.qorpera_folder_machine_fence(uuid)'::regprocedure) ~* 'for (update|no key update|share)\M|nowait' then
		raise exception 'H: qorpera_folder_machine_fence takes only KEY SHARE'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture: the machine node and executor, then 648's company rows as 648 removes them.
set session_replication_role = replica;
do $$
declare v_table record;
begin
	for v_table in select c.table_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
		execute format('delete from public.%I where node_id = $1', v_table.table_name) using '82400000-0000-4000-8000-000000000410'::uuid;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '82400000-0000-4000-8000-000000000410';
	delete from public.qorpera_machine_executors where owner = 'mx-824';
end $$;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
	-- The computer-hour inbox keeps ids of hour-log rows the loop above removed.
	delete from public.qorpera_computer_hour_inbox inbox
	where not exists (select 1 from public.qorpera_computer_hour_log log where log.id = inbox.log_id);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_company_machines where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_nodes where id = '82400000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-824')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;

-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930737000: the executor's list of machines says who a machine was started by, with the saved figure and the
-- template every client draws that agent's figure from, so the executor can write the figure into the machine for its
-- desktop's backdrop. 648's committed folder-v2 fixture (Ada and the Co-Founder) with a machine node and executor, as
-- the idle rule's test makes them: Ada's run started m-1231-a; a member started m-1231-b for the Co-Founder (a machine
-- no run started, 20260930730000). Covered:
-- 1. The entry of each machine names its starter: the agent's id, its figure as saved (none for an agent nobody
--    dressed), and its template (co-founder for the Co-Founder, none for a folder hire).
-- 2. The figure follows the agent's row: a saved one, a retired one as saved (the executor draws its replacement), none
--    again; and a starter whose row is gone is null.
-- 3. Nothing else in the entry moved: its other keys are the ones the executor reads (and the company's time zone, which
--    20260930739000 added: test 1233).
-- 4. The function is the service role's alone, names this migration and keeps the earlier ones.
-- The fixture is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Machine desktop figure: %', p_message; end if; end
$$;
-- The machine node and its executor, as 824 makes them: the node, its inventory, and a fresh ready observation.
create function pg_temp.observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12310000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12310000-0000-4000-8000-000000000410','machineIdSha256',repeat('1231',16),'observationId',extensions.gen_random_uuid(),
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
		'nodeId','12310000-0000-4000-8000-000000000410','machineIdSha256',repeat('1231',16),'label','machine-1231','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12310000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('1231',16),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.observe();
	perform public.qorpera_enroll_runtime_node_provider('12310000-0000-4000-8000-000000000410',repeat('1231',16),'machine','machine-1231',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-1231',repeat('1231',16),true,jsonb_build_object('providerId','machine-1231',
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;

-- Ada's task machine, started by her leased run; and the Co-Founder's, started by a member from the computer window
-- (no run, no receipt). Both get room on the node.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('12310000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-1231-a',
	'Build the site', '64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(),
	'64800000-0000-4000-8000-000000000002', 1, 1073741824, 10737418240, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp()),
	('12310000-0000-4000-8000-0000000000a2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'm-1231-b',
	'A member started it from the computer window.', '64800000-0000-4000-8000-0000000000c0', null, null,
	'64800000-0000-4000-8000-000000000002', 2, 4294967296, 42949672960, 'standard', 'task', 'running', clock_timestamp(), clock_timestamp());
select pg_temp.observe();
select public.qorpera_admit_executor_machines('mx-1231', repeat('1231',16)) \g /dev/null
select public.qorpera_admit_executor_machines('mx-1231', repeat('1231',16)) \g /dev/null

create function pg_temp.entry(p_machine uuid) returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1231', repeat('1231',16))) entry
	where entry ->> 'machineId' = p_machine::text
$$;
create function pg_temp.figure(p_agent uuid, p_figure text) returns void language sql as $$
	update public.qorpera_profile_staff set appearance_creature = p_figure
	where profile_id = '64800000-0000-4000-8000-000000000010' and staff_agent_id = p_agent
$$;

-- 1. Each machine's entry names its starter.
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a1') is not null
	and pg_temp.entry('12310000-0000-4000-8000-0000000000a2') is not null, 'both machines are placed on the node and listed');
select pg_temp.figure('64800000-0000-4000-8000-0000000000a1', null);
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a1') -> 'starter'
	= jsonb_build_object('staffAgentId', '64800000-0000-4000-8000-0000000000a1', 'figure', null, 'templateId', null),
	'a run''s machine names its agent, with no figure and no template for a folder hire nobody dressed: '
	|| coalesce((pg_temp.entry('12310000-0000-4000-8000-0000000000a1') -> 'starter')::text, 'null'));
select pg_temp.figure('64800000-0000-4000-8000-0000000000c0', 'crown');
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a2') -> 'starter'
	= jsonb_build_object('staffAgentId', '64800000-0000-4000-8000-0000000000c0', 'figure', 'crown', 'templateId', 'co-founder'),
	'a machine no run started names the agent it was started for, the Co-Founder with its template: '
	|| coalesce((pg_temp.entry('12310000-0000-4000-8000-0000000000a2') -> 'starter')::text, 'null'));

-- 2. The figure follows the agent's row, as saved.
select pg_temp.figure('64800000-0000-4000-8000-0000000000a1', 'star');
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a1') #>> '{starter,figure}' = 'star'
	and pg_temp.entry('12310000-0000-4000-8000-0000000000a2') #>> '{starter,figure}' = 'crown', 'a saved figure is answered, each agent its own');
select pg_temp.figure('64800000-0000-4000-8000-0000000000a1', 'ghost');
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a1') #>> '{starter,figure}' = 'ghost',
	'a retired figure is answered as it was saved: the executor draws its replacement, as every client does');
select pg_temp.figure('64800000-0000-4000-8000-0000000000c0', null);
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a2') -> 'starter' -> 'figure' = 'null'::jsonb
	and pg_temp.entry('12310000-0000-4000-8000-0000000000a2') #>> '{starter,templateId}' = 'co-founder',
	'an agent without a saved figure keeps its template: the executor takes the template''s figure');
-- A starter whose row is gone: null, and the entry is still listed.
set session_replication_role = replica;
update public.qorpera_company_machines set started_by_staff_agent_id = '12310000-0000-4000-8000-0000000000ee'
where id = '12310000-0000-4000-8000-0000000000a1';
set session_replication_role = origin;
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a1') ? 'starter'
	and pg_temp.entry('12310000-0000-4000-8000-0000000000a1') -> 'starter' = 'null'::jsonb, 'a starter whose row is gone is null');
set session_replication_role = replica;
update public.qorpera_company_machines set started_by_staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
where id = '12310000-0000-4000-8000-0000000000a1';
set session_replication_role = origin;

-- 3. Nothing else in the entry moved.
select pg_temp.check((select array_agg(key order by key) from jsonb_object_keys(pg_temp.entry('12310000-0000-4000-8000-0000000000a1')) key)
	= array['asleepSince','binding','bindingText','bootId','commands','createdAt','desiredState','instanceSha256','lastError','lastUsedAt',
		'lifetime','machineId','placementId','released','removeDue','removing','reserved','retired','runningAt','schema','sleepDue','starter',
		'stopDue','timeZone'],
	'the entry has the keys the executor reads, the starter and the company''s time zone (20260930739000): '
	|| (select string_agg(key, ',' order by key) from jsonb_object_keys(pg_temp.entry('12310000-0000-4000-8000-0000000000a1')) key));
select pg_temp.check(pg_temp.entry('12310000-0000-4000-8000-0000000000a1') ->> 'schema' = 'qorpera.company-machine-state/v2'
	and pg_temp.entry('12310000-0000-4000-8000-0000000000a1') ->> 'desiredState' = 'running'
	and (pg_temp.entry('12310000-0000-4000-8000-0000000000a1') ->> 'reserved')::boolean
	and (pg_temp.entry('12310000-0000-4000-8000-0000000000a2') -> 'binding' ->> 'cpus')::integer = 2,
	'the entries are the placements'' own, as before');

-- 4. Only the service role; this migration's marker and the earlier ones.
select pg_temp.check(not has_function_privilege('anon', 'public.qorpera_list_executor_machines(text,text)', 'execute')
	and not has_function_privilege('authenticated', 'public.qorpera_list_executor_machines(text,text)', 'execute')
	and has_function_privilege('service_role', 'public.qorpera_list_executor_machines(text,text)', 'execute'),
	'the list is the service role''s alone');
select pg_temp.check((select bool_and(position(marker in pg_get_functiondef('public.qorpera_list_executor_machines(text,text)'::regprocedure)) > 0)
	from unnest(array['20260930737000', '20260929730000', '(20260930055000)']) marker), 'the body names this migration and keeps the earlier ones');

-- Remove the fixture: the machine node and executor, then 648's company rows as 648 removes them.
set session_replication_role = replica;
do $$
declare v_table record;
begin
	for v_table in select c.table_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name = 'node_id' and c.data_type = 'uuid' loop
		execute format('delete from public.%I where node_id = $1', v_table.table_name) using '12310000-0000-4000-8000-000000000410'::uuid;
	end loop;
	delete from public.qorpera_runtime_nodes where id = '12310000-0000-4000-8000-000000000410';
	delete from public.qorpera_machine_executors where owner = 'mx-1231';
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
		or exists (select 1 from public.qorpera_company_machines where id in ('12310000-0000-4000-8000-0000000000a1',
			'12310000-0000-4000-8000-0000000000a2'))
		or exists (select 1 from public.qorpera_runtime_nodes where id = '12310000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_machine_executors where owner = 'mx-1231')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;

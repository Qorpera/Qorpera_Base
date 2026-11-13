-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930739000: a company has a time zone, taken once from a member's browser, and the executor's list of machines
-- names it for the desktop's clock. On 924's base (an owner, a contributor, a viewer, an admin and an outsider; Alice's
-- live run), with a second company of the outsider's and a machine node as 1231 makes it: a machine Alice's run started
-- and one the owner started for Carol (a machine no run started, 20260930730000). Covered:
-- 1. A company starts without a zone: the column is null, the team read says null to every member with its other keys
--    as before, and the executor's list says null for each machine.
-- 2. Who may hand one in: owners, admins and contributors; a viewer, an outsider and a call with no member are refused,
--    and nothing is taken.
-- 3. What is refused: no name, a name the database does not know (also in another case, or with spaces), and a name it
--    knows whose shape the machine would not accept. Nothing is taken.
-- 4. Taken once: the first name handed in is the company's; a later one, by anyone, changes nothing and is answered the
--    company's. The team read says it to every member. Another company is not touched and takes its own.
-- 5. The executor's list names the zone with each of the company's machines, whoever started it, and nothing else in
--    the entry moved.
-- 6. The column's own check, the grants and the markers.
-- Everything is rolled back at the end.

create function pg_temp.tz_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.tz_try(text) to authenticated, anon;
create function pg_temp.tz_user(p_who text) returns uuid language sql immutable as $$
	select case p_who when 'owner' then '92400000-0000-4000-8000-000000000001' when 'contributor' then
		'92400000-0000-4000-8000-000000000002' when 'viewer' then '92400000-0000-4000-8000-000000000003'
		when 'admin' then '92400000-0000-4000-8000-000000000004' else '92400000-0000-4000-8000-000000000005' end::uuid
$$;
-- A member call, as that member: 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.tz_as(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', pg_temp.tz_user(p_who));
	set local role authenticated;
	v := pg_temp.tz_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- The browser's zone, handed in for a company (the base's unless named).
create function pg_temp.tz_ensure(p_who text, p_zone text, p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns text language sql as $$
	select pg_temp.tz_as(p_who, format('select public.qorpera_ensure_company_time_zone(%L, %L)', p_profile, p_zone))
$$;
create function pg_temp.tz_answer(p_zone text, p_taken boolean) returns text language sql as $$
	select 'ok:' || jsonb_build_object('schema', 'qorpera.company-time-zone/v1', 'timeZone', p_zone, 'taken', p_taken)::text
$$;
-- The team read of a company (the base's unless named), as a member.
create function pg_temp.tz_team(p_who text, p_profile uuid default '92400000-0000-4000-8000-000000000010') returns jsonb
language sql as $$
	select substring(pg_temp.tz_as(p_who, format('select public.qorpera_profile_team_info(%L)', p_profile)) from '^ok:(.*)$')::jsonb
$$;
create function pg_temp.tz_zone(p_profile uuid default '92400000-0000-4000-8000-000000000010') returns text language sql as $$
	select time_zone from public.qorpera_profiles where id = p_profile
$$;

-- A second company, the outsider's own: a row and its owner are all the zone needs.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12330000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('12330000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000005', 'base-outsider@example.test', 'Outsider', 'owner');

-- The machine node and its executor, as 1231 makes them: the node, its inventory, and a fresh ready observation.
create function pg_temp.tz_observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12330000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12330000-0000-4000-8000-000000000410','machineIdSha256',repeat('1233',16),'observationId',extensions.gen_random_uuid(),
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
		'nodeId','12330000-0000-4000-8000-000000000410','machineIdSha256',repeat('1233',16),'label','machine-1233','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12330000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('1233',16),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.tz_observe();
	perform public.qorpera_enroll_runtime_node_provider('12330000-0000-4000-8000-000000000410',repeat('1233',16),'machine','machine-1233',
		repeat('f',64),8000,34359738368);
	perform public.qorpera_configure_machine_executor('mx-1233',repeat('1233',16),true,jsonb_build_object('providerId','machine-1233',
		'providerPolicySha256',repeat('f',64),'project','machines','imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),
		'storagePool','machines','network','machine-net'),322122547200);
end $$;

-- A machine Alice's leased run started (the row machine_start makes, as 1231 writes it), and one the owner starts for
-- Carol from the computer window (no run, no receipt). The node executor's own pass places both.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, wanted_at, updated_at)
values ('12330000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'm-1233-a',
	'Build the site', '92400000-0000-4000-8000-000000000030', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000001', 1, 1073741824, 10737418240, 'standard', 'task', 'running',
	clock_timestamp(), clock_timestamp());
select pg_temp.base_assert(pg_temp.tz_as('owner', $sql$select public.qorpera_member_start_agent_computer(
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000032')$sql$) like 'ok:%"state": "started"%',
	'the owner starts a computer for Carol');
do $$
begin
	for attempt in 1..12 loop
		perform pg_temp.tz_observe();
		exit when public.qorpera_admit_executor_machines('mx-1233', repeat('1233',16)) = '[]'::jsonb;
	end loop;
end $$;
-- The executor's entry of a machine, by the machine's name.
create function pg_temp.tz_entry(p_name text) returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1233', repeat('1233',16))) entry
	where entry ->> 'machineId' = (select id::text from public.qorpera_company_machines where name = p_name and removed_at is null)
$$;

-- 1. A company starts without a zone --------------------------------------------------------------------------------------
select pg_temp.base_assert(pg_temp.tz_zone() is null and pg_temp.tz_zone('12330000-0000-4000-8000-000000000010') is null,
	'1: a company has no zone until a member''s browser hands one in');
select pg_temp.base_assert((select bool_and(pg_temp.tz_team(who) ? 'time_zone' and pg_temp.tz_team(who) -> 'time_zone' = 'null'::jsonb)
	from unnest(array['owner', 'admin', 'contributor', 'viewer']) who), '1: the team read says null to every member');
select pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(pg_temp.tz_team('owner')) key)
	= array['capabilities', 'invitations', 'members', 'profile_id', 'role', 'time_zone'],
	'1: the team read has its keys and the zone: '
	|| (select string_agg(key, ',' order by key) from jsonb_object_keys(pg_temp.tz_team('owner')) key));
select pg_temp.base_assert(pg_temp.tz_team('owner') ->> 'role' = 'owner' and pg_temp.tz_team('viewer') ->> 'role' = 'viewer'
	and (pg_temp.tz_team('contributor') #>> '{capabilities,write}')::boolean and not (pg_temp.tz_team('viewer') #>> '{capabilities,write}')::boolean
	and jsonb_array_length(pg_temp.tz_team('viewer') -> 'members') = 4, '1: the team read is the member''s own, as before');
select pg_temp.base_assert(pg_temp.tz_as('outsider', $sql$select public.qorpera_profile_team_info('92400000-0000-4000-8000-000000000010')$sql$)
	= '42501:profile read access is required', '1: the team read still refuses an outsider');
select pg_temp.base_assert(pg_temp.tz_entry('m-1233-a') is not null and pg_temp.tz_entry('carol-desktop') is not null,
	'1: both machines are placed on the node and listed');
select pg_temp.base_assert(pg_temp.tz_entry('m-1233-a') ? 'timeZone' and pg_temp.tz_entry('m-1233-a') -> 'timeZone' = 'null'::jsonb
	and pg_temp.tz_entry('carol-desktop') ? 'timeZone' and pg_temp.tz_entry('carol-desktop') -> 'timeZone' = 'null'::jsonb,
	'1: the executor''s list says null while the company has no zone');

-- 2. Who may hand one in ---------------------------------------------------------------------------------------------------
select pg_temp.base_assert(pg_temp.tz_ensure('viewer', 'Europe/Copenhagen') = '42501:Company is unavailable', '2: a viewer: '
	|| pg_temp.tz_ensure('viewer', 'Europe/Copenhagen'));
select pg_temp.base_assert(pg_temp.tz_ensure('outsider', 'Europe/Copenhagen') = '42501:Company is unavailable', '2: an outsider');
-- A viewer and an outsider learn nothing about a name either: the refusal is the company's, whatever they hand in.
select pg_temp.base_assert(pg_temp.tz_ensure('viewer', 'Not/A_Zone') = '42501:Company is unavailable'
	and pg_temp.tz_ensure('outsider', null) = '42501:Company is unavailable', '2: who may is asked before the name');
select pg_temp.base_assert(pg_temp.tz_ensure('owner', 'Europe/Copenhagen', null) = '22023:Company time zone is invalid',
	'2: no company');
select pg_temp.base_assert(pg_temp.tz_ensure('owner', 'Europe/Copenhagen', '12330000-0000-4000-8000-0000000000ff')
	= '42501:Company is unavailable', '2: a company that is not there');
select pg_temp.base_assert(pg_temp.tz_ensure('owner', 'Europe/Copenhagen', '12330000-0000-4000-8000-000000000010')
	= '42501:Company is unavailable', '2: another company''s member');
-- A signed-in call with no member (no sub), and the roles that may not call it at all.
do $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated');
	set local role authenticated;
	v := pg_temp.tz_try($sql$select public.qorpera_ensure_company_time_zone('92400000-0000-4000-8000-000000000010', 'Europe/Copenhagen')$sql$);
	reset role;
	perform pg_temp.base_claims('anon');
	set local role anon;
	v := v || ' | ' || pg_temp.tz_try($sql$select public.qorpera_ensure_company_time_zone('92400000-0000-4000-8000-000000000010', 'Europe/Copenhagen')$sql$);
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v = '22023:Company time zone is invalid | 42501:permission denied for function qorpera_ensure_company_time_zone',
		'2: no member, and anon: ' || v);
end $$;
select pg_temp.base_assert(pg_temp.tz_zone() is null, '2: a refused call takes nothing');

-- 3. What is refused ---------------------------------------------------------------------------------------------------------
select pg_temp.base_assert((select bool_and(pg_temp.tz_ensure(who, zone) = '22023:Time zone is unknown')
	from unnest(array['owner', 'admin', 'contributor']) who,
		unnest(array[null, '', ' ', 'Not/A_Zone', 'europe/copenhagen', 'Europe/copenhagen', ' Europe/Copenhagen', 'Europe/Copenhagen ',
			E'Europe/Copenhagen\n', 'Europe/Copenhagen/', '/Europe/Copenhagen', 'Europe//Copenhagen', '../Europe/Copenhagen',
			'Europe/../Europe/Copenhagen', '+02:00', 'UTC0', 'auto', 'Europe/Copenhagen;id', repeat('A', 65)]) zone),
	'3: no name, an unknown name, another spelling of a known one, and a path are refused');
-- A name the database knows whose shape the machine would not take: three `/` (posix/America/Argentina/Buenos_Aires is in
-- pg_timezone_names on this image; were it not, the name is unknown and refused all the same).
select pg_temp.base_assert(pg_temp.tz_ensure('owner', 'posix/America/Argentina/Buenos_Aires') = '22023:Time zone is unknown',
	'3: a known name of another shape is refused');
select pg_temp.base_assert(pg_temp.tz_zone() is null and pg_temp.tz_team('owner') -> 'time_zone' = 'null'::jsonb,
	'3: a refused name takes nothing');

-- 4. Taken once --------------------------------------------------------------------------------------------------------------
select pg_temp.base_assert(pg_temp.tz_ensure('contributor', 'Europe/Copenhagen') = pg_temp.tz_answer('Europe/Copenhagen', true),
	'4: the first name handed in is taken: ' || coalesce(pg_temp.tz_zone(), 'none'));
select pg_temp.base_assert(pg_temp.tz_zone() = 'Europe/Copenhagen', '4: it is the company''s');
select pg_temp.base_assert(pg_temp.tz_ensure('owner', 'America/New_York') = pg_temp.tz_answer('Europe/Copenhagen', false)
	and pg_temp.tz_ensure('admin', 'Asia/Tokyo') = pg_temp.tz_answer('Europe/Copenhagen', false)
	and pg_temp.tz_ensure('contributor', 'Europe/Copenhagen') = pg_temp.tz_answer('Europe/Copenhagen', false)
	and pg_temp.tz_zone() = 'Europe/Copenhagen', '4: a later one changes nothing and is answered the company''s');
-- Still refused once the company has one: a name that is not one, and a member who may not act.
select pg_temp.base_assert(pg_temp.tz_ensure('owner', 'Not/A_Zone') = '22023:Time zone is unknown'
	and pg_temp.tz_ensure('viewer', 'Europe/Copenhagen') = '42501:Company is unavailable', '4: the refusals stand');
select pg_temp.base_assert((select bool_and(pg_temp.tz_team(who) ->> 'time_zone' = 'Europe/Copenhagen')
	from unnest(array['owner', 'admin', 'contributor', 'viewer']) who), '4: the team read says it to every member');
-- Another company is not touched, and takes its own: a name with two `/`, a `-` and a `_`, and one with a `+`.
select pg_temp.base_assert(pg_temp.tz_zone('12330000-0000-4000-8000-000000000010') is null
	and pg_temp.tz_team('outsider', '12330000-0000-4000-8000-000000000010') -> 'time_zone' = 'null'::jsonb,
	'4: another company has none still');
select pg_temp.base_assert(pg_temp.tz_ensure('outsider', 'America/Argentina/Buenos_Aires', '12330000-0000-4000-8000-000000000010')
	= pg_temp.tz_answer('America/Argentina/Buenos_Aires', true)
	and pg_temp.tz_ensure('outsider', 'Etc/GMT+2', '12330000-0000-4000-8000-000000000010')
	= pg_temp.tz_answer('America/Argentina/Buenos_Aires', false)
	and pg_temp.tz_zone() = 'Europe/Copenhagen', '4: another company takes its own');
-- Every name with one `+` or `-` in it that a browser may report is taken as it is (a savepoint each: nothing is kept).
do $$
declare v_zone text;
begin
	foreach v_zone in array array['UTC', 'Etc/GMT-14', 'Etc/GMT+12', 'America/Port-au-Prince', 'America/North_Dakota/New_Salem',
		'Asia/Kolkata', 'Pacific/Auckland'] loop
		begin
			update public.qorpera_profiles set time_zone = null where id = '12330000-0000-4000-8000-000000000010';
			perform pg_temp.base_assert(pg_temp.tz_ensure('outsider', v_zone, '12330000-0000-4000-8000-000000000010')
				= pg_temp.tz_answer(v_zone, true), '4: a browser''s name is taken: ' || v_zone);
			raise sqlstate 'P0F99';
		exception when sqlstate 'P0F99' then null;
		end;
	end loop;
end $$;

-- 5. The executor's list names it, whoever started the machine -----------------------------------------------------------------
select pg_temp.base_assert(pg_temp.tz_entry('m-1233-a') ->> 'timeZone' = 'Europe/Copenhagen'
	and pg_temp.tz_entry('carol-desktop') ->> 'timeZone' = 'Europe/Copenhagen',
	'5: a run''s machine and one no run started both name the company''s zone: '
	|| coalesce(pg_temp.tz_entry('m-1233-a') ->> 'timeZone', 'none') || ', ' || coalesce(pg_temp.tz_entry('carol-desktop') ->> 'timeZone', 'none'));
select pg_temp.base_assert(pg_temp.tz_entry('m-1233-a') #>> '{starter,staffAgentId}' = '92400000-0000-4000-8000-000000000030'
	and pg_temp.tz_entry('carol-desktop') #>> '{starter,staffAgentId}' = '92400000-0000-4000-8000-000000000032',
	'5: each entry still names its starter (20260930737000)');
select pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(pg_temp.tz_entry('m-1233-a')) key)
	= array['asleepSince','binding','bindingText','bootId','commands','createdAt','desiredState','instanceSha256','lastError','lastUsedAt',
		'lifetime','machineId','placementId','released','removeDue','removing','reserved','retired','runningAt','schema','sleepDue','starter',
		'stopDue','timeZone'],
	'5: the entry has the keys the executor reads, the starter and the zone: '
	|| (select string_agg(key, ',' order by key) from jsonb_object_keys(pg_temp.tz_entry('m-1233-a')) key));
select pg_temp.base_assert(pg_temp.tz_entry('m-1233-a') ->> 'schema' = 'qorpera.company-machine-state/v2'
	and pg_temp.tz_entry('m-1233-a') ->> 'desiredState' = 'running' and (pg_temp.tz_entry('m-1233-a') ->> 'reserved')::boolean
	and (pg_temp.tz_entry('carol-desktop') -> 'binding' ->> 'cpus')::integer = 2, '5: the entries are the placements'' own, as before');

-- 6. The column's own check, the grants and the markers ------------------------------------------------------------------------
select pg_temp.base_error($sql$update public.qorpera_profiles set time_zone = '../etc/passwd' where id = '92400000-0000-4000-8000-000000000010'$sql$,
	'23514');
select pg_temp.base_error($sql$update public.qorpera_profiles set time_zone = '' where id = '92400000-0000-4000-8000-000000000010'$sql$, '23514');
select pg_temp.base_error(format($sql$update public.qorpera_profiles set time_zone = %L where id = '92400000-0000-4000-8000-000000000010'$sql$,
	'a/b/c/d'), '23514');
select pg_temp.base_error(format($sql$update public.qorpera_profiles set time_zone = %L where id = '92400000-0000-4000-8000-000000000010'$sql$,
	repeat('A', 65)), '23514');
select pg_temp.base_assert(pg_temp.tz_zone() = 'Europe/Copenhagen', '6: the column keeps its shape');
select pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_ensure_company_time_zone(uuid,text)', 'execute')
	and has_function_privilege('authenticated', 'public.qorpera_ensure_company_time_zone(uuid,text)', 'execute')
	and not has_function_privilege('service_role', 'public.qorpera_ensure_company_time_zone(uuid,text)', 'execute')
	and (select prosecdef and array_to_string(proconfig, ',') like 'search_path=%' from pg_proc
		where oid = 'public.qorpera_ensure_company_time_zone(uuid,text)'::regprocedure),
	'6: the hand-in is the members'' alone, a definer with its own search path');
select pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_list_executor_machines(text,text)', 'execute')
	and not has_function_privilege('authenticated', 'public.qorpera_list_executor_machines(text,text)', 'execute')
	and has_function_privilege('service_role', 'public.qorpera_list_executor_machines(text,text)', 'execute'),
	'6: the executor''s list is the service role''s alone');
select pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_profile_team_info(uuid)', 'execute'),
	'6: the team read is the members'' still');
select pg_temp.base_assert((select bool_and(position(marker in pg_get_functiondef('public.qorpera_list_executor_machines(text,text)'::regprocedure)) > 0)
	from unnest(array['20260930739000', '20260930737000', '20260929730000', '(20260930055000)']) marker)
	and (select bool_and(position(marker in pg_get_functiondef('public.qorpera_profile_team_info(uuid)'::regprocedure)) > 0)
	from unnest(array['20260930739000', '20260930010000', '20260930330000']) marker)
	and position('20260930739000' in pg_get_functiondef('public.qorpera_ensure_company_time_zone(uuid,text)'::regprocedure)) > 0,
	'6: each body names this migration and keeps the earlier ones');

rollback;

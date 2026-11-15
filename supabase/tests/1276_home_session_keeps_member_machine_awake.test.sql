-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

select pg_temp.base_claims('service_role');

create function pg_temp.k6_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.k6_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.k6_placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
create function pg_temp.k6_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.k6_try(text) to authenticated;
create function pg_temp.k6_as_owner(p_sql text) returns jsonb language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v := pg_temp.k6_try(p_sql);
	reset role;
	perform pg_temp.base_claims('service_role');
	if v not like 'ok:%' then raise exception 'Home keeps a member machine awake: % answered %', p_sql, v; end if;
	return substring(v from 4)::jsonb;
end $$;
create function pg_temp.k6_observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12760000-0000-4000-8000-000000000410');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12760000-0000-4000-8000-000000000410','machineIdSha256',repeat('6',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end $$;
create function pg_temp.k6_place(p_name text) returns void language plpgsql as $$
begin
	perform pg_temp.k6_observe();
	for attempt in 1..12 loop
		exit when (pg_temp.k6_placement(p_name)).id is not null;
		exit when public.qorpera_admit_executor_machines('mx-1276', repeat('6', 64), 16) = '[]'::jsonb;
	end loop;
	if (pg_temp.k6_placement(p_name)).id is null then raise exception 'Home keeps a member machine awake: % was not placed', p_name; end if;
end $$;
create function pg_temp.k6_running(p_name text, p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_running((pg_temp.k6_placement(p_name)).id, (pg_temp.k6_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.k6_placement(p_name)).binding),
		(pg_temp.k6_placement(p_name)).machine_id_sha256, p_boot)
$$;
create function pg_temp.k6_quiet(p_name text) returns void language plpgsql as $$
declare v_id uuid := (pg_temp.k6_machine(p_name)).id; v_at timestamptz := clock_timestamp() - interval '30 minutes';
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machines set wanted_at = v_at where id = v_id;
	update public.qorpera_company_machine_placements set running_at = v_at where machine_id = v_id and running_at is not null;
	update public.qorpera_company_machine_screen_watches set last_look_at = v_at,
		confirmed_at = case when confirmed_at is not null then v_at end
	where machine_id = v_id;
	update public.qorpera_company_machine_desktop_pointers set begun_at = v_at where machine_id = v_id;
	update public.qorpera_company_machine_desktop_starts set begun_at = v_at where machine_id = v_id;
	set local session_replication_role = origin;
end $$;
create function pg_temp.k6_only(p_name text) returns boolean language sql as $$
	select public.qorpera_company_machine_member_only(pg_temp.k6_machine(p_name))
$$;
create function pg_temp.k6_due(p_name text) returns boolean language sql as $$
	select (entry ->> 'sleepDue')::boolean
	from jsonb_array_elements(public.qorpera_list_executor_machines('mx-1276', repeat('6', 64))) entry
	where entry ->> 'machineId' = (pg_temp.k6_machine(p_name)).id::text
$$;
create function pg_temp.k6_stop(p_name text) returns text language plpgsql as $$
declare v jsonb; v_said text;
begin
	begin
		v := public.qorpera_authorize_executor_machine((pg_temp.k6_placement(p_name)).id, (pg_temp.k6_placement(p_name)).owner,
			public.qorpera_company_machine_binding_text((pg_temp.k6_placement(p_name)).binding),
			(pg_temp.k6_placement(p_name)).machine_id_sha256, 'stop');
		v_said := case when v ->> 'state' = 'refused' then v ->> 'reason'
			else format('agreed:%s:%s:%s', (pg_temp.k6_machine(p_name)).desired_state, (pg_temp.k6_machine(p_name)).desired_by,
				(pg_temp.k6_placement(p_name)).stop_cause) end;
		raise exception using errcode = 'P1276', message = v_said;
	exception when sqlstate 'P1276' then return sqlerrm;
	end;
end $$;
create function pg_temp.k6_open(p_name text, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_authorize_home_session(pg_temp.k6_binding(),
		jsonb_build_object('machineId', (pg_temp.k6_machine(p_name)).id), p_session)
$$;
create function pg_temp.k6_sessions(p_name text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('id', home.id, 'run', home.run_id, 'closed', home.closed_at is not null)
		order by home.opened_at), '[]'::jsonb)
	from public.qorpera_company_home_sessions home where home.machine_id = (pg_temp.k6_machine(p_name)).id
$$;
create function pg_temp.k6_run_ended() returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = (select run.job_id from public.qorpera_execution_runs run where run.id = (pg_temp.k6_binding() ->> 'runId')::uuid);
	set local session_replication_role = origin;
end $$;

do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-1276','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12760000-0000-4000-8000-000000000410','machineIdSha256',repeat('6',64),'label','machine-1276','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12760000-0000-4000-8000-000000000410','host',jsonb_build_object('machineIdSha256',repeat('6',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.k6_observe();
	perform public.qorpera_enroll_runtime_node_provider('12760000-0000-4000-8000-000000000410', repeat('6',64), 'machine', 'machine-1276',
		repeat('f',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1276', repeat('6',64), true, v_policy, 322122547200);
	delete from public.qorpera_home_settings;
	insert into public.qorpera_home_settings(singleton, enabled) values (true, true);
	insert into public.qorpera_home_companies(profile_id) values ('92400000-0000-4000-8000-000000000010') on conflict do nothing;
	if to_regprocedure('public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid)') is null then
		create function public.qorpera_folder_home_shared(p_machine public.qorpera_company_machines, p_staff_agent_id uuid,
			p_member_user_id uuid, p_run_id uuid) returns boolean language sql as 'select true';
	end if;
end $$;

do $$
declare v jsonb;
begin
	v := pg_temp.k6_as_owner(format('select public.qorpera_member_start_agent_computer(%L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000032'));
	perform pg_temp.base_assert(v ->> 'state' = 'started' and v #>> '{machine,name}' = 'carol-desktop',
		'0: the owner made Carol''s computer: ' || v::text);
	perform pg_temp.k6_place('carol-desktop');
	perform pg_temp.base_assert(pg_temp.k6_running('carol-desktop', '12760000-0000-4000-8000-0000000000b1') ->> 'state' = 'running',
		'0: Carol''s computer came up');
	perform pg_temp.base_assert((pg_temp.k6_machine('carol-desktop')).desired_by = 'member'
		and (pg_temp.k6_machine('carol-desktop')).started_by_run_id is null, '0: it is awake for a member only');
	perform pg_temp.k6_quiet('carol-desktop');
	perform pg_temp.base_assert(pg_temp.k6_only('carol-desktop') and pg_temp.k6_due('carol-desktop')
		and pg_temp.k6_stop('carol-desktop') = 'agreed:stopped:kernel:slept',
		'1: with no home session 20260930759000 answers as it did: member-only, due, and the stop agrees');
end $$;

select set_config('qorpera_test.k6_first', extensions.gen_random_uuid()::text, false) \g /dev/null
do $$
declare v jsonb; v_session uuid := current_setting('qorpera_test.k6_first')::uuid;
begin
	v := pg_temp.k6_open('carol-desktop', v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized', '2: a going run opens its home on the machine: ' || v::text);
	perform pg_temp.k6_quiet('carol-desktop');
	perform pg_temp.base_assert(not pg_temp.k6_only('carol-desktop'),
		'2: an open home session of a going run makes the machine the agent''s, as a running command does');
	perform pg_temp.base_assert(pg_temp.k6_due('carol-desktop') is false,
		'2: so the executor''s list does not say it is due: ' || coalesce(pg_temp.k6_due('carol-desktop')::text, 'null'));
	perform pg_temp.base_assert(pg_temp.k6_stop('carol-desktop') is distinct from 'agreed:stopped:kernel:slept',
		'2: and the stop''s custody does not agree to put it to sleep: ' || pg_temp.k6_stop('carol-desktop'));
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.k6_sessions('carol-desktop')) = 1,
		'2: the session is one row, whatever channel of it is open: ' || pg_temp.k6_sessions('carol-desktop')::text);
end $$;

do $$
declare v_session uuid := current_setting('qorpera_test.k6_first')::uuid; v_last timestamptz;
begin
	v_last := (pg_temp.k6_machine('carol-desktop')).last_used_at;
	perform pg_temp.k6_run_ended();
	perform pg_temp.base_assert(pg_temp.k6_sessions('carol-desktop') #> '{0,closed}' = 'false'::jsonb,
		'3: a run that ended without closing its session leaves the row open');
	perform pg_temp.base_assert(pg_temp.k6_only('carol-desktop') and pg_temp.k6_due('carol-desktop')
		and pg_temp.k6_stop('carol-desktop') = 'agreed:stopped:kernel:slept',
		'3: a session whose run''s job is no longer queued or leased keeps nothing awake: due, and the stop agrees');
	raise exception using errcode = 'P1276', message = 'undo';
exception when sqlstate 'P1276' then null;
end $$;

do $$
declare v jsonb; v_session uuid := current_setting('qorpera_test.k6_first')::uuid; v_last timestamptz;
begin
	perform pg_temp.base_assert(not pg_temp.k6_only('carol-desktop'), '4: the run goes again, and the session is open');
	v_last := (pg_temp.k6_machine('carol-desktop')).last_used_at;
	v := public.qorpera_close_home_session(pg_temp.k6_binding(), v_session, 'ended');
	perform pg_temp.base_assert(v ->> 'state' = 'closed', '4: the run closes its session: ' || v::text);
	perform pg_temp.base_assert((pg_temp.k6_machine('carol-desktop')).last_used_at = v_last,
		'4: the close leaves the machine''s last use as it was');
	perform pg_temp.base_assert(pg_temp.k6_only('carol-desktop') and pg_temp.k6_due('carol-desktop')
		and pg_temp.k6_stop('carol-desktop') = 'agreed:stopped:kernel:slept',
		'4: with the session closed the machine is the member''s again: due at once, the member having left long ago');
end $$;

do $$
begin
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_machine_member_only(public.qorpera_company_machines)'::regprocedure),
			'qorpera_company_home_sessions') > 0
		and strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_machine_member_only(public.qorpera_company_machines)'::regprocedure),
			'20260930759000') > 0,
		'5: the rule reads the home sessions and keeps 20260930759000''s body');
	perform pg_temp.base_assert(not has_function_privilege('anon',
			'public.qorpera_company_machine_member_only(public.qorpera_company_machines)', 'execute')
		and not has_function_privilege('authenticated',
			'public.qorpera_company_machine_member_only(public.qorpera_company_machines)', 'execute')
		and not has_function_privilege('service_role',
			'public.qorpera_company_machine_member_only(public.qorpera_company_machines)', 'execute'),
		'5: the patched rule is still no API role''s');
end $$;

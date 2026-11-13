-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930752000 (agent-box slice 1): a run's own exec-server session on its home machine. On 924's base (Alice's live
-- conversation run) with 1241's machine node and executor:
-- 1. The switch is off: with no rows, with the platform switch alone, and with the company named alone, a run has no
--    home. With both on it still has none until a machine of its own agent is running (section 2), because an
--    environment the model cannot reach would only refuse it.
-- 2. With a machine of its own running, the run has a home and it is that machine. A session is authorized on it and
--    its row is the run's: one row, the boot and placement of the
--    machine it names, the run, its agent and the member it works for; the same session id again answers the same row,
--    and no second row is written. A stopped machine is refused MACHINE_NOT_RUNNING in words the model can act on.
-- 3. A session belongs to one run and one boot: another run's binding cannot take that session id (42501), a run has
--    one open a boot (HOME_SESSION_OPEN), and after a restart on the same disk the session of the boot before is
--    refused HOME_SESSION_ENDED while the run opens its own on the new boot.
-- 4. A closed session stays closed: the close answers it, a second close answers the same, and the authority refuses
--    it afterwards. With the switch off again, even an open session's authority is refused.
-- 5. The channel is the runtime's and the executor's: no API role may call any of the four functions, the switch's two
--    tables are revoked from every role, and the session's columns are there (the folder window of slice 3 included).

select pg_temp.base_claims('service_role');

create function pg_temp.h1_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.h1_run() returns uuid language sql as $$ select (pg_temp.h1_binding() ->> 'runId')::uuid $$;
create function pg_temp.h1_company() returns uuid language sql as $$
	select (public.qorpera_describe_native_tool_authority(pg_temp.h1_binding()) #>> '{identity,companyId}')::uuid
$$;
create function pg_temp.h1_requester() returns uuid language sql as $$
	select (public.qorpera_describe_native_tool_authority(pg_temp.h1_binding()) #>> '{identity,requesterUserId}')::uuid
$$;
create function pg_temp.h1_machine(p_name text) returns public.qorpera_company_machines language sql as $$
	select machine from public.qorpera_company_machines machine where machine.name = p_name and machine.removed_at is null
$$;
create function pg_temp.h1_placement(p_name text) returns public.qorpera_company_machine_placements language sql as $$
	select placement from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where machine.name = p_name and machine.removed_at is null and placement.retired_at is null and placement.removed_at is null
$$;
-- 1241's node observation: the node reports exactly the machines it holds.
create function pg_temp.h1_observe() returns void language plpgsql as $$
declare v_context jsonb := public.qorpera_runtime_node_inventory_context('12460000-0000-4000-8000-000000000460');
begin
	perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','12460000-0000-4000-8000-000000000460','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
			coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
				'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
				'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,'category','managed','reason',null))
				from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
end
$$;
-- 628's machine_start, as 1241 makes it: the exact envelope Alice's run hashes, authorize, the receipt, begin, complete.
create function pg_temp.h1_start(p_name text) returns jsonb language plpgsql as $$
declare v_receipt uuid := extensions.gen_random_uuid(); v_envelope text; v_sha text; v_result jsonb;
begin
	v_envelope := jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(pg_temp.h1_binding()) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1',
			'logicalOperationKey','home-' || p_name,
			'arguments',jsonb_build_object('name',p_name,'purpose','A home for ' || p_name,'cpus',2,'memoryGiB',4,
				'diskGiB',40,'lifetime','task'),
			'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text;
	v_sha := encode(extensions.digest(convert_to(v_envelope, 'UTF8'), 'sha256'), 'hex');
	perform public.qorpera_native_machine_start(pg_temp.h1_binding(), v_envelope, 'authorize');
	perform public.qorpera_begin_native_tool_operation(pg_temp.h1_binding(), v_receipt, 'machine_start:home-' || p_name, v_sha,
		repeat('9', 64), false);
	v_result := public.qorpera_native_machine_start(pg_temp.h1_binding(), v_envelope, 'begin', v_receipt, repeat('9', 64));
	perform public.qorpera_complete_native_tool_operation(pg_temp.h1_binding(), v_receipt, v_sha,
		jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',v_sha,
			'content',jsonb_build_object('kind','json','value',v_result)));
	return v_result;
end
$$;
-- The executor's pass, its custody and the guest's mark: the machine runs (1241's b1_up).
create function pg_temp.h1_up(p_name text, p_boot uuid) returns jsonb language plpgsql as $$
begin
	perform pg_temp.h1_observe();
	for attempt in 1..12 loop
		exit when (pg_temp.h1_placement(p_name)).id is not null;
		exit when public.qorpera_admit_executor_machines('mx-1246', repeat('c', 64), 16) = '[]'::jsonb;
	end loop;
	perform public.qorpera_authorize_executor_machine((pg_temp.h1_placement(p_name)).id, (pg_temp.h1_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.h1_placement(p_name)).binding),
		(pg_temp.h1_placement(p_name)).machine_id_sha256, 'run');
	return public.qorpera_mark_company_machine_running((pg_temp.h1_placement(p_name)).id, (pg_temp.h1_placement(p_name)).owner,
		public.qorpera_company_machine_binding_text((pg_temp.h1_placement(p_name)).binding),
		(pg_temp.h1_placement(p_name)).machine_id_sha256, p_boot);
end
$$;
-- Whether this run has a home now, and which machine it is.
create function pg_temp.h1_home() returns jsonb language sql as $$
	select public.qorpera_company_home_available(pg_temp.h1_binding())
$$;
create function pg_temp.h1_has_home() returns boolean language sql as $$
	select (pg_temp.h1_home() -> 'available') = 'true'::jsonb
$$;
create function pg_temp.h1_switch(p_platform boolean, p_company boolean) returns void language plpgsql as $$
begin
	delete from public.qorpera_home_settings;
	delete from public.qorpera_home_companies where profile_id = pg_temp.h1_company();
	if p_platform then insert into public.qorpera_home_settings(singleton, enabled) values (true, true); end if;
	if p_company then insert into public.qorpera_home_companies(profile_id) values (pg_temp.h1_company()); end if;
end
$$;
create function pg_temp.h1_authorize(p_name text, p_session uuid, p_binding jsonb default null) returns jsonb language sql as $$
	select public.qorpera_authorize_home_session(coalesce(p_binding, pg_temp.h1_binding()),
		jsonb_build_object('machineId', (pg_temp.h1_machine(p_name)).id), p_session)
$$;
create function pg_temp.h1_sessions(p_session uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('machine', machine.name, 'placement', s.placement_id, 'boot', s.boot_id,
		'run', s.run_id, 'agent', s.staff_agent_id, 'member', s.requested_by_user_id, 'window', s.folder_window_id,
		'closed', s.closed_at is not null, 'why', s.close_reason) order by s.opened_at), '[]'::jsonb)
	from public.qorpera_company_home_sessions s join public.qorpera_company_machines machine on machine.id = s.machine_id
	where s.id = p_session
$$;
-- A refusal's words, or the SQLSTATE of a raise.
create function pg_temp.h1_try(p_name text, p_session uuid, p_binding jsonb default null) returns text language plpgsql as $$
declare v jsonb;
begin
	v := pg_temp.h1_authorize(p_name, p_session, p_binding);
	return coalesce(v ->> 'reason', v ->> 'state');
exception when others then return sqlstate; end
$$;

-- 1241's node and executor, under this test's own ids.
do $$
declare v_policy jsonb := jsonb_build_object('providerId','machine-1246','providerPolicySha256',repeat('f',64),'project','machines',
	'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0');
begin
	perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
		'nodeId','12460000-0000-4000-8000-000000000460','machineIdSha256',repeat('c',64),'label','machine-h','cpuMillis',16000,
		'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
		'standardMemoryBytes',4294967296,'enabled',true),0);
	perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
		'nodeId','12460000-0000-4000-8000-000000000460','host',jsonb_build_object('machineIdSha256',repeat('c',64),
		'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),'serverName','lxd',
		'serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
	perform pg_temp.h1_observe();
	perform public.qorpera_enroll_runtime_node_provider('12460000-0000-4000-8000-000000000460', repeat('c',64), 'machine', 'machine-1246',
		repeat('f',64), 8000, 34359738368);
	perform public.qorpera_configure_machine_executor('mx-1246', repeat('c',64), true, v_policy, 322122547200);
end $$;

-- 1. The switch is off ------------------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(not pg_temp.h1_has_home(),
		'1: with no rows at all a run has no home');
	perform pg_temp.h1_switch(true, false);
	perform pg_temp.base_assert(not pg_temp.h1_has_home(),
		'1: the platform switch alone is not enough');
	perform pg_temp.h1_switch(false, true);
	perform pg_temp.base_assert(not pg_temp.h1_has_home(),
		'1: the company named alone is not enough');
	perform pg_temp.h1_switch(true, true);
	-- Both on, and still no home: this agent has no machine running, and an environment it cannot reach would only
	-- refuse the model.
	perform pg_temp.base_assert(not pg_temp.h1_has_home(),
		'1: with both on and no machine of this agent there is still no home: ' || pg_temp.h1_home()::text);
	perform pg_temp.base_assert(public.qorpera_company_home_allowed(pg_temp.h1_company()), '1: the company is allowed');
	perform pg_temp.base_assert(not public.qorpera_company_home_allowed(extensions.gen_random_uuid()),
		'1: another company is not');
end $$;

-- 2. A session on a running machine ----------------------------------------------------------------------------------
select set_config('qorpera_test.h1_session', extensions.gen_random_uuid()::text, false) \g /dev/null
select set_config('qorpera_test.h1_boot', extensions.gen_random_uuid()::text, false) \g /dev/null
select pg_temp.h1_start('home-a') \g /dev/null
do $$
declare v jsonb; v_session uuid := current_setting('qorpera_test.h1_session')::uuid; v_rows jsonb;
begin
	-- Before the machine runs: the agent hears that it is not running, not a refusal it cannot read, and the machine
	-- is not offered as a home while it is still starting (review round 1, F12).
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', v_session) = 'MACHINE_NOT_RUNNING',
		'2: a machine that is not running is refused in words: ' || pg_temp.h1_try('home-a', v_session));
	perform pg_temp.base_assert(not pg_temp.h1_has_home(),
		'2: a machine that has not reached running is no home yet: ' || pg_temp.h1_home()::text);
	perform pg_temp.base_assert(pg_temp.h1_sessions(v_session) = '[]'::jsonb, '2: and no row is written');
	perform pg_temp.h1_up('home-a', current_setting('qorpera_test.h1_boot')::uuid);
	perform pg_temp.base_assert(pg_temp.h1_has_home() and pg_temp.h1_home() ->> 'machine' = 'home-a'
		and pg_temp.h1_home() ->> 'machineId' = (pg_temp.h1_machine('home-a')).id::text,
		'2: with the switch on and its own machine running, the run has a home, and it is that machine: '
			|| pg_temp.h1_home()::text);
	v := pg_temp.h1_authorize('home-a', v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v ->> 'sessionId' = v_session::text
		and v ->> 'machine' = 'home-a' and v ->> 'runId' = pg_temp.h1_run()::text
		and v ->> 'bootId' = current_setting('qorpera_test.h1_boot') and v ->> 'executorOwner' = 'mx-1246'
		and v ->> 'providerId' = 'machine-1246' and v #>> '{identity,companyId}' = pg_temp.h1_company()::text,
		'2: the session is authorized with its machine, boot and executor: ' || v::text);
	v_rows := pg_temp.h1_sessions(v_session);
	perform pg_temp.base_assert(jsonb_array_length(v_rows) = 1
		and v_rows #>> '{0,machine}' = 'home-a' and v_rows #>> '{0,run}' = pg_temp.h1_run()::text
		and v_rows #>> '{0,boot}' = current_setting('qorpera_test.h1_boot')
		and v_rows #>> '{0,placement}' = (pg_temp.h1_placement('home-a')).id::text
		and v_rows #>> '{0,agent}' = '92400000-0000-4000-8000-000000000030'
		and v_rows #>> '{0,member}' = pg_temp.h1_requester()::text
		and v_rows #> '{0,window}' = 'null'::jsonb and v_rows #> '{0,closed}' = 'false'::jsonb,
		'2: one row, the run''s, with no window of its own yet: ' || v_rows::text);
	-- The same session id again: the same row, no second one.
	v := pg_temp.h1_authorize('home-a', v_session);
	perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v ->> 'sessionId' = v_session::text
		and pg_temp.h1_sessions(v_session) = v_rows, '2: asked again it is the same session');
end $$;

-- 3. One session, one run, one boot --------------------------------------------------------------------------------
do $$
declare v_session uuid := current_setting('qorpera_test.h1_session')::uuid; v_other jsonb;
	v_second uuid := extensions.gen_random_uuid(); v_third uuid := extensions.gen_random_uuid();
begin
	-- Another run of the same company: its binding is refused this session id outright.
	v_other := pg_temp.h1_binding() || jsonb_build_object('runId', extensions.gen_random_uuid());
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', v_session, v_other) in ('42501','22023'),
		'3: another run cannot take this session: ' || pg_temp.h1_try('home-a', v_session, v_other));
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.h1_sessions(v_session)) = 1, '3: still one row');
	-- One channel at a time on one boot: a second session id while this run's is open is refused in words, not as a
	-- row clash.
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', v_second) = 'HOME_SESSION_OPEN',
		'3: a run has one open session a boot: ' || pg_temp.h1_try('home-a', v_second));
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.h1_sessions(v_second)) = 0, '3: and no row for the second');
	-- The machine is restarted on the same disk: a new boot of the same placement. The session of the boot before is
	-- refused in words, because its home went with that boot (review round 1, F4).
	perform pg_temp.h1_up('home-a', extensions.gen_random_uuid());
	perform pg_temp.base_assert((pg_temp.h1_placement('home-a')).boot_id::text
		is distinct from current_setting('qorpera_test.h1_boot'), '3: the machine rebooted on the same disk');
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', v_session) = 'HOME_SESSION_ENDED',
		'3: a session of the boot before is refused in words: ' || pg_temp.h1_try('home-a', v_session));
	-- The same run opens a session of its own on the new boot, with the old one still open on the old boot.
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', v_third) = 'authorized',
		'3: the run opens a session on the new boot: ' || pg_temp.h1_try('home-a', v_third));
	perform pg_temp.base_assert(pg_temp.h1_sessions(v_third) #>> '{0,boot}' = (pg_temp.h1_placement('home-a')).boot_id::text
		and pg_temp.h1_sessions(v_session) #>> '{0,boot}' = current_setting('qorpera_test.h1_boot'),
		'3: each session keeps its own boot');
end $$;

-- 4. Closing ------------------------------------------------------------------------------------------------------------
do $$
declare v_session uuid := current_setting('qorpera_test.h1_session')::uuid; v jsonb;
begin
	v := public.qorpera_close_home_session(pg_temp.h1_binding(), v_session, 'ended');
	perform pg_temp.base_assert(v ->> 'state' = 'closed' and v ->> 'closeReason' = 'ended'
		and pg_temp.h1_sessions(v_session) #> '{0,closed}' = 'true'::jsonb, '4: the run closes its session: ' || v::text);
	perform pg_temp.base_assert(public.qorpera_close_home_session(pg_temp.h1_binding(), v_session, 'stopped') ->> 'closeReason' = 'ended',
		'4: a second close answers the first');
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', v_session) = 'HOME_SESSION_ENDED',
		'4: a closed session is refused afterwards');
	-- The switch off again: no new session, whatever the machine does.
	perform pg_temp.h1_switch(false, false);
	perform pg_temp.base_assert(pg_temp.h1_try('home-a', extensions.gen_random_uuid()) = '42501',
		'4: with the switch off the authority refuses');
	perform pg_temp.base_assert(not pg_temp.h1_has_home(), '4: and no run has a home');
	perform pg_temp.h1_switch(true, true);
end $$;

-- 5. Whose these are ---------------------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_company_home_allowed(uuid)','public.qorpera_company_home_available(jsonb)',
		'public.qorpera_authorize_home_session(jsonb, jsonb, uuid)','public.qorpera_close_home_session(jsonb, uuid, text)'] loop
		foreach v_role in array array['anon','authenticated'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'execute'),
				'5: ' || v_role || ' cannot call ' || v_function);
		end loop;
	end loop;
	perform pg_temp.base_assert(not has_function_privilege('service_role', 'public.qorpera_company_home_allowed(uuid)', 'execute'),
		'5: the company''s own gate is internal');
	foreach v_function in array array['public.qorpera_company_home_available(jsonb)',
		'public.qorpera_authorize_home_session(jsonb, jsonb, uuid)','public.qorpera_close_home_session(jsonb, uuid, text)'] loop
		perform pg_temp.base_assert(has_function_privilege('service_role', v_function, 'execute'),
			'5: the runtime and the executor call ' || v_function);
	end loop;
	foreach v_role in array array['anon','authenticated','service_role'] loop
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_home_settings', 'select')
			and not has_table_privilege(v_role, 'public.qorpera_home_companies', 'select')
			and not has_table_privilege(v_role, 'public.qorpera_company_home_sessions', 'select'),
			'5: ' || v_role || ' reads none of the switch''s or the sessions'' rows');
	end loop;
	perform pg_temp.base_assert((select count(*) from information_schema.columns where table_schema = 'public'
		and table_name = 'qorpera_company_home_sessions'
		and column_name in ('id','machine_id','placement_id','boot_id','run_id','staff_agent_id','requested_by_user_id',
			'folder_window_id','opened_at','closed_at','close_reason')) = 11,
		'5: the session''s columns are there, slice 3''s folder window included');
end $$;

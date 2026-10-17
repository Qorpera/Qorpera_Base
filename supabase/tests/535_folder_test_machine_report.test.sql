-- @fixture 628_runtime_company_machines.test.sql until "-- 7. A start the guest does not know yet"
-- The test machine's report (20260930511000; F3 step 6, slice 6e-2a: deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md
-- "The report"). SQL keeps why a machine lost a command for its folder (folder_lost_reason), so the executor's receipt
-- and the run's continuation can say it. The retirement (20260930424000) gives the machine's open commands its cause
-- (moved_<cause>) before they end lost. The executor's restart of a boot whose folder can never be proven again marks
-- that boot's open commands first, under its custody (qorpera_mark_company_machine_folder_restart, restart_<why>), and
-- they end lost when the next boot is recorded. The authority for a command (qorpera_authorize_machine_command) returns
-- the cause as folderLost only for a command that ended lost, also on its refusal of one, and
-- qorpera_company_machine_folder_lost_text gives the agent's words: contracts' CLOUD_MACHINE_FOLDER_LOST
-- (packages/contracts/src/cloud-machine.ts) word for word. 519 tests the continuation. 628's
-- build-a runs its first boot, where the suite command (...502) failed; the retirement and custody helpers are 516's.

-- 516's (510's): the statement fails with this SQLSTATE, message and detail (no detail unless one is named).
create function pg_temp.refused(p_sql text, p_state text, p_message text default null, p_detail text default null)
returns void language plpgsql as $$
declare v_detail text;
begin
	begin execute p_sql;
	exception when others then
		get stacked diagnostics v_detail = pg_exception_detail;
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) and nullif(v_detail, '') is not distinct from p_detail then
			return; end if;
		raise exception 'Expected SQLSTATE % (%, detail %), got %: % (detail %)', p_state, p_message, p_detail, sqlstate, sqlerrm, v_detail;
	end;
	raise exception 'Expected SQLSTATE % (%), but it succeeded: %', p_state, p_message, p_sql;
end $$;
-- 516's (632's): a fixture change in replica mode (CHECK constraints still apply).
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;
-- 516's: the platform's open for build-a's placement and boot.
create function pg_temp.open_at(p_placement uuid) returns jsonb language sql as $$
	select public.qorpera_folder_view_open((pg_temp.mc_machine('build-a')).environment_id, '{"kind":"platform"}', 'test_machine',
		jsonb_build_object('companyMachineId', p.machine_id, 'placementId', p.id, 'bootId', p.boot_id))
	from public.qorpera_company_machine_placements p where p.id = p_placement
$$;
create function pg_temp.open_build_a() returns jsonb language sql as $$
	select pg_temp.open_at((pg_temp.mc_placement('build-a')).id)
$$;
-- 516's: revokes every path grant of build-a's starting agent, so it no longer reads the root (callers undo it).
create function pg_temp.revoke_agent() returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
		where principal_kind = ''staff_agent'' and principal_id = %L and revoked_at is null',
		(pg_temp.mc_machine('build-a')).started_by_staff_agent_id))
$$;
-- 516's: the executor's retirement of a placement, for a boot.
create function pg_temp.retire_at(p_placement public.qorpera_company_machine_placements, p_boot uuid, p_reason text)
returns jsonb language sql as $$
	select public.qorpera_retire_company_machine(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_boot, p_reason)
$$;
-- 516's: the same for build-a's current placement and boot.
create function pg_temp.retire(p_reason text) returns jsonb language sql as $$
	select pg_temp.retire_at(pg_temp.mc_placement('build-a'), (pg_temp.mc_placement('build-a')).boot_id, p_reason)
$$;
-- The executor's restart mark for a placement and a boot, under the custody 516 uses for the retirement.
create function pg_temp.mark_at(p_placement public.qorpera_company_machine_placements, p_boot uuid, p_reason text)
returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_folder_restart(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_boot, p_reason)
$$;
-- The same for build-a's current placement and boot.
create function pg_temp.mark(p_reason text) returns jsonb language sql as $$
	select pg_temp.mark_at(pg_temp.mc_placement('build-a'), (pg_temp.mc_placement('build-a')).boot_id, p_reason)
$$;
-- A command's row.
create function pg_temp.command(p_id uuid) returns public.qorpera_company_machine_commands language sql as $$
	select c from public.qorpera_company_machine_commands c where c.id = p_id
$$;
-- 628 §6's read or cancel of a command on build-a: the authority the run's gateway asks for.
create function pg_temp.authority(p_command uuid, p_action text) returns jsonb language sql as $$
	select public.qorpera_authorize_machine_command(pg_temp.mc_binding(),
		jsonb_build_object('machineId', (pg_temp.mc_machine('build-a')).id), p_action, p_command)
$$;

-- 0. The marker is in the new functions and in every one the migration patches. The new functions are security
--    definers with an empty search path and no API owner; only the executor (service_role) may mark a restart, and no
--    API role may run the words or the continuation's report. A cause is one of six. Applying the migration again is
--    refused: its guard (copied here word for word) raises now that the column exists.
do $$
declare c_mark constant text := 'public.qorpera_mark_company_machine_folder_restart(uuid,text,text,text,uuid,text)';
	c_text constant text := 'public.qorpera_company_machine_folder_lost_text(text)';
	c_report constant text := 'public.qorpera_folder_test_machine_event_report(uuid,uuid,uuid,jsonb)';
	f text; r name; p pg_proc%rowtype;
begin
	foreach f in array array[c_mark, c_text, c_report, 'public.qorpera_retire_company_machine(uuid,text,text,text,uuid,text)',
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)',
		'public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)'] loop
		perform pg_temp.base_assert(strpos(pg_get_functiondef(f::regprocedure), '20260930511000') > 0, f || ' carries 20260930511000');
	end loop;
	foreach f in array array[c_mark, c_text, c_report] loop
		select * into p from pg_proc where oid = f::regprocedure;
		perform pg_temp.base_assert(p.prosecdef and p.proconfig is not distinct from array['search_path=""']
			and pg_get_userbyid(p.proowner) not in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker'),
			f || ' is a security definer with an empty search path and no API owner');
		foreach r in array array['public', 'anon', 'authenticated', 'qorpera_secret_broker']::name[] loop
			perform pg_temp.base_assert(not has_function_privilege(r, f, 'EXECUTE'), r || ' may not run ' || f);
		end loop;
	end loop;
	perform pg_temp.base_assert(has_function_privilege('service_role', c_mark, 'EXECUTE'), 'The executor marks a restart');
	perform pg_temp.base_assert(not has_function_privilege('service_role', c_text, 'EXECUTE')
		and not has_function_privilege('service_role', c_report, 'EXECUTE'), 'The words and the report are internal');
	perform pg_temp.base_error(format('select pg_temp.fx(%L)', format('update public.qorpera_company_machine_commands
		set folder_lost_reason = ''restart'' where id = %L', '62800000-0000-4000-8000-000000000502')), '23514');
	perform pg_temp.refused($sql$do $g$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_company_machine_commands'::regclass
		and attname = 'folder_lost_reason' and not attisdropped) then
		raise exception 'The test machine''s report (20260930511000) is already applied'; end if;
end $g$ $sql$, 'P0001', 'The test machine''s report (20260930511000) is already applied');
end $$;

-- 1. The retirement, for each of its three causes (reached as 516 §2, §4 and §5 reach them): the open command ends
--    lost with the cause (moved_<cause>), and the suite command, which ended before, keeps its state and gets none. While
--    the machine moves, a read is refused before any cause (MACHINE_NOT_RUNNING). Once the new disk runs (516 §2's
--    admission), the command's placement is no longer the machine's: a read is refused as a command that ended
--    (MACHINE_COMMAND_ENDED), and the refusal names the cause; the suite command's names none. Each case is undone after.
do $$
declare c_open constant uuid := '53500000-0000-4000-8000-000000000011'; c_suite constant uuid := '62800000-0000-4000-8000-000000000502';
	v_case text; v_retired jsonb; v_read jsonb; v_old public.qorpera_company_machine_placements;
begin
	foreach v_case in array array['unchecked', 'unreadable', 'starter'] loop
		begin
			v_old := pg_temp.mc_placement('build-a');
			if v_case = 'unchecked' then
				-- A start by a caller without the root read marks a disk that never had a view.
				perform pg_temp.revoke_agent();
				perform pg_temp.base_assert(pg_temp.mc_run(c_open, 'rp-moved', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state'
					= 'authorized' and (pg_temp.mc_placement('build-a')).folder_unchecked_at is not null, 'The start marks the disk');
				v_retired := pg_temp.retire('new-disk');
			elsif v_case = 'unreadable' then
				-- A disk with a view whose reads are unreadable.
				perform pg_temp.open_build_a();
				perform pg_temp.base_assert(pg_temp.mc_run(c_open, 'rp-moved', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state'
					= 'authorized', 'A command starts on the disk with a view');
				v_retired := pg_temp.retire('unreadable');
			else
				-- A disk that had a view, once its starter's agent no longer reads the root.
				perform pg_temp.open_build_a();
				perform pg_temp.base_assert(pg_temp.mc_run(c_open, 'rp-moved', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state'
					= 'authorized', 'A command starts on the disk with a view');
				perform pg_temp.revoke_agent();
				v_retired := pg_temp.retire('new-disk');
			end if;
			perform pg_temp.base_assert(v_retired ->> 'state' = 'retired' and v_retired ->> 'reason' = v_case,
				'Retired for ' || v_case || ': ' || v_retired::text);
			perform pg_temp.base_assert((pg_temp.command(c_open)).state = 'lost' and (pg_temp.command(c_open)).ended_at is not null
				and (pg_temp.command(c_open)).folder_lost_reason = 'moved_' || v_case,
				'The open command ended lost with its cause: ' || to_jsonb(pg_temp.command(c_open))::text);
			perform pg_temp.base_assert((pg_temp.command(c_suite)).state = 'failed' and (pg_temp.command(c_suite)).folder_lost_reason is null,
				'The command that ended before keeps its state and gets no cause');
			v_read := pg_temp.authority(c_open, 'read');
			perform pg_temp.base_assert(v_read ->> 'state' = 'refused' and v_read ->> 'reason' = 'MACHINE_NOT_RUNNING'
				and not v_read ? 'folderLost', 'A read of the moved command is refused before any cause: ' || v_read::text);
			perform pg_temp.base_assert(pg_temp.mc_custody_at(v_old, 'stop') ->> 'intent' = 'stop', 'The old disk''s stop is authorized');
			perform pg_temp.mc_observe_a();
			perform pg_temp.base_assert(public.qorpera_admit_executor_machines('mx-a', repeat('c', 64))
					= jsonb_build_array((pg_temp.mc_machine('build-a')).id)
				and pg_temp.mc_running('build-a', extensions.gen_random_uuid()) #>> '{machine,state}' = 'running'
				and (pg_temp.mc_placement('build-a')).id <> v_old.id, 'The machine runs on a new disk');
			v_read := pg_temp.authority(c_open, 'read');
			perform pg_temp.base_assert(v_read ->> 'state' = 'refused' and v_read ->> 'reason' = 'MACHINE_COMMAND_ENDED'
				and v_read ->> 'commandState' = 'lost' and v_read ->> 'folderLost' = 'moved_' || v_case
				and pg_temp.authority(c_open, 'cancel') ->> 'folderLost' = 'moved_' || v_case,
				'The moved command''s refusal names the cause: ' || v_read::text);
			v_read := pg_temp.authority(c_suite, 'read');
			perform pg_temp.base_assert(v_read ->> 'state' = 'refused' and v_read ->> 'reason' = 'MACHINE_COMMAND_ENDED'
				and v_read -> 'folderLost' = 'null'::jsonb, 'The suite command''s refusal names none: ' || v_read::text);
			raise exception 'Undo' using errcode = 'QTF80';
		exception when sqlstate 'QTF80' then null;
		end;
	end loop;
end $$;

-- 2. The executor's restart mark, under its custody, for the placement's current boot: each open command of the
--    placement gets the cause (restart_<why>), a command that ended keeps none, and the next boot ends them lost with it.
--    A second mark with another cause replaces the first (the last mark wins). Another boot answers "stale" and changes
--    nothing. A cause of the three and a boot are required (22023, checked before the boot); the custody refuses another
--    owner, another binding text and a caller who is not the service role (undone after).
do $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.mc_placement('build-a');
	c_one constant uuid := '53500000-0000-4000-8000-000000000021'; c_two constant uuid := '53500000-0000-4000-8000-000000000022';
	c_suite constant uuid := '62800000-0000-4000-8000-000000000502'; v jsonb; v_boot uuid := extensions.gen_random_uuid();
begin
	begin
		perform pg_temp.base_assert(pg_temp.mc_run(c_one, 'rp-mark-1', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state' = 'authorized'
			and pg_temp.mc_run(c_two, 'rp-mark-2', repeat('2', 64), 'build-a', 'npm run lint', false) ->> 'state' = 'authorized',
			'Two commands run');
		v := pg_temp.mark('unproven');
		perform pg_temp.base_assert(v = '{"state":"marked","commands":2}'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason = 'restart_unproven' and (pg_temp.command(c_one)).ended_at is null
			and (pg_temp.command(c_two)).folder_lost_reason = 'restart_unproven' and (pg_temp.command(c_two)).ended_at is null
			and (pg_temp.command(c_suite)).folder_lost_reason is null and (pg_temp.command(c_suite)).state = 'failed',
			'The boot''s open commands get the cause; they still run: ' || v::text);
		v := pg_temp.mark('view_gone');
		perform pg_temp.base_assert(v = '{"state":"marked","commands":2}'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason = 'restart_view_gone'
			and (pg_temp.command(c_two)).folder_lost_reason = 'restart_view_gone',
			'A second mark with another cause replaces the first: ' || v::text);
		perform pg_temp.base_assert(pg_temp.mark_at(v_placement, extensions.gen_random_uuid(), 'unproven') = '{"state":"stale"}'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason = 'restart_view_gone', 'Another boot is stale and changes nothing');
		perform pg_temp.base_error($sql$select pg_temp.mark('moved')$sql$, '22023', 'Machine folder restart invalid');
		perform pg_temp.base_error($sql$select pg_temp.mark('restart_unproven')$sql$, '22023', 'Machine folder restart invalid');
		perform pg_temp.base_error($sql$select pg_temp.mark(null)$sql$, '22023', 'Machine folder restart invalid');
		perform pg_temp.base_error($sql$select pg_temp.mark_at(pg_temp.mc_placement('build-a'), null, 'unproven')$sql$, '22023',
			'Machine folder restart invalid');
		perform pg_temp.base_error($sql$select pg_temp.mark_at(pg_temp.mc_placement('build-a'), extensions.gen_random_uuid(), 'gone')$sql$,
			'22023', 'Machine folder restart invalid');
		perform pg_temp.base_error(format($sql$select public.qorpera_mark_company_machine_folder_restart(%L, 'mx-a', %L, repeat('c', 64),
			%L, 'unproven')$sql$, v_placement.id, (v_placement.binding || '{"network":"drift"}')::text, v_placement.boot_id), '42501',
			'Machine custody differs');
		perform pg_temp.base_error(format($sql$select public.qorpera_mark_company_machine_folder_restart(%L, 'mx-other', %L,
			repeat('c', 64), %L, 'unproven')$sql$, v_placement.id, public.qorpera_company_machine_binding_text(v_placement.binding),
			v_placement.boot_id), '42501', 'Machine custody differs');
		perform pg_temp.base_claims('anon');
		perform pg_temp.base_error($sql$select pg_temp.mark('unproven')$sql$, '42501', 'Machine custody required');
		perform pg_temp.base_claims('authenticated');
		perform pg_temp.base_error($sql$select pg_temp.mark('unproven')$sql$, '42501', 'Machine custody required');
		perform pg_temp.base_claims('service_role');
		perform pg_temp.base_assert((pg_temp.command(c_one)).folder_lost_reason = 'restart_view_gone'
			and (pg_temp.command(c_two)).folder_lost_reason = 'restart_view_gone', 'A refused mark changes nothing');
		-- The executor restarts the guest: the next boot ends them lost with their cause, and a mark then finds none open.
		perform pg_temp.base_assert(pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running', 'The next boot runs');
		perform pg_temp.base_assert((pg_temp.command(c_one)).state = 'lost' and (pg_temp.command(c_one)).folder_lost_reason = 'restart_view_gone'
			and (pg_temp.command(c_two)).state = 'lost' and (pg_temp.command(c_two)).folder_lost_reason = 'restart_view_gone',
			'The next boot ends them lost, with the cause');
		v := pg_temp.mark('unproven');
		perform pg_temp.base_assert(v = '{"state":"marked","commands":0}'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason = 'restart_view_gone' and (pg_temp.command(c_suite)).folder_lost_reason is null,
			'A mark leaves ended commands alone: ' || v::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- A placement retired, or removed, answers "stale"; its open command gets no cause.
	begin
		perform pg_temp.base_assert(pg_temp.mc_run(c_one, 'rp-mark-1', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state' = 'authorized',
			'A command runs');
		perform pg_temp.fx(format('update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = %L',
			v_placement.id));
		perform pg_temp.base_assert(pg_temp.mark_at(v_placement, v_placement.boot_id, 'unproven') = '{"state":"stale"}'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason is null, 'A retired placement is stale');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.base_assert(pg_temp.mc_run(c_one, 'rp-mark-1', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state' = 'authorized',
			'A command runs');
		perform pg_temp.fx(format('update public.qorpera_company_machine_placements set removing_at = clock_timestamp(),
			removed_at = clock_timestamp() where id = %L', v_placement.id));
		perform pg_temp.base_assert(pg_temp.mark_at(v_placement, v_placement.boot_id, 'unproven') = '{"state":"stale"}'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason is null, 'A removed placement is stale');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- The API roles anon and authenticated may not call the mark at all.
do $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.mc_placement('build-a'); v_sql text; r name;
	v_state text; v_message text;
begin
	v_sql := format('select public.qorpera_mark_company_machine_folder_restart(%L, %L, %L, %L, %L, %L)', v_placement.id,
		v_placement.owner, public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256,
		v_placement.boot_id, 'unproven');
	foreach r in array array['anon', 'authenticated']::name[] loop
		v_state := null;
		v_message := null;
		begin
			execute format('set local role %I', r);
			execute v_sql;
		exception when others then
			get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		end;
		reset role;
		perform pg_temp.base_assert(v_state = '42501' and v_message like 'permission denied for function %',
			r || ' may not mark a restart: ' || coalesce(v_state || ' ' || v_message, 'it succeeded'));
	end loop;
end $$;

-- 3. The authority for a command (628 §6's read and cancel) names the cause (folderLost) only for a command that ended
--    lost: not while it runs, nor for an end the guest saw after the mark, though both have the cause. A start of a lost
--    command sent again is refused (MACHINE_COMMAND_ENDED), and the refusal names the cause too. A command lost without a
--    cause, and one that failed, have none (undone after).
do $$
declare c_one constant uuid := '53500000-0000-4000-8000-000000000031'; c_two constant uuid := '53500000-0000-4000-8000-000000000032';
	c_three constant uuid := '53500000-0000-4000-8000-000000000033'; c_suite constant uuid := '62800000-0000-4000-8000-000000000502';
	v_boot uuid := extensions.gen_random_uuid(); v jsonb;
begin
	begin
		perform pg_temp.base_assert(pg_temp.mc_run(c_one, 'rp-auth-1', repeat('1', 64), 'build-a', 'npm test', true) ->> 'state' = 'authorized'
			and pg_temp.mc_run(c_two, 'rp-auth-2', repeat('2', 64), 'build-a', 'npm run lint', true) ->> 'state' = 'authorized'
			and pg_temp.mark('view_closed') = '{"state":"marked","commands":2}'::jsonb
			and pg_temp.mc_run(c_three, 'rp-auth-3', repeat('3', 64), 'build-a', 'npm run build', true) ->> 'state' = 'authorized',
			'Two commands are marked; a third starts after the mark');
		v := pg_temp.authority(c_one, 'read');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v -> 'folderLost' = 'null'::jsonb
			and (pg_temp.command(c_one)).folder_lost_reason = 'restart_view_closed',
			'A running command has no folderLost, though it has the cause: ' || v::text);
		perform pg_temp.base_assert(pg_temp.mc_record('build-a', current_setting('qorpera_test.boot_a')::uuid,
			jsonb_build_array(jsonb_build_object('commandId', c_one, 'state', 'succeeded', 'exitCode', 0)), true) ->> 'state' = 'recorded'
			and (pg_temp.command(c_one)).state = 'succeeded' and (pg_temp.command(c_one)).folder_lost_reason = 'restart_view_closed',
			'The guest saw it succeed after the mark: it keeps its own state');
		v := pg_temp.authority(c_one, 'read');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v -> 'folderLost' = 'null'::jsonb,
			'A command that succeeded has no folderLost: ' || v::text);
		perform pg_temp.base_assert(pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running'
			and (pg_temp.command(c_two)).state = 'lost' and (pg_temp.command(c_three)).state = 'lost'
			and (pg_temp.command(c_three)).folder_lost_reason is null, 'The next boot ends the open commands lost');
		v := pg_temp.authority(c_two, 'read');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v ->> 'folderLost' = 'restart_view_closed'
			and pg_temp.authority(c_two, 'cancel') ->> 'folderLost' = 'restart_view_closed',
			'A command lost with a cause names it: ' || v::text);
		v := public.qorpera_authorize_machine_command(pg_temp.mc_binding(), jsonb_build_object('machineId', (pg_temp.mc_machine('build-a')).id),
			'start', c_two, repeat('2', 64), '{"commandHead":"npm run lint","notify":true}');
		perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'MACHINE_COMMAND_ENDED' and v ->> 'commandState' = 'lost'
			and v ->> 'folderLost' = 'restart_view_closed', 'Its start sent again is refused, and the refusal names it: ' || v::text);
		v := pg_temp.authority(c_three, 'read');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v -> 'folderLost' = 'null'::jsonb,
			'A command lost without a cause has no folderLost: ' || v::text);
		v := public.qorpera_authorize_machine_command(pg_temp.mc_binding(), jsonb_build_object('machineId', (pg_temp.mc_machine('build-a')).id),
			'start', c_three, repeat('3', 64), '{"commandHead":"npm run build","notify":true}');
		perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'MACHINE_COMMAND_ENDED' and v -> 'folderLost' = 'null'::jsonb,
			'Its start sent again is refused without one: ' || v::text);
		v := pg_temp.authority(c_suite, 'read');
		perform pg_temp.base_assert(v ->> 'state' = 'authorized' and v -> 'folderLost' = 'null'::jsonb,
			'A command that failed has no folderLost: ' || v::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 4. The words for each cause are contracts' CLOUD_MACHINE_FOLDER_LOST (packages/contracts/src/cloud-machine.ts), word
--    for word; any other cause has none.
do $$
declare v_reason text; v_text text;
begin
	for v_reason, v_text in select * from (values
		('restart_unproven', 'the executor restarted the machine because it could not prove what the machine read in /company'),
		('restart_view_closed', 'the executor restarted the machine because its /company view was closed'),
		('restart_view_gone', 'the executor restarted the machine because the company folder service lost its /company view'),
		('moved_unchecked', 'the machine moved to a new disk because a command ran on the old one before /company was checked'),
		('moved_starter',
			'the machine moved to a new disk because the agent or member who started it no longer reads the whole company folder'),
		('moved_unreadable', 'the machine moved to a new disk because something it read in /company is no longer readable')) t loop
		perform pg_temp.base_assert(public.qorpera_company_machine_folder_lost_text(v_reason) is not distinct from v_text,
			v_reason || ': ' || coalesce(public.qorpera_company_machine_folder_lost_text(v_reason), 'null'));
	end loop;
	perform pg_temp.base_assert(public.qorpera_company_machine_folder_lost_text('moved') is null
		and public.qorpera_company_machine_folder_lost_text('unproven') is null
		and public.qorpera_company_machine_folder_lost_text(null) is null, 'Any other cause has no words');
end $$;

rollback;

-- @fixture 628_runtime_company_machines.test.sql until "-- 7. A start the guest does not know yet"
-- Machine commands on a test machine's disk (20260930420000; F3 step 6, slice 6a: RUNTIME-FOLDER-TEST-MACHINES.md):
-- a disk that has had a test machine view may hold what its views read, so once it has had one, every command there
-- (start, read, cancel) needs the run's agent and member to read the folder's root, on every later boot too. A disk that
-- never had one keeps today's access; its first command marks it, and no view opens there after. 628's build-a ran its
-- first command in §6 (Alice's run, for 924's owner), through the real native receipts; a cleared mark stands in for a
-- new disk. The view is the platform's real open on build-a's current placement and boot.

-- 510's: the statement fails with this SQLSTATE, message and detail (no detail unless one is named).
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
-- 632's: a fixture change in replica mode.
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;
-- The platform's open for build-a's current placement and boot.
create function pg_temp.open_build_a() returns jsonb language sql as $$
	select public.qorpera_folder_view_open((pg_temp.mc_machine('build-a')).environment_id, '{"kind":"platform"}', 'test_machine',
		jsonb_build_object('companyMachineId', (pg_temp.mc_machine('build-a')).id, 'placementId', (pg_temp.mc_placement('build-a')).id,
			'bootId', (pg_temp.mc_placement('build-a')).boot_id))
$$;
-- Whether build-a's starting agent and member read the root now.
create function pg_temp.reads_root() returns boolean language sql as $$
	select public.qorpera_folder_reads_root(m.environment_id, m.profile_id, m.started_by_staff_agent_id, m.requested_by_user_id)
	from public.qorpera_company_machines m where m.id = (pg_temp.mc_machine('build-a')).id
$$;
-- Revokes every path grant of build-a's starting agent, so it no longer reads the root (callers undo it).
create function pg_temp.revoke_agent() returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
		where principal_kind = ''staff_agent'' and principal_id = %L and revoked_at is null',
		(pg_temp.mc_machine('build-a')).started_by_staff_agent_id))
$$;
-- A command's read or cancel, as the run asks for it.
create function pg_temp.command(p_intent text, p_command uuid) returns jsonb language sql as $$
	select public.qorpera_authorize_machine_command(pg_temp.mc_binding(), jsonb_build_object('machineId', (pg_temp.mc_machine('build-a')).id),
		p_intent, p_command)
$$;

-- 1. build-a's disk never had a view. Its commands keep today's access without the root (undone after). Its first
--    command marked it, so the platform's open there tells the executor to move the machine to a new disk.
do $$
declare v_auth jsonb;
begin
	perform pg_temp.base_assert(pg_temp.reads_root() and (pg_temp.mc_placement('build-a')).folder_unchecked_at is not null
		and not exists (select 1 from public.qorpera_folder_views where placement_id = (pg_temp.mc_placement('build-a')).id),
		'Alice and her member read the root; the disk ran a command without the check and never had a view');
	begin
		perform pg_temp.revoke_agent();
		perform pg_temp.base_assert(not pg_temp.reads_root(), 'Without its grants the agent does not read the root');
		v_auth := pg_temp.mc_run('51100000-0000-4000-8000-000000000001', 'tm-unviewed', repeat('1', 64), 'build-a', 'npm test', false);
		perform pg_temp.base_assert(v_auth ->> 'state' = 'authorized'
			and pg_temp.command('read', '51100000-0000-4000-8000-000000000001') ->> 'executorOwner' = 'mx-a'
			and pg_temp.command('cancel', '51100000-0000-4000-8000-000000000001') ->> 'executorOwner' = 'mx-a',
			'A disk that never had a view keeps today''s access: ' || v_auth::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.refused('select pg_temp.open_build_a()', '42501', 'Test machine disk was used without the folder check',
		'qorpera.test-machine/new-disk');
end $$;

-- 2. On a clean disk (the cleared mark), the platform opens a view. With the root, a command there is started, read
--    and cancelled, and the disk stays unmarked. Without it (undone after), each is refused: with the view open, once it
--    is closed, and on the disk's next boot. With the root again, the next boot runs commands.
do $$
declare v_view jsonb; v_boot uuid := extensions.gen_random_uuid(); v_case text; v_intent text;
begin
	perform pg_temp.fx(format('update public.qorpera_company_machine_placements set folder_unchecked_at = null where id = %L',
		(pg_temp.mc_placement('build-a')).id));
	v_view := pg_temp.open_build_a();
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views where id = (v_view ->> 'viewId')::uuid
		and kind = 'test_machine' and state = 'open' and placement_id = (pg_temp.mc_placement('build-a')).id),
		'The view is open on build-a''s disk: ' || v_view::text);
	perform pg_temp.base_assert(pg_temp.mc_run('51100000-0000-4000-8000-000000000002', 'tm-viewed', repeat('2', 64), 'build-a',
			'npm test', false) ->> 'state' = 'authorized'
		and pg_temp.command('read', '51100000-0000-4000-8000-000000000002') ->> 'executorOwner' = 'mx-a'
		and pg_temp.command('cancel', '51100000-0000-4000-8000-000000000002') ->> 'executorOwner' = 'mx-a'
		and (pg_temp.mc_placement('build-a')).folder_unchecked_at is null,
		'With the root, commands run on a disk that has a view, and it stays unmarked');
	foreach v_case in array array['open', 'closed', 'next boot'] loop
		begin
			if v_case <> 'open' then perform public.qorpera_folder_view_close((v_view ->> 'viewId')::uuid, v_view ->> 'pass'); end if;
			if v_case = 'next boot' then
				perform pg_temp.base_assert(pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running', 'The next boot runs');
			end if;
			perform pg_temp.revoke_agent();
			perform pg_temp.refused(format('select pg_temp.mc_run(%L, %L, %L, %L, %L, false)', '51100000-0000-4000-8000-000000000003',
				'tm-refused', repeat('3', 64), 'build-a', 'npm test'), '42501', 'Machine needs the company-wide view');
			foreach v_intent in array array['read', 'cancel'] loop
				perform pg_temp.refused(format('select pg_temp.command(%L, %L)', v_intent, '51100000-0000-4000-8000-000000000002'),
					'42501', 'Machine needs the company-wide view');
			end loop;
			raise exception 'Undo' using errcode = 'QTF80';
		exception when sqlstate 'QTF80' then null;
		end;
	end loop;
	perform pg_temp.base_assert(pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running'
		and pg_temp.mc_run('51100000-0000-4000-8000-000000000004', 'tm-next-boot', repeat('4', 64), 'build-a', 'npm test',
			false) ->> 'bootId' = v_boot::text
		and (pg_temp.mc_placement('build-a')).folder_unchecked_at is null,
		'With the root, the next boot runs commands');
end $$;

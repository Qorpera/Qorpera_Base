-- @fixture 628_runtime_company_machines.test.sql until "-- 7. A start the guest does not know yet"
-- Test machine retirement (20260930424000; F3 step 6, slice 6d, part 2: RUNTIME-FOLDER-TEST-MACHINES.md "Views",
-- "Access" and "Reads" rule 5): the machine executor moves a test machine to a new disk when the open refuses its disk
-- ("new-disk") or its view's reads are unreadable ("unreadable"). The retirement checks the cause again under custody,
-- for the placement's current boot, keeps a disk that may still get a view, and ends the machine's open commands lost;
-- admission then starts the machine on a new disk. And the authorize/open race: a start before the boot's open marks
-- the disk only when its caller does not read the root. 628's build-a ran its commands as Alice, who reads the root,
-- so its disk is unmarked and never had a view. Views are the platform's real open on build-a's placement and boot.

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
-- The platform's open for a placement of build-a and its boot.
create function pg_temp.open_at(p_placement uuid) returns jsonb language sql as $$
	select public.qorpera_folder_view_open((pg_temp.mc_machine('build-a')).environment_id, '{"kind":"platform"}', 'test_machine',
		jsonb_build_object('companyMachineId', p.machine_id, 'placementId', p.id, 'bootId', p.boot_id))
	from public.qorpera_company_machine_placements p where p.id = p_placement
$$;
create function pg_temp.open_build_a() returns jsonb language sql as $$
	select pg_temp.open_at((pg_temp.mc_placement('build-a')).id)
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
-- Gives back the grants revoked since then.
create function pg_temp.restore_agent(p_since timestamptz) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_path_grants set revoked_at = null
		where principal_kind = ''staff_agent'' and principal_id = %L and revoked_at >= %L',
		(pg_temp.mc_machine('build-a')).started_by_staff_agent_id, p_since))
$$;
-- The executor's retirement of a placement, for a boot.
create function pg_temp.retire_at(p_placement public.qorpera_company_machine_placements, p_boot uuid, p_reason text)
returns jsonb language sql as $$
	select public.qorpera_retire_company_machine(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_boot, p_reason)
$$;
-- The same for build-a's current placement and boot.
create function pg_temp.retire(p_reason text) returns jsonb language sql as $$
	select pg_temp.retire_at(pg_temp.mc_placement('build-a'), (pg_temp.mc_placement('build-a')).boot_id, p_reason)
$$;
create function pg_temp.running_at(p_placement public.qorpera_company_machine_placements, p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_mark_company_machine_running(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_boot)
$$;
create function pg_temp.record_at(p_placement public.qorpera_company_machine_placements, p_boot uuid) returns jsonb language sql as $$
	select public.qorpera_record_company_machine_commands(p_placement.id, p_placement.owner,
		public.qorpera_company_machine_binding_text(p_placement.binding), p_placement.machine_id_sha256, p_boot, '[]', false)
$$;

-- 0. The marker is in the new function and the patched authorization. Only the executor (service_role) retires; a
--    retirement cause is one of three, and only on a retired placement.
do $$
declare v_retire constant text := 'public.qorpera_retire_company_machine(uuid,text,text,text,uuid,text)'; r name;
begin
	perform pg_temp.base_assert(strpos(pg_get_functiondef(v_retire::regprocedure), '20260930424000') > 0
		and strpos(pg_get_functiondef('public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure),
			'20260930424000: unless the caller reads the root') > 0, 'The marker is in both functions');
	foreach r in array array['anon','authenticated','qorpera_secret_broker']::name[] loop
		perform pg_temp.base_assert(not has_function_privilege(r, v_retire, 'EXECUTE'), r || ' may not retire a machine');
	end loop;
	perform pg_temp.base_assert(has_function_privilege('service_role', v_retire, 'EXECUTE'), 'The executor retires');
	perform pg_temp.base_error(format('select pg_temp.fx(%L)', format('update public.qorpera_company_machine_placements
		set folder_retire_reason = ''unchecked'' where id = %L', (pg_temp.mc_placement('build-a')).id)), '23514');
	perform pg_temp.base_error(format('select pg_temp.fx(%L)', format('update public.qorpera_company_machine_placements
		set folder_retire_reason = ''moved'', retired_at = clock_timestamp() where id = %L', (pg_temp.mc_placement('build-a')).id)), '23514');
end $$;

-- 1. The race: the executor records a new boot, and before it opens the boot's view a run woken by the machine starts a
--    command there. Its caller reads the root, so the disk stays unmarked, and the open makes the view (undone after).
do $$
declare v_boot uuid := extensions.gen_random_uuid(); v_view jsonb;
begin
	perform pg_temp.base_assert(pg_temp.reads_root() and (pg_temp.mc_placement('build-a')).id is not null
		and (pg_temp.mc_placement('build-a')).folder_unchecked_at is null
		and not exists (select 1 from public.qorpera_folder_views where placement_id = (pg_temp.mc_placement('build-a')).id),
		'Alice and her member read the root; their commands left the disk unmarked, and it never had a view');
	begin
		perform pg_temp.base_assert(pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running', 'The new boot runs');
		perform pg_temp.base_assert(pg_temp.mc_run('51600000-0000-4000-8000-000000000001', 'tm-race', repeat('1', 64), 'build-a',
			'npm test', true) ->> 'bootId' = v_boot::text, 'A run woken by the machine starts a command');
		perform pg_temp.base_assert((pg_temp.mc_placement('build-a')).folder_unchecked_at is null,
			'A start before the boot''s open, by a caller who reads the root, leaves the disk unmarked');
		v_view := pg_temp.open_build_a();
		perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views where id = (v_view ->> 'viewId')::uuid
				and kind = 'test_machine' and state = 'open' and placement_id = (pg_temp.mc_placement('build-a')).id and boot_id = v_boot)
			and exists (select 1 from public.qorpera_company_machine_commands where id = '51600000-0000-4000-8000-000000000001'
				and ended_at is null),
			'The open makes the boot''s view, and the command runs on: ' || v_view::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 2. A caller without the root read starts a command before the boot's view: the disk is marked, the open refuses it,
--    and the executor retires it. Its open command ends lost and its run is told; the old placement is stopped and
--    deleted as any retired one, and runs nothing more; admission starts the machine on a new disk, where the open makes
--    a view (undone after).
do $$
declare v_old public.qorpera_company_machine_placements; v_new public.qorpera_company_machine_placements; v_first jsonb;
	v_entry jsonb; v_boot uuid := extensions.gen_random_uuid(); v_since timestamptz; v_view jsonb;
begin
	begin
		v_since := clock_timestamp();
		perform pg_temp.revoke_agent();
		perform pg_temp.base_assert(not pg_temp.reads_root(), 'Without its grants the agent does not read the root');
		perform pg_temp.base_assert(pg_temp.mc_run('51600000-0000-4000-8000-000000000002', 'tm-unchecked', repeat('2', 64), 'build-a',
			'npm test', true) ->> 'state' = 'authorized', 'A disk that never had a view keeps today''s access');
		perform pg_temp.base_assert((pg_temp.mc_placement('build-a')).folder_unchecked_at is not null,
			'A start by a caller without the root read marks the disk');
		perform pg_temp.refused('select pg_temp.open_build_a()', '42501', 'Test machine disk was used without the folder check',
			'qorpera.test-machine/new-disk');
		v_old := pg_temp.mc_placement('build-a');
		v_first := pg_temp.retire_at(v_old, current_setting('qorpera_test.boot_a')::uuid, 'new-disk');
		perform pg_temp.base_assert(v_first ->> 'state' = 'retired' and v_first ->> 'reason' = 'unchecked'
			and v_first ->> 'machineId' = v_old.machine_id::text and v_first ->> 'placementId' = v_old.id::text
			and exists (select 1 from public.qorpera_company_machine_placements where id = v_old.id and removed_at is null
				and retired_at = (v_first ->> 'retiredAt')::timestamptz and folder_retire_reason = 'unchecked'),
			'Retired for its unchecked use: ' || v_first::text);
		perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_machine_commands
				where id = '51600000-0000-4000-8000-000000000002' and state = 'lost' and end_reason = 'lost' and ended_at is not null)
			and (select count(*) from public.qorpera_company_machine_events where kind = 'command'
				and command_id = '51600000-0000-4000-8000-000000000002' and delivery = 'waiting') = 1,
			'Its open command ended lost, and its run will hear');
		v_entry := pg_temp.mc_listed_at('mx-a', repeat('c', 64), v_old.id);
		perform pg_temp.base_assert((v_entry ->> 'retired')::boolean and v_entry ->> 'desiredState' = 'deleted'
			and v_entry -> 'commands' = '[]'::jsonb and (v_entry ->> 'stopDue')::boolean and (v_entry ->> 'removeDue')::boolean
			and (pg_temp.mc_placement('build-a')).id is null and (pg_temp.mc_machine('build-a')).desired_state = 'running'
			and public.qorpera_company_machine_state(pg_temp.mc_machine('build-a')) = 'waiting',
			'The executor stops and deletes the old disk, and the machine still wants to run: ' || v_entry::text);
		perform pg_temp.base_assert(pg_temp.retire_at(v_old, current_setting('qorpera_test.boot_a')::uuid, 'new-disk') = v_first
			and pg_temp.retire_at(v_old, extensions.gen_random_uuid(), 'unreadable') = v_first
			and pg_temp.running_at(v_old, extensions.gen_random_uuid()) ->> 'state' = 'kept'
			and pg_temp.record_at(v_old, current_setting('qorpera_test.boot_a')::uuid) ->> 'state' = 'stale'
			and pg_temp.mc_run('51600000-0000-4000-8000-000000000003', 'tm-retired', repeat('3', 64), 'build-a', 'npm test', false)
				->> 'reason' = 'MACHINE_NOT_RUNNING',
			'A repeat answers the same; the old disk gets no new boot and no command');
		perform pg_temp.refused(format('select pg_temp.open_at(%L)', v_old.id), '42501', 'Folder view machine is not current');
		perform pg_temp.base_assert(pg_temp.mc_custody_at(v_old, 'stop') ->> 'intent' = 'stop', 'Its stop is authorized');
		perform pg_temp.base_assert((select stop_authorized_at from public.qorpera_company_machine_placements where id = v_old.id)
			is not null, 'Its stop is recorded');
		perform pg_temp.mc_observe_a();
		perform pg_temp.base_assert(public.qorpera_admit_executor_machines('mx-a', repeat('c', 64))
			= jsonb_build_array((pg_temp.mc_machine('build-a')).id), 'Admission starts the machine on a new disk');
		v_new := pg_temp.mc_placement('build-a');
		perform pg_temp.base_assert(v_new.id <> v_old.id and v_new.folder_unchecked_at is null and v_new.folder_retire_reason is null
			and not exists (select 1 from public.qorpera_folder_views where placement_id = v_new.id)
			and pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running',
			'The new disk is clean, and it runs');
		perform pg_temp.restore_agent(v_since);
		perform pg_temp.base_assert(pg_temp.reads_root(), 'With its grants back the agent reads the root');
		v_view := pg_temp.open_build_a();
		perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_views
				where id = (v_view ->> 'viewId')::uuid and placement_id = v_new.id and boot_id = v_boot),
			'The open makes the new disk''s view: ' || v_view::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 3. A disk that may still get a view is kept: unmarked, without a view whose reads are unreadable.
do $$
begin
	perform pg_temp.base_assert(pg_temp.retire('new-disk') = '{"state":"kept","reason":"FOLDER_DISK_USABLE"}'::jsonb
		and pg_temp.retire('unreadable') = '{"state":"kept","reason":"FOLDER_DISK_USABLE"}'::jsonb
		and (pg_temp.mc_placement('build-a')).id is not null and (pg_temp.mc_placement('build-a')).folder_retire_reason is null,
		'An unmarked disk that never had a view is kept');
end $$;

-- 4. A disk with a view is kept while the starter reads the root, until its view's reads are unreadable: then it is
--    retired, its open command ends lost, and the view stays valid for the final publish (undone after).
do $$
declare v_view jsonb; v_retired jsonb;
begin
	begin
		v_view := pg_temp.open_build_a();
		perform pg_temp.base_assert(pg_temp.mc_run('51600000-0000-4000-8000-000000000004', 'tm-viewed', repeat('4', 64), 'build-a',
			'npm test', true) ->> 'state' = 'authorized', 'With the root, a command starts on a disk that has a view');
		perform pg_temp.base_assert(pg_temp.retire('new-disk') = '{"state":"kept","reason":"FOLDER_DISK_USABLE"}'::jsonb,
			'With the root, a disk that has a view is kept');
		v_retired := pg_temp.retire('unreadable');
		perform pg_temp.base_assert(v_retired ->> 'state' = 'retired' and v_retired ->> 'reason' = 'unreadable'
			and exists (select 1 from public.qorpera_company_machine_commands where id = '51600000-0000-4000-8000-000000000004'
				and state = 'lost' and ended_at is not null)
			and exists (select 1 from public.qorpera_folder_views v where v.id = (v_view ->> 'viewId')::uuid and v.state = 'open'
				and public.qorpera_folder_view_valid(v))
			and (pg_temp.mc_placement('build-a')).id is null,
			'Unreadable reads retire it; its view stays valid for the final publish: ' || v_retired::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 5. The starter: once the starter's agent no longer reads the root, the open refuses the next boot of a disk that had
--    a view, and the executor retires it for that; a refusal it saw on an earlier boot is stale (undone after).
do $$
declare v_view jsonb; v_boot uuid := extensions.gen_random_uuid(); v_retired jsonb;
begin
	begin
		v_view := pg_temp.open_build_a();
		perform public.qorpera_folder_view_close((v_view ->> 'viewId')::uuid, v_view ->> 'pass');
		perform pg_temp.base_assert(pg_temp.mc_running('build-a', v_boot) #>> '{machine,state}' = 'running', 'The next boot runs');
		perform pg_temp.base_assert(pg_temp.retire('new-disk') = '{"state":"kept","reason":"FOLDER_DISK_USABLE"}'::jsonb,
			'The next boot of a disk that had a view is kept while the starter reads the root');
		perform pg_temp.revoke_agent();
		perform pg_temp.refused('select pg_temp.open_build_a()', '42501', 'Folder view needs the company-wide view',
			'qorpera.test-machine/new-disk');
		perform pg_temp.base_assert(pg_temp.retire_at(pg_temp.mc_placement('build-a'), current_setting('qorpera_test.boot_a')::uuid,
			'new-disk') = '{"state":"stale"}'::jsonb, 'A refusal seen on an earlier boot is stale');
		v_retired := pg_temp.retire('new-disk');
		perform pg_temp.base_assert(v_retired ->> 'state' = 'retired' and v_retired ->> 'reason' = 'starter'
			and (select folder_retire_reason from public.qorpera_company_machine_placements
				where id = (v_retired ->> 'placementId')::uuid) = 'starter',
			'The starter no longer reads the root: retired: ' || v_retired::text);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 6. Only the placement's current boot counts: another boot, a placement retired otherwise, or one removed answers
--    "stale" (undone after).
do $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.mc_placement('build-a');
begin
	perform pg_temp.base_assert(pg_temp.retire_at(v_placement, extensions.gen_random_uuid(), 'new-disk') = '{"state":"stale"}'::jsonb,
		'Another boot is stale');
	begin
		perform pg_temp.fx(format('update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp(),
			retired_at = clock_timestamp() where id = %L', v_placement.id));
		perform pg_temp.base_assert(pg_temp.retire_at(v_placement, v_placement.boot_id, 'new-disk') = '{"state":"stale"}'::jsonb
			and (select folder_retire_reason from public.qorpera_company_machine_placements where id = v_placement.id) is null,
			'A placement retired otherwise is stale and gets no cause');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.fx(format('update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
			where id = %L', v_placement.id));
		perform pg_temp.base_assert(pg_temp.retire_at(v_placement, v_placement.boot_id, 'new-disk') ->> 'reason' = 'unchecked',
			'A marked disk is retired');
		perform pg_temp.fx(format('update public.qorpera_company_machine_placements set removed_at = clock_timestamp() where id = %L',
			v_placement.id));
		perform pg_temp.base_assert(pg_temp.retire_at(v_placement, v_placement.boot_id, 'new-disk') = '{"state":"stale"}'::jsonb,
			'Once removed, it is stale');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
end $$;

-- 7. Custody: the executor of the placement's node, with its exact binding text, under the service role; a reason of
--    the two and a boot.
do $$
declare v_placement public.qorpera_company_machine_placements := pg_temp.mc_placement('build-a');
begin
	perform pg_temp.base_error(format($sql$select public.qorpera_retire_company_machine(%L, 'mx-a', %L, repeat('c', 64), %L, 'new-disk')$sql$,
		v_placement.id, (v_placement.binding || '{"network":"drift"}')::text, v_placement.boot_id), '42501', 'Machine custody differs');
	perform pg_temp.base_error(format($sql$select public.qorpera_retire_company_machine(%L, 'mx-other', %L, repeat('c', 64), %L, 'new-disk')$sql$,
		v_placement.id, public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.boot_id), '42501',
		'Machine custody differs');
	perform pg_temp.base_claims('authenticated');
	perform pg_temp.base_error($sql$select pg_temp.retire('new-disk')$sql$, '42501', 'Machine custody required');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($sql$select pg_temp.retire('moved')$sql$, '22023', 'Machine retirement invalid');
	perform pg_temp.base_error($sql$select pg_temp.retire_at(pg_temp.mc_placement('build-a'), null, 'new-disk')$sql$, '22023',
		'Machine retirement invalid');
	perform pg_temp.base_assert((pg_temp.mc_placement('build-a')).id = v_placement.id
		and (pg_temp.mc_placement('build-a')).retired_at is null, 'Nothing was retired');
end $$;

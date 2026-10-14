-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- Test machine views (20260930420000; F3 step 6, slice 6a: deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md), which
-- build C1b-3b (RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views" §8): one view per boot of a company machine, opened by the
-- platform after the executor records the boot. It names the starter's agent and member and acts through the starter's
-- run while the run's job is leased, then as the agent, company-wide as a desktop. It stands while its placement runs
-- its boot and the starter still reads the root; a retired placement keeps it for one final publish, which closes it.
-- Its read set lives with the disk. Machines, placements and their node demands are built by hand, as the executor's
-- custody leaves them (873 tests that). The office, run builder and view helpers are 639's and 632's.

-- 981's: the statement fails with this SQLSTATE, message and detail (no detail unless one is named).
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
-- 981's: a fixture change (632's pg_temp.fx) that breaks the named constraint or unique index.
create function pg_temp.violates(p_sql text, p_constraint text) returns void language plpgsql as $$
declare v_name text;
begin
	begin perform pg_temp.fx(p_sql);
	exception when integrity_constraint_violation then
		get stacked diagnostics v_name = constraint_name;
		if v_name = p_constraint then return; end if;
		raise exception 'Expected % to refuse, got %: %', p_constraint, v_name, sqlerrm;
	end;
	raise exception 'Expected % to refuse, but it succeeded: %', p_constraint, p_sql;
end $$;
-- A company machine that a run of agent A started for the run's requester. It has no placement yet.
create function pg_temp.machine(p_run jsonb, p_name text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
		started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	select v_id, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', p_name, 'Runs the tests.', r.staff_agent_id,
		r.id, extensions.gen_random_uuid(), r.requested_by_user_id, 2, 4294967296, 21474836480, 'standard', 'task'
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
-- A new disk: the machine's current placement (its earlier one retired), reserved on node ...e2 and running a first
-- boot. Returns the boot's anchor.
create function pg_temp.place(p_machine uuid) returns jsonb language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_boot uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where machine_id = p_machine and retired_at is null;
	insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding, instance_sha256,
		running_at, boot_id)
	values (v_id, p_machine, '63200000-0000-4000-8000-000000000010', 'node-a', repeat('8', 64), '{}', repeat('9', 64), clock_timestamp(), v_boot);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter, instance_sha256,
		reserved_at)
	values (v_id, '63200000-0000-4000-8000-000000000010', v_id, 'lxd', repeat('9', 64), clock_timestamp());
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes,
		reserved_at)
	values (v_id, '63900000-0000-4000-8000-0000000000e2', 'machine', 'lxd', repeat('4', 64), 2000, 4294967296, clock_timestamp());
	set local session_replication_role = origin;
	return jsonb_build_object('companyMachineId', p_machine, 'placementId', v_id, 'bootId', v_boot);
end $$;
-- The same disk boots again (a wake): the new boot's anchor.
create function pg_temp.reboot(p_anchor jsonb) returns jsonb language plpgsql as $$
declare v_boot uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format('update public.qorpera_company_machine_placements set boot_id = %L, running_at = clock_timestamp() where id = %L',
		v_boot, p_anchor ->> 'placementId'));
	return p_anchor || jsonb_build_object('bootId', v_boot);
end $$;
create function pg_temp.open_machine(p_anchor jsonb) returns jsonb language sql as $$
	select pg_temp.open('test_machine', p_anchor)
$$;
create function pg_temp.not_current(p_anchor jsonb) returns void language sql as $$
	select pg_temp.refused(format('select pg_temp.open_machine(%L)', p_anchor), '42501', 'Folder view machine is not current')
$$;
-- 981's: the last change set says "final" (C1B §8). Possession is the view's, as for vcommit.
create function pg_temp.final(p_view jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_units);
	return public.qorpera_folder_commit('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view) || '{"final":true}', p_key, p_units);
end $$;
create function pg_temp.view_row(p_view jsonb) returns public.qorpera_folder_views language sql as $$
	select * from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;
create function pg_temp.lapse(p_run jsonb) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L',
		p_run ->> 'jobId'))
$$;
-- Agent A loses every grant (the root's too), and gets them back.
create function pg_temp.a_grants(p_revoked boolean) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_path_grants set revoked_at = %s where principal_kind = ''staff_agent''
		and principal_id = ''63200000-0000-4000-8000-0000000000a1''', case when p_revoked then 'clock_timestamp()' else 'null' end))
$$;


-- The migration's marker is in every function it patches and in the new root check, which is internal. The view's
-- machine columns belong to test machines alone, and a placement records a disk used without the folder check.
do $$
declare f regprocedure; r name; v_root constant text := 'public.qorpera_folder_reads_root(uuid,uuid,uuid,uuid)';
begin
	foreach f in array array[v_root, 'public.qorpera_folder_view_valid(public.qorpera_folder_views)',
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)', 'public.qorpera_folder_view_resolve(uuid,uuid,jsonb)',
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', 'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)']::regprocedure[] loop
		if strpos(pg_get_functiondef(f), '20260930420000') = 0 then raise exception '% has no marker 20260930420000', f; end if;
	end loop;
	foreach r in array array['anon','authenticated','service_role','qorpera_secret_broker']::name[] loop
		if has_function_privilege(r, v_root, 'EXECUTE') then raise exception '% may run the root check', r; end if;
	end loop;
	if has_function_privilege('authenticated', 'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', 'EXECUTE') then
		raise exception 'view open''s privileges changed'; end if;
	if not exists (select 1 from information_schema.columns where table_schema = 'public'
			and table_name = 'qorpera_company_machine_placements' and column_name = 'folder_unchecked_at') then
		raise exception 'A placement has no folder_unchecked_at'; end if;
	-- The root check: agent A (its root grant) with member 2 (a contributor) reads the root; with a stranger, or once A's
	-- grants are revoked, it does not.
	if not public.qorpera_folder_reads_root('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
			'63200000-0000-4000-8000-0000000000a1', '63200000-0000-4000-8000-000000000002')
		or public.qorpera_folder_reads_root('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
			'63200000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid()) then
		raise exception 'The root check'; end if;
	perform pg_temp.a_grants(true);
	if public.qorpera_folder_reads_root('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
			'63200000-0000-4000-8000-0000000000a1', '63200000-0000-4000-8000-000000000002') then
		raise exception 'The root check without A''s grants'; end if;
	perform pg_temp.a_grants(false);
end $$;

-- Setup: tm/ with two files, which the machine's tests read.
do $$
declare a jsonb := pg_temp.stage('test machine');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'tm-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','tm'),
		jsonb_build_object('op','write','path','tm/k.txt','file',a), jsonb_build_object('op','write','path','tm/r.txt','file',a))), 3, 'saved');
end $$;

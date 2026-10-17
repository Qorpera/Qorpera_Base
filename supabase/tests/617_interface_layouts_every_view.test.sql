-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- Interfaces C6c (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §2 and §4; 20260930510000) on every machine view: 689
-- shows a run box; here a desktop held by a run (live, then detached), a shell command, a test machine and a coding
-- session. Each is an agent's view, so each commit's unit that changes or lands anything under interfaces/, a table's
-- folder or its table.toml is refused with layout_authoring and its other units save. A coding session never writes
-- interfaces/ or a table.toml at all (the coding rule, 20260928469290, denies them first); it is refused the rule's
-- code for a new table folder. A desktop a member holds saves as the member, and a member's page is stored and inert:
-- the web draws only the pages it ships (packages/web/test/interface-folder.test.ts, "never reads or draws the
-- folder's interfaces/"). The office, run builder and view helpers are 639's and 632's.

-- 981's: a start's row as the native operation's begin makes it: keyed by its receipt, in the office's and the
-- screen's generation (1), for the run's agent and member; the guest has not named it yet (command_id null).
create function pg_temp.command(p_run jsonb, p_network boolean default false) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_office_shell_commands(id, receipt_id, office_id, computer_generation, screen_id, screen_generation,
		staff_agent_id, run_id, requested_by_user_id, conversation_run_id, command, network, started_at, worked_at)
	select v_id, v_id, '63900000-0000-4000-8000-0000000000e0', 1, '63900000-0000-4000-8000-0000000000e4', 1, r.staff_agent_id, r.id,
		r.requested_by_user_id, r.id, 'make', p_network, clock_timestamp(), clock_timestamp()
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
-- 510's: a company machine that a run of agent A started for the run's requester. It has no placement yet.
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
-- 510's: a new disk, the machine's current placement, reserved on node ...e2 and running a first boot. Returns the
-- boot's anchor.
create function pg_temp.place(p_machine uuid) returns jsonb language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_boot uuid := extensions.gen_random_uuid();
	v_instance text := encode(extensions.digest(v_id::text, 'sha256'), 'hex');
begin
	set local session_replication_role = replica;
	update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where machine_id = p_machine and retired_at is null;
	insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding, instance_sha256,
		running_at, boot_id)
	values (v_id, p_machine, '63200000-0000-4000-8000-000000000010', 'node-a', repeat('8', 64), '{}', v_instance, clock_timestamp(), v_boot);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter, instance_sha256,
		reserved_at)
	values (v_id, '63200000-0000-4000-8000-000000000010', v_id, 'lxd', v_instance, clock_timestamp());
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes,
		reserved_at)
	values (v_id, '63900000-0000-4000-8000-0000000000e2', 'machine', 'lxd', repeat('4', 64), 2000, 4294967296, clock_timestamp());
	set local session_replication_role = origin;
	return jsonb_build_object('companyMachineId', p_machine, 'placementId', v_id, 'bootId', v_boot);
end $$;
-- 689's: refused by the rule, its code, its message, and no other problem.
create function pg_temp.layout(p_result jsonb, p_unit integer) returns void language plpgsql as $$
declare v jsonb := pg_temp.expect(p_result, p_unit, 'refused', 'structured_rule');
begin
	if v -> 'problems' -> 0 ->> 'code' is distinct from 'layout_authoring'
		or v -> 'problems' -> 0 ->> 'message' is distinct from 'page and table layout authoring is not available'
		or jsonb_array_length(v -> 'problems') <> 1 then
		raise exception 'Unit % names the rule alone: %', p_unit, p_result using errcode = 'QTF01'; end if;
end $$;
-- A view's commit of every kind of layout change (a page folder, a page file, a table definition, a table folder, a
-- copy into interfaces/) and one plain folder: the first five refused for the layout, the last saved, as the agent.
create function pg_temp.agent_view(p_view jsonb, p_name text) returns public.qorpera_folder_commits language plpgsql as $$
declare r jsonb; i integer; c public.qorpera_folder_commits%rowtype;
begin
	r := pg_temp.vcommit(p_view, 'layout-' || p_name, jsonb_build_array(jsonb_build_object('op','mkdir','path','interfaces/page-' || p_name),
		jsonb_build_object('op','write','path','interfaces/order-' || p_name || '.md','file',pg_temp.stage('A page file.')),
		jsonb_build_object('op','write','path','tables/t/table.toml','file',pg_temp.stage('name = "Figures"')),
		jsonb_build_object('op','mkdir','path','tables/table-' || p_name),
		jsonb_build_object('op','copy','from','shared/a.txt','to','interfaces/copy-' || p_name || '.md'),
		jsonb_build_object('op','mkdir','path','shared/by-' || p_name)));
	for i in 1..5 loop perform pg_temp.layout(r, i); end loop;
	perform pg_temp.expect(r, 6, 'saved');
	c := pg_temp.last_commit(r);
	if c.actor_kind is distinct from 'staff_agent' or c.view_id is distinct from (p_view ->> 'viewId')::uuid then
		raise exception 'The % view''s commit: %', p_name, to_jsonb(c); end if;
	return c;
end $$;
-- Every live entry under interfaces/ or tables/ (689's, by key).
create function pg_temp.layouts() returns text[] language sql as $$
	select coalesce(array_agg(key_text order by key_text), '{}') from public.qorpera_folder_entries
	where environment_id = '63200000-0000-4000-8000-000000000020' and kind <> 'claim' and key_text ~ '^(interfaces|tables)(/|$)'
$$;

-- The platform makes the pages folder, the tables root and a table's folder, so each change below has its parent.
do $$
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'layout-seed', '[{"op":"mkdir","path":"interfaces"},
		{"op":"mkdir","path":"tables"},{"op":"mkdir","path":"tables/t"}]'), 3, 'saved');
	if pg_temp.layouts() <> array['interfaces', 'tables', 'tables/t'] then raise exception 'The seed: %', pg_temp.layouts(); end if;
end $$;

-- A desktop held by a run, then detached (the run's lease released): both save as the agent.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); d jsonb; c public.qorpera_folder_commits%rowtype;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	c := pg_temp.agent_view(d, 'desk-live');
	if c.run_id is distinct from (v ->> 'runId')::uuid or c.view_kind is distinct from 'computer_desktop' then
		raise exception 'Live desktop commit: %', to_jsonb(c); end if;
	perform pg_temp.hold(null);
	c := pg_temp.agent_view(d, 'desk-detached');
	if c.run_id is not null or c.view_kind is distinct from 'computer_desktop' then raise exception 'Detached desktop commit: %', to_jsonb(c); end if;
end $$;

-- A shell command of a run's.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); s jsonb;
begin
	perform pg_temp.hold(v);
	s := pg_temp.open('computer_shell_command', jsonb_build_object('shellCommandId', pg_temp.command(v)));
	if (pg_temp.agent_view(s, 'shell')).view_kind is distinct from 'computer_shell_command' then raise exception 'The shell view''s kind'; end if;
	perform pg_temp.hold(null);
end $$;

-- A test machine a run started.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); s jsonb;
begin
	s := pg_temp.open('test_machine', pg_temp.place(pg_temp.machine(v, 'layouts')));
	if (pg_temp.agent_view(s, 'test-machine')).view_kind is distinct from 'test_machine' then raise exception 'The test machine view''s kind'; end if;
end $$;

-- A coding session (639's attachment): interfaces/ and a table.toml are denied by the coding rule before the layout
-- rule; a new table folder is refused for the layout; its code/ folder saves.
do $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid(); cm uuid := extensions.gen_random_uuid(); cv jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
	repo jsonb := '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-coding', 'coding', 'Code', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid, '63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000002', 'exec-1', repeat('8', 64), '{}');
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code', repo, 'qorpera/w-coding', cm,
		tok, clock_timestamp() + interval '60 seconds', 1, clock_timestamp());
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1', repo, true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled) values ('63200000-0000-4000-8000-000000000020', 'exec-1', true);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', repeat('9', 64), cm, clock_timestamp());
	set local session_replication_role = origin;
	cv := pg_temp.open('coding_session', jsonb_build_object('workerId', w, 'attachmentToken', tok));
	r := pg_temp.vcommit(cv, 'layout-coding', jsonb_build_array(jsonb_build_object('op','mkdir','path','interfaces/page-coding'),
		jsonb_build_object('op','write','path','interfaces/order-coding.md','file',pg_temp.stage('A page file.')),
		jsonb_build_object('op','write','path','tables/t/table.toml','file',pg_temp.stage('name = "Figures"')),
		jsonb_build_object('op','mkdir','path','tables/table-coding'), jsonb_build_object('op','mkdir','path','code/by-coding')));
	perform pg_temp.expect(r, 1, 'denied', 'denied'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	perform pg_temp.expect(r, 3, 'denied', 'denied'); perform pg_temp.layout(r, 4); perform pg_temp.expect(r, 5, 'saved');
	c := pg_temp.last_commit(r);
	if c.actor_kind is distinct from 'staff_agent' or c.session_kind is distinct from 'coding' or c.view_kind is distinct from 'coding_session' then
		raise exception 'Coding view commit: %', to_jsonb(c); end if;
end $$;

-- No agent's view stored anything the rule keeps.
do $$
begin
	if pg_temp.layouts() <> array['interfaces', 'tables', 'tables/t'] then raise exception 'The layouts changed: %', pg_temp.layouts(); end if;
end $$;

-- A desktop a member holds (a takeover) is the member's: its page folder saves as the member and is stored, by design
-- (C6c: members keep their writes). It stays inert: the web never reads or draws it (interface-folder.test.ts).
do $$
declare m jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
begin
	perform pg_temp.hold(null, '63200000-0000-4000-8000-000000000001');
	m := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4',
		'holderUserId','63200000-0000-4000-8000-000000000001'));
	r := pg_temp.vcommit(m, 'layout-member-desk', '[{"op":"mkdir","path":"interfaces/member-desk"}]');
	perform pg_temp.expect(r, 1, 'saved');
	c := pg_temp.last_commit(r);
	if c.actor_kind is distinct from 'member' or c.view_kind is distinct from 'computer_desktop' then
		raise exception 'A member-held desktop saves as the member: %', to_jsonb(c); end if;
	if not (pg_temp.read('interfaces/member-desk') ->> 'found')::boolean then raise exception 'The member''s page folder is stored'; end if;
end $$;

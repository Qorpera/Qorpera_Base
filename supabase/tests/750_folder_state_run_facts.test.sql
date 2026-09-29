-- @fixture 707_folder_state_todos.test.sql until "-- 1. The company, two agents, and a todo"
-- Company state files, F2-1b part A (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5): a folder-v2 run's context
-- names the company as its vision file does and gives its agents' folder names; a snapshot-v1 company's is unchanged.

do $$
declare r jsonb; i integer; f jsonb;
	nora constant uuid := '70700000-0000-4000-8000-0000000000a1'; otto constant uuid := '70700000-0000-4000-8000-0000000000a2';
	cofounder constant uuid := '70700000-0000-4000-8000-0000000000c0'; legacy constant uuid := '75000000-0000-4000-8000-0000000000b9';
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Folders'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', cofounder, 'Co-Founder', 'co-founder')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'), pg_temp.hire('otto', otto, 'Otto')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- An agent row from before the company's files has no folder.
	insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
		employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id)
	values ('70700000-0000-4000-8000-000000000010', legacy, 'Old hand', 'Ops', 'Help.', 'native', 'round', 'active', 'active',
		statement_timestamp(), statement_timestamp(), '70700000-0000-4000-8000-000000000001');

	f := public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora);
	if f is distinct from jsonb_build_object('companyName', 'Nordlys Folders', 'agent', 'nora',
			'coworkers', jsonb_build_object(cofounder, 'co-founder', otto, 'otto')) then
		raise exception 'A folder-v2 run names the company and its agents'' folders: %', f; end if;
	-- The agent from before the files has no folder of its own, and is no folder of a coworker.
	f := public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', legacy);
	if f ->> 'agent' is not null or f -> 'coworkers' is distinct from jsonb_build_object(cofounder, 'co-founder', nora, 'nora', otto, 'otto') then
		raise exception 'An agent without a folder: %', f; end if;

	-- A rename moves the folder; an archived agent is no coworker; the company's new name is its vision's.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0001', jsonb_build_array(pg_temp.move('agents/otto', 'agents/otis'))), 1, 'saved');
	if public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora) -> 'coworkers' ->> otto::text is distinct from 'otis' then
		raise exception 'A renamed coworker''s folder'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'archive-0001', jsonb_build_array(pg_temp.write('agents/otis/agent.md', 'agent',
		pg_temp.agent_text(otto, 'Otto', 'agent', 'archived'), pg_temp.agent_parse(otto, 'Otto', 'agent', 'archived'),
		pg_temp.version('agents/otis/agent.md')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'vision-0002', jsonb_build_array(pg_temp.vision('Nordlys Studio'))), 1, 'saved');
	f := public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora);
	if f ->> 'companyName' is distinct from 'Nordlys Studio' or f -> 'coworkers' ? otto::text then
		raise exception 'Archived coworkers and the vision''s name: %', f; end if;

	-- A snapshot-v1 company says nothing: its runs keep their context and their folders by id.
	if public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000022', nora) is not null then
		raise exception 'Another environment of the company has no folder facts'; end if;
	insert into public.qorpera_profiles(id, name, created_by_user_id) values ('75000000-0000-4000-8000-000000000010', 'Snapshot Co', '70700000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('75000000-0000-4000-8000-000000000020', '75000000-0000-4000-8000-000000000010', 'Environment', 1, '70700000-0000-4000-8000-000000000001');
	if public.qorpera_company_state_run_folder('75000000-0000-4000-8000-000000000020', nora) is not null then
		raise exception 'A snapshot-v1 company has no folder facts'; end if;

	-- The run context carries them: the company's name, and folder only when the agent has one (a folder-v2 run's actor
	-- describes its context from core C1c on, so the definition is read here).
	f := to_jsonb(pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure));
	if position('v_folder := public.qorpera_company_state_run_folder(v_run.environment_id, v_run.staff_agent_id);' in f #>> '{}') = 0
		or position('v_company_name := coalesce(v_folder ->> ''companyName'', v_company_name);' in f #>> '{}') = 0
		or position('|| case when v_folder ->> ''agent'' is null then ''{}''::jsonb else jsonb_build_object(''folder'', v_folder - ''companyName'') end;' in f #>> '{}') = 0 then
		raise exception 'The run context carries the folder facts'; end if;
end $$;

rollback;

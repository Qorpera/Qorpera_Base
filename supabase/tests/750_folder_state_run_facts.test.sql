-- @fixture 707_folder_state_todos.test.sql until "-- 1. The company, two agents, and a todo"
-- A row with a folder in the company's other environment (foreign keys and checks as a real row has them).
create function pg_temp.fx_other_folder(p_staff uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_profile_staff set folder_environment_id = '70700000-0000-4000-8000-000000000022',
		folder_path = 'agents/elsewhere/agent.md', folder_path_version = extensions.gen_random_uuid(),
		folder_commit_id = extensions.gen_random_uuid()
	where profile_id = '70700000-0000-4000-8000-000000000010' and staff_agent_id = p_staff;
	set local session_replication_role = origin;
end $$;

-- Company state files, F2-1b part A (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5): the folder names a folder-v2
-- run's context gives (core C1c-2's folder-v2 body of the context adds them), for the agent and the coworkers the context
-- lists; none for a snapshot-v1 company or an agent without a folder.

do $$
declare r jsonb; i integer; f jsonb; v_all uuid[];
	nora constant uuid := '70700000-0000-4000-8000-0000000000a1'; otto constant uuid := '70700000-0000-4000-8000-0000000000a2';
	cofounder constant uuid := '70700000-0000-4000-8000-0000000000c0'; legacy constant uuid := '75000000-0000-4000-8000-0000000000b9';
	elsewhere constant uuid := '75000000-0000-4000-8000-0000000000b8';
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Folders'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', cofounder, 'Co-Founder', 'co-founder')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'), pg_temp.hire('otto', otto, 'Otto')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- An agent row from before the company's files has no folder; one whose folder is another environment's is no folder here.
	insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
		employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id)
	values ('70700000-0000-4000-8000-000000000010', legacy, 'Old hand', 'Ops', 'Help.', 'native', 'round', 'active', 'active',
		statement_timestamp(), statement_timestamp(), '70700000-0000-4000-8000-000000000001'),
		('70700000-0000-4000-8000-000000000010', elsewhere, 'Elsewhere', 'Ops', 'Help.', 'native', 'round', 'active', 'active',
		statement_timestamp(), statement_timestamp(), '70700000-0000-4000-8000-000000000001');
	perform pg_temp.fx_other_folder(elsewhere);
	v_all := array[cofounder, otto, legacy, elsewhere];

	f := public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora, v_all);
	if f is distinct from jsonb_build_object('agent', 'nora', 'coworkers', jsonb_build_object(cofounder, 'co-founder', otto, 'otto')) then
		raise exception 'A folder-v2 run gives its agents'' folders: %', f; end if;
	-- Only the coworkers the context lists.
	f := public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora, array[otto]);
	if f -> 'coworkers' is distinct from jsonb_build_object(otto, 'otto') then raise exception 'Only listed coworkers: %', f; end if;
	-- An agent without a folder gets none: its run keeps the folders by id.
	if public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', legacy, array[nora, otto]) is not null then
		raise exception 'An agent without a folder'; end if;

	-- A rename moves the folder; a deleted agent folder is no folder.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0001', jsonb_build_array(pg_temp.move('agents/otto', 'agents/otis'))), 1, 'saved');
	if public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora, v_all) -> 'coworkers' ->> otto::text
		is distinct from 'otis' then
		raise exception 'A renamed coworker''s folder'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'delete-0001', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/otis','expectedVersion',pg_temp.version('agents/otis'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	if coalesce(public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000020', nora, v_all) -> 'coworkers' ? otto::text, true) then
		raise exception 'A deleted coworker has no folder'; end if;

	-- A snapshot-v1 company, and another environment of this one, give nothing.
	if public.qorpera_company_state_run_folder('70700000-0000-4000-8000-000000000022', nora, v_all) is not null then
		raise exception 'Another environment of the company has no folder facts'; end if;
	insert into public.qorpera_profiles(id, name, created_by_user_id) values ('75000000-0000-4000-8000-000000000010', 'Snapshot Co', '70700000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('75000000-0000-4000-8000-000000000020', '75000000-0000-4000-8000-000000000010', 'Environment', 1, '70700000-0000-4000-8000-000000000001');
	if public.qorpera_company_state_run_folder('75000000-0000-4000-8000-000000000020', nora, v_all) is not null then
		raise exception 'A snapshot-v1 company has no folder facts'; end if;
end $$;

rollback;

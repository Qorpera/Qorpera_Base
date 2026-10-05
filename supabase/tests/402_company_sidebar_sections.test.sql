-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company sidebar sections on folder-v2 (ported from snapshot-v1 in the legacy sweep): sections and placement are the
-- company's agents/sections.md, which members and agents' runs save (the member RPC's section and move actions refuse;
-- the agent organises the sidebar by saving the file); the member read shows them in file order. Pins and hidden agents
-- stay each member's own. An archived agent leaves every list but keeps its place.
select pg_temp.base_claims('service_role');

create function pg_temp.sb_manage(p_user uuid, p_request jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', p_request);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.sb_read(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.sb_refused(p_user uuid, p_request jsonb, p_code text, p_message text default null) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.sb_manage(p_user, p_request);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code or (p_message is not null and sqlerrm <> p_message) then
			raise exception 'expected % %, got % (%)', p_code, coalesce(p_message, ''), sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_request;
end $$;
-- agents/sections.md with these sections, each a name and its agents in order.
create function pg_temp.sb_sections(p_sections jsonb) returns jsonb language sql as $$
	select pg_temp.base_write('agents/sections.md', 'sections', 'sections ' || p_sections::text, jsonb_build_object('kind', 'sections',
		'sections', coalesce((select jsonb_agg(jsonb_build_object('name', section ->> 'name', 'line', 3 + 10 * (ordinal - 1)::integer,
			'members', coalesce((select jsonb_agg(jsonb_build_object('id', member #>> '{}', 'line', 4 + 10 * (ordinal - 1)::integer + n::integer)
				order by n) from jsonb_array_elements(section -> 'agents') with ordinality m(member, n)), '[]'::jsonb)) order by ordinal)
			from jsonb_array_elements(p_sections) with ordinality s(section, ordinal)), '[]'::jsonb)),
		pg_temp.base_version('agents/sections.md'))
$$;
-- A section's agents in a member's read, in the order the client draws them.
create function pg_temp.sb_in(p_state jsonb, p_section text) returns text[] language sql as $$
	select coalesce(array_agg(placement ->> 'staffAgentId' order by (placement ->> 'position')::int), '{}')
	from jsonb_array_elements(p_state -> 'placements') placement where placement ->> 'sectionId' is not distinct from p_section
$$;
create function pg_temp.sb_section_of(p_state jsonb, p_agent text) returns text language sql as $$
	select placement ->> 'sectionId' from jsonb_array_elements(p_state -> 'placements') placement where placement ->> 'staffAgentId' = p_agent
$$;
create function pg_temp.sb_section(p_state jsonb, p_name text) returns text language sql as $$
	select section ->> 'sectionId' from jsonb_array_elements(p_state -> 'sections') section where section ->> 'name' = p_name
$$;

-- 1. Members: the file is the sidebar; pins and hidden agents are each member's own.
do $$
declare v_state jsonb; v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_contributor uuid := '92400000-0000-4000-8000-000000000002';
	v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_alice text := '92400000-0000-4000-8000-000000000030';
	v_bob text := '92400000-0000-4000-8000-000000000031'; v_carol text := '92400000-0000-4000-8000-000000000032';
	v_action text; v_version uuid; v_result jsonb; v_units jsonb;
begin
	-- An empty company sidebar: every agent Unassigned, nothing pinned or hidden.
	v_state := pg_temp.sb_read(v_owner);
	perform pg_temp.base_assert(v_state ->> 'schema' = 'qorpera.company-sidebar/v1' and v_state -> 'sections' = '[]'
		and v_state -> 'placements' = '[]' and v_state -> 'pinned' = '[]' and v_state -> 'hidden' = '[]',
		'A company starts with no sections: ' || v_state::text);
	-- The owner saves a section with two agents in order; the read draws it as the file has it.
	perform pg_temp.base_commit(pg_temp.base_owner(), 'sb-sections-0001', jsonb_build_array(pg_temp.sb_sections(jsonb_build_array(
		jsonb_build_object('name', 'Research team', 'agents', jsonb_build_array(v_carol, v_bob))))));
	v_state := pg_temp.sb_read(v_owner);
	perform pg_temp.base_assert(v_state #>> '{sections,0,name}' = 'Research team'
		and pg_temp.sb_in(v_state, pg_temp.sb_section(v_state, 'Research team')) = array[v_carol, v_bob]
		and pg_temp.sb_section_of(v_state, v_alice) is null, 'The file''s section and order are the sidebar''s: ' || v_state::text);
	-- A contributor organises too; a viewer cannot change the file.
	perform pg_temp.base_commit(jsonb_build_object('kind', 'member', 'userId', v_contributor), 'sb-sections-0002', jsonb_build_array(
		pg_temp.sb_sections(jsonb_build_array(jsonb_build_object('name', 'Research team', 'agents', jsonb_build_array(v_carol, v_bob)),
			jsonb_build_object('name', 'Operations', 'agents', jsonb_build_array(v_alice))))));
	v_state := pg_temp.sb_read(v_owner);
	perform pg_temp.base_assert(v_state #>> '{sections,1,name}' = 'Operations'
		and pg_temp.sb_in(v_state, pg_temp.sb_section(v_state, 'Operations')) = array[v_alice], 'A contributor saves the sections');
	v_version := pg_temp.base_version('agents/sections.md');
	-- The viewer holds the file as its own upload would, then commits it.
	v_units := jsonb_build_array(pg_temp.sb_sections('[{"name":"Viewers","agents":[]}]'));
	perform pg_temp.base_seal(jsonb_build_object('kind', 'member', 'userId', v_viewer), (select manifest_text
		from public.qorpera_folder_upload_intents where environment_id = '92400000-0000-4000-8000-000000000020'
			and manifest_sha256 = v_units #>> '{0,file,manifestSha256}' limit 1));
	v_result := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', jsonb_build_object('kind', 'member', 'userId', v_viewer),
		'sb-sections-viewer', v_units);
	perform pg_temp.base_assert(v_result #>> '{units,0,outcome}' = 'denied'
		and pg_temp.base_version('agents/sections.md') = v_version, 'A viewer cannot change the sections: ' || v_result::text);
	-- The member RPC's section and move actions are file edits on folder-v2: they refuse, and so for a viewer.
	foreach v_action in array array['create_section', 'rename_section', 'delete_section', 'move_agent', 'move_room'] loop
		perform pg_temp.sb_refused(v_owner, jsonb_build_object('action', v_action), '55000',
			'This company keeps its sections in agents/sections.md; edit that file');
	end loop;
	perform pg_temp.sb_refused(v_viewer, '{"action":"rename_section"}', '42501');
	-- Pins are the member's own and never reach another member.
	v_state := pg_temp.sb_manage(v_viewer, jsonb_build_object('action', 'set_pins', 'order', jsonb_build_array(v_bob, v_alice)));
	perform pg_temp.base_assert(v_state -> 'pinned' = jsonb_build_array(v_bob, v_alice), 'A viewer pins for themself');
	perform pg_temp.base_assert(pg_temp.sb_read(v_owner) -> 'pinned' = '[]', 'Pins stay with their member');
	perform pg_temp.sb_refused(v_owner, jsonb_build_object('action', 'set_pins', 'order', jsonb_build_array(v_bob, v_bob)), '22023');
	-- Hiding also unpins; pinning shows the agent again.
	v_state := pg_temp.sb_manage(v_viewer, jsonb_build_object('action', 'set_hidden', 'staffAgentId', v_bob, 'hidden', true));
	perform pg_temp.base_assert(v_state -> 'hidden' = jsonb_build_array(v_bob) and v_state -> 'pinned' = jsonb_build_array(v_alice),
		'Hiding takes the agent out of the pinned row');
	v_state := pg_temp.sb_manage(v_viewer, jsonb_build_object('action', 'set_pins', 'order', jsonb_build_array(v_bob, v_alice)));
	perform pg_temp.base_assert(v_state -> 'hidden' = '[]' and v_state -> 'pinned' = jsonb_build_array(v_bob, v_alice),
		'Pinning a hidden agent shows it');
	perform pg_temp.sb_refused(v_owner, jsonb_build_object('action', 'set_hidden', 'staffAgentId', v_bob, 'hidden', 'yes'), '22023');
	perform pg_temp.sb_refused(v_owner, jsonb_build_object('action', 'set_pins', 'order', jsonb_build_array('92400000-0000-4000-8000-000000000099')),
		'P0002');
end $$;

-- 2. An agent moves a coworker into a section by saving agents/sections.md from its run, with no member step. Rows of
-- agents that kept their place are not rewritten, and members see what the agent changed.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_result jsonb; v_state jsonb;
	v_alice text := '92400000-0000-4000-8000-000000000030'; v_bob text := '92400000-0000-4000-8000-000000000031';
	v_carol text := '92400000-0000-4000-8000-000000000032'; v_carol_at timestamptz; v_alice_at timestamptz;
begin
	select updated_at into strict v_carol_at from public.qorpera_company_sidebar_placements where staff_agent_id = v_carol::uuid;
	select updated_at into strict v_alice_at from public.qorpera_company_sidebar_placements where staff_agent_id = v_alice::uuid;
	v_result := pg_temp.base_commit(jsonb_build_object('kind', 'run', 'runId', v_binding ->> 'runId', 'jobId', v_binding ->> 'jobId',
		'runnerId', v_binding ->> 'runnerId', 'assignmentId', v_binding ->> 'assignmentId'), 'sb-agent-move-0001', jsonb_build_array(
		pg_temp.sb_sections(jsonb_build_array(jsonb_build_object('name', 'Research team', 'agents', jsonb_build_array(v_carol)),
			jsonb_build_object('name', 'Operations', 'agents', jsonb_build_array(v_alice, v_bob))))));
	perform pg_temp.base_assert((select actor_kind = 'staff_agent' and run_id = (v_binding ->> 'runId')::uuid
		from public.qorpera_folder_commits where id = (v_result ->> 'commitId')::uuid), 'The move is the agent''s run''s');
	v_state := pg_temp.sb_read('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(pg_temp.sb_in(v_state, pg_temp.sb_section(v_state, 'Operations')) = array[v_alice, v_bob]
		and pg_temp.sb_in(v_state, pg_temp.sb_section(v_state, 'Research team')) = array[v_carol],
		'The agent''s coworker is last in its new section, and members see it: ' || v_state::text);
	perform pg_temp.base_assert((select updated_at from public.qorpera_company_sidebar_placements where staff_agent_id = v_carol::uuid) = v_carol_at
		and (select updated_at from public.qorpera_company_sidebar_placements where staff_agent_id = v_alice::uuid) = v_alice_at,
		'An unmoved row is not rewritten');
end $$;

-- 3. Only members call the member RPCs and only the runner calls the agent RPC.
do $$
begin
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_read_company_sidebar(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_manage_company_sidebar(uuid,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_manage_agent_sidebar(jsonb,jsonb)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_manage_agent_sidebar(jsonb,jsonb)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_manage_company_sidebar(uuid,jsonb)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_manage_agent_sidebar(jsonb,jsonb)', 'execute'),
		'Sidebar RPC grants');
end $$;
-- The agent RPC is the runner's; a member cannot call it, and an agent cannot call the member RPC.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_manage_agent_sidebar(current_setting('qorpera_test.base_binding')::jsonb,'{"action":"list"}')$q$, '42501');
select pg_temp.base_claims('service_role');
select pg_temp.base_error($q$select public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010','{"action":"set_pins","order":[]}')$q$, '42501');

-- 4. An archived agent leaves every list but keeps its place for a return.
do $$
declare v_state jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'sb-archive-bob', jsonb_build_array(pg_temp.base_write('agents/bob/agent.md', 'agent',
		E'---\nid: 92400000-0000-4000-8000-000000000031\nname: Bob\nrole: Research\nkind: agent\nstatus: archived\n---\nRead and change the company folder.\n',
		jsonb_build_object('kind', 'agent', 'id', '92400000-0000-4000-8000-000000000031', 'name', 'Bob', 'role', 'Research', 'agentKind', 'agent',
			'status', 'archived', 'colour', null, 'figure', null, 'model', null, 'effort', null, 'instructions', 'Read and change the company folder.'),
		pg_temp.base_version('agents/bob/agent.md'))));
	perform pg_temp.base_assert((select employment_status from public.qorpera_profile_staff where staff_agent_id = '92400000-0000-4000-8000-000000000031')
		= 'archived', 'Bob is archived');
	v_state := pg_temp.sb_read('92400000-0000-4000-8000-000000000003');
	perform pg_temp.base_assert(v_state -> 'pinned' = '["92400000-0000-4000-8000-000000000030"]', 'An archived agent is not pinned: ' || v_state::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sidebar_placements
		where staff_agent_id = '92400000-0000-4000-8000-000000000031'), 'Its placement is kept');
	perform pg_temp.base_assert(not '92400000-0000-4000-8000-000000000031'::uuid = any(public.qorpera_sidebar_container(
		'92400000-0000-4000-8000-000000000010', pg_temp.sb_section(v_state, 'Operations')::uuid))
		and pg_temp.sb_section_of(v_state, '92400000-0000-4000-8000-000000000031') is null, 'An archived agent is not listed');
end $$;

-- 5. Members never read the sidebar rows directly, nor write them.
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
	set local role authenticated;
	begin
		perform 1 from public.qorpera_member_sidebar_agents;
		raise exception 'member sidebar rows were readable directly';
	exception when insufficient_privilege then null;
	end;
	begin
		perform 1 from public.qorpera_company_sidebar_placements;
		raise exception 'placements were readable directly';
	exception when insufficient_privilege then null;
	end;
	begin
		insert into public.qorpera_company_sidebar_sections(id, profile_id, name, position)
		values ('40200000-0000-4000-8000-000000000009', '92400000-0000-4000-8000-000000000010', 'Direct', 9);
		raise exception 'a member wrote a section directly';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

-- 6. Runtime v95: a company keeps any number of sections (was 40).
do $$
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'sb-many-sections', jsonb_build_array(pg_temp.sb_sections(
		(select jsonb_agg(jsonb_build_object('name', 'Team ' || n, 'agents', '[]'::jsonb) order by n) from generate_series(1, 42) n))));
	perform pg_temp.base_assert((select count(*) > 41 from public.qorpera_company_sidebar_sections
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'A company keeps more than forty-one sections');
end $$;

rollback;

-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Each member's own sidebar over the company's (20260930722000). The company's sidebar is its sections file; what a
-- member changes (sections, where agents and group chats stand) is theirs, and everything they did not touch keeps
-- following the company's. Reset takes the member's changes away; Undo puts them back.
select pg_temp.base_claims('service_role');

create function pg_temp.own_manage(p_user uuid, p_request jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', p_request);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.own_read(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.own_refused(p_user uuid, p_request jsonb, p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.own_manage(p_user, p_request);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected % for %, got % (%)', p_code, p_request, sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_request;
end $$;
create function pg_temp.own_sections_file(p_sections jsonb) returns jsonb language sql as $$
	select pg_temp.base_write('QorperaOS/agents/sections.md', 'sections', 'sections ' || p_sections::text, jsonb_build_object('kind', 'sections',
		'sections', coalesce((select jsonb_agg(jsonb_build_object('name', section ->> 'name', 'line', 3 + 10 * (ordinal - 1)::integer,
			'members', coalesce((select jsonb_agg(jsonb_build_object('id', member #>> '{}', 'line', 4 + 10 * (ordinal - 1)::integer + n::integer)
				order by n) from jsonb_array_elements(section -> 'agents') with ordinality m(member, n)), '[]'::jsonb)) order by ordinal)
			from jsonb_array_elements(p_sections) with ordinality s(section, ordinal)), '[]'::jsonb)),
		pg_temp.base_version('QorperaOS/agents/sections.md'))
$$;
-- A container's agents in a read, in the order the client draws them; p_section null: in no section.
create function pg_temp.own_in(p_state jsonb, p_section text) returns text[] language sql as $$
	select coalesce(array_agg(placement ->> 'staffAgentId' order by (placement ->> 'position')::int), '{}')
	from jsonb_array_elements(p_state -> 'placements') placement where placement ->> 'sectionId' is not distinct from p_section
$$;
create function pg_temp.own_section(p_state jsonb, p_name text) returns text language sql as $$
	select section ->> 'sectionId' from jsonb_array_elements(p_state -> 'sections') section where section ->> 'name' = p_name
$$;
create function pg_temp.own_names(p_state jsonb) returns text[] language sql as $$
	select coalesce(array_agg(section ->> 'name' order by n), '{}')
	from jsonb_array_elements(p_state -> 'sections') with ordinality s(section, n)
$$;

-- The company's sidebar: Research (Carol, Bob), Operations (Alice).
select pg_temp.base_commit(pg_temp.base_owner(), 'own-sections-0001', jsonb_build_array(pg_temp.own_sections_file(jsonb_build_array(
	jsonb_build_object('name', 'Research', 'agents', jsonb_build_array('92400000-0000-4000-8000-000000000032', '92400000-0000-4000-8000-000000000031')),
	jsonb_build_object('name', 'Operations', 'agents', jsonb_build_array('92400000-0000-4000-8000-000000000030'))))));

-- 1. A viewer's own changes are theirs; the owner keeps seeing the company's sidebar.
do $$
declare v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_alice text := '92400000-0000-4000-8000-000000000030'; v_bob text := '92400000-0000-4000-8000-000000000031';
	v_carol text := '92400000-0000-4000-8000-000000000032'; v_mine text := '12140000-0000-4000-8000-0000000000e1';
	v_state jsonb; v_company jsonb; v_research text; v_operations text;
begin
	v_company := pg_temp.own_read(v_owner);
	v_research := pg_temp.own_section(v_company, 'Research');
	v_operations := pg_temp.own_section(v_company, 'Operations');
	perform pg_temp.base_assert(v_company #>> '{own,changes}' = '0' and pg_temp.own_in(v_company, v_research) = array[v_carol, v_bob],
		'A member starts with the company''s sidebar and no changes: ' || v_company::text);
	perform pg_temp.base_assert(pg_temp.own_read(v_viewer) - 'own' = v_company - 'own', 'Every member starts from the same sidebar');

	-- A viewer makes a section of their own with Bob in it.
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'create_section', 'sectionId', v_mine, 'name', 'Mine',
		'staffAgentId', v_bob));
	perform pg_temp.base_assert(pg_temp.own_names(v_state) = array['Research', 'Operations', 'Mine']
		and v_state #> '{sections,2,mine}' = 'true'::jsonb and pg_temp.own_in(v_state, v_mine) = array[v_bob]
		and pg_temp.own_in(v_state, v_research) = array[v_carol], 'The viewer''s section holds Bob: ' || v_state::text);
	perform pg_temp.base_assert(pg_temp.own_read(v_owner) - 'own' = v_company - 'own', 'The owner''s sidebar is unchanged');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sidebar_sections where id = v_mine::uuid),
		'The company has no new section');

	-- The viewer moves Alice to the top of what is in no section; Carol to after Alice there.
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', v_alice, 'sectionId', null,
		'order', jsonb_build_array(v_alice)));
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', v_carol, 'sectionId', null,
		'order', jsonb_build_array(v_alice, v_carol)));
	perform pg_temp.base_assert(pg_temp.own_in(v_state, null) = array[v_alice, v_carol] and pg_temp.own_in(v_state, v_research) = '{}'
		and pg_temp.own_in(v_state, v_operations) = '{}', 'The viewer''s moves: ' || v_state::text);

	-- Renaming a company section is the viewer's own; another section of the same name is refused, case aside.
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'rename_section', 'sectionId', v_research, 'name', 'Build'));
	perform pg_temp.base_assert(pg_temp.own_names(v_state) = array['Build', 'Operations', 'Mine'], 'The viewer renamed Research');
	perform pg_temp.base_assert(pg_temp.own_names(pg_temp.own_read(v_owner)) = array['Research', 'Operations'], 'Not for the owner');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'create_section',
		'sectionId', '12140000-0000-4000-8000-0000000000e2', 'name', 'build'), '23505');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'rename_section', 'sectionId', v_mine, 'name', 'OPERATIONS'), '23505');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'create_section', 'sectionId', v_research, 'name', 'Taken'), '23505');

	-- Removing a company section is the viewer's own too.
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'delete_section', 'sectionId', v_operations));
	perform pg_temp.base_assert(pg_temp.own_names(v_state) = array['Build', 'Mine'], 'The viewer removed Operations');
	perform pg_temp.base_assert(pg_temp.own_names(pg_temp.own_read(v_owner)) = array['Research', 'Operations'], 'The company keeps it');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', v_bob, 'sectionId', v_operations), 'P0002');

	-- Pins count among the changes.
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'set_pins', 'order', jsonb_build_array(v_bob)));
	perform pg_temp.base_assert(v_state #>> '{own,changes}' = '7' and v_state #> '{own,moved}' = jsonb_build_array(v_bob, v_alice, v_carol)
		and v_state #>> '{own,pinned}' = '1'
		and v_state #> '{own,sections}' @> '[{"change":"added","name":"Mine"},{"change":"renamed","from":"Research","name":"Build"},{"change":"removed","name":"Operations"}]',
		'The viewer''s changes are counted and named: ' || (v_state -> 'own')::text);
end $$;

-- 2. What the viewer did not touch follows the company: an agent's new order arrives, a touched agent stays put.
do $$
declare v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_alice text := '92400000-0000-4000-8000-000000000030'; v_bob text := '92400000-0000-4000-8000-000000000031';
	v_carol text := '92400000-0000-4000-8000-000000000032'; v_mine text := '12140000-0000-4000-8000-0000000000e1';
	v_state jsonb; v_research text;
begin
	-- The viewer puts Bob back into no section, after Alice; then the company's agents re-sort.
	perform pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', v_bob, 'sectionId', null,
		'order', jsonb_build_array(v_alice, v_bob, v_carol)));
	perform pg_temp.base_commit(pg_temp.base_owner(), 'own-sections-0002', jsonb_build_array(pg_temp.own_sections_file(jsonb_build_array(
		jsonb_build_object('name', 'Research', 'agents', jsonb_build_array(v_bob, v_carol, v_alice))))));
	v_state := pg_temp.own_read(v_viewer);
	v_research := pg_temp.own_section(v_state, 'Build');
	perform pg_temp.base_assert(pg_temp.own_in(v_state, null) = array[v_alice, v_bob, v_carol] and pg_temp.own_in(v_state, v_research) = '{}',
		'Every agent the viewer placed keeps the viewer''s place: ' || v_state::text);
	-- The viewer forgets their own section: Bob was not there anymore, so nothing moves; then removes their place for
	-- Carol by moving her into Build, where the company's order holds around her.
	v_state := pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'delete_section', 'sectionId', v_mine));
	perform pg_temp.base_assert(pg_temp.own_names(v_state) = array['Build'], 'Mine is gone: ' || v_state::text);
	-- Operations is gone from the company: the viewer's removal of it says nothing anymore.
	perform pg_temp.base_assert(not (v_state #> '{own,sections}') @> '[{"change":"removed"}]', 'A gone section is no change');
	-- An agent the viewer never touched follows the company: Alice comes back to Research's order when the viewer's
	-- place for her goes with a reset of hers (section 3).
end $$;

-- 3. Reset brings the company's sidebar back; Undo brings the viewer's changes back, once.
do $$
declare v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_alice text := '92400000-0000-4000-8000-000000000030'; v_bob text := '92400000-0000-4000-8000-000000000031';
	v_carol text := '92400000-0000-4000-8000-000000000032'; v_before jsonb; v_state jsonb;
begin
	-- The viewer also hides the Mailbox page, and places the owner among their contacts.
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	perform public.qorpera_set_interface_page_hidden('92400000-0000-4000-8000-000000000020', 'mailbox', true);
	perform public.qorpera_place_member_contacts('92400000-0000-4000-8000-000000000010', jsonb_build_array(jsonb_build_object(
		'userId', v_owner, 'zone', 'unassigned', 'sectionId', null, 'after', null, 'rank', 0, 'hidden', false)));
	reset role;
	perform pg_temp.base_claims('service_role');
	v_before := pg_temp.own_read(v_viewer);
	perform pg_temp.base_assert((v_before #>> '{own,changes}')::int > 0 and v_before #>> '{own,pages}' = '1'
		and v_before #>> '{own,contacts}' = '1', 'Pages and contacts count: ' || (v_before -> 'own')::text);

	v_state := pg_temp.own_manage(v_viewer, '{"action":"reset"}');
	perform pg_temp.base_assert(v_state - 'own' = pg_temp.own_read(v_owner) - 'own' and v_state #>> '{own,changes}' = '0'
		and v_state -> 'pinned' = '[]', 'After a reset the viewer sees the company''s sidebar: ' || v_state::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_member_hidden_interface_pages where user_id = v_viewer)
		and not exists (select 1 from public.qorpera_member_sidebar_contacts where user_id = v_viewer), 'Pages and contacts reset');
	perform pg_temp.base_assert(pg_temp.own_in(v_state, pg_temp.own_section(v_state, 'Research')) = array[v_bob, v_carol, v_alice],
		'The company''s order: ' || v_state::text);

	v_state := pg_temp.own_manage(v_viewer, '{"action":"undo_reset"}');
	perform pg_temp.base_assert(v_state = v_before, 'Undo puts everything back: ' || v_state::text || ' vs ' || v_before::text);
	perform pg_temp.own_refused(v_viewer, '{"action":"undo_reset"}', 'P0002');
	-- A reset is the caller's only; the owner's sidebar is untouched by the viewer's reset and undo.
	perform pg_temp.base_assert(pg_temp.own_read(v_owner) #>> '{own,changes}' = '0', 'The owner has no changes');
end $$;

-- 4. A contact may stand in the member's own section; a section that is nobody's is refused.
do $$
declare v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_own text := '12140000-0000-4000-8000-0000000000e3';
begin
	perform pg_temp.own_manage(v_viewer, jsonb_build_object('action', 'create_section', 'sectionId', v_own, 'name', 'People'));
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	perform public.qorpera_place_member_contacts('92400000-0000-4000-8000-000000000010', jsonb_build_array(jsonb_build_object(
		'userId', v_owner, 'zone', 'section', 'sectionId', v_own, 'after', null, 'rank', 0, 'hidden', false)));
	begin
		perform public.qorpera_place_member_contacts('92400000-0000-4000-8000-000000000010', jsonb_build_array(jsonb_build_object(
			'userId', v_owner, 'zone', 'section', 'sectionId', '12140000-0000-4000-8000-0000000000e9', 'after', null, 'rank', 0,
			'hidden', false)));
		raise exception 'an unknown section was taken';
	exception when sqlstate '22023' then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_member_sidebar_contacts
		where user_id = v_viewer and section_id = v_own::uuid), 'The contact stands in the viewer''s section');
	-- The owner cannot place a contact in the viewer's section.
	perform pg_temp.base_claims('authenticated', v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_place_member_contacts('92400000-0000-4000-8000-000000000010', jsonb_build_array(jsonb_build_object(
			'userId', v_viewer, 'zone', 'section', 'sectionId', v_own, 'after', null, 'rank', 0, 'hidden', false)));
		raise exception 'another member''s section was taken';
	exception when sqlstate '22023' then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

-- 5. Bad requests, strangers, and no direct access to the rows.
do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_bob text := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.own_refused(v_viewer, '{"action":"reset","name":"x"}', '22023');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', v_bob, 'sectionId', null,
		'order', jsonb_build_array('92400000-0000-4000-8000-000000000030')), '22023');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', v_bob, 'sectionId', null,
		'order', jsonb_build_array(v_bob, v_bob)), '22023');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'rename_section',
		'sectionId', '12140000-0000-4000-8000-0000000000e9', 'name', 'Nowhere'), 'P0002');
	perform pg_temp.own_refused(v_viewer, jsonb_build_object('action', 'move_agent', 'staffAgentId', '92400000-0000-4000-8000-000000000099',
		'sectionId', null), 'P0002');
	-- Someone outside the company reads and changes nothing.
	perform pg_temp.own_refused('92400000-0000-4000-8000-0000000000ff', '{"action":"reset"}', '42501');
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	begin
		perform 1 from public.qorpera_member_sidebar_places;
		raise exception 'member places were readable directly';
	exception when insufficient_privilege then null;
	end;
	begin
		perform 1 from public.qorpera_member_sidebar_sections;
		raise exception 'member sections were readable directly';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_sidebar_own_reset('92400000-0000-4000-8000-000000000010', v_viewer);
		raise exception 'the reset helper was callable';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

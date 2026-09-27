-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Company sidebar sections (2026-09-24): sections and placement are the company's,
-- shared by members and agents; pins and hidden agents are each member's own. An
-- agent moves itself or a coworker between sections through its run binding.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.sidebar_binding',current_setting('qorpera_test.wake_binding'),true);

create function pg_temp.agent_sidebar(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_sidebar(current_setting('qorpera_test.sidebar_binding')::jsonb,p_request)
$$;
create function pg_temp.member_sidebar(p_user uuid,p_request jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated',p_user);
	set local role authenticated;
	v_result := public.qorpera_manage_company_sidebar('30000000-0000-4000-8000-000000000010',p_request);
	reset role;
	perform pg_temp.path_claims('service_role');
	return v_result;
end $$;
create function pg_temp.member_read(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated',p_user);
	set local role authenticated;
	v_result := public.qorpera_read_company_sidebar('30000000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.path_claims('service_role');
	return v_result;
end $$;
create function pg_temp.member_error(p_user uuid,p_request jsonb,p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.member_sidebar(p_user,p_request);
	exception when others then
		reset role;
		perform pg_temp.path_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected %, got % (%)',p_code,sqlstate,sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %',p_code,p_request;
end $$;
-- Section of an agent in a member's read, by position in the section, as the client draws it.
create function pg_temp.section_of(p_state jsonb,p_agent text) returns text language sql as $$
	select placement ->> 'sectionId' from jsonb_array_elements(p_state -> 'placements') placement
	where placement ->> 'staffAgentId' = p_agent
$$;

-- An agent's wake still owes its acknowledgement before any sidebar work.
select pg_temp.wake_error($q$select pg_temp.agent_sidebar('{"action":"list"}')$q$,'55000','Wake requires an acknowledgement before work');
select pg_temp.wake_public_send(current_setting('qorpera_test.sidebar_binding')::jsonb,'progress','sidebar-ack');

do $$
declare v_state jsonb; v_list jsonb; v_owner uuid := '30000000-0000-4000-8000-000000000001'; v_revision bigint;
	v_research uuid := '51000000-0000-4000-8000-000000000001'; v_ops uuid := '51000000-0000-4000-8000-000000000002';
	v_agent text := '30000000-0000-4000-8000-000000000030'; v_bob text := '30000000-0000-4000-8000-000000000031';
	v_carol text := '30000000-0000-4000-8000-000000000032';
begin
	-- An empty company sidebar: every agent Unassigned, nothing pinned or hidden.
	v_state := pg_temp.member_read(v_owner);
	perform pg_temp.wake_assert(v_state ->> 'schema' = 'qorpera.company-sidebar/v1' and v_state -> 'sections' = '[]'
		and v_state -> 'placements' = '[]' and v_state -> 'pinned' = '[]' and v_state -> 'hidden' = '[]',
		'A company starts with no sections');
	-- A member creates a section and moves an agent into it in one step; retrying the create is the same section.
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','create_section','sectionId',v_research,
		'name','  Research   team ','staffAgentId',v_bob));
	perform pg_temp.wake_assert(v_state #>> '{sections,0,name}' = 'Research team'
		and pg_temp.section_of(v_state,v_bob) = v_research::text,'Create with an agent places the agent');
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','create_section','sectionId',v_research,'name','Research team'));
	perform pg_temp.wake_assert(jsonb_array_length(v_state -> 'sections') = 1,'A retried create makes nothing new');
	-- Names are unique per company, ignoring case.
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','create_section','sectionId',v_ops,'name','RESEARCH TEAM'),'23505');
	-- A contributor organises too; a viewer cannot change sections.
	v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000002',
		jsonb_build_object('action','create_section','sectionId',v_ops,'name','Operations'));
	perform pg_temp.wake_assert(v_state #>> '{sections,1,name}' = 'Operations','A contributor creates a section');
	perform pg_temp.member_error('30000000-0000-4000-8000-000000000003',
		jsonb_build_object('action','rename_section','sectionId',v_ops,'name','Ops'),'42501');
	-- A drag orders the section: Carol goes before Bob.
	v_state := pg_temp.member_sidebar(v_owner,jsonb_build_object('action','move_agent','staffAgentId',v_carol,
		'sectionId',v_research,'order',jsonb_build_array(v_carol,v_bob)));
	perform pg_temp.wake_assert((select array_agg(placement ->> 'staffAgentId' order by (placement ->> 'position')::int)
		from jsonb_array_elements(v_state -> 'placements') placement where placement ->> 'sectionId' = v_research::text)
		= array[v_carol,v_bob],'An explicit order is kept');
	-- Pins are the member's own and never reach another member.
	v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000003',
		jsonb_build_object('action','set_pins','order',jsonb_build_array(v_bob,v_agent)));
	perform pg_temp.wake_assert(v_state -> 'pinned' = jsonb_build_array(v_bob,v_agent),'A viewer pins for themself');
	perform pg_temp.wake_assert(pg_temp.member_read(v_owner) -> 'pinned' = '[]','Pins stay with their member');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','set_pins','order',jsonb_build_array(v_bob,v_bob)),'22023');
	-- Hiding also unpins; pinning shows the agent again.
	v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000003',
		jsonb_build_object('action','set_hidden','staffAgentId',v_bob,'hidden',true));
	perform pg_temp.wake_assert(v_state -> 'hidden' = jsonb_build_array(v_bob) and v_state -> 'pinned' = jsonb_build_array(v_agent),
		'Hiding takes the agent out of the pinned row');
	v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000003',
		jsonb_build_object('action','set_pins','order',jsonb_build_array(v_bob,v_agent)));
	perform pg_temp.wake_assert(v_state -> 'hidden' = '[]' and v_state -> 'pinned' = jsonb_build_array(v_bob,v_agent),
		'Pinning a hidden agent shows it');
	-- Dragging out of the pinned row into a section unpins in the same call (a contributor moves shared placement).
	v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000002',jsonb_build_object('action','set_pins',
		'order',jsonb_build_array(v_agent)));
	v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000002',jsonb_build_object('action','move_agent',
		'staffAgentId',v_agent,'sectionId',v_ops,'unpin',true));
	perform pg_temp.wake_assert(v_state -> 'pinned' = '[]' and pg_temp.section_of(v_state,v_agent) = v_ops::text,
		'A move can unpin');
	-- Closed requests.
	perform pg_temp.member_error(v_owner,'{"action":"move_agent","staffAgentId":"30000000-0000-4000-8000-000000000031"}','22023');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_agent','staffAgentId',v_bob,'sectionId',null,'extra',1),'22023');
	perform pg_temp.member_error(v_owner,jsonb_build_object('action','move_agent','staffAgentId',
		'30000000-0000-4000-8000-000000000099','sectionId',null),'P0002');

	-- The agent lists sections and moves a coworker by section name, with no member step.
	v_list := pg_temp.agent_sidebar('{"action":"list"}');
	perform pg_temp.wake_assert(v_list ->> 'schema' = 'qorpera.agent-sidebar/v1' and jsonb_array_length(v_list -> 'sections') = 2
		and v_list #>> '{sections,0,agents,0,name}' = 'Carol','The agent sees sections with their agents in order');
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','move_agent','agentId',v_bob,'section','operations'));
	perform pg_temp.wake_assert((v_list ->> 'changed')::boolean and v_list #>> '{sections,1,agents,1,name}' = 'Bob',
		'An agent moves a coworker into a section by name, last in it');
	perform pg_temp.wake_assert((select updated_by_staff_agent_id = v_agent::uuid and updated_by_user_id is null
		from public.qorpera_company_sidebar_placements where staff_agent_id = v_bob::uuid),'The move is the agent''s');
	-- Agents that kept their place were not rewritten: they keep their last editor.
	perform pg_temp.wake_assert((select updated_by_user_id = v_owner and updated_by_staff_agent_id is null
		from public.qorpera_company_sidebar_placements where staff_agent_id = v_carol::uuid),'An unmoved row keeps its editor');
	v_revision := (select revision from public.qorpera_company_sidebar_revisions
		where profile_id = '30000000-0000-4000-8000-000000000010');
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','move_agent','agentId',v_bob,'section','Operations'));
	perform pg_temp.wake_assert(not (v_list ->> 'changed')::boolean,'Moving again changes nothing');
	perform pg_temp.wake_assert((select revision from public.qorpera_company_sidebar_revisions
		where profile_id = '30000000-0000-4000-8000-000000000010') = v_revision,'A no-op sends no hint');
	v_list := pg_temp.agent_sidebar('{"action":"create_section","name":"Sales"}');
	v_list := pg_temp.agent_sidebar('{"action":"create_section","name":"sales"}');
	perform pg_temp.wake_assert(not (v_list ->> 'changed')::boolean and jsonb_array_length(v_list -> 'sections') = 3,
		'Creating an existing section is the same section');
	v_revision := (select revision from public.qorpera_company_sidebar_revisions
		where profile_id = '30000000-0000-4000-8000-000000000010');
	v_list := pg_temp.agent_sidebar('{"action":"rename_section","section":"Sales","name":"Growth"}');
	perform pg_temp.wake_assert(v_list #>> '{sections,2,name}' = 'Growth','An agent renames a section');
	perform pg_temp.wake_assert((select revision from public.qorpera_company_sidebar_revisions
		where profile_id = '30000000-0000-4000-8000-000000000010') = v_revision + 1
		and (select updated_by_staff_agent_id = v_agent::uuid from public.qorpera_company_sidebar_sections where name = 'Growth'),
		'One change is one hint, attributed to the agent');
	-- Deleting a section keeps its agents: they go to the end of Unassigned.
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','delete_section','section','Operations'));
	perform pg_temp.wake_assert(jsonb_array_length(v_list -> 'sections') = 2
		and (select array_agg(agent ->> 'id' order by ordinality) from jsonb_array_elements(v_list -> 'unassigned')
			with ordinality as item(agent,ordinality)) = array[v_agent,v_bob],
		'A deleted section''s agents are Unassigned, in their order');
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','delete_section','section','Operations'));
	perform pg_temp.wake_assert(not (v_list ->> 'changed')::boolean,'Deleting a missing section is a no-op');
	v_list := pg_temp.agent_sidebar(jsonb_build_object('action','move_agent','agentId',v_carol,'section',null));
	perform pg_temp.wake_assert(v_list #>> '{unassigned,2,name}' = 'Carol','null section is Unassigned');
	-- The member's read reflects the agents' changes.
	v_state := pg_temp.member_read(v_owner);
	perform pg_temp.wake_assert(pg_temp.section_of(v_state,v_carol) is null and jsonb_array_length(v_state -> 'sections') = 2,
		'Members see what agents changed');
end $$;

-- A refusal the agent can act on comes back as data with nothing changed; a malformed
-- request is still an error.
do $$
declare v_result jsonb;
begin
	v_result := pg_temp.agent_sidebar('{"action":"move_agent","agentId":"30000000-0000-4000-8000-000000000031","section":"Nowhere"}');
	perform pg_temp.wake_assert(v_result ->> 'refused' = 'No section is called that' and not (v_result ->> 'changed')::boolean,
		'A missing section is a refusal the agent reads');
	v_result := pg_temp.agent_sidebar('{"action":"create_section","name":"   "}');
	perform pg_temp.wake_assert(v_result ? 'refused','An empty name is refused as data');
	v_result := pg_temp.agent_sidebar('{"action":"create_section","name":"Growth"}');
	perform pg_temp.wake_assert(not (v_result ->> 'changed')::boolean and not v_result ? 'refused','Growth exists already');
	-- A rename retried after it applied finds the section under its new name.
	v_result := pg_temp.agent_sidebar('{"action":"rename_section","section":"Sales","name":"Growth"}');
	perform pg_temp.wake_assert(not (v_result ->> 'changed')::boolean and not v_result ? 'refused','A retried rename is done');
	-- Names are found the way they are written, inner spaces collapsed.
	v_result := pg_temp.agent_sidebar('{"action":"rename_section","section":"  platform   team ","name":"Platform"}');
	perform pg_temp.wake_assert(v_result ? 'refused','Unknown section by collapsed name is refused');
	v_result := pg_temp.agent_sidebar('{"action":"move_agent","agentId":"30000000-0000-4000-8000-000000000031","section":"  growth  "}');
	perform pg_temp.wake_assert(not v_result ? 'refused','A name with extra spaces finds its section');
end $$;
select pg_temp.wake_error($q$select pg_temp.agent_sidebar('{"action":"move_agent","agentId":"30000000-0000-4000-8000-000000000031"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.agent_sidebar('{"action":"list","extra":true}')$q$,'22023');
select pg_temp.member_error('30000000-0000-4000-8000-000000000001',
	'{"action":"move_agent","staffAgentId":"30000000-0000-4000-8000-000000000031","sectionId":null,"unpin":"yes"}','22023');
-- Only members call the member RPCs and only the runner calls the agent RPC.
do $$
begin
	perform pg_temp.wake_assert(not has_function_privilege('anon','public.qorpera_read_company_sidebar(uuid)','execute')
		and not has_function_privilege('anon','public.qorpera_manage_company_sidebar(uuid,jsonb)','execute')
		and not has_function_privilege('authenticated','public.qorpera_manage_agent_sidebar(jsonb,jsonb)','execute')
		and not has_function_privilege('qorpera_secret_broker','public.qorpera_manage_agent_sidebar(jsonb,jsonb)','execute')
		and not has_function_privilege('qorpera_secret_broker','public.qorpera_manage_company_sidebar(uuid,jsonb)','execute')
		and has_function_privilege('service_role','public.qorpera_manage_agent_sidebar(jsonb,jsonb)','execute'),
		'Sidebar RPC grants');
end $$;
-- The agent RPC is the runner's; a member cannot call it, and an agent cannot call the member RPC.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_manage_agent_sidebar(current_setting('qorpera_test.sidebar_binding')::jsonb,'{"action":"list"}')$q$,'42501');
select pg_temp.path_claims('service_role');
select pg_temp.wake_error($q$select public.qorpera_manage_company_sidebar('30000000-0000-4000-8000-000000000010','{"action":"set_pins","order":[]}')$q$,'42501');

-- An archived agent leaves every list but keeps its place for a return.
do $$
begin
	update public.qorpera_profile_staff set employment_status = 'archived'
	where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000031';
	perform pg_temp.wake_assert(not exists (select 1 from jsonb_array_elements(
		pg_temp.member_read('30000000-0000-4000-8000-000000000003') -> 'pinned') pin
		where pin #>> '{}' = '30000000-0000-4000-8000-000000000031'),'An archived agent is not pinned');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_sidebar_placements
		where staff_agent_id = '30000000-0000-4000-8000-000000000031'),'Its placement is kept');
	perform pg_temp.wake_assert(not exists (select 1 from jsonb_array_elements(
		pg_temp.agent_sidebar('{"action":"list"}') -> 'unassigned') agent
		where agent ->> 'id' = '30000000-0000-4000-8000-000000000031'),'An archived agent is not listed');
end $$;

-- Members read only the revision row, for Realtime hints, and only for their own companies.
do $$
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
	set local role authenticated;
	if (select count(*) from public.qorpera_company_sidebar_revisions) <> 1 then
		raise exception 'a member could not read the company''s sidebar revision'; end if;
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
		insert into public.qorpera_company_sidebar_sections(id,profile_id,name,position)
		values ('51000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000010','Direct',9);
		raise exception 'a member wrote a section directly';
	exception when insufficient_privilege then null;
	end;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000077');
	if (select count(*) from public.qorpera_company_sidebar_revisions) <> 0 then
		raise exception 'an outsider read the company''s sidebar revision'; end if;
	reset role;
	perform pg_temp.path_claims('service_role');
end $$;

-- Runtime v95: a company keeps any number of sections (was 40).
do $$
declare v_index integer; v_state jsonb;
begin
	for v_index in 1..41 loop
		v_state := pg_temp.member_sidebar('30000000-0000-4000-8000-000000000001',jsonb_build_object('action','create_section',
			'sectionId',extensions.gen_random_uuid(),'name','Team ' || v_index));
	end loop;
	perform pg_temp.wake_assert((select count(*) > 41 from public.qorpera_company_sidebar_sections
		where profile_id = '30000000-0000-4000-8000-000000000010'),'A company keeps more than forty-one sections');
end $$;

rollback;

-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The Co-Founder deals agents out to members (20260930702000), on the folder-v2 runtime base: Owner (…001), Member
-- (…002, contributor), Viewer (…003) and Admin (…004); agents Alice (…030), Bob (…031) and Carol, all hired in the
-- owner's commit, so they work for the owner. Here Alice is made the company's Co-Founder, so her live run deals.

do $$
begin
	-- Only the host's calls reach the deals; members and anon never do.
	if has_function_privilege('authenticated', 'public.qorpera_offer_agents_to_member(jsonb,jsonb)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_offer_agents_to_member(jsonb,jsonb)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_cofounder_crew(jsonb)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_cofounder_offer_run(jsonb)', 'EXECUTE') then
		raise exception 'API clients can deal agents'; end if;
	if (select count(*) from public.qorpera_native_host_calls
		where name in ('qorpera_cofounder_crew', 'qorpera_offer_agents_to_member') and scope = 'binding') <> 2 then
		raise exception 'the deals are not host calls'; end if;
end $$;

-- Alice is the Co-Founder (foreign keys and triggers off only while the row changes).
set local session_replication_role = replica;
delete from public.qorpera_company_cofounders where profile_id = '92400000-0000-4000-8000-000000000010';
insert into public.qorpera_company_cofounders(profile_id, environment_id, staff_agent_id, created_by_user_id, created_at)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000001', statement_timestamp());
set local session_replication_role = origin;

-- The members' names, as their accounts give them.
update auth.users set raw_user_meta_data = jsonb_build_object('display_name', case id
		when '92400000-0000-4000-8000-000000000001' then 'Owner One' when '92400000-0000-4000-8000-000000000002' then 'Member Two'
		when '92400000-0000-4000-8000-000000000003' then 'Viewer Three' else 'Admin Four' end)
where id in ('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002',
	'92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000004');
update public.qorpera_profile_members set display_name = case user_id
		when '92400000-0000-4000-8000-000000000001' then 'Owner One' when '92400000-0000-4000-8000-000000000002' then 'Member Two'
		when '92400000-0000-4000-8000-000000000003' then 'Viewer Three' else 'Admin Four' end
where profile_id = '92400000-0000-4000-8000-000000000010';

create function pg_temp.offer(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_offer_agents_to_member(current_setting('qorpera_test.base_binding')::jsonb, p_request)
$$;
create function pg_temp.refused(p_request jsonb, p_state text, p_text text) returns void language plpgsql as $$
begin
	perform pg_temp.offer(p_request);
	raise exception 'expected % from %', p_state, p_request;
exception when others then
	if sqlstate <> p_state or position(p_text in sqlerrm) = 0 then
		raise exception 'expected % "%" from %, got %: %', p_state, p_text, p_request, sqlstate, sqlerrm; end if;
end $$;

do $$
declare v jsonb;
begin
	-- 1. What the Co-Founder sees: the members with their login state, the agents with whom they work for, no asks.
	v := public.qorpera_cofounder_crew(current_setting('qorpera_test.base_binding')::jsonb);
	if v ->> 'schema' <> 'qorpera.cofounder-crew/v1' or jsonb_array_length(v -> 'members') <> 4
		or (select m -> 'login' ->> 'state' from jsonb_array_elements(v -> 'members') m where m ->> 'name' = 'Owner One') <> 'ready'
		or (select m -> 'login' ->> 'state' from jsonb_array_elements(v -> 'members') m where m ->> 'name' = 'Viewer Three') <> 'none'
		or (select a ->> 'worksFor' from jsonb_array_elements(v -> 'agents') a where a ->> 'name' = 'Bob')
			<> '92400000-0000-4000-8000-000000000001'
		or exists (select 1 from jsonb_array_elements(v -> 'agents') a where a ->> 'name' = 'Alice')
		or jsonb_array_length(v -> 'asks') <> 0 then
		raise exception 'the crew read is wrong: %', v; end if;

	-- 2. Bob and Carol offered to Member by first name, with a reason: two asks Member answers.
	v := pg_temp.offer('{"member": "member", "agents": ["Bob", "carol"], "why": "You said you run sales."}');
	if v ->> 'schema' <> 'qorpera.agent-offers/v1' or v ->> 'member' <> 'Member Two'
		or v -> 'asked' <> '["Bob", "Carol"]' or v -> 'alreadyTheirs' <> '[]' or v -> 'alreadyAsked' <> '[]' then
		raise exception 'the offer is wrong: %', v; end if;
	if (select count(*) from public.qorpera_agent_works_for_asks
		where profile_id = '92400000-0000-4000-8000-000000000010' and status = 'open'
			and asked_by_staff_agent_id = '92400000-0000-4000-8000-000000000030' and asked_by_user_id is null
			and to_user_id = '92400000-0000-4000-8000-000000000002' and answer_by_user_id = '92400000-0000-4000-8000-000000000002'
			and from_user_id = '92400000-0000-4000-8000-000000000001' and why = 'You said you run sales.') <> 2 then
		raise exception 'the asks are not the Co-Founder''s to Member'; end if;

	-- 3. The same offer again asks nothing twice.
	v := pg_temp.offer('{"member": "base-member@example.test", "agents": ["Bob", "Carol"]}');
	if v -> 'asked' <> '[]' or v -> 'alreadyAsked' <> '["Bob", "Carol"]' then raise exception 'an offer asked twice: %', v; end if;

	-- 4. An agent that already works for the member is said so.
	v := pg_temp.offer('{"member": "Owner One", "agents": ["Co-Founder"]}');
	if v -> 'asked' <> '[]' or v -> 'alreadyTheirs' <> '["Co-Founder"]' then raise exception 'an agent of theirs was asked: %', v; end if;
end $$;

-- 5. Refusals name who there is, and change nothing.
select pg_temp.refused('{"member": "Viewer", "agents": ["Bob"]}', '22023', 'Viewer Three is a viewer');
select pg_temp.refused('{"member": "Nobody", "agents": ["Bob"]}', '22023', 'The members are: Owner One, Member Two, Admin Four');
select pg_temp.refused('{"member": "Admin", "agents": ["Zed"]}', '22023', 'no agent called Zed');
select pg_temp.refused('{"member": "Admin", "agents": []}', '22023', 'a list of 1 to 20 agents');

-- 6. A run of an agent that is not the Co-Founder deals nothing.
set local session_replication_role = replica;
update public.qorpera_company_cofounders set staff_agent_id = '92400000-0000-4000-8000-000000000033'
where profile_id = '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;
select pg_temp.refused('{"member": "Admin", "agents": ["Carol"]}', '42501', 'Only the Co-Founder deals agents');
set local session_replication_role = replica;
update public.qorpera_company_cofounders set staff_agent_id = '92400000-0000-4000-8000-000000000030'
where profile_id = '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;

-- 7. Member says yes to Bob on the Members page, which shows the reason.
select set_config('request.jwt.claims', '{"sub":"92400000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v jsonb := public.qorpera_read_works_for('92400000-0000-4000-8000-000000000010');
	v_ask jsonb;
begin
	select ask into v_ask from jsonb_array_elements(v -> 'asks') as ask
	where ask ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000031';
	if v_ask ->> 'why' <> 'You said you run sales.' or v_ask ->> 'asked_by_staff_agent_id' <> '92400000-0000-4000-8000-000000000030' then
		raise exception 'the page does not show the Co-Founder''s ask: %', v_ask; end if;
	if public.qorpera_answer_works_for((v_ask ->> 'id')::uuid, true) ->> 'status' <> 'yes' then raise exception 'Member''s yes'; end if;
	if (select agent ->> 'user_id' from jsonb_array_elements(public.qorpera_read_works_for('92400000-0000-4000-8000-000000000010')
		-> 'agents') as agent where agent ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000031')
		<> '92400000-0000-4000-8000-000000000002' then raise exception 'Bob does not work for Member'; end if;
end $$;
reset role;


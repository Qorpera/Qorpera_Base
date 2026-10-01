-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Company state files, thin writers W4b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5; RUNTIME-COMPANY-FOLDER-C2.md
-- §5): a run's group chat, as create_group_chat saves it. One new folder agents/groups/<handle> with group.md, staged by
-- the run and saved with the review recorded for exactly that change set. The commit opens the chat's room and
-- conversation, with its agents and the run's requester as members. Without the review nothing is saved, a run's
-- chat may add only the member its run works for, and only active agents. Runs are 647's hand-built runs, on 769's helpers.

create function pg_temp.group_text(p_id uuid, p_agents uuid[], p_people uuid[]) returns text language sql as $$
	-- As writeGroupFile writes it: an empty list is "[]".
	select format(E'---\nid: %s\nname: Launch\nagents:\n%s%s---\nPlan the launch.\n', p_id,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a),
		case when coalesce(cardinality(p_people), 0) = 0 then E'people: []\n'
			else E'people:\n' || (select string_agg(format(E'  - %s\n', a), '') from unnest(p_people) a) end)
$$;
create function pg_temp.group_parse(p_id uuid, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('kind','group','id',p_id,'name','Launch','subtitle',null,'agents',to_jsonb(p_agents),
		'people',to_jsonb(coalesce(p_people, '{}'::uuid[])),'purpose','Plan the launch.')
$$;
-- The chat's one unit, staged by the actor that commits it (a version-2 file is held to possession).
create function pg_temp.chat(p_actor jsonb, p_handle text, p_id uuid, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_agents, p_people), p_actor))),
		'structured', jsonb_build_array(jsonb_build_object('path','agents/groups/' || p_handle || '/group.md','kind','group',
			'text',pg_temp.group_text(p_id, p_agents, p_people),'parse',pg_temp.group_parse(p_id, p_agents, p_people),'parserVersion',1))))
$$;

-- The groups folder, as the seeded tree has it.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'run-chat-setup', '[{"op":"mkdir","path":"agents"},{"op":"mkdir","path":"agents/groups"}]'),
	2, 'saved') \g /dev/null

do $$
declare
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	c_member constant uuid := '63400000-0000-4000-8000-000000000002'; c_other constant uuid := '63400000-0000-4000-8000-000000000004';
	c_chat constant uuid := '77700000-0000-4000-8000-0000000000c1';
	x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
	g public.qorpera_company_rooms%rowtype;
begin
	-- 1. Unreviewed: denied, and no room.
	u := pg_temp.chat(p, 'launch', c_chat, array[c_a, c_b], array[c_member]);
	perform pg_temp.expect(pg_temp.commit(p, 'run-chat-none', u), 1, 'denied', 'review_required');
	if exists (select 1 from public.qorpera_company_rooms where id = c_chat) then raise exception 'An unreviewed chat opens nothing'; end if;
	-- 2. Reviewed: saved; the room is the chat's, with its agents and the requester as members.
	r := pg_temp.record(b, pg_temp.action(b, 'call-chat-1', 'allow', 'delegation', 'create_group_chat'), u);
	c := pg_temp.commit(p, 'run-chat-0001', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	select * into g from public.qorpera_company_rooms where id = c_chat;
	if g.room_key is distinct from 'chat-' || c_chat or g.name is distinct from 'Launch' or g.bound_staff_agent_id is not null
		or g.purpose is distinct from 'Plan the launch.' then
		raise exception 'The chat opens its room: %', to_jsonb(g); end if;
	if (select count(*) from public.qorpera_company_room_members where room_id = c_chat and status = 'active'
			and principal_id in (c_a, c_b, c_member)) <> 3 then
		raise exception 'The chat''s members are its agents and the requester'; end if;
	-- 3. A run's chat may add only the member its run works for, even when reviewed.
	u := pg_temp.chat(p, 'launch-other', '77700000-0000-4000-8000-0000000000c2', array[c_a, c_b], array[c_other]);
	r := pg_temp.record(b, pg_temp.action(b, 'call-chat-2', 'allow', 'delegation', 'create_group_chat'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'run-chat-0002', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_rule');
	-- 4. An agent the chat adds must be active: an archived coworker is refused (restored after).
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = %L where profile_id = %L and staff_agent_id = %L',
		'archived', '63400000-0000-4000-8000-000000000010', c_b));
	u := pg_temp.chat(p, 'launch-archived', '77700000-0000-4000-8000-0000000000c4', array[c_a, c_b], array[c_member]);
	r := pg_temp.record(b, pg_temp.action(b, 'call-chat-4', 'allow', 'delegation', 'create_group_chat'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'run-chat-0004', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_rule');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = %L where profile_id = %L and staff_agent_id = %L',
		'active', '63400000-0000-4000-8000-000000000010', c_b));
	-- 5. Without the member, and with one agent too few: the file's own rule.
	u := pg_temp.chat(p, 'launch-alone', '77700000-0000-4000-8000-0000000000c3', array[c_a], null);
	r := pg_temp.record(b, pg_temp.action(b, 'call-chat-3', 'allow', 'delegation', 'create_group_chat'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'run-chat-0003', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_invalid');
	if exists (select 1 from public.qorpera_company_rooms where id in ('77700000-0000-4000-8000-0000000000c2', '77700000-0000-4000-8000-0000000000c3',
			'77700000-0000-4000-8000-0000000000c4')) then
		raise exception 'A refused chat opens nothing'; end if;
end $$;

rollback;

-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Mentions in group chat posts on folder-v2 (ported from snapshot-v1 in the legacy sweep): agents named in a group chat
-- answer and the others are not woken; a named agent must answer, an agent nobody named may stay silent; a named member
-- sees the post as an unseen mention until they open the conversation. The group chat is a group.md the owner saves.
select pg_temp.base_claims('service_role');

-- A group chat of the owner (Owen), the member (Mia) and the agents Bob and Carol. Member names follow the account's own
-- name (the trigger of 20260926000000_account_display_names), as when a member renames themself.
update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name',
	case id when '92400000-0000-4000-8000-000000000001' then 'Owen' else 'Mia' end)
where id in ('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_assert((select string_agg(display_name, ',' order by user_id) = 'Owen,Mia'
	from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
		and user_id in ('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002')),
	'Fixture: the owner is Owen and the member Mia');
select pg_temp.base_commit(pg_temp.base_owner(), 'mn-group-launch', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
	jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/launch',
		'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(g.text))),
		'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/groups/launch/group.md', 'kind', 'group', 'text', g.text,
			'parse', jsonb_build_object('kind', 'group', 'id', '62600000-0000-4000-8000-000000000628', 'name', 'Launch', 'subtitle', null,
				'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
				'people', '["92400000-0000-4000-8000-000000000001","92400000-0000-4000-8000-000000000002"]'::jsonb, 'purpose', 'Plan the launch.'),
			'parserVersion', 1)))))
from (select E'---\nid: 62600000-0000-4000-8000-000000000628\nname: Launch\nagents:\n  - 92400000-0000-4000-8000-000000000031\n'
	|| E'  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n'
	|| E'  - 92400000-0000-4000-8000-000000000002\n---\nPlan the launch.\n' as text) g \g /dev/null
select set_config('qorpera_test.mn_session', (select session_id::text from public.qorpera_company_rooms
	where id = '62600000-0000-4000-8000-000000000628'), true);

-- The owner posts on their own sponsor, as a browser does; returns who woke.
create function pg_temp.mn_post(p_text text, p_client uuid default extensions.gen_random_uuid()) returns uuid[] language plpgsql as $$
declare v_result jsonb; v_woken uuid[];
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_post_company_room_message('62600000-0000-4000-8000-000000000628', p_client,
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	reset role;
	perform pg_temp.base_claims('service_role');
	select coalesce(array_agg(staff_agent_id order by staff_agent_id), '{}') into v_woken from public.qorpera_wake_occurrences
	where id in (select jsonb_array_elements_text(v_result -> 'occurrenceIds')::uuid);
	perform set_config('qorpera_test.mn_input', v_result ->> 'inputId', true);
	return v_woken;
end $$;
-- An agent's name, saved in its agent.md by the owner.
create function pg_temp.mn_rename(p_handle text, p_id uuid, p_name text) returns void language sql as $$
	select pg_temp.base_commit(pg_temp.base_owner(), 'mn-rename-' || p_handle || '-' || md5(p_name), jsonb_build_array(pg_temp.base_write(
		'QorperaOS/agents/' || p_handle || '/agent.md', 'agent', pg_temp.base_agent_text(p_id, p_name),
		jsonb_build_object('kind', 'agent', 'id', p_id, 'name', p_name, 'role', 'Research', 'agentKind', 'agent', 'status', 'active',
			'colour', null, 'figure', null, 'model', null, 'effort', null, 'instructions', 'Read and change the company folder.'),
		pg_temp.base_version('QorperaOS/agents/' || p_handle || '/agent.md'))))::text::void
$$;

do $$
declare v_both uuid[] := array['92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000032']::uuid[];
	v_bob uuid[] := array['92400000-0000-4000-8000-000000000031']::uuid[];
	v_carol uuid[] := array['92400000-0000-4000-8000-000000000032']::uuid[];
	v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_assert(pg_temp.mn_post('Plan the launch') = v_both, 'A post that names no agent wakes every agent');
	perform pg_temp.base_assert(pg_temp.mn_post('@Bob can you check the prices?', v_client) = v_bob,
		'A post that names an agent wakes that agent alone');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_room_mentions
		where input_id = current_setting('qorpera_test.mn_input')::uuid and principal_kind = 'staff_agent'
			and principal_id = '92400000-0000-4000-8000-000000000031'), 'The agent mention is recorded');
	-- The same post again (a retried request) wakes the same agent and records nothing twice.
	perform pg_temp.base_assert(pg_temp.mn_post('@Bob can you check the prices?', v_client) = v_bob,
		'A replayed post answers with the same wake');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_room_mentions
		where input_id = current_setting('qorpera_test.mn_input')::uuid), 'A replayed post records its mentions once');
	perform pg_temp.base_assert(pg_temp.mn_post('(@CAROL) and @mia, please look.') = v_carol,
		'Names are read in any case, after a bracket and before punctuation');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_room_mentions
		where input_id = current_setting('qorpera_test.mn_input')::uuid and principal_kind = 'member'
			and principal_id = '92400000-0000-4000-8000-000000000002'), 'The member mention is recorded');
	perform pg_temp.base_assert(pg_temp.mn_post('@Bob and @Carol, both of you') = v_both, 'Two agents named both answer');
	perform pg_temp.base_assert(pg_temp.mn_post('Mail bob@bob.com or ask @Bobby') = v_both,
		'An address or a longer word is not a mention');
	perform pg_temp.base_assert(pg_temp.mn_post('Thanks @Owen, noted') = v_both
		and not exists (select 1 from public.qorpera_room_mentions where input_id = current_setting('qorpera_test.mn_input')::uuid),
		'The author naming themself records nothing');
	perform pg_temp.base_assert(pg_temp.mn_post('@Alice are you there?') = v_both,
		'An agent that is not in the room is not named, so every agent in it wakes');
	perform pg_temp.base_assert(pg_temp.mn_post('Hej' || chr(160) || '@Bob can you check') = v_bob,
		'A no-break space before "@" is a space, as in the web');
	perform pg_temp.base_assert(pg_temp.mn_post('İstanbul @BOB can you check') = v_bob,
		'Other letters before a name change nothing; A-Z match in either case');
end
$$;

-- A longer name takes its letters: "@Bob Jensen" names Bob Jensen, not Bob.
savepoint mn_longer_name;
select pg_temp.mn_rename('carol', '92400000-0000-4000-8000-000000000032', 'Bob Jensen');
do $$
begin
	perform pg_temp.base_assert((select display_name from public.qorpera_profile_staff where staff_agent_id = '92400000-0000-4000-8000-000000000032')
		= 'Bob Jensen', 'Carol is now Bob Jensen');
	perform pg_temp.base_assert(pg_temp.mn_post('@Bob Jensen, the invoices') = array['92400000-0000-4000-8000-000000000032']::uuid[],
		'The longer name is read and the shorter one inside it is not');
	perform pg_temp.base_assert(pg_temp.mn_post('@Bob, the invoices') = array['92400000-0000-4000-8000-000000000031']::uuid[],
		'The shorter name alone is still read');
	perform pg_temp.base_assert(pg_temp.mn_post('@Bob Jensen @Bob Jensen, the invoices')
		= array['92400000-0000-4000-8000-000000000032']::uuid[], 'A longer name written twice in a row never names the shorter one');
end
$$;
rollback to savepoint mn_longer_name;

-- Everyone who shares a name named is named.
savepoint mn_same_name;
select pg_temp.mn_rename('carol', '92400000-0000-4000-8000-000000000032', 'Bob');
select pg_temp.base_assert(pg_temp.mn_post('@Bob, the invoices')
	= array['92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000032']::uuid[],
	'Two agents with the name named both answer');
rollback to savepoint mn_same_name;

-- A named agent must answer; an agent woken by a post that names nobody may stay silent.
do $$
declare v_named uuid; v_unnamed uuid; v_pass jsonb; v_passes integer := 0;
begin
	perform pg_temp.mn_post('@Carol what is the launch date?');
	perform pg_temp.mn_post('Anyone free for the launch?');
	-- Passes of sixteen until every wake of the posts above is a run and the company is idle.
	loop
		v_pass := pg_temp.base_materialize(16);
		v_passes := v_passes + 1;
		exit when v_pass ->> 'state' = 'idle';
		perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and v_passes < 10, 'A pass runs: ' || v_pass::text);
	end loop;
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_wake_occurrences
		where profile_id = '92400000-0000-4000-8000-000000000010' and status = 'queued'), 'Every wake is a run');
	select occurrence.run_id into strict v_named from public.qorpera_wake_occurrences occurrence
	join public.qorpera_session_inputs input on input.id = occurrence.source_id
	where input.body ->> 'text' = '@Carol what is the launch date?' and occurrence.run_id is not null;
	select occurrence.run_id into strict v_unnamed from public.qorpera_wake_occurrences occurrence
	join public.qorpera_session_inputs input on input.id = occurrence.source_id
	where input.body ->> 'text' = 'Anyone free for the launch?' and occurrence.run_id is not null
		and occurrence.staff_agent_id = '92400000-0000-4000-8000-000000000032';
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy_internal(v_named) ->> 'final' = 'required', 'A named agent must answer');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy_internal(v_unnamed) ->> 'final' = 'optional',
		'An agent nobody named may stay silent');
end
$$;

-- The member named sees the conversation among their unseen mentions until they open it.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
do $$
declare v_list jsonb;
begin
	v_list := public.qorpera_list_member_mentions('92400000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(v_list ->> 'schema' = 'qorpera.member-mentions/v1' and jsonb_array_length(v_list -> 'sessions') = 1
		and v_list #>> '{sessions,0,sessionId}' = current_setting('qorpera_test.mn_session')
		and (v_list #>> '{sessions,0,count}')::integer = 1, format('The member lists one unseen mention: %s', v_list));
	perform pg_temp.base_assert((public.qorpera_mark_member_mentions_seen(current_setting('qorpera_test.mn_session')::uuid) ->> 'seen')::integer = 1,
		'Opening the conversation sees the mention');
	perform pg_temp.base_assert(jsonb_array_length(public.qorpera_list_member_mentions('92400000-0000-4000-8000-000000000010') -> 'sessions') = 0,
		'A seen mention is not listed');
end
$$;
-- The owner was never named; an outsider and anon read nothing.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(jsonb_array_length(public.qorpera_list_member_mentions('92400000-0000-4000-8000-000000000010') -> 'sessions') = 0,
	'The author is not told about their own post');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error('select public.qorpera_list_member_mentions(''92400000-0000-4000-8000-000000000010'')', '42501');
select pg_temp.base_error(format('select public.qorpera_mark_member_mentions_seen(%L)', current_setting('qorpera_test.mn_session')), '42501');
reset role;
set local role anon;
select pg_temp.base_claims('anon');
select pg_temp.base_error('select public.qorpera_list_member_mentions(''92400000-0000-4000-8000-000000000010'')', '42501');
reset role;
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(not has_table_privilege('authenticated', 'public.qorpera_room_mentions', 'select'),
	'Members cannot read the mentions table directly');

rollback;

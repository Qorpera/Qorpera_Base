-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Mentions in room posts (20260928010000): agents named in a group chat answer and
-- the others are not woken; a named agent must answer; a named member sees the post
-- as an unseen mention until they open the conversation.

-- A group chat of the owner (Owen), the member (Mia) and the agents Bob and Carol.
-- Member names follow the account's own name (the trigger of 20260926000000_account_display_names), as when a member renames themself.
update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name',
	case id when '30000000-0000-4000-8000-000000000001' then 'Owen' else 'Mia' end)
where id in ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert((select string_agg(display_name, ',' order by user_id) = 'Owen,Mia'
	from public.qorpera_profile_members where profile_id = '30000000-0000-4000-8000-000000000010'
		and user_id in ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002')),
	'Fixture: the owner is Owen and the member Mia');
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,execution_scope)
values ('30000000-0000-4000-8000-000000000626','30000000-0000-4000-8000-000000000627',
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020','Launch','open',
	'30000000-0000-4000-8000-000000000001',jsonb_build_object('roomId','30000000-0000-4000-8000-000000000628'));
insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,session_id,version,
	source_path,source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id)
values ('30000000-0000-4000-8000-000000000628','30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000020','launch','Launch','Plan the launch','active',
	'30000000-0000-4000-8000-000000000626',1,'organization/rooms/launch.json',
	'30000000-0000-4000-8000-000000000629','30000000-0000-4000-8000-00000000062a',repeat('c',64),
	'30000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_room_members(room_id,principal_kind,principal_id,status,source_path_version)
select '30000000-0000-4000-8000-000000000628',kind,id,'active','30000000-0000-4000-8000-000000000629'
from (values ('member','30000000-0000-4000-8000-000000000001'::uuid),('member','30000000-0000-4000-8000-000000000002'::uuid),
	('staff_agent','30000000-0000-4000-8000-000000000031'::uuid),('staff_agent','30000000-0000-4000-8000-000000000032'::uuid))
	as member(kind,id);

-- The owner posts on their own sponsor, as a browser does; returns who woke.
create function pg_temp.mention_post(p_text text, p_client uuid default extensions.gen_random_uuid())
returns uuid[] language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_result jsonb; v_woken uuid[];
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_post_company_room_message('30000000-0000-4000-8000-000000000628',p_client,
		jsonb_build_object('schema','qorpera.session-prompt/v1','text',p_text),v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	select coalesce(array_agg(staff_agent_id order by staff_agent_id),'{}') into v_woken from public.qorpera_wake_occurrences
	where id in (select jsonb_array_elements_text(v_result -> 'occurrenceIds')::uuid);
	perform set_config('qorpera_test.mention_input',v_result ->> 'inputId',true);
	return v_woken;
end
$$;

do $$
declare v_both uuid[] := array['30000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000032']::uuid[];
	v_bob uuid[] := array['30000000-0000-4000-8000-000000000031']::uuid[];
	v_carol uuid[] := array['30000000-0000-4000-8000-000000000032']::uuid[];
	v_client uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.wake_assert(pg_temp.mention_post('Plan the launch') = v_both, 'A post that names no agent wakes every agent');
	perform pg_temp.wake_assert(pg_temp.mention_post('@Bob can you check the prices?', v_client) = v_bob,
		'A post that names an agent wakes that agent alone');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_room_mentions
		where input_id = current_setting('qorpera_test.mention_input')::uuid and principal_kind = 'staff_agent'
			and principal_id = '30000000-0000-4000-8000-000000000031'), 'The agent mention is recorded');
	-- The same post again (a retried request) wakes the same agent and records nothing twice.
	perform pg_temp.wake_assert(pg_temp.mention_post('@Bob can you check the prices?', v_client) = v_bob,
		'A replayed post answers with the same wake');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_room_mentions
		where input_id = current_setting('qorpera_test.mention_input')::uuid), 'A replayed post records its mentions once');
	perform pg_temp.wake_assert(pg_temp.mention_post('(@CAROL) and @mia, please look.') = v_carol,
		'Names are read in any case, after a bracket and before punctuation');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_room_mentions
		where input_id = current_setting('qorpera_test.mention_input')::uuid and principal_kind = 'member'
			and principal_id = '30000000-0000-4000-8000-000000000002'), 'The member mention is recorded');
	perform pg_temp.wake_assert(pg_temp.mention_post('@Bob and @Carol, both of you') = v_both,
		'Two agents named both answer');
	perform pg_temp.wake_assert(pg_temp.mention_post('Mail bob@bob.com or ask @Bobby') = v_both,
		'An address or a longer word is not a mention');
	perform pg_temp.wake_assert(pg_temp.mention_post('Thanks @Owen, noted') = v_both
		and not exists (select 1 from public.qorpera_room_mentions where input_id = current_setting('qorpera_test.mention_input')::uuid),
		'The author naming themself records nothing');
	perform pg_temp.wake_assert(pg_temp.mention_post('@Agent are you there?') = v_both,
		'An agent that is not in the room is not named, so every agent in it wakes');
	perform pg_temp.wake_assert(pg_temp.mention_post('Hej' || chr(160) || '@Bob can you check') = v_bob,
		'A no-break space before "@" is a space, as in the web');
	perform pg_temp.wake_assert(pg_temp.mention_post('İstanbul @BOB can you check') = v_bob,
		'Other letters before a name change nothing; A-Z match in either case');
end
$$;

-- A longer name takes its letters: "@Bob Jensen" names Bob Jensen, not Bob.
savepoint longer_name;
update public.qorpera_profile_staff set display_name = 'Bob Jensen' where staff_agent_id = '30000000-0000-4000-8000-000000000032';
do $$
begin
	perform pg_temp.wake_assert(pg_temp.mention_post('@Bob Jensen, the invoices') = array['30000000-0000-4000-8000-000000000032']::uuid[],
		'The longer name is read and the shorter one inside it is not');
	perform pg_temp.wake_assert(pg_temp.mention_post('@Bob, the invoices') = array['30000000-0000-4000-8000-000000000031']::uuid[],
		'The shorter name alone is still read');
	perform pg_temp.wake_assert(pg_temp.mention_post('@Bob Jensen @Bob Jensen, the invoices')
		= array['30000000-0000-4000-8000-000000000032']::uuid[], 'A longer name written twice in a row never names the shorter one');
end
$$;
rollback to longer_name;

-- Everyone who shares a name named is named.
savepoint same_name;
update public.qorpera_profile_staff set display_name = 'Bob' where staff_agent_id = '30000000-0000-4000-8000-000000000032';
select pg_temp.wake_assert(pg_temp.mention_post('@Bob, the invoices')
	= array['30000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000032']::uuid[],
	'Two agents with the name named both answer');
rollback to same_name;

-- A named agent must answer; an agent woken by a post that names nobody may stay silent.
do $$
declare v_named uuid; v_unnamed uuid;
begin
	perform pg_temp.mention_post('@Carol what is the launch date?');
	select run_id into v_named from public.qorpera_wake_occurrences where source_id = current_setting('qorpera_test.mention_input')::uuid;
	perform pg_temp.mention_post('Anyone free for the launch?');
	perform public.qorpera_materialize_wake_execution_runs(32);
	select occurrence.run_id into strict v_named from public.qorpera_wake_occurrences occurrence
	join public.qorpera_session_inputs input on input.id = occurrence.source_id
	where input.body ->> 'text' = '@Carol what is the launch date?' and occurrence.run_id is not null;
	select occurrence.run_id into strict v_unnamed from public.qorpera_wake_occurrences occurrence
	join public.qorpera_session_inputs input on input.id = occurrence.source_id
	where input.body ->> 'text' = 'Anyone free for the launch?' and occurrence.run_id is not null
		and occurrence.staff_agent_id = '30000000-0000-4000-8000-000000000032';
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy_internal(v_named) ->> 'final' = 'required',
		'A named agent must answer');
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy_internal(v_unnamed) ->> 'final' = 'optional',
		'An agent nobody named may stay silent');
end
$$;

-- The member named sees the conversation among their unseen mentions until they open it.
set local role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
do $$
declare v_list jsonb;
begin
	v_list := public.qorpera_list_member_mentions('30000000-0000-4000-8000-000000000010');
	perform pg_temp.wake_assert(v_list ->> 'schema' = 'qorpera.member-mentions/v1' and jsonb_array_length(v_list -> 'sessions') = 1
		and v_list #>> '{sessions,0,sessionId}' = '30000000-0000-4000-8000-000000000626'
		and (v_list #>> '{sessions,0,count}')::integer = 1, format('The member lists one unseen mention: %s', v_list));
	perform pg_temp.wake_assert((public.qorpera_mark_member_mentions_seen('30000000-0000-4000-8000-000000000626') ->> 'seen')::integer = 1,
		'Opening the conversation sees the mention');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_member_mentions('30000000-0000-4000-8000-000000000010') -> 'sessions') = 0,
		'A seen mention is not listed');
end
$$;
-- The owner was never named; an outsider and anon read nothing.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_member_mentions('30000000-0000-4000-8000-000000000010') -> 'sessions') = 0,
	'The author is not told about their own post');
reset role;
insert into auth.users(id,email) values ('30000000-0000-4000-8000-00000000062b','mention-outsider@example.test');
set local role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-00000000062b');
select pg_temp.wake_error('select public.qorpera_list_member_mentions(''30000000-0000-4000-8000-000000000010'')','42501');
select pg_temp.wake_error('select public.qorpera_mark_member_mentions_seen(''30000000-0000-4000-8000-000000000626'')','42501');
reset role;
set local role anon;
select pg_temp.wake_error('select public.qorpera_list_member_mentions(''30000000-0000-4000-8000-000000000010'')','42501');
reset role;
select pg_temp.wake_assert(not has_table_privilege('authenticated','public.qorpera_room_mentions','select'),
	'Members cannot read the mentions table directly');

rollback;

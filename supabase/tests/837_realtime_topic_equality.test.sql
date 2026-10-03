-- Realtime topic equality (20260930017000): a member joined to one private topic reads only that topic's rows, and
-- publishes only on it. Realtime checks a private join by reading realtime.messages as the member with
-- realtime.topic() set to the joined topic, and Postgres joins a table's policies with OR, so every policy has to ask
-- for the row's own topic. Without that, the presence and room drafts policies let a member joined to their company's
-- presence topic (or to a room's drafts topic) read every other topic's broadcasts: a folder hint, another room's
-- drafts, another company's presence. Each check below names the counts it would have seen without it.

begin;

-- M owns two companies and is in both rooms of the first; S is in no company.
insert into auth.users (id, email) values
	('98370000-0000-4000-8000-00000000000a', 'topic-member@example.test'),
	('98370000-0000-4000-8000-0000000000f0', 'topic-stranger@example.test');
insert into public.qorpera_profiles (id, name, created_by_user_id) values
	('98370000-0000-4000-8000-000000000010', 'Topic QA', '98370000-0000-4000-8000-00000000000a'),
	('98370000-0000-4000-8000-000000000011', 'Topic QA other', '98370000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role) values
	('98370000-0000-4000-8000-000000000010', '98370000-0000-4000-8000-00000000000a', 'topic-member@example.test', 'Mo', 'owner'),
	('98370000-0000-4000-8000-000000000011', '98370000-0000-4000-8000-00000000000a', 'topic-member@example.test', 'Mo', 'owner');
insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id) values
	('98370000-0000-4000-8000-000000000020', '98370000-0000-4000-8000-000000000010', 'Environment', 1,
		'98370000-0000-4000-8000-00000000000a');
insert into public.qorpera_shared_sessions (id, profile_id, environment_id, title, created_by_user_id, audience_kind, execution_scope)
select room.session_id, '98370000-0000-4000-8000-000000000010', '98370000-0000-4000-8000-000000000020', room.name,
	'98370000-0000-4000-8000-00000000000a', 'company', jsonb_build_object('roomId', room.id)
from (values
	('98370000-0000-4000-8000-000000000060'::uuid, '98370000-0000-4000-8000-000000000050'::uuid, 'Launch'),
	('98370000-0000-4000-8000-000000000061'::uuid, '98370000-0000-4000-8000-000000000051'::uuid, 'Hiring')
) as room(id, session_id, name);
insert into public.qorpera_company_rooms (id, profile_id, environment_id, room_key, name, purpose, status, session_id,
	version, source_path, source_path_version, source_snapshot_id, source_file_sha256, created_by_user_id)
select room.id, '98370000-0000-4000-8000-000000000010', '98370000-0000-4000-8000-000000000020', room.room_key, room.name,
	room.name || ' planning', 'active', room.session_id, 1, 'organization/rooms/' || room.room_key || '.json',
	room.path_version, '98370000-0000-4000-8000-000000000070', repeat('d', 64), '98370000-0000-4000-8000-00000000000a'
from (values
	('98370000-0000-4000-8000-000000000060'::uuid, '98370000-0000-4000-8000-000000000050'::uuid, 'launch', 'Launch',
		'98370000-0000-4000-8000-000000000062'::uuid),
	('98370000-0000-4000-8000-000000000061'::uuid, '98370000-0000-4000-8000-000000000051'::uuid, 'hiring', 'Hiring',
		'98370000-0000-4000-8000-000000000063'::uuid)
) as room(id, session_id, room_key, name, path_version);
insert into public.qorpera_company_room_members (room_id, principal_kind, principal_id, status, source_path_version) values
	('98370000-0000-4000-8000-000000000060', 'member', '98370000-0000-4000-8000-00000000000a', 'active',
		'98370000-0000-4000-8000-000000000062'),
	('98370000-0000-4000-8000-000000000061', 'member', '98370000-0000-4000-8000-00000000000a', 'active',
		'98370000-0000-4000-8000-000000000063');

-- One company's presence (a track and a typing broadcast), the other company's presence, each room's drafts, and the
-- first company's folder hint, as the platform and the database leave them.
insert into realtime.messages (topic, extension, payload, event, private) values
	('qorpera-presence-98370000-0000-4000-8000-000000000010', 'presence', '{}', 'track', true),
	('qorpera-presence-98370000-0000-4000-8000-000000000010', 'broadcast', '{}', 'typing', true),
	('qorpera-presence-98370000-0000-4000-8000-000000000011', 'presence', '{}', 'track', true),
	('qorpera-presence-98370000-0000-4000-8000-000000000011', 'broadcast', '{}', 'typing', true),
	('qorpera-room-drafts-98370000-0000-4000-8000-000000000060', 'broadcast', '{"body":"Launch on Friday"}', 'draft', true),
	('qorpera-room-drafts-98370000-0000-4000-8000-000000000061', 'broadcast', '{"body":"Hire a designer"}', 'draft', true),
	('qorpera-folder-98370000-0000-4000-8000-000000000020', 'broadcast', '{"schema":"qorpera.folder-hint/v1","seq":1}',
		'folder', true);

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.as_user(p_user text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true)::text::void
$$;
-- What the user reads while joined to p_topic, as Realtime asks it: '<rows of that topic>/<rows of any other topic>'.
create function pg_temp.reads(p_user text, p_topic text) returns text language plpgsql as $$
declare v_own bigint; v_other bigint;
begin
	perform pg_temp.as_user(p_user);
	perform set_config('realtime.topic', p_topic, true);
	set local role authenticated;
	select count(*) filter (where message.topic = p_topic), count(*) filter (where message.topic <> p_topic)
	into v_own, v_other from realtime.messages as message;
	reset role;
	perform set_config('realtime.topic', '', true);
	return v_own || '/' || v_other;
end $$;
-- Whether the user, joined to p_joined, may write a broadcast row on p_topic: 'published' or the refusal's code.
create function pg_temp.publishes(p_user text, p_joined text, p_topic text) returns text language plpgsql as $$
declare v_result text := 'published';
begin
	perform pg_temp.as_user(p_user);
	perform set_config('realtime.topic', p_joined, true);
	set local role authenticated;
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values (p_topic, 'broadcast', '{"body":"forged"}', 'typing', true);
	exception when insufficient_privilege then v_result := sqlstate;
	end;
	reset role;
	perform set_config('realtime.topic', '', true);
	return v_result;
end $$;

-- The policies keep their roles and command; every policy on realtime.messages asks for the joined topic.
do $$
declare v_policy record;
begin
	perform pg_temp.same((select string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' ' order by policyname)
		from pg_policies where schemaname = 'realtime' and tablename = 'messages'
			and policyname in ('qorpera_presence_member_receive', 'qorpera_presence_member_publish',
				'qorpera_room_drafts_member_receive')),
		'qorpera_presence_member_publish:INSERT:authenticated qorpera_presence_member_receive:SELECT:authenticated '
			|| 'qorpera_room_drafts_member_receive:SELECT:authenticated', 'the three policies');
	for v_policy in select policyname, coalesce(qual, with_check) as rule from pg_policies
		where schemaname = 'realtime' and tablename = 'messages' loop
		if v_policy.rule not like '%topic = ( SELECT realtime.topic()%' then
			raise exception 'policy % on realtime.messages does not ask for the joined topic: %', v_policy.policyname, v_policy.rule;
		end if;
	end loop;
end $$;

-- Joined to a presence topic, the member reads that company's presence and nothing else. Without the topic check:
-- the other company's presence, both rooms' drafts and the folder hint as well.
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-00000000000a', 'qorpera-presence-98370000-0000-4000-8000-000000000010'),
	'2/0', 'joined to the first company''s presence');
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-00000000000a', 'qorpera-presence-98370000-0000-4000-8000-000000000011'),
	'2/0', 'joined to the other company''s presence');

-- Joined to a room's drafts topic, the member reads that room's drafts and nothing else. Without the topic check: the
-- other room's drafts, both companies' typing broadcasts and the folder hint as well.
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-00000000000a', 'qorpera-room-drafts-98370000-0000-4000-8000-000000000060'),
	'1/0', 'joined to the first room''s drafts');
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-00000000000a', 'qorpera-room-drafts-98370000-0000-4000-8000-000000000061'),
	'1/0', 'joined to the second room''s drafts');

-- Someone in no company still reads nothing anywhere.
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-0000000000f0', 'qorpera-presence-98370000-0000-4000-8000-000000000010'),
	'0/0', 'a stranger joined to the presence topic');
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-0000000000f0', 'qorpera-room-drafts-98370000-0000-4000-8000-000000000060'),
	'0/0', 'a stranger joined to a drafts topic');

-- Joined to a presence topic, the member publishes there and nowhere else: not on a room's drafts or the folder hint,
-- where only the database publishes, and not on the other company's presence. Without the topic check all three
-- were accepted.
select pg_temp.same(pg_temp.publishes('98370000-0000-4000-8000-00000000000a',
	'qorpera-presence-98370000-0000-4000-8000-000000000010', 'qorpera-presence-98370000-0000-4000-8000-000000000010'),
	'published', 'typing on the joined presence topic');
select pg_temp.same(pg_temp.publishes('98370000-0000-4000-8000-00000000000a',
	'qorpera-presence-98370000-0000-4000-8000-000000000010', 'qorpera-room-drafts-98370000-0000-4000-8000-000000000060'),
	'42501', 'a forged draft from the presence topic');
select pg_temp.same(pg_temp.publishes('98370000-0000-4000-8000-00000000000a',
	'qorpera-presence-98370000-0000-4000-8000-000000000010', 'qorpera-folder-98370000-0000-4000-8000-000000000020'),
	'42501', 'a forged folder hint from the presence topic');
select pg_temp.same(pg_temp.publishes('98370000-0000-4000-8000-00000000000a',
	'qorpera-presence-98370000-0000-4000-8000-000000000010', 'qorpera-presence-98370000-0000-4000-8000-000000000011'),
	'42501', 'typing on the other company''s presence from the first');
select pg_temp.same(pg_temp.reads('98370000-0000-4000-8000-00000000000a', 'qorpera-presence-98370000-0000-4000-8000-000000000010'),
	'3/0', 'the joined presence topic after the member''s own typing');

rollback;

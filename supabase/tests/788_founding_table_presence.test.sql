-- Live presence at the founding table (20260930531000): every seat of an open table, joined or invited, joins the
-- table's private topic `qorpera-founding-<profile id>`, receives and publishes there and nowhere else; and each tab's
-- device is registered and resolved only for people with a seat at that open table, so what a tab signs is tied to a
-- seat. Realtime checks a private join by reading (receive) and writing (publish) realtime.messages as the user with
-- realtime.topic() set to the joined topic; that is what pg_temp.reads and pg_temp.publishes do.

begin;

-- Anna opened the table and Bo joined it; Cy is invited; Dee sits alone at a table of her own.
insert into auth.users (id, email, raw_user_meta_data) values
	('78800000-0000-4000-8000-00000000000a', 'presence-anna@example.test', '{"display_name":"Anna"}'),
	('78800000-0000-4000-8000-00000000000b', 'presence-bo@example.test', '{"display_name":"Bo"}'),
	('78800000-0000-4000-8000-00000000000c', 'presence-cy@example.test', '{"display_name":"Cy"}'),
	('78800000-0000-4000-8000-00000000000d', 'presence-dee@example.test', '{"display_name":"Dee"}');
insert into public.qorpera_profiles (id, name, created_by_user_id) values
	('78800000-0000-4000-8000-000000000010', 'Nordlys', '78800000-0000-4000-8000-00000000000a'),
	('78800000-0000-4000-8000-000000000011', 'Dee''s table', '78800000-0000-4000-8000-00000000000d');
-- Members first: once a table is open, people join it only by taking a seat.
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role) values
	('78800000-0000-4000-8000-000000000010', '78800000-0000-4000-8000-00000000000a', 'presence-anna@example.test', 'Anna', 'owner'),
	('78800000-0000-4000-8000-000000000010', '78800000-0000-4000-8000-00000000000b', 'presence-bo@example.test', 'Bo', 'contributor'),
	('78800000-0000-4000-8000-000000000011', '78800000-0000-4000-8000-00000000000d', 'presence-dee@example.test', 'Dee', 'owner');
insert into public.qorpera_company_foundings (profile_id, created_by_user_id, vision_draft) values
	('78800000-0000-4000-8000-000000000010', '78800000-0000-4000-8000-00000000000a', 'Specialty coffee.'),
	('78800000-0000-4000-8000-000000000011', '78800000-0000-4000-8000-00000000000d', '');
insert into public.qorpera_company_founder_seats (profile_id, user_id, invited_by_user_id, state, joined_at) values
	('78800000-0000-4000-8000-000000000010', '78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-00000000000a', 'joined', statement_timestamp()),
	('78800000-0000-4000-8000-000000000010', '78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-00000000000a', 'joined', statement_timestamp()),
	('78800000-0000-4000-8000-000000000010', '78800000-0000-4000-8000-00000000000c', '78800000-0000-4000-8000-00000000000a', 'invited', null),
	('78800000-0000-4000-8000-000000000011', '78800000-0000-4000-8000-00000000000d', '78800000-0000-4000-8000-00000000000d', 'joined', statement_timestamp());

-- What Realtime leaves on the topics: each table's presence and a caret broadcast, and the first table's company
-- presence topic.
insert into realtime.messages (topic, extension, payload, event, private) values
	('qorpera-founding-78800000-0000-4000-8000-000000000010', 'presence', '{}', 'track', true),
	('qorpera-founding-78800000-0000-4000-8000-000000000010', 'broadcast', '{"field":"vision"}', 'live', true),
	('qorpera-founding-78800000-0000-4000-8000-000000000011', 'presence', '{}', 'track', true),
	('qorpera-founding-78800000-0000-4000-8000-000000000011', 'broadcast', '{"field":"vision"}', 'live', true),
	('qorpera-presence-78800000-0000-4000-8000-000000000010', 'presence', '{}', 'track', true);

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.as_user(p_user text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true)::text::void
$$;
-- What the user reads while joined to p_topic: '<rows of that topic>/<rows of any other topic>'.
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
		values (p_topic, 'broadcast', '{"field":"vision","text":"forged"}', 'live', true);
	exception when insufficient_privilege then v_result := sqlstate;
	end;
	reset role;
	perform set_config('realtime.topic', '', true);
	return v_result;
end $$;
-- A call as the user: its answer as text, or the refusal's code.
create function pg_temp.call(p_user text, p_sql text) returns text language plpgsql as $$
declare v_result text;
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	begin
		execute p_sql into v_result;
	exception when others then v_result := sqlstate;
	end;
	reset role;
	return coalesce(v_result, 'null');
end $$;
create function pg_temp.key(p_letter text) returns text language sql as $$ select repeat(p_letter, 43) || '=' $$;
create function pg_temp.register(p_user text, p_profile text, p_client text, p_key text) returns text language sql as $$
	select pg_temp.call(p_user, format('select public.qorpera_register_founding_presence(%L, %L, %L)::text',
		p_profile, p_client, p_key))
$$;
-- The user ids the caller's list returns for these devices, in device order, or the refusal's code.
create function pg_temp.listed(p_user text, p_profile text, p_clients text[]) returns text language plpgsql as $$
declare v_answer text := pg_temp.call(p_user, format('select public.qorpera_list_founding_presence(%L, %L)::text',
	p_profile, p_clients));
begin
	if v_answer !~ '^\[' then return v_answer; end if;
	return coalesce((select string_agg(right(device ->> 'client_id', 1) || ':' || right(device ->> 'user_id', 1), ' '
		order by device ->> 'client_id') from jsonb_array_elements(v_answer::jsonb) as device), '');
end $$;

-- The API: the topic helpers, the join check and the three device calls are for signed-in people only; nobody reads
-- or writes the device table directly. The policies are a receive and a publish policy for authenticated users, and
-- every function carries the deploy guard's marker.
do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_founding_topic_profile(text)',
		'public.qorpera_can_join_founding_table(uuid)', 'public.qorpera_register_founding_presence(uuid,uuid,text)',
		'public.qorpera_list_founding_presence(uuid,uuid[])', 'public.qorpera_unregister_founding_presence(uuid,uuid)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE')
			or not has_function_privilege('authenticated', v_function, 'EXECUTE') then
			raise exception '% has the wrong grants', v_function; end if;
		if strpos(pg_get_functiondef(v_function::regprocedure), '20260930531000') = 0 then
			raise exception '% has no deploy marker', v_function; end if;
	end loop;
	foreach v_function in array array['authenticated', 'anon', 'service_role'] loop
		if has_table_privilege(v_function, 'public.qorpera_founding_presence_devices', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'the device table is open to %', v_function; end if;
	end loop;
	perform pg_temp.same((select string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' ' order by policyname)
		from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'qorpera_founding%'),
		'qorpera_founding_table_publish:INSERT:authenticated qorpera_founding_table_receive:SELECT:authenticated',
		'the two policies');
end $$;

-- Only this exact topic shape names a table.
select pg_temp.same(public.qorpera_founding_topic_profile('qorpera-founding-78800000-0000-4000-8000-000000000010')::text,
	'78800000-0000-4000-8000-000000000010', 'the table''s topic');
select pg_temp.same(public.qorpera_founding_topic_profile('qorpera-founding-78800000-0000-4000-8000-000000000010-x')::text,
	null, 'a longer topic');
select pg_temp.same(public.qorpera_founding_topic_profile('qorpera-founding-78800000-0000-4000-8000-00000000001A')::text,
	null, 'capital letters');
select pg_temp.same(public.qorpera_founding_topic_profile('qorpera-presence-78800000-0000-4000-8000-000000000010')::text,
	null, 'the company''s presence topic');

-- Joined and invited seats read their table's topic, and nothing else through it. Dee, at another table, reads none of
-- it, and the first table's people read nothing of Dee's.
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000a', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'2/0', 'Anna (joined) at her table');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000b', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'2/0', 'Bo (joined) at the table');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000c', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'2/0', 'Cy (invited) at the table');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000d', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'0/0', 'Dee at a table she has no seat at');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000a', 'qorpera-founding-78800000-0000-4000-8000-000000000011'),
	'0/0', 'Anna at Dee''s table');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000d', 'qorpera-founding-78800000-0000-4000-8000-000000000011'),
	'2/0', 'Dee at her own table');

-- Every seat publishes on its table's topic, and only there.
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000b',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'published', 'Bo writes at the table');
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000c',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'published', 'Cy (invited) is at the table');
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000d',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'42501', 'Dee at a table she has no seat at');
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000a',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-founding-78800000-0000-4000-8000-000000000011'),
	'42501', 'Anna onto Dee''s table from her own');
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000c',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-presence-78800000-0000-4000-8000-000000000010'),
	'42501', 'Cy onto the company''s presence topic from the table');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000a', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'4/0', 'the table after Bo''s and Cy''s messages');

-- Devices: each seat registers its own tab; an id stays with its owner; Dee and bad keys are refused.
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c1', pg_temp.key('A')),
	jsonb_build_object('client_id', '78800000-0000-4000-8000-0000000000c1', 'user_id', '78800000-0000-4000-8000-00000000000a',
		'public_key', pg_temp.key('A'))::text, 'Anna''s tab');
select pg_temp.same(left(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c2', pg_temp.key('B')), 1), '{', 'Bo''s tab');
select pg_temp.same(left(pg_temp.register('78800000-0000-4000-8000-00000000000c', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c3', pg_temp.key('C')), 1), '{', 'Cy''s tab (invited)');
select pg_temp.same(left(pg_temp.register('78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c1', pg_temp.key('E')), 1), '{', 'Anna again, with a new key');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c1', pg_temp.key('B')), '23505', 'Bo taking Anna''s device id');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000d', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c4', pg_temp.key('D')), '42501', 'Dee at a table she has no seat at');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c5', 'not a key'), '42501', 'a malformed key');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	null, pg_temp.key('B')), '42501', 'no device id');
select pg_temp.same((select string_agg(right(client_id::text, 1) || ':' || right(user_id::text, 1) || ':' || left(public_key, 1),
	' ' order by client_id) from public.qorpera_founding_presence_devices
	where profile_id = '78800000-0000-4000-8000-000000000010'), '1:a:E 2:b:B 3:c:C', 'the table''s devices');

-- The list names each device's person, for seats only; ids it does not know are left out.
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000c', '78800000-0000-4000-8000-000000000010',
	array['78800000-0000-4000-8000-0000000000c1', '78800000-0000-4000-8000-0000000000c2',
		'78800000-0000-4000-8000-0000000000c3', '78800000-0000-4000-8000-0000000000c9']),
	'1:a 2:b 3:c', 'Cy''s list');
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000d', '78800000-0000-4000-8000-000000000010',
	array['78800000-0000-4000-8000-0000000000c1']), '42501', 'Dee''s list of a table she has no seat at');
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-000000000010',
	(select array_agg(extensions.gen_random_uuid()::text) from generate_series(1, 65))), '42501', 'too many ids at once');
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-000000000010', null),
	'42501', 'no ids');

-- A device quiet for two minutes is not resolved; after five, its id is free for anyone at the table, and a
-- registration removes quiet devices at any table.
update public.qorpera_founding_presence_devices set last_seen_at = statement_timestamp() - interval '3 minutes'
where client_id = '78800000-0000-4000-8000-0000000000c3';
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-000000000010',
	array['78800000-0000-4000-8000-0000000000c2', '78800000-0000-4000-8000-0000000000c3']), '2:b', 'a quiet device');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c3', pg_temp.key('B')), '23505', 'a device quiet for three minutes is still Cy''s');
update public.qorpera_founding_presence_devices set last_seen_at = statement_timestamp() - interval '6 minutes'
where client_id = '78800000-0000-4000-8000-0000000000c3';
select pg_temp.same(left(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c3', pg_temp.key('F')), 1), '{', 'an id quiet for six minutes');
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000a', '78800000-0000-4000-8000-000000000010',
	array['78800000-0000-4000-8000-0000000000c3']), '3:b', 'the id is Bo''s now');
select pg_temp.same(left(pg_temp.register('78800000-0000-4000-8000-00000000000d', '78800000-0000-4000-8000-000000000011',
	'78800000-0000-4000-8000-0000000000d1', pg_temp.key('D')), 1), '{', 'Dee''s tab at her table');
update public.qorpera_founding_presence_devices set last_seen_at = statement_timestamp() - interval '6 minutes'
where client_id = '78800000-0000-4000-8000-0000000000d1';
select pg_temp.same(left(pg_temp.register('78800000-0000-4000-8000-00000000000c', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c6', pg_temp.key('C')), 1), '{', 'Cy''s new tab');
select pg_temp.same((select count(*)::text from public.qorpera_founding_presence_devices
	where client_id = '78800000-0000-4000-8000-0000000000d1'), '0', 'Dee''s quiet device was removed');

-- A tab removes its own device only.
select pg_temp.same(pg_temp.call('78800000-0000-4000-8000-00000000000b',
	$$select 'done' from public.qorpera_unregister_founding_presence('78800000-0000-4000-8000-000000000010',
		'78800000-0000-4000-8000-0000000000c1')$$), 'done', 'Bo unregistering Anna''s tab');
select pg_temp.same((select count(*)::text from public.qorpera_founding_presence_devices
	where client_id = '78800000-0000-4000-8000-0000000000c1'), '1', 'Anna''s tab stays');
select pg_temp.same(pg_temp.call('78800000-0000-4000-8000-00000000000a',
	$$select 'done' from public.qorpera_unregister_founding_presence('78800000-0000-4000-8000-000000000010',
		'78800000-0000-4000-8000-0000000000c1')$$), 'done', 'Anna unregistering her tab');
select pg_temp.same((select count(*)::text from public.qorpera_founding_presence_devices
	where client_id = '78800000-0000-4000-8000-0000000000c1'), '0', 'Anna''s tab is gone');

-- A seat given up: Cy's invitation is withdrawn. Cy joins nothing, registers nothing, and her device is no longer
-- resolved; she can still remove it.
delete from public.qorpera_company_founder_seats
where profile_id = '78800000-0000-4000-8000-000000000010' and user_id = '78800000-0000-4000-8000-00000000000c';
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000c', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'0/0', 'Cy after her invitation was withdrawn');
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000c',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'42501', 'Cy publishing after her invitation was withdrawn');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000c', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c6', pg_temp.key('C')), '42501', 'Cy registering after her invitation was withdrawn');
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	array['78800000-0000-4000-8000-0000000000c2', '78800000-0000-4000-8000-0000000000c6']), '2:b', 'Cy''s device is not resolved');
select pg_temp.same(pg_temp.call('78800000-0000-4000-8000-00000000000c',
	$$select 'done' from public.qorpera_unregister_founding_presence('78800000-0000-4000-8000-000000000010',
		'78800000-0000-4000-8000-0000000000c6')$$), 'done', 'Cy removing her own device');
select pg_temp.same((select count(*)::text from public.qorpera_founding_presence_devices
	where client_id = '78800000-0000-4000-8000-0000000000c6'), '0', 'Cy''s device is gone');

-- A table being deleted, or started, joins nothing any more.
insert into public.qorpera_company_deletions (profile_id, requested_by_user_id)
values ('78800000-0000-4000-8000-000000000011', '78800000-0000-4000-8000-00000000000d');
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000d', 'qorpera-founding-78800000-0000-4000-8000-000000000011'),
	'0/0', 'Dee at her table being deleted');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000d', '78800000-0000-4000-8000-000000000011',
	'78800000-0000-4000-8000-0000000000d2', pg_temp.key('D')), '42501', 'Dee registering at her table being deleted');
update public.qorpera_company_foundings set phase = 'started', started_at = statement_timestamp(),
	started_by_user_id = '78800000-0000-4000-8000-00000000000a', started_revision = revision,
	start_client_id = '78800000-0000-4000-8000-0000000000e1', vision_draft = null
where profile_id = '78800000-0000-4000-8000-000000000010';
select pg_temp.same(pg_temp.reads('78800000-0000-4000-8000-00000000000a', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'0/0', 'Anna at her started table');
select pg_temp.same(pg_temp.publishes('78800000-0000-4000-8000-00000000000b',
	'qorpera-founding-78800000-0000-4000-8000-000000000010', 'qorpera-founding-78800000-0000-4000-8000-000000000010'),
	'42501', 'Bo publishing at the started table');
select pg_temp.same(pg_temp.register('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	'78800000-0000-4000-8000-0000000000c2', pg_temp.key('B')), '42501', 'Bo registering at the started table');
select pg_temp.same(pg_temp.listed('78800000-0000-4000-8000-00000000000b', '78800000-0000-4000-8000-000000000010',
	array['78800000-0000-4000-8000-0000000000c2']), '42501', 'Bo''s list at the started table');

-- Devices go with their account and with their company (an account deletion reaches the person's own devices: test 720
-- lists the table).
select pg_temp.same((select string_agg(link.confrelid::regclass::text || ':' || link.confdeltype::text, ' '
	order by link.confrelid::regclass::text) from pg_catalog.pg_constraint as link
	where link.conrelid = 'public.qorpera_founding_presence_devices'::regclass and link.contype = 'f'),
	'auth.users:c qorpera_profiles:c', 'the device table''s links');

rollback;

-- 20260930653000 (perf T3): the web's change hints by push. A change to a session, an agent, an access row, a Company
-- File row or the sidebar sends {"schema":"qorpera.live-hint/v1"} as event sessions / staff / access / company-file /
-- sidebar on the private topic 'qorpera-live-<profileId>-<userId>' of exactly the members who may read the changed row
-- under its own read policy, at commit. Each check below compares with the real policy, read the way Realtime read it
-- for postgres_changes (as the member, the row by its key). A member may join only their own topic, of a company they
-- belong to or have an access row in; nobody publishes on it; a failing Realtime never fails the write.

begin;

-- A has owner A1, contributor A2, viewer A3, X and R; B has owner B1 and X. S is in no company.
insert into auth.users (id, email) values
	('11530000-0000-4000-8000-0000000000a1', 'live-a1@example.test'),
	('11530000-0000-4000-8000-0000000000a2', 'live-a2@example.test'),
	('11530000-0000-4000-8000-0000000000a3', 'live-a3@example.test'),
	('11530000-0000-4000-8000-0000000000b1', 'live-b1@example.test'),
	('11530000-0000-4000-8000-0000000000c1', 'live-x@example.test'),
	('11530000-0000-4000-8000-0000000000d1', 'live-r@example.test'),
	('11530000-0000-4000-8000-0000000000f0', 'live-s@example.test');
insert into public.qorpera_profiles (id, name, created_by_user_id) values
	('11530000-0000-4000-8000-000000000010', 'Live A', '11530000-0000-4000-8000-0000000000a1'),
	('11530000-0000-4000-8000-000000000011', 'Live B', '11530000-0000-4000-8000-0000000000b1');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role) values
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-0000000000a1', 'live-a1@example.test', 'A1', 'owner'),
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-0000000000a2', 'live-a2@example.test', 'A2', 'contributor'),
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-0000000000a3', 'live-a3@example.test', 'A3', 'viewer'),
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-0000000000c1', 'live-x@example.test', 'X', 'contributor'),
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-0000000000d1', 'live-r@example.test', 'R', 'contributor'),
	('11530000-0000-4000-8000-000000000011', '11530000-0000-4000-8000-0000000000b1', 'live-b1@example.test', 'B1', 'owner'),
	('11530000-0000-4000-8000-000000000011', '11530000-0000-4000-8000-0000000000c1', 'live-x@example.test', 'X', 'contributor');
insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id) values
	('11530000-0000-4000-8000-000000000020', '11530000-0000-4000-8000-000000000010', 'Live A', 1, '11530000-0000-4000-8000-0000000000a1'),
	('11530000-0000-4000-8000-000000000021', '11530000-0000-4000-8000-000000000011', 'Live B', 1, '11530000-0000-4000-8000-0000000000b1');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('11530000-0000-4000-8000-000000000020') \g /dev/null
select public.qorpera_folder_enable('11530000-0000-4000-8000-000000000021') \g /dev/null
select set_config('request.jwt.claims', '', true) \g /dev/null
insert into public.qorpera_shared_sessions (id, profile_id, environment_id, title, created_by_user_id, audience_kind, audience_user_id) values
	('11530000-0000-4000-8000-000000000030', '11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000020', 'Team', '11530000-0000-4000-8000-0000000000a1', 'company', null),
	('11530000-0000-4000-8000-000000000031', '11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000020', 'A1 alone', '11530000-0000-4000-8000-0000000000a1', 'member_private', '11530000-0000-4000-8000-0000000000a1'),
	('11530000-0000-4000-8000-000000000032', '11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000020', 'R alone', '11530000-0000-4000-8000-0000000000d1', 'member_private', '11530000-0000-4000-8000-0000000000d1'),
	('11530000-0000-4000-8000-000000000033', '11530000-0000-4000-8000-000000000011', '11530000-0000-4000-8000-000000000021', 'B team', '11530000-0000-4000-8000-0000000000b1', 'company', null);
insert into public.qorpera_profile_staff (profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, model_provider, model_id, created_at, updated_at, updated_by_user_id) values
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000040', 'Agent A', 'Operations', 'Live hints.', 'blue', 'round',
		'active', 'active', 'openai', 'gpt-native', clock_timestamp(), clock_timestamp(), '11530000-0000-4000-8000-0000000000a1'),
	('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000041', 'Agent gone', 'Operations', 'Live hints.', 'blue', 'round',
		'active', 'active', 'openai', 'gpt-native', clock_timestamp(), clock_timestamp(), '11530000-0000-4000-8000-0000000000a1'),
	('11530000-0000-4000-8000-000000000011', '11530000-0000-4000-8000-000000000042', 'Agent B', 'Operations', 'Live hints.', 'blue', 'round',
		'active', 'active', 'openai', 'gpt-native', clock_timestamp(), clock_timestamp(), '11530000-0000-4000-8000-0000000000b1');
insert into public.qorpera_company_sidebar_revisions (profile_id, revision, updated_at) values
	('11530000-0000-4000-8000-000000000010', 1, clock_timestamp()),
	('11530000-0000-4000-8000-000000000011', 1, clock_timestamp())
on conflict (profile_id) do nothing;

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A short name for a fixture user or company.
create function pg_temp.who(p_id uuid) returns text language sql immutable as $$
	select case p_id
		when '11530000-0000-4000-8000-0000000000a1' then 'A1' when '11530000-0000-4000-8000-0000000000a2' then 'A2'
		when '11530000-0000-4000-8000-0000000000a3' then 'A3' when '11530000-0000-4000-8000-0000000000b1' then 'B1'
		when '11530000-0000-4000-8000-0000000000c1' then 'X' when '11530000-0000-4000-8000-0000000000d1' then 'R'
		when '11530000-0000-4000-8000-0000000000f0' then 'S' when '11530000-0000-4000-8000-000000000010' then 'A'
		when '11530000-0000-4000-8000-000000000011' then 'B' else p_id::text end
$$;
-- The live hints sent so far, as company/member:event, sorted.
create function pg_temp.hints() returns text language sql as $$
	select coalesce(string_agg(label, ' ' order by label collate "C"), '')
	from (select distinct pg_temp.who(substring(topic from 14 for 36)::uuid) || '/' || pg_temp.who(substring(topic from 51)::uuid)
		|| ':' || event as label from realtime.messages where topic like 'qorpera-live-%') as hint
$$;
create function pg_temp.clear() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
$$;
-- What a commit would send now: the deferred hints fire.
create function pg_temp.flush() returns void language plpgsql as $$
begin
	set constraints qorpera_live_hint immediate;
	set constraints qorpera_live_hint deferred;
end $$;
create function pg_temp.users() returns setof uuid language sql immutable as $$
	select unnest(array['11530000-0000-4000-8000-0000000000a1', '11530000-0000-4000-8000-0000000000a2',
		'11530000-0000-4000-8000-0000000000a3', '11530000-0000-4000-8000-0000000000b1', '11530000-0000-4000-8000-0000000000c1',
		'11530000-0000-4000-8000-0000000000d1', '11530000-0000-4000-8000-0000000000f0']::uuid[])
$$;
-- Whether `p_user` sees the row of `p_table` that `p_key` selects, under the table's policy: Realtime's own check for
-- postgres_changes (the row by its key, as the subscriber).
create function pg_temp.sees(p_table text, p_key text, p_user uuid) returns boolean language plpgsql as $$
declare v_seen boolean;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
	set local role authenticated;
	execute format('select exists (select 1 from public.%I where %s)', p_table, p_key) into v_seen;
	reset role;
	perform set_config('request.jwt.claims', '', true);
	return v_seen;
end $$;
-- Whether `p_user` may join `p_topic`: Realtime's private join, a probe row read as the member with the topic set.
create function pg_temp.may_join(p_topic text, p_user uuid, p_role text default 'authenticated') returns boolean language plpgsql as $$
declare v_probe uuid := extensions.gen_random_uuid(); v_seen boolean;
begin
	insert into realtime.messages (id, topic, extension, private) values (v_probe, p_topic, 'broadcast', true);
	perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', p_role)::text, true);
	perform set_config('realtime.topic', p_topic, true);
	execute format('set local role %I', p_role);
	select exists (select 1 from realtime.messages where id = v_probe) into v_seen;
	reset role;
	perform set_config('realtime.topic', '', true);
	perform set_config('request.jwt.claims', '', true);
	delete from realtime.messages where id = v_probe;
	return v_seen;
end $$;
create function pg_temp.topic(p_profile text, p_user text) returns text language sql immutable as $$
	select 'qorpera-live-11530000-0000-4000-8000-0000000000' || p_profile || '-11530000-0000-4000-8000-0000000000' || p_user
$$;

-- The pieces: one deferred row trigger per published table, the helpers' grants, the policy.
do $$
declare v_table text;
begin
	foreach v_table in array array['qorpera_shared_sessions', 'qorpera_profile_staff', 'qorpera_profile_access_state',
		'qorpera_company_files', 'qorpera_company_sidebar_revisions'] loop
		if not exists (select 1 from pg_trigger as trigger where trigger.tgrelid = format('public.%I', v_table)::regclass
			and trigger.tgname = 'qorpera_live_hint' and trigger.tgdeferrable and trigger.tginitdeferred
			and pg_get_triggerdef(trigger.oid) like '%AFTER INSERT OR DELETE OR UPDATE%FOR EACH ROW%qorpera_live_hint_internal(%') then
			raise exception 'the live hint trigger on % is missing or has the wrong shape', v_table; end if;
		-- The publication stays for web tabs from before the push.
		if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
			and tablename = v_table) then
			raise exception '% left the publication', v_table; end if;
	end loop;
	if has_function_privilege('anon', 'public.qorpera_live_hint_member(text)', 'EXECUTE')
		or not has_function_privilege('authenticated', 'public.qorpera_live_hint_member(text)', 'EXECUTE') then
		raise exception 'the join check has the wrong grants'; end if;
	if exists (select 1 from unnest(array['public.qorpera_live_hint_topic(uuid,uuid)', 'public.qorpera_live_hint_topic_profile(text,uuid)',
			'public.qorpera_live_hint_profile_topics(uuid)', 'public.qorpera_live_hint_session_topics(uuid,text,uuid)',
			'public.qorpera_live_hint_staff_topics(uuid,boolean)', 'public.qorpera_live_hint_access_topics(uuid,uuid)',
			'public.qorpera_live_hint_send(text,text[],text)', 'public.qorpera_live_hint_internal()']) as fn,
			unnest(array['anon', 'authenticated', 'service_role']) as role
		where has_function_privilege(role, fn, 'EXECUTE')) then
		raise exception 'a live hint helper is exposed'; end if;
	if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
		and policyname = 'qorpera_live_hint_member_receive' and cmd = 'SELECT' and roles = '{authenticated}') then
		raise exception 'the receive policy is missing'; end if;
	if exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
		and policyname like '%live_hint%' and cmd <> 'SELECT') then
		raise exception 'a client may publish on a live hint topic'; end if;
	if strpos(pg_get_functiondef('public.qorpera_live_hint_internal()'::regprocedure), '''20ms''') = 0
		or strpos(pg_get_functiondef('public.qorpera_live_hint_internal()'::regprocedure), 'perf T3 (20260930653000)') = 0
		or strpos(pg_get_functiondef('public.qorpera_live_hint_member(text)'::regprocedure), 'perf T3 (20260930653000)') = 0
		then raise exception 'a live hint function lost its budget or body marker'; end if;
	-- The topic and its parser: the user's own topic only, lower-case ids as the database writes them.
	perform pg_temp.same(public.qorpera_live_hint_topic('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-0000000000a1'),
		pg_temp.topic('10', 'a1'), 'the topic');
	perform pg_temp.same(public.qorpera_live_hint_topic_profile(pg_temp.topic('10', 'a1'), '11530000-0000-4000-8000-0000000000a1')::text,
		'11530000-0000-4000-8000-000000000010', 'the topic''s company');
	perform pg_temp.same(public.qorpera_live_hint_topic_profile(pg_temp.topic('10', 'a1'), '11530000-0000-4000-8000-0000000000a2')::text,
		null, 'another member''s topic');
	perform pg_temp.same(public.qorpera_live_hint_topic_profile(upper(pg_temp.topic('10', 'a1')), '11530000-0000-4000-8000-0000000000a1')::text,
		null, 'an upper-case topic');
	perform pg_temp.same(public.qorpera_live_hint_topic_profile(pg_temp.topic('10', 'a1') || 'x', '11530000-0000-4000-8000-0000000000a1')::text,
		null, 'a longer topic');
	perform pg_temp.same(public.qorpera_live_hint_topic_profile('qorpera-presence-11530000-0000-4000-8000-000000000010',
		'11530000-0000-4000-8000-0000000000a1')::text, null, 'another family''s topic');
	perform pg_temp.same(public.qorpera_live_hint_topic_profile(pg_temp.topic('10', 'a1'), null)::text, null, 'no user');
end $$;

-- Deferred: the fixture's writes sent nothing yet. At commit each row's readers get one hint per resource. (Live hints
-- of earlier tests' committed rows are cleared first.)
do $$ begin
	perform pg_temp.clear();
	perform pg_temp.same(pg_temp.hints(), '', 'nothing before the commit');
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A1:access A/A1:company-file A/A1:sessions A/A1:sidebar A/A1:staff '
		|| 'A/A2:access A/A2:company-file A/A2:sessions A/A2:sidebar A/A2:staff A/A3:access A/A3:company-file A/A3:sessions '
		|| 'A/A3:sidebar A/A3:staff A/R:access A/R:company-file A/R:sessions A/R:sidebar A/R:staff A/X:access A/X:company-file '
		|| 'A/X:sessions A/X:sidebar A/X:staff B/B1:access B/B1:company-file B/B1:sessions B/B1:sidebar B/B1:staff B/X:access '
		|| 'B/X:company-file B/X:sessions B/X:sidebar B/X:staff', 'the fixture''s commit');
	perform pg_temp.same((select string_agg(distinct jsonb_build_object('payload', message.payload, 'private', message.private,
			'extension', message.extension)::text, ' ') from realtime.messages as message where message.topic like 'qorpera-live-%'),
		jsonb_build_object('payload', jsonb_build_object('schema', 'qorpera.live-hint/v1'), 'private', true,
			'extension', 'broadcast')::text, 'a hint says only which resource changed');
	perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'), '35',
		'one hint per topic and resource, however many rows moved');
end $$;

-- Row by row, member by member: a change reaches exactly the members the row's policy shows it to.
do $$
declare
	v_row record;
	v_user uuid;
	v_want text;
	v_got text;
begin
	-- R's private session is R's alone; A2's is A2's. The agent soft-deleted below is no one's.
	update public.qorpera_profile_staff set deleted_at = clock_timestamp(), deleted_by_user_id = '11530000-0000-4000-8000-0000000000a1'
	where staff_agent_id = '11530000-0000-4000-8000-000000000041';
	for v_row in
		select 'qorpera_shared_sessions' as tbl, 'sessions' as event, profile_id, format('id = %L', id) as key from public.qorpera_shared_sessions
		where profile_id in ('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000011')
		union all select 'qorpera_profile_staff', 'staff', profile_id, format('profile_id = %L and staff_agent_id = %L', profile_id, staff_agent_id)
		from public.qorpera_profile_staff where profile_id in ('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000011')
		union all select 'qorpera_profile_access_state', 'access', profile_id, format('profile_id = %L and user_id = %L', profile_id, user_id)
		from public.qorpera_profile_access_state where profile_id in ('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000011')
		union all select 'qorpera_company_files', 'company-file', profile_id, format('environment_id = %L', environment_id)
		from public.qorpera_company_files where profile_id in ('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000011')
		union all select 'qorpera_company_sidebar_revisions', 'sidebar', profile_id, format('profile_id = %L', profile_id)
		from public.qorpera_company_sidebar_revisions where profile_id in ('11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000011')
	loop
		perform pg_temp.clear();
		execute format('update public.%I set updated_at = updated_at where %s', v_row.tbl, v_row.key);
		perform pg_temp.flush();
		select coalesce(string_agg(pg_temp.who(member), ' ' order by pg_temp.who(member)), '') into v_want
		from pg_temp.users() as member where pg_temp.sees(v_row.tbl, v_row.key, member);
		select coalesce(string_agg(pg_temp.who(member), ' ' order by pg_temp.who(member)), '') into v_got
		from pg_temp.users() as member where exists (select 1 from realtime.messages as message
			where message.topic = public.qorpera_live_hint_topic(v_row.profile_id, member) and message.event = v_row.event);
		perform pg_temp.same(v_got, v_want, format('who hears of %s %s', v_row.tbl, v_row.key));
		perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'
			and (substring(topic from 14 for 36)::uuid <> v_row.profile_id or event <> v_row.event)), '0',
			format('%s %s hints nothing else', v_row.tbl, v_row.key));
	end loop;
	-- The matrix covered the cases that differ.
	perform pg_temp.same((select count(*)::text from public.qorpera_shared_sessions
		where profile_id = '11530000-0000-4000-8000-000000000010' and audience_kind = 'member_private'), '2', 'two private sessions');
	perform pg_temp.clear();
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000032';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/R:sessions', 'a member''s own session reaches that member alone');
	perform pg_temp.clear();
	update public.qorpera_profile_staff set updated_at = updated_at where staff_agent_id = '11530000-0000-4000-8000-000000000041';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), '', 'a deleted agent reaches no one');
end $$;

-- A deleted row reaches whoever could read it just before.
do $$ begin
	insert into public.qorpera_shared_sessions (id, profile_id, environment_id, title, created_by_user_id, audience_kind, audience_user_id)
	values ('11530000-0000-4000-8000-000000000034', '11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000020',
		'A2 alone', '11530000-0000-4000-8000-0000000000a2', 'member_private', '11530000-0000-4000-8000-0000000000a2');
	perform pg_temp.flush();
	perform pg_temp.clear();
	delete from public.qorpera_shared_sessions where id = '11530000-0000-4000-8000-000000000034';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A2:sessions', 'a deleted private session');
	-- A row inserted and deleted in one transaction reaches no one for the insert.
	perform pg_temp.clear();
	insert into public.qorpera_shared_sessions (id, profile_id, environment_id, title, created_by_user_id, audience_kind)
	values ('11530000-0000-4000-8000-000000000035', '11530000-0000-4000-8000-000000000011', '11530000-0000-4000-8000-000000000021',
		'Gone', '11530000-0000-4000-8000-0000000000b1', 'company');
	update public.qorpera_shared_sessions set audience_kind = 'member_private', audience_user_id = '11530000-0000-4000-8000-0000000000b1'
	where id = '11530000-0000-4000-8000-000000000035';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'B/B1:sessions', 'a session made private in the same transaction is read as it is at commit');
end $$;

-- One hint per topic and resource per transaction.
do $$ begin
	perform pg_temp.clear();
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000030';
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000030';
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000031';
	perform pg_temp.flush();
	perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'), '5', 'five members, one hint each');
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000030';
	perform pg_temp.flush();
	perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'), '5',
		'a hint already sent in this transaction is not sent again');
	-- Two members' own sessions are two classes of readers: each member hears of their own.
	perform pg_temp.clear();
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000031';
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000032';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A1:sessions A/R:sessions', 'two private sessions in one transaction');
end $$;

-- A statement over many rows of one company sends once: 200 new team sessions, one hint per member.
do $$ begin
	perform pg_temp.clear();
	insert into public.qorpera_shared_sessions (id, profile_id, environment_id, title, created_by_user_id, audience_kind)
	select extensions.gen_random_uuid(), '11530000-0000-4000-8000-000000000010', '11530000-0000-4000-8000-000000000020',
		'Bulk ' || n, '11530000-0000-4000-8000-0000000000a1', 'company' from generate_series(1, 200) as n;
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A1:sessions A/A2:sessions A/A3:sessions A/R:sessions A/X:sessions', 'a bulk insert');
	perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'), '5', 'five hints for 200 rows');
	-- and a bulk delete of them the same, from the rows as they were.
	perform pg_temp.clear();
	delete from public.qorpera_shared_sessions where title like 'Bulk %' and profile_id = '11530000-0000-4000-8000-000000000010';
	perform pg_temp.flush();
	perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'), '5', 'five hints for 200 deletes');
end $$;

-- A member removed in the same transaction as a change hears only of their own access, at commit.
savepoint live_removed;
do $$ begin
	perform pg_temp.clear();
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000030';
	update public.qorpera_company_sidebar_revisions set revision = revision + 1 where profile_id = '11530000-0000-4000-8000-000000000010';
	delete from public.qorpera_profile_members where profile_id = '11530000-0000-4000-8000-000000000010'
		and user_id = '11530000-0000-4000-8000-0000000000d1';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A1:access A/A1:sessions A/A1:sidebar A/A2:access A/A2:sessions A/A2:sidebar '
		|| 'A/A3:access A/A3:sessions A/A3:sidebar A/R:access A/X:access A/X:sessions A/X:sidebar', 'a removal');
	-- From then on R hears nothing of A, not even of R's own former private session.
	perform pg_temp.clear();
	update public.qorpera_shared_sessions set updated_at = updated_at where profile_id = '11530000-0000-4000-8000-000000000010';
	update public.qorpera_profile_staff set updated_at = updated_at where staff_agent_id = '11530000-0000-4000-8000-000000000040';
	update public.qorpera_company_files set updated_at = updated_at where profile_id = '11530000-0000-4000-8000-000000000010';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A1:company-file A/A1:sessions A/A1:staff A/A2:company-file A/A2:sessions A/A2:staff '
		|| 'A/A3:company-file A/A3:sessions A/A3:staff A/X:company-file A/X:sessions A/X:staff', 'after the removal');
	perform pg_temp.same(pg_temp.sees('qorpera_shared_sessions', 'id = ''11530000-0000-4000-8000-000000000032''',
		'11530000-0000-4000-8000-0000000000d1')::text, 'false', 'and the policy agrees');
	-- R may still join R's topic (R reads R's own access row), and hears only that row's changes.
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('10', 'd1'), '11530000-0000-4000-8000-0000000000d1')::text, 'true',
		'the removed member''s own topic');
end $$;
rollback to savepoint live_removed;

-- A company being deleted: files and the sidebar reach no one (qorpera_can_read_profile); sessions, agents and access
-- rows still do, as their policies say.
savepoint live_deleting;
do $$ begin
	insert into public.qorpera_company_deletions (profile_id, requested_by_user_id)
	values ('11530000-0000-4000-8000-000000000011', '11530000-0000-4000-8000-0000000000b1');
	perform pg_temp.clear();
	update public.qorpera_company_files set updated_at = updated_at where profile_id = '11530000-0000-4000-8000-000000000011';
	update public.qorpera_company_sidebar_revisions set revision = revision + 1 where profile_id = '11530000-0000-4000-8000-000000000011';
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000033';
	update public.qorpera_profile_access_state set updated_at = updated_at where profile_id = '11530000-0000-4000-8000-000000000011'
		and user_id = '11530000-0000-4000-8000-0000000000b1';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'B/B1:access B/B1:sessions B/X:sessions', 'a company being deleted');
	perform pg_temp.same(pg_temp.sees('qorpera_profile_access_state', 'user_id = ''11530000-0000-4000-8000-0000000000b1''',
		'11530000-0000-4000-8000-0000000000c1')::text, 'false', 'X no longer reads B1''s access row');
end $$;
rollback to savepoint live_deleting;

-- Who may join: a member their own topic; nobody another member's, a company they are not in, or as anon.
do $$ begin
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('10', 'a1'), '11530000-0000-4000-8000-0000000000a1')::text, 'true', 'A1, own topic');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('10', 'a3'), '11530000-0000-4000-8000-0000000000a3')::text, 'true', 'a viewer');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('11', 'c1'), '11530000-0000-4000-8000-0000000000c1')::text, 'true', 'X in B');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('10', 'a2'), '11530000-0000-4000-8000-0000000000a1')::text, 'false',
		'another member''s topic');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('11', 'b1'), '11530000-0000-4000-8000-0000000000a1')::text, 'false',
		'another company''s member''s topic');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('11', 'a1'), '11530000-0000-4000-8000-0000000000a1')::text, 'false',
		'own topic of a company not joined');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('10', 'f0'), '11530000-0000-4000-8000-0000000000f0')::text, 'false',
		'a stranger''s own topic of A');
	perform pg_temp.same(pg_temp.may_join(pg_temp.topic('10', 'a1'), '11530000-0000-4000-8000-0000000000a1', 'anon')::text, 'false',
		'anon');
	-- Joined to another family's topic, a member reads none of the live hints through this policy, and joined to a live
	-- topic none of the others'.
	perform pg_temp.flush();
	perform set_config('request.jwt.claims', jsonb_build_object('sub', '11530000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
	perform set_config('realtime.topic', 'qorpera-presence-11530000-0000-4000-8000-000000000010', true);
	set local role authenticated;
	perform pg_temp.same((select count(*)::text from realtime.messages where topic like 'qorpera-live-%'), '0',
		'joined to presence, no live hints');
	reset role;
	insert into realtime.messages (topic, extension, payload, event, private)
	values ('qorpera-presence-11530000-0000-4000-8000-000000000010', 'presence', '{}', 'track', true);
	perform set_config('realtime.topic', pg_temp.topic('10', 'a1'), true);
	set local role authenticated;
	perform pg_temp.same((select count(*)::text from realtime.messages where topic not like 'qorpera-live-%'), '0',
		'joined to a live topic, nothing else');
	reset role;
	perform set_config('realtime.topic', '', true);
	perform set_config('request.jwt.claims', '', true);
end $$;
-- Nobody publishes on a live topic.
select set_config('request.jwt.claims', jsonb_build_object('sub', '11530000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
select set_config('realtime.topic', 'qorpera-live-11530000-0000-4000-8000-000000000010-11530000-0000-4000-8000-0000000000a1', true);
set local role authenticated;
do $$ begin
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values ('qorpera-live-11530000-0000-4000-8000-000000000010-11530000-0000-4000-8000-0000000000a1', 'broadcast',
			'{"schema":"qorpera.live-hint/v1"}', 'sessions', true);
		raise exception 'a member published on their live topic';
	exception when insufficient_privilege then null;
	end;
end $$;
reset role;
select set_config('realtime.topic', '', true);
select set_config('request.jwt.claims', '', true);

-- A rolled-back write sends nothing; a failing or missing Realtime never fails a write.
do $$ begin
	perform pg_temp.clear();
	begin
		update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000033';
		raise exception 'roll back';
	exception when raise_exception then null;
	end;
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), '', 'a rolled-back write');
end $$;
savepoint live_no_realtime;
alter table realtime.messages rename to messages_moved_by_test_1153;
do $$ begin
	perform set_config('qorpera.live_hints_sent', '', true);
	update public.qorpera_shared_sessions set title = 'Team renamed' where id = '11530000-0000-4000-8000-000000000030';
	perform pg_temp.flush();
	perform pg_temp.same((select title from public.qorpera_shared_sessions where id = '11530000-0000-4000-8000-000000000030'),
		'Team renamed', 'the write without Realtime');
	perform pg_temp.same(current_setting('lock_timeout'), (select setting from pg_settings where name = 'lock_timeout'),
		'the lock budget is restored');
end $$;
rollback to savepoint live_no_realtime;
savepoint live_raising_realtime;
create function realtime.refuse_1153() returns trigger language plpgsql as $$ begin raise exception 'Realtime is down (test 1153)'; end $$;
create trigger refuse_1153 before insert on realtime.messages for each row execute function realtime.refuse_1153();
do $$ begin
	perform pg_temp.clear();
	update public.qorpera_shared_sessions set title = 'Team renamed' where id = '11530000-0000-4000-8000-000000000030';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), '', 'no hint from a refusing Realtime');
	perform pg_temp.same(current_setting('lock_timeout'), (select setting from pg_settings where name = 'lock_timeout'),
		'the lock budget is restored after a refusal');
	-- The refused send is not counted as sent: the next change in the transaction sends it.
	drop trigger refuse_1153 on realtime.messages;
	update public.qorpera_shared_sessions set updated_at = updated_at where id = '11530000-0000-4000-8000-000000000030';
	perform pg_temp.flush();
	perform pg_temp.same(pg_temp.hints(), 'A/A1:sessions A/A2:sessions A/A3:sessions A/R:sessions A/X:sessions', 'the next change sends');
end $$;
rollback to savepoint live_raising_realtime;

rollback;

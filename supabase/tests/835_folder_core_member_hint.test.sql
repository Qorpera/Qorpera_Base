-- @fixture 636_folder_core_feed.test.sql until "-- A history: seq 1 folders"
-- Company folder core, C4 slice P30 (20260930013100): the members' and clients' hint. Each forward move of a folder-v2
-- company's clock broadcasts {"schema":"qorpera.folder-hint/v1","seq"} as event 'folder' on the private topic
-- 'qorpera-folder-<environmentId>', inside the commit: a change set or an authority change sends one, a commit that
-- saves nothing sends none, and a failing Realtime never fails the commit. Members of the company receive the topic,
-- nobody else does, and nobody but the database publishes on it.

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- The hints sent for the fixture company, as their seqs in order.
create function pg_temp.hints() returns text language sql as $$
	select coalesce(string_agg(message.payload ->> 'seq', ',' order by (message.payload ->> 'seq')::bigint), '')
	from realtime.messages as message where message.topic = 'qorpera-folder-63000000-0000-4000-8000-000000000020'
$$;
create function pg_temp.as_user(p_n integer) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '63000000-0000-4000-8000-00000000000' || p_n)::text, true)::text::void
$$;
insert into auth.users(id, email) values ('63000000-0000-4000-8000-000000000005', 'folder-stranger@example.test');

-- The pieces: the trigger runs only on a forward move; the helpers' grants; the policy.
do $$ begin
	if not exists (select 1 from pg_trigger where tgname = 'qorpera_folder_clocks_hint'
		and tgrelid = 'public.qorpera_folder_clocks'::regclass and not tgdeferrable
		and pg_get_triggerdef(oid) like '%AFTER UPDATE OF last_seq%WHEN ((new.last_seq > old.last_seq))%') then
		raise exception 'the hint trigger is missing or has the wrong shape'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_folder_hint_internal()', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_folder_hint_internal()', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_folder_hint_internal()', 'EXECUTE') then
		raise exception 'the trigger function is exposed'; end if;
	if not has_function_privilege('authenticated', 'public.qorpera_folder_hint_member(text)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_folder_hint_member(text)', 'EXECUTE') then
		raise exception 'the member check has the wrong grants'; end if;
	if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
		and policyname = 'qorpera_folder_hint_member_receive' and cmd = 'SELECT' and roles = '{authenticated}') then
		raise exception 'the receive policy is missing'; end if;
	if exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
		and policyname like '%folder%' and cmd <> 'SELECT') then
		raise exception 'a client may publish on the folder topic'; end if;
	if strpos(pg_get_functiondef('public.qorpera_folder_hint_internal()'::regprocedure), '''20ms''') = 0
		or strpos(pg_get_functiondef('public.qorpera_folder_hint_internal()'::regprocedure), 'C4 P30 (20260930013100)') = 0
		or strpos(pg_get_functiondef('public.qorpera_folder_hint_member(text)'::regprocedure), 'C4 P30 (20260930013100)') = 0
		then raise exception 'a hint function lost its budget or body marker'; end if;
	perform pg_temp.same(public.qorpera_folder_hint_topic('63000000-0000-4000-8000-000000000020'),
		'qorpera-folder-63000000-0000-4000-8000-000000000020', 'the topic');
	perform pg_temp.same(public.qorpera_folder_hint_environment('qorpera-folder-63000000-0000-4000-8000-000000000020')::text,
		'63000000-0000-4000-8000-000000000020', 'the topic''s environment');
	perform pg_temp.same(public.qorpera_folder_hint_environment('qorpera-room-drafts-63000000-0000-4000-8000-000000000020')::text,
		null, 'another topic');
end $$;

-- Enabling the folder made the clock; that sends nothing. Each change set sends one hint with its seq, as a private
-- broadcast.
do $$ begin
	perform pg_temp.same(pg_temp.hints(), '', 'no hint before the first commit');
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'hint-key-1', '[{"op":"mkdir","path":"docs"}]'), 1, 'saved');
	perform pg_temp.same(pg_temp.hints(), '1', 'one hint for the first change set');
	perform pg_temp.same((select jsonb_build_object('payload', message.payload, 'event', message.event,
			'private', message.private, 'extension', message.extension)::text
		from realtime.messages as message where message.topic = 'qorpera-folder-63000000-0000-4000-8000-000000000020'),
		jsonb_build_object('payload', jsonb_build_object('schema', 'qorpera.folder-hint/v1', 'seq', 1), 'event', 'folder',
			'private', true, 'extension', 'broadcast')::text, 'the hint says only the seq');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'hint-key-2', jsonb_build_array(jsonb_build_object('op', 'write',
		'path', 'docs/a.txt', 'file', pg_temp.stage('alpha')))), 1, 'saved');
	perform pg_temp.same(pg_temp.hints(), '1,2', 'a member''s change set');
end $$;

-- A commit that saves nothing takes no seq and sends nothing; an authority change sends one.
do $$ begin
	perform public.qorpera_folder_commit('63000000-0000-4000-8000-000000000020', pg_temp.platform(), 'hint-key-3',
		jsonb_build_array(jsonb_build_object('op', 'delete', 'path', 'docs/a.txt',
			'expectedVersion', '63000000-0000-4000-8000-0000000000ee')));
	perform pg_temp.same(pg_temp.seq()::text, '2', 'a refused unit takes no seq');
	perform pg_temp.same(pg_temp.hints(), '1,2', 'and sends no hint');
	perform public.qorpera_folder_set_resource('63000000-0000-4000-8000-000000000020', pg_temp.platform(), 'hintzone',
		'subtree', 'company_shared', 'normal');
	perform pg_temp.same(pg_temp.seq()::text, '3', 'an authority change takes a seq');
	perform pg_temp.same(pg_temp.hints(), '1,2,3', 'and sends a hint');
end $$;

-- A missing Realtime never fails a commit: the commit saves, and no hint is sent for it.
savepoint hint_no_realtime;
alter function realtime.send(jsonb, text, text, boolean) rename to send_moved_by_test_835;
do $$ begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'hint-key-4', '[{"op":"mkdir","path":"notes"}]'), 1, 'saved');
	perform pg_temp.same(pg_temp.seq()::text, '4', 'the commit saved');
	perform pg_temp.same(pg_temp.hints(), '1,2,3', 'without a hint');
	perform pg_temp.same(current_setting('lock_timeout'), (select setting from pg_settings where name = 'lock_timeout'),
		'the lock budget is restored');
end $$;
rollback to savepoint hint_no_realtime;

-- Members receive the topic; a non-member, another topic and anon do not; nobody publishes on it.
do $$
declare v_user integer;
begin
	foreach v_user in array array[1, 3] loop
		perform pg_temp.as_user(v_user);
		perform pg_temp.same(public.qorpera_folder_hint_member('qorpera-folder-63000000-0000-4000-8000-000000000020')::text,
			'true', 'a member may receive the topic');
	end loop;
	perform pg_temp.same(public.qorpera_folder_hint_member('qorpera-folder-63000000-0000-4000-8000-000000000021')::text,
		'false', 'a snapshot-v1 company has no hint');
	perform pg_temp.same(public.qorpera_folder_hint_member('qorpera-folder-63000000-0000-4000-8000-00000000002x')::text,
		'false', 'a malformed topic');
	perform pg_temp.as_user(5);
	perform pg_temp.same(public.qorpera_folder_hint_member('qorpera-folder-63000000-0000-4000-8000-000000000020')::text,
		'false', 'a non-member');
	perform pg_temp.claims('anon');
	perform pg_temp.same(public.qorpera_folder_hint_member('qorpera-folder-63000000-0000-4000-8000-000000000020')::text,
		'false', 'anon');
end $$;

select pg_temp.as_user(3);
select set_config('realtime.topic', 'qorpera-folder-63000000-0000-4000-8000-000000000020', true);
set local role authenticated;
do $$ begin
	perform pg_temp.same((select count(*) from realtime.messages
		where topic = 'qorpera-folder-63000000-0000-4000-8000-000000000020')::text, '3', 'a member receives the hints');
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values ('qorpera-folder-63000000-0000-4000-8000-000000000020', 'broadcast',
			'{"schema":"qorpera.folder-hint/v1","seq":99}'::jsonb, 'folder', true);
		raise exception 'a member published on the folder topic';
	exception when insufficient_privilege then null;
	end;
end $$;
reset role;
select set_config('realtime.topic', 'qorpera-room-drafts-63000000-0000-4000-8000-000000000020', true);
set local role authenticated;
do $$ begin
	perform pg_temp.same((select count(*) from realtime.messages
		where topic = 'qorpera-folder-63000000-0000-4000-8000-000000000020')::text, '0',
		'a client joined to another topic reads none of the folder''s hints');
end $$;
reset role;
select pg_temp.as_user(5);
select set_config('realtime.topic', 'qorpera-folder-63000000-0000-4000-8000-000000000020', true);
set local role authenticated;
do $$ begin
	perform pg_temp.same((select count(*) from realtime.messages
		where topic = 'qorpera-folder-63000000-0000-4000-8000-000000000020')::text, '0', 'a non-member receives nothing');
end $$;
reset role;
select set_config('realtime.topic', '', true);
select pg_temp.claims('service_role');

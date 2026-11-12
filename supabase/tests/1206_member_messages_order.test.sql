-- Members' messages keep their order under sends at the same moment (20260930715000; review of #1638, F3), on three
-- connections. A chat's sends go one at a time (an advisory lock on the chat, held to the end of the send's
-- transaction): a second send in the chat waits for the first one's commit before it takes its place, so the chat's
-- committed messages are always a whole run and nothing turns up later in front of a message already read. A send in
-- another chat does not wait. Locks show only across connections, so the company is committed here and removed at the
-- end. The wait is seen with pg_blocking_pids, never by wall-clock time.
-- "Order shop": Ann (a), Bo (b) and Cy (c).

insert into auth.users(id, email) values
	('12060000-0000-4000-8000-00000000000a', 'order-ann@example.test'),
	('12060000-0000-4000-8000-00000000000b', 'order-bo@example.test'),
	('12060000-0000-4000-8000-00000000000c', 'order-cy@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12060000-0000-4000-8000-000000000101', 'Order shop', '12060000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12060000-0000-4000-8000-000000000101', '12060000-0000-4000-8000-00000000000a', 'order-ann@example.test', 'Ann', 'owner'),
	('12060000-0000-4000-8000-000000000101', '12060000-0000-4000-8000-00000000000b', 'order-bo@example.test', 'Bo', 'admin'),
	('12060000-0000-4000-8000-000000000101', '12060000-0000-4000-8000-00000000000c', 'order-cy@example.test', 'Cy', 'contributor');

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['order_hold', 'order_act', 'order_other']) name;

-- Signs a connection in as the member whose id ends in p_who, for its session.
create function pg_temp.order_as(p_connection text, p_who text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_connection, format('set request.jwt.claims = %L',
		format('{"sub":"12060000-0000-4000-8000-00000000000%s","role":"authenticated"}', p_who)));
	perform dblink_exec(p_connection, 'set role authenticated');
end $$;
-- What a member call answers on a connection.
create function pg_temp.order_call(p_connection text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select answer::jsonb into v from dblink(p_connection, 'select (' || p_sql || ')::text') as call(answer text);
	return v;
end $$;

do $$
declare
	v_hold integer; v_act integer; v_waited boolean := false;
	v_first jsonb; v_second jsonb; v_other jsonb; v jsonb; v_chat jsonb;
	c_shop constant text := quote_literal('12060000-0000-4000-8000-000000000101');
	c_ann constant text := quote_literal('12060000-0000-4000-8000-00000000000a');
	c_bo constant text := quote_literal('12060000-0000-4000-8000-00000000000b');
begin
	select pid into v_hold from dblink('order_hold', 'select pg_backend_pid()') as b(pid integer);
	select pid into v_act from dblink('order_act', 'select pg_backend_pid()') as b(pid integer);
	perform pg_temp.order_as('order_hold', 'b');
	perform pg_temp.order_as('order_act', 'a');
	perform pg_temp.order_as('order_other', 'c');
	-- A send that waited for a lock would be refused here, not hang the suite.
	perform dblink_exec('order_other', 'set lock_timeout = ''5s''');

	-- Bo writes to Ann, and his transaction stays open: his message has its place and is not committed.
	perform dblink_exec('order_hold', 'begin');
	v_first := pg_temp.order_call('order_hold', format(
		$q$public.qorpera_send_member_message(%s, %s, '12060000-0000-4000-8000-0000000000f1', 'First')$q$, c_shop, c_ann));

	-- Ann writes to Bo at the same moment: her send waits for his.
	perform dblink_send_query('order_act', format(
		$q$select public.qorpera_send_member_message(%s, %s, '12060000-0000-4000-8000-0000000000f2', 'Second')::text$q$,
		c_shop, c_bo));
	for attempt in 1..400 loop
		v_waited := v_hold = any(pg_blocking_pids(v_act));
		exit when v_waited or dblink_is_busy('order_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	if not v_waited then raise exception 'a second send in the chat did not wait for the first'; end if;

	-- Cy writes to Ann meanwhile: another chat, no wait.
	v_other := pg_temp.order_call('order_other', format(
		$q$public.qorpera_send_member_message(%s, %s, '12060000-0000-4000-8000-0000000000f3', 'Elsewhere')$q$, c_shop, c_ann));
	if v_other #>> '{message,text}' is distinct from 'Elsewhere' then
		raise exception 'a send in another chat waited or failed: %', v_other; end if;

	-- Nothing of Ann and Bo's chat is committed yet, so nobody has read a later message of it before an earlier one:
	-- Cy's connection, as Ann, reads the chat empty and has nothing of Bo's to mark.
	perform pg_temp.order_as('order_other', 'a');
	v := pg_temp.order_call('order_other', format('public.qorpera_read_member_chat(%s, %s)', c_shop, c_bo));
	if jsonb_array_length(v -> 'messages') <> 0 then raise exception 'a message showed before its commit: %', v; end if;
	v := pg_temp.order_call('order_other', format('public.qorpera_mark_member_chat_read(%s, %s, %s)', c_shop, c_bo,
		(v_other #>> '{message,seq}')::bigint + 1000));
	if (v ->> 'readSeq')::bigint <> 0 then raise exception 'a mark passed a message still on its way: %', v; end if;

	-- Bo's send commits; Ann's goes on and takes the place after it.
	perform dblink_exec('order_hold', 'commit');
	select answer::jsonb into v_second from dblink_get_result('order_act') as call(answer text);
	perform * from dblink_get_result('order_act', false) as call(answer text);
	if (v_second #>> '{message,seq}')::bigint <= (v_first #>> '{message,seq}')::bigint then
		raise exception 'the send that waited did not come after the first: % then %', v_first, v_second; end if;

	-- The chat as each side reads it now: both messages, in the order they were committed.
	v := pg_temp.order_call('order_other', format('public.qorpera_read_member_chat(%s, %s)', c_shop, c_bo));
	if jsonb_array_length(v -> 'messages') <> 2 or v #>> '{messages,0,text}' <> 'First' or v #>> '{messages,1,text}' <> 'Second' then
		raise exception 'the chat is not First then Second: %', v; end if;
	-- Bo's message, written first and committed first, is unread to Ann until she marks it: her own send, which took
	-- the later place, moved no mark past it.
	select chat into v_chat
	from jsonb_array_elements(pg_temp.order_call('order_other', format('public.qorpera_list_member_chats(%s)', c_shop)) -> 'chats') as chat
	where chat ->> 'userId' = '12060000-0000-4000-8000-00000000000b';
	if (v_chat ->> 'unread')::int <> 1 or (v_chat ->> 'readSeq')::bigint <> 0 then
		raise exception 'Bo''s message is not unread to Ann: %', v_chat; end if;
	v := pg_temp.order_call('order_other', format('public.qorpera_mark_member_chat_read(%s, %s, %s)', c_shop, c_bo,
		v_second #>> '{message,seq}'));
	if (v ->> 'readSeq')::bigint <> (v_second #>> '{message,seq}')::bigint then
		raise exception 'Ann''s mark did not reach the newest message: %', v; end if;
	select chat into v_chat
	from jsonb_array_elements(pg_temp.order_call('order_other', format('public.qorpera_list_member_chats(%s)', c_shop)) -> 'chats') as chat
	where chat ->> 'userId' = '12060000-0000-4000-8000-00000000000b';
	if (v_chat ->> 'unread')::int <> 0 then raise exception 'something is unread after Ann marked the chat: %', v_chat; end if;
end $$;

-- At the end: remove what the test committed.
select dblink_exec(name, 'reset role') from unnest(array['order_hold', 'order_act', 'order_other']) name;
select dblink_disconnect(name) from unnest(array['order_hold', 'order_act', 'order_other']) name;
delete from public.qorpera_profiles where id = '12060000-0000-4000-8000-000000000101';
delete from auth.users where id in ('12060000-0000-4000-8000-00000000000a', '12060000-0000-4000-8000-00000000000b',
	'12060000-0000-4000-8000-00000000000c');
do $$
begin
	if exists (select 1 from public.qorpera_member_messages where profile_id = '12060000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_member_message_reads where profile_id = '12060000-0000-4000-8000-000000000101') then
		raise exception 'the company left its member chats behind';
	end if;
end $$;

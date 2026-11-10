-- Members of a company message each other (20260930715000), as the real client role, in one transaction that is
-- rolled back. Company "Chat shop" has Ann (owner), Bo (contributor) and Cy (viewer); "Chat cafe" has Ann and Dan.
-- Eve is in no company. Each member has one chat with every other member of a company; nobody else reads it.
begin;

insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_user_meta_data)
values
	('12050000-0000-4000-8000-00000000000a', 'chat-ann@example.test', statement_timestamp(), null, '{"display_name":"Ann"}'),
	('12050000-0000-4000-8000-00000000000b', 'chat-bo@example.test', statement_timestamp(),
		statement_timestamp() - interval '2 days', '{"display_name":"Bo"}'),
	('12050000-0000-4000-8000-00000000000c', 'chat-cy@example.test', statement_timestamp(), null, '{"display_name":"Cy"}'),
	('12050000-0000-4000-8000-00000000000d', 'chat-dan@example.test', statement_timestamp(), null, '{"display_name":"Dan"}'),
	('12050000-0000-4000-8000-00000000000e', 'chat-eve@example.test', statement_timestamp(), null, '{"display_name":"Eve"}');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values
	('12050000-0000-4000-8000-000000000101', 'Chat shop', '12050000-0000-4000-8000-00000000000a'),
	('12050000-0000-4000-8000-000000000102', 'Chat cafe', '12050000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role, joined_at)
values
	('12050000-0000-4000-8000-000000000101', '12050000-0000-4000-8000-00000000000a', 'chat-ann@example.test', 'Ann', 'owner', statement_timestamp() - interval '3 days'),
	('12050000-0000-4000-8000-000000000101', '12050000-0000-4000-8000-00000000000b', 'chat-bo@example.test', 'Bo', 'contributor', statement_timestamp() - interval '2 days'),
	('12050000-0000-4000-8000-000000000101', '12050000-0000-4000-8000-00000000000c', 'chat-cy@example.test', 'Cy', 'viewer', statement_timestamp() - interval '1 day'),
	('12050000-0000-4000-8000-000000000102', '12050000-0000-4000-8000-00000000000a', 'chat-ann@example.test', 'Ann', 'owner', statement_timestamp() - interval '3 days'),
	('12050000-0000-4000-8000-000000000102', '12050000-0000-4000-8000-00000000000d', 'chat-dan@example.test', 'Dan', 'admin', statement_timestamp() - interval '2 days');

create function pg_temp.chat_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'member messages: %', p_what; end if;
end $$;
-- A person's id, by the letter that ends it.
create function pg_temp.chat_user(p_who text) returns uuid language sql immutable as $$
	select ('12050000-0000-4000-8000-00000000000' || p_who)::uuid
$$;
-- Signs p_who in as the client role (null: signed out, the anon role) for the rest of the transaction or block.
create function pg_temp.chat_sign_in(p_who text) returns void language plpgsql as $$
begin
	if p_who is null then
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		set local role anon;
	else
		perform set_config('request.jwt.claims',
			jsonb_build_object('role', 'authenticated', 'sub', pg_temp.chat_user(p_who))::text, true);
		set local role authenticated;
	end if;
end $$;
-- What the call p_sql answers p_who, with "$shop" and "$cafe" standing for the two companies and "$a" to "$e" for the
-- people. The checks around it run as the suite's own role.
create function pg_temp.chat_sql(p_sql text) returns text language sql immutable as $$
	select replace(replace(replace(replace(replace(replace(replace(p_sql,
		'$shop', quote_literal('12050000-0000-4000-8000-000000000101')),
		'$cafe', quote_literal('12050000-0000-4000-8000-000000000102')),
		'$a', quote_literal(pg_temp.chat_user('a'))), '$b', quote_literal(pg_temp.chat_user('b'))),
		'$c', quote_literal(pg_temp.chat_user('c'))), '$d', quote_literal(pg_temp.chat_user('d'))),
		'$e', quote_literal(pg_temp.chat_user('e')))
$$;
create function pg_temp.chat_call(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; v_sql text := 'select (' || pg_temp.chat_sql(p_sql) || ')::jsonb';
begin
	perform pg_temp.chat_sign_in(p_who);
	execute v_sql into v;
	reset role;
	perform set_config('request.jwt.claims', '', true);
	return v;
end $$;
-- The call p_sql by p_who is refused with p_state; what it changed, the sign-in and the role end with it.
create function pg_temp.chat_refused(p_who text, p_sql text, p_state text, p_what text) returns void language plpgsql as $$
declare v_state text; v_message text; v_sql text := 'select ' || pg_temp.chat_sql(p_sql);
begin
	begin
		perform pg_temp.chat_sign_in(p_who);
		execute v_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_state = p_state then return; end if;
		raise exception 'member messages: % refused with % %, expected %', p_what, v_state, v_message, p_state;
	end;
	raise exception 'member messages: not refused: %', p_what;
end $$;
-- One chat of a list, by the other member's letter.
create function pg_temp.chat_of(p_list jsonb, p_who text) returns jsonb language sql as $$
	select chat from jsonb_array_elements(p_list -> 'chats') as chat where chat ->> 'userId' = pg_temp.chat_user(p_who)::text
$$;
-- The live hints sent so far, as the letters of the members of "Chat shop" they went to, sorted.
create function pg_temp.chat_hints() returns text language sql as $$
	select coalesce(string_agg(distinct right(topic, 1), '' order by right(topic, 1)), '')
	from realtime.messages
	where event = 'member-chats' and topic like 'qorpera-live-12050000-0000-4000-8000-000000000101-%'
$$;
-- What a commit would send now: the deferred hints fire.
create function pg_temp.chat_flush() returns void language plpgsql as $$
begin
	set constraints qorpera_member_chat_hint immediate;
	set constraints qorpera_member_chat_hint deferred;
end $$;
create function pg_temp.chat_clear() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
	select set_config('qorpera.live_hints_failed', '', true)::void;
$$;

-- 1. The API roles: authenticated calls the five functions, anon none; nobody reaches the tables, the message order
-- or the helpers; the marker.
select pg_temp.chat_assert(
	has_function_privilege('authenticated', signature, 'EXECUTE') and not has_function_privilege('anon', signature, 'EXECUTE')
		and not has_function_privilege('service_role', signature, 'EXECUTE')
		and position('20260930715000' in pg_get_functiondef(signature::regprocedure)) > 0,
	'authenticated alone may call ' || signature)
from unnest(array['public.qorpera_list_member_chats(uuid)', 'public.qorpera_read_member_chat(uuid,uuid,bigint,integer)',
	'public.qorpera_send_member_message(uuid,uuid,uuid,text)', 'public.qorpera_mark_member_chat_read(uuid,uuid,bigint)',
	'public.qorpera_delete_member_message(uuid,uuid)']) as signature;
select pg_temp.chat_assert(
	not has_function_privilege(role_name, signature, 'EXECUTE'), role_name || ' may not call ' || signature)
from unnest(array['public.qorpera_member_chat_pair(uuid,uuid)',
		'public.qorpera_member_message_json(uuid,bigint,uuid,timestamptz,timestamptz,text)',
		'public.qorpera_member_chat_hint()']) as signature,
	unnest(array['anon', 'authenticated', 'service_role']) as role_name;
select pg_temp.chat_assert(
	not has_table_privilege(role_name, table_name, 'SELECT') and not has_table_privilege(role_name, table_name, 'INSERT')
		and not has_table_privilege(role_name, table_name, 'UPDATE') and not has_table_privilege(role_name, table_name, 'DELETE'),
	role_name || ' may not touch ' || table_name)
from unnest(array['public.qorpera_member_messages', 'public.qorpera_member_message_reads']) as table_name,
	unnest(array['anon', 'authenticated', 'service_role']) as role_name;
select pg_temp.chat_assert(
	not has_sequence_privilege(role_name, 'public.qorpera_member_messages_seq_seq', 'USAGE'),
	role_name || ' may not use the message order')
from unnest(array['anon', 'authenticated', 'service_role']) as role_name;
select pg_temp.chat_refused('a', '(select count(*) from public.qorpera_member_messages)', '42501', 'a member reading the messages table');
select pg_temp.chat_refused('a', '(select count(*) from public.qorpera_member_message_reads)', '42501', 'a member reading the read marks');
-- No link to the accounts: an account's deletion is not what removes a chat (720's rule for company data).
select pg_temp.chat_assert(not exists (select 1 from pg_catalog.pg_constraint as link
	where link.contype = 'f' and link.confrelid = 'auth.users'::regclass
		and link.conrelid in ('public.qorpera_member_messages'::regclass, 'public.qorpera_member_message_reads'::regclass)),
	'no link from the member chats to the accounts');

-- 2. Ann's list before anyone wrote: Bo and Cy, in the order they joined, nothing unread, no last message. Bo has no
-- online mark, so his last sign-in stands in; Cy has neither.
do $$
declare v jsonb := pg_temp.chat_call('a', 'public.qorpera_list_member_chats($shop)');
begin
	perform pg_temp.chat_assert(v ->> 'schema' = 'qorpera.member-chats/v1' and jsonb_array_length(v -> 'chats') = 2
		and v -> 'chats' -> 0 ->> 'userId' = pg_temp.chat_user('b')::text
		and v -> 'chats' -> 1 ->> 'userId' = pg_temp.chat_user('c')::text
		and (v -> 'chats' -> 0 ->> 'unread')::int = 0 and jsonb_typeof(v -> 'chats' -> 0 -> 'last') = 'null'
		and (v -> 'chats' -> 0 ->> 'readSeq')::bigint = 0 and (v -> 'chats' -> 0 ->> 'theirReadSeq')::bigint = 0
		and (v -> 'chats' -> 0 ->> 'lastSeenAt')::timestamptz < statement_timestamp() - interval '1 day'
		and jsonb_typeof(v -> 'chats' -> 1 -> 'lastSeenAt') = 'null',
		'Ann''s empty list: ' || v::text);
end $$;

-- 3. Ann writes to Bo. The same call again is the same message; the id with other words, or for Cy, is refused.
do $$
declare v jsonb; v_again jsonb;
begin
	v := pg_temp.chat_call('a', $q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f1', E'Hi Bo\nsecond line')$q$);
	perform pg_temp.chat_assert(v ->> 'schema' = 'qorpera.member-message/v1' and v ->> 'userId' = pg_temp.chat_user('b')::text
		and v -> 'message' ->> 'text' = E'Hi Bo\nsecond line'
		and v -> 'message' ->> 'authorUserId' = pg_temp.chat_user('a')::text
		and (v -> 'message' ->> 'createdAt')::timestamptz <= clock_timestamp()
		and (v -> 'message' ->> 'seq')::bigint > 0 and not (v -> 'message' ? 'deleted'), 'Ann''s first message: ' || v::text);
	v_again := pg_temp.chat_call('a', $q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f1', E'Hi Bo\nsecond line')$q$);
	perform pg_temp.chat_assert(v_again = v, 'a repeated send is the same message: ' || v_again::text);
	perform pg_temp.chat_assert((select count(*) from public.qorpera_member_messages) = 1, 'a repeated send writes nothing');
	-- Writing moves no read mark: a mark says what its member has seen.
	perform pg_temp.chat_assert(not exists (select 1 from public.qorpera_member_message_reads), 'a send writes no read mark');
	perform set_config('chat.first', v -> 'message' ->> 'seq', true);
	perform set_config('chat.first_id', v -> 'message' ->> 'id', true);
end $$;
select pg_temp.chat_refused('a', $q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f1', 'Other words')$q$,
	'23505', 'the same id with other words');
select pg_temp.chat_refused('a', $q$public.qorpera_send_member_message($shop, $c, '12050000-0000-4000-8000-0000000000f1', E'Hi Bo\nsecond line')$q$,
	'23505', 'the same id for another member');
-- What is no message, and whom Ann cannot write to here: herself, Dan (not in this company), Eve (in none), nobody.
select pg_temp.chat_refused('a', format($q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f2', %L)$q$, body),
	'22023', what)
from (values (E' \n\t', 'a blank message'), (repeat('a', 16385), 'a message over 16 KiB')) as bad(body, what);
select pg_temp.chat_refused('a', $q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f2', null)$q$,
	'22023', 'a message without words');
select pg_temp.chat_refused('a', $q$public.qorpera_send_member_message($shop, $b, null, 'No id')$q$, '22023', 'a message without its id');
select pg_temp.chat_refused('a', format($q$public.qorpera_send_member_message($shop, %s, '12050000-0000-4000-8000-0000000000f3', 'Hello')$q$, whom),
	'42501', 'writing to ' || what)
from (values ('$a', 'herself'), ('$d', 'a member of another company'), ('$e', 'someone in no company'), ('null', 'nobody')) as bad(whom, what);
-- A 16 KiB message is the longest one.
select pg_temp.chat_assert(length(pg_temp.chat_call('a', format(
	$q$public.qorpera_send_member_message($shop, $c, '12050000-0000-4000-8000-0000000000f4', %L)$q$, repeat('a', 16384)))
	-> 'message' ->> 'text') = 16384, 'a 16 KiB message to Cy');

-- At commit, Ann's two messages hint Ann, Bo and Cy, and nobody in another company; a hint carries nothing.
select pg_temp.chat_flush();
select pg_temp.chat_assert(pg_temp.chat_hints() = 'abc', 'hints after Ann wrote to Bo and Cy: ' || pg_temp.chat_hints());
select pg_temp.chat_assert((select count(*) = 3 and bool_and(payload = '{"schema":"qorpera.live-hint/v1"}'::jsonb and private
		and extension = 'broadcast' and topic like 'qorpera-live-12050000-0000-4000-8000-000000000101-%')
	from realtime.messages where event = 'member-chats'), 'one hint per member, with no row and no id, inside the company');
select pg_temp.chat_clear();

-- 4. Bo sees one unread message from Ann with its words, reads the chat, and marks it read.
do $$
declare v jsonb; v_chat jsonb; v_first bigint := current_setting('chat.first')::bigint;
begin
	v := pg_temp.chat_call('b', 'public.qorpera_list_member_chats($shop)');
	v_chat := pg_temp.chat_of(v, 'a');
	perform pg_temp.chat_assert((v_chat ->> 'unread')::int = 1 and v_chat -> 'last' ->> 'text' = E'Hi Bo\nsecond line'
		and (v_chat -> 'last' ->> 'seq')::bigint = v_first
		and (v_chat ->> 'readSeq')::bigint = 0 and (v_chat ->> 'theirReadSeq')::bigint = 0,
		'Bo''s list with Ann''s message: ' || v_chat::text);
	-- Bo's chat with Cy is empty: Ann's message to Cy is not his to see, in the list or by reading.
	v_chat := pg_temp.chat_of(v, 'c');
	perform pg_temp.chat_assert((v_chat ->> 'unread')::int = 0 and jsonb_typeof(v_chat -> 'last') = 'null', 'Bo''s chat with Cy is empty');
	v := pg_temp.chat_call('b', 'public.qorpera_read_member_chat($shop, $c)');
	perform pg_temp.chat_assert(jsonb_array_length(v -> 'messages') = 0 and not (v ->> 'hasMore')::boolean,
		'Bo reads nothing of Ann and Cy''s chat');
	v := pg_temp.chat_call('b', 'public.qorpera_read_member_chat($shop, $a)');
	perform pg_temp.chat_assert(v ->> 'schema' = 'qorpera.member-chat/v1' and v ->> 'userId' = pg_temp.chat_user('a')::text
		and jsonb_array_length(v -> 'messages') = 1
		and (v -> 'messages' -> 0 ->> 'seq')::bigint = v_first and not (v ->> 'hasMore')::boolean
		and (v ->> 'readSeq')::bigint = 0 and (v ->> 'theirReadSeq')::bigint = 0, 'Bo reads the chat: ' || v::text);
	-- A mark far ahead stops at the chat's newest message (Ann's message to Cy came later and is not Bo's).
	v := pg_temp.chat_call('b', format('public.qorpera_mark_member_chat_read($shop, $a, %s)', v_first + 1000));
	perform pg_temp.chat_assert(v ->> 'schema' = 'qorpera.member-chat-read/v1' and (v ->> 'readSeq')::bigint = v_first, 'Bo''s mark: ' || v::text);
	-- It never moves back, and a mark at no message changes nothing.
	v := pg_temp.chat_call('b', 'public.qorpera_mark_member_chat_read($shop, $a, 0)');
	perform pg_temp.chat_assert((v ->> 'readSeq')::bigint = v_first, 'a mark never moves back: ' || v::text);
	v := pg_temp.chat_call('b', 'public.qorpera_mark_member_chat_read($shop, $a, null)');
	perform pg_temp.chat_assert((v ->> 'readSeq')::bigint = v_first, 'a mark without a message changes nothing: ' || v::text);
	-- Bo has no chat with Cy to mark: nothing is written.
	v := pg_temp.chat_call('b', format('public.qorpera_mark_member_chat_read($shop, $c, %s)', v_first + 1000));
	perform pg_temp.chat_assert((v ->> 'readSeq')::bigint = 0, 'a mark in an empty chat: ' || v::text);
	v_chat := pg_temp.chat_of(pg_temp.chat_call('b', 'public.qorpera_list_member_chats($shop)'), 'a');
	perform pg_temp.chat_assert((v_chat ->> 'unread')::int = 0 and (v_chat ->> 'readSeq')::bigint = v_first,
		'nothing unread once marked: ' || v_chat::text);
end $$;
-- Bo cannot take back Ann's message, and nobody takes back one that is not there.
select pg_temp.chat_refused('b', format('public.qorpera_delete_member_message($shop, %L)', current_setting('chat.first_id')),
	'42501', 'Bo taking back Ann''s message');
select pg_temp.chat_refused('a', $q$public.qorpera_delete_member_message($shop, '12050000-0000-4000-8000-0000000000ff')$q$,
	'42501', 'taking back a message that is not there');
-- Bo answers twice.
select pg_temp.chat_call('b', $q$public.qorpera_send_member_message($shop, $a, '12050000-0000-4000-8000-0000000000b1', 'Hi Ann')$q$) \g /dev/null
select pg_temp.chat_call('b', $q$public.qorpera_send_member_message($shop, $a, '12050000-0000-4000-8000-0000000000b2', 'Second from Bo')$q$) \g /dev/null

-- Bo's mark and his messages hint Ann and Bo only.
select pg_temp.chat_flush();
select pg_temp.chat_assert(pg_temp.chat_hints() = 'ab', 'hints after Bo read and answered: ' || pg_temp.chat_hints());
select pg_temp.chat_clear();

-- 5. Ann sees Bo's read mark ("Seen") and two unread messages, pages the chat, and takes back her first message.
do $$
declare v jsonb; v_chat jsonb; v_page jsonb; v_first bigint := current_setting('chat.first')::bigint;
begin
	v_chat := pg_temp.chat_of(pg_temp.chat_call('a', 'public.qorpera_list_member_chats($shop)'), 'b');
	-- Bo's mark stands at Ann's message, where he put it: his own two messages did not move it, nor any mark of Ann's.
	perform pg_temp.chat_assert((v_chat ->> 'unread')::int = 2 and v_chat -> 'last' ->> 'text' = 'Second from Bo'
		and (v_chat ->> 'theirReadSeq')::bigint = v_first and (v_chat ->> 'readSeq')::bigint = 0,
		'Ann''s list after Bo answered: ' || v_chat::text);
	v := pg_temp.chat_call('a', 'public.qorpera_read_member_chat($shop, $b, null, 2)');
	perform pg_temp.chat_assert(jsonb_array_length(v -> 'messages') = 2 and (v ->> 'hasMore')::boolean
		and v -> 'messages' -> 0 ->> 'text' = 'Hi Ann' and v -> 'messages' -> 1 ->> 'text' = 'Second from Bo',
		'the newest page, oldest first: ' || v::text);
	-- Ann has seen "Hi Ann" and not yet the message after it: one is left unread.
	perform pg_temp.chat_call('a', format('public.qorpera_mark_member_chat_read($shop, $b, %s)', v -> 'messages' -> 0 ->> 'seq'));
	v_chat := pg_temp.chat_of(pg_temp.chat_call('a', 'public.qorpera_list_member_chats($shop)'), 'b');
	perform pg_temp.chat_assert((v_chat ->> 'unread')::int = 1
		and (v_chat ->> 'readSeq')::bigint = (v -> 'messages' -> 0 ->> 'seq')::bigint, 'Ann''s mark at Bo''s first answer: ' || v_chat::text);
	v_page := pg_temp.chat_call('a', format('public.qorpera_read_member_chat($shop, $b, %s, 2)', v -> 'messages' -> 0 ->> 'seq'));
	perform pg_temp.chat_assert(jsonb_array_length(v_page -> 'messages') = 1 and not (v_page ->> 'hasMore')::boolean
		and (v_page -> 'messages' -> 0 ->> 'seq')::bigint = v_first, 'the page before it: ' || v_page::text);
	-- A page asks for 1 to 200 messages; anything else is brought inside.
	v_page := pg_temp.chat_call('a', 'public.qorpera_read_member_chat($shop, $b, null, 0)');
	perform pg_temp.chat_assert(jsonb_array_length(v_page -> 'messages') = 1 and (v_page ->> 'hasMore')::boolean, 'a page of at least one');
	v := pg_temp.chat_call('a', format('public.qorpera_delete_member_message($shop, %L)', current_setting('chat.first_id')));
	perform pg_temp.chat_assert((v -> 'message' ->> 'deleted')::boolean and not (v -> 'message' ? 'text')
		and v ->> 'userId' = pg_temp.chat_user('b')::text and (v -> 'message' ->> 'seq')::bigint = v_first,
		'a message taken back: ' || v::text);
	perform pg_temp.chat_assert(pg_temp.chat_call('a', format('public.qorpera_delete_member_message($shop, %L)',
		current_setting('chat.first_id'))) = v, 'taking it back twice answers the same');
	-- Its id still answers the same call, deleted.
	v := pg_temp.chat_call('a', $q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f1', E'Hi Bo\nsecond line')$q$);
	perform pg_temp.chat_assert((v -> 'message' ->> 'deleted')::boolean, 'a repeated send of a message taken back: ' || v::text);
	v := pg_temp.chat_call('a', 'public.qorpera_read_member_chat($shop, $b)');
	perform pg_temp.chat_assert(jsonb_array_length(v -> 'messages') = 3 and (v -> 'messages' -> 0 ->> 'deleted')::boolean
		and not (v -> 'messages' -> 0 ? 'text'), 'the chat keeps the place of a message taken back: ' || v::text);
end $$;
select pg_temp.chat_assert((select body = '' and deleted_at is not null from public.qorpera_member_messages
	where id = current_setting('chat.first_id')::uuid), 'a message taken back keeps no words');
select pg_temp.chat_flush();
select pg_temp.chat_assert(pg_temp.chat_hints() = 'ab', 'hints after Ann took a message back: ' || pg_temp.chat_hints());
select pg_temp.chat_clear();

-- 6. Cy, a viewer, reads Ann's long message and answers: people talk whatever their role.
do $$
declare v jsonb;
begin
	v := pg_temp.chat_call('c', 'public.qorpera_read_member_chat($shop, $a)');
	perform pg_temp.chat_assert(jsonb_array_length(v -> 'messages') = 1, 'Cy reads Ann''s message');
	v := pg_temp.chat_call('c', $q$public.qorpera_send_member_message($shop, $a, '12050000-0000-4000-8000-0000000000c1', 'Hi from a viewer')$q$);
	perform pg_temp.chat_assert(v -> 'message' ->> 'text' = 'Hi from a viewer', 'a viewer writes');
	-- Writing moved no mark: Ann's message is unread to Cy until Cy's own mark says it was seen. Cy's own message is
	-- never unread to Cy.
	v := pg_temp.chat_of(pg_temp.chat_call('c', 'public.qorpera_list_member_chats($shop)'), 'a');
	perform pg_temp.chat_assert((v ->> 'unread')::int = 1 and (v ->> 'readSeq')::bigint = 0
		and v -> 'last' ->> 'text' = 'Hi from a viewer', 'Cy''s list after writing: ' || v::text);
	perform pg_temp.chat_call('c', format('public.qorpera_mark_member_chat_read($shop, $a, %s)', v -> 'last' ->> 'seq'));
	v := pg_temp.chat_of(pg_temp.chat_call('c', 'public.qorpera_list_member_chats($shop)'), 'a');
	perform pg_temp.chat_assert((v ->> 'unread')::int = 0, 'Cy has nothing unread once marked: ' || v::text);
end $$;

-- 7. Dan and Eve are not in "Chat shop", and nobody is signed out: every call is refused.
select pg_temp.chat_refused(who, call, '42501', coalesce(who, 'signed out') || ' calling ' || call)
from unnest(array['d', 'e', null]) as who,
	unnest(array['public.qorpera_list_member_chats($shop)',
		'public.qorpera_read_member_chat($shop, $a)',
		$q$public.qorpera_send_member_message($shop, $a, '12050000-0000-4000-8000-0000000000d1', 'Let me in')$q$,
		'public.qorpera_mark_member_chat_read($shop, $a, 1)',
		$q$public.qorpera_delete_member_message($shop, '12050000-0000-4000-8000-0000000000f1')$q$]) as call;
-- Ann and Dan's chat in "Chat cafe" is its own, and a message id is each company's own.
do $$
declare v jsonb;
begin
	v := pg_temp.chat_call('d', 'public.qorpera_list_member_chats($cafe)');
	perform pg_temp.chat_assert(jsonb_array_length(v -> 'chats') = 1 and v -> 'chats' -> 0 ->> 'userId' = pg_temp.chat_user('a')::text
		and jsonb_typeof(v -> 'chats' -> 0 -> 'last') = 'null', 'Dan''s list in the other company: ' || v::text);
	v := pg_temp.chat_call('d', $q$public.qorpera_send_member_message($cafe, $a, '12050000-0000-4000-8000-0000000000f1', 'Same id, another company')$q$);
	perform pg_temp.chat_assert(v -> 'message' ->> 'text' = 'Same id, another company', 'Dan writes to Ann in the other company');
	v := pg_temp.chat_call('a', 'public.qorpera_list_member_chats($cafe)');
	perform pg_temp.chat_assert(jsonb_array_length(v -> 'chats') = 1 and (v -> 'chats' -> 0 ->> 'unread')::int = 1,
		'Ann''s list in the other company: ' || v::text);
end $$;

-- 8. A message taken back before it was read is not unread: Bo's "Second from Bo", unread for Ann, goes.
do $$
declare v_id text; v_chat jsonb;
begin
	select message ->> 'id' into v_id
	from jsonb_array_elements(pg_temp.chat_call('b', 'public.qorpera_read_member_chat($shop, $a)') -> 'messages') as message
	where message ->> 'text' = 'Second from Bo';
	perform pg_temp.chat_call('b', format('public.qorpera_delete_member_message($shop, %L)', v_id));
	v_chat := pg_temp.chat_of(pg_temp.chat_call('a', 'public.qorpera_list_member_chats($shop)'), 'b');
	perform pg_temp.chat_assert((v_chat ->> 'unread')::int = 0 and (v_chat -> 'last' ->> 'deleted')::boolean,
		'a message taken back unread is not counted: ' || v_chat::text);
end $$;

-- 9. Bo leaves the company: what still waited for a commit goes to nobody who left; Ann's list no longer names him,
-- his chat takes no call, and a later change to it hints only Ann. The messages stay the company's.
delete from public.qorpera_profile_members
where profile_id = '12050000-0000-4000-8000-000000000101' and user_id = '12050000-0000-4000-8000-00000000000b';
select pg_temp.chat_flush();
select pg_temp.chat_assert(pg_temp.chat_hints() = 'ac', 'hints once Bo has left: ' || pg_temp.chat_hints());
select pg_temp.chat_clear();
select pg_temp.chat_assert(pg_temp.chat_of(pg_temp.chat_call('a', 'public.qorpera_list_member_chats($shop)'), 'b') is null,
	'a member who left is in no list');
select pg_temp.chat_refused('a', call, '42501', 'Ann calling ' || call || ' after Bo left')
from unnest(array['public.qorpera_read_member_chat($shop, $b)',
	$q$public.qorpera_send_member_message($shop, $b, '12050000-0000-4000-8000-0000000000f5', 'Are you there')$q$,
	'public.qorpera_mark_member_chat_read($shop, $b, 9999)']) as call;
select pg_temp.chat_assert((select count(*) from public.qorpera_member_messages
	where profile_id = '12050000-0000-4000-8000-000000000101' and user_high = '12050000-0000-4000-8000-00000000000b') = 3,
	'the messages of a member who left stay with the company');
update public.qorpera_member_message_reads set read_seq = read_seq + 1
where profile_id = '12050000-0000-4000-8000-000000000101' and user_id = '12050000-0000-4000-8000-00000000000a'
	and other_user_id = '12050000-0000-4000-8000-00000000000b';
select pg_temp.chat_flush();
select pg_temp.chat_assert(pg_temp.chat_hints() = 'a', 'a member who left hears nothing: ' || pg_temp.chat_hints());
select pg_temp.chat_clear();

-- 10. A company being deleted: no call, and no hint.
insert into public.qorpera_company_deletions (profile_id) values ('12050000-0000-4000-8000-000000000101');
select pg_temp.chat_refused('a', call, '42501', 'a company being deleted: ' || call)
from unnest(array['public.qorpera_list_member_chats($shop)', 'public.qorpera_read_member_chat($shop, $c)',
	$q$public.qorpera_send_member_message($shop, $c, '12050000-0000-4000-8000-0000000000f5', 'Still here')$q$,
	format('public.qorpera_delete_member_message($shop, %L)', current_setting('chat.first_id'))]) as call;
update public.qorpera_member_messages set deleted_at = clock_timestamp(), body = ''
where profile_id = '12050000-0000-4000-8000-000000000101' and deleted_at is null;
select pg_temp.chat_flush();
select pg_temp.chat_assert(pg_temp.chat_hints() = '', 'a company being deleted sends no hint: ' || pg_temp.chat_hints());
delete from public.qorpera_company_deletions where profile_id = '12050000-0000-4000-8000-000000000101';
select pg_temp.chat_clear();

-- 11. A failing Realtime never fails the write: with the hint's insert refused, the message is still sent, and
-- hinting stops for the rest of the transaction.
alter table realtime.messages add constraint chat_test_refuse check (event is distinct from 'member-chats');
select pg_temp.chat_call('a', $q$public.qorpera_send_member_message($shop, $c, '12050000-0000-4000-8000-0000000000f6', 'Sent while Realtime fails')$q$) \g /dev/null
select pg_temp.chat_flush();
select pg_temp.chat_assert(exists (select 1 from public.qorpera_member_messages where body = 'Sent while Realtime fails')
	and current_setting('qorpera.live_hints_failed', true) = 'on', 'a refused hint leaves the message and stops hinting');

-- 12. The chats go with their company: each table's one link is to the company's row, and it cascades. The hint
-- fires on no delete, so the company's purge meets no trigger here (715 checks every delete trigger it can reach).
select pg_temp.chat_assert((select count(*) = 2 and bool_and(link.confdeltype = 'c' and link.confrelid = 'public.qorpera_profiles'::regclass)
	from pg_catalog.pg_constraint as link
	where link.contype = 'f'
		and link.conrelid in ('public.qorpera_member_messages'::regclass, 'public.qorpera_member_message_reads'::regclass)),
	'a deleted company takes its member chats along');
select pg_temp.chat_assert((select count(*) = 2 and bool_and(trigger_row.tgtype & 8 = 0 and trigger_row.tgdeferrable
		and trigger_row.tginitdeferred)
	from pg_catalog.pg_trigger as trigger_row
	where trigger_row.tgname = 'qorpera_member_chat_hint' and not trigger_row.tgisinternal), 'the hint is deferred and fires on no delete');

rollback;

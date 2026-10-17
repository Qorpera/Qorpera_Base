-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The Mailbox's Sent view and a thread's older messages (20260930512000, C6e), on the folder-v2 runtime base. The
-- threads call lists only the threads whose newest message went the asked way, newest first, and pages through all of
-- them, with a state or an address too. The thread call reads a thread of 120 messages, received and sent, in pages of
-- 50 from the newest: each page oldest first, each message once, in the thread's own order, the next page starting
-- before the message a page names. An older page hides account mail as the newest page does. Who may read is
-- unchanged: a viewer reads, an outsider does not, and a request of another shape is refused.

select pg_temp.base_claims('service_role');
-- A received email as the mail door stores it: the delivery of its first recipient.
create function pg_temp.mt_received(p_n integer, p_to text, p_message jsonb default '{}') returns uuid language sql as $$
	select (public.qorpera_receive_mail('69500000-0000-4000-8000-' || lpad(p_n::text, 12, '0'), array[p_to],
		(jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '69500000-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
			'subject', 'Re: Order 7', 'from', 'Customer <customer@example.org>', 'to', jsonb_build_array(p_to),
			'text', 'Message ' || p_n) || p_message)::text) #>> '{results,0,deliveryId}')::uuid
$$;
-- An email the base run's agent sends from the support mailbox: its outbox id.
create function pg_temp.mt_sent(p_call text, p_extra jsonb default '{}') returns uuid language plpgsql as $$
begin
	perform public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, p_call,
		jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
			'subject', 'Re: Order 7', 'text', 'Reply ' || p_call) || p_extra);
	return (select mail.id from public.qorpera_company_mail_outbox as mail where mail.call_id = p_call);
end $$;
-- The threads the calling member's list shows for a request, in its order.
create function pg_temp.mt_listed(p_request jsonb) returns text[] language sql as $$
	select coalesce(array_agg(entry.item ->> 'thread' order by entry.n), '{}')
	from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', p_request)
		-> 'threads') with ordinality as entry(item, n)
$$;
-- The company's threads whose newest message went that way, newest first, from the table.
create function pg_temp.mt_threads(p_direction text) returns text[] language sql as $$
	select coalesce(array_agg(thread.id order by thread.last_at desc, thread.id desc), '{}')
	from public.qorpera_mail_threads as thread
	where thread.environment_id = '92400000-0000-4000-8000-000000000020' and thread.last_direction = p_direction
$$;
-- One page of a thread, as the calling member reads it.
create function pg_temp.mt_page(p_thread text, p_before jsonb default null) returns jsonb language sql as $$
	select public.qorpera_member_mail_thread('92400000-0000-4000-8000-000000000020', p_thread, p_before)
$$;
-- A page's messages by their ids (a received one's delivery, a sent one's outbox id), in its order.
create function pg_temp.mt_ids(p_page jsonb) returns text[] language sql as $$
	select coalesce(array_agg(coalesce(entry.item ->> 'deliveryId', entry.item ->> 'mailId') order by entry.n), '{}')
	from jsonb_array_elements(p_page -> 'messages') with ordinality as entry(item, n)
$$;
-- Every message of a thread, oldest first, from the tables.
create function pg_temp.mt_order(p_thread text) returns text[] language sql as $$
	select array_agg(both_kinds.id order by both_kinds.at, both_kinds.key) from (
		select received.received_at as at, 'received:' || received.delivery_id as key, received.delivery_id::text as id
		from public.qorpera_mail_received as received where received.thread_id = p_thread
		union all
		select mail.created_at, 'sent:' || mail.id, mail.id::text
		from public.qorpera_company_mail_outbox as mail where mail.thread = p_thread) as both_kinds
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support', 'Customer support') \g /dev/null
select pg_temp.base_claims('service_role');
-- An account an agent used, on a tagged address of the support mailbox (as 815 writes it).
select set_config('session_replication_role', 'replica', true) \g /dev/null
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
	opened_by_user_id, created_at, closed_at, last_used_at, last_used_by_staff_agent_id, connected_at)
values ('69500000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'acme.example', 'support+acme@mail.example.test', 'connected', '92400000-0000-4000-8000-000000000001',
	'2026-10-01T00:00:00Z', null, '2026-10-02T09:00:00Z', '92400000-0000-4000-8000-000000000030', '2026-10-01T00:00:00Z');
select set_config('session_replication_role', 'origin', true) \g /dev/null

-- Thread A: 120 messages. The first is received; then every third is the agent's reply and the others are the
-- customer's, one of them (4) account mail. Its newest message is a reply.
do $$
declare
	v_first uuid := pg_temp.mt_received(0, 'support@mail.example.test', '{"messageId":"<a0@acme.test>","subject":"Order 7"}');
	v_n integer;
begin
	perform set_config('qorpera_test.mt_thread', (select received.thread_id from public.qorpera_mail_received as received
		where received.delivery_id = v_first), true);
	for v_n in 1 .. 119 loop
		if v_n % 3 = 2 then
			perform pg_temp.mt_sent('mt-a-' || v_n, jsonb_build_object('inReplyTo', v_first));
		elsif v_n = 4 then
			perform set_config('qorpera_test.mt_code', pg_temp.mt_received(v_n, 'support+acme@mail.example.test',
				'{"messageId":"<a4@acme.test>","references":"<a0@acme.test>","subject":"Your code is 424242","text":"Code 424242","cc":["boss@acme.example"],"attachments":[{"id":"att_code","filename":"code.pdf","size":3}]}')::text,
				true);
		else
			perform pg_temp.mt_received(v_n, 'support@mail.example.test',
				jsonb_build_object('messageId', '<a' || v_n || '@acme.test>', 'references', '<a0@acme.test>'));
		end if;
	end loop;
end
$$;
-- Thread B: one received email. Thread C: one received and its reply. Thread D: an email the agent started.
-- (Two statements: a statement does not see the rows a function it calls has written.)
select set_config('qorpera_test.mt_b', pg_temp.mt_received(200, 'support@mail.example.test',
	'{"messageId":"<b@other.test>","subject":"Question"}')::text, true) \g /dev/null
select set_config('qorpera_test.mt_b', (select received.thread_id from public.qorpera_mail_received as received
	where received.delivery_id = current_setting('qorpera_test.mt_b')::uuid), true) \g /dev/null
select set_config('qorpera_test.mt_c_first', pg_temp.mt_received(201, 'support@mail.example.test',
	'{"messageId":"<c@other.test>","subject":"Invoice"}')::text, true) \g /dev/null
select pg_temp.mt_sent('mt-c', jsonb_build_object('inReplyTo', current_setting('qorpera_test.mt_c_first'))) \g /dev/null
select pg_temp.mt_sent('mt-d', '{"subject":"Hello"}') \g /dev/null
select pg_temp.base_assert((select count(*) = 4 from public.qorpera_mail_threads
		where environment_id = '92400000-0000-4000-8000-000000000020')
	and (select message_count = 120 from public.qorpera_mail_threads where id = current_setting('qorpera_test.mt_thread'))
	and cardinality(pg_temp.mt_order(current_setting('qorpera_test.mt_thread'))) = 120
	and pg_temp.mt_threads('sent') @> array[current_setting('qorpera_test.mt_thread')] and cardinality(pg_temp.mt_threads('sent')) = 3
	and pg_temp.mt_threads('received') = array[current_setting('qorpera_test.mt_b')],
	'The fixture has four threads, thread A with 120 messages, three of them last sent and B last received');

-- 1. Threads by the newest message's direction ------------------------------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.mt_listed('{"direction":"sent"}') = pg_temp.mt_threads('sent')
		and pg_temp.mt_listed('{"direction":"received"}') = pg_temp.mt_threads('received')
		and cardinality(pg_temp.mt_listed('{}')) = 4,
	'Sent lists the three threads last sent, received the one last received, newest first; no direction lists all four');
select pg_temp.base_assert((select bool_and(item ->> 'direction' = direction) from (values ('sent'), ('received')) as asked(direction)
		cross join lateral jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
			jsonb_build_object('direction', asked.direction)) -> 'threads') as entry(item)),
	'Each row of a direction''s list shows that direction');
-- A page of Sent ends before the sent threads do and names where the next starts; the next one has the rest.
select set_config('qorpera_test.mt_sent_1', public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
	'{"direction":"sent","limit":2}')::text, true) \g /dev/null
select pg_temp.base_assert(jsonb_array_length(first -> 'threads') = 2 and first ? 'nextBefore'
		and not second ? 'nextBefore'
		and array(select item ->> 'thread' from jsonb_array_elements((first -> 'threads') || (second -> 'threads')) as entry(item))
			= pg_temp.mt_threads('sent'),
	'Sent pages through every sent thread: ' || first::text || ' then ' || second::text)
from (select current_setting('qorpera_test.mt_sent_1')::jsonb as first) as one
cross join lateral (select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
	jsonb_build_object('direction', 'sent', 'limit', 2, 'before', one.first -> 'nextBefore')) as second) as two;
-- With a state and with an address.
select pg_temp.base_assert(pg_temp.mt_listed('{"direction":"received","state":"new"}') = pg_temp.mt_threads('received')
		and pg_temp.mt_listed('{"direction":"sent","state":"new"}') = '{}'
		and pg_temp.mt_listed('{"direction":"received","state":"handled"}') = '{}'
		and pg_temp.mt_listed('{"direction":"sent","state":"handled"}') = pg_temp.mt_threads('sent')
		and pg_temp.mt_listed('{"direction":"sent","address":"support@mail.example.test"}') = pg_temp.mt_threads('sent')
		and pg_temp.mt_listed('{"direction":"sent","address":"sales@mail.example.test"}') = '{}',
	'A direction narrows a state''s list and a mailbox''s list');
select pg_temp.base_error(format('select public.qorpera_member_mail_threads(%L, %L)', '92400000-0000-4000-8000-000000000020',
		request), '22023', 'Mail threads request is invalid')
from (values ('{"direction":"both"}'), ('{"direction":"Sent"}'), ('{"direction":""}'), ('{"direction":1}'),
	('{"direction":null}'), ('{"direction":["sent"]}')) as item(request);
-- A viewer reads Sent; an outsider does not.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(pg_temp.mt_listed('{"direction":"sent"}') = pg_temp.mt_threads('sent'), 'A viewer reads Sent');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error($q$select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
	'{"direction":"sent"}')$q$, '42501', 'Company mail is unavailable');

-- 2. A thread's older messages, 50 a page ----------------------------------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.mt_p1', pg_temp.mt_page(current_setting('qorpera_test.mt_thread'))::text, true) \g /dev/null
select set_config('qorpera_test.mt_p2', pg_temp.mt_page(current_setting('qorpera_test.mt_thread'),
	current_setting('qorpera_test.mt_p1')::jsonb -> 'nextBefore')::text, true) \g /dev/null
select set_config('qorpera_test.mt_p3', pg_temp.mt_page(current_setting('qorpera_test.mt_thread'),
	current_setting('qorpera_test.mt_p2')::jsonb -> 'nextBefore')::text, true) \g /dev/null
select pg_temp.base_assert(jsonb_array_length(p1 -> 'messages') = 50 and p1 -> 'more' = 'true'
		and jsonb_array_length(p2 -> 'messages') = 50 and p2 -> 'more' = 'true'
		and jsonb_array_length(p3 -> 'messages') = 20 and not p3 ?| array['more', 'nextBefore'],
	'Pages of 50, 50 and 20; the last has no more: ' || jsonb_array_length(p1 -> 'messages') || ', '
		|| jsonb_array_length(p2 -> 'messages') || ', ' || coalesce(p3::text, 'none'))
from (select current_setting('qorpera_test.mt_p1')::jsonb as p1, current_setting('qorpera_test.mt_p2')::jsonb as p2,
	current_setting('qorpera_test.mt_p3')::jsonb as p3) as pages;
select pg_temp.base_assert(pg_temp.mt_ids(p3) || pg_temp.mt_ids(p2) || pg_temp.mt_ids(p1)
		= pg_temp.mt_order(current_setting('qorpera_test.mt_thread')),
	'The three pages hold every message once, oldest first, in the thread''s own order')
from (select current_setting('qorpera_test.mt_p1')::jsonb as p1, current_setting('qorpera_test.mt_p2')::jsonb as p2,
	current_setting('qorpera_test.mt_p3')::jsonb as p3) as pages;
-- The next page starts before a page's oldest message, received (message 70) or sent (message 20, a reply).
select pg_temp.base_assert(p1 -> 'nextBefore' = jsonb_build_object('at', p1 #> '{messages,0,receivedAt}', 'kind', 'received',
			'id', p1 #> '{messages,0,deliveryId}')
		and p2 -> 'nextBefore' = jsonb_build_object('at', p2 #> '{messages,0,at}', 'kind', 'sent', 'id', p2 #> '{messages,0,mailId}'),
	'nextBefore names the page''s oldest message: ' || (p1 -> 'nextBefore')::text || ', ' || (p2 -> 'nextBefore')::text)
from (select current_setting('qorpera_test.mt_p1')::jsonb as p1, current_setting('qorpera_test.mt_p2')::jsonb as p2) as pages;
-- Every page answers for the same thread, with its address and waiting sends; no cursor is the newest page.
select pg_temp.base_assert(p1 - array['messages', 'more', 'nextBefore'] = p2 - array['messages', 'more', 'nextBefore']
		and p1 - array['messages', 'more', 'nextBefore'] = p3 - array['messages', 'more', 'nextBefore']
		and p1 ->> 'thread' = current_setting('qorpera_test.mt_thread') and p1 ->> 'address' = 'support@mail.example.test'
		and pg_temp.mt_page(current_setting('qorpera_test.mt_thread'), null) = p1,
	'Every page answers for the same thread; without a cursor it is the newest page')
from (select current_setting('qorpera_test.mt_p1')::jsonb as p1, current_setting('qorpera_test.mt_p2')::jsonb as p2,
	current_setting('qorpera_test.mt_p3')::jsonb as p3) as pages;
-- An older page draws messages as the newest does: account mail without its subject, text, recipients or attachments.
select pg_temp.base_assert(code.item ->> 'kind' = 'received' and not code.item ?| array['subject', 'text', 'to', 'cc', 'attachments']
		and code.item #>> '{account,site}' = 'acme.example' and strpos(p3::text, '424242') = 0
		and (select bool_and(case item ->> 'kind' when 'received' then item ? 'text' or item ? 'account'
				when 'sent' then item ->> 'text' like 'Reply mt-a-%' and item ->> 'status' = 'queued' end)
			from jsonb_array_elements(p3 -> 'messages') as entry(item)),
	'The oldest page hides account mail and shows the rest: ' || coalesce(code.item::text, 'message 4 not on it'))
from (select current_setting('qorpera_test.mt_p3')::jsonb as p3) as page
left join lateral (select item from jsonb_array_elements(page.p3 -> 'messages') as entry(item)
	where item ->> 'deliveryId' = current_setting('qorpera_test.mt_code')) as code on true;
-- Before the oldest message there is nothing.
select pg_temp.base_assert(older -> 'messages' = '[]'::jsonb and not older ?| array['more', 'nextBefore'],
	'Nothing is older than the first message: ' || older::text)
from (select pg_temp.mt_page(current_setting('qorpera_test.mt_thread'), jsonb_build_object('at',
	current_setting('qorpera_test.mt_p3')::jsonb #> '{messages,0,receivedAt}', 'kind', 'received',
	'id', current_setting('qorpera_test.mt_p3')::jsonb #> '{messages,0,deliveryId}')) as older) as answer;

-- 3. Who may read older pages, and the cursor's shape ----------------------------------------------------------------

select pg_temp.base_error(format('select pg_temp.mt_page(%L, %L)', current_setting('qorpera_test.mt_thread'), cursor), '22023',
		'Mail thread request is invalid')
from (values ('[]'), ('"x"'), ('null'), ('{}'), ('{"at":"2026-10-17T10:00:00Z","kind":"received"}'),
	('{"at":"2026-10-17T10:00:00Z","kind":"received","id":"69500000-0000-4000-8000-000000000001","thread":"x"}'),
	('{"at":"2026-10-17T10:00:00Z","kind":"draft","id":"69500000-0000-4000-8000-000000000001"}'),
	('{"at":"2026-10-17T10:00:00Z","kind":"received","id":"69500000-0000-4000-8000-00000000000A"}'),
	('{"at":"2026-10-17T10:00:00Z","kind":"received","id":"received:69500000-0000-4000-8000-000000000001"}'),
	('{"at":"2026-10-17T10:00:00Z","kind":"received","id":1}'),
	('{"at":"yesterday","kind":"received","id":"69500000-0000-4000-8000-000000000001"}'),
	('{"at":"2026-13-45T10:00:00Z","kind":"received","id":"69500000-0000-4000-8000-000000000001"}')) as item(cursor);
select pg_temp.base_error(format('select pg_temp.mt_page(%L, %L)', repeat('x', 43),
		current_setting('qorpera_test.mt_p1')::jsonb -> 'nextBefore'), '22023', 'No mail thread of this company has that id');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(pg_temp.mt_page(current_setting('qorpera_test.mt_thread'),
		current_setting('qorpera_test.mt_p1')::jsonb -> 'nextBefore') = current_setting('qorpera_test.mt_p2')::jsonb,
	'A viewer reads the older page an owner reads');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error(format('select pg_temp.mt_page(%L, %L)', current_setting('qorpera_test.mt_thread'),
		current_setting('qorpera_test.mt_p1')::jsonb -> 'nextBefore'), '42501', 'Company mail is unavailable');
select pg_temp.base_claims('anon');
select pg_temp.base_error(format('select pg_temp.mt_page(%L, %L)', current_setting('qorpera_test.mt_thread'),
		current_setting('qorpera_test.mt_p1')::jsonb -> 'nextBefore'), '42501', 'Company mail is unavailable');
-- One thread read, with its cursor; only members call it.
select pg_temp.base_assert(to_regprocedure('public.qorpera_member_mail_thread(uuid,text)') is null
		and has_function_privilege('authenticated', 'public.qorpera_member_mail_thread(uuid,text,jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_member_mail_thread(uuid,text,jsonb)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_member_mail_thread(uuid,text,jsonb)', 'EXECUTE'),
	'The thread read has one form, with the cursor, for members only');

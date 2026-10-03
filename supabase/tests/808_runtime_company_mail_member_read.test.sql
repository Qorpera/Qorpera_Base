-- @fixture 733_runtime_company_mail_sending.test.sql until "-- Switched off, nothing is queued."
-- Company mail for members, step I5a (20260928439980): received and sent mail is threaded (the root Message-ID, a
-- reply to an email an agent started through the provider's Message-ID read back after sending, else a thread of
-- its own) and kept for members past the deliveries' 7-day purge; any member of the company reads the mailboxes,
-- the threads newest first, one thread and the sends waiting for a person, marks threads read, and never sees an
-- account mail's subject, text, recipients or attachments; nobody else does, and with mail off every answer is
-- empty. Threads quiet for 30 days are deleted.

create function pg_temp.member(p_user uuid default '30000000-0000-4000-8000-000000000001') returns void language sql as $$
	select pg_temp.path_claims('authenticated', p_user)
$$;
create function pg_temp.threads(p_request jsonb default '{}') returns jsonb language sql as $$
	select public.qorpera_member_mail_threads('30000000-0000-4000-8000-000000000020', p_request)
$$;
create function pg_temp.thread(p_thread text) returns jsonb language sql as $$
	select public.qorpera_member_mail_thread('30000000-0000-4000-8000-000000000020', p_thread)
$$;
create function pg_temp.thread_of(p_delivery uuid) returns text language sql as $$
	select thread_id from public.qorpera_mail_received where delivery_id = p_delivery
$$;
create function pg_temp.listed(p_thread text, p_request jsonb default '{}') returns jsonb language sql as $$
	select item from jsonb_array_elements(pg_temp.threads(p_request) -> 'threads') as entry(item)
	where item ->> 'thread' = p_thread
$$;
create function pg_temp.support() returns uuid language sql as $$
	select id from public.qorpera_company_mailboxes where local_part = 'support' and removed_at is null
		and profile_id = '30000000-0000-4000-8000-000000000010'
$$;
-- An open review card for a send_mail call of the fixture's run, with its arguments as the card keeps them.
create function pg_temp.card(p_call text, p_arguments jsonb) returns uuid language sql as $$
	insert into public.qorpera_action_reviews (profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope)
	values ('30000000-0000-4000-8000-000000000010',
		(current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid, p_call,
		'30000000-0000-4000-8000-000000000030', 'send_mail', 'external', repeat('a', 64),
		jsonb_build_object('title', 'Send an email', 'arguments', p_arguments::text), 'ask', 'none', 'A person decides',
		'reviewer-fixture', 'owners_admins')
	returning id
$$;
select pg_temp.path_claims('service_role');
update public.qorpera_mail_settings set sending = true;

-- Privileges: the members' calls are authenticated's alone; the helpers and the tables nobody's.
do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_member_mail_addresses(uuid)',
		'public.qorpera_member_mail_threads(uuid,jsonb)', 'public.qorpera_member_mail_thread(uuid,text)',
		'public.qorpera_member_mail_waiting(uuid)', 'public.qorpera_mark_mail_thread_read(uuid,text)'] loop
		if not has_function_privilege('authenticated', v_function, 'EXECUTE') then
			raise exception '% lost its caller', v_function; end if;
		foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_mail_thread_id(uuid,text)', 'public.qorpera_mail_message_id(text)',
		'public.qorpera_mail_thread_root(jsonb)', 'public.qorpera_mail_party(text)', 'public.qorpera_mail_json_object(text)',
		'public.qorpera_mail_thread_note(text,uuid,uuid,uuid,text,timestamp with time zone,text,text,text,uuid,uuid,jsonb)',
		'public.qorpera_mail_received_note(uuid,public.qorpera_company_mailboxes,timestamp with time zone,jsonb,text,text,text)',
		'public.qorpera_mail_threads_backfill()', 'public.qorpera_mail_account(uuid,uuid,text[])',
		'public.qorpera_member_mail_company(uuid)', 'public.qorpera_member_mail_agent(uuid,uuid)',
		'public.qorpera_member_mail_woken_agent(uuid)', 'public.qorpera_member_mail_open_sends(uuid,uuid)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_company_mail_message_ids_due(integer)',
		'public.qorpera_record_company_mail_message_id(uuid,text,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
		if not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% lost its caller', v_function; end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_mail_threads', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_mail_received', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_mail_thread_reads', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Mail threads are exposed to %', v_role; end if;
	end loop;
end
$$;

-- Message-IDs as a header carries them, and thread ids safe in a URL and a path.
select pg_temp.wake_assert(public.qorpera_mail_message_id(value) is not distinct from expected,
	format('%s reads as %s, not %s', value, expected, public.qorpera_mail_message_id(value)))
from (values ('<a@b.example>', '<a@b.example>'), ('a@b.example', '<a@b.example>'), (' x <a@b.example> y', '<a@b.example>'),
	('has space', null), ('', null), (null, null), ('<' || repeat('a', 997) || '>', null), ('<a"b@c.example>', null),
	('<a\b@c.example>', null), ('<caf' || chr(233) || '@c.example>', null)) as item(value, expected);
select pg_temp.wake_assert(public.qorpera_mail_thread_id(pg_temp.support(), '<a@b.example>') ~ '^[A-Za-z0-9_-]{43}$'
	and public.qorpera_mail_thread_id(pg_temp.support(), '<a@b.example>')
		<> public.qorpera_mail_thread_id('30000000-0000-4000-8000-0000000007a1', '<a@b.example>'),
	'A thread id is 43 URL-safe characters, and another mailbox''s differs');

-- A received email starts a thread at its Message-ID; a reply that references it joins it.
select set_config('qorpera_test.first', pg_temp.received(70, 'support@mail.example.test',
	'{"messageId":"<a1@customer.example>","subject":"Where is my order?","text":"Hello, where is it?"}')::text, true);
select set_config('qorpera_test.thread', pg_temp.thread_of(current_setting('qorpera_test.first')::uuid), true);
select pg_temp.wake_assert(received.message_id = '<a1@customer.example>'
		and received.thread_id = public.qorpera_mail_thread_id(pg_temp.support(), '<a1@customer.example>')
		and received.subject = 'Where is my order?' and received.from_address = 'customer@example.org'
		and received.delivered_to = array['support@mail.example.test']
		and (select headers - array['delivered-to', 'from', 'subject', 'authentication-results'] = '{}'::jsonb
			from public.qorpera_event_deliveries where id = received.delivery_id),
	'The message is recorded for members, its delivery''s headers unchanged')
from public.qorpera_mail_received as received where received.delivery_id = current_setting('qorpera_test.first')::uuid;
-- The root is the first id referenced, before the one answered.
select pg_temp.wake_assert(public.qorpera_mail_thread_root(
		'{"references":"<root@x.example> <mid@x.example>","inReplyTo":"<mid@x.example>","messageId":"<new@x.example>"}')
		= '<root@x.example>'
	and public.qorpera_mail_thread_root('{"inReplyTo":"<mid@x.example>","messageId":"<new@x.example>"}') = '<mid@x.example>'
	and public.qorpera_mail_thread_root('{"messageId":"<new@x.example>"}') = '<new@x.example>'
	and public.qorpera_mail_thread_root('{}') is null, 'The thread''s root');
select set_config('qorpera_test.second', pg_temp.received(71, 'support@mail.example.test',
	'{"messageId":"<a2@customer.example>","references":"<a1@customer.example>","inReplyTo":"<a1@customer.example>","subject":"Re: Where is my order?"}')::text,
	true);
select pg_temp.wake_assert(pg_temp.thread_of(current_setting('qorpera_test.second')::uuid)
	= current_setting('qorpera_test.thread'), 'A reply joins the thread');
select pg_temp.wake_assert(thread.message_count = 2 and thread.last_direction = 'received'
		and thread.subject = 'Re: Where is my order?' and thread.outside_name = 'Customer'
		and thread.outside_address = 'customer@example.org' and thread.mailbox_id = pg_temp.support()
		and thread.last_received_delivery_id = current_setting('qorpera_test.second')::uuid,
	'The thread follows its newest message')
from public.qorpera_mail_threads as thread where thread.id = current_setting('qorpera_test.thread');
-- An agent's reply joins it; the outside party stays the customer.
select set_config('qorpera_test.reply', pg_temp.send('reply-1', pg_temp.request(p_extra => jsonb_build_object('inReplyTo',
	current_setting('qorpera_test.second'))))::text, true);
select pg_temp.wake_assert((pg_temp.outbox(current_setting('qorpera_test.reply')::jsonb)).thread
	= current_setting('qorpera_test.thread'), 'An agent''s reply joins the received email''s thread');
select pg_temp.wake_assert(thread.message_count = 3 and thread.last_direction = 'sent'
		and thread.last_sent_staff_agent_id = '30000000-0000-4000-8000-000000000030'
		and thread.outside_address = 'customer@example.org' and thread.subject = 'Hello',
	'The thread records the reply')
from public.qorpera_mail_threads as thread where thread.id = current_setting('qorpera_test.thread');
-- An email an agent starts begins a thread of its own, with its recipient as the outside party.
select set_config('qorpera_test.quote', pg_temp.send('new-1', pg_temp.request(p_extra =>
	'{"to":["bob@acme.test"],"subject":"Your quote"}'))::text, true);
select set_config('qorpera_test.quote_thread', (pg_temp.outbox(current_setting('qorpera_test.quote')::jsonb)).thread, true);
select pg_temp.wake_assert(current_setting('qorpera_test.quote_thread') = public.qorpera_mail_thread_id(pg_temp.support(),
		'mail:' || (current_setting('qorpera_test.quote')::jsonb ->> 'mailId'))
	and (select outside_address = 'bob@acme.test' and outside_name is null and last_direction = 'sent'
		from public.qorpera_mail_threads where id = current_setting('qorpera_test.quote_thread')),
	'A new email begins its own thread');

-- mail-outbox reads back the provider's Message-ID of what it sent: sent emails without one, once each five minutes,
-- recorded once for the email sent under that provider id.
update public.qorpera_company_mail_outbox set status = 'sent', provider_message_id = 'resend-quote',
	settled_at = clock_timestamp() - interval '1 minute', attempt_count = 1
where id = (current_setting('qorpera_test.quote')::jsonb ->> 'mailId')::uuid;
select pg_temp.wake_assert(public.qorpera_company_mail_message_ids_due(10) = jsonb_build_array(jsonb_build_object(
		'mailId', current_setting('qorpera_test.quote')::jsonb ->> 'mailId', 'providerMessageId', 'resend-quote')),
	'A sent email without its Message-ID is due');
select pg_temp.wake_assert(public.qorpera_company_mail_message_ids_due(10) = '[]'::jsonb,
	'It is asked again only after five minutes');
select pg_temp.wake_error('select public.qorpera_company_mail_message_ids_due(11)', '22023');
select pg_temp.wake_assert(not public.qorpera_record_company_mail_message_id(mail_id, 'resend-other', '<q1@ses.example>')
		and not public.qorpera_record_company_mail_message_id(mail_id, 'resend-quote', 'not an id')
		and public.qorpera_record_company_mail_message_id(mail_id, 'resend-quote', '<q1@ses.example>')
		and not public.qorpera_record_company_mail_message_id(mail_id, 'resend-quote', '<q2@ses.example>'),
	'The Message-ID is recorded once, for the email the provider sent under that id')
from (select (current_setting('qorpera_test.quote')::jsonb ->> 'mailId')::uuid as mail_id) as quote;
-- Only sent emails without one, sent between a day and ten seconds ago; those never asked first, the newest first.
select pg_temp.send('due-' || n, pg_temp.request(p_extra => jsonb_build_object('to', jsonb_build_array('due' || n || '@acme.test'))))
from generate_series(1, 5) as n;
update public.qorpera_company_mail_outbox set status = case call_id when 'due-3' then 'failed' else 'sent' end,
	provider_message_id = 'resend-' || call_id, attempt_count = 1,
	settled_at = clock_timestamp() - case call_id when 'due-1' then interval '3 minutes' when 'due-2' then interval '2 minutes'
		when 'due-3' then interval '2 minutes 30 seconds' when 'due-4' then interval '1 day 1 minute' else interval '1 second' end
where call_id like 'due-%';
update public.qorpera_company_mail_outbox set message_id_checked_at = clock_timestamp() - interval '6 minutes'
where call_id = 'due-1';
select pg_temp.wake_assert(public.qorpera_company_mail_message_ids_due(1) = jsonb_build_array(
		jsonb_build_object('mailId', (select id from public.qorpera_company_mail_outbox where call_id = 'due-2'),
			'providerMessageId', 'resend-due-2')),
	'The email never asked comes first, though another was sent earlier');
select pg_temp.wake_assert(public.qorpera_company_mail_message_ids_due(10) = jsonb_build_array(
		jsonb_build_object('mailId', (select id from public.qorpera_company_mail_outbox where call_id = 'due-1'),
			'providerMessageId', 'resend-due-1')),
	'Due: sent, between a day and ten seconds ago, once each five minutes');
update public.qorpera_company_mail_outbox set message_id_checked_at = null
where call_id in ('due-1', 'due-2');
select pg_temp.wake_assert(public.qorpera_company_mail_message_ids_due(10) = jsonb_build_array(
		jsonb_build_object('mailId', (select id from public.qorpera_company_mail_outbox where call_id = 'due-2'),
			'providerMessageId', 'resend-due-2'),
		jsonb_build_object('mailId', (select id from public.qorpera_company_mail_outbox where call_id = 'due-1'),
			'providerMessageId', 'resend-due-1')),
	'Among those never asked, the newest first, in that order');
-- The recipient's answer joins the agent's thread.
select set_config('qorpera_test.bob', pg_temp.received(72, 'support@mail.example.test',
	'{"from":"Bob <bob@acme.test>","messageId":"<b1@acme.test>","references":"<q1@ses.example>","inReplyTo":"<q1@ses.example>","subject":"Re: Your quote"}')::text,
	true);
select pg_temp.wake_assert(pg_temp.thread_of(current_setting('qorpera_test.bob')::uuid)
		= current_setting('qorpera_test.quote_thread')
	and (select outside_name = 'Bob' and outside_address = 'bob@acme.test' and last_direction = 'received'
		from public.qorpera_mail_threads where id = current_setting('qorpera_test.quote_thread')),
	'An answer to an email an agent started joins its thread');
-- Another company's mail that references the same Message-ID is its own company's thread.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('30000000-0000-4000-8000-0000000007a0',
	'30000000-0000-4000-8000-0000000007a1', 'theirs', 'Another company''s mailbox');
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.theirs', pg_temp.received(76, 'theirs@mail.example.test',
	'{"messageId":"<t1@acme.test>","references":"<q1@ses.example>","subject":"Re: Your quote"}')::text, true);
select pg_temp.wake_assert(pg_temp.thread_of(current_setting('qorpera_test.theirs')::uuid)
	= public.qorpera_mail_thread_id((select id from public.qorpera_company_mailboxes where local_part = 'theirs'
		and removed_at is null), '<q1@ses.example>'),
	'Another company''s mail never joins this company''s thread');
-- Mail without any Message-ID is a thread of its own.
select set_config('qorpera_test.bare', pg_temp.received(73, 'support@mail.example.test', '{"subject":"No ids"}')::text, true);
select pg_temp.wake_assert(pg_temp.thread_of(current_setting('qorpera_test.bare')::uuid)
	= public.qorpera_mail_thread_id(pg_temp.support(), 'delivery:' || current_setting('qorpera_test.bare')),
	'Mail without ids is a thread of its own');

-- Only a member of the company reads its mail.
select pg_temp.member('30000000-0000-4000-8000-0000000000ee');
select pg_temp.wake_error('select pg_temp.threads()', '42501');
select pg_temp.wake_error($q$select public.qorpera_member_mail_addresses('30000000-0000-4000-8000-000000000020')$q$, '42501');
select pg_temp.wake_error(format('select pg_temp.thread(%L)', current_setting('qorpera_test.thread')), '42501');
select pg_temp.wake_error($q$select public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020')$q$, '42501');
select pg_temp.wake_error(format($q$select public.qorpera_mark_mail_thread_read('30000000-0000-4000-8000-000000000020', %L)$q$,
	current_setting('qorpera_test.thread')), '42501');
select pg_temp.path_claims('anon');
select pg_temp.wake_error('select pg_temp.threads()', '42501');
-- A member's id under another role is not a member's call.
select pg_temp.path_claims('service_role', '30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error('select pg_temp.threads()', '42501');
select pg_temp.member();
select pg_temp.wake_error($q$select public.qorpera_member_mail_threads(extensions.gen_random_uuid(), '{}')$q$, '42501');
-- A company being deleted has no members to read its mail.
do $$
begin
	insert into public.qorpera_company_deletions(profile_id) values ('30000000-0000-4000-8000-000000000010');
	perform pg_temp.wake_error('select pg_temp.threads()', '42501');
	raise exception using errcode = 'P0004', message = 'undo the deletion';
exception when sqlstate 'P0004' then null;
end
$$;

-- The mailboxes, with the routines that listen on them, their agents and the last 7 days' mail.
select pg_temp.path_claims('service_role');
select pg_temp.routine(jsonb_build_object('action', 'upsert', 'operationKey', 'mail-808', 'routineKey', 'support-mail-808',
	'title', 'Answer support mail', 'intent', 'Answer each support email.',
	'trigger', jsonb_build_object('kind', 'listener', 'source', 'event',
		'hookId', (select hook_id from public.qorpera_company_mailboxes where id = pg_temp.support()),
		'only', jsonb_build_array('mail.received'), 'timeZone', 'UTC', 'replyPolicy', 'silent')));
select pg_temp.member();
select pg_temp.wake_assert(box ->> 'status' = 'active'
		and box ->> 'hookId' = (select hook_id::text from public.qorpera_company_mailboxes where id = pg_temp.support())
		and box -> 'handledBy' = '[{"staffAgentId":"30000000-0000-4000-8000-000000000030","name":"Agent"}]'::jsonb
		and box #>> '{routines,0,title}' = 'Answer support mail'
		and box #>> '{routines,0,staffAgentId}' = '30000000-0000-4000-8000-000000000030'
		and (box ->> 'last7Days')::integer >= 4,
	'The mailbox, who handles it and its week: ' || box::text)
from jsonb_array_elements(public.qorpera_member_mail_addresses('30000000-0000-4000-8000-000000000020')) as entry(box)
where box ->> 'address' = 'support@mail.example.test';

-- The threads, newest first: the outside party, the state, who handled it, the direction, and unread.
select pg_temp.wake_assert(item ->> 'state' = 'handled' and item ->> 'direction' = 'sent'
		and item ->> 'fromName' = 'Customer' and item ->> 'fromAddress' = 'customer@example.org'
		and item ->> 'address' = 'support@mail.example.test' and item ->> 'subject' = 'Hello'
		and item -> 'handledBy' = '{"staffAgentId":"30000000-0000-4000-8000-000000000030","name":"Agent"}'::jsonb
		and item -> 'unread' = 'true'::jsonb and (item ->> 'messages')::integer = 3,
	'A replied thread is handled: ' || item::text)
from pg_temp.listed(current_setting('qorpera_test.thread')) as item;
-- A reply that failed answered nothing.
select pg_temp.path_claims('service_role');
update public.qorpera_company_mail_outbox set status = 'failed', settled_at = clock_timestamp()
where id = (current_setting('qorpera_test.reply')::jsonb ->> 'mailId')::uuid;
select pg_temp.member();
select pg_temp.wake_assert(pg_temp.listed(current_setting('qorpera_test.thread')) ->> 'state' = 'new',
	'A failed reply leaves the thread new');
select pg_temp.path_claims('service_role');
update public.qorpera_company_mail_outbox set status = 'pending', settled_at = null
where id = (current_setting('qorpera_test.reply')::jsonb ->> 'mailId')::uuid;
select pg_temp.member();
select pg_temp.wake_assert(item ->> 'state' = 'new' and item ->> 'direction' = 'received' and item ->> 'fromName' = 'Bob'
		and item #>> '{handledBy,staffAgentId}' = '30000000-0000-4000-8000-000000000030',
	'An answer after the agent''s email makes it new again: ' || item::text)
from pg_temp.listed(current_setting('qorpera_test.quote_thread')) as item;
select pg_temp.wake_assert((select array_agg(item ->> 'thread' order by n) filter (where item ->> 'thread' in (
			pg_temp.thread_of(current_setting('qorpera_test.bare')::uuid), current_setting('qorpera_test.quote_thread'),
			current_setting('qorpera_test.thread')))
		from jsonb_array_elements(pg_temp.threads() -> 'threads') with ordinality as entry(item, n))
		= array[pg_temp.thread_of(current_setting('qorpera_test.bare')::uuid), current_setting('qorpera_test.quote_thread'),
			current_setting('qorpera_test.thread')]
	and (select bool_and(earlier.value >= later.value) from (select (item ->> 'lastAt')::timestamptz as value, n
			from jsonb_array_elements(pg_temp.threads() -> 'threads') with ordinality as entry(item, n)) as earlier
		join (select (item ->> 'lastAt')::timestamptz as value, n
			from jsonb_array_elements(pg_temp.threads() -> 'threads') with ordinality as entry(item, n)) as later
			on later.n = earlier.n + 1),
	'Newest first');
-- Only this company's threads, in this environment.
select pg_temp.wake_assert(not exists (select 1 from jsonb_array_elements(pg_temp.threads('{"limit":50}') -> 'threads') as entry(item)
		left join public.qorpera_mail_threads as thread on thread.id = item ->> 'thread'
		where thread.environment_id is distinct from '30000000-0000-4000-8000-000000000020')
	and pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.theirs')::uuid)) is null,
	'Another company''s threads are not listed');
select pg_temp.wake_error(format('select pg_temp.thread(%L)', pg_temp.thread_of(current_setting('qorpera_test.theirs')::uuid)),
	'22023');
-- Pages of one, with ties broken by thread id: every thread once.
update public.qorpera_mail_threads set last_at = '2026-10-02T09:00:00Z'
where id in (current_setting('qorpera_test.thread'), current_setting('qorpera_test.quote_thread'));
do $$
declare v_page jsonb; v_request jsonb := '{"limit":1}'; v_seen text[] := '{}';
begin
	loop
		v_page := pg_temp.threads(v_request);
		v_seen := v_seen || array(select item ->> 'thread' from jsonb_array_elements(v_page -> 'threads') as entry(item));
		exit when not v_page ? 'nextBefore';
		v_request := jsonb_build_object('limit', 1, 'before', v_page -> 'nextBefore');
	end loop;
	perform pg_temp.wake_assert(v_seen = array(select item ->> 'thread'
		from jsonb_array_elements(pg_temp.threads() -> 'threads') with ordinality as entry(item, n) order by n),
		'Paging shows every thread once: ' || v_seen::text);
end
$$;
-- By mailbox address (a tag reaches its mailbox) and by state.
select pg_temp.wake_assert((select bool_and(item ->> 'address' = 'support@mail.example.test') and count(*) >= 3
		from jsonb_array_elements(pg_temp.threads('{"address":"support+x@mail.example.test"}') -> 'threads') as entry(item))
	and (select bool_and(item ->> 'address' = 'a.b@mail.example.test') is not false
		from jsonb_array_elements(pg_temp.threads('{"address":"a.b@mail.example.test"}') -> 'threads') as entry(item))
	and pg_temp.threads('{"address":"nobody@mail.example.test"}') = '{"threads":[]}'::jsonb
	and pg_temp.threads('{"address":"support@elsewhere.example"}') = '{"threads":[]}'::jsonb
	and pg_temp.threads('{"address":"support+not a tag@mail.example.test"}') = '{"threads":[]}'::jsonb,
	'Threads by mailbox address');
select pg_temp.wake_assert((select bool_and(item ->> 'state' = 'handled') and count(*) >= 1
	from jsonb_array_elements(pg_temp.threads('{"state":"handled"}') -> 'threads') as entry(item)), 'Threads by state');
select pg_temp.wake_error(format('select pg_temp.threads(%L::jsonb)', request), '22023')
from (values ('{"limit":51}'), ('{"limit":0}'), ('{"state":"open"}'), ('{"extra":1}'), ('{"before":{"lastAt":"2026-10-02T09:00:00Z"}}'),
	('{"before":{"lastAt":"yesterday","thread":"' || repeat('a', 43) || '"}}'), ('{"address":7}'), ('[]')) as item(request);

-- Read marks: a member's own, cleared again by a newer received message.
select pg_temp.wake_assert(public.qorpera_mark_mail_thread_read('30000000-0000-4000-8000-000000000020',
		current_setting('qorpera_test.thread'))
	and pg_temp.listed(current_setting('qorpera_test.thread')) -> 'unread' = 'false'::jsonb,
	'A read thread is not unread');
select pg_temp.member('30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(coalesce(pg_temp.listed(current_setting('qorpera_test.thread')) -> 'unread', 'true'::jsonb) = 'true'::jsonb
	or not exists (select 1 from public.qorpera_profile_members where profile_id = '30000000-0000-4000-8000-000000000010'
		and user_id = '30000000-0000-4000-8000-000000000002'),
	'Another member''s mark is their own');
select pg_temp.member();
select pg_temp.path_claims('service_role');
select pg_temp.received(74, 'support@mail.example.test',
	'{"messageId":"<a3@customer.example>","references":"<a1@customer.example> <a2@customer.example>","subject":"Re: Where is my order?"}');
select pg_temp.member();
select pg_temp.wake_assert(item -> 'unread' = 'true'::jsonb and item ->> 'state' = 'new',
	'A newer message makes it unread and new again: ' || item::text)
from pg_temp.listed(current_setting('qorpera_test.thread')) as item;
select pg_temp.wake_error(format($q$select public.qorpera_mark_mail_thread_read('30000000-0000-4000-8000-000000000020', %L)$q$,
	public.qorpera_mail_thread_id('30000000-0000-4000-8000-0000000007a1', 'mail:x')), '22023');

-- One thread: its messages oldest first, received and sent.
select pg_temp.wake_assert(detail ->> 'address' = 'support@mail.example.test'
		and (select array_agg(item ->> 'kind' order by n) from jsonb_array_elements(detail -> 'messages')
			with ordinality as entry(item, n)) = array['received', 'received', 'sent', 'received']
		and detail #>> '{messages,0,text}' = 'Hello, where is it?' and detail #>> '{messages,0,subject}' = 'Where is my order?'
		and detail #>> '{messages,0,fromAddress}' = 'customer@example.org'
		and detail #>> '{messages,2,status}' = 'queued' and detail #>> '{messages,2,to,0}' = 'customer@example.org'
		and detail #>> '{messages,2,staffAgent,staffAgentId}' = '30000000-0000-4000-8000-000000000030'
		and detail #>> '{messages,2,text}' like 'Thanks for writing.%' and detail -> 'waiting' = '[]'::jsonb,
	'The thread reads in order: ' || detail::text)
from (select pg_temp.thread(current_setting('qorpera_test.thread')) as detail) as answer;
select pg_temp.wake_error(format('select pg_temp.thread(%L)', value), '22023')
from (values ('not-a-thread'), (repeat('a', 43)),
	(public.qorpera_mail_thread_id('30000000-0000-4000-8000-0000000007a1', 'mail:x'))) as item(value);
-- A cleared text says so.
select pg_temp.path_claims('service_role');
update public.qorpera_event_deliveries set body = null where id = current_setting('qorpera_test.first')::uuid;
select pg_temp.member();
select pg_temp.wake_assert(detail #> '{messages,0,textCleared}' = 'true'::jsonb and not detail -> 'messages' -> 0 ? 'text'
		and detail #>> '{messages,0,subject}' = 'Where is my order?',
	'A cleared text is gone; its subject stays')
from (select pg_temp.thread(current_setting('qorpera_test.thread')) as detail) as answer;

-- The sends that wait for a person: in their thread, and as the `waiting` source's rows.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.card', pg_temp.card('call-card-1', jsonb_build_object('from', 'support@mail.example.test',
	'to', jsonb_build_array('bob@acme.test'), 'subject', 'Re: Your quote', 'text', 'Here it is.',
	'inReplyTo', current_setting('qorpera_test.bob')))::text, true);
select set_config('qorpera_test.card_new', pg_temp.card('call-card-2', jsonb_build_object('from', 'Support@Mail.Example.Test',
	'to', jsonb_build_array('eve@acme.test'), 'subject', 'Hello Eve', 'text', 'Hi.'))::text, true);
insert into public.qorpera_action_reviews (profile_id, run_id, call_id, staff_agent_id, tool_name, effect, argument_sha256,
	action, decision, built_in, reason, reviewer_model, approver_scope)
values ('30000000-0000-4000-8000-000000000010', (current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid,
	'call-card-3', '30000000-0000-4000-8000-000000000030', 'send_mail', 'external', repeat('a', 64),
	'{"title":"Send an email","arguments":"{not json"}', 'ask', 'none', 'A person decides', 'reviewer-fixture',
	'owners_admins');
-- The conversation a card was raised in, where it is answered (20260930000400): the first card has one, the new email's
-- card none.
insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, audience_kind)
values ('80800000-0000-4000-8000-0000000000c5', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000020',
	'Agent', '30000000-0000-4000-8000-000000000001', 'company');
update public.qorpera_action_reviews set card_session_id = '80800000-0000-4000-8000-0000000000c5'
where id = current_setting('qorpera_test.card')::uuid;
select pg_temp.member();
select pg_temp.wake_assert(pg_temp.listed(current_setting('qorpera_test.quote_thread')) ->> 'state' = 'waiting',
	'A thread with an open send is waiting');
select pg_temp.wake_assert(detail -> 'waiting' = jsonb_build_array(jsonb_build_object('reviewId', current_setting('qorpera_test.card'),
		'sessionId', '80800000-0000-4000-8000-0000000000c5', 'staffAgent', '{"staffAgentId":"30000000-0000-4000-8000-000000000030","name":"Agent"}'::jsonb,
		'to', '["bob@acme.test"]'::jsonb, 'subject', 'Re: Your quote', 'text', 'Here it is.',
		'createdAt', (select created_at from public.qorpera_action_reviews where id = current_setting('qorpera_test.card')::uuid))),
	'The thread shows its waiting send: ' || (detail -> 'waiting')::text)
from (select pg_temp.thread(current_setting('qorpera_test.quote_thread')) as detail) as answer;
select pg_temp.wake_assert(jsonb_array_length(waiting) = 2
		and waiting #>> '{0,reviewId}' = current_setting('qorpera_test.card_new') and not waiting -> 0 ? 'thread'
		and waiting #>> '{0,address}' = 'support@mail.example.test'
		and waiting #>> '{1,thread}' = current_setting('qorpera_test.quote_thread')
		and waiting #>> '{1,sessionId}' = '80800000-0000-4000-8000-0000000000c5' and not waiting -> 0 ? 'sessionId',
	'Every open send, newest first, a new email without a thread: ' || waiting::text)
from (select public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020') as waiting) as answer;
-- Only a viewer who may answer a card gets its conversation (20260930000400): a contributor gets none for the owners'
-- and admins' card; once the card waits for that contributor, the contributor gets it and the owner none.
select pg_temp.path_claims('service_role');
insert into auth.users(id, email) values ('80800000-0000-4000-8000-0000000000c6', 'mail-contributor@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('30000000-0000-4000-8000-000000000010', '80800000-0000-4000-8000-0000000000c6', 'mail-contributor@example.test',
	'Contributor', 'contributor');
select pg_temp.member('80800000-0000-4000-8000-0000000000c6');
select pg_temp.wake_assert(jsonb_array_length(waiting) = 2 and not waiting -> 1 ? 'sessionId'
		and not pg_temp.thread(current_setting('qorpera_test.quote_thread')) #> '{waiting,0}' ? 'sessionId',
	'A contributor gets no conversation for the owners'' and admins'' card: ' || waiting::text)
from (select public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020') as waiting) as answer;
select pg_temp.path_claims('service_role');
update public.qorpera_action_reviews set approver_scope = 'member', approver_user_id = '80800000-0000-4000-8000-0000000000c6'
where id = current_setting('qorpera_test.card')::uuid;
select pg_temp.member('80800000-0000-4000-8000-0000000000c6');
select pg_temp.wake_assert(waiting #>> '{1,sessionId}' = '80800000-0000-4000-8000-0000000000c5'
		and pg_temp.thread(current_setting('qorpera_test.quote_thread')) #>> '{waiting,0,sessionId}'
			= '80800000-0000-4000-8000-0000000000c5',
	'The member a card waits for gets its conversation: ' || waiting::text)
from (select public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020') as waiting) as answer;
select pg_temp.member();
select pg_temp.wake_assert(not waiting -> 1 ? 'sessionId', 'The owner gets none for a card waiting for another member: '
	|| waiting::text)
from (select public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020') as waiting) as answer;
select pg_temp.path_claims('service_role');
update public.qorpera_action_reviews set approver_scope = 'owners_admins', approver_user_id = null
where id = current_setting('qorpera_test.card')::uuid;
select pg_temp.member();
-- Another environment of the company sees none of this one's mail.
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
select '80800000-0000-4000-8000-000000000021', profile_id, 'Second', contract_version, created_by_user_id
from public.qorpera_company_environments where id = '30000000-0000-4000-8000-000000000020';
select pg_temp.wake_assert(public.qorpera_member_mail_waiting('80800000-0000-4000-8000-000000000021') = '[]'::jsonb
		and public.qorpera_member_mail_threads('80800000-0000-4000-8000-000000000021', '{}') = '{"threads":[]}'::jsonb,
	'Another environment of the company sees none of this one''s mail');
select pg_temp.wake_error(format($q$select public.qorpera_member_mail_thread('80800000-0000-4000-8000-000000000021', %L)$q$,
	current_setting('qorpera_test.quote_thread')), '22023');
select pg_temp.wake_error(format($q$select public.qorpera_mark_mail_thread_read('80800000-0000-4000-8000-000000000021', %L)$q$,
	current_setting('qorpera_test.quote_thread')), '22023');
-- A card that answers another company's email has no thread here.
select pg_temp.path_claims('service_role');
select pg_temp.card('call-card-6', jsonb_build_object('from', 'support@mail.example.test',
	'to', jsonb_build_array('bob@acme.test'), 'subject', 'Wrong', 'text', 'No.',
	'inReplyTo', current_setting('qorpera_test.theirs')));
select pg_temp.member();
select pg_temp.wake_assert((select not item ? 'thread' from jsonb_array_elements(
		public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020')) as entry(item)
		where item ->> 'subject' = 'Wrong'),
	'A card answering another company''s email has no thread');
select pg_temp.path_claims('service_role');
update public.qorpera_action_reviews set answer = 'deny', answered_at = clock_timestamp(),
	answered_by_user_id = '30000000-0000-4000-8000-000000000001' where call_id = 'call-card-6';
select pg_temp.member();
-- Another company's card is not this company's, whatever it names.
select pg_temp.path_claims('service_role');
insert into public.qorpera_action_reviews (profile_id, run_id, call_id, staff_agent_id, tool_name, effect, argument_sha256,
	action, decision, built_in, reason, reviewer_model, approver_scope)
values ('30000000-0000-4000-8000-0000000007a0', (current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid,
	'call-card-4', '30000000-0000-4000-8000-000000000030', 'send_mail', 'external', repeat('a', 64),
	jsonb_build_object('title', 'Send an email', 'arguments', jsonb_build_object('from', 'theirs@mail.example.test',
		'to', jsonb_build_array('bob@acme.test'), 'subject', 'Theirs', 'text', 'Not yours.',
		'inReplyTo', current_setting('qorpera_test.bob'))::text),
	'ask', 'none', 'A person decides', 'reviewer-fixture', 'owners_admins');
select pg_temp.member();
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020')) = 2
	and jsonb_array_length(pg_temp.thread(current_setting('qorpera_test.quote_thread')) -> 'waiting') = 1,
	'Another company''s card is never listed');
-- An answered card waits no more.
select pg_temp.path_claims('service_role');
update public.qorpera_action_reviews set answer = 'deny', answered_at = clock_timestamp(),
	answered_by_user_id = '30000000-0000-4000-8000-000000000001'
where id = current_setting('qorpera_test.card')::uuid;
select pg_temp.member();
select pg_temp.wake_assert(pg_temp.listed(current_setting('qorpera_test.quote_thread')) ->> 'state' = 'new',
	'An answered card waits no more');

-- Account mail (I5b, through A1's lookup once it exists): who used the account and when, never its subject or text.
-- A1's own lookup (20260928439960) steps aside for this test's.
do $$
begin
	if to_regprocedure('public.qorpera_company_account_mail(uuid,uuid,text[])') is not null then
		alter function public.qorpera_company_account_mail(uuid, uuid, text[]) rename to qorpera_company_account_mail_a1;
	end if;
end
$$;
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.code', pg_temp.received(75, 'support+acme@mail.example.test',
	'{"messageId":"<code@acme.example>","subject":"Your code is 424242","text":"Code 424242","to":["support+acme@mail.example.test"],"cc":["boss@acme.example"],"attachments":[{"id":"att_code","filename":"code.pdf","size":3}]}')::text, true);
select pg_temp.member();
select pg_temp.wake_assert(pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.code')::uuid)) ->> 'subject'
	= 'Your code is 424242', 'Before the lookup exists, account mail shows as any mail');
create function public.qorpera_company_account_mail(p_profile_id uuid, p_environment_id uuid, p_addresses text[])
returns jsonb language sql stable set search_path = '' as $$
	select case when p_profile_id = '30000000-0000-4000-8000-000000000010'
		and p_environment_id = '30000000-0000-4000-8000-000000000020' and 'support+acme@mail.example.test' = any (p_addresses)
		then jsonb_build_object('accountId', '80800000-0000-4000-8000-000000000001', 'site', 'acme.example',
			'lastUsedBy', '30000000-0000-4000-8000-000000000030', 'lastUsedAt', '2026-10-02T09:00:00Z') end
$$;
select pg_temp.wake_assert(not item ? 'subject' and item #>> '{account,site}' = 'acme.example'
		and item #>> '{account,lastUsedBy}' = '30000000-0000-4000-8000-000000000030',
	'Account mail shows the account, not the subject: ' || item::text)
from pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.code')::uuid)) as item;
select pg_temp.wake_assert(not detail #> '{messages,0}' ? 'subject' and not detail #> '{messages,0}' ? 'text'
		and not detail #> '{messages,0}' ? 'to' and not detail #> '{messages,0}' ? 'cc'
		and not detail #> '{messages,0}' ? 'attachments'
		and detail #>> '{messages,0,account,site}' = 'acme.example' and detail #>> '{messages,0,fromAddress}' = 'customer@example.org',
	'The thread shows who used the account, not the code: ' || detail::text)
from (select pg_temp.thread(pg_temp.thread_of(current_setting('qorpera_test.code')::uuid)) as detail) as answer;
select pg_temp.wake_assert(pg_temp.listed(current_setting('qorpera_test.thread')) ? 'subject',
	'Other mail keeps its subject');
-- Account mail received before the lookup existed stays hidden when a follow-up without a subject joins its thread:
-- the thread's mark looks at every address its messages reached.
select pg_temp.path_claims('service_role');
select pg_temp.received(81, 'support@mail.example.test',
	'{"messageId":"<code-follow@acme.example>","references":"<code@acme.example>"}');
select pg_temp.member();
select pg_temp.wake_assert(item ? 'account' and not item ? 'subject' and (item ->> 'messages')::integer = 2,
	'A follow-up does not bring back an account mail''s subject: ' || item::text)
from pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.code')::uuid)) as item;
-- A lookup that fails never costs the mail: it is stored as account mail would be.
alter function public.qorpera_company_account_mail(uuid, uuid, text[]) rename to qorpera_company_account_mail_kept;
create function public.qorpera_company_account_mail(p_profile_id uuid, p_environment_id uuid, p_addresses text[])
returns jsonb language plpgsql stable set search_path = '' as $$ begin raise exception 'lookup down'; end $$;
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.down', pg_temp.received(82, 'support@mail.example.test',
	'{"messageId":"<down@x.example>","subject":"Maybe a code"}')::text, true);
select pg_temp.wake_assert(received.subject is null and received.account = '{"unknown":true}'::jsonb,
	'With the lookup down, the mail is stored without its subject')
from public.qorpera_mail_received as received where received.delivery_id = current_setting('qorpera_test.down')::uuid;
-- On reading, a failing lookup marks each thread it touches as unknown, and the Mailbox still lists.
select pg_temp.member();
select pg_temp.wake_assert(pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.down')::uuid)) -> 'account'
		= '{"unknown":true}'::jsonb
	and not pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.down')::uuid)) ? 'subject',
	'A failing lookup hides, and the listing still answers');
select pg_temp.path_claims('service_role');
drop function public.qorpera_company_account_mail(uuid, uuid, text[]);
alter function public.qorpera_company_account_mail_kept(uuid, uuid, text[]) rename to qorpera_company_account_mail;
select pg_temp.member();
-- Account mail that joins a thread marks it.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.plain', pg_temp.received(79, 'support@mail.example.test',
	'{"messageId":"<x1@acme.example>","subject":"Welcome"}')::text, true);
select pg_temp.received(80, 'support+acme@mail.example.test',
	'{"messageId":"<x2@acme.example>","references":"<x1@acme.example>","subject":"Your code is 777777"}');
select pg_temp.member();
select pg_temp.wake_assert(item ? 'account' and not item ? 'subject' and (item ->> 'messages')::integer = 2,
	'Account mail that joins a thread marks it: ' || item::text)
from pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.plain')::uuid)) as item;
-- The mark stays when plain mail follows it.
select pg_temp.path_claims('service_role');
select pg_temp.received(83, 'support@mail.example.test', jsonb_build_object('messageId', '<x3@acme.example>',
	'references', '<x1@acme.example>', 'subject', 'Plain follow-up',
	'to', jsonb_build_array(repeat('a', 330) || '@x.example', 'ok@x.example')));
select pg_temp.wake_assert((select recipients_to = '["ok@x.example"]'::jsonb from public.qorpera_mail_received
	where message_id = '<x3@acme.example>'), 'Recipients longer than an address are not kept');
select pg_temp.member();

-- Account mail recorded as such when it arrives stays hidden, even when the lookup is gone.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.code2', pg_temp.received(77, 'support+acme@mail.example.test',
	'{"messageId":"<code2@acme.example>","subject":"Your code is 555555"}')::text, true);
select pg_temp.wake_assert((select account ->> 'site' = 'acme.example' and subject is null
		from public.qorpera_mail_received where delivery_id = current_setting('qorpera_test.code2')::uuid)
	and (select account ->> 'site' = 'acme.example' from public.qorpera_mail_threads
		where id = pg_temp.thread_of(current_setting('qorpera_test.code2')::uuid)),
	'Account mail is recorded as such when it arrives, without its subject');
drop function public.qorpera_company_account_mail(uuid, uuid, text[]);
select pg_temp.member();
select pg_temp.wake_assert(pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.code2')::uuid)) ? 'account'
	and not pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.code2')::uuid)) ? 'subject'
	and not pg_temp.thread(pg_temp.thread_of(current_setting('qorpera_test.code2')::uuid)) #> '{messages,0}' ? 'subject'
	and not pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.plain')::uuid)) ? 'subject',
	'A thread marked as account mail stays so, whether it began so or account mail joined it');

-- After the deliveries' 7-day purge clears headers and text, members still read the thread: the received messages,
-- their subject and sender, their account mark, and a later reply or open card joins it.
select pg_temp.path_claims('service_role');
update public.qorpera_event_deliveries set received_at = clock_timestamp() - interval '8 days'
where id in (current_setting('qorpera_test.first')::uuid, current_setting('qorpera_test.second')::uuid,
	current_setting('qorpera_test.code2')::uuid);
select public.qorpera_purge_event_deliveries(1000);
select pg_temp.wake_assert((select bool_and(headers = '{}'::jsonb and body is null) from public.qorpera_event_deliveries
	where id in (current_setting('qorpera_test.first')::uuid, current_setting('qorpera_test.code2')::uuid)), 'The purge ran');
select set_config('qorpera_test.late_reply', pg_temp.send('late-reply', pg_temp.request(p_extra => jsonb_build_object('inReplyTo',
	current_setting('qorpera_test.first'))))::text, true);
select set_config('qorpera_test.late_card', pg_temp.card('call-card-5', jsonb_build_object('from', 'support@mail.example.test',
	'to', jsonb_build_array('customer@example.org'), 'subject', 'Re: Where is my order?', 'text', 'Soon.',
	'inReplyTo', current_setting('qorpera_test.second')))::text, true);
select pg_temp.member();
select pg_temp.wake_assert((pg_temp.outbox(current_setting('qorpera_test.late_reply')::jsonb)).thread
		= current_setting('qorpera_test.thread')
	and (select count(*) = 3 and count(*) filter (where item -> 'textCleared' = 'true'::jsonb) = 2
		and bool_or(item ->> 'subject' = 'Where is my order?')
		from jsonb_array_elements(detail -> 'messages') as entry(item) where item ->> 'kind' = 'received')
	and detail #>> '{waiting,0,reviewId}' = current_setting('qorpera_test.late_card')
	and not detail #> '{waiting,0}' ? 'sessionId',
	'After the purge the thread reads whole (its card has no conversation): ' || detail::text)
from (select pg_temp.thread(current_setting('qorpera_test.thread')) as detail) as answer;
select pg_temp.wake_assert(pg_temp.listed(current_setting('qorpera_test.thread')) ->> 'state' = 'waiting'
	and not pg_temp.listed(pg_temp.thread_of(current_setting('qorpera_test.code2')::uuid)) ? 'subject',
	'After the purge a thread still waits, and account mail stays hidden');

-- The backfill records what was received before, threaded as the mail door now does, with long names cut. (A first
-- run records the fixture's deliveries written straight into the table.)
select pg_temp.path_claims('service_role');
select public.qorpera_mail_threads_backfill();
select set_config('qorpera_test.old', pg_temp.received(78, 'support@mail.example.test',
	'{"messageId":"<old@x.example>","subject":"Old"}')::text, true);
select set_config('qorpera_test.old_reply', pg_temp.received(84, 'support@mail.example.test',
	'{"messageId":"<old2@x.example>","references":"<old@x.example>","subject":"Re: Old"}')::text, true);
select set_config('qorpera_test.ancient', pg_temp.received(85, 'support@mail.example.test',
	'{"messageId":"<ancient@x.example>","subject":"Ancient"}')::text, true);
delete from public.qorpera_mail_threads where id in (pg_temp.thread_of(current_setting('qorpera_test.old')::uuid),
	pg_temp.thread_of(current_setting('qorpera_test.ancient')::uuid));
delete from public.qorpera_mail_received where delivery_id in (current_setting('qorpera_test.old')::uuid,
	current_setting('qorpera_test.old_reply')::uuid, current_setting('qorpera_test.ancient')::uuid);
update public.qorpera_event_deliveries set received_at = clock_timestamp() - interval '31 days'
where id = current_setting('qorpera_test.ancient')::uuid;
update public.qorpera_event_deliveries set headers = headers || jsonb_build_object('from', repeat('n', 400) || ' <old@x.example>')
where id = current_setting('qorpera_test.old')::uuid;
select set_config('qorpera_test.backfilled', public.qorpera_mail_threads_backfill()::text, true);
select pg_temp.wake_assert(current_setting('qorpera_test.backfilled') = '2'
		and pg_temp.thread_of(current_setting('qorpera_test.old')::uuid)
			= public.qorpera_mail_thread_id(pg_temp.support(), '<old@x.example>')
		and pg_temp.thread_of(current_setting('qorpera_test.old_reply')::uuid)
			= pg_temp.thread_of(current_setting('qorpera_test.old')::uuid)
		and pg_temp.thread_of(current_setting('qorpera_test.ancient')::uuid) is null
		and (select message_count = 2 and subject = 'Re: Old' and last_received_delivery_id = current_setting('qorpera_test.old_reply')::uuid
			from public.qorpera_mail_threads where id = pg_temp.thread_of(current_setting('qorpera_test.old')::uuid))
		and (select char_length(from_name) = 320 from public.qorpera_mail_received
			where delivery_id = current_setting('qorpera_test.old')::uuid),
	'The backfill threads what the last 30 days received, in the order it came, names cut to their limits');
select pg_temp.wake_assert(public.qorpera_mail_threads_backfill() = 0, 'The backfill records each once');

-- Mail switched off: every answer is empty.
select pg_temp.path_claims('service_role');
update public.qorpera_mail_settings set enabled = false;
select pg_temp.member();
select pg_temp.wake_assert(public.qorpera_member_mail_addresses('30000000-0000-4000-8000-000000000020') = '[]'::jsonb
		and pg_temp.threads() = '{"threads":[]}'::jsonb
		and pg_temp.thread(current_setting('qorpera_test.thread')) = '{"messages":[],"waiting":[]}'::jsonb
		and public.qorpera_member_mail_waiting('30000000-0000-4000-8000-000000000020') = '[]'::jsonb,
	'With mail off, members see none');
select pg_temp.path_claims('service_role');
update public.qorpera_mail_settings set enabled = true;

-- Threads quiet for 30 days are deleted by the outbox's claim, with their read marks.
update public.qorpera_mail_threads set last_at = clock_timestamp() - interval '31 days'
where id = current_setting('qorpera_test.thread');
select public.qorpera_claim_company_mail(1, '80800000-0000-4000-8000-0000000000f1');
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_mail_threads where id = current_setting('qorpera_test.thread'))
		and not exists (select 1 from public.qorpera_mail_thread_reads where thread_id = current_setting('qorpera_test.thread'))
		and exists (select 1 from public.qorpera_mail_threads where id = current_setting('qorpera_test.quote_thread')),
	'A quiet thread is deleted with its marks');

rollback;

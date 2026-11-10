-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Members send mail (20260930716000), on the folder-v2 runtime base. A member who may write in the company queues a
-- plain-text email from one of its mailboxes as themself: from "<member> at <company>", the text as written with no
-- AI line, beside the agents' email in the outbox, where the sender claims it as any queued email. Every member reads
-- it in Sent and in its thread as that member's, an outside answer joins the thread, the same send again is the same
-- email, and the company's limits count the agents' email and the members' together. A viewer, an outsider and
-- another company's member send nothing here; a request of another shape, a mailbox that is not this company's or is
-- removed or paused, the company's own mailboxes as recipients, a name that reads as Qorpera and the sending switch
-- are refused as send_mail refuses them.

select pg_temp.base_claims('service_role');
-- A member's request: send n, from the support mailbox to one customer.
create function pg_temp.ms_request(p_n integer, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('sendId', '73100000-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
		'from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Your order', 'text', 'Hello ' || p_n) || p_extra
$$;
-- The calling member sends it: the answer.
create function pg_temp.ms_send(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_send_member_mail('92400000-0000-4000-8000-000000000020', p_request)
$$;
-- The calling member's send is refused, with that state and message.
create function pg_temp.ms_refused(p_request jsonb, p_state text, p_message text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.ms_send(p_request);
	exception when others then
		if sqlstate = p_state and sqlerrm = p_message then return; end if;
		raise exception 'Expected % "%" for %, got %: %', p_state, p_message, left(p_request::text, 200), sqlstate, sqlerrm;
	end;
	raise exception 'Expected % "%" for %, the email was queued', p_state, p_message, left(p_request::text, 200);
end
$$;
-- The email of a member's send n, from the table; the owner's unless another member is named.
create function pg_temp.ms_mail(p_n integer, p_user uuid default '92400000-0000-4000-8000-000000000001')
returns public.qorpera_company_mail_outbox language sql as $$
	select mail from public.qorpera_company_mail_outbox as mail
	where mail.member_user_id = p_user
		and mail.member_send_id = ('73100000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
-- An email the base run's agent sends from the support mailbox: its outbox id.
create function pg_temp.ms_agent(p_call text) returns uuid language plpgsql as $$
begin
	perform public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, p_call,
		jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
			'subject', 'From the agent', 'text', 'Reply ' || p_call));
	return (select mail.id from public.qorpera_company_mail_outbox as mail where mail.call_id = p_call);
end $$;
-- A thread's line in the calling member's list, for a request.
create function pg_temp.ms_line(p_thread text, p_request jsonb default '{}') returns jsonb language sql as $$
	select entry.item
	from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', p_request)
		-> 'threads') as entry(item)
	where entry.item ->> 'thread' = p_thread
$$;
-- A thread's messages, as the calling member reads them.
create function pg_temp.ms_messages(p_thread text) returns jsonb language sql as $$
	select public.qorpera_member_mail_thread('92400000-0000-4000-8000-000000000020', p_thread, null) -> 'messages'
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
-- The members' names, as their accounts give them.
update auth.users set raw_user_meta_data = jsonb_build_object('display_name', case id
		when '92400000-0000-4000-8000-000000000001' then 'Olivia Owner'
		when '92400000-0000-4000-8000-000000000002' then 'Carl Contributor'
		when '92400000-0000-4000-8000-000000000003' then 'Vera Viewer' else 'Ada Admin' end)
where id in ('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002',
	'92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000004');
-- Three mailboxes: support, orders, and one that was removed.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support', 'Customer support') \g /dev/null
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'orders', 'Orders') \g /dev/null
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'old', 'An old mailbox') \g /dev/null
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'old' and removed_at is null), 'removed') \g /dev/null
-- Another company, with a mailbox of its own.
select pg_temp.base_claims('service_role');
insert into auth.users(id, email) values ('73100000-0000-4000-8000-0000000000c1', 'other-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('73100000-0000-4000-8000-0000000000c2', 'Other company', '73100000-0000-4000-8000-0000000000c1');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('73100000-0000-4000-8000-0000000000c2', '73100000-0000-4000-8000-0000000000c1', 'other-owner@example.test',
	'Other', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('73100000-0000-4000-8000-0000000000c3', '73100000-0000-4000-8000-0000000000c2', 'Environment', 1,
	'73100000-0000-4000-8000-0000000000c1');
select public.qorpera_folder_enable('73100000-0000-4000-8000-0000000000c3') \g /dev/null
select pg_temp.base_claims('authenticated', '73100000-0000-4000-8000-0000000000c1');
select public.qorpera_create_company_mailbox('73100000-0000-4000-8000-0000000000c2', '73100000-0000-4000-8000-0000000000c3',
	'theirs', 'Their mailbox') \g /dev/null

-- 1. A member sends an email as themself -------------------------------------------------------------------------------

-- The owner writes to two customers with a copy to a third: addresses as typed, one of them twice.
-- (Two statements: a statement does not see the rows a function it calls has written.)
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.ms_first', pg_temp.ms_send(pg_temp.ms_request(1, jsonb_build_object(
	'to', jsonb_build_array(' Customer@Example.org ', 'customer@example.org', 'second@example.org'),
	'cc', jsonb_build_array('second@example.org', 'boss@example.org'),
	'subject', '  Your order  ', 'text', E'Hello there,\n\nYour order is on its way.\n\n  ')))::text, true) \g /dev/null
select pg_temp.base_assert((select count(*) = 3 from jsonb_object_keys(answer)) and answer ->> 'status' = 'queued'
		and answer ->> 'mailId' = (pg_temp.ms_mail(1)).id::text and answer ->> 'thread' = (pg_temp.ms_mail(1)).thread,
	'The answer names the email, its thread and that it is queued: ' || answer::text)
from (select current_setting('qorpera_test.ms_first')::jsonb as answer) as sent;
select pg_temp.base_assert((select mail.member_user_id = '92400000-0000-4000-8000-000000000001'
			and mail.run_id is null and mail.call_id is null and mail.staff_agent_id is null
			and mail.mailbox_id = (select box.id from public.qorpera_company_mailboxes as box
				where box.local_part = 'support' and box.removed_at is null)
			and mail.from_name = 'Olivia Owner at Folder runtime base' and mail.from_address is null
			and mail.recipients_to = array['customer@example.org', 'second@example.org']
			and mail.recipients_cc = array['boss@example.org'] and mail.subject = 'Your order'
			and mail.body = E'Hello there,\n\nYour order is on its way.' and mail.status = 'pending'
			and mail.attempt_count = 0 and mail.in_reply_to_delivery_id is null and mail.in_reply_to is null
			and mail.attachments = '[]'::jsonb
		from pg_temp.ms_mail(1) as mail),
	'The outbox keeps it as the member''s: their name at the company, each address once, the text as written, no AI line');
select pg_temp.base_assert((select thread.last_direction = 'sent' and thread.last_sent_staff_agent_id is null
			and thread.last_sent_at = (pg_temp.ms_mail(1)).created_at and thread.last_received_at is null
			and thread.message_count = 1 and thread.subject = 'Your order' and thread.outside_name is null
			and thread.outside_address = 'customer@example.org' and thread.mailbox_id = (pg_temp.ms_mail(1)).mailbox_id
		from public.qorpera_mail_threads as thread where thread.id = (pg_temp.ms_mail(1)).thread),
	'It begins a thread of its own: last sent, to the first recipient, by no agent');
-- Sent lists the thread as the member's, and the thread shows who sent the email.
select pg_temp.base_assert(line ->> 'direction' = 'sent' and line ->> 'state' = 'handled' and not line ? 'handledBy'
		and line -> 'sentBy' = '{"userId":"92400000-0000-4000-8000-000000000001","name":"Olivia Owner"}'
		and line ->> 'address' = 'support@mail.example.test' and line ->> 'fromAddress' = 'customer@example.org'
		and line ->> 'subject' = 'Your order' and line ->> 'snippet' like 'Hello there,%'
		and line ->> 'messages' = '1' and line ->> 'unread' = 'false',
	'Sent lists the thread as the member''s: ' || coalesce(line::text, 'no line'))
from (select pg_temp.ms_line((pg_temp.ms_mail(1)).thread, '{"direction":"sent"}') as line) as listed;
select pg_temp.base_assert(jsonb_array_length(messages) = 1 and messages #>> '{0,kind}' = 'sent'
		and messages #>> '{0,mailId}' = (pg_temp.ms_mail(1)).id::text
		and messages #> '{0,member}' = '{"userId":"92400000-0000-4000-8000-000000000001","name":"Olivia Owner"}'
		and not messages -> 0 ? 'staffAgent' and messages #>> '{0,fromName}' = 'Olivia Owner at Folder runtime base'
		and messages #>> '{0,fromAddress}' = 'support@mail.example.test'
		and messages #> '{0,to}' = '["customer@example.org","second@example.org"]'
		and messages #> '{0,cc}' = '["boss@example.org"]' and messages #>> '{0,subject}' = 'Your order'
		and messages #>> '{0,text}' = E'Hello there,\n\nYour order is on its way.' and messages #>> '{0,status}' = 'queued',
	'The thread shows the email with the member who sent it: ' || coalesce(messages::text, 'no messages'))
from (select pg_temp.ms_messages((pg_temp.ms_mail(1)).thread) as messages) as read;
-- No mail is private to a member: a viewer reads the same line and the same message.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(
	pg_temp.ms_line((pg_temp.ms_mail(1)).thread, '{"direction":"sent"}') #>> '{sentBy,name}' = 'Olivia Owner'
		and pg_temp.ms_messages((pg_temp.ms_mail(1)).thread) #>> '{0,member,name}' = 'Olivia Owner'
		and pg_temp.ms_messages((pg_temp.ms_mail(1)).thread) #>> '{0,text}' like 'Hello there,%',
	'A viewer reads the member''s email in Sent and in its thread');
-- The platform's sender claims it as any queued email: from the member at the company at the mailbox's address, the
-- text as written, and no header saying a machine sent it.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.ms_claim',
	public.qorpera_claim_company_mail(10, '73100000-0000-4000-8000-0000000000a1')::text, true) \g /dev/null
select pg_temp.base_assert(jsonb_array_length(claim) = 1 and claim #>> '{0,mailId}' = (pg_temp.ms_mail(1)).id::text
		and claim #>> '{0,from}' = '"Olivia Owner at Folder runtime base" <support@mail.example.test>'
		and claim #> '{0,to}' = '["customer@example.org","second@example.org"]'
		and claim #> '{0,cc}' = '["boss@example.org"]' and claim #>> '{0,subject}' = 'Your order'
		and claim #>> '{0,text}' = E'Hello there,\n\nYour order is on its way.'
		and coalesce(claim #> '{0,headers}', '{}') = '{}'::jsonb and not claim -> 0 ? 'attachments'
		and (pg_temp.ms_mail(1)).status = 'delivering' and (pg_temp.ms_mail(1)).from_address = 'support@mail.example.test',
	'The sender claims the member''s email, with no AI line and no Auto-Submitted header: ' || claim::text)
from (select current_setting('qorpera_test.ms_claim')::jsonb as claim) as claimed;

-- 2. Who may send -------------------------------------------------------------------------------------------------------

-- A contributor and an admin send as themselves; a mailbox by its name alone is the same mailbox.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.ms_send(pg_temp.ms_request(2, '{"from":" SUPPORT "}')) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000004');
select pg_temp.ms_send(pg_temp.ms_request(3)) \g /dev/null
select pg_temp.base_assert(
	(pg_temp.ms_mail(2, '92400000-0000-4000-8000-000000000002')).from_name = 'Carl Contributor at Folder runtime base'
		and (pg_temp.ms_mail(2, '92400000-0000-4000-8000-000000000002')).mailbox_id = (pg_temp.ms_mail(1)).mailbox_id
		and (pg_temp.ms_mail(3, '92400000-0000-4000-8000-000000000004')).from_name = 'Ada Admin at Folder runtime base'
		and (pg_temp.ms_mail(3, '92400000-0000-4000-8000-000000000004')).thread
			<> (pg_temp.ms_mail(2, '92400000-0000-4000-8000-000000000002')).thread,
	'A contributor and an admin each send as themselves, each email in a thread of its own');
-- A viewer reads the company's mail and sends none.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.ms_refused(pg_temp.ms_request(4), '42501', 'Only a member who can write in the company sends its email');
-- An outsider, a caller who is not signed in, the service role and another company's owner are not members here.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.ms_refused(pg_temp.ms_request(4), '42501', 'Company mail is unavailable');
select pg_temp.base_claims('anon');
select pg_temp.ms_refused(pg_temp.ms_request(4), '42501', 'Company mail is unavailable');
select pg_temp.base_claims('service_role');
select pg_temp.ms_refused(pg_temp.ms_request(4), '42501', 'Company mail is unavailable');
select pg_temp.base_claims('authenticated', '73100000-0000-4000-8000-0000000000c1');
select pg_temp.ms_refused(pg_temp.ms_request(4, '{"from":"theirs@mail.example.test"}'), '42501',
	'Company mail is unavailable');
-- That owner sends from their own company's mailbox, and not from this company's.
select pg_temp.base_assert(public.qorpera_send_member_mail('73100000-0000-4000-8000-0000000000c3',
		pg_temp.ms_request(4, '{"from":"theirs@mail.example.test"}')) ->> 'status' = 'queued',
	'Another company''s owner sends from their own mailbox');
select pg_temp.base_error(format('select public.qorpera_send_member_mail(%L, %L::jsonb)',
	'73100000-0000-4000-8000-0000000000c3', pg_temp.ms_request(5)), '42501', 'No mailbox of this company has that address');

-- 3. What is refused ----------------------------------------------------------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
-- A request of another shape: not an object, a field missing, of another type or unknown.
select pg_temp.ms_refused(bad.request, '22023', 'Mail request is invalid') from (values
	(null::jsonb), ('null'), ('[]'), ('"send"'),
	(pg_temp.ms_request(10) - 'sendId'), (pg_temp.ms_request(10) - 'from'), (pg_temp.ms_request(10) - 'to'),
	(pg_temp.ms_request(10) - 'subject'), (pg_temp.ms_request(10) - 'text'),
	(pg_temp.ms_request(10, '{"sendId":"ten"}')), (pg_temp.ms_request(10, '{"sendId":10}')),
	(pg_temp.ms_request(10, '{"sendId":"73100000-0000-4000-8000-00000000001"}')),
	(pg_temp.ms_request(10, '{"from":7}')), (pg_temp.ms_request(10, '{"subject":7}')),
	(pg_temp.ms_request(10, '{"text":7}')), (pg_temp.ms_request(10, '{"to":"customer@example.org"}')),
	(pg_temp.ms_request(10, '{"cc":"boss@example.org"}')),
	(pg_temp.ms_request(10, '{"inReplyTo":"73100000-0000-4000-8000-0000000000b1"}')),
	(pg_temp.ms_request(10, '{"attachments":[]}')), (pg_temp.ms_request(10, '{"html":"<b>Hello</b>"}')),
	(pg_temp.ms_request(10, '{"fromName":"Someone else"}'))) as bad(request);
-- Recipients: one to ten in to, at most nine in cc, ten in all, each a plain address.
select pg_temp.ms_refused(pg_temp.ms_request(10, bad.extra), '22023', 'Mail request is invalid') from (values
	('{"to":[]}'::jsonb), ('{"to":[7]}'), ('{"to":["Customer <customer@example.org>"]}'),
	('{"to":["customer@example"]}'), ('{"to":["customer example.org"]}'), ('{"cc":["boss"]}'),
	(jsonb_build_object('to', (select jsonb_agg('to' || n || '@example.org') from generate_series(1, 11) as n))),
	(jsonb_build_object('cc', (select jsonb_agg('cc' || n || '@example.org') from generate_series(1, 10) as n))),
	(jsonb_build_object('to', (select jsonb_agg('to' || n || '@example.org') from generate_series(1, 6) as n),
		'cc', (select jsonb_agg('cc' || n || '@example.org') from generate_series(1, 5) as n)))) as bad(extra);
-- The subject: one line of 1 to 200 characters. The text: 1 to 20000 characters, not blank.
select pg_temp.ms_refused(pg_temp.ms_request(10, bad.extra), '22023', 'Mail request is invalid') from (values
	('{"subject":""}'::jsonb), ('{"subject":"   "}'), ('{"subject":"Two\nlines"}'),
	(jsonb_build_object('subject', repeat('s', 201))),
	('{"text":""}'), ('{"text":" \n\t "}'), (jsonb_build_object('text', repeat('t', 20001)))) as bad(extra);
-- ... and at those limits it goes.
select pg_temp.base_assert(pg_temp.ms_send(pg_temp.ms_request(11, jsonb_build_object('subject', repeat('s', 200),
		'text', repeat('t', 20000)))) ->> 'status' = 'queued',
	'A subject of 200 characters and a text of 20000 go');
-- Another company's mailbox, an unknown one, a removed one, a tagged one and one of another domain are not this
-- company's to send from.
select pg_temp.ms_refused(pg_temp.ms_request(12, bad.extra), '42501', 'No mailbox of this company has that address')
from (values ('{"from":"theirs@mail.example.test"}'::jsonb), ('{"from":"theirs"}'), ('{"from":"nobody@mail.example.test"}'),
	('{"from":"old@mail.example.test"}'), ('{"from":"support@other.example"}'),
	('{"from":"support+tag@mail.example.test"}')) as bad(extra);
-- A company never emails its own mailboxes, tagged or not, in to or in cc.
select pg_temp.ms_refused(pg_temp.ms_request(13, bad.extra), '42501', 'Email to your own company''s mailboxes is refused')
from (values ('{"to":["orders@mail.example.test"]}'::jsonb), ('{"to":["support@mail.example.test"]}'),
	('{"cc":["Support+tag@mail.example.test"]}')) as bad(extra);
-- A paused mailbox sends nothing until it is resumed.
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'orders' and removed_at is null), 'paused') \g /dev/null
select pg_temp.ms_refused(pg_temp.ms_request(14, '{"from":"orders@mail.example.test"}'), '0A000',
	'The mailbox is paused; resume it to send from it');
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'orders' and removed_at is null), 'active') \g /dev/null
select pg_temp.base_assert(pg_temp.ms_send(pg_temp.ms_request(14, '{"from":"orders@mail.example.test"}')) ->> 'status'
	= 'queued', 'A resumed mailbox sends again');
-- Nothing goes out as if from Qorpera: a member named like it sends nothing, whatever letters spell the name.
select pg_temp.base_claims('service_role');
update auth.users set raw_user_meta_data = '{"display_name":"Q0rpera Support"}'
where id = '92400000-0000-4000-8000-000000000004';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000004');
select pg_temp.ms_refused(pg_temp.ms_request(15), '42501',
	'Email that would look like it comes from Qorpera is refused; change your name, the company''s or the mailbox''s');
-- A name that is an address would read as the sender's address: the email goes out from "A member".
select pg_temp.base_claims('service_role');
update auth.users set raw_user_meta_data = '{"display_name":"ada@elsewhere.example"}'
where id = '92400000-0000-4000-8000-000000000004';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000004');
select pg_temp.ms_send(pg_temp.ms_request(15)) \g /dev/null
select pg_temp.base_assert(
	(pg_temp.ms_mail(15, '92400000-0000-4000-8000-000000000004')).from_name = 'A member at Folder runtime base',
	'A member whose name is an address sends as "A member"');
select pg_temp.base_claims('service_role');
update auth.users set raw_user_meta_data = '{"display_name":"Ada Admin"}' where id = '92400000-0000-4000-8000-000000000004';
-- The sending switch is the platform's: off, no member sends.
update public.qorpera_mail_settings set sending = false;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.ms_refused(pg_temp.ms_request(16), '0A000', 'Sending company mail is switched off');
select pg_temp.base_assert((select count(*) = 6 from public.qorpera_company_mail_outbox
		where profile_id = '92400000-0000-4000-8000-000000000010')
	and (select count(*) = 1 from public.qorpera_company_mail_outbox
		where profile_id = '73100000-0000-4000-8000-0000000000c2'),
	'No refused send queued an email: six are this company''s, one the other company''s');

-- 4. The same send again is the same email ------------------------------------------------------------------------------

-- A request sent again (the answer was lost on the way): one email and the same answer, whatever the request says
-- now and with sending still switched off.
select pg_temp.base_assert(again = current_setting('qorpera_test.ms_first')::jsonb
		and (select count(*) = 1 from public.qorpera_company_mail_outbox
			where member_send_id = '73100000-0000-4000-8000-000000000001')
		and (pg_temp.ms_mail(1)).body = E'Hello there,\n\nYour order is on its way.',
	'The same send again is the email already queued: ' || again::text)
from (select pg_temp.ms_send(pg_temp.ms_request(1, '{"text":"Another text"}')) as again) as retried;
select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set sending = true;
-- Another member's send under the same id is their own email.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.ms_send(pg_temp.ms_request(1)) \g /dev/null
select pg_temp.base_assert(
	(pg_temp.ms_mail(1, '92400000-0000-4000-8000-000000000002')).id <> (pg_temp.ms_mail(1)).id
		and (pg_temp.ms_mail(1, '92400000-0000-4000-8000-000000000002')).thread <> (pg_temp.ms_mail(1)).thread
		and (pg_temp.ms_mail(1, '92400000-0000-4000-8000-000000000002')).body = 'Hello 1',
	'A send id is one member''s: another member''s send under it is an email of its own');

-- 5. Sent, and answered -------------------------------------------------------------------------------------------------

-- The sender reports the email sent and reads back its Message-ID. The same send again then says it is sent.
select pg_temp.base_claims('service_role');
select public.qorpera_complete_company_mail((pg_temp.ms_mail(1)).id, '73100000-0000-4000-8000-0000000000a1',
	'provider-ms-1') \g /dev/null
select pg_temp.base_assert(public.qorpera_record_company_mail_message_id((pg_temp.ms_mail(1)).id, 'provider-ms-1',
	'<ms-1@mail.example.test>'), 'The Message-ID of the member''s email is recorded');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert((pg_temp.ms_mail(1)).status = 'sent'
		and pg_temp.ms_send(pg_temp.ms_request(1)) ->> 'status' = 'sent'
		and pg_temp.ms_messages((pg_temp.ms_mail(1)).thread) #>> '{0,status}' = 'sent',
	'A sent email reads as sent, in its thread and to the same send again');
-- The customer answers: the answer joins the member's thread, which now waits as any received email does.
select pg_temp.base_claims('service_role');
select public.qorpera_receive_mail('73100000-0000-4000-8000-0000000000b1', array['support@mail.example.test'],
	jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '73100000-0000-4000-8000-0000000000b1',
		'subject', 'Re: Your order', 'from', 'Customer <customer@example.org>',
		'to', jsonb_build_array('support@mail.example.test'), 'text', 'Thank you!',
		'messageId', '<answer-1@example.org>', 'references', '<ms-1@mail.example.test>')::text) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert((select thread.last_direction = 'received' and thread.message_count = 2
			and thread.outside_name = 'Customer' and thread.last_sent_staff_agent_id is null
		from public.qorpera_mail_threads as thread where thread.id = (pg_temp.ms_mail(1)).thread)
		and jsonb_array_length(messages) = 2 and messages #>> '{0,member,name}' = 'Olivia Owner'
		and messages #>> '{1,kind}' = 'received' and messages -> 1 ? 'deliveryId'
		and line ->> 'direction' = 'received' and line ->> 'state' = 'new' and not line ? 'sentBy'
		and line ->> 'messages' = '2' and line ->> 'unread' = 'true',
	'An outside answer joins the member''s thread: ' || coalesce(line::text, 'no line') || ' '
		|| coalesce(messages::text, 'no messages'))
from (select pg_temp.ms_messages((pg_temp.ms_mail(1)).thread) as messages,
	pg_temp.ms_line((pg_temp.ms_mail(1)).thread) as line) as read;
-- An agent's email is the agent's, as before: no member on its row, its message or its line.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.ms_agent', pg_temp.ms_agent('ms-agent-1')::text, true) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(sent.member_user_id is null and sent.member_send_id is null and sent.run_id is not null
		and sent.staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and not line ? 'sentBy' and line #>> '{handledBy,staffAgentId}' = '92400000-0000-4000-8000-000000000030'
		and messages #>> '{0,staffAgent,staffAgentId}' = '92400000-0000-4000-8000-000000000030'
		and not messages -> 0 ? 'member',
	'An agent''s email names its agent and no member: ' || coalesce(line::text, 'no line') || ' '
		|| coalesce(messages::text, 'no messages'))
from (select (select mail from public.qorpera_company_mail_outbox as mail
	where mail.id = current_setting('qorpera_test.ms_agent')::uuid) as mail) as queued
cross join lateral (select (queued.mail).*) as sent
cross join lateral (select pg_temp.ms_line(sent.thread, '{"direction":"sent"}') as line,
	pg_temp.ms_messages(sent.thread) as messages) as read;

-- 6. The company's limits -----------------------------------------------------------------------------------------------

-- An email with more recipients than the limits ever allow.
select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set company_hourly_recipients = 2, company_daily_recipients = 300;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.ms_refused(pg_temp.ms_request(20, '{"to":["a@example.org","b@example.org","c@example.org"]}'), '54000',
	'The company''s email limits allow 2 recipients an hour and 300 a day, fewer than this email has');
-- The agents' email and the members' count together: with room for two more recipients this hour, an agent's email
-- and a member's go, and the next of either waits.
select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set company_hourly_recipients = 2 + (
	select sum(cardinality(mail.recipients_to) + cardinality(mail.recipients_cc))
	from public.qorpera_company_mail_outbox as mail where mail.profile_id = '92400000-0000-4000-8000-000000000010');
select pg_temp.ms_agent('ms-agent-2') \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.ms_send(pg_temp.ms_request(21)) \g /dev/null
-- The refusal says when the email can go: when the hour's oldest email has left the hour.
do $$
declare v_after timestamptz;
begin
	begin
		perform pg_temp.ms_send(pg_temp.ms_request(22));
	exception when sqlstate '54000' then
		v_after := substring(sqlerrm from 'this email can go after ([0-9TZ:-]+)$')::timestamptz;
		perform pg_temp.base_assert(sqlerrm ~ '^The company has emailed the [0-9]+ recipients an hour and 300 a day its limits allow; '
				and v_after > clock_timestamp() and v_after <= clock_timestamp() + interval '1 hour 1 second',
			'A member''s email past the hourly limit says when it can go: ' || sqlerrm);
		return;
	end;
	raise exception 'A member''s email past the hourly limit was queued';
end
$$;
select pg_temp.base_claims('service_role');
select pg_temp.base_error(format('select pg_temp.ms_agent(%L)', 'ms-agent-3'), '54000');
-- An email cancelled before any attempt never went out, so its recipient is not counted: one more email goes. The
-- same send again says its email was cancelled.
update public.qorpera_company_mail_outbox set status = 'cancelled', settled_at = clock_timestamp()
where id = (pg_temp.ms_mail(21)).id;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.ms_send(pg_temp.ms_request(22)) ->> 'status' = 'queued'
		and pg_temp.ms_send(pg_temp.ms_request(21)) ->> 'status' = 'cancelled',
	'An email cancelled before any attempt leaves its room to the next, and its send again says cancelled');
select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set company_hourly_recipients = 60;

-- 7. Kept as the company's ----------------------------------------------------------------------------------------------

-- A member who has left: their email stays in its thread, with who sent it by id and the name it went out under.
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(messages #> '{0,member}' = '{"userId":"92400000-0000-4000-8000-000000000002"}'
		and messages #>> '{0,fromName}' = 'Carl Contributor at Folder runtime base'
		and line -> 'sentBy' = '{"userId":"92400000-0000-4000-8000-000000000002"}',
	'The email of a member who has left stays the company''s: ' || coalesce(line::text, 'no line') || ' '
		|| coalesce(messages::text, 'no messages'))
from (select mail.thread from pg_temp.ms_mail(2, '92400000-0000-4000-8000-000000000002') as mail) as sent
cross join lateral (select pg_temp.ms_line(sent.thread, '{"direction":"sent"}') as line,
	pg_temp.ms_messages(sent.thread) as messages) as read;
-- An email in the outbox is an agent's or a member's, never both and never neither.
select pg_temp.base_error($q$update public.qorpera_company_mail_outbox
	set staff_agent_id = '92400000-0000-4000-8000-000000000030' where member_send_id is not null$q$, '23514');
select pg_temp.base_error($q$update public.qorpera_company_mail_outbox
	set member_user_id = null, member_send_id = null where member_send_id is not null$q$, '23514');
select pg_temp.base_error($q$update public.qorpera_company_mail_outbox
	set member_user_id = '92400000-0000-4000-8000-000000000001', member_send_id = extensions.gen_random_uuid()
	where call_id is not null$q$, '23514');
-- Members call the send; nobody calls the helper that names a member, and nobody reads the outbox.
select pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_send_member_mail(uuid,jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_send_member_mail(uuid,jsonb)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_send_member_mail(uuid,jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_member_mail_member(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_member_mail_member(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_member_mail_member(uuid,uuid)', 'EXECUTE')
		and not has_table_privilege('authenticated', 'public.qorpera_company_mail_outbox', 'SELECT'),
	'Only signed-in members call the send; the outbox and the helper stay closed');
-- A company being deleted sends nothing.
select pg_temp.base_claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.ms_refused(pg_temp.ms_request(30), '42501', 'Company mail is unavailable');

rollback;

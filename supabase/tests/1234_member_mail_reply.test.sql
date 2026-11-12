-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member answers in a mail thread (20260930740000), on the folder-v2 runtime base. A member who may write in the
-- company sends their own email with `replyTo`, the message it answers: a received email of the company (by its
-- deliveryId) or a sent one (by its mailId). The email joins that message's thread and carries In-Reply-To and
-- References built from the answered message's ids, so the other side's mail program threads it too; the outside
-- answer to it joins the same thread. It is the member's own act: it answers automatic email, carries no
-- Auto-Submitted and no AI line. A message with no usable id is answered in its thread without thread headers. A
-- reply to what is not this company's, to account mail, of another shape, or by a viewer is refused. A received
-- email joins the thread of a message its mailbox knows, sent or received, that it answers or references first; and
-- the thread read gives a received message's Reply-To addresses while its stored message is kept.

select pg_temp.base_claims('service_role');
-- A member's request: send n, from the support mailbox to the customer.
create function pg_temp.mr_request(p_n integer, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('sendId', '12340000-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
		'from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Re: Your order', 'text', 'Answer ' || p_n) || p_extra
$$;
-- The same, as a reply to a message.
create function pg_temp.mr_reply(p_n integer, p_kind text, p_id uuid, p_extra jsonb default '{}') returns jsonb
language sql as $$
	select pg_temp.mr_request(p_n, jsonb_build_object('replyTo', jsonb_build_object('kind', p_kind, 'id', p_id)) || p_extra)
$$;
create function pg_temp.mr_send(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_send_member_mail('92400000-0000-4000-8000-000000000020', p_request)
$$;
create function pg_temp.mr_refused(p_request jsonb, p_state text, p_message text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.mr_send(p_request);
	exception when others then
		if sqlstate = p_state and sqlerrm = p_message then return; end if;
		raise exception 'Expected % "%" for %, got %: %', p_state, p_message, left(p_request::text, 200), sqlstate, sqlerrm;
	end;
	raise exception 'Expected % "%" for %, the email was queued', p_state, p_message, left(p_request::text, 200);
end
$$;
-- The email of a member's send n, from the table; the owner's unless another member is named.
create function pg_temp.mr_mail(p_n integer, p_user uuid default '92400000-0000-4000-8000-000000000001')
returns public.qorpera_company_mail_outbox language sql as $$
	select mail from public.qorpera_company_mail_outbox as mail
	where mail.member_user_id = p_user
		and mail.member_send_id = ('12340000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
-- An email arrives at a mailbox of the test domain: email n, with what its message says beside the usual.
create function pg_temp.mr_receive(p_n integer, p_to text, p_extra jsonb) returns void language plpgsql as $$
declare v_id text := '12340000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0');
begin
	perform public.qorpera_receive_mail(v_id, array[p_to], (jsonb_build_object('schema', 'qorpera.mail/v1',
		'emailId', v_id, 'subject', 'Your order', 'from', 'Customer <customer@example.org>',
		'to', jsonb_build_array(p_to), 'text', 'Where is my order?') || p_extra)::text);
end $$;
-- The received email with that Message-ID, as members read it.
create function pg_temp.mr_received(p_message_id text) returns public.qorpera_mail_received language sql as $$
	select received from public.qorpera_mail_received as received where received.message_id = p_message_id
$$;
-- A thread's line and messages, as the calling member reads them.
create function pg_temp.mr_line(p_thread text) returns jsonb language sql as $$
	select entry.item
	from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}')
		-> 'threads') as entry(item)
	where entry.item ->> 'thread' = p_thread
$$;
create function pg_temp.mr_messages(p_thread text) returns jsonb language sql as $$
	select public.qorpera_member_mail_thread('92400000-0000-4000-8000-000000000020', p_thread, null) -> 'messages'
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
update auth.users set raw_user_meta_data = jsonb_build_object('display_name', case id
		when '92400000-0000-4000-8000-000000000001' then 'Olivia Owner'
		when '92400000-0000-4000-8000-000000000002' then 'Carl Contributor'
		when '92400000-0000-4000-8000-000000000003' then 'Vera Viewer' else 'Ada Admin' end)
where id in ('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002',
	'92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000004');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support', 'Customer support') \g /dev/null
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'orders', 'Orders') \g /dev/null
-- Another company, with a mailbox, a received email and a sent one of its own.
select pg_temp.base_claims('service_role');
insert into auth.users(id, email) values ('12340000-0000-4000-8000-0000000000c1', 'other-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12340000-0000-4000-8000-0000000000c2', 'Other company', '12340000-0000-4000-8000-0000000000c1');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('12340000-0000-4000-8000-0000000000c2', '12340000-0000-4000-8000-0000000000c1', 'other-owner@example.test',
	'Other', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12340000-0000-4000-8000-0000000000c3', '12340000-0000-4000-8000-0000000000c2', 'Environment', 1,
	'12340000-0000-4000-8000-0000000000c1');
select public.qorpera_folder_enable('12340000-0000-4000-8000-0000000000c3') \g /dev/null
select pg_temp.base_claims('authenticated', '12340000-0000-4000-8000-0000000000c1');
select public.qorpera_create_company_mailbox('12340000-0000-4000-8000-0000000000c2', '12340000-0000-4000-8000-0000000000c3',
	'theirs', 'Their mailbox') \g /dev/null
select public.qorpera_send_member_mail('12340000-0000-4000-8000-0000000000c3', pg_temp.mr_request(90,
	'{"from":"theirs@mail.example.test"}')) \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.mr_receive(90, 'theirs@mail.example.test', '{"messageId":"<theirs-1@example.org>"}');

-- 1. A reply to a received email --------------------------------------------------------------------------------------

-- A customer writes in a thread that began elsewhere: the email names the thread's root and the email before it.
select pg_temp.mr_receive(1, 'support@mail.example.test', jsonb_build_object('messageId', '<q-1@example.org>',
	'references', '<root@example.org> <mid@example.org>', 'inReplyTo', '<mid@example.org>'));
select pg_temp.base_assert((pg_temp.mr_received('<q-1@example.org>')).delivery_id is not null,
	'The customer''s email is received');
-- The owner answers it. (Two statements: a statement does not see the rows a function it calls has written.)
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.mr_first', pg_temp.mr_send(pg_temp.mr_reply(1, 'received',
	(pg_temp.mr_received('<q-1@example.org>')).delivery_id))::text, true) \g /dev/null
select pg_temp.base_assert((select count(*) = 3 from jsonb_object_keys(answer)) and answer ->> 'status' = 'queued'
		and answer ->> 'mailId' = (pg_temp.mr_mail(1)).id::text
		and answer ->> 'thread' = (pg_temp.mr_received('<q-1@example.org>')).thread_id,
	'The answer names the reply and the thread of the email it answers: ' || answer::text)
from (select current_setting('qorpera_test.mr_first')::jsonb as answer) as sent;
select pg_temp.base_assert((select mail.thread = (pg_temp.mr_received('<q-1@example.org>')).thread_id
			and mail.in_reply_to = '<q-1@example.org>'
			and mail.thread_references = '<root@example.org> <mid@example.org> <q-1@example.org>'
			and mail.in_reply_to_delivery_id is null and mail.member_user_id = '92400000-0000-4000-8000-000000000001'
			and mail.staff_agent_id is null and mail.from_name = 'Olivia Owner at Folder runtime base'
			and mail.subject = 'Re: Your order' and mail.body = 'Answer 1' and mail.status = 'pending'
		from pg_temp.mr_mail(1) as mail),
	'The outbox keeps the reply in the thread, with the ids of the email it answers and no mark of an automatic reply');
select pg_temp.base_assert((select thread.last_direction = 'sent' and thread.message_count = 2
			and thread.last_sent_staff_agent_id is null and thread.outside_address = 'customer@example.org'
			and thread.outside_name = 'Customer' and thread.subject = 'Re: Your order'
		from public.qorpera_mail_threads as thread where thread.id = (pg_temp.mr_mail(1)).thread)
		and line ->> 'state' = 'handled' and line ->> 'direction' = 'sent' and line ->> 'messages' = '2'
		and line -> 'sentBy' = '{"userId":"92400000-0000-4000-8000-000000000001","name":"Olivia Owner"}'
		and jsonb_array_length(messages) = 2 and messages #>> '{0,kind}' = 'received'
		and messages #>> '{1,kind}' = 'sent' and messages #>> '{1,mailId}' = (pg_temp.mr_mail(1)).id::text
		and messages #>> '{1,member,name}' = 'Olivia Owner' and messages #>> '{1,text}' = 'Answer 1',
	'The thread holds the email and the member''s reply, and is handled: ' || coalesce(line::text, 'no line') || ' '
		|| coalesce(messages::text, 'no messages'))
from (select pg_temp.mr_line((pg_temp.mr_mail(1)).thread) as line,
	pg_temp.mr_messages((pg_temp.mr_mail(1)).thread) as messages) as read;
-- The platform's sender claims it with its thread headers, and with nothing that says a machine sent it.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mr_claim',
	public.qorpera_claim_company_mail(10, '12340000-0000-4000-8000-0000000000a1')::text, true) \g /dev/null
select pg_temp.base_assert(mail #>> '{from}' = '"Olivia Owner at Folder runtime base" <support@mail.example.test>'
		and mail #> '{headers}' = jsonb_build_object('In-Reply-To', '<q-1@example.org>',
			'References', '<root@example.org> <mid@example.org> <q-1@example.org>')
		and mail #>> '{text}' = 'Answer 1',
	'The sender claims the reply with In-Reply-To and References and no Auto-Submitted: ' || coalesce(mail::text, 'none'))
from (select (select item.value from jsonb_array_elements(current_setting('qorpera_test.mr_claim')::jsonb) as item(value)
	where item.value ->> 'mailId' = (pg_temp.mr_mail(1)).id::text) as mail) as claimed;

-- 2. A follow-up to a sent email, and the answer to it -----------------------------------------------------------------

-- The reply went out and its Message-ID is read back. A contributor follows up on it: the same thread, the reply's
-- own ids before its Message-ID.
select public.qorpera_complete_company_mail((pg_temp.mr_mail(1)).id, '12340000-0000-4000-8000-0000000000a1',
	'provider-mr-1') \g /dev/null
select pg_temp.base_assert(public.qorpera_record_company_mail_message_id((pg_temp.mr_mail(1)).id, 'provider-mr-1',
	'<mr-1@mail.example.test>'), 'The Message-ID of the reply is recorded');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.mr_send(pg_temp.mr_reply(2, 'sent', (pg_temp.mr_mail(1)).id)) \g /dev/null
select pg_temp.base_assert((select mail.thread = (pg_temp.mr_mail(1)).thread
			and mail.in_reply_to = '<mr-1@mail.example.test>'
			and mail.thread_references
				= '<root@example.org> <mid@example.org> <q-1@example.org> <mr-1@mail.example.test>'
			and mail.in_reply_to_delivery_id is null and mail.from_name = 'Carl Contributor at Folder runtime base'
		from pg_temp.mr_mail(2, '92400000-0000-4000-8000-000000000002') as mail)
		and (select thread.message_count = 3 from public.qorpera_mail_threads as thread
			where thread.id = (pg_temp.mr_mail(1)).thread),
	'A follow-up to a sent email is in its thread, after that email''s ids');
-- A sent email whose Message-ID is not read back yet is followed up in its thread, without thread headers.
select pg_temp.mr_send(pg_temp.mr_reply(3, 'sent', (pg_temp.mr_mail(2, '92400000-0000-4000-8000-000000000002')).id)) \g /dev/null
select pg_temp.base_assert((select mail.thread = (pg_temp.mr_mail(1)).thread and mail.in_reply_to is null
			and mail.thread_references is null
		from pg_temp.mr_mail(3, '92400000-0000-4000-8000-000000000002') as mail),
	'A follow-up to an email with no Message-ID yet is in its thread, without thread headers');
-- The customer answers the member's reply: the answer names the thread's root first, and joins the same thread.
select pg_temp.base_claims('service_role');
select pg_temp.mr_receive(2, 'support@mail.example.test', jsonb_build_object('messageId', '<q-2@example.org>',
	'references', '<root@example.org> <mid@example.org> <q-1@example.org> <mr-1@mail.example.test>',
	'inReplyTo', '<mr-1@mail.example.test>'));
select pg_temp.base_assert((pg_temp.mr_received('<q-2@example.org>')).thread_id = (pg_temp.mr_mail(1)).thread
		and (select thread.last_direction = 'received' and thread.message_count = 5
			from public.qorpera_mail_threads as thread where thread.id = (pg_temp.mr_mail(1)).thread),
	'The outside answer to the member''s reply joins the thread');

-- 3. What a person may answer that an agent may not, and what has no id ------------------------------------------------

-- An automatic email (an auto-reply, a mailing list): an agent's reply to it is refused, a member's goes.
select pg_temp.mr_receive(3, 'support@mail.example.test', '{"messageId":"<auto-1@example.org>","automated":true}');
select pg_temp.base_error(format('select public.qorpera_send_agent_mail(%L::jsonb, %L, %L::jsonb)',
	current_setting('qorpera_test.base_binding'), 'mr-agent-1', jsonb_build_object('from', 'support@mail.example.test',
		'to', jsonb_build_array('customer@example.org'), 'subject', 'Re: Your order', 'text', 'Hello',
		'inReplyTo', (pg_temp.mr_received('<auto-1@example.org>')).delivery_id)), '42501',
	'That email was sent automatically (an auto-reply, a mailing list or bulk mail); it is not answered');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.mr_send(pg_temp.mr_reply(4, 'received', (pg_temp.mr_received('<auto-1@example.org>')).delivery_id)) \g /dev/null
select pg_temp.base_assert((select mail.thread = (pg_temp.mr_received('<auto-1@example.org>')).thread_id
			and mail.in_reply_to = '<auto-1@example.org>' and mail.thread_references = '<auto-1@example.org>'
			and mail.in_reply_to_delivery_id is null
		from pg_temp.mr_mail(4) as mail),
	'A member answers an automatic email: a person replying starts no loop');
-- A received email without a Message-ID is answered in its thread, without thread headers.
select pg_temp.base_claims('service_role');
select pg_temp.mr_receive(4, 'support@mail.example.test', '{"subject":"No id"}');
select set_config('qorpera_test.mr_no_id', (select received.delivery_id::text from public.qorpera_mail_received as received
	where received.subject = 'No id'), true) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.mr_send(pg_temp.mr_reply(5, 'received', current_setting('qorpera_test.mr_no_id')::uuid)) \g /dev/null
select pg_temp.base_assert((select mail.thread = (select received.thread_id from public.qorpera_mail_received as received
				where received.delivery_id = current_setting('qorpera_test.mr_no_id')::uuid)
			and mail.in_reply_to is null and mail.thread_references is null
		from pg_temp.mr_mail(5) as mail),
	'A reply to an email without a Message-ID is in its thread, without thread headers');
-- Once the answered email's text is cleared its own References are gone: the reply still names the email it answers.
select pg_temp.base_claims('service_role');
update public.qorpera_event_deliveries set body = null
where id = (pg_temp.mr_received('<q-2@example.org>')).delivery_id;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.mr_send(pg_temp.mr_reply(6, 'received', (pg_temp.mr_received('<q-2@example.org>')).delivery_id)) \g /dev/null
select pg_temp.base_assert((select mail.thread = (pg_temp.mr_mail(1)).thread and mail.in_reply_to = '<q-2@example.org>'
			and mail.thread_references = '<q-2@example.org>'
		from pg_temp.mr_mail(6) as mail),
	'A reply to an email whose text is cleared stays in its thread and names that email');
-- A reply may go from another of the company's mailboxes; it is still in the thread of the email it answers.
select pg_temp.mr_send(pg_temp.mr_reply(7, 'received', (pg_temp.mr_received('<q-1@example.org>')).delivery_id,
	'{"from":"orders@mail.example.test"}')) \g /dev/null
select pg_temp.base_assert((select mail.thread = (pg_temp.mr_mail(1)).thread
			and mail.mailbox_id = (select box.id from public.qorpera_company_mailboxes as box
				where box.local_part = 'orders' and box.removed_at is null)
		from pg_temp.mr_mail(7) as mail),
	'A reply from another mailbox of the company is in the answered email''s thread');

-- The customer answers that reply. The answer names the cleared email first, an id no sent email has: it joins the
-- thread through the received email the company knows by that id.
select pg_temp.base_claims('service_role');
select pg_temp.mr_receive(5, 'support@mail.example.test', jsonb_build_object('messageId', '<q-3@example.org>',
	'references', '<q-2@example.org> <mr-6@mail.example.test>', 'inReplyTo', '<mr-6@mail.example.test>'));
select pg_temp.base_assert((pg_temp.mr_received('<q-3@example.org>')).thread_id = (pg_temp.mr_mail(1)).thread,
	'The answer to a reply that names only a received email joins that email''s thread');
-- An answer whose first reference the company does not know joins the thread of the email it answers.
select pg_temp.mr_receive(6, 'support@mail.example.test', jsonb_build_object('messageId', '<q-4@example.org>',
	'references', '<elsewhere@example.net> <mr-1@mail.example.test>', 'inReplyTo', '<mr-1@mail.example.test>'));
select pg_temp.base_assert((pg_temp.mr_received('<q-4@example.org>')).thread_id = (pg_temp.mr_mail(1)).thread,
	'An answer to a sent email joins its thread, whatever it references first');
-- An email that answers nothing the company knows is in the thread of the first id it references, as before; and
-- another company's mailbox knows none of this company's messages.
select pg_temp.mr_receive(7, 'support@mail.example.test', jsonb_build_object('messageId', '<new-1@example.org>',
	'references', '<unknown@example.net>', 'inReplyTo', '<unknown@example.net>'));
select pg_temp.mr_receive(91, 'theirs@mail.example.test', jsonb_build_object('messageId', '<theirs-2@example.org>',
	'references', '<q-2@example.org>', 'inReplyTo', '<mr-1@mail.example.test>'));
select pg_temp.base_assert((pg_temp.mr_received('<new-1@example.org>')).thread_id = public.qorpera_mail_thread_id(
			(pg_temp.mr_received('<new-1@example.org>')).mailbox_id, '<unknown@example.net>')
		and (pg_temp.mr_received('<theirs-2@example.org>')).thread_id = public.qorpera_mail_thread_id(
			(pg_temp.mr_received('<theirs-2@example.org>')).mailbox_id, '<q-2@example.org>')
		and (pg_temp.mr_received('<theirs-2@example.org>')).thread_id <> (pg_temp.mr_mail(1)).thread,
	'An email that answers nothing its mailbox knows is in the thread of its first reference');

-- 3b. Where an email asks its answers to go ----------------------------------------------------------------------------

-- A received message carries the addresses of its Reply-To while its stored message is kept; never for account mail.
select pg_temp.mr_receive(8, 'support@mail.example.test', jsonb_build_object('messageId', '<vendor-1@example.org>',
	'from', 'Vendor <no-reply@vendor.example>',
	'replyTo', jsonb_build_array('support@vendor.example', 7, repeat('x', 400), 'billing@vendor.example')));
select pg_temp.mr_receive(9, 'support@mail.example.test', '{"messageId":"<vendor-2@example.org>","replyTo":[]}');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(
	pg_temp.mr_messages((pg_temp.mr_received('<vendor-1@example.org>')).thread_id) #> '{0,replyTo}'
			= '["support@vendor.example","billing@vendor.example"]'
		and pg_temp.mr_messages((pg_temp.mr_received('<vendor-1@example.org>')).thread_id) #>> '{0,fromAddress}'
			= 'no-reply@vendor.example'
		and not pg_temp.mr_messages((pg_temp.mr_received('<vendor-2@example.org>')).thread_id) -> 0 ? 'replyTo'
		and not pg_temp.mr_messages((pg_temp.mr_received('<q-1@example.org>')).thread_id) -> 0 ? 'replyTo',
	'A received message says where its answers are asked to go, and nothing when it asks for nowhere else');
select pg_temp.base_claims('service_role');
update public.qorpera_mail_received set account = '{"unknown":true}'
where delivery_id = (pg_temp.mr_received('<vendor-1@example.org>')).delivery_id;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(
	not pg_temp.mr_messages((pg_temp.mr_received('<vendor-1@example.org>')).thread_id) -> 0 ? 'replyTo',
	'Account mail shows no Reply-To');
select pg_temp.base_claims('service_role');
update public.qorpera_mail_received set account = null
where delivery_id = (pg_temp.mr_received('<vendor-1@example.org>')).delivery_id;
update public.qorpera_event_deliveries set body = null
where id = (pg_temp.mr_received('<vendor-1@example.org>')).delivery_id;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(
	not pg_temp.mr_messages((pg_temp.mr_received('<vendor-1@example.org>')).thread_id) -> 0 ? 'replyTo',
	'A message whose text is cleared shows no Reply-To');

-- 4. References on one header line -------------------------------------------------------------------------------------

select pg_temp.base_assert(
	public.qorpera_mail_reply_references(null, '<a@example.org>') = '<a@example.org>'
		and public.qorpera_mail_reply_references('', '<a@example.org>') = '<a@example.org>'
		-- The provider's list shape, a repeated id and the answered id itself among them.
		and public.qorpera_mail_reply_references('["<r@example.org>","<m@example.org>","<r@example.org>","<a@example.org>"]',
			'<a@example.org>') = '<r@example.org> <m@example.org> <a@example.org>'
		and public.qorpera_mail_reply_references('<r@example.org>', null) is null
		and public.qorpera_mail_reply_references('<r@example.org>', 'a@example.org') is null
		and public.qorpera_mail_reply_references('<r@example.org>', '<a b@example.org>') is null
		and public.qorpera_mail_reply_references('<r@example.org>', '<' || repeat('a', 979) || '>') is null,
	'References are the stored ids, each once, then the id answered; none without a usable id');
-- More ids than one line holds: the root, then the newest that fit, then the id answered.
select pg_temp.base_assert(char_length(built) <= 980 and built like '<root@example.org> <id-%'
		and built like '% <id-60@' || repeat('x', 30) || '.example.org> <a@example.org>'
		and built not like '%<id-1@%'
		and (select count(*) between 10 and 59 from regexp_matches(built, '<id-', 'g')),
	'A long thread keeps its root and its newest ids on one line: ' || built)
from (select public.qorpera_mail_reply_references('<root@example.org> ' || (select string_agg(
	'<id-' || n || '@' || repeat('x', 30) || '.example.org>', ' ' order by n) from generate_series(1, 60) as n),
	'<a@example.org>') as built) as long;

-- 5. What is refused ---------------------------------------------------------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
-- A `replyTo` of another shape.
select pg_temp.mr_refused(pg_temp.mr_request(10, jsonb_build_object('replyTo', bad.value)), '22023',
	'Mail request is invalid') from (values
	('null'::jsonb), ('"12340000-0000-4000-8000-000000000101"'), ('[]'), ('{}'),
	('{"kind":"received"}'), ('{"id":"12340000-0000-4000-8000-000000000101"}'),
	('{"kind":"draft","id":"12340000-0000-4000-8000-000000000101"}'),
	('{"kind":7,"id":"12340000-0000-4000-8000-000000000101"}'),
	('{"kind":"received","id":"one"}'), ('{"kind":"received","id":7}'),
	('{"kind":"received","id":"12340000-0000-4000-8000-000000000101","thread":"x"}')) as bad(value);
-- A message that is not there, another company's received email and another company's sent one.
select pg_temp.mr_refused(pg_temp.mr_reply(11, bad.kind, bad.id), '42501',
	'The email this answers is not one the company can answer') from (values
	('received', '12340000-0000-4000-8000-0000000000ff'::uuid), ('sent', '12340000-0000-4000-8000-0000000000ff'),
	('received', (pg_temp.mr_received('<theirs-1@example.org>')).delivery_id),
	('sent', (select mail.id from public.qorpera_company_mail_outbox as mail
		where mail.profile_id = '12340000-0000-4000-8000-0000000000c2')),
	-- A received email's id is no sent email's, and the other way round.
	('sent', (pg_temp.mr_received('<q-1@example.org>')).delivery_id), ('received', (pg_temp.mr_mail(1)).id)) as bad(kind, id);
-- Mail for one of the company's accounts on a site is not answered.
select pg_temp.base_claims('service_role');
update public.qorpera_mail_received set account = '{"unknown":true}'
where delivery_id = (pg_temp.mr_received('<auto-1@example.org>')).delivery_id;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.mr_refused(pg_temp.mr_reply(12, 'received', (pg_temp.mr_received('<auto-1@example.org>')).delivery_id),
	'42501', 'The email this answers is not one the company can answer');
-- A reply is checked as any email of a member's: a viewer sends none, and the company's own mailboxes are no recipients.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.mr_refused(pg_temp.mr_reply(13, 'received', (pg_temp.mr_received('<q-1@example.org>')).delivery_id),
	'42501', 'Only a member who can write in the company sends its email');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.mr_refused(pg_temp.mr_reply(13, 'received', (pg_temp.mr_received('<q-1@example.org>')).delivery_id,
	'{"to":["orders@mail.example.test"]}'), '42501', 'Email to your own company''s mailboxes is refused');
-- Another company's owner answers their own mail, and none of this company's.
select pg_temp.base_claims('authenticated', '12340000-0000-4000-8000-0000000000c1');
select pg_temp.base_assert(public.qorpera_send_member_mail('12340000-0000-4000-8000-0000000000c3',
		pg_temp.mr_reply(91, 'received', (pg_temp.mr_received('<theirs-1@example.org>')).delivery_id,
			'{"from":"theirs@mail.example.test"}')) ->> 'thread' = (pg_temp.mr_received('<theirs-1@example.org>')).thread_id,
	'Another company''s owner answers their own company''s email');
select pg_temp.base_error(format('select public.qorpera_send_member_mail(%L, %L::jsonb)',
	'12340000-0000-4000-8000-0000000000c3', pg_temp.mr_reply(92, 'received',
		(pg_temp.mr_received('<q-1@example.org>')).delivery_id, '{"from":"theirs@mail.example.test"}')), '42501',
	'The email this answers is not one the company can answer');
select pg_temp.base_claims('service_role');
select pg_temp.base_assert((select count(*) = 7 from public.qorpera_company_mail_outbox
		where profile_id = '92400000-0000-4000-8000-000000000010')
	and (select count(*) = 2 from public.qorpera_company_mail_outbox
		where profile_id = '12340000-0000-4000-8000-0000000000c2'),
	'No refused reply queued an email: seven are this company''s, two the other company''s');

-- 6. The same send again, and a new email as before --------------------------------------------------------------------

-- A reply sent again (the answer was lost on the way) is the email already queued.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(again ->> 'mailId' = (pg_temp.mr_mail(1)).id::text
		and again ->> 'thread' = (pg_temp.mr_mail(1)).thread and again ->> 'status' = 'sent',
	'The same reply again is the email already sent: ' || again::text)
from (select pg_temp.mr_send(pg_temp.mr_reply(1, 'received', (pg_temp.mr_received('<q-1@example.org>')).delivery_id))
	as again) as retried;
-- An email without `replyTo` begins a thread of its own, with no thread headers, as before.
select pg_temp.mr_send(pg_temp.mr_request(20)) \g /dev/null
select pg_temp.base_assert((select mail.thread <> (pg_temp.mr_mail(1)).thread and mail.in_reply_to is null
			and mail.thread_references is null
			and (select thread.message_count = 1 from public.qorpera_mail_threads as thread where thread.id = mail.thread)
		from pg_temp.mr_mail(20) as mail),
	'An email that answers nothing begins a thread of its own');
-- Nobody calls the helper that builds References.
select pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_mail_reply_references(text,text)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_mail_reply_references(text,text)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_mail_reply_references(text,text)', 'EXECUTE'),
	'The References helper stays closed');

rollback;

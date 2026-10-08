-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company mail for members and quotes of it, between companies and roles, on the folder-v2 runtime base (ported from
-- snapshot-v1 in the legacy sweep; it also holds the surviving checks of 808 and 816, which other tests chain on). The
-- mail tables are closed; only a member of the company reads its mail (not an outsider, anon, another role with a
-- member's id, another environment or a company being deleted); another company's reply never joins this company's
-- thread, and its threads and cards are never this company's, to list, read or mark; an account mail's subject, text,
-- recipients and attachments never show, and a failing account lookup hides rather than shows; a message or a draft
-- never quotes another company's mail or account mail, and a viewer is refused before any quote is read; threads quiet
-- for 30 days are deleted with their read marks.

select pg_temp.base_claims('service_role');
-- A received email as the mail door stores it: the delivery of its first recipient.
create function pg_temp.mq_received(p_n integer, p_to text, p_message jsonb default '{}') returns uuid language sql as $$
	select (public.qorpera_receive_mail('81500000-0000-4000-8000-' || lpad((500 + p_n)::text, 12, '0'), array[p_to],
		(jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '81500000-0000-4000-8000-' || lpad((500 + p_n)::text, 12, '0'),
			'subject', 'Refund', 'from', 'Customer <customer@example.org>', 'to', jsonb_build_array(p_to), 'text', 'Hi.')
			|| p_message)::text) #>> '{results,0,deliveryId}')::uuid
$$;
create function pg_temp.mq_thread_of(p_delivery uuid) returns text language sql as $$
	select thread_id from public.qorpera_mail_received where delivery_id = p_delivery
$$;
-- A thread as the calling member's list shows it, or null.
create function pg_temp.mq_listed(p_thread text) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
		'{"limit":50}') -> 'threads') as entry(item)
	where item ->> 'thread' = p_thread
$$;
create function pg_temp.mq_detail(p_thread text) returns jsonb language sql as $$
	select public.qorpera_member_mail_thread('92400000-0000-4000-8000-000000000020', p_thread)
$$;
-- A member's message that quotes a mail thread: «Order 7» at 7–14.
create function pg_temp.mq_quoted(p_ref text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'About «Order 7» please.',
		'quotes', jsonb_build_array(jsonb_build_object('start', 7, 'end', 14, 'source', 'mail', 'ref', p_ref)))
$$;
-- A member's post in Alice's thread, paid by the owner's sponsor, through the real room door.
create function pg_temp.mq_post(p_user uuid, p_body jsonb) returns jsonb language plpgsql as $$
declare
	v_claims text := current_setting('request.jwt.claims', true);
	v_room uuid := pg_temp.base_thread('92400000-0000-4000-8000-000000000030');
	v_binding uuid := (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_post jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_post := public.qorpera_post_company_room_message(v_room, extensions.gen_random_uuid(), p_body, v_binding, 1);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_post;
end
$$;
-- The owner's draft in Alice's thread with the quoted message's text and quotes.
create function pg_temp.mq_draft(p_ref text) returns jsonb language plpgsql as $$
declare
	v_claims text := current_setting('request.jwt.claims', true);
	v_room uuid := pg_temp.base_thread('92400000-0000-4000-8000-000000000030');
	v_body jsonb := pg_temp.mq_quoted(p_ref);
	v_draft jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_draft := public.qorpera_put_room_draft(v_room, '92400000-0000-4000-8000-000000000001', 0, v_body ->> 'text',
		v_body -> 'quotes');
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_draft;
end
$$;
-- An open review card for a send_mail call of the base run, in a company's name, with its arguments as the card keeps them.
create function pg_temp.mq_card(p_call text, p_profile uuid, p_arguments jsonb) returns uuid language sql as $$
	insert into public.qorpera_action_reviews (profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope)
	values (p_profile, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, p_call,
		'92400000-0000-4000-8000-000000000030', 'send_mail', 'external', repeat('a', 64),
		jsonb_build_object('title', 'Send an email', 'arguments', p_arguments::text), 'ask', 'none', 'A person decides',
		'reviewer-fixture', 'owners_admins')
	returning id
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';

-- Another folder-v2 company (made as the base makes its own).
insert into auth.users(id, email) values ('81500000-0000-4000-8000-000000000001', 'quotes-other-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('81500000-0000-4000-8000-000000000010', 'Other company', '81500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('81500000-0000-4000-8000-000000000010', '81500000-0000-4000-8000-000000000001', 'quotes-other-owner@example.test',
	'Other', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('81500000-0000-4000-8000-000000000020', '81500000-0000-4000-8000-000000000010', 'Environment', 1,
	'81500000-0000-4000-8000-000000000001');
select public.qorpera_folder_enable('81500000-0000-4000-8000-000000000020') \g /dev/null

-- Each company's mailbox, made by its owner.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support', 'Customer support') \g /dev/null
select pg_temp.base_claims('authenticated', '81500000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('81500000-0000-4000-8000-000000000010', '81500000-0000-4000-8000-000000000020',
	'theirs', 'Their mailbox') \g /dev/null
select pg_temp.base_claims('service_role');

-- An account Alice used, on a tagged address of the support mailbox (written as 809 writes them: the secret is not
-- needed for the lookup).
select set_config('session_replication_role', 'replica', true) \g /dev/null
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
	opened_by_user_id, created_at, closed_at, last_used_at, last_used_by_staff_agent_id, connected_at)
values ('81500000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'acme.example', 'support+acme@mail.example.test', 'connected', '92400000-0000-4000-8000-000000000001',
	'2026-10-01T00:00:00Z', null, '2026-10-02T09:00:00Z', '92400000-0000-4000-8000-000000000030', '2026-10-01T00:00:00Z');
select set_config('session_replication_role', 'origin', true) \g /dev/null

-- This company's first email, a thread of its own.
select set_config('qorpera_test.mq_ours', pg_temp.mq_received(1, 'support@mail.example.test',
	'{"messageId":"<q1@acme.test>","subject":"Where is my order?"}')::text, true) \g /dev/null
select set_config('qorpera_test.mq_thread', pg_temp.mq_thread_of(current_setting('qorpera_test.mq_ours')::uuid), true)
\g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mq_thread') ~ '^[A-Za-z0-9_-]{43}$',
	'The first email starts a thread: ' || current_setting('qorpera_test.mq_thread'));

-- 1. The mail tables are closed ---------------------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_mail_threads', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_mail_received', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_mail_thread_reads', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Mail threads are exposed to %', v_role; end if;
	end loop;
end
$$;

-- 2. Only a member of the company reads its mail ----------------------------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error(statement, '42501', 'Company mail is unavailable')
from (values
	($q$select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}')$q$),
	($q$select public.qorpera_member_mail_addresses('92400000-0000-4000-8000-000000000020')$q$),
	(format('select pg_temp.mq_detail(%L)', current_setting('qorpera_test.mq_thread'))),
	($q$select public.qorpera_member_mail_waiting('92400000-0000-4000-8000-000000000020')$q$),
	(format($q$select public.qorpera_mark_mail_thread_read('92400000-0000-4000-8000-000000000020', %L)$q$,
		current_setting('qorpera_test.mq_thread')))) as item(statement);
select pg_temp.base_claims('anon');
select pg_temp.base_error($q$select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}')$q$,
	'42501', 'Company mail is unavailable');
-- A member's id under another role is not a member's call.
select pg_temp.base_claims('service_role', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}')$q$,
	'42501', 'Company mail is unavailable');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_member_mail_threads(extensions.gen_random_uuid(), '{}')$q$,
	'42501', 'Company mail is unavailable');
-- A company being deleted has no members to read its mail.
select pg_temp.base_claims('service_role');
do $$
begin
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error($q$select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}')$q$,
		'42501', 'Company mail is unavailable');
	raise exception using errcode = 'P0004', message = 'undo the deletion';
exception when sqlstate 'P0004' then null;
end
$$;

-- 3. Between companies: threads, reads, marks and cards are each company's own ---------------------------------------

-- Another company's reply to this company's email is its own company's thread.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mq_theirs', pg_temp.mq_received(2, 'theirs@mail.example.test',
	'{"messageId":"<t1@other.example>","references":"<q1@acme.test>","inReplyTo":"<q1@acme.test>","subject":"Re: Where is my order?"}')::text,
	true) \g /dev/null
select set_config('qorpera_test.mq_their_thread', pg_temp.mq_thread_of(current_setting('qorpera_test.mq_theirs')::uuid), true)
\g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mq_their_thread') = public.qorpera_mail_thread_id(
		(select id from public.qorpera_company_mailboxes where local_part = 'theirs' and removed_at is null), '<q1@acme.test>')
	and (select profile_id = '81500000-0000-4000-8000-000000000010' from public.qorpera_mail_threads
		where id = current_setting('qorpera_test.mq_their_thread'))
	and (select message_count = 1 and subject = 'Where is my order?' from public.qorpera_mail_threads
		where id = current_setting('qorpera_test.mq_thread')),
	'Another company''s mail never joins this company''s thread');
-- Members list, read and mark only their company's threads.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.mq_listed(current_setting('qorpera_test.mq_thread')) is not null
	and pg_temp.mq_listed(current_setting('qorpera_test.mq_their_thread')) is null
	and not exists (select 1 from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
			'{"limit":50}') -> 'threads') as entry(item)
		left join public.qorpera_mail_threads as thread on thread.id = item ->> 'thread'
		where thread.profile_id is distinct from '92400000-0000-4000-8000-000000000010'),
	'Another company''s threads are not listed');
select pg_temp.base_error(format('select pg_temp.mq_detail(%L)', current_setting('qorpera_test.mq_their_thread')), '22023',
	'No mail thread of this company has that id');
select pg_temp.base_error(format($q$select public.qorpera_mark_mail_thread_read('92400000-0000-4000-8000-000000000020', %L)$q$,
	current_setting('qorpera_test.mq_their_thread')), '22023', 'No mail thread of this company has that id');
-- A card that answers another company's email has no thread here; another company's card is never this company's,
-- whatever email it names.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mq_card', pg_temp.mq_card('mq-card-1', '92400000-0000-4000-8000-000000000010',
	jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'), 'subject', 'Wrong',
		'text', 'No.', 'inReplyTo', current_setting('qorpera_test.mq_theirs')))::text, true) \g /dev/null
select pg_temp.mq_card('mq-card-2', '81500000-0000-4000-8000-000000000010', jsonb_build_object('from', 'theirs@mail.example.test',
	'to', jsonb_build_array('customer@example.org'), 'subject', 'Theirs', 'text', 'Not yours.',
	'inReplyTo', current_setting('qorpera_test.mq_ours'))) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(jsonb_array_length(waiting) = 1 and waiting #>> '{0,reviewId}' = current_setting('qorpera_test.mq_card')
		and not waiting -> 0 ? 'thread'
		and pg_temp.mq_detail(current_setting('qorpera_test.mq_thread')) -> 'waiting' = '[]'::jsonb,
	'A card answering another company''s email has no thread, and another company''s card is never listed: ' || waiting::text)
from (select public.qorpera_member_mail_waiting('92400000-0000-4000-8000-000000000020') as waiting) as answer;

-- 4. Account mail: who used the account, never its subject, text, recipients or attachments ---------------------------

select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mq_code', pg_temp.mq_received(3, 'support+acme@mail.example.test',
	'{"messageId":"<code@acme.example>","subject":"Your code is 424242","text":"Code 424242","to":["support+acme@mail.example.test"],"cc":["boss@acme.example"],"attachments":[{"id":"att_code","filename":"code.pdf","size":3}]}')::text,
	true) \g /dev/null
select set_config('qorpera_test.mq_code_thread', pg_temp.mq_thread_of(current_setting('qorpera_test.mq_code')::uuid), true)
\g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(not item ? 'subject' and item #>> '{account,site}' = 'acme.example'
		and item #>> '{account,lastUsedBy}' = '92400000-0000-4000-8000-000000000030'
		and pg_temp.mq_listed(current_setting('qorpera_test.mq_thread')) ->> 'subject' = 'Where is my order?',
	'Account mail shows the account, not the subject (other mail keeps it): ' || coalesce(item::text, 'not listed'))
from (select pg_temp.mq_listed(current_setting('qorpera_test.mq_code_thread')) as item) as answer;
select pg_temp.base_assert(not detail #> '{messages,0}' ?| array['subject', 'text', 'to', 'cc', 'attachments']
		and detail #>> '{messages,0,account,site}' = 'acme.example'
		and detail #>> '{messages,0,fromAddress}' = 'customer@example.org',
	'The thread shows who used the account, not the code: ' || detail::text)
from (select pg_temp.mq_detail(current_setting('qorpera_test.mq_code_thread')) as detail) as answer;
-- Account mail that joins a thread marks it.
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mq_plain', pg_temp.mq_received(4, 'support@mail.example.test',
	'{"messageId":"<x1@acme.example>","subject":"Welcome"}')::text, true) \g /dev/null
select pg_temp.mq_received(5, 'support+acme@mail.example.test',
	'{"messageId":"<x2@acme.example>","references":"<x1@acme.example>","subject":"Your code is 777777"}') \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(item ? 'account' and not item ? 'subject' and (item ->> 'messages')::integer = 2,
	'Account mail that joins a thread marks it: ' || coalesce(item::text, 'not listed'))
from (select pg_temp.mq_listed(pg_temp.mq_thread_of(current_setting('qorpera_test.mq_plain')::uuid)) as item) as answer;
-- A lookup that fails never costs the mail, and never shows it: it is stored as account mail would be, and read as
-- unknown.
select pg_temp.base_claims('service_role');
alter function public.qorpera_company_account_mail(uuid, uuid, text[]) rename to qorpera_company_account_mail_mq;
create function public.qorpera_company_account_mail(p_profile_id uuid, p_environment_id uuid, p_addresses text[])
returns jsonb language plpgsql stable set search_path = '' as $$ begin raise exception 'lookup down'; end $$;
select set_config('qorpera_test.mq_down', pg_temp.mq_received(6, 'support@mail.example.test',
	'{"messageId":"<down@x.example>","subject":"Maybe a code"}')::text, true) \g /dev/null
select pg_temp.base_assert((select received.subject is null and received.account = '{"unknown":true}'::jsonb
		from public.qorpera_mail_received as received where received.delivery_id = current_setting('qorpera_test.mq_down')::uuid),
	'With the lookup down, the mail is stored without its subject');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(item -> 'account' = '{"unknown":true}'::jsonb and not item ? 'subject',
	'A failing lookup hides the subject, and the list still answers: ' || coalesce(item::text, 'not listed'))
from (select pg_temp.mq_listed(pg_temp.mq_thread_of(current_setting('qorpera_test.mq_down')::uuid)) as item) as answer;
select pg_temp.base_claims('service_role');
drop function public.qorpera_company_account_mail(uuid, uuid, text[]);
alter function public.qorpera_company_account_mail_mq(uuid, uuid, text[]) rename to qorpera_company_account_mail;

-- 5. Quotes: never another company's mail or account mail, and a viewer is refused first ------------------------------

select pg_temp.base_error(format('select pg_temp.mq_post(%L, %L::jsonb)', '92400000-0000-4000-8000-000000000001',
	pg_temp.mq_quoted(current_setting(setting))), '22023', 'A quote names an unknown record')
from unnest(array['qorpera_test.mq_their_thread', 'qorpera_test.mq_code_thread']) as setting;
select pg_temp.base_error(format('select pg_temp.mq_post(%L, %L::jsonb)', '92400000-0000-4000-8000-000000000003',
	pg_temp.mq_quoted(repeat('Z', 43))), '42501', 'Room is unavailable');
select pg_temp.base_error(format('select pg_temp.mq_draft(%L)', current_setting(setting)), '22023',
	'A quote names an unknown record')
from unnest(array['qorpera_test.mq_their_thread', 'qorpera_test.mq_code_thread']) as setting;
-- The company's own mail is quoted, in a draft and a message.
select pg_temp.base_assert(pg_temp.mq_draft(current_setting('qorpera_test.mq_thread')) ->> 'status' = 'ok',
	'A draft quotes the company''s own mail');
select set_config('qorpera_test.mq_post', pg_temp.mq_post('92400000-0000-4000-8000-000000000001',
	pg_temp.mq_quoted(current_setting('qorpera_test.mq_thread')))::text, true) \g /dev/null
select pg_temp.base_assert((select input.body -> 'quotes' = pg_temp.mq_quoted(current_setting('qorpera_test.mq_thread')) -> 'quotes'
		from public.qorpera_session_inputs as input
		where input.id = (current_setting('qorpera_test.mq_post')::jsonb ->> 'inputId')::uuid),
	'A message quotes the company''s own mail: ' || current_setting('qorpera_test.mq_post'));

-- 6. Threads quiet for 30 days are deleted, with their read marks -----------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_mark_mail_thread_read('92400000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.mq_thread')), 'The owner marks the thread read');
select pg_temp.base_assert(exists (select 1 from public.qorpera_mail_thread_reads
	where thread_id = current_setting('qorpera_test.mq_thread')), 'The owner''s read mark is kept');
select pg_temp.base_claims('service_role');
update public.qorpera_mail_threads set last_at = clock_timestamp() - interval '31 days'
where id = current_setting('qorpera_test.mq_thread');
select public.qorpera_claim_company_mail(1, '81500000-0000-4000-8000-0000000000f1') \g /dev/null
select pg_temp.base_assert(not exists (select 1 from public.qorpera_mail_threads where id = current_setting('qorpera_test.mq_thread'))
		and not exists (select 1 from public.qorpera_mail_thread_reads where thread_id = current_setting('qorpera_test.mq_thread'))
		and exists (select 1 from public.qorpera_mail_threads where id = current_setting('qorpera_test.mq_code_thread')),
	'A quiet thread is deleted with its read marks; a newer one stays');

rollback;

-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The Mailbox's list lines (20260930522000), on the folder-v2 runtime base. Each thread in the threads call carries the
-- start of its newest message's text on one line, at most 200 characters: a received message's while its body is
-- kept, an agent's reply once it is the newest. Account mail carries none, and a body that can't be read leaves the
-- snippet out without failing the list. Each waiting send carries the start of the text the agent wants to send.

select pg_temp.base_claims('service_role');
-- A received email as the mail door stores it: the delivery of its first recipient.
create function pg_temp.ms_received(p_n integer, p_to text, p_message jsonb default '{}') returns uuid language sql as $$
	select (public.qorpera_receive_mail('71900000-0000-4000-8000-' || lpad(p_n::text, 12, '0'), array[p_to],
		(jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '71900000-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
			'subject', 'Catering', 'from', 'Mette Holm <mette@example.org>', 'to', jsonb_build_array(p_to),
			'text', 'Message ' || p_n) || p_message)::text) #>> '{results,0,deliveryId}')::uuid
$$;
create function pg_temp.ms_thread_of(p_delivery uuid) returns text language sql as $$
	select thread_id from public.qorpera_mail_received where delivery_id = p_delivery
$$;
-- A thread as the calling member's list shows it, or null.
create function pg_temp.ms_listed(p_thread text) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
		'{"limit":50}') -> 'threads') as entry(item)
	where item ->> 'thread' = p_thread
$$;
-- An open review card for a send_mail call of the base run, with its arguments as the card keeps them (as 815 makes it).
create function pg_temp.ms_card(p_call text, p_arguments jsonb) returns uuid language sql as $$
	insert into public.qorpera_action_reviews (profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope)
	values ('92400000-0000-4000-8000-000000000010', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
		p_call, '92400000-0000-4000-8000-000000000030', 'send_mail', 'external', repeat('a', 64),
		jsonb_build_object('title', 'Send an email', 'arguments', p_arguments::text), 'ask', 'none', 'A person decides',
		'reviewer-fixture', 'owners_admins')
	returning id
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'hej', 'Customers') \g /dev/null
select pg_temp.base_claims('service_role');
-- An account an agent used, on a tagged address of the mailbox (as 815 writes it).
select set_config('session_replication_role', 'replica', true) \g /dev/null
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
	opened_by_user_id, created_at, closed_at, last_used_at, last_used_by_staff_agent_id, connected_at)
values ('71900000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'wolt.example', 'hej+wolt@mail.example.test', 'connected', '92400000-0000-4000-8000-000000000001',
	'2026-10-01T00:00:00Z', null, '2026-10-02T09:00:00Z', '92400000-0000-4000-8000-000000000030', '2026-10-01T00:00:00Z');
select set_config('session_replication_role', 'origin', true) \g /dev/null

-- A: a received email whose text spreads over lines and runs of spaces. B: one of 500 characters. C: one the agent
-- answers, so its newest message is the reply. D: account mail. E: one whose stored body is not JSON. F: one whose
-- body is no longer kept.
select set_config('qorpera_test.ms_a', pg_temp.ms_received(1, 'hej@mail.example.test',
	jsonb_build_object('messageId', '<a@example.org>',
		'text', E'Hi,\n\n  We would like lunch\tfor 40 people.\r\n\r\nBest,\nMette  ')) ::text, true) \g /dev/null
select set_config('qorpera_test.ms_b', pg_temp.ms_received(2, 'hej@mail.example.test',
	jsonb_build_object('messageId', '<b@example.org>', 'text', repeat('æ', 500)))::text, true) \g /dev/null
select set_config('qorpera_test.ms_c', pg_temp.ms_received(3, 'hej@mail.example.test',
	jsonb_build_object('messageId', '<c@example.org>', 'text', 'Does the vegan box contain nuts?'))::text, true) \g /dev/null
select public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, 'ms-reply',
	jsonb_build_object('from', 'hej@mail.example.test', 'to', jsonb_build_array('mette@example.org'),
		'subject', 'Re: Catering', 'text', E'Hi Jakob,\n\nNo nuts, but the kitchen uses them.',
		'inReplyTo', current_setting('qorpera_test.ms_c'))) \g /dev/null
select set_config('qorpera_test.ms_d', pg_temp.ms_received(4, 'hej+wolt@mail.example.test',
	'{"messageId":"<d@wolt.example>","subject":"Your code is 424242","text":"Code 424242"}')::text, true) \g /dev/null
select set_config('qorpera_test.ms_e', pg_temp.ms_received(5, 'hej@mail.example.test',
	'{"messageId":"<e@example.org>","text":"Readable once"}')::text, true) \g /dev/null
select set_config('qorpera_test.ms_f', pg_temp.ms_received(6, 'hej@mail.example.test',
	'{"messageId":"<f@example.org>","text":"Kept for a while"}')::text, true) \g /dev/null
update public.qorpera_event_deliveries set body = convert_to('not json {', 'UTF8')
where id = current_setting('qorpera_test.ms_e')::uuid;
update public.qorpera_event_deliveries set body = null where id = current_setting('qorpera_test.ms_f')::uuid;
-- A send the agent wants to make in thread A, waiting for a person.
select set_config('qorpera_test.ms_card', pg_temp.ms_card('ms-card', jsonb_build_object('from', 'hej@mail.example.test',
	'to', jsonb_build_array('mette@example.org'), 'subject', 'Re: Catering',
	'text', E'Hi Mette,\n\nGreat, we''ll bring cutlery for 40.', 'inReplyTo', current_setting('qorpera_test.ms_a')))::text,
	true) \g /dev/null
select pg_temp.base_assert((select count(*) = 6 from public.qorpera_mail_threads
		where environment_id = '92400000-0000-4000-8000-000000000020'),
	'The fixture has six threads');

-- The checks, as the owner ------------------------------------------------------------------------------------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_a')::uuid)) ->> 'snippet'
		= 'Hi, We would like lunch for 40 people. Best, Mette',
	'A received email''s snippet is its text on one line, each run of whitespace one space, trimmed');
select pg_temp.base_assert(snippet = repeat('æ', 200) and char_length(snippet) = 200,
	'A long text''s snippet is its first 200 characters: ' || coalesce(snippet, 'none'))
from (select pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_b')::uuid)) ->> 'snippet' as snippet) as one;
-- (The outbox keeps the text as sent, with the line the platform adds after the agent's own.)
select pg_temp.base_assert(item ->> 'direction' = 'sent' and item ->> 'snippet' like 'Hi Jakob, No nuts, but the kitchen uses them. %',
	'Once the agent''s reply is the newest message, the snippet is the reply''s: ' || item::text)
from (select pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_c')::uuid)) as item) as one;
select pg_temp.base_assert(item ? 'account' and not item ? 'snippet' and not item ? 'subject',
	'Account mail has no snippet, as it has no subject: ' || item::text)
from (select pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_d')::uuid)) as item) as one;
select pg_temp.base_assert(e is not null and not e ? 'snippet' and f is not null and not f ? 'snippet'
		and jsonb_array_length(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}') -> 'threads') = 6,
	'A body that is not JSON, or no longer kept, leaves the snippet out and the list whole: ' || e::text || ' ' || f::text)
from (select pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_e')::uuid)) as e,
	pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_f')::uuid)) as f) as two;
select pg_temp.base_assert(jsonb_array_length(waiting) = 1
		and waiting #>> '{0,reviewId}' = current_setting('qorpera_test.ms_card')
		and waiting #>> '{0,snippet}' = 'Hi Mette, Great, we''ll bring cutlery for 40.',
	'A waiting send carries the start of the text the agent wants to send: ' || waiting::text)
from (select public.qorpera_member_mail_waiting('92400000-0000-4000-8000-000000000020') as waiting) as answer;
select pg_temp.base_assert(public.qorpera_mail_snippet(E' \n\t ') is null and public.qorpera_mail_snippet(null) is null
		and public.qorpera_mail_snippet('a  b') = 'a b',
	'Blank text has no snippet');

-- Who may call is unchanged, and the helpers are closed ------------------------------------------------------------

select pg_temp.base_assert(not has_function_privilege(role, 'public.qorpera_mail_snippet(text)', 'EXECUTE')
		and not has_function_privilege(role, 'public.qorpera_mail_thread_snippet(text)', 'EXECUTE'),
	'The snippet helpers are not callable by ' || role)
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role);
select pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_member_mail_threads(uuid,jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_member_mail_threads(uuid,jsonb)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_member_mail_waiting(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_member_mail_waiting(uuid)', 'EXECUTE'),
	'The threads and waiting calls are still for members only');
-- A viewer reads the snippets; an outsider reads nothing.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(pg_temp.ms_listed(pg_temp.ms_thread_of(current_setting('qorpera_test.ms_a')::uuid)) ? 'snippet',
	'A viewer reads the snippets');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error($q$select public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020', '{}')$q$,
	'42501', 'Company mail is unavailable');
select pg_temp.base_error($q$select public.qorpera_member_mail_waiting('92400000-0000-4000-8000-000000000020')$q$,
	'42501', 'Company mail is unavailable');

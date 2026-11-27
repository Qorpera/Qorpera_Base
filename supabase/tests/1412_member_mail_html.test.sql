-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

select pg_temp.base_claims('service_role');

create function pg_temp.mh_received(p_n integer, p_to text, p_message jsonb default '{}') returns uuid language sql as $$
	select (public.qorpera_receive_mail('14120000-0000-4000-8000-' || lpad(p_n::text, 12, '0'), array[p_to],
		(jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '14120000-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
			'subject', 'Alert ' || p_n, 'from', 'GitGuardian <security@example.org>', 'to', jsonb_build_array(p_to))
			|| p_message)::text) #>> '{results,0,deliveryId}')::uuid
$$;
create function pg_temp.mh_thread_of(p_delivery uuid) returns text language sql as $$
	select thread_id from public.qorpera_mail_received where delivery_id = p_delivery
$$;
create function pg_temp.mh_listed(p_thread text) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_member_mail_threads('92400000-0000-4000-8000-000000000020',
		'{"limit":50}') -> 'threads') as entry(item)
	where item ->> 'thread' = p_thread
$$;
create function pg_temp.mh_message(p_thread text) returns jsonb language sql as $$
	select public.qorpera_member_mail_thread('92400000-0000-4000-8000-000000000020', p_thread, null) -> 'messages' -> 0
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'alerts.base', 'Alerts') \g /dev/null
select pg_temp.base_claims('service_role');

select set_config('session_replication_role', 'replica', true) \g /dev/null
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
	opened_by_user_id, created_at, closed_at, last_used_at, last_used_by_staff_agent_id, connected_at)
values ('14120000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'github.example', 'alerts.base+github@mail.example.test', 'connected', '92400000-0000-4000-8000-000000000001',
	'2026-10-01T00:00:00Z', null, '2026-10-02T09:00:00Z', '92400000-0000-4000-8000-000000000030', '2026-10-01T00:00:00Z');
select set_config('session_replication_role', 'origin', true) \g /dev/null

select set_config('qorpera_test.mh_html_only', pg_temp.mh_received(1, 'alerts.base@mail.example.test',
	jsonb_build_object('messageId', '<mh1@example.org>', 'text', null,
		'html', '<!doctype html><html><head><title>Secret</title><style>body{color:red}</style></head><body><!-- hidden --><div>&zwnj;&#847;&nbsp;<b>Secret exposed</b> &amp; rotated &mdash; check&nbsp;now.</div></body></html>'))::text, true) \g /dev/null

select set_config('qorpera_test.mh_both', pg_temp.mh_received(2, 'alerts.base@mail.example.test',
	jsonb_build_object('messageId', '<mh2@example.org>', 'text', 'Plain version first.',
		'html', '<p>Rich <strong>HTML</strong> version.</p>'))::text, true) \g /dev/null

select set_config('qorpera_test.mh_truncated', pg_temp.mh_received(3, 'alerts.base@mail.example.test',
	jsonb_build_object('messageId', '<mh3@example.org>', 'text', null, 'truncated', true,
		'html', '<p>Cut off start</p>'))::text, true) \g /dev/null

select set_config('qorpera_test.mh_blank_html', pg_temp.mh_received(4, 'alerts.base@mail.example.test',
	jsonb_build_object('messageId', '<mh4@example.org>', 'text', 'Only text',
		'html', E'  \n\t '))::text, true) \g /dev/null

select set_config('qorpera_test.mh_account', pg_temp.mh_received(5, 'alerts.base+github@mail.example.test',
	jsonb_build_object('messageId', '<mh5@example.org>', 'text', null,
		'html', '<p>Your code is 998877</p>'))::text, true) \g /dev/null

select set_config('qorpera_test.mh_cleared', pg_temp.mh_received(6, 'alerts.base@mail.example.test',
	jsonb_build_object('messageId', '<mh6@example.org>', 'text', null,
		'html', '<p>Gone soon</p>'))::text, true) \g /dev/null
update public.qorpera_event_deliveries set body = null where id = current_setting('qorpera_test.mh_cleared')::uuid;

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');

select pg_temp.base_assert(
		msg ->> 'html' like '<!doctype html>%<b>Secret exposed</b>%'
		and not msg ? 'text'
		and not msg ? 'htmlTruncated'
		and (msg ->> 'textCleared')::boolean = false,
	'HTML-only message returns html without text: ' || msg::text)
from (select pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_html_only')::uuid)) as msg) as one;

select pg_temp.base_assert(
		listed ->> 'snippet' = 'Secret exposed & rotated — check now.',
	'HTML-only thread derives a clean text snippet from html: ' || coalesce(listed::text, 'null'))
from (select pg_temp.mh_listed(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_html_only')::uuid)) as listed) as one;

select pg_temp.base_assert(
		msg ->> 'text' = 'Plain version first.'
		and msg ->> 'html' = '<p>Rich <strong>HTML</strong> version.</p>'
		and listed ->> 'snippet' = 'Plain version first.',
	'Multipart message returns both text and html and keeps text snippet: ' || msg::text || ' ' || listed::text)
from (select pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_both')::uuid)) as msg,
	pg_temp.mh_listed(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_both')::uuid)) as listed) as one;

select pg_temp.base_assert(
		msg ->> 'html' = '<p>Cut off start</p>'
		and (msg ->> 'htmlTruncated')::boolean = true,
	'Truncated delivery marks htmlTruncated true: ' || msg::text)
from (select pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_truncated')::uuid)) as msg) as one;

select pg_temp.base_assert(
		msg ->> 'text' = 'Only text'
		and not msg ? 'html'
		and not msg ? 'htmlTruncated',
	'Whitespace-only html is omitted: ' || msg::text)
from (select pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_blank_html')::uuid)) as msg) as one;

select pg_temp.base_assert(
		msg ? 'account'
		and not msg ? 'html'
		and not msg ? 'htmlTruncated'
		and not msg ? 'text'
		and not listed ? 'snippet',
	'Account mail never exposes html or html snippet: ' || msg::text || ' ' || listed::text)
from (select pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_account')::uuid)) as msg,
	pg_temp.mh_listed(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_account')::uuid)) as listed) as one;

select pg_temp.base_assert(
		not msg ? 'html'
		and (msg ->> 'textCleared')::boolean = true
		and not listed ? 'snippet',
	'Cleared body exposes no html and no snippet: ' || msg::text || ' ' || listed::text)
from (select pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_cleared')::uuid)) as msg,
	pg_temp.mh_listed(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_cleared')::uuid)) as listed) as one;

select pg_temp.base_assert(
		public.qorpera_mail_html_snippet('<style>a{color:red}</style><script>alert(1)</script><p>Hello &lt;world&gt; &amp;lt;ok</p>') = 'Hello <world> &lt;ok'
		and public.qorpera_mail_html_snippet('<style>unclosed css forever') is null
		and public.qorpera_mail_html_snippet('   ') is null
		and public.qorpera_mail_html_snippet(null) is null,
	'HTML snippet helper strips tags, styles, scripts, unclosed style, and decodes entities safely');

select pg_temp.base_assert(
		not has_function_privilege(role, 'public.qorpera_mail_html_snippet(text)', 'EXECUTE')
		and not has_function_privilege(role, 'public.qorpera_mail_thread_snippet(text)', 'EXECUTE'),
	'Mail html snippet helpers are closed to ' || role)
from (values ('anon'), ('authenticated'), ('service_role'), ('qorpera_secret_broker')) as roles(role);

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(
		pg_temp.mh_message(pg_temp.mh_thread_of(current_setting('qorpera_test.mh_html_only')::uuid)) ? 'html',
	'A viewer reads received html');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error($q$select public.qorpera_member_mail_thread('92400000-0000-4000-8000-000000000020', pg_temp.mh_thread_of(current_setting('qorpera_test.mh_html_only')::uuid), null)$q$,
	'42501', 'Company mail is unavailable');

-- @fixture 732_runtime_company_mailboxes.test.sql until "-- The company's hourly budget holds for mail."
-- Company mail, sending: step M2b (20260929680000): an agent run queues an email from a live mailbox of its company,
-- as the agent ("<agent> at <company>"), in plain text with the AI line, and a reply joins the received email's
-- thread; sending has its own switch and the company's limits; the worker's door claims a batch with a lease, sends
-- from the mailbox's current address and completes or fails each; mail from a removed or paused mailbox, of a company
-- being deleted, or waiting a day is not sent; texts are cleared seven days after they settle.

-- A send by the fixture's live agent run (company 010, agent "Agent"), which acknowledged its wake.
create function pg_temp.send(p_call text, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_send_agent_mail(current_setting('qorpera_test.routine_binding')::jsonb, p_call, p_request)
$$;
create function pg_temp.send_error(p_call text, p_request jsonb, p_state text) returns void language sql as $$
	select pg_temp.wake_error(format('select pg_temp.send(%L, %L::jsonb)', p_call, p_request), p_state)
$$;
create function pg_temp.outbox(p_receipt jsonb) returns public.qorpera_company_mail_outbox language sql as $$
	select * from public.qorpera_company_mail_outbox where id = (p_receipt ->> 'mailId')::uuid
$$;
create function pg_temp.request(p_from text default 'support@mail.example.test', p_extra jsonb default '{}')
returns jsonb language sql as $$
	select jsonb_build_object('from', p_from, 'to', jsonb_build_array('customer@example.org'), 'subject', 'Hello',
		'text', 'Thanks for writing.') || p_extra
$$;
create function pg_temp.received(p_n integer, p_to text, p_message jsonb) returns uuid language sql as $$
	select (public.qorpera_receive_mail(pg_temp.mail_id(p_n), array[p_to], (jsonb_build_object('schema', 'qorpera.mail/v1',
		'emailId', pg_temp.mail_id(p_n), 'subject', 'Refund', 'from', 'Customer <customer@example.org>') || p_message)::text)
		#>> '{results,0,deliveryId}')::uuid
$$;

-- Privileges: the outbox is closed; the agents' door and the worker's are service_role's alone.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_company_mail_outbox', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'The mail outbox is exposed to %', v_role; end if;
		foreach v_function in array array['public.qorpera_mail_display_name(text,text)',
			'public.qorpera_agent_mail_receipt(public.qorpera_company_mail_outbox,boolean)'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_send_agent_mail(jsonb,text,jsonb)',
		'public.qorpera_claim_company_mail(integer,uuid)', 'public.qorpera_complete_company_mail(uuid,uuid,text)',
		'public.qorpera_fail_company_mail(uuid,uuid,text,boolean)'] loop
		foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
		if not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% lost its caller', v_function; end if;
	end loop;
	if (select sending or company_hourly_sends <> 30 or company_daily_sends <> 200 from public.qorpera_mail_settings) then
		raise exception 'Sending was not built switched off with its limits'; end if;
end
$$;

-- Switched off, nothing is queued.
select pg_temp.send_error('off', pg_temp.request(), '0A000');
update public.qorpera_mail_settings set sending = true;
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_company_mail_outbox), 'Nothing was queued while off');

-- Requests: closed shapes, plain addresses, one-line subjects, bounded recipients and text.
select pg_temp.send_error('invalid-' || n, request, '22023')
from unnest(array[
	'{}'::jsonb,
	pg_temp.request() - 'to',
	pg_temp.request() - 'text',
	pg_temp.request(p_extra => '{"to":[]}'),
	pg_temp.request(p_extra => jsonb_build_object('to', (select jsonb_agg('c' || n || '@example.org')
		from generate_series(1, 11) as n))),
	pg_temp.request(p_extra => jsonb_build_object('to', (select jsonb_agg('c' || n || '@example.org')
		from generate_series(1, 10) as n), 'cc', jsonb_build_array('boss@example.org'))),
	pg_temp.request(p_extra => '{"to":["not-an-address"]}'),
	pg_temp.request(p_extra => '{"to":["Customer <customer@example.org>"]}'),
	pg_temp.request(p_extra => '{"to":["customer@localhost"]}'),
	pg_temp.request(p_extra => '{"to":"customer@example.org"}'),
	pg_temp.request(p_extra => '{"cc":"boss@example.org"}'),
	pg_temp.request(p_extra => '{"bcc":["boss@example.org"]}'),
	pg_temp.request(p_extra => jsonb_build_object('subject', E'Hello\r\nBcc: everyone@example.org')),
	pg_temp.request(p_extra => '{"subject":""}'),
	pg_temp.request(p_extra => '{"subject":"   "}'),
	pg_temp.request(p_extra => jsonb_build_object('subject', repeat('s', 201))),
	pg_temp.request(p_extra => jsonb_build_object('text', E' \n\t')),
	pg_temp.request(p_extra => jsonb_build_object('text', repeat('t', 20001))),
	pg_temp.request(p_extra => '{"inReplyTo":"not-a-delivery"}'),
	pg_temp.request(p_extra => '{"from":7}')
]) with ordinality as item(request, n);
select pg_temp.send_error('', pg_temp.request(), '22023');

-- The mailbox: this company's, live, on the platform's domain.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('30000000-0000-4000-8000-0000000007a0',
	'30000000-0000-4000-8000-0000000007a1', 'theirs', 'Another company''s mailbox');
select pg_temp.path_claims('service_role');
select pg_temp.send_error('from-' || n, pg_temp.request(address), '42501')
from unnest(array['sales@mail.example.test', 'support@elsewhere.example', 'support@sub.mail.example.test',
	'support@mail.example.test@mail.example.test', 'theirs@mail.example.test', 'theirs']) with ordinality as item(address, n);

-- An email, as the agent, with the AI line; addresses once each, lowercased, and none in both to and cc.
select set_config('qorpera_test.sent', pg_temp.send('call-1', jsonb_build_object('from', 'Support@Mail.Example.Test',
	'to', jsonb_build_array(' Customer@Example.org ', 'customer@example.org', 'second@example.org'),
	'cc', jsonb_build_array('second@example.org', 'boss@example.org'), 'subject', ' Your order ',
	'text', E'Hello,\n\nYour order ships today.\n\n'))::text, true);
select pg_temp.wake_assert(current_setting('qorpera_test.sent')::jsonb - 'mailId' = jsonb_build_object(
		'schema', 'qorpera.agent-mail/v1', 'runId', current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId',
		'status', 'queued', 'from', 'support@mail.example.test', 'fromName', 'Agent at Path gateway fixture',
		'to', jsonb_build_array('customer@example.org', 'second@example.org'), 'cc', jsonb_build_array('boss@example.org'),
		'subject', 'Your order'),
	'The receipt names the email as queued: ' || current_setting('qorpera_test.sent'));
select pg_temp.wake_assert(mail.body = E'Hello,\n\nYour order ships today.\n\n-- \n'
		|| 'Written and sent by Agent, an AI agent working for Path gateway fixture.'
		and mail.status = 'pending' and mail.staff_agent_id = '30000000-0000-4000-8000-000000000030'
		and mail.profile_id = '30000000-0000-4000-8000-000000000010' and mail.in_reply_to is null
		and mail.mailbox_id = (select id from public.qorpera_company_mailboxes where hook_id = current_setting('qorpera_test.mail_hook')::uuid),
	'The text ends with the AI line: ' || mail.body)
from pg_temp.outbox(current_setting('qorpera_test.sent')::jsonb) as mail;
-- The same call again is the same email, whatever it asks now.
select pg_temp.wake_assert(pg_temp.send('call-1', pg_temp.request()) ->> 'mailId' = current_setting('qorpera_test.sent')::jsonb ->> 'mailId'
	and (select count(*) = 1 from public.qorpera_company_mail_outbox), 'A repeated call queues nothing more');
-- The agent's and company's names as a header can carry them.
update public.qorpera_profile_staff set display_name = E'Ada "the"\n<Bot>\\'
where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000030';
select set_config('qorpera_test.named', pg_temp.send('call-2', pg_temp.request('support'))::text, true);
select pg_temp.wake_assert(current_setting('qorpera_test.named')::jsonb ->> 'fromName' = 'Ada the Bot at Path gateway fixture'
	and (pg_temp.outbox(current_setting('qorpera_test.named')::jsonb)).body
		like E'%\n-- \nWritten and sent by Ada the Bot, an AI agent working for Path gateway fixture.',
	'Names lose quotes, brackets and line breaks: ' || current_setting('qorpera_test.named'));

-- A reply joins the received email's thread: its message id, and the references before it.
select set_config('qorpera_test.question', pg_temp.received(30, 'support@mail.example.test', jsonb_build_object(
	'messageId', '<m30@example.org>', 'references', E'<m1@example.org>\n <m2@example.org>', 'text', 'Please refund.'))::text, true);
select set_config('qorpera_test.reply', pg_temp.send('call-3', pg_temp.request(p_extra => jsonb_build_object(
	'subject', 'Re: Refund', 'inReplyTo', upper(current_setting('qorpera_test.question')))))::text, true);
select pg_temp.wake_assert(current_setting('qorpera_test.reply')::jsonb ->> 'inReplyTo' = current_setting('qorpera_test.question')
	and (current_setting('qorpera_test.reply')::jsonb ->> 'threaded')::boolean
	and mail.in_reply_to = '<m30@example.org>' and mail.thread_references = '<m1@example.org> <m2@example.org> <m30@example.org>'
	and mail.in_reply_to_delivery_id = current_setting('qorpera_test.question')::uuid,
	'The reply carries the thread: ' || current_setting('qorpera_test.reply'))
from pg_temp.outbox(current_setting('qorpera_test.reply')::jsonb) as mail;
-- A message id without its brackets gets them; one with a line break, or none at all, leaves the reply unthreaded.
select pg_temp.wake_assert(mail.in_reply_to = '<m31@example.org>' and mail.thread_references = '<m31@example.org>',
	'A bare message id is bracketed: ' || coalesce(mail.in_reply_to, 'null'))
from pg_temp.outbox(pg_temp.send('call-4', pg_temp.request(p_extra => jsonb_build_object('inReplyTo',
	pg_temp.received(31, 'support@mail.example.test', '{"messageId":"m31@example.org"}'))))) as mail;
select pg_temp.wake_assert(not (receipt ->> 'threaded')::boolean and (pg_temp.outbox(receipt)).in_reply_to is null
		and (pg_temp.outbox(receipt)).thread_references is null, 'No usable message id, no thread: ' || receipt::text)
from unnest(array[
	pg_temp.send('call-5', pg_temp.request(p_extra => jsonb_build_object('inReplyTo',
		pg_temp.received(32, 'support@mail.example.test', jsonb_build_object('messageId', E'<m32@example.org>\r\nBcc: x@example.org'))))),
	pg_temp.send('call-6', pg_temp.request(p_extra => jsonb_build_object('inReplyTo',
		pg_temp.received(33, 'support@mail.example.test', '{}'))))
]) as receipt;
-- An email whose text was cleared is still answered, outside its thread.
update public.qorpera_event_deliveries set body = null where id = current_setting('qorpera_test.question')::uuid;
select pg_temp.wake_assert(not (pg_temp.send('call-7', pg_temp.request(p_extra => jsonb_build_object('inReplyTo',
	current_setting('qorpera_test.question')))) ->> 'threaded')::boolean, 'A cleared email is answered unthreaded');
-- Only a received email of this company: not another company's, not another hook's event, not an unknown id.
select pg_temp.wake_assert(pg_temp.post('{"form":"contact"}') = 'accepted', 'A form post arrives');
select pg_temp.send_error('reply-' || n, pg_temp.request(p_extra => jsonb_build_object('inReplyTo', delivery)), '42501')
from unnest(array[
	pg_temp.received(34, 'theirs@mail.example.test', '{"messageId":"<m34@example.org>"}'),
	(select id from public.qorpera_event_deliveries where hook_id = '30000000-0000-4000-8000-0000000007b1'
		and status = 'verified' order by received_at desc limit 1),
	extensions.gen_random_uuid()
]) with ordinality as item(delivery, n);

-- A paused mailbox, a company being deleted and a finished run send nothing.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status(current_setting('qorpera_test.mail_hook')::uuid, 'paused');
select pg_temp.path_claims('service_role');
select pg_temp.send_error('paused', pg_temp.request(), '0A000');
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status(current_setting('qorpera_test.mail_hook')::uuid, 'active');
select pg_temp.path_claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001');
select pg_temp.send_error('deleting', pg_temp.request(), '55000');
delete from public.qorpera_company_deletions where profile_id = '30000000-0000-4000-8000-000000000010';
select pg_temp.wake_error(format('select public.qorpera_send_agent_mail(%L::jsonb, %L, %L::jsonb)',
	current_setting('qorpera_test.event_binding'), 'finished', pg_temp.request()), '42501');

-- The company's limits: an hour's and a day's, with the time room returns.
update public.qorpera_mail_settings set company_hourly_sends = (select count(*) from public.qorpera_company_mail_outbox
	where profile_id = '30000000-0000-4000-8000-000000000010');
do $$
begin
	perform pg_temp.send('limited-hour', pg_temp.request());
	raise exception 'The hourly limit let an email through';
exception when program_limit_exceeded then
	if sqlerrm not like 'The company has sent the % emails an hour and 200 a day its limits allow; try again after %Z' then
		raise; end if;
end
$$;
update public.qorpera_mail_settings set company_hourly_sends = 30, company_daily_sends = 1;
select pg_temp.send_error('limited-day', pg_temp.request(), '54000');
-- Cancelled email never went out and does not count.
update public.qorpera_mail_settings set company_daily_sends = (select count(*) + 1 from public.qorpera_company_mail_outbox
	where profile_id = '30000000-0000-4000-8000-000000000010');
select pg_temp.send('to-cancel', pg_temp.request());
update public.qorpera_company_mail_outbox set status = 'cancelled', settled_at = clock_timestamp() where call_id = 'to-cancel';
select pg_temp.wake_assert(pg_temp.send('after-cancel', pg_temp.request()) ->> 'status' = 'queued',
	'A cancelled email frees its place');
update public.qorpera_mail_settings set company_daily_sends = 200;

-- The worker's door. Switched off, it claims nothing and queued email waits.
update public.qorpera_mail_settings set sending = false;
select pg_temp.wake_assert(public.qorpera_claim_company_mail(10, '73300000-0000-4000-8000-000000000001') = '[]'::jsonb
	and not exists (select 1 from public.qorpera_company_mail_outbox where status not in ('pending', 'cancelled')),
	'Switched off, nothing is claimed');
update public.qorpera_mail_settings set sending = true;
select pg_temp.wake_error($q$select public.qorpera_claim_company_mail(0, '73300000-0000-4000-8000-000000000001')$q$, '22023');
select pg_temp.wake_error($q$select public.qorpera_claim_company_mail(51, '73300000-0000-4000-8000-000000000001')$q$, '22023');
select pg_temp.wake_error($q$select public.qorpera_claim_company_mail(10, null)$q$, '22023');
-- Mail waiting a day is not sent; mail from a removed or paused mailbox, or of a company being deleted, is cancelled.
update public.qorpera_company_mail_outbox set created_at = clock_timestamp() - interval '25 hours'
where id = (pg_temp.outbox(current_setting('qorpera_test.named')::jsonb)).id;
select set_config('qorpera_test.from_removed', pg_temp.send('from-a.b', pg_temp.request('a.b'))::text, true);
select set_config('qorpera_test.from_paused', pg_temp.send('from-a_b', pg_temp.request('a_b'))::text, true);
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'a.b' and removed_at is null), 'removed');
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'a_b' and removed_at is null), 'paused');
select pg_temp.path_claims('service_role');
-- The domain moved since they were queued: they go out from the mailbox's current address.
update public.qorpera_mail_settings set domain = 'test-1234.resend.app';
select set_config('qorpera_test.claim', public.qorpera_claim_company_mail(50, '73300000-0000-4000-8000-000000000001')::text, true);
select pg_temp.wake_assert(status = 'failed' and last_error = 'Not sent within a day' and settled_at is not null,
	'Mail waiting a day is not sent: ' || status)
from pg_temp.outbox(current_setting('qorpera_test.named')::jsonb);
select pg_temp.wake_assert(status = 'cancelled' and last_error = 'The mailbox was removed', 'Removed: ' || status)
from pg_temp.outbox(current_setting('qorpera_test.from_removed')::jsonb);
select pg_temp.wake_assert(status = 'cancelled' and last_error = 'The mailbox was paused', 'Paused: ' || status)
from pg_temp.outbox(current_setting('qorpera_test.from_paused')::jsonb);
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.claim')::jsonb) = (select count(*)
		from public.qorpera_company_mail_outbox where status = 'delivering'
			and lease_id = '73300000-0000-4000-8000-000000000001' and attempt_count = 1)
	and not exists (select 1 from public.qorpera_company_mail_outbox where status in ('pending', 'retrying')),
	'Every open email is claimed under the lease: ' || current_setting('qorpera_test.claim'));
select pg_temp.wake_assert(job - 'leaseId' = jsonb_build_object('mailId', current_setting('qorpera_test.sent')::jsonb ->> 'mailId',
		'attemptCount', 1, 'from', '"Agent at Path gateway fixture" <support@test-1234.resend.app>',
		'to', jsonb_build_array('customer@example.org', 'second@example.org'), 'cc', jsonb_build_array('boss@example.org'),
		'subject', 'Your order', 'text', E'Hello,\n\nYour order ships today.\n\n-- \n'
			|| 'Written and sent by Agent, an AI agent working for Path gateway fixture.', 'headers', '{}'::jsonb),
	'A job is the email as the provider takes it: ' || job::text)
from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as item(job)
where job ->> 'mailId' = current_setting('qorpera_test.sent')::jsonb ->> 'mailId';
select pg_temp.wake_assert(job -> 'headers' = jsonb_build_object('In-Reply-To', '<m30@example.org>',
		'References', '<m1@example.org> <m2@example.org> <m30@example.org>'), 'A reply carries its thread headers: ' || job::text)
from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as item(job)
where job ->> 'mailId' = current_setting('qorpera_test.reply')::jsonb ->> 'mailId';
-- Leased email is not claimed again.
select pg_temp.wake_assert(public.qorpera_claim_company_mail(50, '73300000-0000-4000-8000-000000000002') = '[]'::jsonb,
	'Leased email is not claimed twice');
-- Completing and failing hold the lease.
select pg_temp.wake_assert(not public.qorpera_complete_company_mail((current_setting('qorpera_test.sent')::jsonb ->> 'mailId')::uuid,
		'73300000-0000-4000-8000-000000000002', 'provider-1')
	and public.qorpera_complete_company_mail((current_setting('qorpera_test.sent')::jsonb ->> 'mailId')::uuid,
		'73300000-0000-4000-8000-000000000001', 'provider-1')
	and not public.qorpera_complete_company_mail((current_setting('qorpera_test.sent')::jsonb ->> 'mailId')::uuid,
		'73300000-0000-4000-8000-000000000001', 'provider-1'),
	'Only the lease completes an email, once');
select pg_temp.wake_assert(status = 'sent' and provider_message_id = 'provider-1' and settled_at is not null
		and lease_id is null and pg_temp.send('call-1', '{}') ->> 'status' = 'sent', 'The email is sent: ' || status)
from pg_temp.outbox(current_setting('qorpera_test.sent')::jsonb);
select pg_temp.wake_assert(public.qorpera_fail_company_mail((current_setting('qorpera_test.reply')::jsonb ->> 'mailId')::uuid,
	'73300000-0000-4000-8000-000000000001', 'Resend returned HTTP 503', true), 'A retryable failure is recorded');
select pg_temp.wake_assert(status = 'retrying' and settled_at is null and last_error = 'Resend returned HTTP 503'
		and next_attempt_at between clock_timestamp() + interval '50 seconds' and clock_timestamp() + interval '70 seconds',
	'A retryable failure waits a minute: ' || status)
from pg_temp.outbox(current_setting('qorpera_test.reply')::jsonb);
select pg_temp.wake_assert(public.qorpera_fail_company_mail(id, '73300000-0000-4000-8000-000000000001',
	'The recipient address is invalid', false), 'A permanent failure is recorded')
from public.qorpera_company_mail_outbox where call_id = 'call-4';
select pg_temp.wake_assert(status = 'failed' and settled_at is not null, 'A permanent failure fails the email: ' || status)
from public.qorpera_company_mail_outbox where call_id = 'call-4';
-- A worker that did not finish gives its lease up in five minutes; after eight attempts the email fails.
update public.qorpera_company_mail_outbox set lease_expires_at = clock_timestamp() - interval '1 second'
where call_id in ('call-5', 'call-6');
update public.qorpera_company_mail_outbox set attempt_count = 8, last_error = 'Resend returned HTTP 500'
where call_id = 'call-6';
update public.qorpera_company_mail_outbox set next_attempt_at = clock_timestamp() where call_id = 'call-3';
select set_config('qorpera_test.claim', public.qorpera_claim_company_mail(50, '73300000-0000-4000-8000-000000000003')::text, true);
select pg_temp.wake_assert((select array_agg(job ->> 'mailId' order by job ->> 'mailId')
		from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as item(job))
	= (select array_agg(id::text order by id::text) from public.qorpera_company_mail_outbox where call_id in ('call-3', 'call-5'))
	and (select attempt_count = 2 and status = 'delivering' from public.qorpera_company_mail_outbox where call_id = 'call-5')
	and (select status = 'failed' and last_error = 'Resend returned HTTP 500' from public.qorpera_company_mail_outbox
		where call_id = 'call-6'),
	'An expired lease is claimed again, and the eighth attempt was the last: ' || current_setting('qorpera_test.claim'));
-- A company being deleted sends nothing more.
select public.qorpera_fail_company_mail(id, '73300000-0000-4000-8000-000000000003', 'Resend returned HTTP 429', true)
from public.qorpera_company_mail_outbox where call_id = 'call-5';
update public.qorpera_company_mail_outbox set next_attempt_at = clock_timestamp() where call_id = 'call-5';
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_claim_company_mail(50, '73300000-0000-4000-8000-000000000004') = '[]'::jsonb,
	'A company being deleted sends nothing more');
select pg_temp.wake_assert(status = 'cancelled' and last_error = 'The company is being deleted',
	'Its queued email is cancelled: ' || status)
from public.qorpera_company_mail_outbox where call_id = 'call-5';
delete from public.qorpera_company_deletions where profile_id = '30000000-0000-4000-8000-000000000010';

-- Texts are cleared seven days after they settle; the receipt stays.
update public.qorpera_company_mail_outbox set settled_at = clock_timestamp() - interval '8 days' where call_id = 'call-1';
select public.qorpera_claim_company_mail(1, '73300000-0000-4000-8000-000000000005');
select pg_temp.wake_assert((select body is null from public.qorpera_company_mail_outbox where call_id = 'call-1')
	and (select body is not null from public.qorpera_company_mail_outbox where call_id = 'call-4')
	and pg_temp.send('call-1', '{}') ->> 'subject' = 'Your order', 'A settled text is cleared after seven days');

-- Once the run has given its final answer, it does no more work, email included.
select pg_temp.wake_public_send(current_setting('qorpera_test.routine_binding')::jsonb, 'final', 'mail-final');
select pg_temp.wake_error(format('select pg_temp.send(%L, %L::jsonb)', 'after-final', pg_temp.request()), '55000',
	'Wake public output is already final');

rollback;

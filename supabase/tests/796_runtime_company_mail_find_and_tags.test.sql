-- @fixture 733_runtime_company_mail_sending.test.sql until "-- Switched off, nothing is queued."
-- Company mail for accounts the company owns (20260929999920): local+tag@ reaches the mailbox local@ and the
-- delivery records where the mail was delivered, its sender and its subject; an agent never mails its own company's
-- mailboxes under a tag, nor sends from one; find_mail searches the company's received mail of the last days by
-- mailbox, delivered-to address, sender and subject, at most 10 newest first.

create function pg_temp.find(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_find_agent_mail(current_setting('qorpera_test.routine_binding')::jsonb, p_request)
$$;
create function pg_temp.find_error(p_request jsonb, p_state text, p_message text default null) returns void
language sql as $$
	select pg_temp.wake_error(format('select pg_temp.find(%L::jsonb)', p_request), p_state, p_message)
$$;
-- The delivery ids a search found, in order.
create function pg_temp.found(p_request jsonb) returns uuid[] language sql as $$
	select coalesce(array_agg((mail.value ->> 'deliveryId')::uuid order by mail.place), '{}')
	from jsonb_array_elements(pg_temp.find(p_request) -> 'mails') with ordinality as mail(value, place)
$$;
create function pg_temp.delivery(p_id uuid) returns public.qorpera_event_deliveries language sql as $$
	select * from public.qorpera_event_deliveries where id = p_id
$$;
select pg_temp.path_claims('service_role');

-- Privileges: the agents' door is service_role's alone; the helpers nobody's.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_find_agent_mail(jsonb,jsonb)', 'EXECUTE') then
			raise exception 'find_mail is exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('service_role', 'public.qorpera_find_agent_mail(jsonb,jsonb)', 'EXECUTE') then
		raise exception 'find_mail lost its caller'; end if;
	if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_find_agent_mail' and scope = 'binding') then
		raise exception 'The native host cannot reach find_mail'; end if;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_mail_box_part(text)',
			'public.qorpera_mail_header_value(text,integer)',
			'public.qorpera_mail_delivery_headers(text[],text,text,jsonb)'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
	end loop;
end
$$;

-- The mailbox an address reaches: its local part, or the part before a tag of 1-64 letters, digits, dots, hyphens
-- and underscores.
select pg_temp.wake_assert(public.qorpera_mail_box_part(address) is not distinct from mailbox,
	format('%s reaches %s, not %s', address, coalesce(mailbox, 'nothing'), public.qorpera_mail_box_part(address)))
from (values
	('support@mail.example.test', 'support'), ('support+stripe@mail.example.test', 'support'),
	(' Support+Stripe@Mail.Example.Test ', 'support'), ('support+a.b_c-9@mail.example.test', 'support'),
	('support+' || repeat('t', 64) || '@mail.example.test', 'support'),
	('support+' || repeat('t', 65) || '@mail.example.test', null), ('support+@mail.example.test', null),
	('support+has space@mail.example.test', null), ('support+a+b@mail.example.test', null),
	('support+caf' || chr(233) || '@mail.example.test', null), ('no-at-sign', null)
) as item(address, mailbox);

-- A message to tagged addresses is stored once in their mailbox, recording every address that reached it; a bad tag
-- reaches nothing.
select set_config('qorpera_test.tagged', pg_temp.mail(pg_temp.mail_id(400), array['Support+Stripe@mail.example.test',
	'support+billing@mail.example.test', 'a.b+x@mail.example.test', 'support+bad tag@mail.example.test',
	'customer@example.org', 'support+stripe@elsewhere.example'], 'Confirm your Stripe account')::text, true);
select pg_temp.wake_assert((select array_agg(item ->> 'recipient' || ':' || (item ->> 'outcome') order by item ->> 'recipient')
		from jsonb_array_elements(current_setting('qorpera_test.tagged')::jsonb -> 'results') as item)
	= array['a.b+x@mail.example.test:accepted', 'support+bad tag@mail.example.test:unknown',
		'support+billing@mail.example.test:accepted', 'support+stripe@mail.example.test:duplicate'],
	'Tags reach their mailbox once: ' || current_setting('qorpera_test.tagged'));
select set_config('qorpera_test.stripe_mail', (select item ->> 'deliveryId'
	from jsonb_array_elements(current_setting('qorpera_test.tagged')::jsonb -> 'results') as item
	where item ->> 'recipient' = 'support+billing@mail.example.test'), true);
select set_config('qorpera_test.ab_mail', (select item ->> 'deliveryId'
	from jsonb_array_elements(current_setting('qorpera_test.tagged')::jsonb -> 'results') as item
	where item ->> 'recipient' = 'a.b+x@mail.example.test'), true);
select pg_temp.wake_assert((select headers = jsonb_build_object(
		'delivered-to', 'support+billing@mail.example.test, support+stripe@mail.example.test',
		'from', 'customer@example.org', 'subject', 'Confirm your Stripe account')
		from pg_temp.delivery(current_setting('qorpera_test.stripe_mail')::uuid))
	and (select headers ->> 'delivered-to' = 'a.b+x@mail.example.test'
		from pg_temp.delivery(current_setting('qorpera_test.ab_mail')::uuid)),
	'The delivery records the addresses that reached its mailbox, the sender and the subject');
-- Untagged mail records its address too; a message without a sender or a subject records neither.
select set_config('qorpera_test.plain_mail', (public.qorpera_receive_mail(pg_temp.mail_id(401),
	array['support@mail.example.test'], '{"schema":"qorpera.mail/v1","subject":null}') #>> '{results,0,deliveryId}'), true);
select pg_temp.wake_assert((select headers = '{"delivered-to": "support@mail.example.test"}'::jsonb
		from pg_temp.delivery(current_setting('qorpera_test.plain_mail')::uuid)),
	'A mail without a sender or subject records only where it was delivered');

-- Plus addresses only receive, and a company's own mailboxes are never recipients under a tag.
update public.qorpera_mail_settings set sending = true;
select pg_temp.send_error('own-tag-' || n, request, '42501')
from unnest(array[
	pg_temp.request(p_extra => '{"to":["support+stripe@mail.example.test"]}'),
	pg_temp.request(p_extra => '{"cc":["A.B+anything@Mail.Example.Test"]}'),
	pg_temp.request('support+stripe@mail.example.test')
]) with ordinality as item(request, n);
select pg_temp.wake_assert(pg_temp.send('outside-tag', pg_temp.request(p_extra =>
		'{"to":["customer+orders@example.org"]}')) ->> 'status' = 'queued',
	'Mail to a tagged address outside the company is mail');

-- find_mail: closed request shapes, and since as an ISO instant with its offset.
select pg_temp.find_error(request, '22023', 'Mail search is invalid')
from unnest(array['[]'::jsonb, '{"folder":"x"}', '{"from":42}', '{"from":""}', '{"mailbox":"ab"}',
	jsonb_build_object('mailbox', repeat('m', 321)), jsonb_build_object('subject', repeat('s', 201)),
	jsonb_build_object('to', repeat('t', 321)), '{"to":"ab"}', '{"since":"2026-10-02T10:00:00"}',
	'{"since":"yesterday Z"}', '{"since":"Oct 2 2026T10:00Z"}', '{"since":"soon"}',
	jsonb_build_object('from', 'a' || chr(10) || 'b')]) as request;
select pg_temp.find_error('{"since":"2026-13-45T10:00Z"}', '22023',
	'Mail search is invalid: since and before are instants with their offsets');
-- Only this company's mailboxes, by their address.
select pg_temp.find_error(jsonb_build_object('mailbox', address), '22023')
from unnest(array['sales@mail.example.test', 'support@elsewhere.example', 'support+stripe@mail.example.test']) as address;

-- What it finds: newest first, each with its mailbox, the delivered-to addresses, sender, subject and arrival.
select pg_temp.wake_assert(pg_temp.find('{"to":"support+stripe@mail.example.test"}') -> 'mails' = jsonb_build_array(
		jsonb_build_object('deliveryId', current_setting('qorpera_test.stripe_mail'), 'mailbox', 'support@mail.example.test',
			'deliveredTo', jsonb_build_array('support+billing@mail.example.test', 'support+stripe@mail.example.test'),
			'from', 'customer@example.org', 'subject', 'Confirm your Stripe account',
			'receivedAt', (pg_temp.delivery(current_setting('qorpera_test.stripe_mail')::uuid)).received_at))
	and pg_temp.find('{"to":"support+stripe@mail.example.test"}') ->> 'schema' = 'qorpera.agent-mail-search/v1'
	and pg_temp.find('{"to":"support+stripe@mail.example.test"}') ->> 'more' = 'false'
	and pg_temp.find('{}') ->> 'runId' = current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId',
	'A search by a tagged address: ' || pg_temp.find('{"to":"support+stripe@mail.example.test"}')::text);
select pg_temp.wake_assert(pg_temp.found('{"to":" Support+Billing@Mail.Example.Test "}')
		= array[current_setting('qorpera_test.stripe_mail')::uuid]
	and not (current_setting('qorpera_test.stripe_mail')::uuid = any (pg_temp.found('{"to":"support@mail.example.test"}')))
	and current_setting('qorpera_test.plain_mail')::uuid = any (pg_temp.found('{"to":"support@mail.example.test"}')),
	'An address finds the mail delivered to it, tag and all');
select pg_temp.wake_assert((pg_temp.found('{"mailbox":"A.B@Mail.Example.Test"}'))[1] = current_setting('qorpera_test.ab_mail')::uuid
	and not (current_setting('qorpera_test.stripe_mail')::uuid = any (pg_temp.found('{"mailbox":"A.B@Mail.Example.Test"}')))
	and pg_temp.found('{"from":"CUSTOMER@EXAMPLE","subject":"stripe ACCOUNT"}')
		= array[current_setting('qorpera_test.stripe_mail')::uuid, current_setting('qorpera_test.ab_mail')::uuid]
	and pg_temp.found('{"from":"nobody"}') = '{}' and pg_temp.found('{"subject":"Invoice"}') = '{}',
	'A mailbox, and parts of the sender and subject in any case');
-- since: from then on; by default the last 24 hours, and never more than 7 days back.
select pg_temp.wake_assert(pg_temp.found(jsonb_build_object('since', to_char(clock_timestamp() + interval '1 minute',
		'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) = '{}'
	and current_setting('qorpera_test.stripe_mail')::uuid = any (pg_temp.found('{"since":"2026-01-01T00:00:00+02:00"}'))
	and (pg_temp.find('{"since":"2026-01-01T00:00:00Z"}') ->> 'since')::timestamptz
		between clock_timestamp() - interval '7 days 1 minute' and clock_timestamp() - interval '7 days'
	and (pg_temp.find('{}') ->> 'since')::timestamptz
		between clock_timestamp() - interval '24 hours 1 minute' and clock_timestamp() - interval '24 hours',
	'since bounds the search');
update public.qorpera_event_deliveries set received_at = clock_timestamp() - interval '2 days'
where id = current_setting('qorpera_test.ab_mail')::uuid;
select pg_temp.wake_assert(not (current_setting('qorpera_test.ab_mail')::uuid
		= any (pg_temp.found('{"mailbox":"a.b@mail.example.test"}')))
	and current_setting('qorpera_test.ab_mail')::uuid
		= any (pg_temp.found('{"mailbox":"a.b@mail.example.test","since":"2026-01-01T00:00:00Z"}')),
	'Older mail needs an earlier since');
update public.qorpera_event_deliveries set received_at = clock_timestamp() - interval '8 days'
where id = current_setting('qorpera_test.ab_mail')::uuid;
select pg_temp.wake_assert(not (current_setting('qorpera_test.ab_mail')::uuid
		= any (pg_temp.found('{"mailbox":"a.b@mail.example.test","since":"2026-01-01T00:00:00Z"}'))),
	'Mail older than 7 days is never searched');

-- At most 10, newest first, and more says there are others.
select pg_temp.mail(pg_temp.mail_id(410 + n), 'support+bulk@mail.example.test', 'Bulk ' || n) from generate_series(1, 12) as n;
select pg_temp.wake_assert((select array_agg(mail.value ->> 'subject' order by mail.place)
		from jsonb_array_elements(pg_temp.find('{"to":"support+bulk@mail.example.test"}') -> 'mails')
			with ordinality as mail(value, place))
	= array['Bulk 12', 'Bulk 11', 'Bulk 10', 'Bulk 9', 'Bulk 8', 'Bulk 7', 'Bulk 6', 'Bulk 5', 'Bulk 4', 'Bulk 3']
	and pg_temp.find('{"to":"support+bulk@mail.example.test"}') ->> 'more' = 'true'
	and pg_temp.find('{"to":"support+bulk@mail.example.test","subject":"Bulk 1"}') ->> 'more' = 'false',
	'Ten at most, newest first');

-- What a delivery keeps fits its 8 KiB: control characters become spaces, long values are cut to their share,
-- delivered-to keeps whole addresses, and the mail door's authentication verdicts come along. They count toward
-- the company's hourly bytes.
select set_config('qorpera_test.usage', (select coalesce(sum(bytes), 0)::text from public.qorpera_event_intake_usage
	where profile_id = '30000000-0000-4000-8000-000000000010'), true);
select set_config('qorpera_test.odd_mail', (public.qorpera_receive_mail(pg_temp.mail_id(450),
	(select array_agg('support+' || lpad(n::text, 50, 'x') || '@mail.example.test') from generate_series(1, 40) as n),
	json_build_object('schema', 'qorpera.mail/v1', 'subject', 'Your code' || repeat(chr(1), 900) || 'is 123456',
		'from', repeat(chr(26085), 998), 'authentication', json_build_object('spf', 'pass', 'dkim', 'pass', 'dmarc', 'fail'),
		'text', 'hi')::text) #>> '{results,0,deliveryId}'), true);
select pg_temp.wake_assert((select octet_length(headers::text) <= 8192
		and headers ->> 'subject' = 'Your code is 123456'
		and octet_length(to_jsonb(headers ->> 'from')::text) <= 2048 and headers ->> 'from' like chr(26085) || '%'
		and headers ->> 'authentication-results' = 'spf=pass dkim=pass dmarc=fail'
		and octet_length(headers ->> 'delivered-to') <= 2048
		and (select bool_and(address ~ '^support\+x*[0-9]+@mail\.example\.test$')
			from unnest(string_to_array(headers ->> 'delivered-to', ', ')) as address)
		from pg_temp.delivery(current_setting('qorpera_test.odd_mail')::uuid))
	and (select sum(bytes) from public.qorpera_event_intake_usage where profile_id = '30000000-0000-4000-8000-000000000010')
		= current_setting('qorpera_test.usage')::bigint + (select body_bytes + octet_length(headers::text)
			from pg_temp.delivery(current_setting('qorpera_test.odd_mail')::uuid)),
	'A delivery keeps headers within its limits, and counts them');
select pg_temp.wake_assert((pg_temp.find('{"subject":"code is 123456"}') -> 'mails' -> 0 ->> 'authentication')
		= 'spf=pass dkim=pass dmarc=fail'
	and char_length(pg_temp.find('{"subject":"code is 123456"}') -> 'mails' -> 0 ->> 'from') = 200
	and jsonb_array_length(pg_temp.find('{"subject":"code is 123456"}') -> 'mails' -> 0 -> 'deliveredTo') = 5,
	'An answer carries the authentication verdicts and short sender and recipients');
-- A subject of control characters only keeps no subject.
select pg_temp.wake_assert((select not (headers ? 'subject') and headers ? 'delivered-to' from pg_temp.delivery(
		(public.qorpera_receive_mail(pg_temp.mail_id(451), array['support@mail.example.test'],
			json_build_object('schema', 'qorpera.mail/v1', 'subject', chr(1) || ' ' || chr(2))::text)
			#>> '{results,0,deliveryId}')::uuid)),
	'An empty subject is not kept');
-- An answer keeps what fits the tool's 8 KiB, and says there is more.
select pg_temp.mail(pg_temp.mail_id(460 + n), 'support+big@mail.example.test', repeat(chr(26412), 300))
from generate_series(1, 6) as n;
update public.qorpera_event_deliveries set headers = headers || jsonb_build_object('from', repeat(chr(26085), 300))
where headers ->> 'delivered-to' = 'support+big@mail.example.test';
select pg_temp.wake_assert(jsonb_array_length(pg_temp.find('{"to":"support+big@mail.example.test"}') -> 'mails') between 1 and 5
	and pg_temp.find('{"to":"support+big@mail.example.test"}') ->> 'more' = 'true'
	and octet_length((pg_temp.find('{"to":"support+big@mail.example.test"}') -> 'mails')::text) <= 6100,
	'Large answers are cut to fit: ' || jsonb_array_length(pg_temp.find('{"to":"support+big@mail.example.test"}') -> 'mails'));
-- Characters the answer escapes count for what they cost there, and nextBefore pages to the rest.
select pg_temp.mail(pg_temp.mail_id(490 + n), 'support+lt@mail.example.test', repeat('<', 200)) from generate_series(1, 6) as n;
select pg_temp.wake_assert(jsonb_array_length(pg_temp.find('{"to":"support+lt@mail.example.test"}') -> 'mails') between 1 and 5
	and pg_temp.find('{"to":"support+lt@mail.example.test"}') ->> 'more' = 'true'
	and jsonb_array_length(pg_temp.find(jsonb_build_object('to', 'support+lt@mail.example.test',
		'before', pg_temp.find('{"to":"support+lt@mail.example.test"}') ->> 'nextBefore')) -> 'mails')
		= 6 - jsonb_array_length(pg_temp.find('{"to":"support+lt@mail.example.test"}') -> 'mails'),
	'Escaped characters count, and nextBefore shows the older ones');
select pg_temp.mail(pg_temp.mail_id(500 + n), 'support+quote@mail.example.test', repeat('"', 200)) from generate_series(1, 6) as n;
select pg_temp.wake_assert(jsonb_array_length(pg_temp.find('{"to":"support+quote@mail.example.test"}') -> 'mails') between 1 and 5
	and pg_temp.find('{"to":"support+quote@mail.example.test"}') ->> 'more' = 'true',
	'Quotes count for their escapes too');
-- The two line separators, should one be kept: 3 bytes each, 6 in the answer.
select pg_temp.mail(pg_temp.mail_id(510 + n), 'support+line@mail.example.test', 'Line ' || n) from generate_series(1, 6) as n;
update public.qorpera_event_deliveries set headers = headers || jsonb_build_object('subject', repeat(chr(8232), 100) || repeat(chr(8233), 100))
where headers ->> 'delivered-to' = 'support+line@mail.example.test';
select pg_temp.wake_assert(jsonb_array_length(pg_temp.find('{"to":"support+line@mail.example.test"}') -> 'mails') between 1 and 5
	and pg_temp.find('{"to":"support+line@mail.example.test"}') ->> 'more' = 'true',
	'Line separators count for their escapes too');
-- A search that shows everything says no more and gives no next page.
select pg_temp.wake_assert(pg_temp.find('{"subject":"code is 123456"}') ->> 'more' = 'false'
	and not (pg_temp.find('{"subject":"code is 123456"}') ? 'nextBefore'),
	'Nothing more, no next page');

-- Only verified mail.
insert into public.qorpera_event_deliveries (hook_id, profile_id, status, event_type, content_type, headers, body, body_bytes,
	body_sha256, reason)
select hook_id, profile_id, 'refused', 'mail.received', 'application/json',
	'{"delivered-to":"support+refused@mail.example.test"}', '\x7b7d', 2, repeat('0', 64), 'Refused by hand'
from public.qorpera_company_mailboxes where local_part = 'support' and removed_at is null;
select pg_temp.wake_assert(pg_temp.found('{"to":"support+refused@mail.example.test"}') = '{}',
	'A delivery that is not verified is not found');
-- Only received mail: another kind of event on a mailbox's hook is not mail.
insert into public.qorpera_event_deliveries (hook_id, profile_id, status, delivery_key, event_type, content_type, headers, body,
	body_bytes, body_sha256, verified_at)
select hook_id, profile_id, 'verified', 'other:1', 'other.event', 'application/json',
	'{"delivered-to":"support+other@mail.example.test"}', '\x7b7d', 2, repeat('0', 64), clock_timestamp()
from public.qorpera_company_mailboxes where local_part = 'support' and removed_at is null;
select pg_temp.wake_assert(pg_temp.found('{"to":"support+other@mail.example.test"}') = '{}',
	'Another kind of event is not found');

-- Only the company's own mail: not another company's mailbox, not a removed mailbox, not another hook's events.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('30000000-0000-4000-8000-0000000007a0',
	'30000000-0000-4000-8000-0000000007a1', 'theirs', 'Another company''s mailbox');
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.theirs_mail', pg_temp.mail(pg_temp.mail_id(430), 'theirs+stripe@mail.example.test',
	'Confirm your Stripe account') ->> 'deliveryId', true);
select pg_temp.wake_assert(current_setting('qorpera_test.theirs_mail') is not null
	and not (current_setting('qorpera_test.theirs_mail')::uuid = any (pg_temp.found('{"subject":"Confirm"}')))
	and pg_temp.found('{"to":"theirs+stripe@mail.example.test"}') = '{}',
	'Another company''s mail is not found');
select pg_temp.find_error('{"mailbox":"theirs@mail.example.test"}', '22023');
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'a_b' and removed_at is null), 'removed');
select pg_temp.path_claims('service_role');
select pg_temp.find_error('{"mailbox":"a_b@mail.example.test"}', '22023');

-- A mailbox of the company's other environment is not this run's.
select set_config('qorpera_test.env_mail', pg_temp.mail(pg_temp.mail_id(470), 'a.b+env@mail.example.test', 'Env probe')
	->> 'deliveryId', true);
select pg_temp.wake_assert(current_setting('qorpera_test.env_mail')::uuid = any (pg_temp.found('{"subject":"Env probe"}')),
	'Found in its own environment');
update public.qorpera_company_mailboxes set environment_id = '30000000-0000-4000-8000-0000000007a1'
where local_part = 'a.b' and removed_at is null;
select pg_temp.wake_assert(pg_temp.found('{"subject":"Env probe"}') = '{}', 'Another environment''s mail is not found');
select pg_temp.find_error('{"mailbox":"a.b@mail.example.test"}', '22023');

-- The newest 2000 mails bound a search; more then says so, and before pages back past them.
select set_config('qorpera_test.old_mail', pg_temp.mail(pg_temp.mail_id(480), 'support+old@mail.example.test', 'Old match')
	->> 'deliveryId', true);
select set_config('qorpera_test.cut', clock_timestamp()::text, true);
insert into public.qorpera_event_deliveries (hook_id, profile_id, status, delivery_key, event_type, content_type, headers,
	body, body_bytes, body_sha256, verified_at, received_at)
select mailbox.hook_id, mailbox.profile_id, 'verified', 'mail:noise-' || n, 'mail.received', 'application/json',
	'{"delivered-to":"support+noise@mail.example.test","subject":"Noise"}', '\x7b7d', 2, repeat('0', 64), clock_timestamp(),
	clock_timestamp() + (n || ' milliseconds')::interval
from public.qorpera_company_mailboxes as mailbox, generate_series(1, 2000) as n
where mailbox.local_part = 'support' and mailbox.removed_at is null;
select pg_temp.wake_assert(pg_temp.found('{"to":"support+old@mail.example.test"}') = '{}'
	and pg_temp.find('{"to":"support+old@mail.example.test"}') ->> 'more' = 'true'
	and pg_temp.found(jsonb_build_object('to', 'support+old@mail.example.test',
		'before', to_char(current_setting('qorpera_test.cut')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
		= array[current_setting('qorpera_test.old_mail')::uuid]
	-- With nothing shown, nextBefore is where the search stopped: a next page reaches the old match.
	and (pg_temp.find('{"to":"support+old@mail.example.test"}') ->> 'nextBefore')::timestamptz
		> current_setting('qorpera_test.cut')::timestamptz
	and pg_temp.found(jsonb_build_object('to', 'support+old@mail.example.test', 'before',
		pg_temp.find('{"to":"support+old@mail.example.test"}') ->> 'nextBefore'))
		= array[current_setting('qorpera_test.old_mail')::uuid],
	'Behind 2000 newer mails, more says so and nextBefore reaches it');
select pg_temp.find_error('{"before":"soon"}', '22023', 'Mail search is invalid');

rollback;

-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('12970000-0000-4000-8000-0000000000d1', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'key-1', repeat('1', 64));
insert into auth.users(id, email) values ('12970000-0000-4000-8000-0000000000c1', 'other-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12970000-0000-4000-8000-0000000000c2', 'Other company', '12970000-0000-4000-8000-0000000000c1');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('12970000-0000-4000-8000-0000000000c2', '12970000-0000-4000-8000-0000000000c1', 'other-owner@example.test',
	'Other owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12970000-0000-4000-8000-0000000000c3', '12970000-0000-4000-8000-0000000000c2', 'Environment', 1,
	'12970000-0000-4000-8000-0000000000c1');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('12970000-0000-4000-8000-0000000000d2', '12970000-0000-4000-8000-0000000000c2', 'https://broker.example.test',
	'key-1', repeat('2', 64));

create function pg_temp.g_begin(p_user uuid, p_environment uuid, p_mailbox uuid default null) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_begin_google_mailbox(p_environment, p_mailbox);
	perform pg_temp.base_claims('service_role');
	return v;
end
$$;
create function pg_temp.g_broker(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	set local session authorization qorpera_secret_broker;
	execute p_sql into v;
	reset session authorization;
	return v;
exception when others then
	reset session authorization;
	raise;
end
$$;
create function pg_temp.g_authority(p_ticket jsonb) returns text language sql as $$
	select case when p_ticket #>> '{scope,companyId}' = '12970000-0000-4000-8000-0000000000c2'
		then $a$'12970000-0000-4000-8000-0000000000d2', repeat('2', 64)$a$
		else $a$'12970000-0000-4000-8000-0000000000d1', repeat('1', 64)$a$ end
$$;
create function pg_temp.g_complete(p_ticket jsonb, p_address text) returns jsonb language sql as $$
	select pg_temp.g_broker(format('select public.qorpera_complete_google_mailbox_capture(%s, %L, %L, %L, %L, %L)',
		pg_temp.g_authority(p_ticket), p_ticket ->> 'ticketId',
		encode(extensions.digest(p_ticket ->> 'captureCapability', 'sha256'), 'hex'),
		encode(convert_to('sealed ' || (p_ticket ->> 'ticketId'), 'UTF8'), 'base64'),
		encode(extensions.digest(convert_to('sealed ' || (p_ticket ->> 'ticketId'), 'UTF8'), 'sha256'), 'hex'), p_address))
$$;
create function pg_temp.g_addresses(p_user uuid default '92400000-0000-4000-8000-000000000003',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_member_mail_addresses(p_environment);
	perform pg_temp.base_claims('service_role');
	return v;
end
$$;
create function pg_temp.g_entry(p_address text) returns jsonb language sql as $$
	select entry.value from jsonb_array_elements(pg_temp.g_addresses()) as entry(value)
	where entry.value ->> 'address' = p_address
$$;
create function pg_temp.g_box(p_address text) returns public.qorpera_google_mailboxes language sql as $$
	select google from public.qorpera_google_mailboxes as google where google.address = p_address and google.removed_at is null
$$;
create function pg_temp.g_claim() returns jsonb language sql as $$
	select pg_temp.g_broker($q$select public.qorpera_claim_google_mailbox('12970000-0000-4000-8000-0000000000d1',
		repeat('1', 64))$q$)
$$;
create function pg_temp.g_message(p_address text, p_gmail_id text, p_extra jsonb default '{}') returns text language sql as $$
	select (jsonb_build_object('schema', 'qorpera.mail/v1',
		'emailId', public.qorpera_google_mail_email_id('92400000-0000-4000-8000-000000000010', p_address, p_gmail_id),
		'subject', 'Order ' || p_gmail_id, 'from', 'Customer <customer@example.org>', 'to', jsonb_build_array(p_address),
		'messageId', '<' || p_gmail_id || '@example.org>', 'text', 'Hello ' || p_gmail_id) || p_extra)::text
$$;
create function pg_temp.g_bring(p_claim jsonb, p_gmail_id text, p_imported boolean, p_at timestamptz,
	p_message text default null) returns jsonb language sql as $$
	select pg_temp.g_broker(format('select public.qorpera_bring_in_google_mail(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
		'12970000-0000-4000-8000-0000000000d1', repeat('1', 64), p_claim ->> 'mailboxId', p_claim ->> 'lease', p_gmail_id,
		'thread-' || p_gmail_id, p_imported, p_at,
		coalesce(p_message, pg_temp.g_message(p_claim ->> 'address', p_gmail_id))))
$$;
create function pg_temp.g_finish(p_claim jsonb, p_outcome text, p_history text, p_token text default null,
	p_total integer default null, p_error text default null) returns jsonb language sql as $$
	select pg_temp.g_broker(format('select public.qorpera_finish_google_mailbox_pass(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
		'12970000-0000-4000-8000-0000000000d1', repeat('1', 64), p_claim ->> 'mailboxId', p_claim ->> 'lease', p_outcome,
		p_history, p_token, p_total, p_error))
$$;

select pg_temp.base_claims('service_role');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_error($q$select public.qorpera_begin_google_mailbox('92400000-0000-4000-8000-000000000020')$q$,
	'42501', 'Only owners and admins connect Google mail');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_error($q$select public.qorpera_begin_google_mailbox('92400000-0000-4000-8000-000000000020')$q$,
	'42501', 'Only owners and admins connect Google mail');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error($q$select public.qorpera_begin_google_mailbox('92400000-0000-4000-8000-000000000020')$q$,
	'42501', 'Only owners and admins connect Google mail');
select pg_temp.base_claims('authenticated', '12970000-0000-4000-8000-0000000000c1');
select pg_temp.base_error($q$select public.qorpera_begin_google_mailbox('92400000-0000-4000-8000-000000000020')$q$,
	'42501', 'Only owners and admins connect Google mail');
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.g_ticket', pg_temp.g_begin('92400000-0000-4000-8000-000000000004',
	'92400000-0000-4000-8000-000000000020')::text, true) \g /dev/null
select pg_temp.base_assert((current_setting('qorpera_test.g_ticket')::jsonb ->> 'schema') = 'qorpera.cloud-secret-capture/v1'
		and current_setting('qorpera_test.g_ticket')::jsonb #>> '{scope,connectorId}' = 'gmail'
		and current_setting('qorpera_test.g_ticket')::jsonb #>> '{scope,ownerKind}' = 'company'
		and exists (select 1 from public.qorpera_google_mailbox_tickets as mark
			where mark.ticket_id = (current_setting('qorpera_test.g_ticket')::jsonb ->> 'ticketId')::uuid
				and mark.mailbox_id is null),
	'An admin begins: a company Gmail capture ticket, marked for the Mailbox');
select pg_temp.base_assert(pg_temp.g_broker(format(
		'select public.qorpera_describe_google_mailbox_ticket(%s, %L, %L)', pg_temp.g_authority(current_setting('qorpera_test.g_ticket')::jsonb),
		current_setting('qorpera_test.g_ticket')::jsonb ->> 'ticketId',
		encode(extensions.digest(current_setting('qorpera_test.g_ticket')::jsonb ->> 'captureCapability', 'sha256'), 'hex')))
		= jsonb_build_object('schema', 'qorpera.google-mailbox-ticket/v1', 'mailboxId', null, 'address', null),
	'The broker reads that the ticket is for the Mailbox');
select pg_temp.base_error(format('select pg_temp.g_broker(%L)', format(
		'select public.qorpera_complete_cloud_secret_capture(%s, %L, %L, %L, %L, %L)',
		pg_temp.g_authority(current_setting('qorpera_test.g_ticket')::jsonb),
		current_setting('qorpera_test.g_ticket')::jsonb ->> 'ticketId',
		encode(extensions.digest(current_setting('qorpera_test.g_ticket')::jsonb ->> 'captureCapability', 'sha256'), 'hex'),
		encode(convert_to('plain', 'UTF8'), 'base64'), encode(extensions.digest(convert_to('plain', 'UTF8'), 'sha256'), 'hex'),
		'owner@gmail.com')), '42501', 'cloud secret capture is unavailable');

select pg_temp.base_assert(pg_temp.g_complete(current_setting('qorpera_test.g_ticket')::jsonb, 'Owner@Gmail.com')
		->> 'outcome' = 'created',
	'The broker''s completion creates the Google mailbox');
select pg_temp.base_assert((select secret.status = 'active' and secret.connector_id = 'gmail'
			and secret.account_label = 'owner@gmail.com' and secret.owner_kind = 'company'
		from public.qorpera_cloud_secrets as secret where secret.id = (pg_temp.g_box('owner@gmail.com')).secret_id),
	'The sealed sign-in is a company Gmail connection labelled with the address');
select pg_temp.base_assert(pg_temp.g_entry('owner@gmail.com') - array['hookId', 'handledBy', 'routines']
		= jsonb_build_object('address', 'owner@gmail.com', 'status', 'active', 'kind', 'google', 'last7Days', 0,
			'google', jsonb_build_object('state', 'bringing_in', 'broughtIn', 0, 'total', null, 'lastWeek', 0)),
	'A viewer reads the Google address with its fields: ' || coalesce(pg_temp.g_entry('owner@gmail.com')::text, 'none'));
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support.base', 'Customer support') \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.g_entry('support.base@mail.example.test') ->> 'kind' = 'qorpera'
		and not pg_temp.g_entry('support.base@mail.example.test') ? 'google',
	'A Qorpera address is kind qorpera and nothing else new');
select pg_temp.base_assert(public.qorpera_event_hook_descriptor((select hook from public.qorpera_event_hooks as hook
		where hook.id = (pg_temp.g_box('owner@gmail.com')).hook_id), true) ->> 'email' = 'owner@gmail.com',
	'The hook names the Google address, never the mailbox''s inner name');

select set_config('qorpera_test.g_other', pg_temp.g_begin('12970000-0000-4000-8000-0000000000c1',
	'12970000-0000-4000-8000-0000000000c3')::text, true) \g /dev/null
select pg_temp.base_assert(pg_temp.g_complete(current_setting('qorpera_test.g_other')::jsonb, 'owner@gmail.com')
		= jsonb_build_object('schema', 'qorpera.google-mailbox-refused/v1', 'reason', 'address_taken',
			'message', 'This address is already brought in by another company.'),
	'Another company cannot bring in the same address');
select pg_temp.base_assert((select ticket.status = 'pending' from public.qorpera_cloud_secret_capture_tickets as ticket
		where ticket.id = (current_setting('qorpera_test.g_other')::jsonb ->> 'ticketId')::uuid)
		and not exists (select 1 from public.qorpera_cloud_secrets as secret
			where secret.profile_id = '12970000-0000-4000-8000-0000000000c2'),
	'A refused sign-in seals nothing');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_error(format('select public.qorpera_pause_google_mailbox(%L, true)',
	(pg_temp.g_box('owner@gmail.com')).mailbox_id), '42501', 'Only owners and admins change a Google mailbox');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_pause_google_mailbox((pg_temp.g_box('owner@gmail.com')).mailbox_id, true)
		->> 'state' = 'paused', 'The owner pauses the reader');
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.g_claim() is null and pg_temp.g_entry('owner@gmail.com') #>> '{google,state}' = 'paused',
	'A paused mailbox is not read');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_pause_google_mailbox((pg_temp.g_box('owner@gmail.com')).hook_id, false)
		->> 'state' = 'bringing_in', 'The id the Mailbox lists and removes resumes it too');
select pg_temp.base_claims('service_role');

select set_config('qorpera_test.g_claim', pg_temp.g_claim()::text, true) \g /dev/null
select pg_temp.base_assert((current_setting('qorpera_test.g_claim')::jsonb - array['lease', 'encryptedEnvelopeBase64',
			'envelopeSha256', 'secretId', 'mailboxId', 'environmentId', 'keyId'])
		= jsonb_build_object('schema', 'qorpera.google-mailbox-claim/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
			'address', 'owner@gmail.com', 'state', 'bringing_in', 'secretVersion', 1, 'historyId', null, 'pageToken', null,
			'broughtIn', 0, 'total', null, 'importCount', 0, 'gap', false)
		and pg_temp.g_claim() is null,
	'The broker claims the due mailbox once, with its sealed sign-in: ' || current_setting('qorpera_test.g_claim'));
select pg_temp.base_assert(pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a1', true,
		clock_timestamp() - interval '40 days') ->> 'outcome' = 'accepted',
	'An old message is brought in');
select pg_temp.base_assert(pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a2', true,
		clock_timestamp() - interval '1 hour') ->> 'outcome' = 'accepted'
		and pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a2', true, clock_timestamp() - interval '1 hour')
			->> 'outcome' = 'duplicate',
	'The same Gmail message is never stored twice');
select pg_temp.base_error(format('select pg_temp.g_bring(%L::jsonb, %L, true, clock_timestamp(), %L)',
		current_setting('qorpera_test.g_claim'), 'a3', pg_temp.g_message('owner@gmail.com', 'other')),
	'22023', 'The message is malformed');
select pg_temp.base_assert(pg_temp.g_broker(format('select public.qorpera_google_mail_known_among(%L, %L, %L, %L, %L)',
		'12970000-0000-4000-8000-0000000000d1', repeat('1', 64),
		current_setting('qorpera_test.g_claim')::jsonb ->> 'mailboxId', current_setting('qorpera_test.g_claim')::jsonb ->> 'lease',
		'["a1","a2","a9"]')) -> 'known' = '["a1", "a2"]'::jsonb,
	'The broker asks which of a page it has');
select pg_temp.base_assert((select count(*) = 2 and bool_and(received.delivered_to = array['owner@gmail.com'])
			and min(received.received_at) < clock_timestamp() - interval '39 days'
		from public.qorpera_mail_received as received
		where received.mailbox_id = (pg_temp.g_box('owner@gmail.com')).mailbox_id)
		and (select count(*) = 2 from public.qorpera_mail_threads as thread
			where thread.mailbox_id = (pg_temp.g_box('owner@gmail.com')).mailbox_id)
		and (select count(*) = 0 from public.qorpera_event_intake_usage as usage
			where usage.profile_id = '92400000-0000-4000-8000-000000000010'),
	'Imported mail is stored with its own date, to the Google address, outside the hourly budget');
select pg_temp.base_assert(pg_temp.g_entry('owner@gmail.com') -> 'google'
		= jsonb_build_object('state', 'bringing_in', 'broughtIn', 2, 'total', null, 'lastWeek', 1),
	'The listing counts what the import brought in: ' || (pg_temp.g_entry('owner@gmail.com') -> 'google')::text);
select pg_temp.base_assert(pg_temp.g_finish(current_setting('qorpera_test.g_claim')::jsonb, 'importing', '900', 'page-2', 3)
		->> 'state' = 'bringing_in',
	'A page of the import is recorded');
select set_config('qorpera_test.g_claim', pg_temp.g_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.g_claim')::jsonb ->> 'pageToken' = 'page-2'
		and current_setting('qorpera_test.g_claim')::jsonb ->> 'historyId' = '900'
		and (current_setting('qorpera_test.g_claim')::jsonb ->> 'total')::integer = 3,
	'The next pass goes on from the mark');
select pg_temp.base_assert(pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a3', true,
		clock_timestamp() - interval '2 hours') ->> 'outcome' = 'accepted'
		and (pg_temp.g_box('owner@gmail.com')).brought_in = 3 and (pg_temp.g_box('owner@gmail.com')).total = 3,
	'Google''s total never reads below what was brought in');
update public.qorpera_google_mailboxes set import_count = 50000 where address = 'owner@gmail.com';
select pg_temp.base_assert(pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a4', true, clock_timestamp())
		->> 'outcome' = 'bounded',
	'The first import stops at 50,000 messages');
update public.qorpera_google_mailboxes set import_count = 3 where address = 'owner@gmail.com';
select pg_temp.base_assert(pg_temp.g_finish(current_setting('qorpera_test.g_claim')::jsonb, 'imported', '950')
		->> 'state' = 'live',
	'The import is done: the mailbox is live');

update public.qorpera_google_mailboxes set due_at = clock_timestamp() where address = 'owner@gmail.com';
select set_config('qorpera_test.g_claim', pg_temp.g_claim()::text, true) \g /dev/null
select pg_temp.base_assert(pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a5', true,
		clock_timestamp() - interval '3 hours') ->> 'outcome' = 'accepted'
		and (pg_temp.g_box('owner@gmail.com')).brought_in = 3,
	'Mail from a gap in the change list comes in quietly, outside the first import''s count');
select pg_temp.base_assert(pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'n1', false, clock_timestamp())
		->> 'outcome' = 'accepted',
	'New mail is brought in');
select pg_temp.base_assert((select array_agg(waiting.id) = array[(select known.delivery_id
				from public.qorpera_google_mail_messages as known where known.gmail_id = 'n1')]
		from public.qorpera_event_listener_waiting(row('12970000-0000-4000-8000-0000000000e1', 1, 'mail',
			(pg_temp.g_box('owner@gmail.com')).hook_id, '92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000020', clock_timestamp() - interval '2 days', true, '-infinity'::timestamptz,
			'-infinity'::timestamptz)::public.qorpera_event_listener_cursors, null, 10) as waiting),
	'Only new mail waits for a listener: imported mail wakes no agent');
select pg_temp.base_assert(pg_temp.g_finish(current_setting('qorpera_test.g_claim')::jsonb, 'current', '960')
		->> 'state' = 'live'
		and (pg_temp.g_box('owner@gmail.com')).history_id = '960',
	'The change list''s mark is kept');

select pg_temp.base_assert(public.qorpera_receive_mail('12970000-0000-4000-8000-000000000a01',
		array[(select mailbox.local_part from public.qorpera_company_mailboxes as mailbox
			where mailbox.id = (pg_temp.g_box('owner@gmail.com')).mailbox_id) || '@mail.example.test'],
		jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '12970000-0000-4000-8000-000000000a01')::text)
		#>> '{results,0,outcome}' = 'unknown',
	'Mail to the inner name on the platform''s domain is unknown');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.g_sent', public.qorpera_send_member_mail('92400000-0000-4000-8000-000000000020',
	jsonb_build_object('sendId', '12970000-0000-4000-8000-000000000b01', 'from', 'OWNER@gmail.com',
		'to', jsonb_build_array('customer@example.org'), 'subject', 'Re: Order a2', 'text', 'On its way',
		'replyTo', jsonb_build_object('kind', 'received',
			'id', (select known.delivery_id from public.qorpera_google_mail_messages as known where known.gmail_id = 'a2'))))::text,
	true) \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.base_assert((select mail.route = 'gmail' and mail.from_address = 'owner@gmail.com' and mail.status = 'pending'
			and mail.in_reply_to = '<a2@example.org>'
		from public.qorpera_company_mail_outbox as mail
		where mail.id = (current_setting('qorpera_test.g_sent')::jsonb ->> 'mailId')::uuid),
	'A member''s reply from the Google address is queued for Gmail');
select pg_temp.base_assert(public.qorpera_claim_company_mail(10, '12970000-0000-4000-8000-000000000c01') = '[]'::jsonb,
	'The platform''s outbox leaves it to the broker');
insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
	registers_companies_created_after)
values ('12970000-0000-4000-8000-0000000000e9', 'https://vault.qorpera.test', 'vault-root-1', repeat('9', 64),
	'2099-01-01 00:00:00+00');
update public.qorpera_cloud_secret_broker_authorities set principal_id = '12970000-0000-4000-8000-0000000000e9'
where id = '12970000-0000-4000-8000-0000000000d1';
update public.qorpera_google_mailboxes set due_at = null where address = 'owner@gmail.com';
update public.qorpera_mail_settings set sending = false;
select pg_temp.base_assert(pg_temp.g_broker($q$select public.qorpera_claim_google_mail_sends(
		'12970000-0000-4000-8000-0000000000d1', repeat('1', 64), 10)$q$) -> 'sends' = '[]'::jsonb
		and pg_temp.g_broker($q$select public.qorpera_broker_principal_google_mailboxes_due(
			'12970000-0000-4000-8000-0000000000e9', repeat('9', 64))$q$) -> 'companyIds' = '[]'::jsonb,
	'With sending switched off nothing leaves through Gmail, and no company is due for it');
update public.qorpera_mail_settings set sending = true;
select pg_temp.base_assert(pg_temp.g_broker($q$select public.qorpera_broker_principal_google_mailboxes_due(
		'12970000-0000-4000-8000-0000000000e9', repeat('9', 64))$q$) -> 'companyIds'
		= '["92400000-0000-4000-8000-000000000010"]'::jsonb,
	'With sending on, the company with a queued Gmail send is due');
update public.qorpera_cloud_secret_broker_authorities set principal_id = null where id = '12970000-0000-4000-8000-0000000000d1';
select set_config('qorpera_test.g_sends', pg_temp.g_broker($q$select public.qorpera_claim_google_mail_sends(
	'12970000-0000-4000-8000-0000000000d1', repeat('1', 64), 10)$q$)::text, true) \g /dev/null
select pg_temp.base_assert(jsonb_array_length(current_setting('qorpera_test.g_sends')::jsonb -> 'sends') = 1
		and current_setting('qorpera_test.g_sends')::jsonb #>> '{sends,0,gmailThreadId}' = 'thread-a2'
		and current_setting('qorpera_test.g_sends')::jsonb #>> '{sends,0,address}' = 'owner@gmail.com'
		and current_setting('qorpera_test.g_sends')::jsonb #> '{sends,0,headers}'
			= jsonb_build_object('In-Reply-To', '<a2@example.org>', 'References', '<a2@example.org>'),
	'The broker claims the send in the Gmail thread it answers: ' || current_setting('qorpera_test.g_sends'));
select set_config('qorpera_test.g_done', pg_temp.g_broker(format(
	'select public.qorpera_complete_google_mail_send(%L, %L, %L, %L, %L, %L, %L)',
	'12970000-0000-4000-8000-0000000000d1', repeat('1', 64), current_setting('qorpera_test.g_sends')::jsonb #>> '{sends,0,mailId}',
	current_setting('qorpera_test.g_sends')::jsonb #>> '{sends,0,leaseId}', 's1', 'thread-a2', '<s1@mail.gmail.com>'))::text, true)
\g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.g_done')::jsonb ->> 'completed' = 'true'
		and (select mail.status = 'sent' and mail.provider_message_id = 'gmail:s1' and mail.message_id = '<s1@mail.gmail.com>'
			from public.qorpera_company_mail_outbox as mail
			where mail.id = (current_setting('qorpera_test.g_sent')::jsonb ->> 'mailId')::uuid),
	'The send through Gmail is recorded');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_send_member_mail('92400000-0000-4000-8000-000000000020',
	'{"sendId":"12970000-0000-4000-8000-000000000b03","from":"support.base@mail.example.test","to":["owner+notes@gmail.com"],
	"subject":"Hello","text":"To myself"}')$q$, '42501', 'Email to your own company''s mailboxes is refused');
select pg_temp.base_claims('service_role');
select pg_temp.base_error(format('select public.qorpera_send_agent_mail(%L::jsonb, %L, %L::jsonb)',
	current_setting('qorpera_test.base_binding'), 'g-agent-own', jsonb_build_object('from', 'support.base@mail.example.test',
		'to', jsonb_build_array('customer@example.org'), 'cc', jsonb_build_array('Owner@Gmail.com'), 'subject', 'Hello',
		'text', 'Loop')), '42501', 'Email to your own company''s mailboxes is refused; reach coworkers with send_coworker_message');
select set_config('qorpera_test.g_agent_send', public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb,
	'g-agent-1', jsonb_build_object('from', 'owner@gmail.com', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Hello', 'text', 'From the agent'))::text, true) \g /dev/null
select pg_temp.base_assert((select mail.route = 'gmail' and mail.from_address = 'owner@gmail.com'
		from public.qorpera_company_mail_outbox as mail where mail.call_id = 'g-agent-1'),
	'An agent''s email from the Google address is queued for Gmail');

update public.qorpera_google_mailboxes set due_at = clock_timestamp() where address = 'owner@gmail.com';
select set_config('qorpera_test.g_claim', pg_temp.g_claim()::text, true) \g /dev/null
select pg_temp.base_assert(pg_temp.g_finish(current_setting('qorpera_test.g_claim')::jsonb, 'refused', null, null, null,
		'Google refused the sign-in') ->> 'state' = 'sign_in_again'
		and pg_temp.g_entry('owner@gmail.com') #>> '{google,state}' = 'sign_in_again'
		and pg_temp.g_claim() is null,
	'A refused token asks for a new sign-in and stops the reader');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_send_member_mail('92400000-0000-4000-8000-000000000020',
	'{"sendId":"12970000-0000-4000-8000-000000000b02","from":"owner@gmail.com","to":["customer@example.org"],
	"subject":"Hello","text":"Again"}')$q$, '0A000', 'Google asked you to sign in again.');
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.g_again', pg_temp.g_begin('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000020', (pg_temp.g_box('owner@gmail.com')).mailbox_id)::text, true) \g /dev/null
select pg_temp.base_assert((current_setting('qorpera_test.g_again')::jsonb #>> '{scope,version}')::integer = 2
		and current_setting('qorpera_test.g_again')::jsonb #>> '{scope,secretId}'
			= (pg_temp.g_box('owner@gmail.com')).secret_id::text,
	'Sign in again renews the same connection');
select pg_temp.base_assert(pg_temp.g_complete(current_setting('qorpera_test.g_again')::jsonb, 'someone@gmail.com')
		= jsonb_build_object('schema', 'qorpera.google-mailbox-refused/v1', 'reason', 'wrong_account',
			'address', 'owner@gmail.com', 'message', 'Sign in with owner@gmail.com.'),
	'A different account is refused');
select set_config('qorpera_test.g_new', pg_temp.g_begin('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000020')::text, true) \g /dev/null
select pg_temp.base_assert(pg_temp.g_complete(current_setting('qorpera_test.g_new')::jsonb, 'someone@gmail.com')
		->> 'reason' = 'wrong_account',
	'While an address waits for its sign-in, another account is refused from the Mailbox''s Connect too');
select set_config('qorpera_test.g_relinked', pg_temp.g_complete(current_setting('qorpera_test.g_again')::jsonb,
	'owner@gmail.com')::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.g_relinked')::jsonb ->> 'outcome' = 'relinked'
		and (pg_temp.g_box('owner@gmail.com')).state = 'live'
		and (select secret.current_version = 2 from public.qorpera_cloud_secrets as secret
			where secret.id = (pg_temp.g_box('owner@gmail.com')).secret_id)
		and pg_temp.g_claim() ->> 'secretVersion' = '2',
	'The same account re-links the mailbox and the reader goes on');

insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, current_version, created_by_user_id, account_label)
values ('12970000-0000-4000-8000-000000000f01', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'12970000-0000-4000-8000-0000000000d1', 'company', 'gmail', 'primary', 'Gmail for agents', 1,
	'92400000-0000-4000-8000-000000000001', 'agents@gmail.com');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
	envelope_sha256, created_by_user_id)
values ('12970000-0000-4000-8000-000000000f01', 1, '12970000-0000-4000-8000-0000000000d1', 'key-1', '\x01',
	encode(extensions.digest('\x01'::bytea, 'sha256'), 'hex'), '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.g_reuse', pg_temp.g_begin('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000020')::text, true) \g /dev/null
select set_config('qorpera_test.g_linked', pg_temp.g_complete(current_setting('qorpera_test.g_reuse')::jsonb,
	'agents@gmail.com')::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.g_linked')::jsonb ->> 'outcome' = 'linked'
		and (pg_temp.g_box('agents@gmail.com')).secret_id = '12970000-0000-4000-8000-000000000f01'
		and (select ticket.status = 'cancelled' from public.qorpera_cloud_secret_capture_tickets as ticket
			where ticket.id = (current_setting('qorpera_test.g_reuse')::jsonb ->> 'ticketId')::uuid),
	'The agents'' Gmail connection of the same account becomes the mailbox''s');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status((pg_temp.g_box('owner@gmail.com')).hook_id, 'removed') \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.g_box('owner@gmail.com') is null
		and (select secret.status = 'revoked' from public.qorpera_cloud_secrets as secret
			where secret.account_label = 'owner@gmail.com')
		and exists (select 1 from public.qorpera_connector_token_revocations as revocation
			join public.qorpera_cloud_secrets as secret on secret.id = revocation.secret_id
			where secret.account_label = 'owner@gmail.com' and revocation.reason = 'disconnected')
		and (select count(*) = 5 from public.qorpera_mail_received as received
			join public.qorpera_google_mail_messages as known on known.delivery_id = received.delivery_id
			where known.address = 'owner@gmail.com')
		and pg_temp.g_entry('owner@gmail.com') is null,
	'Remove ends the Google sign-in and keeps the mail brought in');
select set_config('qorpera_test.g_old_box', (select google.mailbox_id::text from public.qorpera_google_mailboxes as google
	where google.address = 'owner@gmail.com'), true) \g /dev/null
select set_config('qorpera_test.g_old_hook', (select google.hook_id::text from public.qorpera_google_mailboxes as google
	where google.address = 'owner@gmail.com'), true) \g /dev/null
update public.qorpera_event_hooks set removed_at = clock_timestamp() - interval '31 days'
where id = current_setting('qorpera_test.g_old_hook')::uuid;
select public.qorpera_purge_event_deliveries(1000) \g /dev/null
select public.qorpera_claim_company_mail(10, '12970000-0000-4000-8000-000000000c02') \g /dev/null
select pg_temp.base_assert(exists (select 1 from public.qorpera_event_hooks as hook
			where hook.id = current_setting('qorpera_test.g_old_hook')::uuid)
		and exists (select 1 from public.qorpera_company_mailboxes as mailbox
			where mailbox.id = current_setting('qorpera_test.g_old_box')::uuid)
		and (select count(*) = 5 from public.qorpera_mail_received as received
			join public.qorpera_google_mail_messages as known on known.delivery_id = received.delivery_id
			where known.address = 'owner@gmail.com')
		and (select count(*) = 1 from public.qorpera_mail_received as received
			join public.qorpera_mail_threads as thread on thread.id = received.thread_id
			where received.received_at < clock_timestamp() - interval '39 days'),
	'The mail brought in stays after Remove, with its hook and mailbox, past the purge and the thread clean-up');
insert into public.qorpera_event_deliveries (id, hook_id, profile_id, status, delivery_key, event_type, content_type,
	headers, body, body_bytes, body_sha256, verified_at, received_at)
select ('12970000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, current_setting('qorpera_test.g_old_hook')::uuid,
	'92400000-0000-4000-8000-000000000010', 'verified', 'mail:bulk-' || n, 'mail.received', 'application/json', '{}',
	null, 0, repeat('0', 64), clock_timestamp(), clock_timestamp() - interval '60 days'
from generate_series(1, 50000) as n;
insert into public.qorpera_mail_received (delivery_id, thread_id, profile_id, environment_id, mailbox_id, received_at)
select ('12970000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, 'b' || lpad(n::text, 42, '0'),
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.g_old_box')::uuid, clock_timestamp() - interval '60 days'
from generate_series(1, 50000) as n;
insert into public.qorpera_google_mail_messages (profile_id, address, gmail_id, mailbox_id, delivery_id, imported)
select '92400000-0000-4000-8000-000000000010', 'owner@gmail.com', 'bulk' || n,
	current_setting('qorpera_test.g_old_box')::uuid, ('12970000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, true
from generate_series(1, 50000) as n;
update public.qorpera_google_mailboxes set brought_in = 50000 where mailbox_id = current_setting('qorpera_test.g_old_box')::uuid;
update public.qorpera_google_mailboxes set due_at = null where address = 'agents@gmail.com';
select set_config('qorpera_test.g_back', pg_temp.g_begin('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000020')::text, true) \g /dev/null
set local statement_timeout = '4s';
select set_config('qorpera_test.g_backed', pg_temp.g_complete(current_setting('qorpera_test.g_back')::jsonb,
	'owner@gmail.com')::text, true) \g /dev/null
set local statement_timeout = 0;
select pg_temp.base_assert(current_setting('qorpera_test.g_backed')::jsonb ->> 'outcome' = 'relinked'
		and current_setting('qorpera_test.g_backed')::jsonb ->> 'mailboxId' = current_setting('qorpera_test.g_old_box'),
	'The same company connects the removed address again, within the vault''s 4 s, however much mail it has');
select pg_temp.base_assert((pg_temp.g_box('owner@gmail.com')).mailbox_id::text = current_setting('qorpera_test.g_old_box')
		and (pg_temp.g_box('owner@gmail.com')).hook_id::text = current_setting('qorpera_test.g_old_hook')
		and (pg_temp.g_box('owner@gmail.com')).state = 'bringing_in'
		and (select hook.status = 'active' and hook.removed_at is null from public.qorpera_event_hooks as hook
			where hook.id = current_setting('qorpera_test.g_old_hook')::uuid)
		and (select mailbox.removed_at is null from public.qorpera_company_mailboxes as mailbox
			where mailbox.id = current_setting('qorpera_test.g_old_box')::uuid)
		and (select count(*) = 50005 from public.qorpera_mail_received as received
			where received.mailbox_id = current_setting('qorpera_test.g_old_box')::uuid)
		and pg_temp.g_entry('owner@gmail.com') ->> 'kind' = 'google',
	'The removed mailbox, its hook and its mail come back in place under the new sign-in');
delete from public.qorpera_event_deliveries where delivery_key like 'mail:bulk-%';
delete from public.qorpera_google_mail_messages where gmail_id like 'bulk%';
select set_config('qorpera_test.g_claim', pg_temp.g_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.g_claim')::jsonb ->> 'address' = 'owner@gmail.com'
		and pg_temp.g_broker(format('select public.qorpera_google_mail_known_among(%L, %L, %L, %L, %L)',
			'12970000-0000-4000-8000-0000000000d1', repeat('1', 64),
			current_setting('qorpera_test.g_claim')::jsonb ->> 'mailboxId',
			current_setting('qorpera_test.g_claim')::jsonb ->> 'lease', '["a1","a2","a3","a5","n1","z9"]'))
			-> 'known' = '["a1", "a2", "a3", "a5", "n1"]'::jsonb
		and pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'a1', true,
			clock_timestamp() - interval '40 days') ->> 'outcome' = 'duplicate',
	'Reading again skips what came in before: nothing is lost and nothing twice');
select pg_temp.base_assert((current_setting('qorpera_test.g_claim')::jsonb ->> 'gap')::boolean
		and (current_setting('qorpera_test.g_claim')::jsonb ->> 'importCount')::integer = 0
		and (current_setting('qorpera_test.g_claim')::jsonb ->> 'broughtIn')::integer = 50000
		and current_setting('qorpera_test.g_claim')::jsonb ->> 'historyId' is null
		and pg_temp.g_bring(current_setting('qorpera_test.g_claim')::jsonb, 'g1', true,
			clock_timestamp() - interval '3 days') ->> 'outcome' = 'accepted'
		and (pg_temp.g_box('owner@gmail.com')).brought_in = 50001
		and (pg_temp.g_box('owner@gmail.com')).import_count = 1,
	'Mail from while it was removed comes in past a removed row''s 50,000, on a limit of its own');
select pg_temp.base_assert(pg_temp.g_finish(current_setting('qorpera_test.g_claim')::jsonb, 'imported', '5000', null, 60000)
		->> 'state' = 'live'
		and not (pg_temp.g_box('owner@gmail.com')).gap
		and (pg_temp.g_box('owner@gmail.com')).total = 60000,
	'The gap import ends at known mail, with Google''s count read again');
select pg_temp.base_assert((select count(*) = 6 from public.qorpera_mail_received as received
		where received.mailbox_id = (pg_temp.g_box('owner@gmail.com')).mailbox_id),
	'Five messages from before and the one from the gap, none twice');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status((pg_temp.g_box('owner@gmail.com')).hook_id, 'removed') \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.g_complete(current_setting('qorpera_test.g_other')::jsonb, 'owner@gmail.com')
		->> 'outcome' = 'created',
	'A removed address may be brought in by another company');

do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_describe_google_mailbox_ticket(uuid,text,uuid,text)',
		'public.qorpera_complete_google_mailbox_capture(uuid,text,uuid,text,text,text,text)',
		'public.qorpera_claim_google_mailbox(uuid,text)',
		'public.qorpera_google_mail_known_among(uuid,text,uuid,uuid,jsonb)',
		'public.qorpera_bring_in_google_mail(uuid,text,uuid,uuid,text,text,boolean,timestamp with time zone,text)',
		'public.qorpera_finish_google_mailbox_pass(uuid,text,uuid,uuid,text,text,text,integer,text)',
		'public.qorpera_claim_google_mail_sends(uuid,text,integer)',
		'public.qorpera_complete_google_mail_send(uuid,text,uuid,uuid,text,text,text)',
		'public.qorpera_fail_google_mail_send(uuid,text,uuid,uuid,text,boolean,boolean)',
		'public.qorpera_broker_principal_google_mailboxes_due(uuid,text)'] loop
		perform pg_temp.base_assert(has_function_privilege('qorpera_secret_broker', v_function, 'EXECUTE')
			and not has_function_privilege('authenticated', v_function, 'EXECUTE')
			and not has_function_privilege('service_role', v_function, 'EXECUTE')
			and not has_function_privilege('anon', v_function, 'EXECUTE'), 'Only the broker calls ' || v_function);
	end loop;
	foreach v_function in array array['public.qorpera_begin_google_mailbox(uuid,uuid)',
		'public.qorpera_pause_google_mailbox(uuid,boolean)'] loop
		perform pg_temp.base_assert(has_function_privilege('authenticated', v_function, 'EXECUTE')
			and not has_function_privilege('anon', v_function, 'EXECUTE')
			and not has_function_privilege('qorpera_secret_broker', v_function, 'EXECUTE'), 'Members call ' || v_function);
	end loop;
	perform pg_temp.base_assert(not has_table_privilege('authenticated', 'public.qorpera_google_mailboxes', 'SELECT')
		and not has_table_privilege('qorpera_secret_broker', 'public.qorpera_google_mail_messages', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_google_mailbox_tickets', 'SELECT'),
		'No role reads the tables');
end
$$;

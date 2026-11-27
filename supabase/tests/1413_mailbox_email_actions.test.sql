-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('14130000-0000-4000-8000-0000000000d1', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'key-1', repeat('1', 64));

create function pg_temp.ma_broker(p_sql text) returns jsonb language plpgsql as $$
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

do $$
declare
	v_profile constant uuid := '92400000-0000-4000-8000-000000000010';
	v_env constant uuid := '92400000-0000-4000-8000-000000000020';
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_viewer constant uuid := '92400000-0000-4000-8000-000000000003';
	v_agent constant uuid := '92400000-0000-4000-8000-000000000030';
	v_auth_id constant uuid := '14130000-0000-4000-8000-0000000000d1';
	v_auth_sha constant text := repeat('1', 64);
	v_box jsonb;
	v_email_1 uuid := '14130000-0000-4000-8000-0000000000e1';
	v_email_2 uuid := '14130000-0000-4000-8000-0000000000e2';
	v_email_3 uuid := '14130000-0000-4000-8000-0000000000e3';
	v_email_4 uuid := '14130000-0000-4000-8000-0000000000e4';
	v_email_5 uuid := '14130000-0000-4000-8000-0000000000e5';
	v_email_6 uuid := '14130000-0000-4000-8000-0000000000e6';
	v_email_7 uuid := '14130000-0000-4000-8000-0000000000e7';
	v_email_8 uuid := '14130000-0000-4000-8000-0000000000e8';
	v_email_9 uuid := '14130000-0000-4000-8000-0000000000e9';
	v_email_10 uuid := '14130000-0000-4000-8000-0000000000ea';
	v_rx jsonb;
	v_delivery_1 uuid;
	v_delivery_2 uuid;
	v_delivery_3 uuid;
	v_delivery_4 uuid;
	v_delivery_5 uuid;
	v_delivery_6 uuid;
	v_delivery_7 uuid;
	v_delivery_8 uuid;
	v_delivery_9 uuid;
	v_delivery_10 uuid;
	v_thread_1 text;
	v_thread_2 text;
	v_thread_3 text;
	v_thread_4 text;
	v_thread_5 text;
	v_thread_6 text;
	v_thread_7 text;
	v_thread_8 text;
	v_thread_9 text;
	v_list jsonb;
	v_detail jsonb;
	v_res jsonb;
	v_claim jsonb;
	v_lease uuid := '14130000-0000-4000-8000-000000000099';
	v_lease_2 uuid := '14130000-0000-4000-8000-00000000009a';
	v_ticket jsonb;
	v_gclaim jsonb;
	v_gactions jsonb;
	v_gthread text;
	v_binding jsonb;
	v_found jsonb;
	v_secret_id uuid;
	v_hook_id uuid;
	v_outbox_row public.qorpera_company_mail_outbox%rowtype;
	v_waiting uuid[];
	v_other_profile constant uuid := '14130000-0000-4000-8000-0000000000f1';
	v_other_env constant uuid := '14130000-0000-4000-8000-0000000000f2';
	v_other_user constant uuid := '14130000-0000-4000-8000-0000000000f3';
	v_first_action_id uuid;
	v_first_lease_id uuid;
begin
	if (select count(*) from public.qorpera_cloud_connector_operations
		where connector_id = 'gmail' and operation_id in ('list_messages', 'update_messages', 'block_sender')
			and version = 1 and status = 'active') <> 3 then
		raise exception 'Expected 3 new active Gmail connector operations';
	end if;

	perform pg_temp.base_claims('authenticated', v_owner);
	v_box := public.qorpera_create_company_mailbox(v_profile, v_env, 'inbox.northwind', 'Main inbox');
	perform pg_temp.base_claims('service_role');

	v_rx := public.qorpera_receive_mail(
		v_email_1::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_1,
			'subject', 'Weekly Digest',
			'from', 'Digest <digest@newsletter.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m1@newsletter.example.org>',
			'automated', true,
			'listUnsubscribe', '<https://newsletter.example.org/unsub?u=1>, <mailto:unsub@newsletter.example.org?subject=Leave>',
			'listUnsubscribePost', 'List-Unsubscribe=One-Click',
			'text', 'This week in tech.'
		)::text
	);
	v_delivery_1 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_1 from public.qorpera_mail_received where delivery_id = v_delivery_1;

	v_rx := public.qorpera_receive_mail(
		v_email_2::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_2,
			'subject', 'Mailto List',
			'from', 'Alerts <alerts@mailto-list.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m2@mailto-list.example.org>',
			'automated', true,
			'listUnsubscribe', '<mailto:leave@mailto-list.example.org?subject=Unsub%20Now&body=Bye+list>',
			'text', 'Alert item.'
		)::text
	);
	v_delivery_2 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_2 from public.qorpera_mail_received where delivery_id = v_delivery_2;

	v_rx := public.qorpera_receive_mail(
		v_email_3::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_3,
			'subject', 'Web Only Newsletter',
			'from', 'Promo <promo@web-only.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m3@web-only.example.org>',
			'automated', true,
			'listUnsubscribe', '<https://web-only.example.org/manage-preferences>',
			'text', 'Special offer.'
		)::text
	);
	v_delivery_3 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_3 from public.qorpera_mail_received where delivery_id = v_delivery_3;

	perform pg_temp.base_claims('authenticated', v_viewer);
	begin
		perform public.qorpera_member_mail_update_threads(v_env, array[v_thread_1], 'star');
		raise exception 'Viewer should not update threads';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_member_mail_block_sender(v_env, 'spam@bad.example.org', true);
		raise exception 'Viewer should not block senders';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_member_mail_unsubscribe(v_env, v_thread_1, null);
		raise exception 'Viewer should not unsubscribe';
	exception when insufficient_privilege then null;
	end;

	perform pg_temp.base_claims('authenticated', v_owner);
	v_detail := public.qorpera_member_mail_thread(v_env, v_thread_1, null);
	if not coalesce((v_detail #>> '{unsubscribe,oneClick}')::boolean, false) then
		raise exception 'Expected oneClick unsubscribe metadata on thread 1: %', v_detail;
	end if;

	v_res := public.qorpera_member_mail_update_threads(v_env, array[v_thread_1], 'star');
	if (v_res ->> 'updatedCount')::integer <> 1 then
		raise exception 'Expected 1 starred thread: %', v_res;
	end if;
	v_list := public.qorpera_member_mail_threads(v_env, jsonb_build_object('view', 'starred'));
	if jsonb_array_length(v_list -> 'threads') <> 1 or v_list #>> '{threads,0,thread}' <> v_thread_1 then
		raise exception 'Expected thread 1 in starred view: %', v_list;
	end if;

	perform public.qorpera_member_mail_update_threads(v_env, array[v_thread_1], 'trash');
	v_list := public.qorpera_member_mail_threads(v_env, jsonb_build_object('view', 'inbox'));
	if exists (select 1 from jsonb_array_elements(v_list -> 'threads') as t where t ->> 'thread' = v_thread_1) then
		raise exception 'Trashed thread must leave inbox view';
	end if;
	v_list := public.qorpera_member_mail_threads(v_env, jsonb_build_object('view', 'trash'));
	if jsonb_array_length(v_list -> 'threads') <> 1 or v_list #>> '{threads,0,thread}' <> v_thread_1 then
		raise exception 'Expected thread 1 in trash view: %', v_list;
	end if;
	perform public.qorpera_member_mail_update_threads(v_env, array[v_thread_1], 'restore');
	v_list := public.qorpera_member_mail_threads(v_env, jsonb_build_object('view', 'inbox'));
	if not exists (select 1 from jsonb_array_elements(v_list -> 'threads') as t where t ->> 'thread' = v_thread_1) then
		raise exception 'Restored thread must return to inbox';
	end if;

	v_res := public.qorpera_member_mail_unsubscribe(v_env, v_thread_1, null);
	if v_res ->> 'method' <> 'one_click' or v_res ->> 'status' <> 'queued' then
		raise exception 'Expected queued one_click unsubscribe: %', v_res;
	end if;

	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_mail_unsubscribes(10, v_lease);
	if jsonb_array_length(v_claim) <> 1 or v_claim #>> '{0,url}' <> 'https://newsletter.example.org/unsub?u=1' then
		raise exception 'Expected claimed one_click unsubscribe: %', v_claim;
	end if;
	if not public.qorpera_complete_mail_unsubscribe((v_claim #>> '{0,unsubscribeId}')::uuid, v_lease) then
		raise exception 'Expected complete_mail_unsubscribe to succeed';
	end if;

	perform pg_temp.base_claims('authenticated', v_owner);
	v_detail := public.qorpera_member_mail_thread(v_env, v_thread_1, null);
	if v_detail #>> '{unsubscribe,status}' <> 'succeeded' then
		raise exception 'Expected succeeded unsubscribe status on thread 1: %', v_detail;
	end if;

	v_res := public.qorpera_member_mail_unsubscribe(v_env, v_thread_2, null);
	if v_res ->> 'method' <> 'mailto' or v_res ->> 'status' <> 'queued' or v_res ->> 'to' <> 'leave@mailto-list.example.org' then
		raise exception 'Expected queued mailto unsubscribe: %', v_res;
	end if;

	v_res := public.qorpera_member_mail_unsubscribe(v_env, v_thread_3, null);
	if v_res ->> 'method' <> 'browser' or v_res ->> 'status' <> 'browser_required'
		or v_res #>> '{urls,0}' <> 'https://web-only.example.org/manage-preferences' then
		raise exception 'Expected browser_required unsubscribe: %', v_res;
	end if;

	v_res := public.qorpera_member_mail_block_sender(v_env, '@web-only.example.org', true);
	if (v_res ->> 'trashedCount')::integer <> 1 or v_res ->> 'sender' <> '@web-only.example.org' then
		raise exception 'Expected domain block to trash existing thread 3: %', v_res;
	end if;
	v_list := public.qorpera_member_mail_blocked_senders(v_env);
	if jsonb_array_length(v_list -> 'senders') <> 1 then
		raise exception 'Expected 1 blocked sender: %', v_list;
	end if;

	perform pg_temp.base_claims('service_role');
	v_rx := public.qorpera_receive_mail(
		v_email_4::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_4,
			'subject', 'Another Spam',
			'from', 'Other <other@web-only.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m4@web-only.example.org>',
			'text', 'Buy now.'
		)::text
	);
	v_delivery_4 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_4 from public.qorpera_mail_received where delivery_id = v_delivery_4;
	if not exists (select 1 from public.qorpera_mail_threads where id = v_thread_4 and trashed_at is not null) then
		raise exception 'Incoming mail from blocked domain must be auto-trashed';
	end if;

	perform pg_temp.base_claims('authenticated', v_owner);
	v_res := public.qorpera_member_mail_unblock_sender(v_env, '@web-only.example.org');
	if not (v_res ->> 'removed')::boolean then
		raise exception 'Expected sender unblock to remove row: %', v_res;
	end if;

	v_ticket := public.qorpera_begin_google_mailbox(v_env, null);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.ma_broker(format(
		'select public.qorpera_complete_google_mailbox_capture(%L, %L, %L, %L, %L, %L, %L)',
		v_auth_id, v_auth_sha, v_ticket ->> 'ticketId',
		encode(extensions.digest(v_ticket ->> 'captureCapability', 'sha256'), 'hex'),
		encode(convert_to('sealed-gmail', 'UTF8'), 'base64'),
		encode(extensions.digest(convert_to('sealed-gmail', 'UTF8'), 'sha256'), 'hex'),
		'owner1413@gmail.com'
	));
	v_gclaim := pg_temp.ma_broker(format('select public.qorpera_claim_google_mailbox(%L, %L)', v_auth_id, v_auth_sha));
	perform pg_temp.ma_broker(format(
		'select public.qorpera_bring_in_google_mail(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
		v_auth_id, v_auth_sha, v_gclaim ->> 'mailboxId', v_gclaim ->> 'lease', 'gm1', 'gth1', true,
		'2026-11-26T10:00:00Z',
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', public.qorpera_google_mail_email_id(v_profile, 'owner1413@gmail.com', 'gm1'),
			'subject', 'Starred Google Mail',
			'from', 'VIP <vip@partner.example.org>',
			'to', jsonb_build_array('owner1413@gmail.com'),
			'messageId', '<gm1@partner.example.org>',
			'gmailLabels', jsonb_build_array('INBOX', 'STARRED'),
			'text', 'Hello from Gmail.'
		)::text
	));
	select rec.thread_id into strict v_gthread
	from public.qorpera_google_mail_messages as gm
	join public.qorpera_mail_received as rec on rec.delivery_id = gm.delivery_id
	where gm.gmail_id = 'gm1';
	if not exists (select 1 from public.qorpera_mail_threads where id = v_gthread and starred and trashed_at is null) then
		raise exception 'Imported Gmail STARRED label should mark thread starred';
	end if;

	perform pg_temp.ma_broker(format(
		'select public.qorpera_apply_google_mail_label_changes(%L, %L, %L, %L, %L::jsonb)',
		v_auth_id, v_auth_sha, v_gclaim ->> 'mailboxId', v_gclaim ->> 'lease',
		jsonb_build_array(jsonb_build_object('gmailThreadId', 'gth1', 'starred', false, 'archived', true))::text
	));
	if not exists (select 1 from public.qorpera_mail_threads where id = v_gthread and not starred and archived_at is not null) then
		raise exception 'Inbound Gmail label changes should update thread';
	end if;

	perform pg_temp.base_claims('service_role');
	delete from public.qorpera_google_mail_actions where profile_id = v_profile and status <> 'done';
	perform pg_temp.base_claims('authenticated', v_owner);
	perform public.qorpera_member_mail_update_threads(v_env, array[v_gthread], 'trash');
	perform pg_temp.base_claims('service_role');
	v_gactions := pg_temp.ma_broker(format('select public.qorpera_claim_google_mail_actions(%L, %L, 10)', v_auth_id, v_auth_sha));
	if jsonb_array_length(v_gactions -> 'actions') <> 1
		or v_gactions #>> '{actions,0,action}' <> 'trash'
		or v_gactions #>> '{actions,0,gmailThreadIds,0}' <> 'gth1' then
		raise exception 'Expected queued Google trash action: %', v_gactions;
	end if;
	v_res := pg_temp.ma_broker(format(
		'select public.qorpera_complete_google_mail_action(%L, %L, %L, %L)',
		v_auth_id, v_auth_sha, v_gactions #>> '{actions,0,actionId}', v_gactions #>> '{actions,0,leaseId}'
	));
	if not (v_res ->> 'completed')::boolean then
		raise exception 'Expected complete_google_mail_action to return true';
	end if;

	v_binding := current_setting('qorpera_test.base_binding')::jsonb;
	v_found := public.qorpera_find_agent_mail(v_binding, jsonb_build_object('view', 'inbox', 'limit', 25));
	if not exists (
		select 1 from jsonb_array_elements(v_found -> 'mails') as m
		where m ->> 'threadId' = v_thread_1 and (m ->> 'starred')::boolean
	) then
		raise exception 'Expected find_mail to return threadId, starred, and unsubscribe: %', v_found;
	end if;

	v_res := public.qorpera_manage_agent_mail(
		v_binding, 'call-star-1',
		jsonb_build_object('action', 'unstar', 'threadIds', jsonb_build_array(v_thread_1))
	);
	if (v_res ->> 'updatedCount')::integer <> 1 then
		raise exception 'Expected agent manage_mail unstar to succeed: %', v_res;
	end if;

	v_res := public.qorpera_manage_agent_mail(
		v_binding, 'call-block-1',
		jsonb_build_object('action', 'block_sender', 'sender', 'alerts@mailto-list.example.org', 'trashExisting', true)
	);
	if not (v_res ->> 'blocked')::boolean or (v_res ->> 'trashedCount')::integer <> 1 then
		raise exception 'Expected agent manage_mail block_sender to succeed: %', v_res;
	end if;
	v_res := public.qorpera_manage_agent_mail(v_binding, 'call-list-1', jsonb_build_object('action', 'list_blocked'));
	if jsonb_array_length(v_res -> 'senders') <> 1 then
		raise exception 'Expected 1 blocked sender in list_blocked: %', v_res;
	end if;

	if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_manage_agent_mail' and scope = 'binding') then
		raise exception 'Expected qorpera_manage_agent_mail in qorpera_native_host_calls';
	end if;

	select secret_id into v_secret_id from public.qorpera_google_mailboxes where address = 'owner1413@gmail.com';
	if v_secret_id is null then
		raise exception 'Expected google mailbox secret';
	end if;

	select * into strict v_outbox_row from public.qorpera_company_mail_outbox
	where recipients_to = array['leave@mailto-list.example.org']
	order by created_at desc
	limit 1;
	if v_outbox_row.subject <> 'Unsubscribe' or v_outbox_row.body <> 'Unsubscribe' then
		raise exception 'Mailto unsubscribe must use fixed body and sanitized subject: % / %',
			v_outbox_row.subject, v_outbox_row.body;
	end if;

	v_rx := public.qorpera_receive_mail(
		v_email_5::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_5,
			'subject', 'Invoice #42',
			'from', 'Bob <bob@customer.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m5@customer.example.org>',
			'text', 'Original invoice.'
		)::text
	);
	v_delivery_5 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_5 from public.qorpera_mail_received where delivery_id = v_delivery_5;
	perform pg_temp.base_claims('authenticated', v_owner);
	perform public.qorpera_member_mail_update_threads(v_env, array[v_thread_5], 'trash');
	if not exists (select 1 from public.qorpera_mail_threads where id = v_thread_5 and trashed_at is not null) then
		raise exception 'Thread 5 must be trashed';
	end if;
	perform pg_temp.base_claims('service_role');
	v_rx := public.qorpera_receive_mail(
		v_email_6::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_6,
			'subject', 'Re: Invoice #42',
			'from', 'Bob <bob@customer.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m6@customer.example.org>',
			'inReplyTo', '<m5@customer.example.org>',
			'text', 'Corrected invoice attached.'
		)::text
	);
	v_delivery_6 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	if not exists (select 1 from public.qorpera_mail_threads where id = v_thread_5 and trashed_at is null) then
		raise exception 'Non-blocked reply to trashed thread must clear trashed_at';
	end if;
	select hook_id into strict v_hook_id from public.qorpera_company_mailboxes where local_part = 'inbox.northwind';
	select array_agg(waiting.id) into v_waiting
	from public.qorpera_event_listener_waiting(
		row('14130000-0000-4000-8000-0000000000c1', 1, 'mail', v_hook_id, v_profile, v_env,
			clock_timestamp() - interval '2 days', true, '-infinity'::timestamptz, '-infinity'::timestamptz
		)::public.qorpera_event_listener_cursors,
		null, 50
	) as waiting;
	if not (v_delivery_6 = any(coalesce(v_waiting, '{}'))) then
		raise exception 'Non-blocked reply after untrash must wake event listeners: %', v_waiting;
	end if;
	if v_delivery_4 = any(coalesce(v_waiting, '{}')) then
		raise exception 'Blocked auto-trashed delivery must not wake event listeners: %', v_waiting;
	end if;

	v_rx := public.qorpera_receive_mail(
		v_email_7::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_7,
			'subject', 'Phish Attempt',
			'from', 'Attacker <attacker@evil.co.uk>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m7@evil.co.uk>',
			'listUnsubscribe', '<mailto:victim@bank.co.uk?subject=Urgent%20wire&body=Send%20funds>',
			'text', 'Click here.'
		)::text
	);
	v_delivery_7 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_7 from public.qorpera_mail_received where delivery_id = v_delivery_7;
	perform pg_temp.base_claims('authenticated', v_owner);
	v_detail := public.qorpera_member_mail_thread(v_env, v_thread_7, null);
	if v_detail -> 'unsubscribe' is not null then
		raise exception 'Cross-domain mailto-only header must not expose unsubscribe: %', v_detail;
	end if;
	begin
		perform public.qorpera_member_mail_unsubscribe(v_env, v_thread_7, null);
		raise exception 'Cross-domain mailto unsubscribe must be refused';
	exception when insufficient_privilege then null;
	end;

	perform pg_temp.base_claims('service_role');
	v_rx := public.qorpera_receive_mail(
		v_email_8::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_8,
			'subject', 'Self Loop Test',
			'from', 'Loop <loop@mail.example.test>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m8@mail.example.test>',
			'listUnsubscribe', '<mailto:inbox.northwind@mail.example.test?subject=unsubscribe>',
			'text', 'Loop.'
		)::text
	);
	v_delivery_8 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_8 from public.qorpera_mail_received where delivery_id = v_delivery_8;
	perform pg_temp.base_claims('authenticated', v_owner);
	begin
		perform public.qorpera_member_mail_unsubscribe(v_env, v_thread_8, null);
		raise exception 'Self-mailbox mailto unsubscribe must be refused';
	exception when insufficient_privilege then null;
	end;

	perform pg_temp.base_claims('service_role');
	v_rx := public.qorpera_receive_mail(
		v_email_9::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_9,
			'subject', 'Subdomain Mailto & Expiry',
			'from', 'Updates <news@updates.brand.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m9@updates.brand.example.org>',
			'listUnsubscribe', '<mailto:unsub@bounce.brand.example.org?subject=unsubscribe%20token-42&body=Ignored+text>',
			'text', 'Brand news.'
		)::text
	);
	v_delivery_9 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_9 from public.qorpera_mail_received where delivery_id = v_delivery_9;
	v_res := public.qorpera_manage_agent_mail(
		v_binding, 'call-preview-1',
		jsonb_build_object('action', 'unsubscribe', 'threadId', v_thread_9, 'preview', true)
	);
	if not coalesce((v_res ->> 'preview')::boolean, false)
		or v_res ->> 'method' <> 'mailto'
		or v_res ->> 'to' <> 'unsub@bounce.brand.example.org'
		or v_res ->> 'subject' <> 'unsubscribe token-42'
		or v_res ->> 'body' <> 'Unsubscribe' then
		raise exception 'Unsubscribe preview must resolve same-org mailto with sanitized subject and fixed body: %', v_res;
	end if;
	if exists (select 1 from public.qorpera_mail_unsubscribes where thread_id = v_thread_9) then
		raise exception 'Unsubscribe preview must not insert unsubscribe rows';
	end if;

	v_rx := public.qorpera_receive_mail(
		v_email_10::text,
		array['inbox.northwind@mail.example.test'],
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', v_email_10,
			'subject', 'One Click Release And Expire',
			'from', 'Promo2 <promo2@brand2.example.org>',
			'to', jsonb_build_array('inbox.northwind@mail.example.test'),
			'messageId', '<m10@brand2.example.org>',
			'listUnsubscribe', '<https://brand2.example.org/unsub>',
			'listUnsubscribePost', 'List-Unsubscribe=One-Click',
			'text', 'Deals.'
		)::text
	);
	v_delivery_10 := (v_rx #>> '{results,0,deliveryId}')::uuid;
	select thread_id into strict v_thread_6 from public.qorpera_mail_received where delivery_id = v_delivery_10;
	perform pg_temp.base_claims('authenticated', v_owner);
	v_res := public.qorpera_member_mail_unsubscribe(v_env, v_thread_6, null);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_mail_unsubscribes(10, v_lease);
	if jsonb_array_length(v_claim) <> 1 or (v_claim #>> '{0,attemptCount}')::integer <> 1 then
		raise exception 'Expected claimed one_click attempt 1: %', v_claim;
	end if;
	if not public.qorpera_release_mail_unsubscribe((v_claim #>> '{0,unsubscribeId}')::uuid, v_lease) then
		raise exception 'Expected release_mail_unsubscribe to succeed';
	end if;
	if not exists (
		select 1 from public.qorpera_mail_unsubscribes
		where id = (v_claim #>> '{0,unsubscribeId}')::uuid and status = 'pending' and attempt_count = 0
	) then
		raise exception 'Released unsubscribe must reset attempt_count and status';
	end if;
	update public.qorpera_mail_unsubscribes
	set created_at = clock_timestamp() - interval '2 days'
	where id = (v_claim #>> '{0,unsubscribeId}')::uuid;
	v_claim := public.qorpera_claim_mail_unsubscribes(10, v_lease_2);
	if jsonb_array_length(v_claim) <> 0 then
		raise exception 'Expired unsubscribe must not be claimed: %', v_claim;
	end if;
	if not exists (
		select 1 from public.qorpera_mail_unsubscribes
		where thread_id = v_thread_6 and status = 'failed' and settled_at is not null
	) then
		raise exception 'Expired unsubscribe must be settled as failed';
	end if;
	perform pg_temp.base_claims('authenticated', v_owner);
	v_res := public.qorpera_member_mail_unsubscribe(v_env, v_thread_6, null);
	if coalesce((v_res ->> 'alreadyRequested')::boolean, false) or v_res ->> 'status' <> 'queued' then
		raise exception 'Re-unsubscribing after failed attempt must queue a fresh attempt: %', v_res;
	end if;

	perform public.qorpera_member_mail_update_threads(v_env, array[v_thread_9], 'archive');
	v_res := public.qorpera_member_mail_block_sender(v_env, '@updates.brand.example.org', true);
	if (v_res ->> 'trashedCount')::integer <> 1
		or v_res #>> '{trashedThreads,0}' <> v_thread_9
		or v_res #>> '{trashedArchivedThreads,0}' <> v_thread_9 then
		raise exception 'Block sender must return trashedThreads and trashedArchivedThreads: %', v_res;
	end if;

	perform pg_temp.base_claims('service_role');
	perform pg_temp.ma_broker(format(
		'select public.qorpera_bring_in_google_mail(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
		v_auth_id, v_auth_sha, v_gclaim ->> 'mailboxId', v_gclaim ->> 'lease', 'gm2', 'gth1', false,
		'2026-11-27T10:00:00Z',
		jsonb_build_object(
			'schema', 'qorpera.mail/v1',
			'emailId', public.qorpera_google_mail_email_id(v_profile, 'owner1413@gmail.com', 'gm2'),
			'subject', 'Re: Starred Google Mail',
			'from', 'VIP <vip@partner.example.org>',
			'to', jsonb_build_array('owner1413@gmail.com'),
			'messageId', '<gm2@partner.example.org>',
			'inReplyTo', '<gm1@partner.example.org>',
			'gmailLabels', jsonb_build_array('INBOX'),
			'text', 'Reply back to inbox.'
		)::text
	));
	if not exists (select 1 from public.qorpera_mail_threads where id = v_gthread and trashed_at is null) then
		raise exception 'Incoming Gmail message with INBOX label must clear trashed_at';
	end if;

	perform pg_temp.base_claims('service_role');
	delete from public.qorpera_google_mail_actions where profile_id = v_profile and status <> 'done';
	perform pg_temp.base_claims('authenticated', v_owner);
	perform public.qorpera_member_mail_update_threads(v_env, array[v_gthread], 'trash');
	perform pg_temp.base_claims('service_role');
	v_gactions := pg_temp.ma_broker(format('select public.qorpera_claim_google_mail_actions(%L, %L, 10)', v_auth_id, v_auth_sha));
	v_first_action_id := (v_gactions #>> '{actions,0,actionId}')::uuid;
	v_first_lease_id := (v_gactions #>> '{actions,0,leaseId}')::uuid;
	perform pg_temp.ma_broker(format(
		'select public.qorpera_fail_google_mail_action(%L, %L, %L, %L, %L, true, false)',
		v_auth_id, v_auth_sha, v_first_action_id, v_first_lease_id, 'temporary 503'
	));
	perform pg_temp.base_claims('authenticated', v_owner);
	perform public.qorpera_member_mail_update_threads(v_env, array[v_gthread], 'restore');
	perform pg_temp.base_claims('service_role');
	if not exists (
		select 1 from public.qorpera_google_mail_actions
		where id = v_first_action_id and status = 'done' and last_error = 'Superseded by newer action'
	) then
		raise exception 'Newer restore must supersede retrying trash action';
	end if;
	v_gactions := pg_temp.ma_broker(format('select public.qorpera_claim_google_mail_actions(%L, %L, 10)', v_auth_id, v_auth_sha));
	if jsonb_array_length(v_gactions -> 'actions') <> 1 or v_gactions #>> '{actions,0,action}' <> 'untrash' then
		raise exception 'Expected only superseding untrash action to be claimed: %', v_gactions;
	end if;
	v_first_action_id := (v_gactions #>> '{actions,0,actionId}')::uuid;
	v_first_lease_id := (v_gactions #>> '{actions,0,leaseId}')::uuid;
	perform pg_temp.base_claims('authenticated', v_owner);
	perform public.qorpera_member_mail_update_threads(v_env, array[v_gthread], 'star');
	perform pg_temp.base_claims('service_role');
	v_gactions := pg_temp.ma_broker(format('select public.qorpera_claim_google_mail_actions(%L, %L, 10)', v_auth_id, v_auth_sha));
	if jsonb_array_length(v_gactions -> 'actions') <> 0 then
		raise exception 'Newer action on same thread must wait while earlier action is delivering: %', v_gactions;
	end if;
	perform pg_temp.ma_broker(format(
		'select public.qorpera_complete_google_mail_action(%L, %L, %L, %L)',
		v_auth_id, v_auth_sha, v_first_action_id, v_first_lease_id
	));
	v_gactions := pg_temp.ma_broker(format('select public.qorpera_claim_google_mail_actions(%L, %L, 10)', v_auth_id, v_auth_sha));
	if jsonb_array_length(v_gactions -> 'actions') <> 1 or v_gactions #>> '{actions,0,action}' <> 'star' then
		raise exception 'Expected queued star action once earlier action settled: %', v_gactions;
	end if;
	perform pg_temp.ma_broker(format(
		'select public.qorpera_fail_google_mail_action(%L, %L, %L, %L, %L, true, true)',
		v_auth_id, v_auth_sha, v_gactions #>> '{actions,0,actionId}', v_gactions #>> '{actions,0,leaseId}', '403 scope'
	));
	if not exists (
		select 1 from public.qorpera_google_mailboxes
		where address = 'owner1413@gmail.com' and state = 'sign_in_again'
	) then
		raise exception 'Refused Google action must move Google mailbox to sign_in_again';
	end if;

	insert into auth.users (id, email) values (v_other_user, 'outsider1413@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_other_profile, 'Other Co', v_other_user);
	insert into public.qorpera_profile_members (profile_id, user_id, email, role, display_name)
	values (v_other_profile, v_other_user, 'outsider1413@example.test', 'owner', 'Outsider');
	perform pg_temp.base_claims('authenticated', v_other_user);
	begin
		perform public.qorpera_member_mail_blocked_senders(v_env);
		raise exception 'Cross-company blocked_senders read must be refused';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_member_mail_update_threads(v_env, array[v_thread_1], 'trash');
		raise exception 'Cross-company thread update must be refused';
	exception when insufficient_privilege then null;
	end;
end $$;

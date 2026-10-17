-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Interfaces C6, a page switched off keeps the company's data (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §4; 688
-- covers the folder, the areas' consents and offers, the members and the sponsor bindings). Here the company has mail:
-- received mail and a reply in one thread, a read mark and a draft that quotes the thread. Switching Mailbox off and on,
-- and Members off and on, by the owner and the admin, leaves the mail, the supervision and who pays (the sponsor
-- bindings, their versions and hand-offs, and the routines' payer changes) as they were, and the mail still reads.
-- The switch writes only qorpera_interface_pages (20260930509000).

select pg_temp.base_claims('service_role');
-- A received email as the mail door stores it: the delivery of its first recipient.
create function pg_temp.km_received(p_n integer, p_message jsonb default '{}') returns uuid language sql as $$
	select (public.qorpera_receive_mail('61600000-0000-4000-8000-' || lpad(p_n::text, 12, '0'), array['support@mail.example.test'],
		(jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', '61600000-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
			'messageId', '<k' || p_n || '@example.org>', 'subject', 'Order 7', 'from', 'Customer <customer@example.org>',
			'to', jsonb_build_array('support@mail.example.test'), 'text', 'Message ' || p_n) || p_message)::text)
		#>> '{results,0,deliveryId}')::uuid
$$;
-- Calls as a signed-in member, then as the service again.
create function pg_temp.km_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	execute p_sql into r;
	perform pg_temp.base_claims('service_role');
	return r;
end $$;
create function pg_temp.km_set(p_user uuid, p_page text, p_on boolean) returns jsonb language sql as $$
	select pg_temp.km_call(p_user, format('select public.qorpera_set_interface_page(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000020', p_page, p_on))
$$;
-- The owner's list of the company's threads.
create function pg_temp.km_threads() returns jsonb language sql as $$
	select pg_temp.km_call('92400000-0000-4000-8000-000000000001', format('select public.qorpera_member_mail_threads(%L, %L)',
		'92400000-0000-4000-8000-000000000020', '{}'))
$$;
-- Every row a switch must leave alone, for 924's company, each table in a stable order ('[]' when it has none, so a
-- row that appears changes the hash too).
create function pg_temp.km_rows(p_rows jsonb) returns text language sql as $$
	select coalesce(p_rows, '[]')::text
$$;
create function pg_temp.km_data() returns text language sql as $$
	select md5(concat_ws('|',
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_company_mailboxes x
			where x.environment_id = '92400000-0000-4000-8000-000000000020')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_mail_threads x
			where x.environment_id = '92400000-0000-4000-8000-000000000020')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_mail_received x
			where x.environment_id = '92400000-0000-4000-8000-000000000020')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_company_mail_outbox x
			where x.environment_id = '92400000-0000-4000-8000-000000000020')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_mail_thread_reads x
			join public.qorpera_mail_threads t on t.id = x.thread_id where t.environment_id = '92400000-0000-4000-8000-000000000020')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_room_drafts x
			join public.qorpera_company_rooms r on r.id = x.room_id where r.profile_id = '92400000-0000-4000-8000-000000000010')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_interface_supervisions x
			where x.environment_id = '92400000-0000-4000-8000-000000000020')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_execution_sponsor_bindings x
			where x.profile_id = '92400000-0000-4000-8000-000000000010')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_execution_sponsor_versions x
			join public.qorpera_execution_sponsor_bindings b on b.id = x.binding_id
			where b.profile_id = '92400000-0000-4000-8000-000000000010')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_execution_sponsor_handoffs x
			join public.qorpera_execution_runs run on run.id = x.run_id where run.profile_id = '92400000-0000-4000-8000-000000000010')),
		pg_temp.km_rows((select jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text) from public.qorpera_routine_payer_changes x
			join public.qorpera_cloud_routines routine on routine.id = x.routine_id
			where routine.profile_id = '92400000-0000-4000-8000-000000000010'))))
$$;

-- The company's mail: the support mailbox, two received messages and the agent's reply in one thread, the owner's read
-- mark and the owner's draft that quotes the thread.
update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support', 'Customer support') \g /dev/null
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.km_first', pg_temp.km_received(1)::text, true) \g /dev/null
select set_config('qorpera_test.km_thread', (select received.thread_id from public.qorpera_mail_received as received
	where received.delivery_id = current_setting('qorpera_test.km_first')::uuid), true) \g /dev/null
select set_config('qorpera_test.km_second', pg_temp.km_received(2, '{"references":"<k1@example.org>"}')::text, true) \g /dev/null
select public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, 'km-reply',
	jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Re: Order 7', 'text', 'Paid today.', 'inReplyTo', current_setting('qorpera_test.km_second'))) \g /dev/null
do $$
declare
	v_thread text := current_setting('qorpera_test.km_thread');
	v_room uuid := pg_temp.base_thread('92400000-0000-4000-8000-000000000030');
begin
	perform pg_temp.base_assert(pg_temp.km_call('92400000-0000-4000-8000-000000000001',
		format('select to_jsonb(public.qorpera_mark_mail_thread_read(%L, %L))', '92400000-0000-4000-8000-000000000020', v_thread))
		= 'true', 'The owner marks the thread read');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_put_room_draft(v_room, '92400000-0000-4000-8000-000000000001', 0, 'About «Order 7» please.',
		jsonb_build_array(jsonb_build_object('start', 7, 'end', 14, 'source', 'mail', 'ref', v_thread)));
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

-- Every kind of mail row is there, and both pages start off.
do $$
declare v_thread text := current_setting('qorpera_test.km_thread');
begin
	perform pg_temp.base_assert((select count(*) from public.qorpera_mail_received where thread_id = v_thread) = 2
		and (select count(*) from public.qorpera_company_mail_outbox where thread = v_thread) = 1
		and (select count(*) from public.qorpera_mail_thread_reads where thread_id = v_thread) = 1
		and (select count(*) from public.qorpera_room_drafts where room_id = pg_temp.base_thread('92400000-0000-4000-8000-000000000030')) = 1
		and (select count(*) from public.qorpera_execution_sponsor_versions v join public.qorpera_execution_sponsor_bindings b
			on b.id = v.binding_id where b.profile_id = '92400000-0000-4000-8000-000000000010') > 0,
		'The company has received and sent mail, a read mark, a draft and a sponsor binding with its versions');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_interface_pages
		where environment_id = '92400000-0000-4000-8000-000000000020'), 'No page has been switched yet');
end $$;

-- The owner switches Mailbox on and off and on, then Members; the admin switches both off and on. After each, nothing
-- else changed, and the owner's list of threads is the same.
do $$
declare
	v_before text := pg_temp.km_data(); v_threads jsonb := pg_temp.km_threads(); v_step record; v_answer jsonb;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_threads -> 'threads') = 1, 'The owner lists the thread');
	for v_step in select * from (values
		(1, '92400000-0000-4000-8000-000000000001'::uuid, 'mailbox', true), (2, '92400000-0000-4000-8000-000000000001'::uuid, 'mailbox', false),
		(3, '92400000-0000-4000-8000-000000000001'::uuid, 'mailbox', true), (4, '92400000-0000-4000-8000-000000000001'::uuid, 'members', true),
		(5, '92400000-0000-4000-8000-000000000001'::uuid, 'members', false), (6, '92400000-0000-4000-8000-000000000004'::uuid, 'mailbox', false),
		(7, '92400000-0000-4000-8000-000000000004'::uuid, 'members', true), (8, '92400000-0000-4000-8000-000000000004'::uuid, 'members', false),
		(9, '92400000-0000-4000-8000-000000000004'::uuid, 'mailbox', true)) as step(n, by_user, page, turn_on) order by n
	loop
		v_answer := pg_temp.km_set(v_step.by_user, v_step.page, v_step.turn_on);
		perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v_answer -> 'pages') as entry(item)
			where entry.item ->> 'page' = v_step.page and (entry.item ->> 'on')::boolean = v_step.turn_on),
			format('Step %s switches %s to %s: %s', v_step.n, v_step.page, v_step.turn_on, v_answer));
		perform pg_temp.base_assert(pg_temp.km_data() = v_before, format('Step %s changes no mail, supervision or payer row', v_step.n));
		perform pg_temp.base_assert(pg_temp.km_threads() = v_threads, format('Step %s: the mail reads as before', v_step.n));
	end loop;
	-- What the switches wrote: the two pages' own rows, and nothing else.
	perform pg_temp.base_assert((select array_agg(page || ':' || enabled order by page) from public.qorpera_interface_pages
		where environment_id = '92400000-0000-4000-8000-000000000020') = array['mailbox:true', 'members:false'],
		'Mailbox is on and Members off, as last switched');
end $$;

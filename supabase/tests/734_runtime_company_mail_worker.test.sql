-- @fixture 385_runtime_workers_todos.test.sql until "-- 4b. A worker's access is kernel authority"
-- Company mail, sending (M2b, 20260929680000): a background worker has no mouth, so it sends no email; its parent,
-- a company agent, does.

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000020', 'support', 'Customer support');
select pg_temp.path_claims('service_role');

select pg_temp.wake_error(format('select public.qorpera_send_agent_mail(%L::jsonb, %L, %L::jsonb)',
	current_setting('qorpera_test.child_binding'), 'worker-mail', jsonb_build_object('from', 'support@mail.example.test',
		'to', jsonb_build_array('customer@example.org'), 'subject', 'Prices', 'text', 'Here are the prices.')),
	'42501', 'Only a company agent sends mail');
select pg_temp.wake_assert(public.qorpera_send_agent_mail(current_setting('qorpera_test.parent_binding')::jsonb,
	'parent-mail', jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Prices', 'text', 'Here are the prices.')) ->> 'status' = 'queued', 'The parent agent sends it');
select pg_temp.wake_assert((select count(*) = 1 and bool_and(call_id = 'parent-mail') from public.qorpera_company_mail_outbox),
	'Only the parent''s email is queued');

rollback;

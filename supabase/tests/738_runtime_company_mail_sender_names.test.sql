-- @fixture 733_runtime_company_mail_sending.test.sql until "-- Requests: closed shapes"
-- Company mail, sender names (20260929810000; founder decision of 1 October 2026): email never looks like it comes
-- from Qorpera. A send is refused when the agent's name, the company's name or the mailbox's local part reads as
-- Qorpera, however it is spelled, and no mailbox is created with such a name. Other names send as before.

-- The helper is no API role's.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_mail_name_reads_as_qorpera(text)', 'EXECUTE') then
			raise exception 'The sender name check is exposed to %', v_role; end if;
	end loop;
end
$$;

-- What reads as Qorpera: case, separators, accents, full width, look-alike letters and digits.
select pg_temp.wake_assert(public.qorpera_mail_name_reads_as_qorpera(name) = expected,
	format('%s reads as Qorpera: %s', name, not expected))
from (values ('Qorpera', true), ('QORPERA Billing', true), ('Support at qorpera', true), ('Q0rpera', true),
	('Qor-pera', true), ('Q o r p e r a', true), (E'Qоrpera', true), (E'Qörpera', true),
	(E'Ｑｏｒｐｅｒａ', true), (E'Qor​pera', true), ('qorp3ra', true),
	('Corpera', false), ('Qorp', false), ('Northwind', false), ('Path gateway fixture', false), ('', false),
	(null, false)) as name_case(name, expected);

-- Mailbox names that read as Qorpera are reserved.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error(format($q$select public.qorpera_create_company_mailbox('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000020', %L, 'Not ours to take')$q$, name), '22023',
	'A mailbox name that reads as Qorpera is reserved')
from unnest(array['qorpera', 'q0rpera-help', 'my.qorpera', 'qor-pera']) as name;
select pg_temp.wake_assert(public.qorpera_create_company_mailbox('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000020', 'corpora', 'A name like it but not it') ->> 'email' = 'corpora@mail.example.test',
	'A name merely like it is a mailbox');
select pg_temp.path_claims('service_role');

-- A send under the agent's or company's name, or from a mailbox, that reads as Qorpera is refused; others go out.
select pg_temp.wake_assert(pg_temp.send('plain', pg_temp.request()) ->> 'fromName' = 'Agent at Path gateway fixture',
	'An ordinary sender sends');
update public.qorpera_profiles set name = 'Q0RPERA Billing' where id = '30000000-0000-4000-8000-000000000010';
select pg_temp.wake_error(format('select pg_temp.send(%L, %L::jsonb)', 'company-name', pg_temp.request()), '42501',
	'Email that would look like it comes from Qorpera is refused; a member renames the company, the agent or the mailbox');
update public.qorpera_profiles set name = 'Path gateway fixture' where id = '30000000-0000-4000-8000-000000000010';
update public.qorpera_profile_staff set display_name = E'Qor​pera support'
where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000030';
select pg_temp.send_error('agent-name', pg_temp.request(), '42501');
update public.qorpera_profile_staff set display_name = 'Agent'
where profile_id = '30000000-0000-4000-8000-000000000010' and staff_agent_id = '30000000-0000-4000-8000-000000000030';
-- A mailbox made before the rule.
update public.qorpera_company_mailboxes set local_part = 'qorpera-help' where local_part = 'a.b' and removed_at is null;
select pg_temp.send_error('mailbox-name', pg_temp.request('qorpera-help'), '42501');
select pg_temp.wake_assert((select count(*) = 1 from public.qorpera_company_mail_outbox), 'Only the ordinary email is queued');

rollback;

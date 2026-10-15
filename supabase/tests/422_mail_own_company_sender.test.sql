-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company mail from Qorpera's own company (20260930475000), on the folder-v2 runtime base: the company that operators name
-- in the mail settings sends under a company or agent name that reads as Qorpera; any other company with such a name is
-- refused, as before; no company sends from, or makes, a mailbox whose name reads as Qorpera; the name is a company's, and
-- it clears when that company goes; the settings stay closed to every API role.

select pg_temp.base_claims('service_role');
create function pg_temp.oc_send(p_call text, p_from text default 'desk@mail.example.test') returns jsonb language sql as $$
	select public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, p_call,
		jsonb_build_object('from', p_from, 'to', jsonb_build_array('customer@example.org'), 'subject', 'Hello',
			'text', 'Thanks for writing.'))
$$;
create function pg_temp.oc_refused(p_call text, p_from text default 'desk@mail.example.test') returns void
language sql as $$
	select pg_temp.base_error(format('select pg_temp.oc_send(%L, %L)', p_call, p_from), '42501',
		'Email that would look like it comes from Qorpera is refused; a member renames the company, the agent or the mailbox')
$$;
create function pg_temp.oc_body(p_call text) returns text language sql as $$
	select body from public.qorpera_company_mail_outbox where call_id = p_call
$$;
create function pg_temp.oc_names(p_company text, p_agent text) returns void language sql as $$
	update public.qorpera_profiles set name = p_company where id = '92400000-0000-4000-8000-000000000010';
	update public.qorpera_profile_staff set display_name = p_agent
	where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '92400000-0000-4000-8000-000000000030';
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	local_part, 'Front desk') from unnest(array['desk', 'old-desk']) as local_part \g /dev/null
select pg_temp.base_claims('service_role');
-- A mailbox made before mailbox names that read as Qorpera were reserved.
update public.qorpera_company_mailboxes set local_part = 'qorpera-desk'
where profile_id = '92400000-0000-4000-8000-000000000010' and local_part = 'old-desk';
-- Another company, for operators to name instead.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('42200000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000001');

-- 1. The settings stay closed, and no company is named until an operator names one ------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_mail_settings', 'SELECT,INSERT,UPDATE,DELETE,REFERENCES')
			or has_column_privilege(v_role, 'public.qorpera_mail_settings', 'own_company_profile_id',
				'SELECT,INSERT,UPDATE,REFERENCES') then
			raise exception 'The mail settings are exposed to %', v_role; end if;
	end loop;
end
$$;
select pg_temp.base_assert((select settings.own_company_profile_id is null from public.qorpera_mail_settings as settings),
	'No company is named until an operator names one');

-- 2. While no company is named, a company or an agent named after the platform is refused --------------------------------

select pg_temp.base_assert(pg_temp.oc_send('oc-plain') ->> 'status' = 'queued', 'An ordinary company sends');
select pg_temp.oc_names('Qorpera', 'Alice');
select pg_temp.oc_refused('oc-company');
select pg_temp.oc_names('Folder runtime base', 'Q0rpera Support');
select pg_temp.oc_refused('oc-agent');

-- 3. Qorpera's own company sends under its own name and its agents' names, never from a mailbox named after the platform --

update public.qorpera_mail_settings set own_company_profile_id = '92400000-0000-4000-8000-000000000010';
select pg_temp.oc_names('Qorpera', 'Q0rpera Support');
select pg_temp.base_assert(receipt ->> 'status' = 'queued' and receipt ->> 'fromName' = 'Q0rpera Support at Qorpera'
		and pg_temp.oc_body('oc-own') like E'%\n\nWritten and sent by Q0rpera Support, an AI agent working for Qorpera.',
	'Qorpera''s own company sends under its own name and its agent''s: ' || receipt::text)
from (select pg_temp.oc_send('oc-own') as receipt) as answer;
select pg_temp.oc_refused('oc-own-mailbox', 'qorpera-desk@mail.example.test');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'qor-pera.team', 'The team')$q$, '22023',
	'A mailbox name that reads as Qorpera is reserved');
select pg_temp.base_claims('service_role');

-- 4. Naming another company takes the exception away; the name is a company's and clears when it goes ------------------

update public.qorpera_mail_settings set own_company_profile_id = '42200000-0000-4000-8000-000000000010';
select pg_temp.oc_refused('oc-not-own');
select pg_temp.base_error($q$update public.qorpera_mail_settings
	set own_company_profile_id = '42200000-0000-4000-8000-0000000000ff'$q$, '23503');
delete from public.qorpera_profiles where id = '42200000-0000-4000-8000-000000000010';
select pg_temp.base_assert((select settings.own_company_profile_id is null from public.qorpera_mail_settings as settings),
	'Deleting the named company clears the name');
select pg_temp.oc_refused('oc-gone');

select pg_temp.oc_names('Folder runtime base', 'Alice');

rollback;

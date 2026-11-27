-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
create function pg_temp.mh_box(p_local_part text, p_profile uuid default '92400000-0000-4000-8000-000000000010',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns text language sql as $$
	select format('select public.qorpera_create_company_mailbox(%L, %L, %L, %L)', p_profile, p_environment, p_local_part,
		'Mail for ' || p_local_part)
$$;
create function pg_temp.mh_agent_box(p_key text, p_local_part text) returns text language sql as $$
	select format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)', current_setting('qorpera_test.base_binding'),
		jsonb_build_object('action', 'create', 'kind', 'mailbox', 'operationKey', p_key, 'localPart', p_local_part,
			'purpose', 'Mail for ' || p_local_part))
$$;
create function pg_temp.mh_owner(p_handle text) returns uuid language sql as $$
	select profile_id from public.qorpera_company_mail_handles where handle = p_handle
$$;
create function pg_temp.mh_status(p_handle text) returns text language sql as $$
	select public.qorpera_company_mail_handle_status('92400000-0000-4000-8000-000000000010', p_handle)
$$;
create function pg_temp.mh_question(p_payload jsonb) returns boolean language sql as $$
	select public.qorpera_interaction_request_valid(jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'question',
		'title', 'Your company''s email address', 'payload', p_payload))
$$;

select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
update auth.users set raw_user_meta_data = jsonb_build_object('display_name', 'Olivia Owner')
where id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'mh-ack') \g /dev/null

select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12930000-0000-4000-8000-000000000010', 'Nordlys ApS', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12930000-0000-4000-8000-000000000020', '12930000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_mailboxes(hook_id, profile_id, environment_id, local_part, removed_at) values
	('12930000-0000-4000-8000-000000000031', '12930000-0000-4000-8000-000000000010', '12930000-0000-4000-8000-000000000020',
		'brooks', null),
	('12930000-0000-4000-8000-000000000032', '12930000-0000-4000-8000-000000000010', '12930000-0000-4000-8000-000000000020',
		'info.fjord', null),
	('12930000-0000-4000-8000-000000000033', '12930000-0000-4000-8000-000000000010', '12930000-0000-4000-8000-000000000020',
		'gone', clock_timestamp());
select set_config('session_replication_role', 'origin', true);
insert into public.qorpera_company_mail_handles(handle, profile_id)
values ('nordlys', '12930000-0000-4000-8000-000000000010');

select pg_temp.base_error($$insert into public.qorpera_company_mail_handles(handle, profile_id)
	values ('a', '12930000-0000-4000-8000-000000000010')$$, '23514');
select pg_temp.base_error($$insert into public.qorpera_company_mail_handles(handle, profile_id)
	values ('ab-', '12930000-0000-4000-8000-000000000010')$$, '23514');
select pg_temp.base_error($$insert into public.qorpera_company_mail_handles(handle, profile_id)
	values ('nordlys', '92400000-0000-4000-8000-000000000010')$$, '23505');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
do $$
declare c_shape constant text := 'A new address is the company''s handle or a name, a dot and the handle, like acme or sales.acme';
begin
	perform pg_temp.base_error(pg_temp.mh_box('a'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('under_score'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('a.b.base'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box(repeat('b', 40) || '.base'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('hello.' || repeat('h', 25)), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('hello.b'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('hello.under_score'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('hello-.base'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.mh_box('Hello.base'), '22023',
		'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores');
	perform pg_temp.base_error(pg_temp.mh_box('postmaster.base'), '22023', 'This mailbox name is reserved');
	perform pg_temp.base_error(pg_temp.mh_box('hello.admin'), '22023', 'This mailbox name is reserved');
	perform pg_temp.base_error(pg_temp.mh_box('hello.q0rpera'), '22023', 'A mailbox name that reads as Qorpera is reserved');
	perform pg_temp.base_error(pg_temp.mh_box('qor.pera'), '22023', 'A mailbox name that reads as Qorpera is reserved');
	perform pg_temp.base_error(pg_temp.mh_box('hello.nordlys'), '23505', 'This address is taken');
	perform pg_temp.base_error(pg_temp.mh_box('hello.brooks'), '23505', 'This address is taken');
	perform pg_temp.base_error(pg_temp.mh_box('hello.fjord'), '23505', 'This address is taken');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_mail_handles
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'a refused address claims no handle');
end $$;

select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'support.base', 'Customer support') \g /dev/null
select pg_temp.base_assert((select profile_id = '92400000-0000-4000-8000-000000000010'
		and claimed_by_user_id = '92400000-0000-4000-8000-000000000001' from public.qorpera_company_mail_handles
		where handle = 'base'), 'the owner''s first address claims its handle for the company');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'team_eu.base', 'Europe') \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000004');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'hello.gone', 'A handle another company''s removed address once used') \g /dev/null
select pg_temp.base_assert(pg_temp.mh_owner('gone') = '92400000-0000-4000-8000-000000000010'
	and (select claimed_by_user_id from public.qorpera_company_mail_handles where handle = 'gone')
		= '92400000-0000-4000-8000-000000000004', 'an admin claims a free handle');
select pg_temp.base_error(pg_temp.mh_box('support.base'), '23505', 'This address is taken');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_error(pg_temp.mh_box('sales.base'), '42501', 'Only owners and admins can create mailboxes');
select pg_temp.base_error(pg_temp.mh_box('sales.contrib'), '42501', 'Only owners and admins can create mailboxes');
select pg_temp.base_assert(pg_temp.mh_owner('contrib') is null, 'a contributor claims nothing');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error(pg_temp.mh_box('hello.outsider'), '42501', 'Only owners and admins can create mailboxes');

select pg_temp.base_claims('service_role');
do $$
declare r jsonb;
begin
	perform pg_temp.base_error(pg_temp.mh_agent_box('mh-agent-1', 'desk'), '22023',
		'A new address is a name, a dot and the company''s handle, like hello.acme');
	perform pg_temp.base_error(pg_temp.mh_agent_box('mh-agent-2', 'desk.newco'), '42501',
		'Only a member can choose the company''s email handle');
	perform pg_temp.base_error(pg_temp.mh_agent_box('mh-agent-3', 'desk.nordlys'), '23505', 'This address is taken');
	perform pg_temp.base_error(pg_temp.mh_agent_box('mh-agent-4', 'desk.brooks'), '23505', 'This address is taken');
	perform pg_temp.base_error(pg_temp.mh_agent_box('mh-agent-5', 'abuse.base'), '22023', 'This mailbox name is reserved');
	perform pg_temp.base_assert(pg_temp.mh_owner('newco') is null, 'an agent claims no handle');
	execute pg_temp.mh_agent_box('mh-agent-6', 'desk.base') into r;
	perform pg_temp.base_assert(r -> 'hook' ->> 'email' = 'desk.base@mail.example.test'
		and (select created_by_user_id is null from public.qorpera_company_mailboxes
			where local_part = 'desk.base' and removed_at is null), 'an agent adds an address under the company''s handle: ' || r::text);
end $$;

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'team_eu.base' and removed_at is null), 'removed') \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(pg_temp.mh_status(handle) = expected, format('%s reads %s, not %s', handle, pg_temp.mh_status(handle), expected))
from (values ('base', 'ours'), ('gone', 'ours'), ('nordlys', 'taken'), ('brooks', 'taken'), ('fjord', 'taken'),
	('newco', 'free'), (repeat('a', 24), 'free'), ('a-b', 'free'), (repeat('a', 25), 'invalid'), ('a', 'invalid'),
	('-ab', 'invalid'), ('ab-', 'invalid'), ('Acme', 'invalid'), ('a.b', 'invalid'), ('admin', 'invalid'),
	('no-reply', 'invalid'), ('q0rpera', 'invalid'), ('teamqorpera', 'invalid'), (null, 'invalid')) as cases(handle, expected);
select pg_temp.base_assert(public.qorpera_company_mail_handles('92400000-0000-4000-8000-000000000010')
		= '{"domain":"mail.example.test","handles":["base","gone"]}'::jsonb,
	'a member reads the company''s handles, oldest first: '
		|| public.qorpera_company_mail_handles('92400000-0000-4000-8000-000000000010')::text);
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'hello.third', 'A third handle') \g /dev/null
select pg_temp.base_error(pg_temp.mh_box('hello.fourth'), '54000', 'A company has at most 3 email handles');
select pg_temp.base_assert(pg_temp.mh_owner('fourth') is null, 'a refused fourth handle is not claimed');
select public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
	where local_part = 'hello.third' and removed_at is null), 'removed') \g /dev/null
select pg_temp.base_error(pg_temp.mh_box('hello.fifth'), '54000', 'A company has at most 3 email handles');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'sales.third', 'An owned handle stays usable past the cap') \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error($$select public.qorpera_company_mail_handle_status('92400000-0000-4000-8000-000000000010', 'base')$$,
	'42501', 'Company mail addresses are unavailable');
select pg_temp.base_error($$select public.qorpera_company_mail_handles('92400000-0000-4000-8000-000000000010')$$,
	'42501', 'Company mail addresses are unavailable');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_error($$select handle from public.qorpera_company_mail_handles$$, '42501');
select pg_temp.base_error($$select public.qorpera_mail_admit_local_part('92400000-0000-4000-8000-000000000010', 'x.base', auth.uid())$$,
	'42501');
select pg_temp.base_assert(pg_temp.mh_status('base') = 'ours', 'the status is an authenticated member''s call');
reset role;
select pg_temp.base_claims('anon');
set local role anon;
select pg_temp.base_error($$select public.qorpera_company_mail_handles('92400000-0000-4000-8000-000000000010')$$, '42501');
reset role;

select pg_temp.base_claims('service_role');
select pg_temp.base_assert(public.qorpera_mail_company_short_name(name) is not distinct from expected,
	format('%L shortens to %L, not %L', name, public.qorpera_mail_company_short_name(name), expected))
from (values (null, null), ('', null), (' 	 ', null), ('No name yet', null), ('Brooks', 'Brooks'),
	('Nordlys ApS', 'Nordlys'), ('Nordlys aps', 'Nordlys'), ('Acme, Inc.', 'Acme'), ('Acme Inc', 'Acme'), ('Fjord GmbH', 'Fjord'),
	('Holding A/S ApS', 'Holding'), ('ApS', 'ApS'), ('Ltd. Ltd.', 'Ltd.'), ('Apsis', 'Apsis'), ('Sa Sa Sa', 'Sa'),
	('  Acme  "Best"  <Shop> ', 'Acme Best Shop'), ('Line' || chr(10) || 'break', 'Line break'),
	(repeat('x', 40), repeat('x', 40)),
	('The Nordic Coffee Roasters and Bakery of Copenhagen', 'The Nordic Coffee Roasters and Bakery…'),
	('The Nordic Coffee Roasters and Bakery of Copenhagen ApS', 'The Nordic Coffee Roasters and Bakery…'),
	('Ab ' || repeat('x', 45), 'Ab ' || repeat('x', 36) || '…'),
	(repeat('a', 20) || ', ' || repeat('b', 30), repeat('a', 20) || '…'),
	(repeat('a', 18) || ' ' || repeat('b', 30), repeat('a', 18) || ' ' || repeat('b', 20) || '…')) as cases(name, expected);

create function pg_temp.mh_member_send(p_n integer) returns public.qorpera_company_mail_outbox language plpgsql as $$
declare v_mail public.qorpera_company_mail_outbox;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform public.qorpera_send_member_mail('92400000-0000-4000-8000-000000000020', jsonb_build_object(
		'sendId', '12930000-0000-4000-8000-' || lpad(p_n::text, 12, '0'), 'from', 'support.base@mail.example.test',
		'to', jsonb_build_array('customer@example.org'), 'subject', 'Hello', 'text', 'Hello ' || p_n));
	perform pg_temp.base_claims('service_role');
	select * into v_mail from public.qorpera_company_mail_outbox
	where member_send_id = ('12930000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
	return v_mail;
end $$;
create function pg_temp.mh_agent_send(p_call text) returns public.qorpera_company_mail_outbox language plpgsql as $$
declare v_mail public.qorpera_company_mail_outbox;
begin
	perform public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, p_call,
		jsonb_build_object('from', 'support.base@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
			'subject', 'From the agent', 'text', 'Reply ' || p_call));
	select * into v_mail from public.qorpera_company_mail_outbox where call_id = p_call;
	return v_mail;
end $$;
create function pg_temp.mh_agent_name() returns text language sql as $$
	select display_name from public.qorpera_profile_staff where staff_agent_id = '92400000-0000-4000-8000-000000000030'
$$;

do $$
declare v_mail public.qorpera_company_mail_outbox; v_agent text := pg_temp.mh_agent_name();
begin
	v_mail := pg_temp.mh_member_send(1);
	perform pg_temp.base_assert(v_mail.from_name = 'Olivia Owner at Folder runtime base', 'a member''s From: ' || v_mail.from_name);
	v_mail := pg_temp.mh_agent_send('mh-send-1');
	perform pg_temp.base_assert(v_mail.from_name = v_agent || ' at Folder runtime base'
		and v_mail.body like E'%\n\nWritten and sent by ' || v_agent || ', an AI agent working for Folder runtime base.',
		'an agent''s From and AI line: ' || to_jsonb(v_mail)::text);
	update public.qorpera_profiles set name = 'The Nordic Coffee Roasters and Bakery of Copenhagen ApS'
	where id = '92400000-0000-4000-8000-000000000010';
	v_mail := pg_temp.mh_member_send(2);
	perform pg_temp.base_assert(v_mail.from_name = 'Olivia Owner at The Nordic Coffee Roasters and Bakery…',
		'a long name is shortened in a member''s From: ' || v_mail.from_name);
	v_mail := pg_temp.mh_agent_send('mh-send-2');
	perform pg_temp.base_assert(v_mail.from_name = v_agent || ' at The Nordic Coffee Roasters and Bakery…'
		and v_mail.body like E'%an AI agent working for The Nordic Coffee Roasters and Bakery of Copenhagen ApS.',
		'the AI line names the whole name: ' || to_jsonb(v_mail)::text);
	update public.qorpera_profiles set name = 'No name yet' where id = '92400000-0000-4000-8000-000000000010';
	v_mail := pg_temp.mh_member_send(3);
	perform pg_temp.base_assert(v_mail.from_name = 'Olivia Owner', 'an unnamed company''s member From: ' || v_mail.from_name);
	v_mail := pg_temp.mh_agent_send('mh-send-3');
	perform pg_temp.base_assert(v_mail.from_name = v_agent
		and v_mail.body like E'%\n\nWritten and sent by ' || v_agent || ', an AI agent working for a new company.',
		'an unnamed company''s agent From and AI line: ' || to_jsonb(v_mail)::text);
	update public.qorpera_profiles set name = 'Nordlys ' || repeat('Kaffe ', 14) || 'Bar'
	where id = '92400000-0000-4000-8000-000000000010';
	v_mail := pg_temp.mh_agent_send('mh-send-5');
	perform pg_temp.base_assert(v_mail.from_name = v_agent || ' at Nordlys Kaffe Kaffe Kaffe Kaffe Kaffe…'
		and v_mail.body like E'%an AI agent working for Nordlys ' || repeat('Kaffe ', 14) || 'Bar.',
		'a name past 64 characters is whole in the AI line: ' || to_jsonb(v_mail)::text);
	update public.qorpera_profiles set name = repeat('Nordlys ', 9) || 'Qorpera' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.base_error($q$select pg_temp.mh_agent_send('mh-send-6')$q$, '42501');
	perform pg_temp.base_error($q$select pg_temp.mh_member_send(6)$q$, '42501');
	update public.qorpera_profiles set name = 'Q0rpera Labs' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.base_error($q$select pg_temp.mh_agent_send('mh-send-4')$q$, '42501');
	update public.qorpera_profiles set name = 'Folder runtime base' where id = '92400000-0000-4000-8000-000000000010';
end $$;

do $$
begin
	perform pg_temp.base_assert(pg_temp.mh_question('{"options":[{"label":"acme","value":"acme"}],"allowCustom":true,
		"input":{"kind":"mail_address"}}'), 'an address card is a question');
	perform pg_temp.base_assert(pg_temp.mh_question('{"options":[{"label":"acme","value":"acme"}],"allowCustom":true}'),
		'a question without input stays valid');
	perform pg_temp.base_assert(not pg_temp.mh_question(p), 'refused: ' || p::text)
	from unnest(array[
		'{"options":[{"label":"acme","value":"acme"}],"input":{"kind":"mail_address"}}',
		'{"options":[{"label":"acme","value":"acme"}],"allowCustom":false,"input":{"kind":"mail_address"}}',
		'{"options":[{"label":"acme","value":"acme"}],"allowCustom":true,"input":{"kind":"phone"}}',
		'{"options":[{"label":"acme","value":"acme"}],"allowCustom":true,"input":{"kind":"mail_address","domain":"x"}}',
		'{"options":[{"label":"acme","value":"acme"}],"allowCustom":true,"input":"mail_address"}',
		'{"options":[{"label":"acme","value":"acme"}],"allowCustom":true,"input":null}',
		'{"options":[{"label":"acme","value":"acme"}],"allowCustom":true,"other":{"kind":"mail_address"}}']::jsonb[]) as p;
end $$;

insert into auth.users(id, email, email_confirmed_at) values
	('12930000-0000-4000-8000-000000000001', 'unnamed-founder@example.test', clock_timestamp());
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', '12930000-0000-4000-8000-000000000001',
	'email', 'unnamed-founder@example.test')::text, true) \g /dev/null
set local role authenticated;
do $$
declare v_table jsonb; v_profile uuid; v_name text; v_revision bigint;
begin
	foreach v_name in array array[null, '', '   ', chr(160) || chr(12288) || ' '] loop
		v_table := public.qorpera_open_company_founding(extensions.gen_random_uuid(), v_name);
		perform pg_temp.base_assert(v_table ->> 'companyName' = 'No name yet' and v_table ->> 'phase' = 'open',
			format('%L opens a company with no name yet: %s', v_name, v_table));
	end loop;
	v_table := public.qorpera_open_company_founding('12930000-0000-4000-8000-000000000100', null);
	v_profile := (v_table ->> 'profileId')::uuid;
	perform pg_temp.base_assert(public.qorpera_open_company_founding('12930000-0000-4000-8000-000000000100', '  ')
		->> 'profileId' = v_profile::text, 'a blank name opens the same company again');
	perform pg_temp.base_error(format('select public.qorpera_open_company_founding(%L, %L)', extensions.gen_random_uuid(),
		repeat('n', 121)), '22023', 'Company details are invalid');
	perform pg_temp.base_error(format('select public.qorpera_open_company_founding(%L, %L)', null, 'Nordlys'), '22023',
		'Company details are invalid');
	v_revision := (v_table ->> 'revision')::bigint;
	v_table := public.qorpera_update_company_founding(v_profile, v_revision, 'Nordlys Kaffe', '');
	perform pg_temp.base_assert(v_table ->> 'companyName' = 'Nordlys Kaffe', 'a founder names the company: ' || v_table::text);
	v_table := public.qorpera_update_company_founding(v_profile, v_revision + 1, chr(160) || ' ', '');
	perform pg_temp.base_assert(v_table ->> 'companyName' = 'No name yet'
		and (v_table ->> 'revision')::bigint = v_revision + 2, 'a blank name means no name yet: ' || v_table::text);
	perform pg_temp.base_error(format('select public.qorpera_update_company_founding(%L, %s, %L, %L)', v_profile, v_revision + 2,
		E'Nordlys\tKaffe', ''), '22023', 'Company details are invalid');
end $$;
reset role;

rollback;

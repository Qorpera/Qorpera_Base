-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
create function pg_temp.bh_box(p_local_part text, p_profile uuid default '92400000-0000-4000-8000-000000000010',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns text language sql as $$
	select format('select public.qorpera_create_company_mailbox(%L, %L, %L, %L)', p_profile, p_environment, p_local_part,
		'Mail for ' || p_local_part)
$$;
create function pg_temp.bh_agent_box(p_key text, p_local_part text) returns text language sql as $$
	select format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)', current_setting('qorpera_test.base_binding'),
		jsonb_build_object('action', 'create', 'kind', 'mailbox', 'operationKey', p_key, 'localPart', p_local_part,
			'purpose', 'Mail for ' || p_local_part))
$$;

select pg_temp.base_claims('service_role');
update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'bh-ack') \g /dev/null

select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('14080000-0000-4000-8000-000000000010', 'Other Co ApS', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('14080000-0000-4000-8000-000000000020', '14080000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('14080000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000005', 'other-owner@example.test', 'Other Owner', 'owner');
select set_config('session_replication_role', 'origin', true);

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
do $$
declare
	c_shape constant text := 'A new address is the company''s handle or a name, a dot and the handle, like acme or sales.acme';
	v_box jsonb;
begin
	perform pg_temp.base_error(pg_temp.bh_box('x'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.bh_box(repeat('a', 25)), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.bh_box('my_co'), '22023', c_shape);
	perform pg_temp.base_error(pg_temp.bh_box('-co'), '22023',
		'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores');
	perform pg_temp.base_error(pg_temp.bh_box('co-'), '22023',
		'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores');
	perform pg_temp.base_error(pg_temp.bh_box('admin'), '22023', 'This mailbox name is reserved');
	perform pg_temp.base_error(pg_temp.bh_box('q0rpera'), '22023', 'A mailbox name that reads as Qorpera is reserved');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_mail_handles
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'refused bare handles claim nothing');

	v_box := public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'namah', 'The company''s main email');
	perform pg_temp.base_assert(v_box ->> 'email' = 'namah@mail.example.test' and v_box ->> 'name' = 'mail-namah',
		'owner creates bare handle mailbox: ' || v_box::text);
	perform pg_temp.base_assert((select profile_id = '92400000-0000-4000-8000-000000000010'
			and claimed_by_user_id = '92400000-0000-4000-8000-000000000001'
		from public.qorpera_company_mail_handles where handle = 'namah'),
		'bare handle mailbox claims its handle');
	perform pg_temp.base_assert(public.qorpera_company_mail_handle_status('92400000-0000-4000-8000-000000000010', 'namah') = 'ours',
		'claimed bare handle reports ours');
	perform pg_temp.base_error(pg_temp.bh_box('namah'), '23505', 'This address is taken');

	v_box := public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'invoices.namah', 'Invoices');
	perform pg_temp.base_assert(v_box ->> 'email' = 'invoices.namah@mail.example.test',
		'member adds dotted address under bare-claimed handle: ' || v_box::text);

	perform public.qorpera_set_event_hook_status((select hook_id from public.qorpera_company_mailboxes
		where local_part = 'namah' and removed_at is null), 'removed');
	v_box := public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'namah', 'Restored main email');
	perform pg_temp.base_assert(v_box ->> 'email' = 'namah@mail.example.test',
		'removing and recreating bare handle succeeds under owned handle');

	perform public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'sales.second', 'Second handle via dotted address');
	v_box := public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'second', 'Bare address under existing handle');
	perform pg_temp.base_assert(v_box ->> 'email' = 'second@mail.example.test',
		'bare address works for a handle already claimed by a dotted address');

	perform public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'third', 'Third handle');
	perform pg_temp.base_error(pg_temp.bh_box('fourth'), '54000', 'A company has at most 3 email handles');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_mail_handles where handle = 'fourth'),
		'fourth bare handle is not claimed');
end $$;

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_error(pg_temp.bh_box('contrib-bare'), '42501', 'Only owners and admins can create mailboxes');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_company_mail_handles where handle = 'contrib-bare'),
	'contributor claims no bare handle');

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_assert(public.qorpera_company_mail_handle_status('14080000-0000-4000-8000-000000000010', 'namah') = 'taken',
	'another company sees bare-claimed handle as taken');
select pg_temp.base_error(pg_temp.bh_box('namah', '14080000-0000-4000-8000-000000000010',
	'14080000-0000-4000-8000-000000000020'), '23505', 'This address is taken');
select pg_temp.base_error(pg_temp.bh_box('hello.namah', '14080000-0000-4000-8000-000000000010',
	'14080000-0000-4000-8000-000000000020'), '23505', 'This address is taken');

select pg_temp.base_claims('service_role');
do $$
declare r jsonb;
begin
	perform pg_temp.base_error(pg_temp.bh_agent_box('bh-agent-1', 'namah'), '22023',
		'A new address is a name, a dot and the company''s handle, like hello.acme');
	execute pg_temp.bh_agent_box('bh-agent-2', 'support.namah') into r;
	perform pg_temp.base_assert(r -> 'hook' ->> 'email' = 'support.namah@mail.example.test',
		'agent adds dotted address under bare-claimed handle: ' || r::text);
end $$;

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_error($$select public.qorpera_mail_admit_local_part('92400000-0000-4000-8000-000000000010', 'namah', auth.uid())$$,
	'42501');
reset role;

rollback;

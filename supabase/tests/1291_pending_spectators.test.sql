-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
create function pg_temp.ps_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_out text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute p_sql into v_out;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_out;
exception when others then
	reset role;
	perform pg_temp.base_claims('service_role');
	raise;
end $$;
create function pg_temp.ps_refused(p_user uuid, p_sql text, p_state text) returns boolean language plpgsql as $$
begin
	perform pg_temp.ps_as(p_user, p_sql);
	return false;
exception when others then
	return sqlstate = p_state;
end $$;

do $$
declare
	v_owner uuid := '92400000-0000-4000-8000-000000000001';
	v_member uuid := '92400000-0000-4000-8000-000000000002';
	v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_admin uuid := '92400000-0000-4000-8000-000000000004';
	v_outsider uuid := '92400000-0000-4000-8000-000000000005';
	v_profile text := '''92400000-0000-4000-8000-000000000010''';
	v_again text;
begin
	perform pg_temp.base_assert(pg_temp.ps_as(v_owner, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array['' Mom@Example.test '', ''dad@example.test'', ''mom@example.test''])::text')
		= '{mom@example.test,dad@example.test}', 'an owner adds spectators, each once, in lower case');
	perform pg_temp.base_assert(pg_temp.ps_as(v_admin, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''gran@example.test''])::text') = '{mom@example.test,dad@example.test,gran@example.test}',
		'an admin adds them too');
	perform pg_temp.base_assert(pg_temp.ps_refused(v_member, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''x@example.test''])::text', '42501')
		and pg_temp.ps_refused(v_viewer, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''x@example.test''])::text', '42501')
		and pg_temp.ps_refused(v_outsider, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''x@example.test''])::text', '42501'), 'contributors, viewers and outsiders add none');
	perform pg_temp.base_assert(pg_temp.ps_refused(v_owner, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''not an email''])::text', '23514'), 'a malformed email is refused');
	perform pg_temp.base_assert(pg_temp.ps_as(v_member, 'select cardinality(public.qorpera_list_pending_spectators('
		|| v_profile || '))::text') = '3' and pg_temp.ps_as(v_outsider,
		'select cardinality(public.qorpera_list_pending_spectators(' || v_profile || '))::text') = '0',
		'members read the list, outsiders read nothing');
	perform pg_temp.base_assert(pg_temp.ps_refused(v_member, 'select public.qorpera_invite_pending_spectators('
		|| v_profile || ')::text', '42501') and pg_temp.ps_refused(v_viewer,
		'select public.qorpera_invite_pending_spectators(' || v_profile || ')::text', '42501'),
		'only an owner or admin sends the invites');

	insert into public.qorpera_company_foundings(profile_id, created_by_user_id, phase, vision_draft)
	values ('92400000-0000-4000-8000-000000000010', v_owner, 'open', '');
	perform pg_temp.base_assert(pg_temp.ps_as(v_owner, 'select public.qorpera_invite_pending_spectators('
		|| v_profile || ')::text') = '{}' and (select count(*) from public.qorpera_pending_spectators) = 3
		and not exists (select 1 from public.qorpera_profile_invitations where email like '%@example.test'
			and email in ('mom@example.test', 'dad@example.test', 'gran@example.test')),
		'nothing is sent while the founding table is open');
	delete from public.qorpera_company_foundings where profile_id = '92400000-0000-4000-8000-000000000010';

	perform pg_temp.ps_as(v_owner, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''base-member@example.test''])::text');
	perform pg_temp.base_assert(pg_temp.ps_as(v_owner, 'select public.qorpera_invite_pending_spectators('
		|| v_profile || ')::text') = '{mom@example.test,dad@example.test,gran@example.test}',
		'after Start each is invited, and a member already there counts as done');
	perform pg_temp.base_assert((select count(*) from public.qorpera_profile_invitations
		where profile_id = '92400000-0000-4000-8000-000000000010' and role = 'viewer'
			and email in ('mom@example.test', 'dad@example.test', 'gran@example.test')) = 3,
		'as viewers');
	perform pg_temp.base_assert((select count(*) from public.qorpera_pending_spectators) = 0, 'and the list is empty');

	perform pg_temp.ps_as(v_owner, 'select public.qorpera_add_pending_spectators(' || v_profile
		|| ', array[''mom@example.test''])::text');
	v_again := pg_temp.ps_as(v_admin, 'select public.qorpera_invite_pending_spectators(' || v_profile || ')::text');
	perform pg_temp.base_assert(v_again = '{}' and (select count(*) from public.qorpera_pending_spectators) = 0
		and (select count(*) from public.qorpera_profile_invitations
			where profile_id = '92400000-0000-4000-8000-000000000010' and email = 'mom@example.test') = 1,
		'an invitation already out counts as done and leaves the list');

	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_add_pending_spectators(uuid,text[])', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_pending_spectators(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_invite_pending_spectators(uuid)', 'execute')
		and not has_table_privilege('authenticated', 'public.qorpera_pending_spectators', 'select'),
		'no anonymous calls, and the table is closed');
end $$;

rollback;

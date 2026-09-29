-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Deleting an account removes only what is the person's own (20260928249180). A delete on auth.users
-- never deletes company data; the last founder of a company with others and the only member of a
-- company are refused; a company being deleted lets its members go; plan records stay. The fixture
-- company has its creator and only founder (…001), a contributor (…002) and a viewer (…003), with
-- agents, conversations and runs.
reset role;

create function pg_temp.acct_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'account deletion: %', p_what; end if;
end
$$;
-- Runs p_sql and expects a refusal with one of p_states (and p_message as a prefix, when given);
-- the refused statement's changes are undone.
create function pg_temp.acct_refused(p_sql text, p_states text[], p_message text, p_what text)
returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_state = any(p_states) and (p_message is null or v_message like p_message || '%') then return; end if;
		raise exception 'account deletion: % refused with % %, expected % %', p_what, v_state, v_message, p_states, p_message;
	end;
	raise exception 'account deletion: not refused: %', p_what;
end
$$;
create function pg_temp.acct_as(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

-- The seven links refuse the deletion, and no cascade from an account reaches company data or plan
-- records any more.
select pg_temp.acct_assert(count(*) = 7 and bool_and(link.confdeltype = 'r'), 'the seven account links refuse')
from pg_catalog.pg_constraint as link
where link.confrelid = 'auth.users'::regclass and link.conname in ('qorpera_profiles_created_by_user_id_fkey',
	'qorpera_company_environments_created_by_user_id_fkey', 'qorpera_company_foundings_created_by_user_id_fkey',
	'qorpera_shared_sessions_created_by_user_id_fkey', 'qorpera_session_inputs_author_user_id_fkey',
	'qorpera_account_entitlements_user_id_fkey', 'qorpera_account_entitlement_changes_user_id_fkey');
-- An account deletion reaches only these tables of the person's own; a new cascade from an account
-- must be classified here (company data or plan records never cascade).
with recursive reached(table_id) as (
	select link.conrelid from pg_catalog.pg_constraint as link
	where link.contype = 'f' and link.confrelid = 'auth.users'::regclass and link.confdeltype = 'c'
	union
	select link.conrelid from pg_catalog.pg_constraint as link
	join reached on link.confrelid = reached.table_id
	where link.contype = 'f' and link.confdeltype = 'c'
)
select pg_temp.acct_assert(not exists (
	select table_id::regclass::text from reached
	except
	select unnest(array['qorpera_company_creation_requests', 'qorpera_company_founder_seats', 'qorpera_friendships',
		'qorpera_member_email_actions', 'qorpera_member_email_drafts', 'qorpera_member_notifications',
		'qorpera_member_pictures', 'qorpera_member_session_accounts', 'qorpera_member_sidebar_agents',
		'qorpera_member_sidebar_rooms', 'qorpera_native_presence_devices', 'qorpera_presence_devices',
		'qorpera_product_feedback', 'qorpera_profile_access_state', 'qorpera_profile_invitation_deliveries',
		'qorpera_profile_invitations', 'qorpera_profile_members', 'qorpera_review_rules', 'qorpera_room_drafts',
		'qorpera_runtime_browser_membership_revocations', 'qorpera_runtime_office_wake_requests'])
), 'an account deletion reaches a table that is not the person''s own');
select pg_temp.acct_assert(not has_function_privilege(role_name, 'public.qorpera_guard_founder_departure()', 'EXECUTE'),
	'the founder guard is callable by no API role') from unnest(array['anon', 'authenticated', 'service_role']) role_name;

-- A member whose only trace is one message in a conversation: refused, and the message stays (before,
-- the message went with the account).
insert into auth.users(id, email) values
	('72000000-0000-4000-8000-000000000006', 'acct-talker@example.test'),
	('72000000-0000-4000-8000-000000000007', 'acct-left@example.test'),
	('72000000-0000-4000-8000-000000000008', 'acct-stays@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('30000000-0000-4000-8000-000000000010', '72000000-0000-4000-8000-000000000006', 'acct-talker@example.test', 'Talker', 'contributor');
insert into public.qorpera_session_inputs(session_id, client_input_id, author_user_id, body)
values ('30000000-0000-4000-8000-000000000040', '72000000-0000-4000-8000-000000000042', '72000000-0000-4000-8000-000000000006',
	'{"text":"Hello"}');
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000006'$q$, array['23503'],
	'update or delete on table "users" violates foreign key constraint "qorpera_session_inputs_author_user_id_fkey"',
	'deleting a member whose message is in a conversation');
select pg_temp.acct_assert(exists (select 1 from public.qorpera_session_inputs
	where author_user_id = '72000000-0000-4000-8000-000000000006'), 'the message stays');

-- A company whose creator has left and has nothing else in it: refused, and the company stays (before,
-- the company went with the account).
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('72000000-0000-4000-8000-000000000011', 'Creator left', '72000000-0000-4000-8000-000000000007');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('72000000-0000-4000-8000-000000000011', '72000000-0000-4000-8000-000000000008', 'acct-stays@example.test', 'Stays', 'owner');
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000007'$q$, array['23503'],
	'update or delete on table "users" violates foreign key constraint "qorpera_profiles_created_by_user_id_fkey"',
	'deleting the creator of a company they have left');
select pg_temp.acct_assert(exists (select 1 from public.qorpera_profile_members
	where profile_id = '72000000-0000-4000-8000-000000000011'), 'the company stays with its founder');

-- The creator and only founder, with others in the company and a history in it: refused, and the
-- company keeps everything.
create temp table acct_before on commit drop as
select (select count(*) from public.qorpera_profile_members where profile_id = '30000000-0000-4000-8000-000000000010') as members,
	(select count(*) from public.qorpera_shared_sessions where profile_id = '30000000-0000-4000-8000-000000000010') as sessions,
	(select count(*) from public.qorpera_session_inputs input join public.qorpera_shared_sessions session on session.id = input.session_id
		where session.profile_id = '30000000-0000-4000-8000-000000000010') as inputs,
	(select count(*) from public.qorpera_execution_runs where profile_id = '30000000-0000-4000-8000-000000000010') as runs;
select pg_temp.acct_assert(sessions > 0 and runs > 0, 'the fixture company has conversations and runs') from acct_before;
select pg_temp.acct_refused($q$delete from auth.users where id = '30000000-0000-4000-8000-000000000001'$q$,
	array['23503', '42501'], null, 'deleting the creator and only founder');

-- With a co-founder, the creator can leave; their account still cannot be erased, because the company
-- and its history name them, and the company stays whole.
select pg_temp.acct_as('30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000002', 'owner');
reset role;
select pg_temp.acct_refused($q$delete from auth.users where id = '30000000-0000-4000-8000-000000000001'$q$,
	array['23503'], null, 'deleting the creator while a co-founder stays');
select pg_temp.acct_as('30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000010');
reset role;
select pg_temp.acct_refused($q$delete from auth.users where id = '30000000-0000-4000-8000-000000000001'$q$,
	array['23503'], null, 'deleting a creator who has left');
select pg_temp.acct_assert(
	exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010')
	and (select count(*) from public.qorpera_shared_sessions where profile_id = '30000000-0000-4000-8000-000000000010') = before.sessions
	and (select count(*) from public.qorpera_session_inputs input join public.qorpera_shared_sessions session on session.id = input.session_id
		where session.profile_id = '30000000-0000-4000-8000-000000000010') = before.inputs
	and (select count(*) from public.qorpera_execution_runs where profile_id = '30000000-0000-4000-8000-000000000010') = before.runs
	and (select count(*) from public.qorpera_profile_members where profile_id = '30000000-0000-4000-8000-000000000010') = before.members - 1,
	'the company keeps its conversations, messages and runs') from acct_before as before;

-- A member without a history goes, with their own things; the company stays.
insert into public.qorpera_friendships(user_low, user_high, requested_by, status)
values ('30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'accepted');
insert into public.qorpera_product_feedback(user_id, client_feedback_id, category, details, include_diagnostics)
values ('30000000-0000-4000-8000-000000000003', gen_random_uuid(), 'other', 'Account deletion fixture', false);
delete from auth.users where id = '30000000-0000-4000-8000-000000000003';
select pg_temp.acct_assert(
	not exists (select 1 from public.qorpera_profile_members where user_id = '30000000-0000-4000-8000-000000000003')
	and not exists (select 1 from public.qorpera_friendships where user_high = '30000000-0000-4000-8000-000000000003')
	and not exists (select 1 from public.qorpera_product_feedback where user_id = '30000000-0000-4000-8000-000000000003')
	and exists (select 1 from public.qorpera_profile_members where profile_id = '30000000-0000-4000-8000-000000000010'
		and user_id = '30000000-0000-4000-8000-000000000002' and role = 'owner'),
	'a member without a history leaves with their own things');

-- A company without any history: its creator (…7201), a founder (…7202) and a contributor (…7203).
insert into auth.users(id, email) values
	('72000000-0000-4000-8000-000000000001', 'acct-creator@example.test'),
	('72000000-0000-4000-8000-000000000002', 'acct-founder@example.test'),
	('72000000-0000-4000-8000-000000000003', 'acct-member@example.test'),
	('72000000-0000-4000-8000-000000000005', 'acct-plan@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('72000000-0000-4000-8000-000000000010', 'Account deletion', '72000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('72000000-0000-4000-8000-000000000010', '72000000-0000-4000-8000-000000000001', 'acct-creator@example.test', 'Creator', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('72000000-0000-4000-8000-000000000020', '72000000-0000-4000-8000-000000000010', 'Environment', 1,
	'72000000-0000-4000-8000-000000000001');

-- Alone in it: the account stays until the company is deleted.
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000001'$q$,
	array['23503', '42501'], null, 'deleting the only member of a company');

-- The creator makes a co-founder and leaves; a contributor joins. The last founder cannot go while
-- the contributor stays, whichever way their membership is removed.
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('72000000-0000-4000-8000-000000000010', '72000000-0000-4000-8000-000000000002', 'acct-founder@example.test', 'Founder', 'owner'),
	('72000000-0000-4000-8000-000000000010', '72000000-0000-4000-8000-000000000003', 'acct-member@example.test', 'Member', 'contributor');
select pg_temp.acct_as('72000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_leave_hosted_profile('72000000-0000-4000-8000-000000000010');
reset role;
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000002'$q$,
	array['42501'], 'The last founder cannot leave while others remain', 'deleting the last founder while others remain');

-- The founder removes the contributor and is alone: neither an account deletion nor any other writer
-- leaves the company with nobody in it.
select pg_temp.acct_as('72000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_remove_profile_member('72000000-0000-4000-8000-000000000010', '72000000-0000-4000-8000-000000000003');
reset role;
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000002'$q$,
	array['42501'], 'The last member cannot leave; delete the company instead', 'deleting the last member');
select pg_temp.acct_refused($q$delete from public.qorpera_profile_members
	where profile_id = '72000000-0000-4000-8000-000000000010' and user_id = '72000000-0000-4000-8000-000000000002'$q$,
	array['42501'], 'The last member cannot leave; delete the company instead', 'removing the last member directly');
select pg_temp.acct_as('72000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.acct_refused($q$select public.qorpera_leave_hosted_profile('72000000-0000-4000-8000-000000000010')$q$,
	array['42501'], null, 'the last member leaving');
reset role;
-- The account that was refused is still a member.
select pg_temp.acct_assert(exists (select 1 from public.qorpera_profile_members
	where profile_id = '72000000-0000-4000-8000-000000000010' and user_id = '72000000-0000-4000-8000-000000000002'),
	'the last member is still in the company');

-- A company being deleted lets its last member go. Company delete (20260928249150) records the request
-- in qorpera_company_deletions and answers qorpera_company_deleting; where that table is not in the
-- database yet, a stand-in function for this test (rolled back) answers for this company. With the
-- table present the guard must use company delete's own function, so a rename there fails this test.
do $$
begin
	if to_regclass('public.qorpera_company_deletions') is null then
		execute $f$create function public.qorpera_company_deleting(p_profile_id uuid) returns boolean language sql as
			'select p_profile_id = ''72000000-0000-4000-8000-000000000010''::uuid'$f$;
	else
		execute $f$insert into public.qorpera_company_deletions (profile_id)
			values ('72000000-0000-4000-8000-000000000010')$f$;
	end if;
end
$$;
-- The creator's account still waits for the company's row to go.
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000001'$q$,
	array['23503'], null, 'deleting the creator of a company awaiting its purge');
delete from auth.users where id = '72000000-0000-4000-8000-000000000002';
select pg_temp.acct_assert(exists (select 1 from public.qorpera_profiles where id = '72000000-0000-4000-8000-000000000010')
	and not exists (select 1 from public.qorpera_profile_members where profile_id = '72000000-0000-4000-8000-000000000010'),
	'the last member of a company being deleted goes');
-- Once the company is gone, so can its creator's account.
delete from public.qorpera_profiles where id = '72000000-0000-4000-8000-000000000010';
delete from auth.users where id = '72000000-0000-4000-8000-000000000001';
select pg_temp.acct_assert(not exists (select 1 from auth.users where id = '72000000-0000-4000-8000-000000000001'),
	'the creator of a deleted company can be deleted');

-- Plan records are kept for bookkeeping: an account with a plan is not erased.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
select public.qorpera_set_account_entitlement('72000000-0000-4000-8000-000000000005', 'internal', 'complimentary', 'all',
	'unlimited', 'account-deletion-test', 'Account deletion fixture');
reset role;
select pg_temp.acct_refused($q$delete from auth.users where id = '72000000-0000-4000-8000-000000000005'$q$,
	array['23503'], null, 'deleting an account with plan records');
select pg_temp.acct_assert(exists (select 1 from public.qorpera_account_entitlements where user_id = '72000000-0000-4000-8000-000000000005')
	and exists (select 1 from public.qorpera_account_entitlement_changes where user_id = '72000000-0000-4000-8000-000000000005'),
	'plan records stay');

rollback;

-- Deleting an account always works once its companies let it go (20260930079000). The last member of a folder-v2
-- company, who is not its creator, deletes the company: the company is paused by a row that names them. They then
-- delete their own account, and it works: the pause stays, without their name, the company stays paused and its
-- deletion goes on to the purge, after which the creator's account can go too.
begin;

insert into auth.users(id, email) values
	('92900000-0000-4000-8000-000000000001', 'pause-creator@example.test'),
	('92900000-0000-4000-8000-000000000002', 'pause-last@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('92900000-0000-4000-8000-000000000010', 'Pause outlives its member', '92900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('92900000-0000-4000-8000-000000000010', '92900000-0000-4000-8000-000000000001', 'pause-creator@example.test', 'Creator', 'owner'),
	('92900000-0000-4000-8000-000000000010', '92900000-0000-4000-8000-000000000002', 'pause-last@example.test', 'Last', 'contributor');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('92900000-0000-4000-8000-000000000020', '92900000-0000-4000-8000-000000000010', 'Environment', 1,
	'92900000-0000-4000-8000-000000000001');

create function pg_temp.pause_as(p_role text, p_user uuid default null) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text, true)::text::void
$$;
create function pg_temp.pause_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'pause outlives its member: %', p_what; end if; end
$$;

select pg_temp.pause_as('service_role');
select public.qorpera_folder_enable('92900000-0000-4000-8000-000000000020') \g /dev/null
select pg_temp.pause_assert(public.qorpera_company_is_folder_v2('92900000-0000-4000-8000-000000000010'), 'the company is folder-v2');

-- 1. The reference itself: nullable, and set to null when its account is deleted.
select pg_temp.pause_assert((select is_nullable = 'YES' from information_schema.columns where table_schema = 'public'
	and table_name = 'qorpera_company_execution_pauses' and column_name = 'paused_by_user_id'), 'the column is nullable');
select pg_temp.pause_assert((select confdeltype = 'n' and confrelid = 'auth.users'::regclass from pg_constraint
	where conname = 'qorpera_company_execution_pauses_paused_by_user_id_fkey'
		and conrelid = 'public.qorpera_company_execution_pauses'::regclass), 'the reference is ON DELETE SET NULL');

-- 2. The creator makes the contributor a co-founder and leaves; the contributor is now the last member, and deletes the
--    company. Its pause names them.
select pg_temp.pause_as('authenticated', '92900000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_profile_member_role('92900000-0000-4000-8000-000000000010',
	'92900000-0000-4000-8000-000000000002', 'owner') \g /dev/null
select public.qorpera_leave_hosted_profile('92900000-0000-4000-8000-000000000010') \g /dev/null
reset role;
select pg_temp.pause_as('authenticated', '92900000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_delete_hosted_profile('92900000-0000-4000-8000-000000000010') \g /dev/null
reset role;
select pg_temp.pause_as('service_role');
select pg_temp.pause_assert(public.qorpera_company_deleting('92900000-0000-4000-8000-000000000010')
	and (select paused_by_user_id = '92900000-0000-4000-8000-000000000002' from public.qorpera_company_execution_pauses
		where profile_id = '92900000-0000-4000-8000-000000000010'), 'the deletion is requested and its pause names the member');

-- 3. The last member deletes their own account: it works. The pause stays without their name; the company stays paused
--    and being deleted.
delete from auth.users where id = '92900000-0000-4000-8000-000000000002';
select pg_temp.pause_assert(not exists (select 1 from auth.users where id = '92900000-0000-4000-8000-000000000002'),
	'the last member''s account is deleted');
select pg_temp.pause_assert((select paused_by_user_id is null from public.qorpera_company_execution_pauses
	where profile_id = '92900000-0000-4000-8000-000000000010'), 'the pause stays, without the member''s name');
select pg_temp.pause_assert(public.qorpera_company_execution_paused('92900000-0000-4000-8000-000000000010')
	and public.qorpera_company_deleting('92900000-0000-4000-8000-000000000010'), 'the company stays paused and being deleted');

-- 4. The deletion goes on to the purge, and then the creator's account can go too.
select set_config('qorpera_test.pause_purge', public.qorpera_finish_company_deletion('92900000-0000-4000-8000-000000000010')::text, true)
\g /dev/null
select pg_temp.pause_assert(current_setting('qorpera_test.pause_purge')::jsonb ->> 'state' = 'purged'
	and not exists (select 1 from public.qorpera_profiles where id = '92900000-0000-4000-8000-000000000010'),
	'the company is purged: ' || current_setting('qorpera_test.pause_purge'));
delete from auth.users where id = '92900000-0000-4000-8000-000000000001';
select pg_temp.pause_assert(not exists (select 1 from auth.users where id = '92900000-0000-4000-8000-000000000001'),
	'the creator''s account is deleted after the purge');

rollback;

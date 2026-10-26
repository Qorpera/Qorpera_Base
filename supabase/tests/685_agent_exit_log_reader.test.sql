-- Agent exit E10a (20260930507000): what a viewer may read of their company's agent exit log. An owner and an admin read
-- the company's lines; a contributor and a viewer read only their own coding machines' lines. Each of these is refused
-- (42501), as if the company were not there: a member of another company, a caller with no account, anon, the service
-- role, and a member asking about a company that does not exist. A company being deleted refuses its own members
-- (55000). Rolled back.
begin;

insert into auth.users(id, email) values
	('68500000-0000-4000-8000-000000000001', 'exit-owner@example.test'),
	('68500000-0000-4000-8000-000000000002', 'exit-admin@example.test'),
	('68500000-0000-4000-8000-000000000003', 'exit-contributor@example.test'),
	('68500000-0000-4000-8000-000000000004', 'exit-viewer@example.test'),
	('68500000-0000-4000-8000-000000000005', 'exit-elsewhere@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('68500000-0000-4000-8000-000000000010', 'Exit log company', '68500000-0000-4000-8000-000000000001'),
	('68500000-0000-4000-8000-000000000011', 'Another company', '68500000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('68500000-0000-4000-8000-000000000010', '68500000-0000-4000-8000-000000000001', 'exit-owner@example.test', 'Owner', 'owner'),
	('68500000-0000-4000-8000-000000000010', '68500000-0000-4000-8000-000000000002', 'exit-admin@example.test', 'Admin', 'admin'),
	('68500000-0000-4000-8000-000000000010', '68500000-0000-4000-8000-000000000003', 'exit-contributor@example.test',
		'Contributor', 'contributor'),
	('68500000-0000-4000-8000-000000000010', '68500000-0000-4000-8000-000000000004', 'exit-viewer@example.test', 'Viewer', 'viewer'),
	('68500000-0000-4000-8000-000000000011', '68500000-0000-4000-8000-000000000005', 'exit-elsewhere@example.test', 'Elsewhere', 'owner');

-- The scope for a caller with this role and account, read as the API role itself.
create function pg_temp.exit_scope(p_role text, p_user uuid, p_company uuid) returns jsonb language plpgsql as $$
declare v_scope jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text, true);
	execute format('set local role %I', p_role);
	v_scope := public.qorpera_member_agent_exit_log_scope(p_company);
	reset role;
	return v_scope;
exception when others then
	reset role;
	raise;
end
$$;
create function pg_temp.exit_same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin if p_got is distinct from p_want then raise exception 'exit log scope: %: got %, want %', p_what, p_got, p_want; end if; end
$$;
create function pg_temp.exit_refused(p_role text, p_user uuid, p_company uuid, p_state text, p_what text)
returns void language plpgsql as $$
declare v_scope jsonb;
begin
	v_scope := pg_temp.exit_scope(p_role, p_user, p_company);
	raise exception 'exit log scope: % was not refused: %', p_what, v_scope;
exception when others then
	if sqlstate <> p_state then
		raise exception 'exit log scope: % was refused with % (%), want %', p_what, sqlstate, sqlerrm, p_state; end if;
end
$$;

-- 1. Owners and admins read the company's lines; any other member reads only their own coding machines'.
select pg_temp.exit_same(pg_temp.exit_scope('authenticated', '68500000-0000-4000-8000-000000000001',
	'68500000-0000-4000-8000-000000000010'), '{"scope": "company"}', 'the owner');
select pg_temp.exit_same(pg_temp.exit_scope('authenticated', '68500000-0000-4000-8000-000000000002',
	'68500000-0000-4000-8000-000000000010'), '{"scope": "company"}', 'the admin');
select pg_temp.exit_same(pg_temp.exit_scope('authenticated', '68500000-0000-4000-8000-000000000003',
	'68500000-0000-4000-8000-000000000010'),
	'{"scope": "member", "member": "68500000-0000-4000-8000-000000000003"}', 'the contributor');
select pg_temp.exit_same(pg_temp.exit_scope('authenticated', '68500000-0000-4000-8000-000000000004',
	'68500000-0000-4000-8000-000000000010'),
	'{"scope": "member", "member": "68500000-0000-4000-8000-000000000004"}', 'the viewer');

-- 2. Everyone else is refused as if the company were not there.
select pg_temp.exit_refused('authenticated', '68500000-0000-4000-8000-000000000005', '68500000-0000-4000-8000-000000000010',
	'42501', 'an owner of another company');
select pg_temp.exit_refused('authenticated', '68500000-0000-4000-8000-000000000001', '68500000-0000-4000-8000-000000000011',
	'42501', 'the owner, asking about a company they are not in');
select pg_temp.exit_refused('authenticated', '68500000-0000-4000-8000-000000000001', '68500000-0000-4000-8000-0000000000ff',
	'42501', 'the owner, asking about a company that does not exist');
select pg_temp.exit_refused('authenticated', null, '68500000-0000-4000-8000-000000000010', '42501', 'a caller with no account');
select pg_temp.exit_refused('anon', null, '68500000-0000-4000-8000-000000000010', '42501', 'anon');
select pg_temp.exit_refused('service_role', null, '68500000-0000-4000-8000-000000000010', '42501', 'the service role');
select pg_temp.exit_same(to_jsonb(array[
		has_function_privilege('anon', 'public.qorpera_member_agent_exit_log_scope(uuid)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_member_agent_exit_log_scope(uuid)', 'execute'),
		has_function_privilege('authenticated', 'public.qorpera_member_agent_exit_log_scope(uuid)', 'execute')]),
	'[false, false, true]', 'who may call it (anon, service role, authenticated)');

-- 3. A company being deleted refuses its own members, its owner too; another company is not affected.
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('68500000-0000-4000-8000-000000000010', '68500000-0000-4000-8000-000000000001');
select pg_temp.exit_refused('authenticated', '68500000-0000-4000-8000-000000000001', '68500000-0000-4000-8000-000000000010',
	'55000', 'the owner of a company being deleted');
select pg_temp.exit_refused('authenticated', '68500000-0000-4000-8000-000000000003', '68500000-0000-4000-8000-000000000010',
	'55000', 'a contributor of a company being deleted');
select pg_temp.exit_same(pg_temp.exit_scope('authenticated', '68500000-0000-4000-8000-000000000005',
	'68500000-0000-4000-8000-000000000011'), '{"scope": "company"}', 'the owner of another company');

rollback;

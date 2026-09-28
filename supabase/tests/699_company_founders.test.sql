-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Several founders per company (20260929030000): founders make founders, step down on their own
-- and remove other members but never a fellow founder; admins keep their powers; the last founder
-- stays while others remain; only the last member deletes. The fixture company has the owner
-- (…001, its creator), a contributor (…002) and a viewer (…003), with agents and their threads.
reset role;

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_company_founders(uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_company_founders(uuid)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_company_founders(uuid)', 'EXECUTE') then
		raise exception 'the founder list is not service-only';
	end if;
end
$$;

insert into auth.users(id,email) values ('30000000-0000-4000-8000-000000000004','path-admin@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000004','path-admin@example.test','Admin','admin');

create function pg_temp.founders() returns uuid[] language sql as $$
	select array_agg(founder.user_id) from public.qorpera_company_founders('30000000-0000-4000-8000-000000000010') founder
$$;
create function pg_temp.refused(p_sql text, p_what text) returns void language plpgsql as $$
begin
	begin
		execute p_sql;
	exception when insufficient_privilege then return;
	end;
	raise exception 'not refused: %', p_what;
end
$$;

-- The owner makes the contributor a co-founder.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000002','owner');
do $$
declare v_team jsonb := public.qorpera_profile_team_info('30000000-0000-4000-8000-000000000010');
begin
	if v_team #> '{capabilities,manage_founders}' <> 'true' or v_team #> '{capabilities,leave}' <> 'true'
		or v_team #> '{capabilities,delete_company}' <> 'false' then
		raise exception 'a founder with a co-founder sees the wrong membership actions: %', v_team -> 'capabilities';
	end if;
end
$$;
reset role;
do $$
begin
	if pg_temp.founders() <> array['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002']::uuid[]
		or public.qorpera_company_owner_user_id('30000000-0000-4000-8000-000000000010') <> '30000000-0000-4000-8000-000000000001' then
		raise exception 'the founder list is not the creator first: %', pg_temp.founders();
	end if;
	-- The places that needed "the" owner work with two founders.
	perform public.qorpera_profile_entitlement_json('30000000-0000-4000-8000-000000000010');
	insert into auth.users(id,email) values ('30000000-0000-4000-8000-000000000005','path-new@example.test');
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	values ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000005','path-new@example.test','New','contributor');
end
$$;

-- An admin cannot make a founder, remove or change a founder, or manage admins; a viewer's role
-- is still theirs to change.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000003','owner')$q$, 'an admin made a founder');
select pg_temp.refused($q$select public.qorpera_remove_profile_member('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000002')$q$, 'an admin removed a founder');
select pg_temp.refused($q$select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000002','contributor')$q$, 'an admin demoted a founder');
select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000003','contributor');
reset role;

-- A founder cannot remove or demote a fellow founder, but removes anyone else, admins included.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_remove_profile_member('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000001')$q$, 'a founder removed a fellow founder');
select pg_temp.refused($q$select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000001','admin')$q$, 'a founder demoted a fellow founder');
select public.qorpera_remove_profile_member('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000005');
reset role;

-- The creator steps down to admin while the co-founder remains; the co-founder is now first.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000001','admin');
reset role;
do $$
begin
	if pg_temp.founders() <> array['30000000-0000-4000-8000-000000000002']::uuid[]
		or public.qorpera_company_owner_user_id('30000000-0000-4000-8000-000000000010') <> '30000000-0000-4000-8000-000000000002' then
		raise exception 'stepping down did not leave the co-founder as the founder: %', pg_temp.founders();
	end if;
end
$$;

-- The last founder can neither leave, step down nor delete while others remain.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.refused($q$select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000010')$q$,
	'the last founder left while others remained');
select pg_temp.refused($q$select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000002','admin')$q$, 'the last founder stepped down while others remained');
select pg_temp.refused($q$select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000010')$q$,
	'a founder deleted the company while others remained');
do $$
declare v_team jsonb := public.qorpera_profile_team_info('30000000-0000-4000-8000-000000000010');
begin
	if v_team #> '{capabilities,leave}' <> 'false' or v_team #> '{capabilities,delete_company}' <> 'false' then
		raise exception 'the last founder is offered leave or delete: %', v_team -> 'capabilities';
	end if;
end
$$;
-- Made a founder again, the creator lets the co-founder leave.
select public.qorpera_update_profile_member_role('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000001','owner');
select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000010');
reset role;
do $$
begin
	if pg_temp.founders() <> array['30000000-0000-4000-8000-000000000001']::uuid[] then
		raise exception 'the co-founder did not leave: %', pg_temp.founders();
	end if;
	-- The rule holds for service code too.
	begin
		delete from public.qorpera_profile_members
		where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '30000000-0000-4000-8000-000000000001';
		raise exception 'service code removed the last founder while others remained';
	exception when insufficient_privilege then null;
	end;
end
$$;

-- A company still at its founding table: no setup job, no Co-Founder, no environment. Members
-- leave and are removed; the last member deletes it.
insert into auth.users(id,email) values
	('30000000-0000-4000-8000-000000000901','lobby-creator@example.test'),
	('30000000-0000-4000-8000-000000000902','lobby-friend@example.test'),
	('30000000-0000-4000-8000-000000000903','lobby-other@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('30000000-0000-4000-8000-000000000910','Founding table','30000000-0000-4000-8000-000000000901');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000910','30000000-0000-4000-8000-000000000901','lobby-creator@example.test','Creator','owner'),
	('30000000-0000-4000-8000-000000000910','30000000-0000-4000-8000-000000000902','lobby-friend@example.test','Friend','contributor'),
	('30000000-0000-4000-8000-000000000910','30000000-0000-4000-8000-000000000903','lobby-other@example.test','Other','contributor');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000902');
set local role authenticated;
select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000910');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000901');
select public.qorpera_remove_profile_member('30000000-0000-4000-8000-000000000910','30000000-0000-4000-8000-000000000903');
do $$
declare v_team jsonb := public.qorpera_profile_team_info('30000000-0000-4000-8000-000000000910');
begin
	if v_team #> '{capabilities,delete_company}' <> 'true' or v_team #> '{capabilities,leave}' <> 'false' then
		raise exception 'the last member is not offered delete: %', v_team -> 'capabilities';
	end if;
end
$$;
select pg_temp.refused($q$select public.qorpera_leave_hosted_profile('30000000-0000-4000-8000-000000000910')$q$,
	'the last member left instead of deleting');
select public.qorpera_delete_hosted_profile('30000000-0000-4000-8000-000000000910');
reset role;
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000910') then
		raise exception 'the last member could not delete the founding-table company';
	end if;
end
$$;

rollback;

-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Several founders per company (20260928248100), on a folder-v2 company (ported from snapshot-v1 in the legacy sweep):
-- founders make founders, step down on their own and remove other members but never a fellow founder; admins keep their
-- powers; the last founder stays while others remain; only the last member deletes. The base company has the owner
-- (…001, its creator and only founder), a contributor (…002), a viewer (…003) and an admin (…004), with agents, their
-- threads and a live run. (664 §2–3 covers only part of this on folder-v2: a founder cannot be removed, the last founder
-- cannot step down, and steps down beside another founder.)

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_company_founders(uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_company_founders(uuid)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_company_founders(uuid)', 'EXECUTE') then
		raise exception 'the founder list is not service-only';
	end if;
end
$$;

create function pg_temp.founders_list() returns uuid[] language sql as $$
	select array_agg(founder.user_id) from public.qorpera_company_founders('92400000-0000-4000-8000-000000000010') founder
$$;
create function pg_temp.founders_refused(p_sql text, p_what text) returns void language plpgsql as $$
begin
	begin
		execute p_sql;
	exception when insufficient_privilege then return;
	end;
	raise exception 'not refused: %', p_what;
end
$$;

-- The owner makes the contributor a co-founder.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000002','owner') \g /dev/null
do $$
declare v_team jsonb := public.qorpera_profile_team_info('92400000-0000-4000-8000-000000000010');
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
	if pg_temp.founders_list() <> array['92400000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000002']::uuid[]
		or public.qorpera_company_owner_user_id('92400000-0000-4000-8000-000000000010') <> '92400000-0000-4000-8000-000000000001' then
		raise exception 'the founder list is not the creator first: %', pg_temp.founders_list();
	end if;
	-- The places that needed "the" owner work with two founders.
	perform public.qorpera_profile_entitlement_json('92400000-0000-4000-8000-000000000010');
	insert into auth.users(id,email) values ('69900000-0000-4000-8000-000000000005','founders-new@example.test');
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	values ('92400000-0000-4000-8000-000000000010','69900000-0000-4000-8000-000000000005','founders-new@example.test','New','contributor');
end
$$;

-- An admin cannot make a founder, remove or change a founder, or manage admins; a viewer's role
-- is still theirs to change.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.founders_refused($q$select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000003','owner')$q$, 'an admin made a founder');
select pg_temp.founders_refused($q$select public.qorpera_remove_profile_member('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000002')$q$, 'an admin removed a founder');
select pg_temp.founders_refused($q$select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000002','contributor')$q$, 'an admin demoted a founder');
select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000003','contributor') \g /dev/null
reset role;
select pg_temp.base_assert((select role::text from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
	and user_id = '92400000-0000-4000-8000-000000000003') = 'contributor', 'the admin changed the viewer''s role');

-- A founder cannot remove or demote a fellow founder, but removes anyone else, admins included.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.founders_refused($q$select public.qorpera_remove_profile_member('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000001')$q$, 'a founder removed a fellow founder');
select pg_temp.founders_refused($q$select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000001','admin')$q$, 'a founder demoted a fellow founder');
select public.qorpera_remove_profile_member('92400000-0000-4000-8000-000000000010','69900000-0000-4000-8000-000000000005') \g /dev/null
select public.qorpera_remove_profile_member('92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000004') \g /dev/null
reset role;
select pg_temp.base_assert(not exists (select 1 from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
	and user_id in ('69900000-0000-4000-8000-000000000005', '92400000-0000-4000-8000-000000000004')), 'a founder removed a member and an admin');

-- The creator steps down to admin while the co-founder remains; the co-founder is now first.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000001','admin') \g /dev/null
reset role;
do $$
begin
	if pg_temp.founders_list() <> array['92400000-0000-4000-8000-000000000002']::uuid[]
		or public.qorpera_company_owner_user_id('92400000-0000-4000-8000-000000000010') <> '92400000-0000-4000-8000-000000000002' then
		raise exception 'stepping down did not leave the co-founder as the founder: %', pg_temp.founders_list();
	end if;
end
$$;

-- The last founder can neither leave, step down nor delete while others remain.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.founders_refused($q$select public.qorpera_leave_hosted_profile('92400000-0000-4000-8000-000000000010')$q$,
	'the last founder left while others remained');
select pg_temp.founders_refused($q$select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000002','admin')$q$, 'the last founder stepped down while others remained');
select pg_temp.founders_refused($q$select public.qorpera_delete_hosted_profile('92400000-0000-4000-8000-000000000010')$q$,
	'a founder deleted the company while others remained');
do $$
declare v_team jsonb := public.qorpera_profile_team_info('92400000-0000-4000-8000-000000000010');
begin
	if v_team #> '{capabilities,leave}' <> 'false' or v_team #> '{capabilities,delete_company}' <> 'false' then
		raise exception 'the last founder is offered leave or delete: %', v_team -> 'capabilities';
	end if;
end
$$;
-- Made a founder again, the creator lets the co-founder leave.
select public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000001','owner') \g /dev/null
select public.qorpera_leave_hosted_profile('92400000-0000-4000-8000-000000000010') \g /dev/null
reset role;
do $$
begin
	if pg_temp.founders_list() <> array['92400000-0000-4000-8000-000000000001']::uuid[]
		or exists (select 1 from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
			and user_id = '92400000-0000-4000-8000-000000000002') then
		raise exception 'the co-founder did not leave: %', pg_temp.founders_list();
	end if;
	-- The rule holds for service code too.
	begin
		delete from public.qorpera_profile_members
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
		raise exception 'service code removed the last founder while others remained';
	exception when insufficient_privilege then null;
	end;
end
$$;

-- A company still at its founding table: no setup job, no Co-Founder, no environment (so no company core). Members
-- leave and are removed; the last member deletes it.
insert into auth.users(id,email) values
	('69900000-0000-4000-8000-000000000901','lobby-creator@example.test'),
	('69900000-0000-4000-8000-000000000902','lobby-friend@example.test'),
	('69900000-0000-4000-8000-000000000903','lobby-other@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('69900000-0000-4000-8000-000000000910','Founding table','69900000-0000-4000-8000-000000000901');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('69900000-0000-4000-8000-000000000910','69900000-0000-4000-8000-000000000901','lobby-creator@example.test','Creator','owner'),
	('69900000-0000-4000-8000-000000000910','69900000-0000-4000-8000-000000000902','lobby-friend@example.test','Friend','contributor'),
	('69900000-0000-4000-8000-000000000910','69900000-0000-4000-8000-000000000903','lobby-other@example.test','Other','contributor');
select pg_temp.base_claims('authenticated','69900000-0000-4000-8000-000000000902');
set local role authenticated;
select public.qorpera_leave_hosted_profile('69900000-0000-4000-8000-000000000910') \g /dev/null
select pg_temp.base_claims('authenticated','69900000-0000-4000-8000-000000000901');
select public.qorpera_remove_profile_member('69900000-0000-4000-8000-000000000910','69900000-0000-4000-8000-000000000903') \g /dev/null
do $$
declare v_team jsonb := public.qorpera_profile_team_info('69900000-0000-4000-8000-000000000910');
begin
	if v_team #> '{capabilities,delete_company}' <> 'true' or v_team #> '{capabilities,leave}' <> 'false' then
		raise exception 'the last member is not offered delete: %', v_team -> 'capabilities';
	end if;
end
$$;
select pg_temp.founders_refused($q$select public.qorpera_leave_hosted_profile('69900000-0000-4000-8000-000000000910')$q$,
	'the last member left instead of deleting');
select pg_temp.founders_refused($q$select public.qorpera_update_profile_member_role('69900000-0000-4000-8000-000000000910',
	'69900000-0000-4000-8000-000000000901','admin')$q$, 'the only member stepped down and left the company without a founder');
select public.qorpera_delete_hosted_profile('69900000-0000-4000-8000-000000000910') \g /dev/null
reset role;
-- Deleting hides the company and stops its work; the deletion finishes once no node holds anything
-- of it (20260928249150). This company has nothing on a node.
select public.qorpera_finish_company_deletion('69900000-0000-4000-8000-000000000910') \g /dev/null
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id = '69900000-0000-4000-8000-000000000910') then
		raise exception 'the last member could not delete the founding-table company';
	end if;
end
$$;

rollback;

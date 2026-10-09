-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- The Company Computer's member and viewer roles on a folder-v2 company (ported from snapshot-v1 in the legacy sweep):
-- 405's computer, where Alice's run holds a screen lease, and 924's owner 01, contributor 02, viewer 03 and admin 04.
-- 1. A viewer ticket is refused under another company's scope and redeemed only once; a watch grant admits no input.
-- 2. A member removed and added again: the removal trigger ends their open viewer grant.
-- 3. The viewer and the contributor are refused a shared viewer.
-- 4. An admin demoted to contributor is refused their next shared input.
-- 5. A removed member cannot read the computer's member status.
-- 6. A removed member cannot enable a browser grant on their own prepared profile.
-- 7. The operator's compute requests for another company's id list nothing.
-- 8. A contributor cannot start a provisioning computer, a viewer cannot wake it, a contributor cannot ask for a drain.
-- 9. A contributor and a viewer can neither read nor configure an agent's access to the computer.

create function pg_temp.mr(p_name text) returns jsonb language sql as $$
	select current_setting('qorpera_test.' || p_name)::jsonb
$$;
create function pg_temp.mr_keep(p_name text, p_value jsonb) returns jsonb language sql as $$
	select set_config('qorpera_test.' || p_name, p_value::text, true)::jsonb
$$;
-- One statement as member 92400000-0000-4000-8000-0000000000<p_member>, or as the gateway (service_role) when null.
create function pg_temp.mr_as(p_member text, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims(case when p_member is null then 'service_role' else 'authenticated' end,
		('92400000-0000-4000-8000-0000000000' || p_member)::uuid);
	execute case when p_member is null then 'set local role service_role' else 'set local role authenticated' end;
	execute p_sql into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.mr_refused(p_member text, p_sql text, p_message text) returns void language sql as $$
	select pg_temp.base_error(format('select pg_temp.mr_as(%L, %L)', p_member, p_sql), '42501', p_message)
$$;
-- The calls, against the screen as it is now.
create function pg_temp.mr_mint(p_mode text) returns text language sql as $$
	select format('select public.qorpera_create_runtime_office_viewer(%L::jsonb, %s, %L)', pg_temp.mr('binding'), s.epoch, p_mode)
	from public.qorpera_runtime_office_screens s where s.id = (pg_temp.mr('binding') ->> 'screenId')::uuid
$$;
create function pg_temp.mr_redeem(p_ticket jsonb, p_scope jsonb default null) returns text language sql as $$
	select format('select public.qorpera_redeem_runtime_office_viewer(%L::jsonb, %L)', coalesce(p_scope, pg_temp.mr('office_scope')),
		encode(extensions.digest(p_ticket ->> 'capability', 'sha256'), 'hex'))
$$;
create function pg_temp.mr_start() returns text language sql as $$
	select format('select public.qorpera_request_runtime_office_start(%L::jsonb, %s, %L)', pg_temp.mr('office_scope'),
		pg_temp.mr('binding') ->> 'computerGeneration', extensions.gen_random_uuid())
$$;
create function pg_temp.mr_drain() returns text language sql as $$
	select format('select public.qorpera_request_runtime_office_drain(%L::jsonb, %L, %s, %s, %s, false)', pg_temp.mr('office_scope'),
		s.id, pg_temp.mr('binding') ->> 'computerGeneration', s.generation, s.epoch)
	from public.qorpera_runtime_office_screens s where s.id = (pg_temp.mr('binding') ->> 'screenId')::uuid
$$;
create function pg_temp.mr_enable() returns text language sql as $$
	select format('select public.qorpera_set_runtime_browser_grant(%L::jsonb, %L, %L, %s, %s, true)', pg_temp.mr('office_scope'),
		p.id, g.staff_agent_id, p.version, g.version)
	from public.qorpera_runtime_browser_grants g join public.qorpera_runtime_browser_profiles p on p.id = g.profile_id
	where p.owner_user_id = '92400000-0000-4000-8000-000000000002'
$$;

-- 1. V1-V3: the viewer's watch ticket, under another company's scope, twice, and its grant's input.
savepoint mr_ticket;
select pg_temp.mr_keep('mr_ticket', pg_temp.mr_as('03', pg_temp.mr_mint('watch')));
select pg_temp.mr_refused(null, pg_temp.mr_redeem(pg_temp.mr('mr_ticket'),
	jsonb_set(pg_temp.mr('office_scope'), '{companyId}', '"92400000-0000-4000-8000-000000000099"')), 'Viewer office differs');
select pg_temp.mr_keep('mr_grant', pg_temp.mr_as(null, pg_temp.mr_redeem(pg_temp.mr('mr_ticket'))));
select pg_temp.mr_refused(null, pg_temp.mr_redeem(pg_temp.mr('mr_ticket')), 'Viewer ticket consumed');
select pg_temp.mr_refused(null, $q$select public.qorpera_admit_runtime_office_viewer_input(pg_temp.mr('mr_grant'), 1, repeat('a', 64))$q$,
	'Member input unavailable');
select pg_temp.mr_refused(null, format('select public.qorpera_admit_runtime_office_viewer_input_window(pg_temp.mr(''mr_grant''), 1, %s)', w),
	'Member input unavailable') from unnest(array['0, null', $w$1, repeat('1', 64)$w$]) w;
rollback to savepoint mr_ticket;

-- 2. V4: the viewer removed (with the membership triggers) and added again; their open grant no longer checks.
savepoint mr_rejoined;
select pg_temp.mr_keep('mr_grant', pg_temp.mr_as(null, pg_temp.mr_redeem(pg_temp.mr_as('03', pg_temp.mr_mint('watch')))));
select pg_temp.base_assert(pg_temp.mr_as(null, $q$select public.qorpera_check_runtime_office_viewer(pg_temp.mr('mr_grant'))$q$)
	->> 'mode' = 'watch', 'the viewer''s grant checks before the removal');
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000003';
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000003', 'base-viewer@example.test', 'Viewer', 'viewer');
select pg_temp.mr_refused(null, $q$select public.qorpera_check_runtime_office_viewer(pg_temp.mr('mr_grant'))$q$,
	'Office viewer authority unavailable');
rollback to savepoint mr_rejoined;

-- 3. V5: a shared viewer for the viewer and the contributor (section 1: the viewer may watch).
select pg_temp.mr_refused(m, pg_temp.mr_mint('shared'), 'Office viewer mode unavailable') from unnest(array['03', '02']) m;

-- 4. V6: the admin's shared input is admitted; demoted to contributor, their next input is refused.
savepoint mr_demoted;
select pg_temp.mr_keep('mr_grant', pg_temp.mr_as(null, pg_temp.mr_redeem(pg_temp.mr_as('04', pg_temp.mr_mint('shared')))));
select pg_temp.base_assert(pg_temp.mr_as(null, $q$select public.qorpera_admit_runtime_office_viewer_input(pg_temp.mr('mr_grant'), 1,
	repeat('e', 64))$q$) ->> 'state' = 'admitted', 'the admin''s shared input is admitted');
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000004';
select pg_temp.mr_refused(null, $q$select public.qorpera_admit_runtime_office_viewer_input(pg_temp.mr('mr_grant'), 2, repeat('e', 64))$q$,
	'Office viewer mode unavailable');
rollback to savepoint mr_demoted;

-- 5. V7: the viewer reads the member status; removed, they are refused it.
savepoint mr_removed;
select pg_temp.base_assert(pg_temp.mr_as('03', $q$select public.qorpera_runtime_office_member_status(pg_temp.mr('office_scope'))$q$)
	->> 'state' = 'active', 'the viewer reads the member status before the removal');
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000003';
select pg_temp.mr_refused('03', $q$select public.qorpera_runtime_office_member_status(pg_temp.mr('office_scope'))$q$,
	'Office member unavailable');
rollback to savepoint mr_removed;

-- 6. V8: Alice's prepared profile made the contributor's own: they enable its grant; removed, the same call is refused.
savepoint mr_browser;
update public.qorpera_runtime_browser_profiles set company_owned = false, owner_user_id = '92400000-0000-4000-8000-000000000002'
where id = (select profile_id from public.qorpera_runtime_browser_grants
	where staff_agent_id = '92400000-0000-4000-8000-000000000030' and state = 'active');
savepoint mr_browser_member;
select pg_temp.base_assert(pg_temp.mr_as('02', pg_temp.mr_enable()) ->> 'state' = 'active', 'the member enables their own profile''s grant');
rollback to savepoint mr_browser_member;
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000002';
select pg_temp.mr_refused('02', pg_temp.mr_enable(), 'Browser grant unavailable');
rollback to savepoint mr_browser;

-- 7. V9: the operator's compute requests: this company has some; another company's id lists none.
select pg_temp.base_assert(jsonb_array_length(pg_temp.mr_as(null,
	$q$select public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000010')$q$) -> 'requests') > 0
	and pg_temp.mr_as(null, $q$select public.qorpera_runtime_compute_requests('92400000-0000-4000-8000-000000000099')$q$)
	-> 'requests' = '[]', 'another company''s id lists none of this company''s compute requests');

-- 8. #2, #4, #5: the contributor starting the computer while it provisions, the viewer waking it, the contributor's drain.
savepoint mr_provisioning;
update public.qorpera_runtime_offices set state = 'provisioning' where id = (pg_temp.mr('office_scope') ->> 'companyComputerId')::uuid;
select pg_temp.mr_refused('02', pg_temp.mr_start(), 'Office start requires founder authority');
rollback to savepoint mr_provisioning;
select pg_temp.mr_refused('03', pg_temp.mr_start(), 'Office wake unavailable');
select pg_temp.mr_refused('02', pg_temp.mr_drain(), 'Office takeover unavailable');
savepoint mr_drain;
select pg_temp.base_assert(pg_temp.mr_as('01', pg_temp.mr_drain()) ->> 'drainId' is not null, 'the owner''s same drain is taken');
rollback to savepoint mr_drain;

-- 9. A: Alice's access to the computer: the owner reads it; the contributor and the viewer can neither read nor configure it.
select pg_temp.base_assert(pg_temp.mr_as('01', $q$select public.qorpera_runtime_office_access_status(pg_temp.mr('office_scope'),
	'92400000-0000-4000-8000-000000000030')$q$) ->> 'staffAgentId' = '92400000-0000-4000-8000-000000000030', 'the owner reads Alice''s access');
select pg_temp.mr_refused(m, s, 'Office grant administration unavailable') from unnest(array['02', '03']) m, unnest(array[
	$q$select public.qorpera_runtime_office_access_status(pg_temp.mr('office_scope'), '92400000-0000-4000-8000-000000000030')$q$,
	$q$select public.qorpera_configure_runtime_office_access(pg_temp.mr('office_scope'), '92400000-0000-4000-8000-000000000030', 2, true,
		'["desktop"]')$q$]) s;

rollback;

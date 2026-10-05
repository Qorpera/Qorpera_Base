-- Computer hours, build step 6d part 2 (20260928259280_company_waiting_for_hours), on a folder-v2 company of its own
-- (ported from snapshot-v1 in the legacy sweep): any member reads whether the company waits for computer hours; nobody
-- else can.
begin;

insert into auth.users(id,email) values
	('72500000-0000-4000-8000-000000000001','waiting-owner@example.test'),
	('72500000-0000-4000-8000-000000000002','waiting-member@example.test'),
	('72500000-0000-4000-8000-000000000003','waiting-viewer@example.test'),
	('72500000-0000-4000-8000-000000000009','outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('72500000-0000-4000-8000-000000000010','Waiting company','72500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('72500000-0000-4000-8000-000000000010','72500000-0000-4000-8000-000000000001','waiting-owner@example.test','Owner','owner'),
	('72500000-0000-4000-8000-000000000010','72500000-0000-4000-8000-000000000002','waiting-member@example.test','Member','contributor'),
	('72500000-0000-4000-8000-000000000010','72500000-0000-4000-8000-000000000003','waiting-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('72500000-0000-4000-8000-000000000020','72500000-0000-4000-8000-000000000010','Environment',1,
	'72500000-0000-4000-8000-000000000001');

create function pg_temp.waiting_claims(p_role text, p_user uuid default null) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text, true)::text::void
$$;
create function pg_temp.waiting_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Waiting assertion: %', p_message; end if; end
$$;
create function pg_temp.waiting_error(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and sqlerrm = p_message then return; end if;
		raise exception 'Expected SQLSTATE % with message %, got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE %, call succeeded', p_state;
end
$$;
select pg_temp.waiting_claims('service_role');
select public.qorpera_folder_enable('72500000-0000-4000-8000-000000000020') \g /dev/null
select pg_temp.waiting_assert(public.qorpera_company_is_folder_v2('72500000-0000-4000-8000-000000000010'), 'The company is folder-v2');

create function pg_temp.waiting_as(p_user uuid) returns boolean language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_waiting boolean;
begin
	perform pg_temp.waiting_claims('authenticated', p_user);
	execute 'set local role authenticated';
	v_waiting := public.qorpera_company_waiting_for_hours('72500000-0000-4000-8000-000000000010');
	execute 'reset role';
	perform set_config('request.jwt.claims', v_claims, true);
	return v_waiting;
end
$$;

select pg_temp.waiting_assert(not has_function_privilege(role_name, 'public.qorpera_company_waiting_for_hours(uuid)', 'EXECUTE'),
	'Not callable by ' || role_name)
from unnest(array['anon', 'service_role']) role_name;
select pg_temp.waiting_assert(has_function_privilege('authenticated', 'public.qorpera_company_waiting_for_hours(uuid)', 'EXECUTE'),
	'Callable by signed-in members');
select pg_temp.waiting_error($$select pg_temp.waiting_as('72500000-0000-4000-8000-000000000009')$$, '42501',
	'profile read access is required');

-- Switched off: nothing waits, however much is used.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('72500000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
select pg_temp.waiting_assert(not pg_temp.waiting_as('72500000-0000-4000-8000-000000000002'), 'Switched off: not waiting');

-- Switched on, at zero: every member, founder, contributor or viewer, sees it.
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select public.qorpera_computer_hour_zero_sweep(clock_timestamp()) \g /dev/null
select pg_temp.waiting_assert(pg_temp.waiting_as('72500000-0000-4000-8000-000000000002')
	and pg_temp.waiting_as('72500000-0000-4000-8000-000000000001')
	and pg_temp.waiting_as('72500000-0000-4000-8000-000000000003'), 'At zero: waiting');

-- Hours arrive: no longer waiting.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '72500000-0000-4000-8000-000000000010', '72500000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.waiting_assert(not pg_temp.waiting_as('72500000-0000-4000-8000-000000000002'), 'Hours arrived: not waiting');
rollback;

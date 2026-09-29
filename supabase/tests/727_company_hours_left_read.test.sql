-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours (20260929330000_company_hours_left_read): from the live switch on, every member
-- reads how many hours the company has left and from what; founders also see each founder's share;
-- nothing before the switch; a complimentary company says so.

insert into auth.users(id,email) values ('72700000-0000-4000-8000-000000000002','left-founder-2@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','72700000-0000-4000-8000-000000000002','left-founder-2@example.test','Founder 2','owner');

create function pg_temp.left_as(p_user uuid) returns jsonb language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_read jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	execute 'set local role authenticated';
	v_read := public.qorpera_read_company_computer_hours('30000000-0000-4000-8000-000000000010') -> 'hoursLeft';
	execute 'reset role';
	perform set_config('request.jwt.claims', v_claims, true);
	return v_read;
end
$$;
create function pg_temp.use(p_seconds bigint) returns void language sql as $$
	insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
	values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), p_seconds, p_seconds)
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name,
		'public.qorpera_computer_hour_member_hours_left(uuid,uuid)', 'EXECUTE'), 'Not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name;

-- Before the live switch members see measured hours only.
select pg_temp.use(1000);
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000001') = 'null'::jsonb,
	'Dry run: no hours left shown');

-- Live: all five free hours; a contributor sees the numbers, not who pays.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000002') = jsonb_build_object(
		'leftSeconds', 18000, 'freeSeconds', 18000, 'planSeconds', 0, 'creditSeconds', 0, 'owedSeconds', 0),
	'Fresh company, contributor: ' || pg_temp.left_as('30000000-0000-4000-8000-000000000002')::text);
select pg_temp.wake_assert(not pg_temp.left_as('30000000-0000-4000-8000-000000000003') ? 'founders',
	'A viewer sees no names either');

-- Founder 2's plan and founder 1's pack: the parts, and each founder's share for a founder.
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
values ('plan_period', '72700000-0000-4000-8000-000000000002', 36000, clock_timestamp() - interval '1 day',
	'2099-01-01T00:00:00Z', 'sub_Left1:1', false);
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.use(20000);
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000002') = jsonb_build_object(
		'leftSeconds', 106000, 'freeSeconds', 0, 'planSeconds', 34000, 'creditSeconds', 72000, 'owedSeconds', 0),
	'Free hours used, then the plan: ' || pg_temp.left_as('30000000-0000-4000-8000-000000000002')::text);
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000001') -> 'founders' = jsonb_build_array(
		jsonb_build_object('userId', '30000000-0000-4000-8000-000000000001', 'planSeconds', null, 'planEndsAt', null,
			'creditSeconds', 72000),
		jsonb_build_object('userId', '72700000-0000-4000-8000-000000000002', 'planSeconds', 34000,
			'planEndsAt', '2099-01-01T00:00:00+00:00', 'creditSeconds', null)),
	'A founder sees who pays: ' || (pg_temp.left_as('30000000-0000-4000-8000-000000000001') -> 'founders')::text);
select pg_temp.wake_assert((pg_temp.left_as('30000000-0000-4000-8000-000000000001') ->> 'leftSeconds')::bigint
	= public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010'), 'The same as the zero rule counts');

-- Past zero: what it owes is shown, and hours left go below zero.
select pg_temp.use(150000);
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000002') = jsonb_build_object(
		'leftSeconds', -44000, 'freeSeconds', 0, 'planSeconds', 0, 'creditSeconds', 0, 'owedSeconds', 44000),
	'Owing: ' || pg_temp.left_as('30000000-0000-4000-8000-000000000002')::text);

-- Complimentary: never limited.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000002') = '{"complimentary": true}',
	'Complimentary');
rollback;

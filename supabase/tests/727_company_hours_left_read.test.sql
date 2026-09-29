-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours (20260929330000_company_hours_left_read): from the live switch on, every member
-- reads how many hours the company has left and from what; founders also see each founder's share;
-- nothing before the switch; a complimentary company says so.

insert into auth.users(id,email) values
	('72700000-0000-4000-8000-000000000002','left-founder-2@example.test'),
	('72700000-0000-4000-8000-000000000004','left-admin@example.test'),
	('72700000-0000-4000-8000-000000000005','left-former@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','72700000-0000-4000-8000-000000000002','left-founder-2@example.test','Founder 2','owner'),
	('30000000-0000-4000-8000-000000000010','72700000-0000-4000-8000-000000000004','left-admin@example.test','Admin','admin');

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
select pg_temp.wake_assert(not pg_temp.left_as('30000000-0000-4000-8000-000000000003') ? 'founders'
	and not pg_temp.left_as('72700000-0000-4000-8000-000000000004') ? 'founders',
	'A viewer and an admin see no names either');

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
		jsonb_build_object('userId', '30000000-0000-4000-8000-000000000001', 'planSeconds', null, 'creditSeconds', 72000),
		jsonb_build_object('userId', '72700000-0000-4000-8000-000000000002', 'planSeconds', 34000, 'creditSeconds', null)),
	'A founder sees who pays: ' || (pg_temp.left_as('30000000-0000-4000-8000-000000000001') -> 'founders')::text);
-- A pack bought by someone who is no longer a founder still pays: one line without a name.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '72700000-0000-4000-8000-000000000005', 3600,
	clock_timestamp() + interval '12 months', false);
select pg_temp.wake_assert(pg_temp.left_as('72700000-0000-4000-8000-000000000002') -> 'founders' -> 2
	= jsonb_build_object('userId', null, 'planSeconds', null, 'creditSeconds', 3600)
	and (pg_temp.left_as('72700000-0000-4000-8000-000000000002') ->> 'creditSeconds')::bigint = 75600,
	'Former founders'' packs: ' || (pg_temp.left_as('72700000-0000-4000-8000-000000000002') -> 'founders')::text);
-- Frozen, withdrawn and expired sources, and another company's pack, count for nothing, as the zero
-- rule counts it.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, frozen_at, withdrawn_at, dry_run)
values
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 3600, clock_timestamp() + interval '1 month', clock_timestamp(), null, false),
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 3600, clock_timestamp() + interval '1 month', null, clock_timestamp(), false),
	('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 3600, clock_timestamp() - interval '1 second', null, null, false);
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('72700000-0000-4000-8000-000000000020','Other','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '72700000-0000-4000-8000-000000000020', '30000000-0000-4000-8000-000000000001', 3600,
	clock_timestamp() + interval '12 months', false);
insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, frozen_at, dry_run)
values ('plan_period', '30000000-0000-4000-8000-000000000001', 7200, clock_timestamp() - interval '1 day',
	clock_timestamp() + interval '1 day', 'sub_Left2:1', clock_timestamp(), false);
select pg_temp.wake_assert((pg_temp.left_as('30000000-0000-4000-8000-000000000001') ->> 'leftSeconds')::bigint = 109600
	and (pg_temp.left_as('30000000-0000-4000-8000-000000000001') ->> 'leftSeconds')::bigint
		= public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010'),
	'Only what pays now counts, as the zero rule counts it: ' || pg_temp.left_as('30000000-0000-4000-8000-000000000001')::text);
select pg_temp.wake_assert((pg_temp.left_as('30000000-0000-4000-8000-000000000001') ->> 'leftSeconds')::bigint
	= public.qorpera_company_computer_hours_left('30000000-0000-4000-8000-000000000010'), 'The same as the zero rule counts');

-- Past zero: what it owes is shown, and hours left go below zero.
select pg_temp.use(153600);
select pg_temp.wake_assert(pg_temp.left_as('72700000-0000-4000-8000-000000000004') = jsonb_build_object(
		'leftSeconds', -44000, 'freeSeconds', 0, 'planSeconds', 0, 'creditSeconds', 0, 'owedSeconds', 44000),
	'Owing: ' || pg_temp.left_as('72700000-0000-4000-8000-000000000004')::text);

-- Complimentary: never limited.
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.wake_assert(pg_temp.left_as('30000000-0000-4000-8000-000000000002') = '{"complimentary": true}',
	'Complimentary');
rollback;

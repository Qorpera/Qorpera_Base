-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A usage wall covers every login of the same provider account on folder-v2 (ported from snapshot-v1 in the legacy sweep;
-- 20260919005000 and 20260920016000). Alice's leased run, paid by the owner's native login, reports the account's usage
-- limit: another login of the owner in the company for the same provider account is at its limit too and is not offered
-- for new work, while a login of a different account with the same display reference has room; the wall does not reach
-- the same account's logins of another member or in another company. After the login's credential rotates to another
-- account, the old account's wall still covers its duplicate and the new account has room. Test 582 continues from
-- this file's checks.

-- The run's report: its native login (924's, at its current version 2) reached the account's limit, which resets in
-- two hours.
insert into public.qorpera_provider_connection_usage_signals(profile_id,run_id,job_id,sponsor_binding_id,sponsor_version,
	provider_connection_id,provider_connection_version,provider,signal_kind,source,resets_at)
select run.profile_id,run.id,run.job_id,run.sponsor_binding_id,run.sponsor_version,
	sponsor.provider_connection_id,sponsor.provider_connection_version,'openai','usage_limit','native_adapter',
	clock_timestamp()+interval '2 hours'
from public.qorpera_execution_runs run
join public.qorpera_execution_sponsor_versions sponsor
	on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
	and sponsor.provider_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
	and sponsor.provider_connection_version = 2;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_identity)
values ((current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid,2,repeat('a',64));

-- Another native login of a member in a company, for the provider account named by p_hash, with room left.
create function pg_temp.r164_wall_account(p_profile uuid,p_user uuid,p_identity uuid,p_client uuid,p_hash text)
returns uuid language plpgsql as $$
declare login jsonb; connection jsonb;
begin
	perform pg_temp.base_claims('authenticated',p_user);
	login := public.qorpera_begin_native_provider_login(p_profile,extensions.gen_random_uuid(),p_client,p_identity,
		'openai','codex-cli',repeat('a',64),900);
	perform pg_temp.base_claims('service_role');
	connection := public.qorpera_complete_native_provider_login((login ->> 'login_id')::uuid,repeat('a',64),
		extensions.gen_random_uuid(),'object://wall-fixture/' || p_client,repeat('b',64),'same-display-reference',
		'personal-subscription','qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
	perform pg_temp.base_claims('authenticated',p_user);
	perform public.qorpera_create_member_execution_sponsor(p_profile,extensions.gen_random_uuid(),
		(connection ->> 'connection_id')::uuid,(connection ->> 'version')::bigint,false);
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_identity,provider_account_usage)
	values ((connection ->> 'connection_id')::uuid,(connection ->> 'version')::bigint,p_hash,
		jsonb_build_object('observedAt',clock_timestamp(),'windows',jsonb_build_array(
			jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));
	return (connection ->> 'connection_id')::uuid;
end $$;

do $$
declare profile_id uuid := '92400000-0000-4000-8000-000000000010';
	owner_id uuid := '92400000-0000-4000-8000-000000000001';
	identity_id uuid := (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
	original_id uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	duplicate_id uuid; different_id uuid; foreign_id uuid; foreign_identity uuid;
	rotated_version public.qorpera_provider_connection_versions%rowtype;
begin
	duplicate_id := pg_temp.r164_wall_account(profile_id,owner_id,identity_id,extensions.gen_random_uuid(),repeat('a',64));
	different_id := pg_temp.r164_wall_account(profile_id,owner_id,identity_id,extensions.gen_random_uuid(),repeat('b',64));
	if public.qorpera_native_account_remaining(original_id,2) <> 0
	  or public.qorpera_native_account_remaining(duplicate_id,1) <> 0 then
		raise exception 'Usage wall did not propagate to another login for the same account'; end if;
	if public.qorpera_native_account_remaining(different_id,1) <> 80 then
		raise exception 'Display-reference equality was mistaken for provider account identity'; end if;
	if exists(select 1 from public.qorpera_eligible_member_accounts(profile_id,owner_id) where connection_id=duplicate_id) then
		raise exception 'Same-account duplicate remained eligible after a usage wall'; end if;

	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
	foreign_identity := (public.qorpera_upsert_member_compute_identity(profile_id,extensions.gen_random_uuid(),
		'Other member','qorpera-member-linux','v1','["agent_turn"]','{}') ->> 'compute_identity_id')::uuid;
	foreign_id := pg_temp.r164_wall_account(profile_id,'92400000-0000-4000-8000-000000000002',foreign_identity,
		extensions.gen_random_uuid(),repeat('a',64));
	if public.qorpera_native_account_remaining(foreign_id,1) <> 80 then
		raise exception 'Usage wall leaked across members'; end if;

	insert into public.qorpera_profiles(id,name,created_by_user_id)
	values ('16400000-0000-4000-8000-000000000110','Other company',owner_id);
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	values ('16400000-0000-4000-8000-000000000110',owner_id,'base-owner@example.test','Owner','owner');
	perform pg_temp.base_claims('authenticated',owner_id);
	foreign_identity := (public.qorpera_upsert_member_compute_identity('16400000-0000-4000-8000-000000000110',
		extensions.gen_random_uuid(),'Other company','qorpera-member-linux','v1','["agent_turn"]','{}') ->> 'compute_identity_id')::uuid;
	foreign_id := pg_temp.r164_wall_account('16400000-0000-4000-8000-000000000110',owner_id,foreign_identity,
		extensions.gen_random_uuid(),repeat('a',64));
	if public.qorpera_native_account_remaining(foreign_id,1) <> 80 then
		raise exception 'Usage wall leaked across companies'; end if;

	-- Version the original connection onto account B's separately issued
	-- capsule. Login client correlation itself is intentionally single-use.
	select * into strict rotated_version from public.qorpera_provider_connection_versions
		where connection_id=different_id and version=1;
	rotated_version.connection_id := original_id;
	rotated_version.version := 3;
	insert into public.qorpera_provider_connection_versions select rotated_version.*;
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_identity,provider_account_usage)
	select original_id,3,provider_account_identity,provider_account_usage
		from public.qorpera_native_provider_account_metadata where connection_id=different_id and connection_version=1;
	perform pg_temp.base_claims('authenticated',owner_id);
	perform public.qorpera_create_member_execution_sponsor(profile_id,extensions.gen_random_uuid(),original_id,3,false);
	if public.qorpera_native_account_remaining(original_id,3) <> 80
	  or public.qorpera_native_account_remaining(different_id,1) <> 80 then
		raise exception 'Historical account wall blocked the new provider account'; end if;
	if public.qorpera_native_account_remaining(duplicate_id,1) <> 0 then
		raise exception 'Rotation erased the still-current old account wall'; end if;
	if not exists(select 1 from public.qorpera_eligible_member_accounts(profile_id,owner_id) where connection_id=original_id) then
		raise exception 'Redundant usage predicate excluded the rotated account'; end if;
end $$;
set constraints all immediate;
rollback;

-- @fixture 705_company_founding_lobby.test.sql until "-- Anna opens a table. Opening again with the same creation id gives the same table."
-- A used-up login is still connected at the founding table, and Start works on it (20260930579000). Found live on
-- 5 Nov 2026: the founder's only login was at its weekly limit, the table said "ChatGPT not connected" and kept Start
-- shut. Now the seat says the login is used up and when it resets, and the first run's payer is that login, where the
-- run waits for the reset; a login with room is still chosen first.

create function pg_temp.p955_anna() returns uuid language sql as $$ select '40000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.p955_seat() returns jsonb language plpgsql as $$
declare v_seat jsonb;
begin
	perform pg_temp.as_user(pg_temp.p955_anna());
	set local role authenticated;
	v_seat := public.qorpera_read_company_founding(current_setting('qorpera_test.table')::uuid) -> 'seats' -> 0;
	reset role;
	return v_seat;
end $$;
create function pg_temp.p955_connection(p_n integer) returns uuid language sql as $$
	select connection.id from public.qorpera_provider_connections as connection
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id and version.version = 2
	join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
	where connection.profile_id = current_setting('qorpera_test.table')::uuid
		and capsule.id = ('40000000-0000-4000-8000-000000000a' || lpad(to_hex(p_n),2,'0'))::uuid
$$;
-- A usage reading of login n taken a minute ago: its week is p_used percent used and resets in two days.
create function pg_temp.p955_reading(p_n integer, p_used numeric) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values (pg_temp.p955_connection(p_n), 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
		'windows', jsonb_build_array(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char((statement_timestamp() + interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;
create function pg_temp.p955_sponsor_connection() returns uuid language sql as $$
	select sponsor.provider_connection_id from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = (public.qorpera_member_first_run_sponsor(current_setting('qorpera_test.table')::uuid,
			pg_temp.p955_anna()) ->> 'sponsorBindingId')::uuid
		and sponsor.version = (public.qorpera_member_first_run_sponsor(current_setting('qorpera_test.table')::uuid,
			pg_temp.p955_anna()) ->> 'sponsorVersion')::bigint
$$;

-- The checks start here.
-- Anna opens a table alone. With no login she is not connected.
select pg_temp.as_user(pg_temp.p955_anna());
set local role authenticated;
select set_config('qorpera_test.table',(public.qorpera_open_company_founding(
	'40000000-0000-4000-8000-000000000100','Rumstuen') ->> 'profileId'),true);
reset role;
do $$
declare v_seat jsonb := pg_temp.p955_seat();
begin
	if (v_seat ->> 'modelLoginReady')::boolean or (v_seat ->> 'modelLoginUsedUp')::boolean
		or v_seat ->> 'modelLoginResetsAt' is not null then
		raise exception 'a founder with no login is connected: %', v_seat; end if;
end $$;

-- 1. Her only login is at its limit: she is connected, it is used up, and the seat says when it resets.
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,pg_temp.p955_anna(),1);
select pg_temp.p955_reading(1, 100);
do $$
declare v_seat jsonb := pg_temp.p955_seat();
begin
	if public.qorpera_native_account_remaining(pg_temp.p955_connection(1), 2) <> 0 then
		raise exception 'the fixture login is not at its limit'; end if;
	if not (v_seat ->> 'modelLoginReady')::boolean or not (v_seat ->> 'modelLoginUsedUp')::boolean
		or abs(extract(epoch from (v_seat ->> 'modelLoginResetsAt')::timestamptz
			- (statement_timestamp() + interval '2 days'))) > 2 then
		raise exception 'a used-up login does not show as connected and used up: %', v_seat; end if;
end $$;

-- 2. Its first run would be paid by that login: the run waits there for the reset.
do $$
begin
	if pg_temp.p955_sponsor_connection() is distinct from pg_temp.p955_connection(1) then
		raise exception 'a used-up login does not pay for the first run'; end if;
end $$;

-- 3. A second login with room is chosen first, and nothing is used up any more.
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,pg_temp.p955_anna(),2);
select pg_temp.p955_reading(2, 30);
do $$
declare v_seat jsonb := pg_temp.p955_seat();
begin
	if pg_temp.p955_sponsor_connection() is distinct from pg_temp.p955_connection(2) then
		raise exception 'the login with room is not chosen first'; end if;
	if not (v_seat ->> 'modelLoginReady')::boolean or (v_seat ->> 'modelLoginUsedUp')::boolean
		or v_seat ->> 'modelLoginResetsAt' is not null then
		raise exception 'a founder with a login with room shows as used up: %', v_seat; end if;
end $$;
-- Used up again: the one that resets first pays.
select pg_temp.p955_reading(2, 100);
do $$
begin
	if pg_temp.p955_sponsor_connection() is null then raise exception 'two used-up logins pay for nothing'; end if;
end $$;

-- 4. Ready and Start work on used-up logins; the started table says no first run waits yet (none is queued).
select pg_temp.as_user(pg_temp.p955_anna());
set local role authenticated;
do $$
declare v_table jsonb := public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,1,true);
begin
	if not (v_table -> 'me' ->> 'canStart')::boolean then
		raise exception 'a founder whose logins are used up cannot start: %', v_table; end if;
	v_table := public.qorpera_start_company_founding(current_setting('qorpera_test.table')::uuid,1,
		'40000000-0000-4000-8000-000000000200');
	if v_table ->> 'phase' <> 'started' or not (v_table -> 'start' ? 'firstRunWaitsUntil')
		or v_table -> 'start' ->> 'firstRunWaitsUntil' is not null then
		raise exception 'Start on a used-up login did not start the table: %', v_table; end if;
end $$;
reset role;
do $$
begin
	if not exists (select 1 from public.founding_test_seeds where profile_id = current_setting('qorpera_test.table')::uuid
		and input ->> 'kickoffRequestedBy' = pg_temp.p955_anna()::text) then
		raise exception 'Start on a used-up login seeded nothing'; end if;
end $$;

-- 5. A revoked login is not connected (as before).
update public.qorpera_provider_connections set status = 'revoked'
	where profile_id = current_setting('qorpera_test.table')::uuid and owner_user_id = pg_temp.p955_anna();
do $$
begin
	if public.qorpera_member_first_run_sponsor(current_setting('qorpera_test.table')::uuid, pg_temp.p955_anna()) is not null then
		raise exception 'a revoked login pays for a first run'; end if;
end $$;

-- The new helpers are the database's own.
do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_native_account_resets_at(uuid)',
		'public.qorpera_member_logins_used_up(uuid,uuid)','public.qorpera_folder_company_first_run_waits_until(uuid)'] loop
		if has_function_privilege('anon',v_function,'EXECUTE') or has_function_privilege('authenticated',v_function,'EXECUTE')
			or has_function_privilege('service_role',v_function,'EXECUTE') then
			raise exception 'API clients can call %', v_function; end if;
	end loop;
end $$;

rollback;

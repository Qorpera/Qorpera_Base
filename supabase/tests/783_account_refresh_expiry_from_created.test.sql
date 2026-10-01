-- @fixture 165_native_account_refresh_requests.test.sql until "select set_config('qorpera_test.refresh_login_count'"
-- An account refresh expires five minutes after its own created_at (20260929994000). Before, created_at and expires_at
-- defaulted to two separate clock_timestamp() calls, so a row inserted with both defaults could get an expires_at a few
-- microseconds past created_at + 5 minutes and be refused by the table's check (23514; node 2's hosted-db run of test
-- 764 on 2026-10-01). Test 165's fixture: the owner's member compute identity with an active Codex login, and no
-- account refresh yet. Rows below are written directly, as tests 693 and 764 do.
create function pg_temp.refresh783(p_status text, p_created_at timestamptz default null,
	p_expires_at timestamptz default null) returns public.qorpera_native_account_refresh_requests language plpgsql as $$
declare v_row public.qorpera_native_account_refresh_requests;
begin
	-- Only the columns given are named, so the others take their defaults.
	execute format('insert into public.qorpera_native_account_refresh_requests(profile_id, client_request_id,
		compute_identity_id, requested_by_user_id, capability_sha256, compute_recovery_epoch, status%s%s)
		select identity.profile_id, extensions.gen_random_uuid(), identity.id, identity.owner_user_id,
			encode(sha256(''refresh-783''::bytea), ''hex''), identity.recovery_epoch, $1%s%s
		from public.qorpera_member_compute_identities as identity where identity.id = $4
		returning *',
		case when p_created_at is null then '' else ', created_at' end,
		case when p_expires_at is null then '' else ', expires_at' end,
		case when p_created_at is null then '' else ', $2' end,
		case when p_expires_at is null then '' else ', $3' end)
	into strict v_row
	using p_status, p_created_at, p_expires_at,
		(current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid;
	return v_row;
end $$;

-- 1. The trigger is the table's alone: no API role may call it.
do $$
begin
	if has_function_privilege('anon', 'public.qorpera_account_refresh_expiry_from_created()', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_account_refresh_expiry_from_created()', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_account_refresh_expiry_from_created()', 'execute') then
		raise exception 'an API role may call qorpera_account_refresh_expiry_from_created'; end if;
end $$;

-- 2. The member's own refresh (the only production inserter) still expires five minutes after it was created.
select set_config('request.jwt.claims', '{"sub":"16500000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('qorpera_test.refresh783', public.qorpera_begin_native_account_refresh(
	'16500000-0000-4000-8000-000000000010', '78300000-0000-4000-8000-000000000001', repeat('c', 64))::text, true);
reset role;
do $$
declare v_row public.qorpera_native_account_refresh_requests;
begin
	select * into strict v_row from public.qorpera_native_account_refresh_requests
	where id = (current_setting('qorpera_test.refresh783')::jsonb ->> 'request_id')::uuid;
	if v_row.status <> 'pending' or v_row.expires_at <> v_row.created_at + interval '5 minutes' then
		raise exception 'The member''s refresh expires at % after its creation', v_row.expires_at - v_row.created_at; end if;
	update public.qorpera_native_account_refresh_requests set status = 'cancelled' where id = v_row.id;
end $$;

-- 3. A pending refresh written with both defaults (through the identity trigger) expires five minutes after it was
--    created, to the microsecond.
do $$
declare v_row public.qorpera_native_account_refresh_requests := pg_temp.refresh783('pending');
begin
	if v_row.compute_recovery_epoch is null or v_row.expires_at <> v_row.created_at + interval '5 minutes' then
		raise exception 'A defaulted pending refresh expires at % after its creation', v_row.expires_at - v_row.created_at; end if;
	update public.qorpera_native_account_refresh_requests set status = 'cancelled' where id = v_row.id;
end $$;

-- 4. Many rows with both defaults in one statement: each row's clock is read apart, and every one expires exactly five
--    minutes after its own creation. Before 20260929994000 this statement failed the check (23514) almost surely.
do $$
declare v_wrong bigint;
begin
	with written as (
		insert into public.qorpera_native_account_refresh_requests(profile_id, client_request_id, compute_identity_id,
			requested_by_user_id, capability_sha256, compute_recovery_epoch, status)
		select identity.profile_id, extensions.gen_random_uuid(), identity.id, identity.owner_user_id,
			encode(sha256('refresh-783'::bytea), 'hex'), identity.recovery_epoch, 'cancelled'
		from public.qorpera_member_compute_identities as identity, generate_series(1, 5000)
		where identity.id = (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid
		returning created_at, expires_at)
	select count(*) filter (where expires_at <> created_at + interval '5 minutes') into v_wrong from written;
	if v_wrong <> 0 then raise exception '% defaulted refreshes do not expire five minutes after creation', v_wrong; end if;
end $$;

-- 5. A row given only its created_at expires five minutes after that created_at, not after the clock.
do $$
declare
	v_created timestamptz := clock_timestamp() - interval '90 seconds';
	v_row public.qorpera_native_account_refresh_requests := pg_temp.refresh783('cancelled', v_created);
begin
	if v_row.created_at <> v_created or v_row.expires_at <> v_created + interval '5 minutes' then
		raise exception 'A refresh created at % expires at %', v_row.created_at, v_row.expires_at; end if;
end $$;

-- 6. An expires_at given explicitly is kept, and the check still holds: at most five minutes, after created_at.
do $$
declare
	v_created timestamptz := clock_timestamp();
	v_row public.qorpera_native_account_refresh_requests :=
		pg_temp.refresh783('cancelled', v_created, v_created + interval '4 minutes');
begin
	if v_row.expires_at <> v_created + interval '4 minutes' then
		raise exception 'A given expiry became %', v_row.expires_at; end if;
	begin
		perform pg_temp.refresh783('cancelled', v_created, v_created + interval '5 minutes 1 microsecond');
		raise exception 'A refresh lived past five minutes';
	exception when check_violation then null; end;
	begin
		perform pg_temp.refresh783('cancelled', v_created, v_created);
		raise exception 'A refresh expired as it was created';
	exception when check_violation then null; end;
	begin
		perform pg_temp.refresh783('cancelled', null, clock_timestamp() + interval '6 minutes');
		raise exception 'A refresh with a defaulted created_at lived past five minutes';
	exception when check_violation then null; end;
end $$;

set constraints all immediate;
rollback;

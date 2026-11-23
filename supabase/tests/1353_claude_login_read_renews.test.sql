-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('13530000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-1353-v1') \g /dev/null

create function pg_temp.r_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate;
end $$;
create function pg_temp.r_take(p_purpose text) returns jsonb language sql as $$
	select public.qorpera_take_claude_login_renewal('12680000-0000-4000-8000-000000000050', repeat('a', 64),
		'13530000-0000-4000-8000-0000000000c1', p_purpose)
$$;
create function pg_temp.r_unlock() returns void language sql as $$
	update public.qorpera_claude_logins set renewal_token = null, renewal_until = null, checked_at = null
	where id = '13530000-0000-4000-8000-0000000000c1'
$$;
create function pg_temp.r_request() returns public.qorpera_native_account_refresh_requests language sql as $$
	select * from public.qorpera_native_account_refresh_requests
	where claude_login_id = '13530000-0000-4000-8000-0000000000c1' order by created_at desc limit 1
$$;

do $$
begin
	perform pg_temp.base_assert(not has_function_privilege('authenticated',
			'public.qorpera_take_claude_login_renewal(uuid,text,uuid,text)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_take_claude_login_renewal(uuid,text,uuid,text)',
			'execute')
		and has_function_privilege('qorpera_secret_broker',
			'public.qorpera_take_claude_login_renewal(uuid,text,uuid,text)', 'execute'),
		'only the vault takes a renewal');
end $$;

create function pg_temp.r_s1() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb;
begin
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb and v ->> 'busy' = 'false',
		'1: no read is pending, so a read takes no renewal: ' || v::text);
	perform pg_temp.base_assert(pg_temp.r_state($q$select pg_temp.r_take('later')$q$) = '22023',
		'1: an unknown purpose is refused');
end $$;
grant execute on function pg_temp.r_s1() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.r_s1() \g /dev/null
reset session authorization;

select pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
set local role authenticated;
select public.qorpera_begin_claude_login_read('92400000-0000-4000-8000-000000000010',
	'13530000-0000-4000-8000-0000000000c1', extensions.gen_random_uuid(), repeat('1', 64), true, null) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

create function pg_temp.r_s2() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb;
begin
	perform pg_temp.base_assert((pg_temp.r_request()).status = 'pending' and (pg_temp.r_request()).claude_usage,
		'2: the member''s read is pending');
	v := pg_temp.r_take('open');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb,
		'2: a run''s open still needs a live run: ' || v::text);
	v := pg_temp.r_take('poll');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb,
		'2: a run''s poll still needs a live run: ' || v::text);
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v #>> '{renewal,token}' is not null
		and v ->> 'claudeLoginId' = '13530000-0000-4000-8000-0000000000c1',
		'2: a pending read of this login takes its renewal: ' || (v - 'encryptedEnvelopeBase64')::text);
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb and v ->> 'busy' = 'true',
		'2: one renewal at a time: ' || v::text);
	perform pg_temp.r_unlock();
	update public.qorpera_claude_logins set checked_at = clock_timestamp()
	where id = '13530000-0000-4000-8000-0000000000c1';
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb and v ->> 'busy' = 'false',
		'2: a login checked in the last 30 seconds is not checked again: ' || v::text);
	perform pg_temp.r_unlock();
	update public.qorpera_native_account_refresh_requests set claude_usage = false, claude_resets = false
	where id = (pg_temp.r_request()).id;
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb, '3: a read that reads nothing takes nothing: ' || v::text);
	update public.qorpera_native_account_refresh_requests set claude_resets = true
	where id = (pg_temp.r_request()).id;
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v #>> '{renewal,token}' is not null,
		'3: a pending resets read takes it: ' || (v - 'encryptedEnvelopeBase64')::text);
	perform pg_temp.r_unlock();
	update public.qorpera_native_account_refresh_requests set claude_resets = false, claude_reset_kind = 'full',
		claude_reset_state = 'asked'
	where id = (pg_temp.r_request()).id;
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v #>> '{renewal,token}' is not null,
		'3: a pending reset takes it: ' || (v - 'encryptedEnvelopeBase64')::text);
	perform pg_temp.r_unlock();
	update public.qorpera_native_account_refresh_requests set status = 'completed', completed_at = clock_timestamp()
	where id = (pg_temp.r_request()).id;
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb, '3: a read no longer pending takes nothing: ' || v::text);
	insert into public.qorpera_native_account_refresh_requests(profile_id, client_request_id, compute_identity_id,
		requested_by_user_id, capability_sha256, compute_recovery_epoch, status, created_at, expires_at,
		claude_login_id, claude_usage, claude_resets)
	select profile_id, extensions.gen_random_uuid(), compute_identity_id, requested_by_user_id, repeat('2', 64),
		compute_recovery_epoch, 'pending', clock_timestamp() - interval '10 minutes',
		clock_timestamp() - interval '7 minutes', claude_login_id, true, true
	from public.qorpera_native_account_refresh_requests where id = (pg_temp.r_request()).id;
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_native_account_refresh_requests
		where capability_sha256 = repeat('2', 64) and status = 'pending' and expires_at < clock_timestamp()
			and claude_login_id = '13530000-0000-4000-8000-0000000000c1'), '3: a pending read whose time has passed');
	v := pg_temp.r_take('read');
	perform pg_temp.base_assert(v -> 'renewal' = 'null'::jsonb, '3: an expired read takes nothing: ' || v::text);
end $$;
grant execute on function pg_temp.r_s2() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.r_s2() \g /dev/null
reset session authorization;

-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
-- 20260930771000 (Claude Code on the agent's home, slice C4b): the shared vault opens a member's sealed Claude login for
-- ONE run of a Claude Code worker and seals the credentials file back. On 1268's fixture (924's base, 1246's machine,
-- the shared vault serving the company): a Claude Code worker of the owner's word is dispatched, started by the drain,
-- materialized and started on a real runner with a native lease, and its run's binding asks.
-- 1. The open: the sealed files with their digest, the member and key, version 1; the description without the files.
-- 2. Who may ask, each refused whole (42501) and naming nothing: another company's broker authority, a wrong capability,
--    the agent's own conversation run, a plain worker's run, the run once its member's lease is not its own (taken by
--    another wake, or its wake ended), and a seal naming another login.
-- 3. The seal-back: a compare-and-swap on the version and envelope opened; the version goes up by one; a repeat of the
--    saved seal answers it again; a stale base answers stale and the newer envelope stays; a key other than the
--    login's, an envelope that is not its digest, and shapes out of bounds are invalid (22023).
-- 4. What the login must be now: signed out (the member signed in again) answers SIGNED_OUT to the open and the seal;
--    the member taken off the Claude list between the dispatch and the open answers NOT_OPEN; on again, open.
-- 5. Only the vault's own role calls the three functions; the inner check is nobody's.
-- The vault's calls run in the vault's own session (qorpera_model_login_authority asks session_user): each section's
-- checks run as that session, through a function that may also change rows to set up a case.

-- The owner's Claude login (made-up sealed files) and a Claude Code worker on their word, running.
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12690000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-c4b-sealed-1') \g /dev/null
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; v_pass jsonb; v_binding jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_i integer;
begin
	v_result := pg_temp.c4_dispatch(v_alice, 'c4b-dispatch-1', 'QorperaOS/agents/alice/todos/onboarding/pdf',
		pg_temp.c4_brief('12690000-0000-4000-8000-0000000000b1'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch: ' || v_result::text);
	-- A plain worker beside it, for a run that is not a Claude Code worker's.
	v_result := pg_temp.c4_dispatch(v_alice, 'c4b-dispatch-2', 'QorperaOS/agents/alice/todos/onboarding/notes',
		pg_temp.c4_brief('12690000-0000-4000-8000-0000000000b2', null, 'Read the notes'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the plain dispatch: ' || v_result::text);
	perform pg_temp.c4_drain();
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences
	where id = (pg_temp.c4_worker('12690000-0000-4000-8000-0000000000b1')).occurrence_id;
	perform pg_temp.base_assert(v_wake.run_id is not null, 'the Claude Code worker''s wake has a run: ' || v_pass::text);
	-- Both runs start on real runners, in the queue's order; the run host's model-login binding is the native lease's
	-- seven fields.
	for v_i in 1..2 loop
		v_binding := pg_temp.base_start(null) - array['provider', 'nativeHarness', 'model'];
		perform set_config(case when (v_binding ->> 'runId')::uuid = v_wake.run_id then 'qorpera_test.c4b_binding'
			else 'qorpera_test.c4b_plain_binding' end, v_binding::text, false);
	end loop;
	perform pg_temp.base_assert(current_setting('qorpera_test.c4b_binding', true) is not null
		and current_setting('qorpera_test.c4b_plain_binding', true) is not null, 'both runs started');
end $$;

create function pg_temp.c4b_binding() returns jsonb language sql as $$
	select current_setting('qorpera_test.c4b_binding')::jsonb
$$;
create function pg_temp.c4b_open(p_binding jsonb default null, p_authority uuid default '12680000-0000-4000-8000-000000000040',
	p_capability text default repeat('c', 64)) returns jsonb language sql as $$
	select public.qorpera_open_claude_login_for_run(p_authority, p_capability, coalesce(p_binding, pg_temp.c4b_binding()))
$$;
create function pg_temp.c4b_seal(p_base_version bigint, p_base_sha text, p_envelope text, p_key text default 'vault-root-1',
	p_login uuid default '12690000-0000-4000-8000-0000000000c1', p_binding jsonb default null) returns jsonb language sql as $$
	select public.qorpera_seal_claude_login_back('12680000-0000-4000-8000-000000000040', repeat('c', 64),
		coalesce(p_binding, pg_temp.c4b_binding()), p_login, p_base_version, p_base_sha, p_key,
		encode(convert_to(p_envelope, 'UTF8'), 'base64'), encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex'))
$$;
create function pg_temp.c4b_sha(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex')
$$;
-- The SQLSTATE a call raises, or 'ok'.
create function pg_temp.c4b_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate;
end $$;
create function pg_temp.c4b_login() returns public.qorpera_claude_logins language sql as $$
	select * from public.qorpera_claude_logins where id = '12690000-0000-4000-8000-0000000000c1'
$$;

-- 1. The open --------------------------------------------------------------------------------------------------------
create function pg_temp.c4b_s1() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb := pg_temp.c4b_open();
begin
	perform pg_temp.base_assert(v ->> 'state' = 'open' and v ->> 'claudeLoginId' = '12690000-0000-4000-8000-0000000000c1'
		and v ->> 'ownerUserId' = pg_temp.c4_owner_id()::text and v ->> 'keyId' = 'vault-root-1' and (v ->> 'version')::bigint = 1
		and v ->> 'envelopeSha256' = pg_temp.c4b_sha('canary-c4b-sealed-1')
		and convert_from(decode(v ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'canary-c4b-sealed-1',
		'1: the run opens its member''s login: ' || (v - 'encryptedEnvelopeBase64')::text);
	v := public.qorpera_describe_claude_login_for_run('12680000-0000-4000-8000-000000000040', repeat('c', 64), pg_temp.c4b_binding());
	perform pg_temp.base_assert(v ->> 'state' = 'described' and not v ? 'encryptedEnvelopeBase64'
		and v ->> 'envelopeSha256' = pg_temp.c4b_sha('canary-c4b-sealed-1') and (v ->> 'version')::bigint = 1,
		'1: the description holds no sealed files: ' || v::text);
end $$;
grant execute on function pg_temp.c4b_s1() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.c4b_s1() \g /dev/null
reset session authorization;

-- 2. Who may ask ----------------------------------------------------------------------------------------------------
create function pg_temp.c4b_s2() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_other uuid := extensions.gen_random_uuid();
begin
	-- A broker authority of another company, and a wrong capability.
	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values ('12690000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
		principal_id)
	values (v_other, '12690000-0000-4000-8000-000000000010', 'https://vault.qorpera.test', 'vault-root-1', repeat('d', 64),
		'12680000-0000-4000-8000-000000000050');
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_open(null, %L, %L)', v_other, repeat('d', 64)))
		= '42501', '2: another company''s authority');
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_open(null, %L, %L)',
		'12680000-0000-4000-8000-000000000040', repeat('e', 64))) <> 'ok', '2: a wrong capability');
	-- The agent's own conversation run: not a worker's.
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_open(%L)',
		(select (b.v - array['provider', 'nativeHarness', 'model'])::text from (select pg_temp.c4_alice() v) b))) in ('42501', '22023'),
		'2: the agent''s conversation run');
	-- A plain worker's run.
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_open(%L)',
		current_setting('qorpera_test.c4b_plain_binding'))) = '42501', '2: a plain worker''s run');
	-- A binding with another lease id (not this run's exact native lease).
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_open(%L)',
		(pg_temp.c4b_binding() || jsonb_build_object('leaseId', extensions.gen_random_uuid()))::text)) <> 'ok',
		'2: another lease');
	-- A seal naming another login.
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_seal(1, %L, %L, %L, %L)',
		pg_temp.c4b_sha('canary-c4b-sealed-1'), 'canary-c4b-renewed', 'vault-root-1', extensions.gen_random_uuid())) = '42501',
		'2: a seal naming another login');
	-- The member's lease taken by another wake (for this check only): the run's own lease is gone.
	begin
		update public.qorpera_claude_worker_leases set wake_id = (pg_temp.c4_worker('12690000-0000-4000-8000-0000000000b2')).occurrence_id
		where owner_user_id = pg_temp.c4_owner_id();
		perform pg_temp.base_assert(pg_temp.c4b_state('select pg_temp.c4b_open()') = '42501', '2: a lease that is not this run''s');
		perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_seal(1, %L, %L)',
			pg_temp.c4b_sha('canary-c4b-sealed-1'), 'canary-c4b-renewed')) = '42501', '2: nor its seal-back');
		raise exception 'c4b-undo';
	exception when raise_exception then if sqlerrm <> 'c4b-undo' then raise; end if;
	end;
	-- Its wake ended (as a stop ends it) while the job is still leased: the lease no longer holds.
	begin
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
		where id = (pg_temp.c4_worker('12690000-0000-4000-8000-0000000000b1')).occurrence_id;
		perform pg_temp.base_assert(pg_temp.c4b_state('select pg_temp.c4b_open()') = '42501', '2: a lease that ended');
		raise exception 'c4b-undo';
	exception when raise_exception then if sqlerrm <> 'c4b-undo' then raise; end if;
	end;
	-- No lease row at all.
	begin
		delete from public.qorpera_claude_worker_leases where owner_user_id = pg_temp.c4_owner_id();
		perform pg_temp.base_assert(pg_temp.c4b_state('select pg_temp.c4b_open()') = '42501', '2: no lease');
		raise exception 'c4b-undo';
	exception when raise_exception then if sqlerrm <> 'c4b-undo' then raise; end if;
	end;
	perform pg_temp.base_assert(pg_temp.c4b_open() ->> 'state' = 'open', '2: put back, the run opens it again');
end $$;
grant execute on function pg_temp.c4b_s2() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.c4b_s2() \g /dev/null
reset session authorization;

-- 3. The seal-back ---------------------------------------------------------------------------------------------------
create function pg_temp.c4b_s3() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb; v_base text := pg_temp.c4b_sha('canary-c4b-sealed-1');
begin
	-- Out of bounds and not its own: invalid.
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_seal(1, %L, %L, %L)', v_base,
		'canary-c4b-renewed', 'vault-root-2')) = '22023', '3: a key other than the login''s');
	perform pg_temp.base_assert(pg_temp.c4b_state(format($q$select public.qorpera_seal_claude_login_back(
		'12680000-0000-4000-8000-000000000040', repeat('c', 64), %L::jsonb, '12690000-0000-4000-8000-0000000000c1', 1, %L,
		'vault-root-1', encode('abc'::bytea, 'base64'), repeat('0', 64))$q$, pg_temp.c4b_binding(), v_base)) = '22023',
		'3: an envelope that is not its digest');
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_seal(0, %L, %L)', v_base, 'canary-c4b-renewed'))
		= '22023', '3: version 0');
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_seal(1, %L, %L)', 'nope', 'canary-c4b-renewed'))
		= '22023', '3: a base that is no digest');
	perform pg_temp.base_assert((pg_temp.c4b_login()).version = 1, '3: nothing sealed yet');
	-- The swap.
	v := pg_temp.c4b_seal(1, v_base, 'canary-c4b-renewed');
	perform pg_temp.base_assert(v ->> 'state' = 'sealed' and (v ->> 'version')::bigint = 2
		and v ->> 'envelopeSha256' = pg_temp.c4b_sha('canary-c4b-renewed'), '3: sealed as version 2: ' || v::text);
	perform pg_temp.base_assert((pg_temp.c4b_login()).version = 2
		and convert_from((pg_temp.c4b_login()).encrypted_envelope, 'UTF8') = 'canary-c4b-renewed'
		and (pg_temp.c4b_login()).envelope_sha256 = pg_temp.c4b_sha('canary-c4b-renewed'), '3: the login holds it');
	-- The same seal again (a lost answer): the same answer, nothing more.
	v := pg_temp.c4b_seal(1, v_base, 'canary-c4b-renewed');
	perform pg_temp.base_assert(v ->> 'state' = 'sealed' and (v ->> 'version')::bigint = 2 and (pg_temp.c4b_login()).version = 2,
		'3: a repeat answers the same: ' || v::text);
	-- A stale swap: another seal from version 1 (a second run's), refused; the newer envelope stays.
	v := pg_temp.c4b_seal(1, v_base, 'canary-c4b-other-run');
	perform pg_temp.base_assert(v ->> 'state' = 'stale' and (v ->> 'version')::bigint = 2
		and convert_from((pg_temp.c4b_login()).encrypted_envelope, 'UTF8') = 'canary-c4b-renewed',
		'3: a stale swap is refused and the newer envelope stays: ' || v::text);
	-- A base version that is right with another envelope digest is stale too.
	v := pg_temp.c4b_seal(2, v_base, 'canary-c4b-other-run');
	perform pg_temp.base_assert(v ->> 'state' = 'stale' and (pg_temp.c4b_login()).version = 2, '3: the digest is part of the base');
	-- The next swap from version 2.
	v := pg_temp.c4b_seal(2, pg_temp.c4b_sha('canary-c4b-renewed'), 'canary-c4b-renewed-again');
	perform pg_temp.base_assert(v ->> 'state' = 'sealed' and (v ->> 'version')::bigint = 3, '3: version 3: ' || v::text);
	-- The open now hands the newest.
	v := pg_temp.c4b_open();
	perform pg_temp.base_assert((v ->> 'version')::bigint = 3 and v ->> 'envelopeSha256' = pg_temp.c4b_sha('canary-c4b-renewed-again'),
		'3: the open hands the newest version');
end $$;
grant execute on function pg_temp.c4b_s3() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.c4b_s3() \g /dev/null
reset session authorization;

-- 4. What the login must be now --------------------------------------------------------------------------------------
create function pg_temp.c4b_s4() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb;
begin
	-- The member taken off the Claude list between the dispatch and the open.
	delete from public.qorpera_claude_sign_in_members where user_id = pg_temp.c4_owner_id();
	v := pg_temp.c4b_open();
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'refused',
		'reason', 'NOT_OPEN'), '4: off the list: ' || v::text);
	v := pg_temp.c4b_seal(3, pg_temp.c4b_sha('canary-c4b-renewed-again'), 'canary-c4b-late');
	perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'NOT_OPEN' and (pg_temp.c4b_login()).version = 3,
		'4: and its seal-back: ' || v::text);
	-- Account logins switched off: not open either.
	insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
	update public.qorpera_account_model_login_settings set enabled = false;
	perform pg_temp.base_assert(pg_temp.c4b_open() ->> 'reason' = 'NOT_OPEN', '4: the sign-in switched off');
	update public.qorpera_account_model_login_settings set enabled = true;
	perform pg_temp.base_assert(pg_temp.c4b_open() ->> 'state' = 'open', '4: on the list again, it opens');
	-- The member signed in again: the worker's recorded login is signed out, and the new one is not this run's.
	perform pg_temp.c4_login('12690000-0000-4000-8000-0000000000c2', pg_temp.c4_owner_id(), 'canary-c4b-new-sign-in');
	v := pg_temp.c4b_open();
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'refused',
		'reason', 'SIGNED_OUT'), '4: a signed-out login: ' || v::text);
	v := pg_temp.c4b_seal(3, pg_temp.c4b_sha('canary-c4b-renewed-again'), 'canary-c4b-late');
	perform pg_temp.base_assert(v ->> 'state' = 'refused' and v ->> 'reason' = 'SIGNED_OUT', '4: and its seal-back: ' || v::text);
	perform pg_temp.base_assert(pg_temp.c4b_state(format('select pg_temp.c4b_seal(1, %L, %L, %L, %L)',
		pg_temp.c4b_sha('canary-c4b-new-sign-in'), 'canary-c4b-late', 'vault-root-1', '12690000-0000-4000-8000-0000000000c2'))
		= '42501', '4: the new login is not this run''s to seal');
	perform pg_temp.base_assert((select envelope_sha256 from public.qorpera_claude_logins where id = '12690000-0000-4000-8000-0000000000c2')
		= pg_temp.c4b_sha('canary-c4b-new-sign-in'), '4: the new login is untouched');
end $$;
grant execute on function pg_temp.c4b_s4() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.c4b_s4() \g /dev/null
reset session authorization;

-- 5. Whose these are --------------------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_open_claude_login_for_run(uuid,text,jsonb)',
		'public.qorpera_describe_claude_login_for_run(uuid,text,jsonb)',
		'public.qorpera_seal_claude_login_back(uuid,text,jsonb,uuid,bigint,text,text,text,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			if has_function_privilege(v_role, v_function, 'execute') then raise exception '5: % may call %', v_role, v_function; end if;
		end loop;
		if not has_function_privilege('qorpera_secret_broker', v_function, 'execute') then
			raise exception '5: the vault may not call %', v_function; end if;
		if position('20260930771000' in pg_get_functiondef(v_function::regprocedure)) = 0 then
			raise exception '5: % does not name 20260930771000', v_function; end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_claude_login_run(uuid,text,jsonb,boolean)', 'execute')
			or has_function_privilege(v_role, 'public.qorpera_claude_login_run_refusal(public.qorpera_claude_logins,uuid)', 'execute') then
			raise exception '5: % may call the inner check', v_role; end if;
	end loop;
end $$;

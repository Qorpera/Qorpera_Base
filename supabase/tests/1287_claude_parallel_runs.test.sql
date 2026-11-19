-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12870000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-1287-v1') \g /dev/null

create function pg_temp.p_brief(p_n integer) returns jsonb language sql as $$
	select pg_temp.c4_brief(('12870000-0000-4000-8000-' || lpad(to_hex(176 + p_n), 12, '0'))::uuid, p_title => 'Part ' || p_n)
$$;
create function pg_temp.p_worker(p_n integer) returns public.qorpera_runtime_workers language sql as $$
	select pg_temp.c4_worker(('12870000-0000-4000-8000-' || lpad(to_hex(176 + p_n), 12, '0'))::uuid)
$$;
create function pg_temp.p_dispatch(p_n integer) returns void language plpgsql as $$
declare v jsonb := pg_temp.c4_dispatch(pg_temp.c4_alice(), 'p-dispatch-' || p_n,
	'QorperaOS/agents/alice/todos/onboarding/part-' || p_n, pg_temp.p_brief(p_n));
begin
	perform pg_temp.base_assert(v -> 'units' -> 0 ->> 'outcome' = 'saved', 'dispatch ' || p_n || ': ' || v::text);
end $$;
create function pg_temp.p_live() returns integer language sql as $$
	select count(*)::integer from public.qorpera_claude_worker_leases lease
	where lease.owner_user_id = pg_temp.c4_owner_id() and public.qorpera_claude_worker_lease_live(lease)
$$;
create function pg_temp.p_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate;
end $$;
create function pg_temp.p_sha(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex')
$$;
create function pg_temp.p_login() returns public.qorpera_claude_logins language sql as $$
	select * from public.qorpera_claude_logins where id = '12870000-0000-4000-8000-0000000000c1'
$$;

do $$
declare v_drain jsonb; v_i integer;
begin
	perform pg_temp.base_assert(public.qorpera_claude_worker_run_cap() = 1, '1: the migration keeps one');
	perform pg_temp.p_dispatch(1);
	perform pg_temp.p_dispatch(2);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.p_worker(1)).occurrence_id is not null and (pg_temp.p_worker(2)).occurrence_id is null
		and pg_temp.p_live() = 1 and public.qorpera_claude_worker_waits(pg_temp.p_worker(2)),
		'1: with a cap of one the second waits: ' || v_drain::text);
	update public.qorpera_claude_parallel_runs set cap = 4;
	perform pg_temp.base_assert(not public.qorpera_claude_worker_waits(pg_temp.p_worker(2)), '1: under four it does not wait');
	for v_i in 3..5 loop perform pg_temp.p_dispatch(v_i); end loop;
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert(pg_temp.p_live() = 4 and (pg_temp.p_worker(5)).occurrence_id is null
		and public.qorpera_claude_worker_waits(pg_temp.p_worker(5)) and not public.qorpera_folder_worker_due(pg_temp.p_worker(5))
		and (select array_agg(slot order by slot) from public.qorpera_claude_worker_leases
			where owner_user_id = pg_temp.c4_owner_id()) = array[1, 2, 3, 4]::smallint[],
		'1: four start, each on its own slot, and the fifth waits: ' || v_drain::text);
	for v_i in 1..4 loop
		perform pg_temp.base_assert(exists (select 1 from public.qorpera_claude_worker_leases lease
			where lease.worker_id = (pg_temp.p_worker(v_i)).id and lease.wake_id = (pg_temp.p_worker(v_i)).occurrence_id),
			'1: worker ' || v_i || ' holds a lease under its wake');
	end loop;
	perform pg_temp.base_assert(not public.qorpera_claude_worker_lease_take(pg_temp.p_worker(5), extensions.gen_random_uuid())
		and pg_temp.p_live() = 4, '1: a take past the cap takes nothing over');
end $$;

do $$
declare v_pass jsonb; v_binding jsonb; v_i integer; v_runs jsonb := '{}';
begin
	v_pass := pg_temp.base_materialize();
	for v_i in 1..4 loop
		perform pg_temp.base_assert((select run_id from public.qorpera_wake_occurrences
			where id = (pg_temp.p_worker(v_i)).occurrence_id) is not null, '2: worker ' || v_i || ' has a run: ' || v_pass::text);
		v_runs := v_runs || jsonb_build_object((select run_id from public.qorpera_wake_occurrences
			where id = (pg_temp.p_worker(v_i)).occurrence_id)::text, v_i);
	end loop;
	for v_i in 1..4 loop
		v_binding := pg_temp.base_start(null) - array['provider', 'nativeHarness', 'model'];
		perform pg_temp.base_assert(v_runs ? (v_binding ->> 'runId'), '2: a started run is a worker''s: ' || v_binding::text);
		perform set_config('qorpera_test.p_binding_' || (v_runs ->> (v_binding ->> 'runId')), v_binding::text, false);
	end loop;
end $$;

create function pg_temp.p_binding(p_n integer) returns jsonb language sql as $$
	select current_setting('qorpera_test.p_binding_' || p_n)::jsonb
$$;
create function pg_temp.p_open(p_n integer, p_known bigint default null) returns jsonb language sql as $$
	select public.qorpera_open_claude_login_for_run('12680000-0000-4000-8000-000000000040', repeat('c', 64),
		pg_temp.p_binding(p_n), p_known)
$$;
create function pg_temp.p_take(p_purpose text, p_login uuid default '12870000-0000-4000-8000-0000000000c1',
	p_capability text default repeat('a', 64)) returns jsonb language sql as $$
	select public.qorpera_take_claude_login_renewal('12680000-0000-4000-8000-000000000050', p_capability, p_login, p_purpose)
$$;
create function pg_temp.p_idle() returns jsonb language sql as $$
	select public.qorpera_take_idle_claude_login_renewal('12680000-0000-4000-8000-000000000050', repeat('a', 64))
$$;
create function pg_temp.p_commit(p_take jsonb, p_envelope text, p_base_version bigint default null,
	p_base_sha text default null, p_key text default 'vault-root-1', p_token uuid default null) returns jsonb language sql as $$
	select public.qorpera_commit_claude_login_renewal('12680000-0000-4000-8000-000000000050', repeat('a', 64),
		'12870000-0000-4000-8000-0000000000c1', coalesce(p_token, (p_take #>> '{renewal,token}')::uuid),
		coalesce(p_base_version, (p_take #>> '{renewal,baseVersion}')::bigint), coalesce(p_base_sha, p_take ->> 'envelopeSha256'),
		p_key, encode(convert_to(p_envelope, 'UTF8'), 'base64'), pg_temp.p_sha(p_envelope))
$$;
create function pg_temp.p_release(p_take jsonb, p_outcome text) returns jsonb language sql as $$
	select public.qorpera_release_claude_login_renewal('12680000-0000-4000-8000-000000000050', repeat('a', 64),
		'12870000-0000-4000-8000-0000000000c1', (p_take #>> '{renewal,token}')::uuid, p_outcome)
$$;
create function pg_temp.p_back(p_checked interval, p_refused interval default null) returns void language sql as $$
	update public.qorpera_claude_logins set checked_at = clock_timestamp() - p_checked,
		refused_at = case when p_refused is null then refused_at else clock_timestamp() - p_refused end
	where id = '12870000-0000-4000-8000-0000000000c1'
$$;

create function pg_temp.p_s2() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb; v_i integer;
begin
	for v_i in 1..4 loop
		v := pg_temp.p_open(v_i);
		perform pg_temp.base_assert(v ->> 'state' = 'open' and (v ->> 'version')::bigint = 1
			and v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1'
			and convert_from(decode(v ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'canary-1287-v1',
			'2: run ' || v_i || ' opens the login: ' || (v - 'encryptedEnvelopeBase64')::text);
		v := pg_temp.p_open(v_i, 1);
		perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.claude-login-for-run/v1', 'state', 'current',
			'claudeLoginId', '12870000-0000-4000-8000-0000000000c1', 'version', 1),
			'2: run ' || v_i || ' holding version 1 is current: ' || v::text);
	end loop;
	perform pg_temp.base_assert(pg_temp.p_open(1, 7) ->> 'state' = 'open', '2: a version it does not hold gets the files');
	perform pg_temp.base_assert(pg_temp.p_state('select pg_temp.p_open(1, 0)') = '22023', '2: version 0 is invalid');
	perform pg_temp.base_assert(pg_temp.p_state(format('select public.qorpera_open_claude_login_for_run(%L, %L, %L, 1)',
		'12680000-0000-4000-8000-000000000040', repeat('c', 64),
		(pg_temp.p_binding(1) || jsonb_build_object('runId', (pg_temp.p_binding(2) ->> 'runId')))::text)) <> 'ok',
		'2: a binding of one run naming another''s id opens nothing');
	perform pg_temp.base_assert((public.qorpera_open_claude_login_for_run('12680000-0000-4000-8000-000000000040', repeat('c', 64),
		pg_temp.p_binding(3)) ->> 'state') = 'open', '2: the three-argument open still answers');
end $$;
grant execute on function pg_temp.p_s2() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.p_s2() \g /dev/null
reset session authorization;

create function pg_temp.p_s3() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb; v2 jsonb; c jsonb; l public.qorpera_claude_logins%rowtype;
begin
	perform pg_temp.base_assert(pg_temp.p_state('select pg_temp.p_take(''open'', p_capability => repeat(''b'', 64))') = '42501',
		'3: another capability is not the vault''s');
	perform pg_temp.base_assert(pg_temp.p_state('select pg_temp.p_take(''soon'')') = '22023', '3: a purpose is open or poll');
	v := pg_temp.p_take('open');
	perform pg_temp.base_assert(v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1' and (v ->> 'version')::bigint = 1
		and v #>> '{renewal,baseVersion}' = '1' and v ->> 'ownerUserId' = pg_temp.c4_owner_id()::text
		and v ->> 'keyId' = 'vault-root-1' and v ->> 'envelopeSha256' = pg_temp.p_sha('canary-1287-v1')
		and convert_from(decode(v ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'canary-1287-v1',
		'3: a run''s open takes the never-checked login''s lock: ' || (v - 'encryptedEnvelopeBase64')::text);
	perform pg_temp.base_assert(pg_temp.p_take('open') = '{"schema":"qorpera.claude-login-renewal/v1","renewal":null,"busy":true}'::jsonb
		and pg_temp.p_idle() -> 'renewal' = 'null'::jsonb,
		'3: one renewal at a time: the lock holds against an open (busy) and the idle pass');
	perform pg_temp.base_assert(pg_temp.p_state(format('select pg_temp.p_commit(%L::jsonb, %L, p_key => %L)', v, 'canary-1287-v2', 'other-key'))
		= '22023', '3: a commit under another key is invalid');
	perform pg_temp.base_assert(pg_temp.p_state(format($q$select public.qorpera_commit_claude_login_renewal(%L, %L, %L, %L, 1, %L,
		'vault-root-1', %L, %L)$q$, '12680000-0000-4000-8000-000000000050', repeat('a', 64), '12870000-0000-4000-8000-0000000000c1',
		v #>> '{renewal,token}', v ->> 'envelopeSha256', encode(convert_to('x', 'UTF8'), 'base64'), repeat('0', 64))) = '22023',
		'3: an envelope that is not its digest is invalid');
	c := pg_temp.p_commit(v, 'canary-1287-v2', p_token => extensions.gen_random_uuid());
	l := pg_temp.p_login();
	perform pg_temp.base_assert(c ->> 'state' = 'sealed' and (c ->> 'version')::bigint = 2 and l.version = 2
		and l.envelope_sha256 = pg_temp.p_sha('canary-1287-v2') and l.renewal_token is null and l.renewal_until is null
		and l.checked_at is not null and l.renewed_at = l.checked_at,
		'3: a renewal on the base it was taken from seals version 2, also when another holds the lock now: ' || c::text);
	perform pg_temp.base_assert(pg_temp.p_release(v, 'refused') ->> 'state' = 'stale' and (pg_temp.p_login()).refused_version is null,
		'3: the lock''s holder then finds it gone and records no refusal');
	perform pg_temp.base_assert(pg_temp.p_commit(v, 'canary-1287-v3') ->> 'state' = 'stale' and (pg_temp.p_login()).version = 2,
		'3: a repeat of the lock seals nothing more');
	v := pg_temp.p_open(1, 1);
	perform pg_temp.base_assert(v ->> 'state' = 'open' and (v ->> 'version')::bigint = 2
		and convert_from(decode(v ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'canary-1287-v2',
		'3: a run holding version 1 gets version 2 in place');
	perform pg_temp.base_assert(pg_temp.p_open(4, 2) ->> 'state' = 'current', '3: a run holding version 2 is current');
	perform pg_temp.base_assert(pg_temp.p_take('open') = '{"schema":"qorpera.claude-login-renewal/v1","renewal":null,"busy":false}'::jsonb
		and pg_temp.p_take('poll') -> 'renewal' = 'null'::jsonb, '3: just checked: not due for an open or a poll, and not busy');
	perform pg_temp.p_back(interval '40 seconds');
	perform pg_temp.base_assert(pg_temp.p_take('poll') -> 'renewal' = 'null'::jsonb, '3: a poll waits 90 seconds');
	v := pg_temp.p_take('open');
	perform pg_temp.base_assert(v -> 'renewal' <> 'null'::jsonb, '3: an open after 30 seconds checks again');
	c := pg_temp.p_commit(v, 'canary-1287-v3', p_base_version => 1, p_base_sha => pg_temp.p_sha('canary-1287-v1'));
	perform pg_temp.base_assert(c ->> 'state' = 'stale' and (pg_temp.p_login()).version = 2 and (pg_temp.p_login()).renewal_token is null,
		'3: a stale base seals nothing: ' || c::text);
	v2 := pg_temp.p_take('open');
	c := pg_temp.p_commit(v2, 'canary-1287-v3', p_base_version => 1, p_base_sha => pg_temp.p_sha('canary-1287-v1'),
		p_token => extensions.gen_random_uuid());
	perform pg_temp.base_assert(c ->> 'state' = 'stale' and (pg_temp.p_login()).renewal_token = (v2 #>> '{renewal,token}')::uuid,
		'3: a late commit on an old base leaves another holder''s lock as it is');
	perform pg_temp.p_release(v2, 'unchanged');
	perform pg_temp.p_back(interval '130 seconds');
	v := pg_temp.p_take('poll');
	v2 := pg_temp.p_release(v, 'unchanged');
	l := pg_temp.p_login();
	perform pg_temp.base_assert(v2 ->> 'state' = 'released' and l.checked_at > clock_timestamp() - interval '5 seconds'
		and l.renewal_token is null and l.version = 2, '3: an unchanged check is recorded: ' || v2::text);
	perform pg_temp.base_assert(pg_temp.p_release(v, 'unchanged') ->> 'state' = 'stale', '3: a released lock is gone');
	perform pg_temp.base_assert(pg_temp.p_state(format('select pg_temp.p_release(%L::jsonb, %L)', v, 'gone')) = '22023',
		'3: an outcome is unchanged, failed or refused');
	perform pg_temp.p_back(interval '130 seconds');
	v := pg_temp.p_take('poll');
	perform pg_temp.base_assert(pg_temp.p_release(v, 'refused') ->> 'state' = 'released' and (pg_temp.p_login()).status = 'active'
		and (pg_temp.p_login()).refused_version = 2, '3: one refusal is recorded, the login stays');
	perform pg_temp.base_assert(pg_temp.p_idle() -> 'renewal' = 'null'::jsonb, '3: the idle pass waits two minutes for the second look');
	perform pg_temp.p_back(interval '130 seconds', interval '30 seconds');
	v := pg_temp.p_take('poll');
	perform pg_temp.base_assert(pg_temp.p_release(v, 'refused') ->> 'state' = 'released' and (pg_temp.p_login()).status = 'active',
		'3: a second refusal within two minutes of the first waits');
	perform pg_temp.p_back(interval '130 seconds');
	v := pg_temp.p_take('poll');
	perform pg_temp.base_assert(pg_temp.p_release(v, 'failed') ->> 'state' = 'released'
		and (pg_temp.p_login()).refused_version = 2 and (pg_temp.p_login()).checked_at < clock_timestamp() - interval '120 seconds',
		'3: a failed check keeps the refusal and counts as no check');
	perform pg_temp.base_assert((pg_temp.p_login()).failures = 1 and (pg_temp.p_login()).failed_at > clock_timestamp() - interval '5 seconds'
		and pg_temp.p_take('poll') -> 'renewal' = 'null'::jsonb, '3: after a failed check the login rests a minute');
	update public.qorpera_claude_logins set failed_at = clock_timestamp() - interval '70 seconds'
	where id = '12870000-0000-4000-8000-0000000000c1';
	update public.qorpera_claude_logins set version = 3, encrypted_envelope = convert_to('canary-1287-v3', 'UTF8'),
		envelope_sha256 = pg_temp.p_sha('canary-1287-v3') where id = '12870000-0000-4000-8000-0000000000c1';
	perform pg_temp.p_back(interval '130 seconds', interval '10 minutes');
	v := pg_temp.p_take('poll');
	perform pg_temp.base_assert(pg_temp.p_release(v, 'refused') ->> 'state' = 'released' and (pg_temp.p_login()).status = 'active'
		and (pg_temp.p_login()).refused_version = 3, '3: a refusal of a newer version starts again');
	perform pg_temp.p_back(interval '130 seconds', interval '3 minutes');
	perform pg_temp.base_assert(pg_temp.p_idle() -> 'renewal' <> 'null'::jsonb, '3: the idle pass takes the second look');
	update public.qorpera_claude_logins set renewal_token = null, renewal_until = null where id = '12870000-0000-4000-8000-0000000000c1';
	v := pg_temp.p_take('poll');
	perform pg_temp.base_assert(pg_temp.p_release(v, 'refused') ->> 'state' = 'signed_out', '3: the second refusal signs out');
	l := pg_temp.p_login();
	perform pg_temp.base_assert(l.status = 'revoked' and l.revoked_at is not null and l.encrypted_envelope is null
		and l.envelope_sha256 is null and l.key_id is null and l.renewal_token is null, '3: signed out as the member''s own sign-out: ' || to_jsonb(l)::text);
	perform pg_temp.base_assert(pg_temp.p_open(1) = '{"schema":"qorpera.claude-login-for-run/v1","state":"refused","reason":"SIGNED_OUT"}'::jsonb,
		'3: a run''s open then answers SIGNED_OUT');
	perform pg_temp.p_back(interval '1 day');
	perform pg_temp.base_assert(pg_temp.p_take('poll') -> 'renewal' = 'null'::jsonb and pg_temp.p_idle() -> 'renewal' = 'null'::jsonb,
		'3: a signed-out login is never taken');
end $$;
grant execute on function pg_temp.p_s3() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.p_s3() \g /dev/null
reset session authorization;

update public.qorpera_claude_logins set status = 'active', revoked_at = null, key_id = 'vault-root-1',
	encrypted_envelope = convert_to('canary-1287-again', 'UTF8'), envelope_sha256 = pg_temp.p_sha('canary-1287-again'),
	checked_at = null, renewed_at = null, refused_version = null, refused_at = null
where id = '12870000-0000-4000-8000-0000000000c1';
create function pg_temp.p_s4() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb; v_i integer;
begin
	update public.qorpera_claude_logins set refused_version = version, refused_at = clock_timestamp() - interval '3 minutes'
	where id = '12870000-0000-4000-8000-0000000000c1';
	v := pg_temp.p_idle();
	perform pg_temp.base_assert(v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1', '4: a never-checked login is idle-due');
	perform pg_temp.base_assert(pg_temp.p_release(v, 'unchanged') ->> 'state' = 'released' and pg_temp.p_idle() -> 'renewal' = 'null'::jsonb
		and (pg_temp.p_login()).refused_version is null and (pg_temp.p_login()).refused_at is null,
		'4: once checked it waits, and a check that Claude Code answered clears a refusal');
	perform pg_temp.p_back(interval '19 hours');
	perform pg_temp.base_assert(pg_temp.p_idle() -> 'renewal' = 'null'::jsonb, '4: not before 20 hours');
	perform pg_temp.p_back(interval '21 hours');
	v := pg_temp.p_idle();
	perform pg_temp.base_assert(v -> 'renewal' <> 'null'::jsonb, '4: after 20 hours it is due again');
	perform pg_temp.p_release(v, 'unchanged');
	for v_i in 1..4 loop
		perform pg_temp.c4_end_job((pg_temp.p_binding(v_i) ->> 'runId')::uuid, 'failed');
	end loop;
	perform pg_temp.p_back(interval '1 hour');
	perform pg_temp.base_assert(pg_temp.p_live() = 0 and pg_temp.p_take('poll') -> 'renewal' = 'null'::jsonb
		and pg_temp.p_take('open') -> 'renewal' = 'null'::jsonb, '4: with no live run nothing but the idle pass checks');
	insert into public.qorpera_claude_logins(id, owner_user_id, principal_id, client_connection_id, key_id, encrypted_envelope,
		envelope_sha256, checked_at)
	values ('12870000-0000-4000-8000-0000000000c2', (select m.user_id from public.qorpera_profile_members m
			where m.profile_id = '92400000-0000-4000-8000-000000000010' and m.user_id <> pg_temp.c4_owner_id() order by m.user_id limit 1),
		'12680000-0000-4000-8000-000000000050', extensions.gen_random_uuid(), 'vault-root-1', convert_to('canary-1287-b', 'UTF8'),
		pg_temp.p_sha('canary-1287-b'), clock_timestamp() - interval '21 hours');
	perform pg_temp.p_back(interval '22 hours');
	v := pg_temp.p_idle();
	perform pg_temp.base_assert(v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1'
		and pg_temp.p_release(v, 'failed') ->> 'state' = 'released', '4: the older idle login first, and its check fails');
	v := pg_temp.p_idle();
	perform pg_temp.base_assert(v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c2',
		'4: the next idle take is the other login, while the failed one rests: ' || coalesce(v::text, 'none'));
	perform pg_temp.base_assert(public.qorpera_release_claude_login_renewal('12680000-0000-4000-8000-000000000050', repeat('a', 64),
		'12870000-0000-4000-8000-0000000000c2', (v #>> '{renewal,token}')::uuid, 'unchanged') ->> 'state' = 'released'
		and pg_temp.p_idle() -> 'renewal' = 'null'::jsonb, '4: then nothing is due');
end $$;
grant execute on function pg_temp.p_s4() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.p_s4() \g /dev/null
reset session authorization;

do $$
declare v_drain jsonb;
begin
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert(pg_temp.p_live() = 1 and (pg_temp.p_worker(5)).occurrence_id is not null,
		'5: the fifth starts when slots free: ' || v_drain::text);
	perform pg_temp.p_dispatch(6);
	perform pg_temp.p_dispatch(7);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert(pg_temp.p_live() = 3, '5: two more start beside it: ' || v_drain::text);
	update public.qorpera_claude_parallel_runs set cap = 2;
	perform pg_temp.p_dispatch(8);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert(pg_temp.p_live() = 3 and (pg_temp.p_worker(8)).occurrence_id is null
		and public.qorpera_claude_worker_waits(pg_temp.p_worker(8))
		and not public.qorpera_claude_worker_lease_take(pg_temp.p_worker(8), extensions.gen_random_uuid()),
		'5: a cap lowered under the live runs starts nothing new: ' || v_drain::text);
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
	where id = (pg_temp.p_worker(5)).occurrence_id;
	perform pg_temp.base_assert(pg_temp.p_live() = 2 and public.qorpera_claude_worker_waits(pg_temp.p_worker(8))
		and not public.qorpera_claude_worker_lease_take(pg_temp.p_worker(8), extensions.gen_random_uuid()),
		'5: with slot 1 free, the two live runs still fill a cap of two');
	update public.qorpera_claude_parallel_runs set cap = 1;
	perform pg_temp.base_assert(public.qorpera_claude_worker_run_cap() = 1, '5: the way back is one statement');
	perform pg_temp.base_assert(pg_temp.p_state('update public.qorpera_claude_parallel_runs set cap = 17') = '23514'
		and pg_temp.p_state('insert into public.qorpera_claude_parallel_runs(only_row, cap) values (false, 2)') = '23514',
		'5: one row, a cap of 1 to 16');
end $$;

insert into public.qorpera_claude_logins(id, owner_user_id, principal_id, client_connection_id, key_id, encrypted_envelope,
	envelope_sha256, provider_account_email)
select v.id::uuid, pg_temp.c4_owner_id(), '12680000-0000-4000-8000-000000000050', extensions.gen_random_uuid(), 'vault-root-1',
	convert_to(v.canary, 'UTF8'), pg_temp.p_sha(v.canary), v.email
from (values ('12870000-0000-4000-8000-0000000000c3', 'canary-1287-second', 'second@example.test'),
	('12870000-0000-4000-8000-0000000000c4', 'canary-1287-third', 'third@example.test')) as v(id, canary, email);

create function pg_temp.p_in_use() returns text language sql as $$
	select string_agg(right(id::text, 2) || case when in_use then '*' else '' end || ':' || status, ' ' order by id)
	from public.qorpera_claude_logins where owner_user_id = pg_temp.c4_owner_id() and id::text like '12870000-%'
$$;
create function pg_temp.p_leases() returns text language sql as $$
	select string_agg(right(lease.claude_login_id::text, 2), ' ' order by lease.claude_login_id) from public.qorpera_claude_worker_leases lease
	where lease.owner_user_id = pg_temp.c4_owner_id() and public.qorpera_claude_worker_lease_live(lease)
$$;
create function pg_temp.p_release_of(p_login uuid, p_take jsonb, p_outcome text) returns jsonb language sql as $$
	select public.qorpera_release_claude_login_renewal('12680000-0000-4000-8000-000000000050', repeat('a', 64), p_login,
		(p_take #>> '{renewal,token}')::uuid, p_outcome)
$$;

do $$
declare v_pass jsonb; v_binding jsonb; v_i integer; v_runs jsonb := '{}';
begin
	perform pg_temp.base_assert(pg_temp.p_in_use() = 'c1*:active c3:active c4:active',
		'7: another account joins Not in use: ' || pg_temp.p_in_use());
	update public.qorpera_claude_parallel_runs set cap = 4;
	v_pass := pg_temp.base_materialize();
	for v_i in 6..7 loop
		v_runs := v_runs || jsonb_build_object((select run_id from public.qorpera_wake_occurrences
			where id = (pg_temp.p_worker(v_i)).occurrence_id)::text, v_i);
	end loop;
	for v_i in 1..2 loop
		v_binding := pg_temp.base_start(null) - array['provider', 'nativeHarness', 'model'];
		perform pg_temp.base_assert(v_runs ? (v_binding ->> 'runId'), '7: a started run is worker 6''s or 7''s: ' || v_binding::text);
		perform set_config('qorpera_test.p_binding_' || (v_runs ->> (v_binding ->> 'runId')), v_binding::text, false);
	end loop;
	perform pg_temp.base_assert(pg_temp.p_leases() = 'c1 c1', '7: each live lease records the login its run started on: '
		|| coalesce(pg_temp.p_leases(), 'none'));
	update public.qorpera_claude_logins set in_use = false where id = '12870000-0000-4000-8000-0000000000c1';
	update public.qorpera_claude_logins set in_use = true where id = '12870000-0000-4000-8000-0000000000c3';
	perform pg_temp.base_assert(public.qorpera_claude_worker_login('92400000-0000-4000-8000-000000000010', pg_temp.c4_owner_id())
		= '12870000-0000-4000-8000-0000000000c3', '7: after the member''s switch new work takes the login In use');
	update public.qorpera_runtime_workers set claude_login_id = '12870000-0000-4000-8000-0000000000c3'
	where id = (pg_temp.p_worker(6)).id;
	update public.qorpera_claude_logins set checked_at = clock_timestamp() - interval '1 hour', failed_at = null, failures = 0
	where id in ('12870000-0000-4000-8000-0000000000c1', '12870000-0000-4000-8000-0000000000c3');
end $$;

create function pg_temp.p_s7() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb; v_i integer;
begin
	for v_i in 6..7 loop
		v := pg_temp.p_open(v_i);
		perform pg_temp.base_assert(v ->> 'state' = 'open' and v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1'
			and convert_from(decode(v ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'canary-1287-again',
			'7: run ' || v_i || ' keeps the login it started on, after the switch and its worker''s follow-up: '
			|| (v - 'encryptedEnvelopeBase64')::text);
	end loop;
	perform pg_temp.base_assert(pg_temp.p_take('open', '12870000-0000-4000-8000-0000000000c3')
		= '{"schema":"qorpera.claude-login-renewal/v1","renewal":null,"busy":false}'::jsonb,
		'7: the login In use with no run of its own is not checked for another login''s runs');
	v := pg_temp.p_take('poll');
	perform pg_temp.base_assert(v ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1'
		and pg_temp.p_release(v, 'unchanged') ->> 'state' = 'released',
		'7: the login the live runs use is checked, though it is no longer In use: ' || (v - 'encryptedEnvelopeBase64')::text);
end $$;
grant execute on function pg_temp.p_s7() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.p_s7() \g /dev/null
reset session authorization;

do $$
declare v_drain jsonb; v_binding jsonb; v_i integer; v_runs jsonb := '{}';
begin
	perform pg_temp.p_dispatch(9);
	perform pg_temp.base_assert((pg_temp.p_worker(9)).claude_login_id = '12870000-0000-4000-8000-0000000000c3',
		'7: a new worker is paid by the login In use');
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert(pg_temp.p_leases() = 'c1 c1 c1 c3' and (pg_temp.p_worker(9)).occurrence_id is not null,
		'7: the waiting worker on the old login and the new one on the login In use start: '
		|| coalesce(pg_temp.p_leases(), 'none') || ' ' || v_drain::text);
	perform pg_temp.p_dispatch(10);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.p_worker(10)).occurrence_id is null and public.qorpera_claude_worker_waits(pg_temp.p_worker(10)),
		'7: the cap counts the member''s runs on every login: the fifth waits: ' || v_drain::text);
	v_drain := pg_temp.base_materialize();
	for v_i in 8..9 loop
		v_runs := v_runs || jsonb_build_object((select run_id from public.qorpera_wake_occurrences
			where id = (pg_temp.p_worker(v_i)).occurrence_id)::text, v_i);
	end loop;
	for v_i in 1..2 loop
		v_binding := pg_temp.base_start(null) - array['provider', 'nativeHarness', 'model'];
		perform pg_temp.base_assert(v_runs ? (v_binding ->> 'runId'), '7: a started run is worker 8''s or 9''s: ' || v_binding::text);
		perform set_config('qorpera_test.p_binding_' || (v_runs ->> (v_binding ->> 'runId')), v_binding::text, false);
	end loop;
	update public.qorpera_claude_logins set usage = jsonb_build_object('observedAt',
		to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'windows', jsonb_build_array(jsonb_build_object(
			'id', 'five_hour', 'label', '5-hour limit', 'usedPercent', 100,
			'resetAt', to_char((clock_timestamp() + interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
	where id = '12870000-0000-4000-8000-0000000000c1';
	update public.qorpera_claude_logins set refused_version = version, refused_at = clock_timestamp() - interval '3 minutes',
		checked_at = clock_timestamp() - interval '1 hour'
	where id = '12870000-0000-4000-8000-0000000000c3';
end $$;

create function pg_temp.p_s7b() returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb;
begin
	perform pg_temp.base_assert(pg_temp.p_open(9) ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c3',
		'7: worker 9''s run opens the login In use');
	v := pg_temp.p_take('poll', '12870000-0000-4000-8000-0000000000c3');
	perform pg_temp.base_assert(pg_temp.p_release_of('12870000-0000-4000-8000-0000000000c3', v, 'refused') ->> 'state' = 'signed_out',
		'7: a second refusal signs out the login In use: ' || (v - 'encryptedEnvelopeBase64')::text);
	execute 'set constraints all immediate';
	execute 'set constraints all deferred';
	perform pg_temp.base_assert(pg_temp.p_in_use() = 'c1:active c3:revoked c4*:active',
		'7: In use moves to the member''s login that is not used up, and every active login keeps one In use: '
		|| pg_temp.p_in_use());
	perform pg_temp.base_assert(pg_temp.p_open(9) = '{"schema":"qorpera.claude-login-for-run/v1","state":"refused","reason":"SIGNED_OUT"}'::jsonb
		and pg_temp.p_open(7) ->> 'claudeLoginId' = '12870000-0000-4000-8000-0000000000c1',
		'7: the signed-out login''s run is told so, another login''s run goes on');
end $$;
grant execute on function pg_temp.p_s7b() to qorpera_secret_broker;
set local session authorization qorpera_secret_broker;
select pg_temp.p_s7b() \g /dev/null
reset session authorization;

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_claude_parallel_runs', 'select,insert,update,delete') then
			raise exception '6: % touches the cap', v_role; end if;
		foreach v_function in array array['public.qorpera_claude_worker_run_cap()',
			'public.qorpera_claude_login_renewal_answer(public.qorpera_claude_logins)',
			'public.qorpera_claude_login_renewal_locked(uuid,text,uuid,uuid)',
			'public.qorpera_claude_worker_lease_take(public.qorpera_runtime_workers,uuid)',
			'public.qorpera_claude_worker_waits(public.qorpera_runtime_workers)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '6: % may call %', v_role, v_function; end if;
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_open_claude_login_for_run(uuid,text,jsonb,bigint)',
		'public.qorpera_take_claude_login_renewal(uuid,text,uuid,text)',
		'public.qorpera_take_idle_claude_login_renewal(uuid,text)',
		'public.qorpera_commit_claude_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,text)',
		'public.qorpera_release_claude_login_renewal(uuid,text,uuid,uuid,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '6: % may call %', v_role, v_function; end if;
		end loop;
		if not has_function_privilege('qorpera_secret_broker', v_function, 'execute') then
			raise exception '6: the vault may not call %', v_function; end if;
	end loop;
end $$;

-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-4 (20260930103000): the native host reaches its credential capsules and its company's presence topic as anon,
-- with its holder credential in the x-qorpera-identity request header (Storage and Realtime hand request headers to
-- the row policies as request.headers). Test 300's fixture leases a run's job with a native connection lease of the
-- identity's capsule; this test gives the job a known lease token, names the capsule as the native host does
-- (native-capsule/<id>), adds a second capsule of the identity and one of another identity, their objects, a pending
-- sign-in and a refresh request with their login guests' allocations, and binds an identity credential to each holder
-- (rows only, as the node host's reservations and binds leave them). Each request below runs as anon with the role's
-- platform privileges on storage.objects (Storage's own schema grants them; the bootstrap does not).
reset role;
grant select, insert, update, delete on storage.objects to anon;
select set_config('qorpera_test.job', current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId', false);
select set_config('qorpera_test.run', current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId', false);
select set_config('qorpera_test.runner', current_setting('qorpera_test.wake_binding')::jsonb ->> 'runnerId', false);
select set_config('qorpera_test.identity', current_setting('qorpera_test.wake_binding')::jsonb ->> 'computeIdentityId', false);
select set_config('qorpera_test.capsule', current_setting('qorpera_test.wake_binding')::jsonb ->> 'credentialCapsuleId', false);
select set_config('qorpera_test.profile', '30000000-0000-4000-8000-000000000010', false);
select set_config('qorpera_test.token', 'T' || repeat('t', 42), false);
create function pg_temp.sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;
update public.qorpera_runner_jobs set lease_token_sha256 = pg_temp.sha(current_setting('qorpera_test.token'))
where id = current_setting('qorpera_test.job')::uuid;
create function pg_temp.job_header() returns text language sql as $$
	select 'job.' || current_setting('qorpera_test.job') || '.' || current_setting('qorpera_test.token')
$$;

-- The capsules: the leased one (as the native host names it), another of the identity, and one of another identity.
update public.qorpera_native_credential_capsules set encrypted_capsule_reference = 'native-capsule/' || id::text
where id = current_setting('qorpera_test.capsule')::uuid;
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
values ('90700000-0000-4000-8000-0000000000e1', current_setting('qorpera_test.profile')::uuid, 'company',
	'90700000-0000-4000-8000-0000000000e2', 'Other identity');
insert into public.qorpera_native_credential_capsules
select (jsonb_populate_record(null::public.qorpera_native_credential_capsules, to_jsonb(capsule) || jsonb_build_object(
	'id', copies.id, 'encrypted_capsule_reference', 'native-capsule/' || copies.id, 'compute_identity_id', copies.identity,
	'ownership_kind', copies.kind, 'owner_user_id', case when copies.kind = 'company' then null else capsule.owner_user_id end))).*
from public.qorpera_native_credential_capsules as capsule
cross join (values ('90700000-0000-4000-8000-000000000061'::uuid, current_setting('qorpera_test.identity')::uuid, 'member'),
	('90700000-0000-4000-8000-000000000062'::uuid, '90700000-0000-4000-8000-0000000000e1'::uuid, 'company')) as copies(id, identity, kind)
where capsule.id = current_setting('qorpera_test.capsule')::uuid;
-- Each capsule's object, an orphan's, and an object of the same name in another bucket.
insert into storage.buckets(id, name) values ('qorpera-g24-other', 'qorpera-g24-other');
insert into storage.objects(bucket_id, name)
values ('qorpera-native-compute-capsules', current_setting('qorpera_test.capsule') || '.capsule'),
	('qorpera-native-compute-capsules', '90700000-0000-4000-8000-000000000061.capsule'),
	('qorpera-native-compute-capsules', '90700000-0000-4000-8000-000000000062.capsule'),
	('qorpera-native-compute-capsules', '90700000-0000-4000-8000-000000000063.capsule'),
	('qorpera-g24-other', current_setting('qorpera_test.capsule') || '.capsule');

-- A pending sign-in of the identity, by its member, and a refresh request (as qorpera_begin_native_account_refresh
-- leaves it).
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.login_id', public.qorpera_begin_native_provider_login(
	'30000000-0000-4000-8000-000000000010', '90700000-0000-4000-8000-000000000051', '90700000-0000-4000-8000-000000000052',
	current_setting('qorpera_test.identity')::uuid, 'openai', 'codex-cli', pg_temp.sha('login-capability'), 900) ->> 'login_id', false);
reset role;
insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
	requested_by_user_id, capability_sha256, compute_recovery_epoch)
select '90700000-0000-4000-8000-000000000071', current_setting('qorpera_test.profile')::uuid, extensions.gen_random_uuid(),
	identity.id, '30000000-0000-4000-8000-000000000001', pg_temp.sha('refresh-capability'), identity.recovery_epoch
from public.qorpera_member_compute_identities as identity where identity.id = current_setting('qorpera_test.identity')::uuid;

-- The holders' allocations and credentials: the run's machine (a job guest) and the sign-in's login guest. The
-- refresh's login guest comes once the sign-in's is released (one login or refresh machine per identity).
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
values ('90700000-0000-4000-8000-000000000081', current_setting('qorpera_test.profile')::uuid,
	current_setting('qorpera_test.run')::uuid, current_setting('qorpera_test.runner')::uuid, 'lxd', repeat('7', 64));
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('90700000-0000-4000-8000-000000000082', current_setting('qorpera_test.profile')::uuid,
	current_setting('qorpera_test.login_id')::uuid, current_setting('qorpera_test.identity')::uuid, 'lxd-login', repeat('8', 64));
insert into public.qorpera_native_identity_credentials(allocation_id, holder_kind, compute_identity_id, credential_sha256)
values ('90700000-0000-4000-8000-000000000081', 'job_guest', current_setting('qorpera_test.identity')::uuid,
		pg_temp.sha('J' || repeat('j', 42))),
	('90700000-0000-4000-8000-000000000082', 'login_guest', current_setting('qorpera_test.identity')::uuid,
		pg_temp.sha('L' || repeat('l', 42)));
create function pg_temp.job_guest() returns text language sql as $$ select 'identity.J' || repeat('j', 42) $$;
create function pg_temp.login_guest() returns text language sql as $$ select 'identity.L' || repeat('l', 42) $$;
create function pg_temp.refresh_guest() returns text language sql as $$ select 'identity.R' || repeat('r', 42) $$;

-- A request as anon with the header (or none): the statement's single value, '' for none, or 'error <sqlstate>'.
create function pg_temp.as_holder(p_header text, p_sql text) returns text language plpgsql as $$
declare v_result text;
begin
	perform set_config('request.headers', case when p_header is null then '{}' else jsonb_build_object('x-qorpera-identity', p_header)::text end, true);
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	execute 'set local role anon';
	begin
		execute p_sql into v_result;
	exception when others then
		execute 'reset role';
		perform set_config('request.headers', '', true);
		return 'error ' || sqlstate;
	end;
	execute 'reset role';
	perform set_config('request.headers', '', true);
	return coalesce(v_result, '');
end $$;
create function pg_temp.readable(p_header text) returns text language sql as $$
	select pg_temp.as_holder(p_header, $q$select string_agg(name, ',' order by name) from storage.objects
		where bucket_id = 'qorpera-native-compute-capsules'$q$)
$$;
create function pg_temp.create_object(p_header text, p_name text) returns text language sql as $$
	select pg_temp.as_holder(p_header, format($q$insert into storage.objects(bucket_id, name)
		values ('qorpera-native-compute-capsules', %L) returning name$q$, p_name))
$$;
create function pg_temp.write_object(p_header text, p_name text) returns text language sql as $$
	select pg_temp.as_holder(p_header, format($q$update storage.objects set metadata = '{"size":1}'
		where bucket_id = 'qorpera-native-compute-capsules' and name = %L returning name$q$, p_name))
$$;
create function pg_temp.delete_object(p_header text, p_name text) returns text language sql as $$
	select pg_temp.as_holder(p_header, format($q$delete from storage.objects
		where bucket_id = 'qorpera-native-compute-capsules' and name = %L returning name$q$, p_name))
$$;
create function pg_temp.expect(p_actual text, p_expected text, p_label text) returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.object(p_id text) returns text language sql as $$ select p_id || '.capsule' $$;
create function pg_temp.objects(p_ids text[]) returns text language sql as $$
	select string_agg(id || '.capsule', ',' order by id || '.capsule') from unnest(p_ids) as id
$$;

-- 1. Who may call what: the holder itself is no role's; the two policy helpers are anon's alone. The policies exist,
-- none deletes, and the bucket's limit is the encrypted maximum.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_native_holder()', 'execute')
			or (v_role <> 'anon' and (has_function_privilege(v_role, 'public.qorpera_native_holder_capsules(boolean)', 'execute')
				or has_function_privilege(v_role, 'public.qorpera_native_holder_presence_topic()', 'execute'))) then
			raise exception '1: the holder''s functions are open to %', v_role; end if;
	end loop;
	if not has_function_privilege('anon', 'public.qorpera_native_holder_capsules(boolean)', 'execute')
		or not has_function_privilege('anon', 'public.qorpera_native_holder_presence_topic()', 'execute') then
		raise exception '1: the policy helpers must be anon''s'; end if;
	if (select count(*) from pg_policies where policyname in ('qorpera_native_capsule_holder_read', 'qorpera_native_capsule_holder_create',
			'qorpera_native_capsule_holder_write', 'qorpera_presence_native_receive', 'qorpera_presence_native_publish')
			and roles = '{anon}') <> 5
		or exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'DELETE'
			and 'anon' = any (roles)) then
		raise exception '1: the anon policies are not as built'; end if;
	if (select file_size_limit from storage.buckets where id = 'qorpera-native-compute-capsules') <> 64 * 1024 * 1024 + 1024 * 1024 then
		raise exception '1: the capsule bucket''s limit is not the encrypted maximum'; end if;
end $$;

-- 2. A job: its identity's active capsules, read (the account metadata loop also runs during a job); its run's leased
-- capsule, written back (and created, as a first upload); nothing else, nothing deleted.
select pg_temp.expect(pg_temp.readable(pg_temp.job_header()),
	pg_temp.objects(array[current_setting('qorpera_test.capsule'), '90700000-0000-4000-8000-000000000061']),
	'2: a job reads its identity''s capsules only');
select pg_temp.expect(pg_temp.write_object(pg_temp.job_header(), pg_temp.object(current_setting('qorpera_test.capsule'))),
	pg_temp.object(current_setting('qorpera_test.capsule')), '2: a job writes its capsule back');
select pg_temp.expect(pg_temp.write_object(pg_temp.job_header(), pg_temp.object('90700000-0000-4000-8000-000000000061')), '',
	'2: a job writes no other capsule of its identity');
select pg_temp.expect(pg_temp.create_object(pg_temp.job_header(), pg_temp.object('90700000-0000-4000-8000-000000000064')),
	'error 42501', '2: a job creates no other object');
select pg_temp.expect(pg_temp.delete_object(pg_temp.job_header(), pg_temp.object(current_setting('qorpera_test.capsule'))), '',
	'2: a job deletes nothing');
savepoint fresh_object;
delete from storage.objects where bucket_id = 'qorpera-native-compute-capsules'
	and name = pg_temp.object(current_setting('qorpera_test.capsule'));
select pg_temp.expect(pg_temp.create_object(pg_temp.job_header(), pg_temp.object(current_setting('qorpera_test.capsule'))),
	pg_temp.object(current_setting('qorpera_test.capsule')), '2: a job creates its capsule''s object');
rollback to savepoint fresh_object;

-- 3. Anything but the job's own valid token is anon's: nothing. An expired lease, or a job that has left `leased`
-- (its token is cleared then), leaves the job nothing; a released connection lease leaves it nothing to write back.
do $$
declare v_header text;
begin
	foreach v_header in array array[
		'job.' || current_setting('qorpera_test.job') || '.W' || repeat('w', 42),
		'job.90700000-0000-4000-8000-0000000000ff.' || current_setting('qorpera_test.token'),
		'job.' || upper(current_setting('qorpera_test.job')) || '.' || current_setting('qorpera_test.token'),
		pg_temp.job_header() || 'x', 'JOB.' || current_setting('qorpera_test.job') || '.' || current_setting('qorpera_test.token'),
		current_setting('qorpera_test.token'), '', 'identity.' || current_setting('qorpera_test.token')] loop
		perform pg_temp.expect(pg_temp.readable(v_header), '', format('3: header %s reads nothing', left(v_header, 16)));
	end loop;
	perform pg_temp.expect(pg_temp.readable(null), '', '3: no header reads nothing');
	perform pg_temp.expect(pg_temp.create_object(null, pg_temp.object('90700000-0000-4000-8000-000000000064')), 'error 42501',
		'3: no header creates nothing');
end $$;
savepoint lease_over;
update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
where id = current_setting('qorpera_test.job')::uuid;
select pg_temp.expect(pg_temp.readable(pg_temp.job_header()), '', '3: an expired lease reads nothing');
rollback to savepoint lease_over;
savepoint job_ended;
set local session_replication_role = replica;
update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
	terminal_lease_token_sha256 = lease_token_sha256, lease_token_sha256 = null, lease_expires_at = null
where id = current_setting('qorpera_test.job')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.readable(pg_temp.job_header()), '', '3: a completed job reads nothing');
select pg_temp.expect(pg_temp.write_object(pg_temp.job_header(), pg_temp.object(current_setting('qorpera_test.capsule'))), '',
	'3: a completed job writes nothing back');
rollback to savepoint job_ended;
savepoint lease_released;
update public.qorpera_native_provider_connection_leases set status = 'released', released_at = clock_timestamp()
where job_id = current_setting('qorpera_test.job')::uuid;
select pg_temp.expect(pg_temp.write_object(pg_temp.job_header(), pg_temp.object(current_setting('qorpera_test.capsule'))), '',
	'3: a released connection lease leaves nothing to write back');
rollback to savepoint lease_released;

-- 4. An identity holder (a job guest, or an execution host's slot): its identity's active capsules, read only. The
-- identity entry point's fences hold here too (860 checks them there): an identity disabled or in recovery, a runner
-- revoked or behind the identity's recovery epoch, or a credential of another kind on this machine reads nothing.
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()),
	pg_temp.objects(array[current_setting('qorpera_test.capsule'), '90700000-0000-4000-8000-000000000061']),
	'4: a job guest reads its identity''s capsules');
select pg_temp.expect(pg_temp.write_object(pg_temp.job_guest(), pg_temp.object(current_setting('qorpera_test.capsule'))), '',
	'4: a job guest writes no capsule');
select pg_temp.expect(pg_temp.create_object(pg_temp.job_guest(), pg_temp.object('90700000-0000-4000-8000-000000000064')),
	'error 42501', '4: a job guest creates nothing');
savepoint capsule_revoked;
update public.qorpera_native_credential_capsules set status = 'revoked', revoked_at = clock_timestamp()
where id = '90700000-0000-4000-8000-000000000061';
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), pg_temp.object(current_setting('qorpera_test.capsule')),
	'4: a revoked capsule is not read');
rollback to savepoint capsule_revoked;
savepoint run_released;
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = '90700000-0000-4000-8000-000000000081';
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), '', '4: a released machine''s credential reads nothing');
rollback to savepoint run_released;
savepoint exec_slot;
update public.qorpera_native_identity_credentials set holder_kind = 'exec_slot' where allocation_id = '90700000-0000-4000-8000-000000000081';
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()),
	pg_temp.objects(array[current_setting('qorpera_test.capsule'), '90700000-0000-4000-8000-000000000061']),
	'4: an execution host''s slot reads its identity''s capsules');
select pg_temp.expect(pg_temp.write_object(pg_temp.job_guest(), pg_temp.object(current_setting('qorpera_test.capsule'))), '',
	'4: an execution host''s slot writes no capsule');
rollback to savepoint exec_slot;
savepoint wrong_kind;
update public.qorpera_native_identity_credentials set holder_kind = 'login_guest' where allocation_id = '90700000-0000-4000-8000-000000000081';
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), '', '4: a login guest''s credential on a run''s machine reads nothing');
rollback to savepoint wrong_kind;
savepoint in_recovery;
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set recovery_pending_id = extensions.gen_random_uuid()
where id = current_setting('qorpera_test.identity')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), '', '4: an identity in recovery reads nothing');
rollback to savepoint in_recovery;
savepoint disabled;
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set status = 'disabled' where id = current_setting('qorpera_test.identity')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), '', '4: a disabled identity reads nothing');
rollback to savepoint disabled;
savepoint stale_runner;
update public.qorpera_member_compute_identities set recovery_epoch = recovery_epoch + 1
where id = current_setting('qorpera_test.identity')::uuid;
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), '', '4: a runner behind the identity''s recovery epoch reads nothing');
rollback to savepoint stale_runner;
savepoint revoked_runner;
set local session_replication_role = replica;
update public.qorpera_runners set status = 'revoked', revoked_at = clock_timestamp(),
	revoked_by_user_id = '30000000-0000-4000-8000-000000000001', session_token_sha256 = null, session_expires_at = null
where id = current_setting('qorpera_test.runner')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.readable(pg_temp.job_guest()), '', '4: a revoked runner reads nothing');
rollback to savepoint revoked_runner;

-- 5. A sign-in's login guest: its sign-in's own capsule, created, read and written again while the sign-in is pending.
select pg_temp.expect(pg_temp.readable(pg_temp.login_guest()), '', '5: the sign-in''s capsule is not there yet');
select pg_temp.expect(pg_temp.create_object(pg_temp.login_guest(), pg_temp.object('90700000-0000-4000-8000-000000000064')),
	'error 42501', '5: a login guest creates no other name');
select pg_temp.expect(pg_temp.create_object(pg_temp.login_guest(), pg_temp.object(current_setting('qorpera_test.login_id'))),
	pg_temp.object(current_setting('qorpera_test.login_id')), '5: a login guest creates its sign-in''s capsule');
select pg_temp.expect(pg_temp.readable(pg_temp.login_guest()), pg_temp.object(current_setting('qorpera_test.login_id')),
	'5: a login guest reads its sign-in''s capsule only');
select pg_temp.expect(pg_temp.write_object(pg_temp.login_guest(), pg_temp.object(current_setting('qorpera_test.login_id'))),
	pg_temp.object(current_setting('qorpera_test.login_id')), '5: a login guest writes it again (a retry)');
select pg_temp.expect(pg_temp.write_object(pg_temp.login_guest(), pg_temp.object('90700000-0000-4000-8000-000000000063')), '',
	'5: a login guest writes no orphan');
savepoint sign_in_expired;
set local session_replication_role = replica;
update public.qorpera_native_provider_login_sessions set expires_at = created_at + interval '1 millisecond'
where id = current_setting('qorpera_test.login_id')::uuid;
set local session_replication_role = origin;
select pg_temp.expect(pg_temp.readable(pg_temp.login_guest()), '', '5: an expired sign-in''s login guest reads nothing');
select pg_temp.expect(pg_temp.write_object(pg_temp.login_guest(), pg_temp.object(current_setting('qorpera_test.login_id'))), '',
	'5: an expired sign-in''s login guest writes nothing');
rollback to savepoint sign_in_expired;

-- 6. The completion through the entry point must name the capsule for the sign-in; after it the login guest reaches
-- nothing.
create function pg_temp.complete(p_capsule text) returns text language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_identity_call', true);
	execute 'set local role anon';
	begin
		v_result := public.qorpera_native_identity_call(current_setting('qorpera_test.identity')::uuid, 'L' || repeat('l', 42),
			'qorpera_complete_native_provider_login', jsonb_build_object('p_login_id', current_setting('qorpera_test.login_id'),
			'p_capability_sha256', pg_temp.sha('login-capability'), 'p_capsule_id', p_capsule,
			'p_encrypted_capsule_reference', 'native-capsule/' || p_capsule, 'p_attestation_policy_sha256', repeat('b', 64),
			'p_provider_account_reference', 'fixture-openai-account', 'p_billing_source', 'personal-subscription',
			'p_consent_version', 'qorpera-native-provider-consent/v1',
			'p_quota_policy', '{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}'::jsonb,
			'p_provider_account_email', 'member@example.com'));
	exception when others then
		execute 'reset role';
		return case when sqlstate = '42501' and sqlerrm = 'native identity call is refused' then 'refused' else sqlstate end;
	end;
	execute 'reset role';
	return 'ok';
end $$;
select pg_temp.expect(pg_temp.complete('90700000-0000-4000-8000-000000000064'), 'refused',
	'6: a completion with a capsule id other than the sign-in''s');
select pg_temp.expect(pg_temp.complete(current_setting('qorpera_test.login_id')), 'ok', '6: a completion naming the sign-in''s capsule');
select pg_temp.expect(pg_temp.readable(pg_temp.login_guest()), '', '6: a completed sign-in''s login guest reads nothing');
select pg_temp.expect(pg_temp.write_object(pg_temp.login_guest(), pg_temp.object(current_setting('qorpera_test.login_id'))), '',
	'6: a completed sign-in''s login guest writes nothing');

-- 7. A refresh's login guest: its identity's active capsules, read only (the new sign-in's capsule now among them).
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = '90700000-0000-4000-8000-000000000082';
insert into public.qorpera_runtime_machine_allocations(id, profile_id, account_refresh_request_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('90700000-0000-4000-8000-000000000083', current_setting('qorpera_test.profile')::uuid, '90700000-0000-4000-8000-000000000071',
	current_setting('qorpera_test.identity')::uuid, 'lxd-login', repeat('9', 64));
insert into public.qorpera_native_identity_credentials(allocation_id, holder_kind, compute_identity_id, credential_sha256)
values ('90700000-0000-4000-8000-000000000083', 'login_guest', current_setting('qorpera_test.identity')::uuid,
	pg_temp.sha('R' || repeat('r', 42)));
select pg_temp.expect(pg_temp.readable(pg_temp.refresh_guest()),
	pg_temp.objects(array[current_setting('qorpera_test.capsule'), '90700000-0000-4000-8000-000000000061',
		current_setting('qorpera_test.login_id')]),
	'7: a refresh''s login guest reads its identity''s capsules');
select pg_temp.expect(pg_temp.write_object(pg_temp.refresh_guest(), pg_temp.object(current_setting('qorpera_test.capsule'))), '',
	'7: a refresh''s login guest writes nothing');

-- 8. Presence: a job whose run has a live presence device joins its company's topic, receives and publishes there;
-- not another topic, not without a live device, never an identity holder or a request without the header.
create function pg_temp.topic(p_header text, p_topic text, p_publish boolean) returns text language plpgsql as $$
begin
	perform set_config('realtime.topic', p_topic, true);
	return pg_temp.as_holder(p_header, case when p_publish then format($q$insert into realtime.messages(topic, extension, payload, event, private)
			values (%L, 'presence', '{}', 'presence', true) returning 'sent'$q$, p_topic)
		else format($q$select count(*)::text from realtime.messages where topic = %L$q$, p_topic) end);
end $$;
insert into realtime.messages(topic, extension, payload, event, private) values
	('qorpera-presence-' || current_setting('qorpera_test.profile'), 'presence', '{}', 'presence', true),
	('qorpera-presence-90700000-0000-4000-8000-0000000000aa', 'presence', '{}', 'presence', true);
select pg_temp.expect(pg_temp.topic(pg_temp.job_header(), 'qorpera-presence-' || current_setting('qorpera_test.profile'), false), '0',
	'8: no presence before the run''s device');
insert into public.qorpera_native_presence_devices(client_id, profile_id, environment_id, run_id, user_id, binding, public_key, expires_at)
select '90700000-0000-4000-8000-000000000091', run.profile_id, run.environment_id, run.id, run.requested_by_user_id,
	current_setting('qorpera_test.wake_binding')::jsonb, 'MCowBQYDK2VwAyEA' || repeat('A', 43) || '=', clock_timestamp() + interval '30 seconds'
from public.qorpera_execution_runs as run where run.id = current_setting('qorpera_test.run')::uuid;
select pg_temp.expect(pg_temp.topic(pg_temp.job_header(), 'qorpera-presence-' || current_setting('qorpera_test.profile'), false), '1',
	'8: a job receives on its company''s presence topic');
select pg_temp.expect(pg_temp.topic(pg_temp.job_header(), 'qorpera-presence-' || current_setting('qorpera_test.profile'), true), 'sent',
	'8: a job publishes there');
select pg_temp.expect(pg_temp.topic(pg_temp.job_header(), 'qorpera-presence-90700000-0000-4000-8000-0000000000aa', false), '0',
	'8: a job receives on no other company''s topic');
select pg_temp.expect(pg_temp.topic(pg_temp.job_header(), 'qorpera-presence-90700000-0000-4000-8000-0000000000aa', true), 'error 42501',
	'8: a job publishes on no other company''s topic');
select pg_temp.expect(pg_temp.topic(pg_temp.job_guest(), 'qorpera-presence-' || current_setting('qorpera_test.profile'), false), '0',
	'8: an identity holder has no presence');
select pg_temp.expect(pg_temp.topic(null, 'qorpera-presence-' || current_setting('qorpera_test.profile'), true), 'error 42501',
	'8: no header publishes nothing');
update public.qorpera_native_presence_devices set expires_at = clock_timestamp() - interval '1 second'
where client_id = '90700000-0000-4000-8000-000000000091';
select pg_temp.expect(pg_temp.topic(pg_temp.job_header(), 'qorpera-presence-' || current_setting('qorpera_test.profile'), false), '0',
	'8: an expired device leaves no presence');

rollback;

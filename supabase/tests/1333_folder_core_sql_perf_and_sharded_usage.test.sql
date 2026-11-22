-- @fixture 635_folder_core_authority_concurrency.test.sql until "-- A. A narrowing that commits while a commit is deciding"
-- WHY: Comprehensive SQL parity, performance, fence, and sharded-usage concurrency tests for 20260930851000.

create function pg_temp.t1333_ok(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception '1333 failed: %', p_msg;
	end if;
end $$;

create function pg_temp.t1333_hash(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;

create function pg_temp.t1333_bucket(p_sha256 text) returns smallint language sql immutable as $$
	select (get_byte(decode(left(p_sha256, 2), 'hex'), 0) & 15)::smallint
$$;

create function pg_temp.t1333_manifest(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
		pg_temp.t1333_hash(p_text), octet_length(convert_to(p_text, 'utf8')),
		pg_temp.t1333_hash(p_text), octet_length(convert_to(p_text, 'utf8')))
$$;

create function pg_temp.t1333_digest_from_list(p_entries jsonb, p_with_receipt boolean) returns text language sql immutable as $$
	select coalesce(
		lpad(to_hex(bit_xor(('x' || encode(substring(h.d from 1 for 8), 'hex'))::bit(64)::bigint)), 16, '0')
		|| lpad(to_hex(bit_xor(('x' || encode(substring(h.d from 9 for 8), 'hex'))::bit(64)::bigint)), 16, '0'),
		repeat('0', 32)
	)
	from (
		select sha256(convert_to(
			case when p_with_receipt then
				(e ->> 'path') || ':' || (e ->> 'version') || ':'
				|| coalesce(e -> 'authority' ->> 'resourceId', '') || ':'
				|| coalesce(e -> 'authority' ->> 'resourceRevision', '') || ':'
				|| coalesce(e -> 'authority' ->> 'grantId', '') || ':'
				|| coalesce(e -> 'authority' ->> 'grantRevision', '')
			else
				(e ->> 'path') || ':' || (e ->> 'version')
			end,
			'utf8'
		)) as d
		from jsonb_array_elements(p_entries) e
	) h
$$;

create function pg_temp.t1333_waits_for_any(p_waiter text, p_holders text[]) returns boolean language plpgsql as $$
declare
	v_until timestamptz := clock_timestamp() + interval '30 seconds';
	v_waiter integer := current_setting('qorpera_test.pid_' || p_waiter)::integer;
	v_holders integer[];
begin
	select array_agg(current_setting('qorpera_test.pid_' || h)::integer) into v_holders from unnest(p_holders) h;
	loop
		if pg_blocking_pids(v_waiter) && v_holders then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;

-- WHY: Verify privileges, lock_timeout proconfig, sharded PK/check, and zero O(U^2) concat in qorpera_folder_commit.
do $$
declare
	v_role text;
	v_config text[];
	v_def text;
	v_pk text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.t1333_ok(
			not has_function_privilege(v_role, 'public.qorpera_folder_actor_rules(uuid,uuid,jsonb,text)', 'EXECUTE'),
			'qorpera_folder_actor_rules must be internal for ' || v_role);
		perform pg_temp.t1333_ok(
			not has_function_privilege(v_role, 'public.qorpera_folder_object_readable_state(uuid,uuid,jsonb,text)', 'EXECUTE'),
			'qorpera_folder_object_readable_state must be internal for ' || v_role);
		perform pg_temp.t1333_ok(
			has_function_privilege(v_role, 'public.qorpera_folder_view_fingerprint(uuid,jsonb)', 'EXECUTE') = (v_role = 'service_role'),
			'qorpera_folder_view_fingerprint grant mismatch for ' || v_role);
		perform pg_temp.t1333_ok(
			has_function_privilege(v_role, 'public.qorpera_folder_download_fence(uuid,jsonb,text,bigint,timestamptz,boolean)', 'EXECUTE') = (v_role = 'service_role'),
			'qorpera_folder_download_fence grant mismatch for ' || v_role);
	end loop;

	select proconfig into v_config from pg_proc
	where oid = 'public.qorpera_folder_authorize_object_download(uuid,jsonb,text)'::regprocedure;
	perform pg_temp.t1333_ok('lock_timeout=2s' = any(coalesce(v_config, '{}')), 'authorize_object_download lost lock_timeout=2s');

	select proconfig into v_config from pg_proc
	where oid = 'public.qorpera_folder_download_fence(uuid,jsonb,text,bigint,timestamptz,boolean)'::regprocedure;
	perform pg_temp.t1333_ok('lock_timeout=2s' = any(coalesce(v_config, '{}')), 'download_fence missing lock_timeout=2s');

	v_def := pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure);
	perform pg_temp.t1333_ok(position('v_locks := v_locks ||' in v_def) = 0, 'commit kept O(U^2) v_locks concat');
	perform pg_temp.t1333_ok(position('v_outcomes := v_outcomes ||' in v_def) = 0, 'commit kept O(U^2) v_outcomes concat');
	perform pg_temp.t1333_ok(position('v_parked := v_parked ||' in v_def) = 0, 'commit kept O(U^2) v_parked concat');

	select pg_get_constraintdef(c.oid) into v_pk
	from pg_constraint c
	where c.conrelid = 'public.qorpera_folder_storage_usage'::regclass and c.contype = 'p';
	perform pg_temp.t1333_ok(v_pk = 'PRIMARY KEY (profile_id, bucket)', 'sharded usage PK mismatch: ' || coalesce(v_pk, 'null'));
end $$;

-- WHY: Section A verifies set-based qorpera_folder_list parity across allow, deny, override, secrets, private, and pagination.
do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_profile uuid := '63500000-0000-4000-8000-000000000010';
	v_owner uuid := '63500000-0000-4000-8000-000000000001';
	v_member uuid := '63500000-0000-4000-8000-000000000002';
	v_staff uuid := '63500000-0000-4000-8000-0000000000a1';
	v_run jsonb := pg_temp.actor('run_one');
	v_res_ops uuid;
	v_res_pub uuid;
	v_res_shared uuid;
	v_res_priv uuid;
	v_root_res uuid;
	v_root_grant uuid;
	v_list jsonb;
	v_expected jsonb;
	v_page jsonb;
	v_after text;
	v_paged jsonb;
	v_auth jsonb;
	v_entry jsonb;
begin
	perform public.qorpera_folder_commit(v_env, '{"kind":"platform"}', 't1333-list-seed', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'depts/ops/public'),
		jsonb_build_object('op', 'write', 'path', 'depts/ops/public/ok.txt', 'file', pg_temp.stage('ops-pub')),
		jsonb_build_object('op', 'mkdir', 'path', 'shared-other'),
		jsonb_build_object('op', 'write', 'path', 'shared-other/nope.txt', 'file', pg_temp.stage('shared-other')),
		jsonb_build_object('op', 'mkdir', 'path', 'credentials'),
		jsonb_build_object('op', 'write', 'path', 'credentials/api.txt', 'file', pg_temp.stage('cred-secret')),
		jsonb_build_object('op', 'mkdir', 'path', 'secrets'),
		jsonb_build_object('op', 'write', 'path', 'secrets/token.txt', 'file', pg_temp.stage('sec-token')),
		jsonb_build_object('op', 'mkdir', 'path', 'members'),
		jsonb_build_object('op', 'mkdir', 'path', 'members/' || v_owner::text),
		jsonb_build_object('op', 'mkdir', 'path', 'members/' || v_owner::text || '/private'),
		jsonb_build_object('op', 'write', 'path', 'members/' || v_owner::text || '/private/diary.txt', 'file', pg_temp.stage('owner-diary')),
		jsonb_build_object('op', 'mkdir', 'path', 'code'),
		jsonb_build_object('op', 'write', 'path', 'code/main.ts', 'file', pg_temp.stage('console.log(1)'))
	));

	v_res_ops := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'depts/ops', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	v_res_pub := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'depts/ops/public', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	perform public.qorpera_folder_grant(v_env, pg_temp.member(1), v_res_pub, 'staff_agent', v_staff, array['read'], null);
	v_res_priv := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'members/' || v_owner::text || '/private', 'subtree', 'member_private', 'normal') ->> 'resourceId')::uuid;

	v_auth := public.qorpera_folder_read_actor(v_env, v_run);
	v_list := public.qorpera_folder_list(v_env, v_run, '', null, 1000, true);
	select coalesce(jsonb_agg(jsonb_build_object('path', e.path, 'version', e.version,
		'authority', public.qorpera_folder_read_receipt(v_env, v_profile, v_auth, e.path)) order by e.key_text), '[]'::jsonb)
	into v_expected
	from public.qorpera_folder_entries e
	where e.environment_id = v_env and e.kind <> 'claim'
		and public.qorpera_folder_actor_allowed(v_env, v_profile, v_auth, e.path, 'read');

	perform pg_temp.t1333_ok(
		(select coalesce(jsonb_agg(jsonb_build_object('path', x ->> 'path', 'version', x ->> 'version', 'authority', x -> 'authority')), '[]'::jsonb)
			from jsonb_array_elements(v_list -> 'entries') x) = v_expected,
		format('root-allowed recursive list parity mismatch: got=%s expected=%s', v_list -> 'entries', v_expected));

	perform pg_temp.t1333_ok(
		not exists (select 1 from jsonb_array_elements(v_list -> 'entries') x
			where x ->> 'path' in ('depts/ops/q.txt', 'credentials/api.txt', 'secrets/token.txt', 'members/' || v_owner::text || '/private/diary.txt')),
		'denied/secret/private paths leaked into run list');
	perform pg_temp.t1333_ok(
		exists (select 1 from jsonb_array_elements(v_list -> 'entries') x where x ->> 'path' = 'depts/ops/public/ok.txt'),
		'child override depts/ops/public/ok.txt missing from run list');

	v_list := public.qorpera_folder_list(v_env, pg_temp.member(1), 'members/' || v_owner::text || '/private', null, 100, false);
	perform pg_temp.t1333_ok(jsonb_array_length(v_list -> 'entries') = 1 and v_list -> 'entries' -> 0 ->> 'path' = 'members/' || v_owner::text || '/private/diary.txt',
		'owner member must see own private folder');
	v_list := public.qorpera_folder_list(v_env, pg_temp.member(2), 'members/' || v_owner::text || '/private', null, 100, false);
	perform pg_temp.t1333_ok(jsonb_array_length(v_list -> 'entries') = 0, 'other member must not see owner private folder');

	select id into v_root_res from public.qorpera_company_path_resources where environment_id = v_env and path = '' and revoked_at is null;
	select id into v_root_grant from public.qorpera_company_path_grants
	where resource_id = v_root_res and principal_kind = 'staff_agent' and principal_id = v_staff and revoked_at is null;
	v_res_shared := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'shared', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	perform public.qorpera_folder_grant(v_env, pg_temp.member(1), v_res_shared, 'staff_agent', v_staff, array['read', 'write'], null);
	perform public.qorpera_folder_revoke(v_env, pg_temp.member(1), v_root_res, v_root_grant);

	v_paged := '[]'::jsonb;
	v_after := null;
	loop
		v_page := public.qorpera_folder_list(v_env, v_run, '', v_after, 2, true);
		v_paged := v_paged || (v_page -> 'entries');
		v_after := v_page ->> 'next';
		exit when v_after is null;
	end loop;

	select coalesce(jsonb_agg(jsonb_build_object('path', e.path, 'version', e.version,
		'authority', public.qorpera_folder_read_receipt(v_env, v_profile, v_auth, e.path)) order by e.key_text), '[]'::jsonb)
	into v_expected
	from public.qorpera_folder_entries e
	where e.environment_id = v_env and e.kind <> 'claim'
		and public.qorpera_folder_actor_allowed(v_env, v_profile, v_auth, e.path, 'read');

	perform pg_temp.t1333_ok(
		(select coalesce(jsonb_agg(jsonb_build_object('path', x ->> 'path', 'version', x ->> 'version', 'authority', x -> 'authority')), '[]'::jsonb)
			from jsonb_array_elements(v_paged) x) = v_expected,
		format('root-denied top_allowed paginated parity mismatch: got=%s expected=%s', v_paged, v_expected));
	perform pg_temp.t1333_ok(
		not exists (select 1 from jsonb_array_elements(v_paged) x where x ->> 'path' like 'shared-other%'),
		'prefix pushdown leaked sibling shared-other');

	perform public.qorpera_folder_grant(v_env, pg_temp.member(1), v_root_res, 'staff_agent', v_staff, array['read', 'write'], null);
end $$;

-- WHY: Section B verifies qorpera_folder_view_fingerprint accuracy across writes, deletes, authority changes, and timed grants.
do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_staff uuid := '63500000-0000-4000-8000-0000000000a1';
	v_run jsonb := pg_temp.actor('run_one');
	v_fp1 jsonb;
	v_fp2 jsonb;
	v_fp3 jsonb;
	v_list jsonb;
	v_res_timed uuid;
	v_grant_timed uuid;
	v_write_res jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin
		perform public.qorpera_folder_view_fingerprint(v_env, '{"kind":"platform"}');
		raise exception 'view_fingerprint allowed non-service_role';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	v_fp1 := public.qorpera_folder_view_fingerprint(v_env, '{"kind":"platform"}');
	v_list := public.qorpera_folder_list(v_env, '{"kind":"platform"}', '', null, 1000, true);
	perform pg_temp.t1333_ok(v_fp1 ->> 'schema' = 'qorpera.folder-view-fingerprint/v1', 'bad fingerprint schema');
	perform pg_temp.t1333_ok((v_fp1 ->> 'entryCount')::integer = jsonb_array_length(v_list -> 'entries'), 'platform count mismatch');
	perform pg_temp.t1333_ok(v_fp1 ->> 'entriesDigest' = pg_temp.t1333_digest_from_list(v_list -> 'entries', false),
		format('platform digest mismatch: fp=%s calc=%s', v_fp1 ->> 'entriesDigest', pg_temp.t1333_digest_from_list(v_list -> 'entries', false)));

	v_fp1 := public.qorpera_folder_view_fingerprint(v_env, v_run);
	v_list := public.qorpera_folder_list(v_env, v_run, '', null, 1000, true);
	perform pg_temp.t1333_ok((v_fp1 ->> 'entryCount')::integer = jsonb_array_length(v_list -> 'entries'), 'run count mismatch');
	perform pg_temp.t1333_ok(v_fp1 ->> 'entriesDigest' = pg_temp.t1333_digest_from_list(v_list -> 'entries', true),
		'run digest with read receipts mismatch');

	v_write_res := pg_temp.commit('{"kind":"platform"}', 't1333-fp-write', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'shared/fp-probe.txt', 'file', pg_temp.stage('fp-v1'))
	));
	v_fp2 := public.qorpera_folder_view_fingerprint(v_env, v_run);
	perform pg_temp.t1333_ok((v_fp2 ->> 'seq')::bigint > (v_fp1 ->> 'seq')::bigint, 'seq did not advance on write');
	perform pg_temp.t1333_ok((v_fp2 ->> 'entryCount')::bigint = (v_fp1 ->> 'entryCount')::bigint + 1, 'count did not increment');
	perform pg_temp.t1333_ok(v_fp2 ->> 'entriesDigest' <> v_fp1 ->> 'entriesDigest', 'digest did not change on write');

	perform pg_temp.commit('{"kind":"platform"}', 't1333-fp-del', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'shared/fp-probe.txt', 'expectedVersion', v_write_res -> 'units' -> 0 ->> 'version')
	));
	v_fp3 := public.qorpera_folder_view_fingerprint(v_env, v_run);
	perform pg_temp.t1333_ok((v_fp3 ->> 'entryCount')::bigint = (v_fp1 ->> 'entryCount')::bigint, 'count did not restore after delete');
	perform pg_temp.t1333_ok(v_fp3 ->> 'entriesDigest' = v_fp1 ->> 'entriesDigest', 'XOR digest must cancel after delete');

	perform pg_temp.commit('{"kind":"platform"}', 't1333-fp-timed-file', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'timed-fp'),
		jsonb_build_object('op', 'write', 'path', 'timed-fp/doc.txt', 'file', pg_temp.stage('timed-doc'))
	));
	v_res_timed := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'timed-fp', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	v_grant_timed := (public.qorpera_folder_grant(v_env, pg_temp.member(1), v_res_timed, 'staff_agent', v_staff, array['read'], clock_timestamp() + interval '1 hour') ->> 'grantId')::uuid;
	v_fp1 := public.qorpera_folder_view_fingerprint(v_env, v_run);
	perform pg_temp.t1333_ok((v_fp1 ->> 'authoritySeq')::bigint > (v_fp3 ->> 'authoritySeq')::bigint, 'authoritySeq did not advance');

	update public.qorpera_company_path_grants
	set created_at = clock_timestamp() - interval '10 seconds', expires_at = clock_timestamp() - interval '1 second'
	where id = v_grant_timed;
	v_fp2 := public.qorpera_folder_view_fingerprint(v_env, v_run);
	perform pg_temp.t1333_ok((v_fp2 ->> 'authoritySeq')::bigint = (v_fp1 ->> 'authoritySeq')::bigint, 'expiry does not advance authoritySeq');
	perform pg_temp.t1333_ok((v_fp2 ->> 'entryCount')::bigint = (v_fp1 ->> 'entryCount')::bigint - 2, 'expired grant must reduce visible entryCount');
	perform pg_temp.t1333_ok(v_fp2 ->> 'entriesDigest' <> v_fp1 ->> 'entriesDigest', 'expired grant must change entriesDigest');
end $$;

-- WHY: Section C verifies set-based qorpera_folder_commit parity, mismatch precedence, and a 1,000-unit run commit benchmark.
do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_run jsonb := pg_temp.actor('run_one');
	v_file jsonb := pg_temp.stage('bench-1000-payload');
	v_unpossessed jsonb := pg_temp.stage('unpossessed-mismatch-payload');
	v_mixed jsonb;
	v_units jsonb;
	v_started timestamptz;
	v_elapsed_ms numeric;
	v_res jsonb;
	v_saved_count integer;
begin
	v_mixed := pg_temp.commit(v_run, 't1333-commit-parity', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'shared/parity'),
		jsonb_build_object('op', 'write', 'path', 'shared/parity/ok.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'depts/ops/denied.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'shared/parity/unverified.txt', 'file', jsonb_build_object(
			'manifestSha256', repeat('d', 64), 'fileSha256', repeat('e', 64), 'bytes', 5, 'mediaType', 'text/plain', 'executable', false)),
		jsonb_build_object('op', 'copy', 'from', 'shared/parity/ok.txt', 'to', 'shared/parity/copied.txt')
	));
	perform pg_temp.t1333_ok(v_mixed -> 'units' -> 0 ->> 'outcome' = 'saved', 'parity unit 0 mkdir failed');
	perform pg_temp.t1333_ok(v_mixed -> 'units' -> 1 ->> 'outcome' = 'saved', 'parity unit 1 write failed');
	perform pg_temp.t1333_ok(v_mixed -> 'units' -> 2 ->> 'outcome' = 'denied' and v_mixed -> 'units' -> 2 ->> 'reason' = 'denied',
		'parity unit 2 must refuse denied: ' || (v_mixed -> 'units' -> 2)::text);
	perform pg_temp.t1333_ok(v_mixed -> 'units' -> 3 ->> 'outcome' = 'refused' and v_mixed -> 'units' -> 3 ->> 'reason' = 'bytes_unverified',
		'parity unit 3 must refuse bytes_unverified: ' || (v_mixed -> 'units' -> 3)::text);
	perform pg_temp.t1333_ok(v_mixed -> 'units' -> 4 ->> 'outcome' = 'saved', 'parity unit 4 copy failed');
	v_mixed := pg_temp.commit(pg_temp.member(1), 't1333-commit-parity-move', jsonb_build_array(
		jsonb_build_object('op', 'move', 'from', 'shared/parity/copied.txt', 'to', 'shared/parity/moved.txt',
			'expectedVersion', v_mixed -> 'units' -> 4 ->> 'version')
	));
	perform pg_temp.t1333_ok(v_mixed -> 'units' -> 0 ->> 'outcome' = 'saved', 'parity move failed: ' || v_mixed::text);

	v_mixed := public.qorpera_folder_commit(v_env, v_run, 't1333-commit-mismatch-unpossessed', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'shared/parity/mismatch-unpossessed.txt',
			'file', v_unpossessed || jsonb_build_object('mediaType', 'application/octet-stream'))
	));
	perform pg_temp.t1333_ok(
		v_mixed -> 'units' -> 0 ->> 'outcome' = 'refused' and v_mixed -> 'units' -> 0 ->> 'reason' = 'bytes_unverified',
		'unpossessed mismatched v2 manifest must return bytes_unverified (security 20260930043000): ' || v_mixed::text);

	begin
		perform public.qorpera_folder_commit(v_env, v_run, 't1333-commit-mismatch-holder', jsonb_build_array(
			jsonb_build_object('op', 'write', 'path', 'shared/parity/mismatch-holder.txt',
				'file', v_file || jsonb_build_object('mediaType', 'application/octet-stream'))
		));
		raise exception 'possessed mismatched v2 manifest must raise 22023';
	exception when invalid_parameter_value then null;
	end;

	perform pg_temp.t1333_ok(not exists (select 1 from public.qorpera_folder_entries where environment_id = v_env and kind = 'claim'),
		'commit left behind claim rows');

	select jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'bench1000'))
		|| jsonb_agg(jsonb_build_object('op', 'write', 'path', format('bench1000/f%04s.txt', g), 'file', v_file) order by g)
	into v_units
	from generate_series(1, 999) g;
	perform pg_temp.possess(v_env, v_run, v_units);

	v_started := clock_timestamp();
	v_res := public.qorpera_folder_commit(v_env, v_run, 't1333-bench-1000', v_units);
	v_elapsed_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;

	select count(*) into v_saved_count
	from jsonb_array_elements(v_res -> 'units') u
	where u ->> 'outcome' = 'saved';
	perform pg_temp.t1333_ok(v_saved_count = 1000, format('1000-unit run commit saved %s/1000', v_saved_count));
	perform pg_temp.t1333_ok(
		(select count(*) from public.qorpera_folder_entries where environment_id = v_env and key_text >= 'bench1000/' collate "C" and key_text < 'bench10000' collate "C") = 999,
		'1000-unit commit entry count mismatch');
	raise notice '1333 bench: 1000-unit run commit completed in % ms', round(v_elapsed_ms, 1);

	perform public.qorpera_folder_commit(v_env, '{"kind":"platform"}', 't1333-bench-1000-clean',
		jsonb_build_array(jsonb_build_object('op', 'delete', 'path', 'bench1000',
			'expectedVersion', v_res -> 'units' -> 0 ->> 'version', 'asOfSeq', (v_res ->> 'seq')::bigint)));
	perform pg_temp.t1333_ok(
		not exists (select 1 from public.qorpera_folder_entries where environment_id = v_env and (key_text = 'bench1000' or (key_text >= 'bench1000/' collate "C" and key_text < 'bench10000' collate "C"))),
		'bench1000 cleanup left entries');
end $$;

-- WHY: Section C2 proves bulk path locking rolls back short groups and preserves strict C key order without deadlocks across 3 sessions.
do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_file jsonb := pg_temp.stage('lock-order-race-payload');
	v_seed jsonb;
begin
	v_seed := public.qorpera_folder_commit(v_env, '{"kind":"platform"}', 't1333-lock-race-seed', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'shared/lock-race'),
		jsonb_build_object('op', 'write', 'path', 'shared/lock-race/d1.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'shared/lock-race/d2.txt', 'file', v_file)
	));
	perform set_config('qorpera_test.t1333_race_file', v_file::text, false);
	perform set_config('qorpera_test.t1333_d1_ver', v_seed -> 'units' -> 1 ->> 'version', false);
end $$;

do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_file jsonb := current_setting('qorpera_test.t1333_race_file')::jsonb;
	v_d1_ver text := current_setting('qorpera_test.t1333_d1_ver');
	v_r2 jsonb;
	v_r3 jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format(
		'select public.qorpera_folder_commit(%L, %L, %L, %L)',
		v_env, '{"kind":"platform"}', 't1333-race-ins-t2',
		jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'shared/lock-race/k1.txt', 'file', v_file))::text
	)) as t(r jsonb);

	perform dblink_send_query('auth_two', format(
		'select public.qorpera_folder_commit(%L, %L, %L, %L)',
		v_env, '{"kind":"platform"}', 't1333-race-ins-t1',
		jsonb_build_array(
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/k1.txt', 'file', v_file),
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/k2.txt', 'file', v_file)
		)::text
	));
	perform pg_temp.t1333_ok(pg_temp.waits_for('auth_two', 'auth_one'), 'T1 did not wait on T2 claim for k1');

	perform dblink_send_query('auth_three', format(
		'select public.qorpera_folder_commit(%L, %L, %L, %L)',
		v_env, '{"kind":"platform"}', 't1333-race-ins-t3',
		jsonb_build_array(
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/k1.txt', 'file', v_file),
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/k2.txt', 'file', v_file)
		)::text
	));
	perform pg_temp.t1333_ok(pg_temp.t1333_waits_for_any('auth_three', array['auth_one', 'auth_two']), 'T3 did not wait on T2/T1 claim for k1');

	perform dblink_exec('auth_one', 'commit');
	v_r2 := pg_temp.result('auth_two');
	v_r3 := pg_temp.result('auth_three');
	perform pg_temp.t1333_ok(
		v_r2 -> 'units' -> 0 ->> 'outcome' = 'conflict' and v_r3 -> 'units' -> 0 ->> 'outcome' = 'conflict',
		format('k1 must conflict after T2 commits: t1=%s t3=%s', v_r2, v_r3));
	perform pg_temp.t1333_ok(
		((v_r2 -> 'units' -> 1 ->> 'outcome' = 'saved' and v_r3 -> 'units' -> 1 ->> 'outcome' = 'conflict')
			or (v_r2 -> 'units' -> 1 ->> 'outcome' = 'conflict' and v_r3 -> 'units' -> 1 ->> 'outcome' = 'saved')),
		format('k2 must save once without deadlock: t1=%s t3=%s', v_r2, v_r3));

	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format(
		'select public.qorpera_folder_commit(%L, %L, %L, %L)',
		v_env, '{"kind":"platform"}', 't1333-race-del-t2',
		jsonb_build_array(jsonb_build_object('op', 'delete', 'path', 'shared/lock-race/d1.txt', 'expectedVersion', v_d1_ver))::text
	)) as t(r jsonb);

	perform dblink_send_query('auth_two', format(
		'select public.qorpera_folder_commit(%L, %L, %L, %L)',
		v_env, '{"kind":"platform"}', 't1333-race-del-t1',
		jsonb_build_array(
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/d1.txt', 'file', v_file),
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/d2.txt', 'file', v_file)
		)::text
	));
	perform pg_temp.t1333_ok(pg_temp.waits_for('auth_two', 'auth_one'), 'T1 did not wait on T2 delete for d1');

	perform dblink_send_query('auth_three', format(
		'select public.qorpera_folder_commit(%L, %L, %L, %L)',
		v_env, '{"kind":"platform"}', 't1333-race-del-t3',
		jsonb_build_array(
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/d1.txt', 'file', v_file),
			jsonb_build_object('op', 'write', 'path', 'shared/lock-race/d2.txt', 'file', v_file)
		)::text
	));
	perform pg_temp.t1333_ok(pg_temp.t1333_waits_for_any('auth_three', array['auth_one', 'auth_two']), 'T3 did not wait on T2/T1 delete for d1');

	perform dblink_exec('auth_one', 'commit');
	v_r2 := pg_temp.result('auth_two');
	v_r3 := pg_temp.result('auth_three');
	perform pg_temp.t1333_ok(
		((v_r2 -> 'units' -> 0 ->> 'outcome' = 'saved' and v_r3 -> 'units' -> 0 ->> 'outcome' = 'conflict')
			or (v_r2 -> 'units' -> 0 ->> 'outcome' = 'conflict' and v_r3 -> 'units' -> 0 ->> 'outcome' = 'saved')),
		format('d1 must recreate once after delete without deadlock: t1=%s t3=%s', v_r2, v_r3));
	perform pg_temp.t1333_ok(
		v_r2 -> 'units' -> 1 ->> 'outcome' = 'conflict' and v_r3 -> 'units' -> 1 ->> 'outcome' = 'conflict',
		format('d2 must remain conflict: t1=%s t3=%s', v_r2, v_r3));
	perform pg_temp.t1333_ok(
		not exists (select 1 from public.qorpera_folder_entries where environment_id = v_env and kind = 'claim'),
		'bulk lock rollback left behind claim rows');
end $$;

-- WHY: Section D verifies active-entry readability short-circuit, historical fallback, and authority-clock download fence.
do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_profile uuid := '63500000-0000-4000-8000-000000000010';
	v_staff uuid := '63500000-0000-4000-8000-0000000000a1';
	v_run jsonb := pg_temp.actor('run_one');
	v_auth jsonb := public.qorpera_folder_read_actor(v_env, v_run);
	v_active_file jsonb := pg_temp.stage('fence-active-body');
	v_hist_file jsonb := pg_temp.stage('fence-hist-body');
	v_denied_file jsonb := pg_temp.stage('fence-denied-body');
	v_timed_file jsonb := pg_temp.stage('fence-timed-body');
	v_res_fence uuid;
	v_grant_fence uuid;
	v_res_t uuid;
	v_grant_t uuid;
	v_pre jsonb;
	v_post jsonb;
	v_member_dl jsonb;
	v_keys text[];
	v_seed_res jsonb;
begin
	v_seed_res := public.qorpera_folder_commit(v_env, '{"kind":"platform"}', 't1333-fence-seed', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'fence-dir'),
		jsonb_build_object('op', 'write', 'path', 'fence-dir/live.txt', 'file', v_active_file),
		jsonb_build_object('op', 'write', 'path', 'fence-dir/hist.txt', 'file', v_hist_file),
		jsonb_build_object('op', 'write', 'path', 'depts/ops/only-denied.txt', 'file', v_denied_file),
		jsonb_build_object('op', 'mkdir', 'path', 'fence-timed'),
		jsonb_build_object('op', 'write', 'path', 'fence-timed/doc.txt', 'file', v_timed_file)
	));
	perform public.qorpera_folder_commit(v_env, '{"kind":"platform"}', 't1333-fence-del-hist', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'fence-dir/hist.txt', 'expectedVersion', v_seed_res -> 'units' -> 2 ->> 'version')
	));

	v_res_fence := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'fence-dir', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	v_grant_fence := (public.qorpera_folder_grant(v_env, pg_temp.member(1), v_res_fence, 'staff_agent', v_staff, array['read'], null) ->> 'grantId')::uuid;

	perform pg_temp.t1333_ok(
		public.qorpera_folder_object_readable_state(v_env, v_profile, v_auth, v_active_file ->> 'fileSha256') = 'active_fenceable',
		'active file must short-circuit to active_fenceable');
	perform pg_temp.t1333_ok(
		public.qorpera_folder_object_readable_state(v_env, v_profile, v_auth, v_hist_file ->> 'fileSha256') = 'historical',
		'deleted file must fall back to historical');
	perform pg_temp.t1333_ok(
		public.qorpera_folder_object_readable_state(v_env, v_profile, v_auth, v_denied_file ->> 'fileSha256') = 'none',
		'denied file must return none');

	v_pre := public.qorpera_folder_authorize_object_download(v_env, v_run, v_active_file ->> 'fileSha256');
	perform pg_temp.t1333_ok((v_pre ->> 'viaActive')::boolean = true, 'active download must set viaActive=true');
	v_post := public.qorpera_folder_download_fence(
		v_env, v_run, v_active_file ->> 'fileSha256',
		(v_pre ->> 'authoritySeq')::bigint, (v_pre ->> 'checkedAt')::timestamptz, (v_pre ->> 'viaActive')::boolean
	);
	perform pg_temp.t1333_ok((v_post ->> 'rechecked')::boolean = false, 'unchanged authoritySeq must skip full recheck');
	perform pg_temp.t1333_ok(v_post ->> 'profileId' = v_pre ->> 'profileId' and v_post ->> 'bytes' = v_pre ->> 'bytes', 'fence metadata mismatch');

	v_post := public.qorpera_folder_download_fence(
		v_env, v_run, v_hist_file ->> 'fileSha256',
		(v_pre ->> 'authoritySeq')::bigint, (v_pre ->> 'checkedAt')::timestamptz, false
	);
	perform pg_temp.t1333_ok((v_post ->> 'rechecked')::boolean = true, 'historical download must force recheck');

	perform public.qorpera_folder_revoke(v_env, pg_temp.member(1), v_res_fence, v_grant_fence);
	begin
		perform public.qorpera_folder_download_fence(
			v_env, v_run, v_active_file ->> 'fileSha256',
			(v_pre ->> 'authoritySeq')::bigint, (v_pre ->> 'checkedAt')::timestamptz, true
		);
		raise exception 'download_fence allowed revoked grant';
	exception when insufficient_privilege then null;
	end;

	v_res_t := (public.qorpera_folder_set_resource(v_env, pg_temp.member(1), 'fence-timed', 'subtree', 'company_shared', 'normal') ->> 'resourceId')::uuid;
	v_grant_t := (public.qorpera_folder_grant(v_env, pg_temp.member(1), v_res_t, 'staff_agent', v_staff, array['read'], clock_timestamp() + interval '1 hour') ->> 'grantId')::uuid;
	v_pre := public.qorpera_folder_authorize_object_download(v_env, v_run, v_timed_file ->> 'fileSha256');
	update public.qorpera_company_path_grants
	set created_at = clock_timestamp() - interval '10 seconds', expires_at = clock_timestamp() - interval '1 millisecond'
	where id = v_grant_t;
	begin
		perform public.qorpera_folder_download_fence(
			v_env, v_run, v_timed_file ->> 'fileSha256',
			(v_pre ->> 'authoritySeq')::bigint, ((v_pre ->> 'checkedAt')::timestamptz) - interval '1 second', true
		);
		raise exception 'download_fence allowed expired timed grant';
	exception when insufficient_privilege then null;
	end;

	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', '63500000-0000-4000-8000-000000000001')::text, true);
	v_member_dl := public.qorpera_member_folder_object(v_env, v_active_file ->> 'fileSha256');
	select array_agg(k order by k) into v_keys from jsonb_object_keys(v_member_dl) k;
	perform pg_temp.t1333_ok(v_keys = array['bytes', 'profileId', 'schema'],
		'qorpera_member_folder_object must preserve exact 3-key shape: ' || array_to_string(v_keys, ','));
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- WHY: Section E proves 16-bucket sharded storage usage, exact quota enforcement, backfill delete math, and zero confirm contention via dblink.
do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_p1 text;
	v_p2 text;
	v_h1 text;
	v_h2 text;
	v_b1 smallint;
	v_b2 smallint;
	v_i integer := 0;
	v_open1 jsonb;
	v_open2 jsonb;
begin
	loop
		v_i := v_i + 1;
		v_p1 := 'shard-concur-a-' || v_i || '-' || extensions.gen_random_uuid();
		v_p2 := 'shard-concur-b-' || v_i || '-' || extensions.gen_random_uuid();
		v_h1 := pg_temp.t1333_hash(v_p1);
		v_h2 := pg_temp.t1333_hash(v_p2);
		v_b1 := pg_temp.t1333_bucket(v_h1);
		v_b2 := pg_temp.t1333_bucket(v_h2);
		exit when v_b1 <> v_b2 and v_b1 <> 0 and v_b2 <> 0;
	end loop;
	v_open1 := public.qorpera_folder_open_upload(v_env, pg_temp.member(1), pg_temp.t1333_manifest(v_p1));
	v_open2 := public.qorpera_folder_open_upload(v_env, pg_temp.member(2), pg_temp.t1333_manifest(v_p2));
	perform set_config('qorpera_test.t1333_p1', v_p1, false);
	perform set_config('qorpera_test.t1333_p2', v_p2, false);
	perform set_config('qorpera_test.t1333_open1', v_open1 ->> 'intentId', false);
	perform set_config('qorpera_test.t1333_open2', v_open2 ->> 'intentId', false);
end $$;

do $$
declare
	v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_profile uuid := '63500000-0000-4000-8000-000000000010';
	v_p1 text := current_setting('qorpera_test.t1333_p1');
	v_p2 text := current_setting('qorpera_test.t1333_p2');
	v_h1 text := pg_temp.t1333_hash(v_p1);
	v_h2 text := pg_temp.t1333_hash(v_p2);
	v_b1 smallint := pg_temp.t1333_bucket(v_h1);
	v_b2 smallint := pg_temp.t1333_bucket(v_h2);
	v_intent1 text := current_setting('qorpera_test.t1333_open1');
	v_intent2 text := current_setting('qorpera_test.t1333_open2');
	v_sum_before bigint;
	v_obj_before bigint;
	v_sum_after bigint;
	v_obj_after bigint;
	v_old_limit bigint;
	v_quota_open jsonb;
	v_quota_payload text := 'quota-over-bucket-check-' || extensions.gen_random_uuid();
	v_cf public.qorpera_company_files%rowtype;
	v_cf_json jsonb;
begin
	select coalesce(sum(bytes), 0)::bigint, coalesce(sum(objects), 0)::bigint
	into v_sum_before, v_obj_before
	from public.qorpera_folder_storage_usage where profile_id = v_profile;

	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format(
		'select public.qorpera_folder_confirm_object(%L, %L, %L, %L, %s)',
		v_env, pg_temp.member(1)::text, v_intent1, v_h1, octet_length(convert_to(v_p1, 'utf8'))
	)) as t(r jsonb);

	perform dblink_send_query('auth_two', format(
		'select public.qorpera_folder_confirm_object(%L, %L, %L, %L, %s)',
		v_env, pg_temp.member(2)::text, v_intent2, v_h2, octet_length(convert_to(v_p2, 'utf8'))
	));
	perform pg_temp.t1333_ok(
		pg_temp.finishes_unblocked('auth_two', 'auth_one'),
		format('confirm on bucket %s blocked on uncommitted confirm in bucket %s', v_b2, v_b1));
	perform pg_temp.t1333_ok(pg_temp.outcome('auth_two') = 'ok', 'concurrent confirm in distinct bucket failed');
	perform dblink_exec('auth_one', 'commit');

	select coalesce(sum(bytes), 0)::bigint, coalesce(sum(objects), 0)::bigint
	into v_sum_after, v_obj_after
	from public.qorpera_folder_storage_usage where profile_id = v_profile;
	perform pg_temp.t1333_ok(
		v_sum_after = v_sum_before + octet_length(convert_to(v_p1, 'utf8')) + octet_length(convert_to(v_p2, 'utf8')),
		format('sharded byte sum mismatch: before=%s after=%s', v_sum_before, v_sum_after));
	perform pg_temp.t1333_ok(v_obj_after = v_obj_before + 2, 'sharded object count mismatch');
	perform pg_temp.t1333_ok(
		(select count(*) from public.qorpera_folder_storage_usage where profile_id = v_profile and bucket in (v_b1, v_b2)) = 2,
		'distinct hashes must populate distinct usage buckets');

	select * into v_cf from public.qorpera_company_files where environment_id = v_env;
	v_cf_json := public.qorpera_company_file_json(v_cf);
	perform pg_temp.t1333_ok((v_cf_json ->> 'storage_used_bytes')::bigint = v_sum_after,
		format('company_file_json storage_used_bytes=%s expected=%s', v_cf_json ->> 'storage_used_bytes', v_sum_after));

	v_old_limit := v_cf.storage_limit_bytes;
	update public.qorpera_company_files set storage_limit_bytes = v_sum_after + 5 where profile_id = v_profile;
	v_quota_open := public.qorpera_folder_open_upload(v_env, pg_temp.member(1), pg_temp.t1333_manifest(v_quota_payload));
	begin
		perform public.qorpera_folder_authorize_object_upload(
			v_env, pg_temp.member(1), (v_quota_open ->> 'intentId')::uuid,
			pg_temp.t1333_hash(v_quota_payload), octet_length(convert_to(v_quota_payload, 'utf8'))
		);
		raise exception 'sharded quota check failed to reject over-limit upload';
	exception when check_violation then null;
	end;
	update public.qorpera_company_files set storage_limit_bytes = v_old_limit where profile_id = v_profile;

	delete from public.qorpera_folder_storage_usage where profile_id = v_profile;
	insert into public.qorpera_folder_storage_usage(profile_id, bucket, bytes, objects)
	select v_profile, 0::smallint, coalesce(sum(bytes), 0), count(*)
	from public.qorpera_profile_objects where profile_id = v_profile;
	delete from public.qorpera_profile_objects where profile_id = v_profile and sha256 = v_h1;
	perform pg_temp.t1333_ok(
		(select sum(bytes)::bigint from public.qorpera_folder_storage_usage where profile_id = v_profile)
			= (select coalesce(sum(bytes), 0)::bigint from public.qorpera_profile_objects where profile_id = v_profile),
		'deleting bucket-0-backfilled object broke cross-bucket sum invariant');
end $$;

select dblink_disconnect(name) from unnest(array['auth_one','auth_two','auth_three']) name;

set session_replication_role = replica;
delete from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intent_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '63500000-0000-4000-8000-000000000010/%';
delete from public.qorpera_folder_authority_changes where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_reads where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_read_records where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_releases where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_execution_sponsor_bindings where id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_provider_connections where id = '63500000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '63500000-0000-4000-8000-000000000010';
delete from auth.users where id in ('63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010') then
		raise exception '1333 fixture must be removed';
	end if;
end $$;

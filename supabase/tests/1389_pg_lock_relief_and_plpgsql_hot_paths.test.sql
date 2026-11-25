-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."
-- WHY: Verify 20260930907000 PL/pgSQL conversions, provider connection version lock relief, and member object download fence RPCs.

create function pg_temp.t1389_as_member(p_n integer) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '63000000-0000-4000-8000-00000000000' || p_n)::text, true)::text::void
$$;

create function pg_temp.t1389_ok(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception '1389 failed: %', p_msg;
	end if;
end $$;

create function pg_temp.t1389_state_of(p_statement text) returns text language plpgsql as $$
begin
	execute p_statement;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;

insert into auth.users(id, email) values ('63000000-0000-4000-8000-000000000005', 'fence-stranger@example.test');

do $$
declare
	v_proc record;
	v_def text;
	v_role text;
	v_env uuid := '63000000-0000-4000-8000-000000000020';
	v_profile uuid := '63000000-0000-4000-8000-000000000010';
	v_hist_file jsonb := pg_temp.stage('fence-member-hist-body');
	v_commit jsonb;
	v_secret_sha text;
	v_diary_sha text;
	v_hist_sha text;
	v_legacy jsonb;
	v_auth jsonb;
	v_fence jsonb;
	v_keys text[];
begin
	-- WHY: Verify all 8 converted hot helpers run as PL/pgSQL SECURITY DEFINER STABLE with empty search_path.
	for v_proc in
		select p.oid::regprocedure::text as sig, l.lanname, p.provolatile, p.prosecdef, p.proconfig
		from pg_proc p join pg_language l on l.oid = p.prolang
		where p.oid in (
			'public.qorpera_run_member_waits(public.qorpera_execution_runs)'::regprocedure,
			'public.qorpera_member_folder_object(uuid,text)'::regprocedure,
			'public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)'::regprocedure,
			'public.qorpera_folder_caller_allowed(jsonb)'::regprocedure,
			'public.qorpera_company_founding_seated(uuid)'::regprocedure,
			'public.qorpera_folder_company_ready(uuid)'::regprocedure,
			'public.qorpera_list_company_foundings()'::regprocedure,
			'public.qorpera_company_founding_open(uuid)'::regprocedure
		)
	loop
		perform pg_temp.t1389_ok(v_proc.lanname = 'plpgsql', v_proc.sig || ' must be plpgsql');
		perform pg_temp.t1389_ok(v_proc.provolatile = 's', v_proc.sig || ' must be stable');
		perform pg_temp.t1389_ok(v_proc.prosecdef, v_proc.sig || ' must be security definer');
		perform pg_temp.t1389_ok(v_proc.proconfig = array['search_path=""'], v_proc.sig || ' must pin search_path');
	end loop;

	-- WHY: Verify lock relief downgraded connection versions to FOR SHARE while keeping connections FOR UPDATE as concurrency mutex.
	v_def := pg_get_functiondef('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure);
	perform pg_temp.t1389_ok(position('order by version.connection_id, version.version for share;' in v_def) > 0,
		'qorpera_folder_materialize_company must lock connection versions FOR SHARE');
	perform pg_temp.t1389_ok(position('order by connection.id for update;' in v_def) > 0,
		'qorpera_folder_materialize_company must keep provider connections FOR UPDATE');

	v_def := pg_get_functiondef('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure);
	perform pg_temp.t1389_ok(position(E'and version.version = v_sponsor.provider_connection_version\n\tfor share;' in v_def) > 0,
		'qorpera_reserve_execution_sponsor_authority must lock connection versions FOR SHARE');
	perform pg_temp.t1389_ok(position(E'and connection.profile_id = v_run.profile_id and connection.status = ''active''\n\tfor update;' in v_def) > 0,
		'qorpera_reserve_execution_sponsor_authority must keep provider connections FOR UPDATE');

	-- WHY: Verify least-privilege grants on new member fence RPCs and preserved service_role-only grant on core download fence.
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.t1389_ok(
			has_function_privilege(v_role, 'public.qorpera_member_folder_object_authorize(uuid,text)', 'EXECUTE') = (v_role = 'authenticated'),
			'authorize grant mismatch for ' || v_role);
		perform pg_temp.t1389_ok(
			has_function_privilege(v_role, 'public.qorpera_member_folder_object_fence(uuid,text,bigint,timestamptz,boolean)', 'EXECUTE') = (v_role = 'authenticated'),
			'fence grant mismatch for ' || v_role);
		perform pg_temp.t1389_ok(
			has_function_privilege(v_role, 'public.qorpera_folder_download_fence(uuid,jsonb,text,bigint,timestamptz,boolean)', 'EXECUTE') = (v_role = 'service_role'),
			'core download_fence grant mismatch for ' || v_role);
	end loop;

	-- WHY: Exercise converted run/founding helpers to ensure PL/pgSQL bodies return expected values without runtime errors.
	perform pg_temp.t1389_ok(
		public.qorpera_run_member_waits(jsonb_populate_record(null::public.qorpera_execution_runs, '{"source_kind":"room_delivery"}'::jsonb)) = true,
		'qorpera_run_member_waits room_delivery');
	perform pg_temp.t1389_ok(
		public.qorpera_run_member_waits(jsonb_populate_record(null::public.qorpera_execution_runs, '{"source_kind":"wake"}'::jsonb)) = false,
		'qorpera_run_member_waits wake');
	perform pg_temp.t1389_ok(public.qorpera_company_founding_open(v_profile) = false, 'qorpera_company_founding_open false');
	perform pg_temp.t1389_ok(public.qorpera_folder_company_ready(v_profile) = false, 'qorpera_folder_company_ready false');

	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 't1389-diary', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'locked/diary.txt', 'file', pg_temp.stage('member 2 private diary'))
	)), 1, 'saved');
	v_commit := pg_temp.commit(pg_temp.platform(), 't1389-hist-add', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'notes/hist.txt', 'file', v_hist_file)
	));
	perform pg_temp.expect(v_commit, 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 't1389-hist-del', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'notes/hist.txt', 'expectedVersion', v_commit -> 'units' -> 0 ->> 'version')
	)), 1, 'saved');

	v_secret_sha := pg_temp.read('notes/secret.txt') -> 'entry' ->> 'manifestSha256';
	v_diary_sha := pg_temp.read('locked/diary.txt') -> 'entry' ->> 'manifestSha256';
	v_hist_sha := v_hist_file ->> 'manifestSha256';

	perform pg_temp.t1389_as_member(3);
	perform pg_temp.t1389_ok(public.qorpera_company_founding_seated(v_profile) = false, 'qorpera_company_founding_seated false');
	perform pg_temp.t1389_ok(public.qorpera_list_company_foundings() = '[]'::jsonb, 'qorpera_list_company_foundings empty');

	-- WHY: Verify forged actors are still blocked on qorpera_folder_download_fence when called under authenticated claims.
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format(
			'select public.qorpera_folder_download_fence(%L, %L::jsonb, %L, 0, now(), true)',
			v_env, '{"kind":"member","userId":"63000000-0000-4000-8000-000000000002"}', v_diary_sha
		)) = '42501 Folder core authority is required',
		'download_fence must reject another member actor');
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format(
			'select public.qorpera_folder_download_fence(%L, %L::jsonb, %L, 0, now(), true)',
			v_env, '{"kind":"platform"}', v_diary_sha
		)) = '42501 Folder core authority is required',
		'download_fence must reject platform actor from authenticated');

	-- WHY: Legacy member RPC keeps exact 3-key shape while new authorize/fence pair returns fence metadata and skips recheck when unchanged.
	v_legacy := public.qorpera_member_folder_object(v_env, v_secret_sha);
	select array_agg(k order by k) into v_keys from jsonb_object_keys(v_legacy) k;
	perform pg_temp.t1389_ok(v_keys = array['bytes', 'profileId', 'schema'], 'legacy member_folder_object key shape changed');

	v_auth := public.qorpera_member_folder_object_authorize(v_env, v_secret_sha);
	select array_agg(k order by k) into v_keys from jsonb_object_keys(v_auth) k;
	perform pg_temp.t1389_ok(
		v_keys = array['authoritySeq', 'bytes', 'checkedAt', 'profileId', 'schema', 'viaActive'],
		'authorize key shape mismatch: ' || coalesce(array_to_string(v_keys, ','), 'null'));
	perform pg_temp.t1389_ok((v_auth ->> 'viaActive')::boolean = true, 'active readable object must set viaActive=true');

	v_fence := public.qorpera_member_folder_object_fence(
		v_env, v_secret_sha,
		(v_auth ->> 'authoritySeq')::bigint,
		(v_auth ->> 'checkedAt')::timestamptz,
		(v_auth ->> 'viaActive')::boolean
	);
	select array_agg(k order by k) into v_keys from jsonb_object_keys(v_fence) k;
	perform pg_temp.t1389_ok(
		v_keys = array['authoritySeq', 'bytes', 'profileId', 'rechecked', 'schema'],
		'fence key shape mismatch: ' || coalesce(array_to_string(v_keys, ','), 'null'));
	perform pg_temp.t1389_ok((v_fence ->> 'rechecked')::boolean = false, 'unchanged authoritySeq must skip full recheck');
	perform pg_temp.t1389_ok(
		v_fence ->> 'profileId' = v_auth ->> 'profileId' and v_fence ->> 'bytes' = v_auth ->> 'bytes',
		'fence profileId/bytes mismatch');

	-- WHY: Historical object sets viaActive=false and forces fence recheck.
	v_auth := public.qorpera_member_folder_object_authorize(v_env, v_hist_sha);
	perform pg_temp.t1389_ok((v_auth ->> 'viaActive')::boolean = false, 'historical object must set viaActive=false');
	v_fence := public.qorpera_member_folder_object_fence(
		v_env, v_hist_sha,
		(v_auth ->> 'authoritySeq')::bigint,
		(v_auth ->> 'checkedAt')::timestamptz,
		(v_auth ->> 'viaActive')::boolean
	);
	perform pg_temp.t1389_ok((v_fence ->> 'rechecked')::boolean = true, 'historical object fence must force recheck');

	-- WHY: Private file of member 2 is refused to member 3 and allowed to member 2.
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format('select public.qorpera_member_folder_object_authorize(%L, %L)', v_env, v_diary_sha))
			= '42501 Object is unavailable',
		'member 3 must not authorize member 2 private file');
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format('select public.qorpera_member_folder_object_fence(%L, %L, 0, now(), false)', v_env, v_diary_sha))
			= '42501 Object is unavailable',
		'member 3 must not pass fence on member 2 private file');

	perform pg_temp.t1389_as_member(2);
	v_auth := public.qorpera_member_folder_object_authorize(v_env, v_diary_sha);
	v_fence := public.qorpera_member_folder_object_fence(
		v_env, v_diary_sha,
		(v_auth ->> 'authoritySeq')::bigint,
		(v_auth ->> 'checkedAt')::timestamptz,
		(v_auth ->> 'viaActive')::boolean
	);
	perform pg_temp.t1389_ok((v_fence ->> 'rechecked')::boolean = false, 'owner fence on active private file skips recheck');

	-- WHY: Non-member is refused on both new RPCs.
	perform pg_temp.t1389_as_member(5);
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format('select public.qorpera_member_folder_object_authorize(%L, %L)', v_env, v_secret_sha))
			= '42501 Company folder is unavailable',
		'non-member authorize must fail');
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format('select public.qorpera_member_folder_object_fence(%L, %L, 0, now(), true)', v_env, v_secret_sha))
			= '42501 Company folder is unavailable',
		'non-member fence must fail');

	-- WHY: Advancing authoritySeq forces fence recheck; narrowing notes to member 2 private must fail closed for member 3.
	perform pg_temp.t1389_as_member(3);
	v_auth := public.qorpera_member_folder_object_authorize(v_env, v_secret_sha);
	perform pg_temp.claims('service_role');
	perform public.qorpera_folder_set_resource(
		v_env, '{"kind":"member","userId":"63000000-0000-4000-8000-000000000001"}'::jsonb,
		'notes', 'subtree', 'company_shared', 'normal'
	);
	perform pg_temp.t1389_as_member(3);
	v_fence := public.qorpera_member_folder_object_fence(
		v_env, v_secret_sha,
		(v_auth ->> 'authoritySeq')::bigint,
		(v_auth ->> 'checkedAt')::timestamptz,
		true
	);
	perform pg_temp.t1389_ok((v_fence ->> 'rechecked')::boolean = true,
		'advanced authoritySeq must force fence recheck');

	perform pg_temp.claims('service_role');
	update public.qorpera_company_path_resources
	set scope = 'member_private', owner_user_id = '63000000-0000-4000-8000-000000000002'
	where environment_id = v_env and path = 'notes';
	perform pg_temp.t1389_as_member(3);
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format(
			'select public.qorpera_member_folder_object_fence(%L, %L, %s, %L::timestamptz, true)',
			v_env, v_secret_sha, (v_auth ->> 'authoritySeq')::bigint, v_auth ->> 'checkedAt'
		)) = '42501 Object is unavailable',
		'fence must reject member 3 after notes becomes member 2 private');
end $$;

savepoint t1389_deleting;
select pg_temp.claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('63000000-0000-4000-8000-000000000010', '63000000-0000-4000-8000-000000000001');
select pg_temp.t1389_as_member(2);
do $$
declare
	v_env uuid := '63000000-0000-4000-8000-000000000020';
	v_sha text := repeat('a', 64);
begin
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format('select public.qorpera_member_folder_object_authorize(%L, %L)', v_env, v_sha))
			= '55000 Company is being deleted',
		'deleting company must refuse authorize');
	perform pg_temp.t1389_ok(
		pg_temp.t1389_state_of(format('select public.qorpera_member_folder_object_fence(%L, %L, 0, now(), true)', v_env, v_sha))
			= '55000 Company is being deleted',
		'deleting company must refuse fence');
end $$;
rollback to savepoint t1389_deleting;
select pg_temp.claims('service_role');

rollback;

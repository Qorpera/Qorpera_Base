-- WHY: Regression, concurrency, and query-plan proofs for 20260930845000_sql_rpc_deadlocks_and_scans.sql.

create function pg_temp.t1327_ok(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception '1327 failed: %', p_msg;
	end if;
end $$;

-- WHY: Verify execute privileges, lock_timeout proconfig settings, and preserved patch invariants.
do $$
declare
	v_role text;
	v_config text[];
	v_def text;
begin
	select proconfig into v_config from pg_proc
	where oid = 'public.qorpera_folder_git_versions_expire(integer)'::regprocedure;
	perform pg_temp.t1327_ok('lock_timeout=2s' = any(coalesce(v_config, '{}')),
		format('git expire lock_timeout=2s missing: %s', v_config));

	select proconfig into v_config from pg_proc
	where oid = 'public.qorpera_archive_quiet_coding_sessions(text)'::regprocedure;
	perform pg_temp.t1327_ok('lock_timeout=1s' = any(coalesce(v_config, '{}')),
		format('quiet archive lock_timeout=1s missing: %s', v_config));

	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.t1327_ok(
			has_function_privilege(v_role, 'public.qorpera_set_primary_site_domain(uuid)', 'EXECUTE') = (v_role = 'authenticated'),
			'set_primary_site_domain grant mismatch for ' || v_role);
		perform pg_temp.t1327_ok(
			has_function_privilege(v_role, 'public.qorpera_seal_digital_post_letter(uuid,text,uuid,bigint,uuid,uuid)', 'EXECUTE') = (v_role = 'qorpera_secret_broker'),
			'seal_digital_post_letter grant mismatch for ' || v_role);
		perform pg_temp.t1327_ok(
			has_function_privilege(v_role, 'public.qorpera_claim_digital_post_letter_file(uuid,integer)', 'EXECUTE') = (v_role = 'service_role'),
			'claim_digital_post_letter_file grant mismatch for ' || v_role);
	end loop;

	v_def := pg_get_functiondef('public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)'::regprocedure);
	perform pg_temp.t1327_ok(position('''guestUid''' in v_def) > 0, 'keep_coding_attachments lost guestUid');
	perform pg_temp.t1327_ok(position('v_seen_by_worker' in v_def) > 0, 'keep_coding_attachments missing pre-indexed lookup');
	perform pg_temp.t1327_ok(position('v_entries || jsonb_build_array' in v_def) = 0, 'keep_coding_attachments kept O(S^2) concat');

	v_def := pg_get_functiondef('public.qorpera_memory_tree_prune(integer)'::regprocedure);
	perform pg_temp.t1327_ok(position('order by p loop' in v_def) > 0, 'memory_tree_prune missing deterministic profile lock order');
end $$;

-- WHY: Verify C1 runtime adapter short-circuit and materialized least-busy placement inside a rolled-back tx.
begin;
do $$
declare
	v_run public.qorpera_execution_runs;
	v_job public.qorpera_runner_jobs;
	v_res jsonb;
begin
	v_run.id := '13270000-0000-4000-8000-000000000101';
	v_run.compute_identity_id := null;
	v_run.session_id := null;
	v_run.runtime_bundle_sha256 := repeat('0', 64);
	v_run.created_at := clock_timestamp();
	perform pg_temp.t1327_ok(public.qorpera_runtime_run_adapter_allowed(v_run, 'lxd'),
		'null compute_identity_id must be allowed');

	v_res := public.qorpera_runtime_run_placement(v_job, v_run);
	perform pg_temp.t1327_ok(v_res ? 'reason' and v_res ? 'fast',
		format('runtime_run_placement returned unexpected payload: %s', v_res));
end $$;
rollback;

-- WHY: Committed fixtures for cross-session dblink concurrency proofs (cleaned up completely at end).
insert into auth.users(id, email) values
	('13270000-0000-4000-8000-000000000001', 'rpc1327-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('13270000-0000-4000-8000-000000000010', 'RPC 1327 A', '13270000-0000-4000-8000-000000000001'),
	('13270000-0000-4000-8000-000000000011', 'RPC 1327 B', '13270000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000001', 'rpc1327-owner@example.test', 'Owner', 'owner'),
	('13270000-0000-4000-8000-000000000011', '13270000-0000-4000-8000-000000000001', 'rpc1327-owner@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('13270000-0000-4000-8000-000000000020', '13270000-0000-4000-8000-000000000010', 'Env A', 1, '13270000-0000-4000-8000-000000000001'),
	('13270000-0000-4000-8000-000000000021', '13270000-0000-4000-8000-000000000011', 'Env B', 1, '13270000-0000-4000-8000-000000000001');

do $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable('13270000-0000-4000-8000-000000000020');
	perform public.qorpera_folder_enable('13270000-0000-4000-8000-000000000021');
end $$;

-- WHY: Verify query plans use PK/partial/GIN/hash indexes on the rewritten predicates with populated stats.
begin;
do $$
declare
	v_plan jsonb;
	v_key bytea := extensions.digest(public.qorpera_folder_key('plan-probe-1'), 'sha256');
begin
	set local session_replication_role = replica;
	insert into public.qorpera_folder_entries(environment_id, path, kind)
	select '13270000-0000-4000-8000-000000000020', 'plan-probe-' || g, 'claim'
	from generate_series(1, 100) g;
	analyze public.qorpera_folder_entries;
	set local enable_seqscan = off;
	set local enable_bitmapscan = off;

	v_plan := qorpera_test_support.plan_with_index_alone('public.qorpera_folder_entries_pkey', format($q$
		select 1 from public.qorpera_folder_entries entry
		where entry.environment_id = '13270000-0000-4000-8000-000000000020'
			and entry.key_sha256 = %L::bytea
			and entry.version = '13270000-0000-4000-8000-000000000099'
	$q$, v_key));
	perform pg_temp.t1327_ok(v_plan #>> '{scan,Index Cond}' ~ 'environment_id = .* AND \(key_sha256 = ',
		'C6 entries lookup did not use PK: ' || v_plan::text);

	v_plan := qorpera_test_support.plan_with_index_alone('public.qorpera_coding_sessions_open', $q$
		select 1 from public.qorpera_coding_sessions session
		where session.environment_id = '13270000-0000-4000-8000-000000000020'
			and session.archived_at is null
			and session.updated_at < clock_timestamp() - interval '1 hour'
	$q$);
	perform pg_temp.t1327_ok(v_plan #>> '{scan,Index Cond}' ~ '\(environment_id = ',
		'H3a quiet coding scan did not use qorpera_coding_sessions_open: ' || v_plan::text);

	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version,
		wake_kind, source_kind, trigger_id, occurrence_key, scheduled_for, not_before, payload)
	select extensions.gen_random_uuid(), '13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020',
		'13270000-0000-4000-8000-000000000077', 1, 'routine', 'company-file', 'file-change',
		'file:' || g || ':1', clock_timestamp(), clock_timestamp(),
		case when g = 1 then '{"folded":[{"seq":1}]}'::jsonb else '{}'::jsonb end
	from generate_series(1, 2000) g;
	analyze public.qorpera_wake_occurrences;

	set local enable_bitmapscan = on;
	v_plan := qorpera_test_support.plan_with_index_alone('public.qorpera_wake_occurrences_folded_file_commits', $q$
		select 1 from public.qorpera_wake_occurrences w
		where w.routine_id = '13270000-0000-4000-8000-000000000077'
			and w.source_kind = 'company-file' and w.payload ? 'folded'
			and w.routine_version = 1
			and w.payload -> 'folded' @> jsonb_build_array(jsonb_build_object('seq', 1::bigint))
	$q$);
	perform pg_temp.t1327_ok(v_plan #>> '{scan,Index Cond}' ~ '\(payload -> ''folded''::text\) @> ',
		'H5b folded wake check did not use partial GIN index: ' || v_plan::text);

	v_plan := qorpera_test_support.plan_with_index_alone('public.qorpera_folder_upload_intent_objects_hash', $q$
		with pruned_hashes as (
			select '13270000-0000-4000-8000-000000000010'::uuid as profile_id, repeat('a', 64) as sha256
		)
		select o.intent_id from pruned_hashes ph
		join public.qorpera_folder_upload_intent_objects o
			on o.profile_id = ph.profile_id and o.sha256 = ph.sha256
	$q$);
	perform pg_temp.t1327_ok(v_plan #>> '{scan,Index Cond}' ~ '\(profile_id = .* AND \(sha256 = ',
		'H6 pruned_hashes join did not use intent objects hash index: ' || v_plan::text);
end $$;
rollback;

-- WHY: Prove M4 single-pass bytea seal accepts multi-chunk + empty files and rejects mismatches.
do $$
declare
	v_auth uuid := '13270000-0000-4000-8000-0000000000a1';
	v_secret uuid := '13270000-0000-4000-8000-0000000000a2';
	v_lease uuid := '13270000-0000-4000-8000-0000000000a3';
	v_ok_letter uuid := '13270000-0000-4000-8000-0000000000a4';
	v_bad_letter uuid := '13270000-0000-4000-8000-0000000000a5';
	v_msg1 uuid := '13270000-0000-4000-8000-0000000000a6';
	v_msg2 uuid := '13270000-0000-4000-8000-0000000000a7';
	v_body bytea := convert_to('hello-world-chunked', 'UTF8');
	v_res jsonb;
	v_caught boolean := false;
begin
	insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
	values (v_auth, '13270000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-1327', repeat('1', 64));
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		connector_id, secret_name, purpose, current_version, created_by_user_id, account_label)
	values (v_secret, '13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020', v_auth, 'company',
		'digital_post', 'primary', 'Digital Post', 1, '13270000-0000-4000-8000-000000000001', '1327-dp');
	insert into public.qorpera_digital_post_syncs(profile_id, environment_id, secret_id, secret_version,
		status, due_at, lease_id, lease_until)
	values ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020', v_secret, 1,
		'waiting', clock_timestamp(), v_lease, clock_timestamp() + interval '5 minutes')
	on conflict (profile_id) do update set secret_id = v_secret, secret_version = 1, status = 'waiting',
		due_at = clock_timestamp(), lease_id = v_lease, lease_until = clock_timestamp() + interval '5 minutes';

	insert into public.qorpera_digital_post_letters(id, profile_id, environment_id, message_uuid, memo_id, status, folder,
		summary, files, bytes, received_at)
	values (v_ok_letter, '13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020', v_msg1,
		extensions.gen_random_uuid(), 'staging', 'digital-post/2026/2026-10-22 A (' || v_msg1 || ')',
		jsonb_build_object('messageUuid', v_msg1, 'folder', 'digital-post/2026/2026-10-22 A (' || v_msg1 || ')',
			'title', 'T', 'sender', 'S', 'senderId', '1', 'created', '2026-10-21T00:00:00Z',
			'received', '2026-10-21T00:00:00Z', 'mandatory', false, 'legalNotification', false,
			'replyBy', null, 'caseId', null, 'files', 1, 'text', false, 'snippet', ''),
		jsonb_build_array(
			jsonb_build_object('name', 'part.bin', 'mediaType', 'application/octet-stream',
				'bytes', octet_length(v_body), 'sha256', encode(sha256(v_body), 'hex')),
			jsonb_build_object('name', 'empty.txt', 'mediaType', 'text/plain',
				'bytes', 0, 'sha256', encode(sha256(''::bytea), 'hex'))),
		octet_length(v_body), clock_timestamp());
	insert into public.qorpera_digital_post_chunks(letter_id, file_index, chunk_index, content) values
		(v_ok_letter, 0, 0, convert_to('hello-world-', 'UTF8')),
		(v_ok_letter, 0, 1, convert_to('chunked', 'UTF8'));

	insert into public.qorpera_digital_post_letters(id, profile_id, environment_id, message_uuid, memo_id, status, folder,
		summary, files, bytes, received_at)
	values (v_bad_letter, '13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020', v_msg2,
		extensions.gen_random_uuid(), 'staging', 'digital-post/2026/2026-10-22 B (' || v_msg2 || ')',
		jsonb_build_object('messageUuid', v_msg2, 'folder', 'digital-post/2026/2026-10-22 B (' || v_msg2 || ')',
			'title', 'T', 'sender', 'S', 'senderId', '1', 'created', '2026-10-21T00:00:00Z',
			'received', '2026-10-21T00:00:00Z', 'mandatory', false, 'legalNotification', false,
			'replyBy', null, 'caseId', null, 'files', 1, 'text', false, 'snippet', ''),
		jsonb_build_array(
			jsonb_build_object('name', 'letter.md', 'mediaType', 'text/markdown',
				'bytes', 5, 'sha256', repeat('0', 64)),
			jsonb_build_object('name', 'letter.json', 'mediaType', 'application/json',
				'bytes', 0, 'sha256', encode(sha256(''::bytea), 'hex'))),
		5, clock_timestamp());
	insert into public.qorpera_digital_post_chunks(letter_id, file_index, chunk_index, content) values
		(v_bad_letter, 0, 0, convert_to('12345', 'UTF8'));

	set local session authorization qorpera_secret_broker;
	v_res := public.qorpera_seal_digital_post_letter(v_auth, repeat('1', 64), v_secret, 1, v_lease, v_ok_letter);
	perform pg_temp.t1327_ok(v_res ->> 'state' = 'kept', format('M4 multi-chunk + empty seal failed: %s', v_res));
	begin
		perform public.qorpera_seal_digital_post_letter(v_auth, repeat('1', 64), v_secret, 1, v_lease, v_bad_letter);
	exception when sqlstate '22023' then
		v_caught := true;
	end;
	reset session authorization;
	perform pg_temp.t1327_ok(v_caught, 'M4 corrupted digest was not rejected with 22023');

	delete from public.qorpera_digital_post_letters where id in (v_ok_letter, v_bad_letter);
end $$;

-- WHY: Prove C4 anti-starvation (25 older leased-company letters cannot starve company B) and
-- non-blocking pg_try_advisory_xact_lock via dblink.
do $$
declare
	v_i integer;
	v_msg uuid;
	v_b_letter uuid := '13270000-0000-4000-8000-0000000000b9';
	v_a_first uuid;
	v_claim jsonb;
	v_empty_files jsonb := jsonb_build_array(
		jsonb_build_object('name', 'letter.md', 'mediaType', 'text/markdown', 'bytes', 0, 'sha256', encode(sha256(''::bytea), 'hex')),
		jsonb_build_object('name', 'letter.json', 'mediaType', 'application/json', 'bytes', 0, 'sha256', encode(sha256(''::bytea), 'hex')));
begin
	for v_i in 1..25 loop
		v_msg := extensions.gen_random_uuid();
		insert into public.qorpera_digital_post_letters(profile_id, environment_id, message_uuid, memo_id, status, folder,
			summary, files, bytes, received_at, kept_at, write_lease_owner, write_lease_until)
		values ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020', v_msg,
			extensions.gen_random_uuid(), 'kept', 'digital-post/2026/2026-10-22 A' || v_i || ' (' || v_msg || ')',
			jsonb_build_object('messageUuid', v_msg, 'folder', 'digital-post/2026/2026-10-22 A' || v_i || ' (' || v_msg || ')',
				'title', 'A', 'sender', 'S', 'senderId', '1', 'created', '2026-10-21T00:00:00Z',
				'received', '2026-10-21T00:00:00Z', 'mandatory', false, 'legalNotification', false,
				'replyBy', null, 'caseId', null, 'files', 0, 'text', false, 'snippet', ''),
			v_empty_files, 0,
			'2020-01-01 00:00:00+00'::timestamptz + make_interval(secs => v_i),
			'2020-01-01 00:00:00+00'::timestamptz + make_interval(secs => v_i),
			case when v_i = 1 then '13270000-0000-4000-8000-0000000000f1'::uuid end,
			case when v_i = 1 then clock_timestamp() + interval '5 minutes' end)
		returning id into v_a_first;
	end loop;

	v_msg := extensions.gen_random_uuid();
	insert into public.qorpera_digital_post_letters(id, profile_id, environment_id, message_uuid, memo_id, status, folder,
		summary, files, bytes, received_at, kept_at)
	values (v_b_letter, '13270000-0000-4000-8000-000000000011', '13270000-0000-4000-8000-000000000021', v_msg,
		extensions.gen_random_uuid(), 'kept', 'digital-post/2026/2026-10-22 B (' || v_msg || ')',
		jsonb_build_object('messageUuid', v_msg, 'folder', 'digital-post/2026/2026-10-22 B (' || v_msg || ')',
			'title', 'B', 'sender', 'S', 'senderId', '1', 'created', '2026-10-21T00:00:00Z',
			'received', '2026-10-21T00:00:00Z', 'mandatory', false, 'legalNotification', false,
			'replyBy', null, 'caseId', null, 'files', 0, 'text', false, 'snippet', ''),
		v_empty_files, 0, '2020-01-02 00:00:00+00'::timestamptz, '2020-01-02 00:00:00+00'::timestamptz);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_claim := public.qorpera_claim_digital_post_letter_file('13270000-0000-4000-8000-0000000000f2', 60);
	perform pg_temp.t1327_ok(v_claim ->> 'letterId' = v_b_letter::text,
		format('C4 starved company B behind 25 older letters of leased company A: %s', v_claim));

	update public.qorpera_digital_post_letters
	set write_lease_owner = null, write_lease_until = null
	where profile_id in ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000011');
end $$;

select dblink_connect('t1327_c4', 'dbname=' || current_database());
select dblink_connect('t1327_c6', 'dbname=' || current_database());
select dblink_connect('t1327_h7_1', 'dbname=' || current_database());
select dblink_connect('t1327_h7_2', 'dbname=' || current_database());

do $$
declare
	v_claim jsonb;
	v_exp jsonb;
	v_site_id uuid;
	v_dom1 uuid := '13270000-0000-4000-8000-0000000000d1';
	v_dom2 uuid := '13270000-0000-4000-8000-0000000000d2';
	v_swap jsonb;
	v_got boolean := false;
begin
	-- WHY: C4 dblink test: session holds advisory lock on older company A; claim must skip A immediately and claim B.
	perform dblink_exec('t1327_c4', 'begin');
	perform dblink_exec('t1327_c4',
		$q$do $x$ begin perform pg_advisory_xact_lock(hashtextextended('qorpera.digital-post-write:13270000-0000-4000-8000-000000000010', 0)); end $x$ $q$);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_claim := public.qorpera_claim_digital_post_letter_file('13270000-0000-4000-8000-0000000000f3', 60);
	perform dblink_exec('t1327_c4', 'rollback');
	perform pg_temp.t1327_ok(v_claim ->> 'letterId' = '13270000-0000-4000-8000-0000000000b9',
		format('C4 blocked or failed to skip advisory-locked company A: %s', v_claim));

	-- WHY: C6 dblink test: session holds git expiry cursor FOR UPDATE; expire must return busy=true without waiting.
	perform dblink_exec('t1327_c6', 'begin');
	perform dblink_exec('t1327_c6',
		$q$do $x$ begin perform 1 from public.qorpera_folder_git_expiry for update; end $x$ $q$);
	v_exp := public.qorpera_folder_git_versions_expire(10);
	perform dblink_exec('t1327_c6', 'rollback');
	perform pg_temp.t1327_ok(
		v_exp = jsonb_build_object('schema', 'qorpera.folder-git-expiry/v1', 'scanned', 0, 'expired', 0, 'queued', 0, 'busy', true),
		format('C6 git expire did not skip locked cursor: %s', v_exp));

	-- WHY: H7 dblink test: holding parent site FOR NO KEY UPDATE blocks set_primary BEFORE it touches child domain D2.
	insert into public.qorpera_company_sites(profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000020',
		'rpc-1327-site', 'RPC 1327 Site', 'sites/rpc1327', '13270000-0000-4000-8000-0000000000c1')
	returning id into v_site_id;
	insert into public.qorpera_company_site_domains(id, site_id, profile_id, hostname, is_apex, is_primary, status, verification_token)
	values
		(v_dom1, v_site_id, '13270000-0000-4000-8000-000000000010', 'primary1327.example.test', true, true, 'dns_verified', repeat('a', 32)),
		(v_dom2, v_site_id, '13270000-0000-4000-8000-000000000010', 'www.primary1327.example.test', false, false, 'dns_verified', repeat('b', 32));
end $$;

do $$
declare
	v_site_id uuid := (select id from public.qorpera_company_sites where slug = 'rpc-1327-site');
	v_dom1 uuid := '13270000-0000-4000-8000-0000000000d1';
	v_dom2 uuid := '13270000-0000-4000-8000-0000000000d2';
	v_swap jsonb;
begin
	perform dblink_exec('t1327_h7_1', 'begin');
	perform dblink_exec('t1327_h7_1',
		format($q$do $x$ begin perform 1 from public.qorpera_company_sites where id = %L for no key update; end $x$ $q$, v_site_id));

	perform dblink_exec('t1327_h7_2',
		$q$set request.jwt.claims = '{"role":"authenticated","sub":"13270000-0000-4000-8000-000000000001"}'$q$);
	perform dblink_send_query('t1327_h7_2',
		format('select public.qorpera_set_primary_site_domain(%L)', v_dom2));
	perform pg_sleep(0.15);

	perform pg_temp.t1327_ok(dblink_is_busy('t1327_h7_2') = 1,
		'H7 set_primary_site_domain did not wait for parent site lock');
	-- WHY: Checking D2 is unlocked via h7_1 proves parent-before-child lock order and releases D2 on h7_1 commit.
	perform dblink_exec('t1327_h7_1',
		format($q$do $x$ begin perform 1 from public.qorpera_company_site_domains where id = %L for update nowait; end $x$ $q$, v_dom2));

	perform dblink_exec('t1327_h7_1', 'commit');
	select r into v_swap from dblink_get_result('t1327_h7_2') as t(r jsonb);
	perform * from dblink_get_result('t1327_h7_2') as t(r text);
	perform pg_temp.t1327_ok(v_swap ->> 'id' = v_dom2::text,
		format('H7 set_primary_site_domain did not complete after site release: %s', v_swap));
	perform pg_temp.t1327_ok(
		(select is_primary from public.qorpera_company_site_domains where id = v_dom2)
		and not (select is_primary from public.qorpera_company_site_domains where id = v_dom1),
		'H7 primary flag swap did not converge');
end $$;

-- WHY: Prove C6 atomicity when a company profile row is held FOR UPDATE during git expiry: the 2s
-- lock_timeout rolls back the entire tick (cursor + version rows intact), and the next tick queues GC.
do $$
declare
	v_profile uuid := '13270000-0000-4000-8000-000000000010';
	v_env uuid := '13270000-0000-4000-8000-000000000020';
	v_commit uuid := '13270000-0000-4000-8000-0000000000c9';
	v_write_ver uuid := '13270000-0000-4000-8000-0000000000e1';
	v_del_ver uuid := '13270000-0000-4000-8000-0000000000e2';
	v_sha text := repeat('c', 64);
	v_path text := 'code/acme/app/repo.git/objects/ab/' || repeat('c', 38);
	v_key bytea := extensions.digest(public.qorpera_folder_key(v_path), 'sha256');
	v_prev_at timestamptz;
	v_prev_ver uuid;
	v_write_at timestamptz;
	v_del_at timestamptz;
begin
	perform pg_sleep(0.01);
	select after_at, after_version into v_prev_at, v_prev_ver from public.qorpera_folder_git_expiry;
	v_write_at := greatest(v_prev_at + interval '1 millisecond', clock_timestamp() - interval '7 days 2 seconds');
	v_del_at := v_write_at + interval '1 millisecond';
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes) values (v_profile, v_sha, 12);
	insert into public.qorpera_folder_commits(id, environment_id, seq, operation_key, actor_kind, units)
	values (v_commit, v_env, 9001, 't1327-git-expiry-lock-test', 'platform', '[]'::jsonb);
	insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version,
		op, kind, commit_id, unit_no, manifest_sha256, created_at)
	values
		(v_write_ver, v_env, v_path, v_key, null, 'write', 'file', v_commit, 1, v_sha, v_write_at),
		(v_del_ver, v_env, v_path, v_key, v_write_ver, 'delete', 'file', v_commit, 2, null, v_del_at);
end $$;

do $$
declare
	v_profile uuid := '13270000-0000-4000-8000-000000000010';
	v_write_ver uuid := '13270000-0000-4000-8000-0000000000e1';
	v_del_ver uuid := '13270000-0000-4000-8000-0000000000e2';
	v_sha text := repeat('c', 64);
	v_before_at timestamptz;
	v_before_ver uuid;
	v_after_at timestamptz;
	v_after_ver uuid;
	v_timed_out boolean := false;
	v_exp jsonb;
begin
	select after_at, after_version into v_before_at, v_before_ver from public.qorpera_folder_git_expiry;
	perform dblink_exec('t1327_c6', 'begin');
	perform dblink_exec('t1327_c6',
		format($q$do $x$ begin perform 1 from public.qorpera_profiles where id = %L for update; end $x$ $q$, v_profile));
	begin
		perform public.qorpera_folder_git_versions_expire(100);
	exception when lock_not_available then
		v_timed_out := true;
	end;
	perform dblink_exec('t1327_c6', 'rollback');

	select after_at, after_version into v_after_at, v_after_ver from public.qorpera_folder_git_expiry;
	perform pg_temp.t1327_ok(v_timed_out,
		'C6 git expire did not abort on 2s lock_timeout while profile row was locked FOR UPDATE');
	perform pg_temp.t1327_ok(v_after_at = v_before_at and v_after_ver = v_before_ver,
		format('C6 cursor advanced despite profile lock rollback: %s/%s vs %s/%s', v_after_at, v_after_ver, v_before_at, v_before_ver));
	perform pg_temp.t1327_ok(
		(select count(*) from public.qorpera_folder_path_versions where version in (v_write_ver, v_del_ver)) = 2,
		'C6 path versions were deleted without queueing GC during profile lock');

	v_exp := public.qorpera_folder_git_versions_expire(100);
	perform pg_temp.t1327_ok((v_exp ->> 'expired')::integer >= 2 and (v_exp ->> 'queued')::integer >= 1,
		format('C6 retry after profile lock release did not expire and queue GC: %s', v_exp));
	perform pg_temp.t1327_ok(
		exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_sha),
		'C6 retry did not write qorpera_folder_object_gc row');

	-- WHY: Restore cursor so subsequent tests in the shared hosted-db run see their aged git versions.
	update public.qorpera_folder_git_expiry set after_at = v_before_at, after_version = v_before_ver;
end $$;

select dblink_disconnect(name) from unnest(array['t1327_c4', 't1327_c6', 't1327_h7_1', 't1327_h7_2']) as name;

-- WHY: Clean up all committed fixture rows so shared test-suite database stays spotless.
delete from public.qorpera_folder_path_versions
where version in ('13270000-0000-4000-8000-0000000000e1', '13270000-0000-4000-8000-0000000000e2');
delete from public.qorpera_folder_object_gc
where profile_id = '13270000-0000-4000-8000-000000000010' and sha256 = repeat('c', 64);
delete from public.qorpera_profile_objects
where profile_id = '13270000-0000-4000-8000-000000000010' and sha256 = repeat('c', 64);
delete from public.qorpera_folder_commits where id = '13270000-0000-4000-8000-0000000000c9';
delete from public.qorpera_digital_post_letters
where profile_id in ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000011');
delete from public.qorpera_company_sites where slug = 'rpc-1327-site';
delete from public.qorpera_profiles
where id in ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000011');
delete from auth.users where id = '13270000-0000-4000-8000-000000000001';

do $$
begin
	perform pg_temp.t1327_ok(
		not exists (select 1 from public.qorpera_profiles where id in ('13270000-0000-4000-8000-000000000010', '13270000-0000-4000-8000-000000000011'))
		and not exists (select 1 from auth.users where id = '13270000-0000-4000-8000-000000000001'),
		'1327 committed fixture cleanup left rows behind');
end $$;

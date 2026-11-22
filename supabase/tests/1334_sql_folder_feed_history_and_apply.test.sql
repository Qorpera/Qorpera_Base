-- WHY: Regression and generic-plan proofs for 20260930852000_sql_folder_feed_history_and_apply.sql.

create function pg_temp.t1334_ok(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception '1334 failed: %', p_msg;
	end if;
end $$;

create function pg_temp.t1334_stage(p_env uuid, p_text text) returns jsonb language plpgsql as $$
declare
	v_manifest text := format(
		'{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
		octet_length(convert_to(p_text, 'utf8')),
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
		octet_length(convert_to(p_text, 'utf8'))
	);
	v_open jsonb := public.qorpera_folder_open_upload(p_env, '{"kind":"platform"}'::jsonb, v_manifest);
	v_obj jsonb;
	v_seal jsonb;
begin
	for v_obj in
		select c from jsonb_array_elements(v_manifest::jsonb -> 'chunks') c
		union all
		select jsonb_build_object(
			'sha256', encode(extensions.digest(convert_to(v_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(v_manifest, 'utf8'))
		)
	loop
		if not (v_open -> 'present') ? (v_obj ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(
				p_env, '{"kind":"platform"}'::jsonb, (v_open ->> 'intentId')::uuid,
				v_obj ->> 'sha256', (v_obj ->> 'bytes')::bigint
			);
		end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload(p_env, '{"kind":"platform"}'::jsonb, (v_open ->> 'intentId')::uuid);
	perform pg_temp.t1334_ok(v_seal ->> 'state' = 'sealed', 'stage failed: ' || v_seal::text);
	return v_seal -> 'file';
end $$;

-- WHY: Verify patched function markers, privileges, and absence of generic-plan-defeating LIKE calls.
do $$
declare
	v_role text;
	v_def text;
begin
	v_def := pg_get_functiondef('public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)'::regprocedure);
	perform pg_temp.t1334_ok(position('20260930380000' in v_def) > 0, 'qorpera_folder_feed lost LK1 marker');
	perform pg_temp.t1334_ok(position('qorpera_folder_paths_authority' in v_def) > 0, 'qorpera_folder_feed missing set-based authority');
	perform pg_temp.t1334_ok(position('qorpera_folder_actor_allowed' in v_def) = 0, 'qorpera_folder_feed kept per-row authority');

	v_def := pg_get_functiondef('public.qorpera_member_folder_history(uuid,bigint,integer)'::regprocedure);
	perform pg_temp.t1334_ok(position('20260930013200' in v_def) > 0, 'qorpera_member_folder_history lost P33 marker');
	perform pg_temp.t1334_ok(position('20260930446400' in v_def) > 0, 'qorpera_member_folder_history lost S5b marker');
	perform pg_temp.t1334_ok(position('qorpera_folder_paths_authority' in v_def) > 0, 'qorpera_member_folder_history missing set-based authority');
	perform pg_temp.t1334_ok(position('qorpera_folder_actor_allowed' in v_def) = 0, 'qorpera_member_folder_history kept per-row authority');

	v_def := pg_get_functiondef('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure);
	perform pg_temp.t1334_ok(position('20260930380000' in v_def) > 0, 'qorpera_folder_apply_unit lost LK1 marker');
	perform pg_temp.t1334_ok(position('qorpera_folder_under' in v_def) = 0, 'qorpera_folder_apply_unit kept LIKE qorpera_folder_under');

	v_def := pg_get_functiondef('public.qorpera_folder_actor_subtree_allowed(uuid,uuid,jsonb,text,text,text)'::regprocedure);
	perform pg_temp.t1334_ok(position('qorpera_folder_under' in v_def) = 0, 'qorpera_folder_actor_subtree_allowed kept LIKE qorpera_folder_under');

	v_def := pg_get_functiondef('public.qorpera_folder_git_unit_refusal(uuid,jsonb,text,text,text,uuid)'::regprocedure);
	perform pg_temp.t1334_ok(position('20260930720000' in v_def) > 0, 'qorpera_folder_git_unit_refusal lost code_record marker');
	perform pg_temp.t1334_ok(position('qorpera_folder_under' in v_def) = 0, 'qorpera_folder_git_unit_refusal kept LIKE qorpera_folder_under');

	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
		perform pg_temp.t1334_ok(
			has_function_privilege(v_role, 'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)', 'EXECUTE') = (v_role = 'service_role'),
			'qorpera_folder_feed grant mismatch for ' || v_role);
		perform pg_temp.t1334_ok(
			has_function_privilege(v_role, 'public.qorpera_member_folder_history(uuid,bigint,integer)', 'EXECUTE') = (v_role in ('authenticated', 'service_role')),
			'qorpera_member_folder_history grant mismatch for ' || v_role);
		perform pg_temp.t1334_ok(
			has_function_privilege(v_role, 'public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)', 'EXECUTE') = false,
			'qorpera_folder_apply_unit should not be executable by ' || v_role);
	end loop;
end $$;

-- WHY: Verify feed, member history, delete/move/copy with sibling edge names, subtree authority, git rules, and generic plans.
begin;
do $$
declare
	v_owner uuid := '13340000-0000-4000-8000-000000000001';
	v_member uuid := '13340000-0000-4000-8000-000000000002';
	v_profile uuid := '13340000-0000-4000-8000-000000000010';
	v_env uuid := '13340000-0000-4000-8000-000000000020';
	v_file jsonb;
	v_res jsonb;
	v_feed jsonb;
	v_history jsonb;
	v_ver_secret uuid;
	v_ver_dir uuid;
	v_ver_file uuid;
	v_ver_copy uuid;
	v_plan text := '';
	v_line text;
	v_move_change jsonb;
	v_item jsonb;
	v_refusal text;
begin
	insert into auth.users(id, email) values
		(v_owner, 'owner-1334@example.test'),
		(v_member, 'member-1334@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id)
		values (v_profile, 'Folder Perf 1334', v_owner);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		(v_profile, v_owner, 'owner-1334@example.test', 'Owner', 'owner'),
		(v_profile, v_member, 'member-1334@example.test', 'Member', 'contributor');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
		values (v_env, v_profile, 'Main', 1, v_owner);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable(v_env);

	-- WHY: Create a member-unreadable subtree under secret/ and readable shared/ to test feed move_in priorVersion redaction and history filtering.
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy, created_by_user_id)
		values (v_env, 'secret', 'subtree', 'member_private', v_owner, 'normal', v_owner);

	v_file := pg_temp.t1334_stage(v_env, 'folder-perf-1334');

	-- WHY: Include sibling paths with ASCII chars below '/' ('-', '.') and LIKE wildcard '_' to verify exact C-collated subtree bounds.
	v_res := public.qorpera_folder_commit(v_env, '{"kind":"platform"}'::jsonb, 'op-1334-setup', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'shared'),
		jsonb_build_object('op', 'mkdir', 'path', 'secret'),
		jsonb_build_object('op', 'mkdir', 'path', 'dir_100'),
		jsonb_build_object('op', 'mkdir', 'path', 'dir_100-sibling'),
		jsonb_build_object('op', 'mkdir', 'path', 'dir_100.dot'),
		jsonb_build_object('op', 'mkdir', 'path', 'code'),
		jsonb_build_object('op', 'mkdir', 'path', 'code/acme'),
		jsonb_build_object('op', 'mkdir', 'path', 'code/acme/app'),
		jsonb_build_object('op', 'mkdir', 'path', 'code/acme/app/repo.git'),
		jsonb_build_object('op', 'mkdir', 'path', 'code/acme/app/repo.git/objects'),
		jsonb_build_object('op', 'mkdir', 'path', 'code/acme/app/repo.git/objects/ab'),
		jsonb_build_object('op', 'write', 'path', 'dir_100/child.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'dir_100-sibling/keep.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'dir_100.dot/keep.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'secret/hidden.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'shared/visible.txt', 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'code/acme/app/repo.git/objects/ab/' || repeat('1', 38), 'file', v_file),
		jsonb_build_object('op', 'write', 'path', 'code/acme/app/repo.git/objects/ab/' || repeat('2', 38), 'file', v_file)
	));
	perform pg_temp.t1334_ok(not exists (
		select 1 from jsonb_array_elements(v_res -> 'units') o where o ->> 'outcome' <> 'saved'
	), 'setup commit had non-saved outcome: ' || v_res::text);

	select version into v_ver_secret from public.qorpera_folder_entries
		where environment_id = v_env and key_text = 'secret/hidden.txt';

	-- WHY: Move secret/hidden.txt into shared/revealed.txt; member feed must include move_in without unreadable priorVersion while owner keeps priorVersion.
	v_res := public.qorpera_folder_commit(v_env, '{"kind":"platform"}'::jsonb, 'op-1334-move-reveal', jsonb_build_array(
		jsonb_build_object('op', 'move', 'from', 'secret/hidden.txt', 'to', 'shared/revealed.txt', 'expectedVersion', v_ver_secret)
	));
	perform pg_temp.t1334_ok((v_res -> 'units' -> 0 ->> 'outcome') = 'saved', 'move-reveal failed: ' || v_res::text);

	v_feed := public.qorpera_folder_feed(v_env, jsonb_build_object('kind', 'member', 'userId', v_member), 0, 100, null);
	select c into v_move_change
	from jsonb_array_elements(v_feed -> 'events') ev, jsonb_array_elements(ev -> 'changes') c
	where c ->> 'path' = 'shared/revealed.txt' and c ->> 'op' = 'move_in';
	perform pg_temp.t1334_ok(v_move_change is not null, 'member feed missing shared/revealed.txt move_in');
	perform pg_temp.t1334_ok(not (v_move_change ? 'priorVersion'), 'member feed leaked unreadable priorVersion: ' || v_move_change::text);
	perform pg_temp.t1334_ok(not exists (
		select 1 from jsonb_array_elements(v_feed -> 'events') ev, jsonb_array_elements(ev -> 'changes') c
		where c ->> 'path' like 'secret%'
	), 'member feed leaked secret/ path');

	v_feed := public.qorpera_folder_feed(v_env, jsonb_build_object('kind', 'member', 'userId', v_owner), 0, 100, null);
	select c into v_move_change
	from jsonb_array_elements(v_feed -> 'events') ev, jsonb_array_elements(ev -> 'changes') c
	where c ->> 'path' = 'shared/revealed.txt' and c ->> 'op' = 'move_in';
	perform pg_temp.t1334_ok((v_move_change ->> 'priorVersion')::uuid = v_ver_secret, 'owner feed missing priorVersion');

	-- WHY: Verify qorpera_member_folder_history filters unreadable paths and collapses repo.git entries under set-based authority.
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_member)::text, true);
	v_history := public.qorpera_member_folder_history(v_env, null, 20);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform pg_temp.t1334_ok(not exists (
		select 1 from jsonb_array_elements(v_history -> 'items') it, jsonb_array_elements(it -> 'paths') p
		where p ->> 'path' like 'secret%'
	), 'member history leaked secret/ path: ' || v_history::text);
	select it into v_item from jsonb_array_elements(v_history -> 'items') it
		where exists (select 1 from jsonb_array_elements(it -> 'paths') p where p ->> 'path' = 'code/acme/app/repo.git');
	perform pg_temp.t1334_ok(v_item is not null, 'member history missing collapsed repo.git entry');
	perform pg_temp.t1334_ok((
		select count(*) from jsonb_array_elements(v_item -> 'paths') p where p ->> 'path' = 'code/acme/app/repo.git'
	) = 1, 'member history did not collapse repo.git entries to one line');

	-- WHY: Verify copy, subtree authority, git unit refusal, and single-pass delete keep exact C-collated subtree bounds.
	select version into v_ver_dir from public.qorpera_folder_entries where environment_id = v_env and key_text = 'dir_100';
	v_res := public.qorpera_folder_commit(v_env, '{"kind":"platform"}'::jsonb, 'op-1334-copy', jsonb_build_array(
		jsonb_build_object('op', 'copy', 'from', 'dir_100', 'to', 'shared/copied', 'expectedVersion', v_ver_dir)
	));
	perform pg_temp.t1334_ok((v_res -> 'units' -> 0 ->> 'outcome') = 'saved', 'copy commit failed: ' || v_res::text);
	perform pg_temp.t1334_ok(exists (
		select 1 from public.qorpera_folder_entries where environment_id = v_env and key_text = 'shared/copied/child.txt'
	), 'copied child missing');
	perform pg_temp.t1334_ok(not exists (
		select 1 from public.qorpera_folder_entries where environment_id = v_env and key_text like 'shared/copied%sibling%'
	), 'copy matched sibling directory outside subtree');

	perform pg_temp.t1334_ok(
		public.qorpera_folder_actor_subtree_allowed(v_env, v_profile, jsonb_build_object('kind', 'member', 'userId', v_member), 'shared/copied', 'shared/copied', 'read'),
		'member should read shared/copied subtree'
	);
	perform pg_temp.t1334_ok(
		not public.qorpera_folder_actor_subtree_allowed(v_env, v_profile, jsonb_build_object('kind', 'member', 'userId', v_member), 'secret', 'secret', 'read'),
		'member should not read secret subtree'
	);

	v_refusal := public.qorpera_folder_git_unit_refusal(
		v_env, jsonb_build_object('op', 'delete', 'path', 'code/acme/app/repo.git/objects'),
		'code/acme/app/repo.git/objects', null, 'session', null
	);
	perform pg_temp.t1334_ok(v_refusal = 'git_object_delete', 'git_unit_refusal expected git_object_delete, got: ' || coalesce(v_refusal, 'null'));

	select version into v_ver_file from public.qorpera_folder_entries where environment_id = v_env and key_text = 'shared/visible.txt';
	select version into v_ver_copy from public.qorpera_folder_entries where environment_id = v_env and key_text = 'shared/copied';
	v_res := public.qorpera_folder_commit(v_env, '{"kind":"platform"}'::jsonb, 'op-1334-delete', jsonb_build_array(
		jsonb_build_object('op', 'delete', 'path', 'dir_100', 'expectedVersion', v_ver_dir, 'asOfSeq', (v_res ->> 'seq')::bigint),
		jsonb_build_object('op', 'delete', 'path', 'shared/visible.txt', 'expectedVersion', v_ver_file),
		jsonb_build_object('op', 'delete', 'path', 'shared/copied', 'expectedVersion', v_ver_copy, 'asOfSeq', (v_res ->> 'seq')::bigint)
	));
	perform pg_temp.t1334_ok(not exists (
		select 1 from jsonb_array_elements(v_res -> 'units') o where o ->> 'outcome' <> 'saved'
	), 'delete commit had non-saved outcome: ' || v_res::text);
	perform pg_temp.t1334_ok(not exists (
		select 1 from public.qorpera_folder_entries where environment_id = v_env and key_text in ('dir_100', 'dir_100/child.txt', 'shared/visible.txt', 'shared/copied', 'shared/copied/child.txt')
	), 'deleted entries still live');
	perform pg_temp.t1334_ok((
		select count(*) from public.qorpera_folder_entries
		where environment_id = v_env and key_text in ('dir_100-sibling', 'dir_100-sibling/keep.txt', 'dir_100.dot', 'dir_100.dot/keep.txt')
	) = 4, 'sibling entries with ASCII < / were mistakenly deleted');
	perform pg_temp.t1334_ok((
		select count(*) from public.qorpera_folder_path_versions
		where environment_id = v_env and op = 'delete' and path in ('dir_100', 'dir_100/child.txt', 'shared/visible.txt')
	) = 3, 'delete did not log all 3 delete path versions');

	-- WHY: Verify generic plan on parameterized C-collated range scan uses qorpera_folder_entries_key_text instead of seqscan.
	set local session_replication_role = replica;
	insert into public.qorpera_folder_entries(environment_id, path, kind)
	select v_env, 'bulk-' || g || '/item.txt', 'claim'
	from generate_series(1, 200) g;
	analyze public.qorpera_folder_entries;
	set local enable_seqscan = off;
	set local plan_cache_mode = force_generic_plan;
	prepare t1334_subtree_plan(uuid, text) as
		select e.key_text from public.qorpera_folder_entries e
		where e.environment_id = $1 and e.kind <> 'claim'
			and e.key_text >= ($2 || '/') collate "C" and e.key_text < ($2 || '0') collate "C";
	for v_line in execute 'explain (costs off) execute t1334_subtree_plan(' || quote_literal(v_env) || ', ''shared'')' loop
		v_plan := v_plan || v_line || E'\n';
	end loop;
	deallocate t1334_subtree_plan;
	perform pg_temp.t1334_ok(position('qorpera_folder_entries_key_text' in v_plan) > 0,
		'generic plan did not use qorpera_folder_entries_key_text: ' || v_plan);
end $$;
rollback;

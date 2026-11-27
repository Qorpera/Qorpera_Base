begin;

create function pg_temp.cscp_fail_hot_gc()
returns trigger language plpgsql as $$
begin
	if new.sha256 = repeat('8', 64) then
		raise exception 'simulated lock timeout' using errcode = '55P03';
	end if;
	return new;
end $$;

do $$
declare
	v_user uuid := '00000000-0000-4000-8000-000000009281';
	v_profile uuid := '00000000-0000-4000-8000-000000009282';
	v_env uuid := '00000000-0000-4000-8000-000000009283';
	v_profile_v1 uuid := '00000000-0000-4000-8000-000000009288';
	v_env_v1 uuid := '00000000-0000-4000-8000-000000009289';
	v_graph_v1 uuid := '00000000-0000-4000-8000-00000000928a';
	v_profile2 uuid := '00000000-0000-4000-8000-00000000928b';
	v_env2 uuid := '00000000-0000-4000-8000-00000000928c';
	v_c1 uuid := '00000000-0000-4000-8000-000000009284';
	v_c2 uuid := '00000000-0000-4000-8000-000000009285';
	v_c3 uuid := '00000000-0000-4000-8000-000000009286';
	v_c4 uuid := '00000000-0000-4000-8000-000000009287';
	v_v1 uuid := '00000000-0000-4000-8000-000000009291';
	v_v2 uuid := '00000000-0000-4000-8000-000000009292';
	v_v3 uuid := '00000000-0000-4000-8000-000000009293';
	v_v4 uuid := '00000000-0000-4000-8000-000000009294';
	v_v5 uuid := '00000000-0000-4000-8000-000000009295';
	v_v6 uuid := '00000000-0000-4000-8000-000000009296';
	v_v7 uuid := '00000000-0000-4000-8000-000000009297';
	v_m_old_main text := repeat('1', 64);
	v_m_live_main text := repeat('2', 64);
	v_m_old_wt text := repeat('3', 64);
	v_m_held text := repeat('4', 64);
	v_m_recent text := repeat('5', 64);
	v_m_intent_unref text := repeat('6', 64);
	v_m_intent_live text := repeat('7', 64);
	v_m_hot text := repeat('8', 64);
	v_m_ok text := repeat('9', 64);
	v_m_v1_retained text := repeat('a', 64);
	v_m_v1_unretained text := repeat('b', 64);
	v_intent_1 uuid := '00000000-0000-4000-8000-000000009301';
	v_intent_2 uuid := '00000000-0000-4000-8000-000000009302';
	v_intent_fresh uuid := '00000000-0000-4000-8000-000000009303';
	v_intent_hot uuid := '00000000-0000-4000-8000-000000009304';
	v_intent_ok uuid := '00000000-0000-4000-8000-000000009305';
	v_main_path text := 'code/company/shop/main/src/app.ts';
	v_wt_path text := 'code/company/shop/worktrees/w1/index.ts';
	v_doc_path text := 'docs/copied.ts';
	v_recent_path text := 'code/company/shop/repo.git/worktrees/w1/index';
	v_res jsonb;
	v_file public.qorpera_company_files%rowtype;
	v_file_json jsonb;
	v_expected_bytes bigint;
	v_unreferenced_since timestamptz;
	v_t_older timestamptz := now() - interval '4 hours';
	v_t_newer timestamptz := now() - interval '2 hours';
	v_surface uuid := '00000000-0000-4000-8000-000000009310';
	v_surface_folder uuid := '00000000-0000-4000-8000-00000000931f';
	v_surface2 uuid := '00000000-0000-4000-8000-00000000931e';
	v_ss_ready uuid := '00000000-0000-4000-8000-000000009311';
	v_ss_young uuid := '00000000-0000-4000-8000-000000009312';
	v_ss_chat uuid := '00000000-0000-4000-8000-000000009313';
	v_ss_job uuid := '00000000-0000-4000-8000-000000009314';
	v_ss_disc_unarch uuid := '00000000-0000-4000-8000-000000009315';
	v_ss_disc_failed uuid := '00000000-0000-4000-8000-000000009316';
	v_ss_disc_done uuid := '00000000-0000-4000-8000-000000009317';
	v_ss_disc_clean uuid := '00000000-0000-4000-8000-000000009318';
	v_ss_disc_folder uuid := '00000000-0000-4000-8000-000000009319';
	v_ss_disc_other uuid := '00000000-0000-4000-8000-00000000931a';
	v_w_ready uuid := '00000000-0000-4000-8000-000000009321';
	v_w_young uuid := '00000000-0000-4000-8000-000000009322';
	v_w_chat uuid := '00000000-0000-4000-8000-000000009323';
	v_w_job uuid := '00000000-0000-4000-8000-000000009324';
	v_w_disc_unarch uuid := '00000000-0000-4000-8000-000000009325';
	v_w_disc_failed uuid := '00000000-0000-4000-8000-000000009326';
	v_w_disc_done uuid := '00000000-0000-4000-8000-000000009327';
	v_w_disc_clean uuid := '00000000-0000-4000-8000-000000009328';
	v_w_disc_folder uuid := '00000000-0000-4000-8000-000000009329';
	v_w_disc_other uuid := '00000000-0000-4000-8000-00000000932a';
	v_agent uuid := '00000000-0000-4000-8000-000000009330';
	v_agent2 uuid := '00000000-0000-4000-8000-000000009331';
	v_token uuid;
	v_retire uuid[];
	v_backfilled integer;
	v_role text;
	v_fn text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_fn in array array[
			'public.qorpera_folder_sweep_upload_intents_cron(integer)',
			'public.qorpera_schedule_folder_intent_sweep()',
			'public.qorpera_code_checkout_path(text)',
			'public.qorpera_code_checkout_version_held(uuid,text)',
			'public.qorpera_code_checkout_prune(integer)',
			'public.qorpera_schedule_code_checkout_prune()',
			'public.qorpera_surface_backfill_discarded_cleanups()'
		] loop
			if has_function_privilege(v_role, v_fn, 'execute') then
				raise exception 'role % unexpectedly has execute on %', v_role, v_fn;
			end if;
		end loop;
		if has_table_privilege(v_role, 'public.qorpera_code_checkout_prune_cursor', 'select')
			or has_table_privilege(v_role, 'public.qorpera_code_checkout_prune_held', 'select') then
			raise exception 'role % unexpectedly has select on code checkout prune tables', v_role;
		end if;
	end loop;

	if not (select relrowsecurity from pg_class where oid = 'public.qorpera_code_checkout_prune_cursor'::regclass)
		or not (select relrowsecurity from pg_class where oid = 'public.qorpera_code_checkout_prune_held'::regclass) then
		raise exception 'RLS must be enabled on code checkout prune tables';
	end if;

	if not public.qorpera_code_checkout_path('code/acme/app/worktrees/w1/src/a.ts')
		or not public.qorpera_code_checkout_path('code/acme/app/main/README.md')
		or not public.qorpera_code_checkout_path('code/acme/app/repo.git/worktrees/w1/index') then
		raise exception 'expected code worktree/main paths to match';
	end if;
	if public.qorpera_code_checkout_path('code/acme/app/repo.git/objects/pack/a.pack')
		or public.qorpera_code_checkout_path('code/acme/app/changes/1.json')
		or public.qorpera_code_checkout_path('code/acme/app/main')
		or public.qorpera_code_checkout_path('docs/worktrees/a.txt') then
		raise exception 'non-worktree path unexpectedly matched';
	end if;

	insert into auth.users (id, email) values (v_user, 'storage-1410@example.com');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Storage Co', v_user);
	insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
	values (v_profile, v_user, 'storage-1410@example.com', 'Owner', 'owner');
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_profile, 'Environment', 1, v_user);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable(v_env);

	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_old_main, 110, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_live_main, 220, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_old_wt, 330, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_held, 440, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_recent, 550, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_intent_unref, 660, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_intent_live, 770, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_hot, 880, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile, v_m_ok, 990, 'nas-object-gateway');

	select * into v_file from public.qorpera_company_files where environment_id = v_env;
	select coalesce(sum(bytes), 0) into v_expected_bytes from public.qorpera_profile_objects where profile_id = v_profile;
	v_file_json := public.qorpera_company_file_json(v_file);
	if v_expected_bytes < (110 + 220 + 330 + 440 + 550 + 660 + 770 + 880 + 990)
		or (v_file_json ->> 'storage_used_bytes')::bigint <> v_expected_bytes
		or (v_file_json ->> 'retained_storage_bytes')::bigint <> 0
		or (v_file_json -> 'object_backends') <> '[]'::jsonb
		or not (v_file_json ?& array[
			'profile_id','environment_id','canonical_workspace_id','head_snapshot_id','state',
			'logical_bytes','retained_storage_bytes','storage_used_bytes','storage_limit_bytes',
			'object_backends','entitlement','created_at','updated_at'
		]) then
		raise exception 'unexpected folder-v2 company file json: %', v_file_json;
	end if;

	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile_v1, 'Snapshot V1 Co', v_user);
	insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
	values (v_profile_v1, v_user, 'storage-1410@example.com', 'Owner', 'owner');
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_v1, v_profile_v1, 'Environment', 1, v_user);
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile_v1, v_m_v1_retained, 4321, 'nas-object-gateway');
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values (v_profile_v1, v_m_v1_unretained, 999, 'nas-object-gateway');
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_object_reachability_graphs (
		id, profile_id, environment_id, root_kind, root_id, client_graph_id, root_object_sha256,
		contract_version, content_sha256, object_count, storage_bytes, status, created_by_user_id
	) values (
		v_graph_v1, v_profile_v1, v_env_v1, 'company_snapshot', v_graph_v1, v_graph_v1, v_m_v1_retained,
		1, v_m_v1_retained, 1, 4321, 'uploading', v_user
	);
	insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
	values (v_graph_v1, v_m_v1_retained, 4321);
	perform set_config('session_replication_role', 'origin', true);
	select * into v_file from public.qorpera_company_files where environment_id = v_env_v1;
	v_file_json := public.qorpera_company_file_json(v_file);
	if (v_file_json ->> 'retained_storage_bytes')::bigint <> 4321
		or (v_file_json -> 'object_backends') <> '["nas-object-gateway"]'::jsonb then
		raise exception 'unexpected snapshot-v1 company file json: %', v_file_json;
	end if;

	insert into public.qorpera_folder_upload_intents (
		id, environment_id, profile_id, actor_kind, scope_id, manifest_sha256, manifest_text,
		file_sha256, bytes, media_type, executable, state, expires_at
	) values
		(v_intent_1, v_env, v_profile, 'platform', v_user, v_m_intent_unref, '{"v":2}', v_m_intent_unref, 660, 'text/plain', false, 'open', v_t_older),
		(v_intent_2, v_env, v_profile, 'platform', v_user, v_m_intent_unref, '{"v":2}', v_m_intent_unref, 660, 'text/plain', false, 'open', v_t_newer),
		(v_intent_fresh, v_env, v_profile, 'platform', v_user, v_m_intent_live, '{"v":2}', v_m_intent_live, 770, 'text/plain', false, 'open', now() + interval '10 minutes');
	insert into public.qorpera_folder_upload_intent_objects (intent_id, sha256, bytes, profile_id, held, put) values
		(v_intent_1, v_m_intent_unref, 660, v_profile, false, true),
		(v_intent_2, v_m_intent_unref, 660, v_profile, false, true),
		(v_intent_2, v_m_intent_live, 770, v_profile, false, true),
		(v_intent_fresh, v_m_intent_live, 770, v_profile, false, true);

	v_res := public.qorpera_folder_sweep_upload_intents_cron(100);
	if (v_res ->> 'swept')::int <> 2 or (v_res ->> 'queued')::int <> 1 or (v_res ->> 'busy')::boolean or (v_res ->> 'fallback')::boolean then
		raise exception 'unexpected intent sweep result: %', v_res;
	end if;
	if exists (select 1 from public.qorpera_folder_upload_intents where id in (v_intent_1, v_intent_2))
		or not exists (select 1 from public.qorpera_folder_upload_intents where id = v_intent_fresh) then
		raise exception 'expired intents were not swept cleanly';
	end if;
	select unreferenced_since into v_unreferenced_since
	from public.qorpera_folder_object_gc
	where profile_id = v_profile and sha256 = v_m_intent_unref;
	if v_unreferenced_since is distinct from v_t_newer then
		raise exception 'expected max(expires_at) % for deduplicated intent object, got %', v_t_newer, v_unreferenced_since;
	end if;
	if exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m_intent_live) then
		raise exception 'fresh-intent-rooted object must not be queued for GC';
	end if;

	execute 'create trigger cscp_fail_hot_gc_trg before insert on public.qorpera_folder_object_gc for each row execute function pg_temp.cscp_fail_hot_gc()';
	insert into public.qorpera_folder_upload_intents (
		id, environment_id, profile_id, actor_kind, scope_id, manifest_sha256, manifest_text,
		file_sha256, bytes, media_type, executable, state, expires_at
	) values
		(v_intent_hot, v_env, v_profile, 'platform', v_user, v_m_hot, '{"v":2}', v_m_hot, 880, 'text/plain', false, 'open', v_t_older),
		(v_intent_ok, v_env, v_profile, 'platform', v_user, v_m_ok, '{"v":2}', v_m_ok, 990, 'text/plain', false, 'open', v_t_newer);
	insert into public.qorpera_folder_upload_intent_objects (intent_id, sha256, bytes, profile_id, held, put) values
		(v_intent_hot, v_m_hot, 880, v_profile, false, true),
		(v_intent_ok, v_m_ok, 990, v_profile, false, true);
	v_res := public.qorpera_folder_sweep_upload_intents_cron(100);
	execute 'drop trigger cscp_fail_hot_gc_trg on public.qorpera_folder_object_gc';
	if not (v_res ->> 'fallback')::boolean
		or (v_res ->> 'swept')::int <> 1
		or (v_res ->> 'queued')::int <> 1
		or (v_res ->> 'skipped')::int <> 1
		or not (v_res ->> 'more')::boolean then
		raise exception 'expected per-intent contention fallback to sweep healthy intent and skip hot intent: %', v_res;
	end if;
	if not exists (select 1 from public.qorpera_folder_upload_intents where id = v_intent_hot)
		or exists (select 1 from public.qorpera_folder_upload_intents where id = v_intent_ok)
		or not exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m_ok) then
		raise exception 'contention fallback left unexpected intent or GC state';
	end if;
	v_res := public.qorpera_folder_sweep_upload_intents_cron(100);
	if (v_res ->> 'fallback')::boolean or (v_res ->> 'swept')::int <> 1 or (v_res ->> 'queued')::int <> 1 then
		raise exception 'expected hot intent to sweep cleanly after contention cleared: %', v_res;
	end if;

	begin
		perform public.qorpera_folder_sweep_upload_intents_cron(0);
		raise exception 'expected p_limit = 0 to fail';
	exception when invalid_parameter_value then
		null;
	end;

	insert into public.qorpera_folder_commits (id, environment_id, seq, operation_key, actor_kind, actor_id, units, created_at) values
		(v_c1, v_env, 101, 'wt-prune-1', 'member', v_user, '[]'::jsonb, now() - interval '20 days'),
		(v_c2, v_env, 102, 'wt-prune-2', 'member', v_user, '[]'::jsonb, now() - interval '10 days'),
		(v_c3, v_env, 103, 'wt-prune-3', 'member', v_user, '[]'::jsonb, now() - interval '9 days'),
		(v_c4, v_env, 104, 'wt-prune-4', 'member', v_user, '[]'::jsonb, now() - interval '2 days');

	insert into public.qorpera_folder_path_versions (
		version, environment_id, path, key_sha256, prior_version, op, kind, commit_id, unit_no,
		manifest_sha256, file_sha256, bytes, media_type, executable, created_at
	) values
		(v_v1, v_env, v_main_path, extensions.digest(public.qorpera_folder_key(v_main_path), 'sha256'), null, 'write', 'file', v_c1, 1, v_m_old_main, v_m_old_main, 110, 'text/plain', false, now() - interval '20 days'),
		(v_v2, v_env, v_main_path, extensions.digest(public.qorpera_folder_key(v_main_path), 'sha256'), v_v1, 'write', 'file', v_c2, 1, v_m_live_main, v_m_live_main, 220, 'text/plain', false, now() - interval '10 days'),
		(v_v3, v_env, v_wt_path, extensions.digest(public.qorpera_folder_key(v_wt_path), 'sha256'), null, 'write', 'file', v_c1, 2, v_m_old_wt, v_m_old_wt, 330, 'text/plain', false, now() - interval '20 days'),
		(v_v4, v_env, v_wt_path, extensions.digest(public.qorpera_folder_key(v_wt_path), 'sha256'), v_v3, 'delete', 'file', v_c2, 2, null, null, null, null, null, now() - interval '10 days'),
		(v_v5, v_env, v_doc_path, extensions.digest(public.qorpera_folder_key(v_doc_path), 'sha256'), null, 'write', 'file', v_c1, 3, v_m_held, v_m_held, 440, 'text/plain', false, now() - interval '20 days'),
		(v_v6, v_env, v_recent_path, extensions.digest(public.qorpera_folder_key(v_recent_path), 'sha256'), null, 'write', 'file', v_c1, 4, v_m_held, v_m_held, 440, 'application/octet-stream', false, now() - interval '20 days'),
		(v_v7, v_env, v_recent_path, extensions.digest(public.qorpera_folder_key(v_recent_path), 'sha256'), v_v6, 'write', 'file', v_c3, 1, v_m_recent, v_m_recent, 550, 'application/octet-stream', false, now() - interval '9 days');

	insert into public.qorpera_folder_entries (environment_id, path, kind, version, commit_id, manifest_sha256, file_sha256, bytes, media_type, executable) values
		(v_env, v_main_path, 'file', v_v2, v_c2, v_m_live_main, v_m_live_main, 220, 'text/plain', false),
		(v_env, v_doc_path, 'file', v_v5, v_c1, v_m_held, v_m_held, 440, 'text/plain', false),
		(v_env, v_recent_path, 'file', v_v7, v_c3, v_m_recent, v_m_recent, 550, 'application/octet-stream', false);

	v_res := public.qorpera_code_checkout_prune(100);
	if (v_res ->> 'pruned')::int <> 2 or (v_res ->> 'held')::int <> 1 or (v_res ->> 'released')::int <> 2 then
		raise exception 'unexpected code checkout prune result: %', v_res;
	end if;
	if exists (select 1 from public.qorpera_folder_path_versions where version in (v_v1, v_v3)) then
		raise exception 'superseded code worktree/main versions v1 and v3 were not pruned';
	end if;
	if not exists (select 1 from public.qorpera_folder_path_versions where version in (v_v2, v_v5, v_v6, v_v7)) then
		raise exception 'live or externally-held versions were unexpectedly pruned';
	end if;
	if not exists (select 1 from public.qorpera_code_checkout_prune_held where version = v_v6) then
		raise exception 'externally shared code version v6 should be held';
	end if;
	if not exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m_old_main)
		or not exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m_old_wt) then
		raise exception 'pruned worktree/main manifests were not queued for GC';
	end if;

	delete from public.qorpera_folder_entries where environment_id = v_env and version = v_v5;
	delete from public.qorpera_folder_path_versions where version = v_v5;
	v_res := public.qorpera_code_checkout_prune(100);
	if (v_res ->> 'pruned')::int <> 1 or (v_res ->> 'released')::int <> 1 then
		raise exception 'expected previously-held code version to prune once external reference cleared: %', v_res;
	end if;
	if exists (select 1 from public.qorpera_folder_path_versions where version = v_v6)
		or exists (select 1 from public.qorpera_code_checkout_prune_held where version = v_v6)
		or not exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m_held) then
		raise exception 'previously-held version v6 was not released cleanly';
	end if;

	insert into public.qorpera_coding_executors (environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
	values (v_env, 'coding-node-01', true, array['codex'], repeat('a', 64));

	insert into public.qorpera_code_repositories (environment_id, profile_id, owner, name, next_care_at)
	values (v_env, v_profile, 'surfaces', 'app', now() - interval '1 hour');

	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile2, 'Storage Co 2', v_user);
	insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
	values (v_profile2, v_user, 'storage-1410@example.com', 'Owner', 'owner');
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env2, v_profile2, 'Environment', 1, v_user);
	perform public.qorpera_folder_enable(v_env2);

	insert into public.qorpera_profile_staff (
		profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
		employment_status, created_at, updated_at, updated_by_user_id
	) values
		(v_profile, v_agent, 'Builder', 'Engineer', 'Builds apps.', '#336699', 'circle', 'active', now(), now(), v_user),
		(v_profile2, v_agent2, 'Builder 2', 'Engineer', 'Builds apps.', '#336699', 'circle', 'active', now(), now(), v_user);

	insert into public.qorpera_surfaces (id, profile_id, slug, title, surface_group, archetype, source_kind, repository_key, status) values
		(v_surface, v_profile, 'app', 'App', 'products', 'live_build', 'code_repo', 'surfaces/app', 'active'),
		(v_surface_folder, v_profile, 'notes-studio', 'Notes', 'products', 'studio', 'folder', null, 'active'),
		(v_surface2, v_profile2, 'app2', 'App 2', 'products', 'live_build', 'code_repo', 'surfaces/app2', 'active');

	insert into public.qorpera_surface_sessions (
		id, profile_id, surface_id, title, prompt, state, has_active_chat, closed_at, branch_head_sha
	) values
		(v_ss_ready, v_profile, v_surface, 'Ready retire', 'p', 'completed', false, now() - interval '25 hours', null),
		(v_ss_young, v_profile, v_surface, 'Too young', 'p', 'completed', false, now() - interval '12 hours', null),
		(v_ss_chat, v_profile, v_surface, 'Chat open', 'p', 'completed', true, now() - interval '48 hours', null),
		(v_ss_job, v_profile, v_surface, 'Job queued', 'p', 'completed', false, now() - interval '48 hours', null),
		(v_ss_disc_unarch, v_profile, v_surface, 'Discarded unarchived', 'p', 'discarded', false, now() - interval '2 days', repeat('d', 40)),
		(v_ss_disc_failed, v_profile, v_surface, 'Discarded failed cleanup', 'p', 'discarded', false, now() - interval '2 days', repeat('e', 40)),
		(v_ss_disc_done, v_profile, v_surface, 'Discarded done cleanup', 'p', 'discarded', false, now() - interval '2 days', repeat('f', 40)),
		(v_ss_disc_clean, v_profile, v_surface, 'Discarded already clean', 'p', 'discarded', false, now() - interval '2 days', null),
		(v_ss_disc_folder, v_profile, v_surface_folder, 'Discarded folder', 'p', 'discarded', false, now() - interval '2 days', repeat('c', 40)),
		(v_ss_disc_other, v_profile2, v_surface2, 'Discarded other company', 'p', 'discarded', false, now() - interval '2 days', repeat('b', 40));

	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_workers (
		id, profile_id, environment_id, staff_agent_id, worker_key, species, title, access, revival, dispatch,
		state, requested_by_user_id, result, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
		surface_backed, surface_session_id
	) values
		(v_w_ready, v_profile, v_env, v_agent, 'w-ready', 'coding', 'Ready', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_ready),
		(v_w_young, v_profile, v_env, v_agent, 'w-young', 'coding', 'Young', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_young),
		(v_w_chat, v_profile, v_env, v_agent, 'w-chat', 'coding', 'Chat', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_chat),
		(v_w_job, v_profile, v_env, v_agent, 'w-job', 'coding', 'Job', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_job),
		(v_w_disc_unarch, v_profile, v_env, v_agent, 'w-disc-1', 'coding', 'Disc 1', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_disc_unarch),
		(v_w_disc_failed, v_profile, v_env, v_agent, 'w-disc-2', 'coding', 'Disc 2', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_disc_failed),
		(v_w_disc_done, v_profile, v_env, v_agent, 'w-disc-3', 'coding', 'Disc 3', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_disc_done),
		(v_w_disc_clean, v_profile, v_env, v_agent, 'w-disc-4', 'coding', 'Disc 4', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_disc_clean),
		(v_w_disc_folder, v_profile, v_env, v_agent, 'w-disc-5', 'coding', 'Disc 5', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_disc_folder),
		(v_w_disc_other, v_profile2, v_env2, v_agent2, 'w-disc-6', 'coding', 'Disc 6', 'write', 'each', '{}'::jsonb, 'succeeded', v_user, '{"summary":"ok"}'::jsonb, v_user, v_user, 1, true, v_ss_disc_other);
	perform set_config('session_replication_role', 'origin', true);

	update public.qorpera_surface_sessions set worker_id = v_w_disc_unarch where id = v_ss_disc_unarch;
	update public.qorpera_surface_sessions set worker_id = v_w_disc_failed where id = v_ss_disc_failed;
	update public.qorpera_surface_sessions set worker_id = v_w_disc_done where id = v_ss_disc_done;
	update public.qorpera_surface_sessions set worker_id = v_w_disc_clean where id = v_ss_disc_clean;
	update public.qorpera_surface_sessions set worker_id = v_w_disc_folder where id = v_ss_disc_folder;
	update public.qorpera_surface_sessions set worker_id = v_w_disc_other where id = v_ss_disc_other;

	insert into public.qorpera_coding_sessions (
		worker_id, profile_id, environment_id, harness, repository, branch, phase, archived_at, archived_by, surface_session_id
	) values
		(v_w_ready, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/r1', 'completed', null, null, v_ss_ready),
		(v_w_young, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/r2', 'completed', null, null, v_ss_young),
		(v_w_chat, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/r3', 'completed', null, null, v_ss_chat),
		(v_w_job, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/r4', 'completed', null, null, v_ss_job),
		(v_w_disc_unarch, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/d1', 'completed', null, null, v_ss_disc_unarch),
		(v_w_disc_failed, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/d2', 'completed', now() - interval '1 day', 'kernel', v_ss_disc_failed),
		(v_w_disc_done, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/d3', 'completed', now() - interval '1 day', 'kernel', v_ss_disc_done),
		(v_w_disc_clean, v_profile, v_env, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app","baseBranch":"main"}', 'qorpera/coding/d4', 'completed', now() - interval '1 day', 'kernel', v_ss_disc_clean),
		(v_w_disc_other, v_profile2, v_env2, 'codex', '{"host":"qorpera","owner":"surfaces","name":"app2","baseBranch":"main"}', 'qorpera/coding/d6', 'completed', null, null, v_ss_disc_other);

	insert into public.qorpera_surface_jobs (profile_id, surface_id, session_id, kind, status, payload) values
		(v_profile, v_surface, v_ss_job, 'publish_surface', 'queued', '{}'::jsonb),
		(v_profile, v_surface, v_ss_disc_failed, 'cleanup_session', 'failed', jsonb_build_object('workerId', v_w_disc_failed)),
		(v_profile, v_surface, v_ss_disc_done, 'cleanup_session', 'completed', jsonb_build_object('workerId', v_w_disc_done));

	set local role service_role;
	v_res := public.qorpera_code_care_step('coding-node-01', repeat('a', 64), v_env, 'surfaces', 'app', null, 'begin');
	if v_res ->> 'state' <> 'go' then
		raise exception 'expected executor begin to go, got %', v_res;
	end if;
	v_token := (v_res ->> 'token')::uuid;
	v_res := public.qorpera_code_care_step('coding-node-01', repeat('a', 64), v_env, 'surfaces', 'app', v_token, 'retire');
	reset role;
	v_retire := array(select e::uuid from jsonb_array_elements_text(v_res -> 'retire') e);
	if v_retire <> array[v_w_ready] then
		raise exception 'expected only 24h-closed completed surface worker % in retire list, got %', v_w_ready, v_retire;
	end if;

	v_backfilled := public.qorpera_surface_backfill_discarded_cleanups();
	if v_backfilled <> 3 then
		raise exception 'expected 3 discarded code_repo sessions backfilled across 2 companies, got %', v_backfilled;
	end if;
	if (select archived_at from public.qorpera_coding_sessions where worker_id = v_w_disc_unarch) is null
		or (select archived_at from public.qorpera_coding_sessions where worker_id = v_w_disc_other) is null then
		raise exception 'discarded unarchived coding sessions were not archived by backfill';
	end if;
	if not exists (
		select 1 from public.qorpera_surface_jobs
		where session_id = v_ss_disc_unarch and kind = 'cleanup_session' and status = 'queued'
	) or not exists (
		select 1 from public.qorpera_surface_jobs
		where session_id = v_ss_disc_failed and kind = 'cleanup_session' and status = 'queued'
	) or not exists (
		select 1 from public.qorpera_surface_jobs
		where session_id = v_ss_disc_other and kind = 'cleanup_session' and status = 'queued'
	) then
		raise exception 'backfill did not enqueue cleanup_session for unarchived, failed-cleanup, and second-company discarded sessions';
	end if;
	if exists (
		select 1 from public.qorpera_surface_jobs
		where session_id in (v_ss_disc_done, v_ss_disc_clean, v_ss_disc_folder)
			and kind = 'cleanup_session' and status = 'queued'
	) then
		raise exception 'backfill unexpectedly enqueued cleanup_session for already-done, clean, or folder session';
	end if;
	if public.qorpera_surface_backfill_discarded_cleanups() <> 0 then
		raise exception 'expected discarded cleanup backfill to be idempotent';
	end if;
end $$;

rollback;

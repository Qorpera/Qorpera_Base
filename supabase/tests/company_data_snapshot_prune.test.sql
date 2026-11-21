begin;

do $$
declare
	v_user uuid := '00000000-0000-4000-8000-000000008281';
	v_profile uuid := '00000000-0000-4000-8000-000000008282';
	v_env uuid := '00000000-0000-4000-8000-000000008283';
	v_c1 uuid := '00000000-0000-4000-8000-000000008284';
	v_c2 uuid := '00000000-0000-4000-8000-000000008285';
	v_c3 uuid := '00000000-0000-4000-8000-000000008286';
	v_v1 uuid := '00000000-0000-4000-8000-000000008291';
	v_v2 uuid := '00000000-0000-4000-8000-000000008292';
	v_v3 uuid := '00000000-0000-4000-8000-000000008293';
	v_m1 text := repeat('a', 64);
	v_m2 text := repeat('b', 64);
	v_m3 text := repeat('c', 64);
	v_path text := 'data/shop/snapshot/tables/orders/0001.csv';
	v_key bytea := extensions.digest(public.qorpera_folder_key(v_path), 'sha256');
	v_res jsonb;
begin
	if not public.qorpera_company_data_snapshot_path('data/shop/snapshot/schema.sql') then
		raise exception 'expected snapshot path to match';
	end if;
	if public.qorpera_company_data_snapshot_path('data/shop/queries/orders.sql')
		or public.qorpera_company_data_snapshot_path('data/shop/snapshot')
		or public.qorpera_company_data_snapshot_path('notes/snapshot/a.csv') then
		raise exception 'non-snapshot path unexpectedly matched';
	end if;

	insert into auth.users (id, email) values (v_user, 'snap-prune@example.com');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Snap Co', v_user);
	insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
	values (v_profile, v_user, 'snap-prune@example.com', 'Owner', 'owner');
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_profile, 'Environment', 1, v_user);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable(v_env);

	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values
		(v_profile, v_m1, 100, 'nas-object-gateway'),
		(v_profile, v_m2, 200, 'nas-object-gateway'),
		(v_profile, v_m3, 300, 'nas-object-gateway');

	insert into public.qorpera_folder_commits (id, environment_id, seq, operation_key, actor_kind, actor_id, units, created_at) values
		(v_c1, v_env, 101, 'snap-prune-test-1', 'member', v_user, '[]'::jsonb, now() - interval '20 days'),
		(v_c2, v_env, 102, 'snap-prune-test-2', 'member', v_user, '[]'::jsonb, now() - interval '15 days'),
		(v_c3, v_env, 103, 'snap-prune-test-3', 'member', v_user, '[]'::jsonb, now() - interval '8 days');

	insert into public.qorpera_folder_path_versions (version, environment_id, path, key_sha256, prior_version, op, kind, commit_id, unit_no, manifest_sha256, file_sha256, bytes, media_type, executable, created_at) values
		(v_v1, v_env, v_path, v_key, null, 'write', 'file', v_c1, 1, v_m1, v_m1, 100, 'text/csv', false, now() - interval '20 days'),
		(v_v2, v_env, v_path, v_key, v_v1, 'write', 'file', v_c2, 1, v_m2, v_m2, 200, 'text/csv', false, now() - interval '15 days'),
		(v_v3, v_env, v_path, v_key, v_v2, 'write', 'file', v_c3, 1, v_m3, v_m3, 300, 'text/csv', false, now() - interval '8 days');

	insert into public.qorpera_folder_entries (environment_id, path, kind, version, commit_id, manifest_sha256, file_sha256, bytes, media_type, executable)
	values (v_env, v_path, 'file', v_v3, v_c3, v_m3, v_m3, 300, 'text/csv', false);

	v_res := public.qorpera_data_snapshot_prune(100);
	if (v_res->>'pruned')::int <> 2 or (v_res->>'released')::int <> 2 then
		raise exception 'unexpected prune result: %', v_res;
	end if;

	if exists (select 1 from public.qorpera_folder_path_versions where version in (v_v1, v_v2)) then
		raise exception 'replaced snapshot versions v1 and v2 were not pruned';
	end if;
	if not exists (select 1 from public.qorpera_folder_path_versions where version = v_v3) then
		raise exception 'live snapshot version v3 should be retained';
	end if;
	if not exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m1)
		or not exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_m2) then
		raise exception 'pruned manifests m1 and m2 were not queued in qorpera_folder_object_gc';
	end if;

	begin
		perform public.qorpera_data_snapshot_prune(0);
		raise exception 'expected p_versions = 0 to be rejected';
	exception when invalid_parameter_value then
		null;
	end;
end $$;

rollback;

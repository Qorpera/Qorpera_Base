-- The cutover must have actually moved trust: after 20260818004000 the
-- retention system's object-existence answers come from the catalog, not
-- from storage.objects. Equivalence while the mirror holds is asserted by
-- the drift checks in 050; this suite proves the *source* changed, by
-- forcing the two apart and watching which one the functions believe.

-- A profile created the same way clients create one, as the separation
-- suite's user A (fixtures are order-coupled and already present).
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.cutover_profile',
	public.qorpera_create_hosted_profile('Cutover', 'main', 1) ->> 'profile_id', false);
reset role;
select set_config('request.jwt.claims', '', false);

select set_config('qorpera_test.cutover_environment',
	(select environment.id::text
	from public.qorpera_company_environments as environment
	where environment.profile_id = current_setting('qorpera_test.cutover_profile')::uuid
	limit 1), false);

-- One object, arriving through the real upload table so the mirror populates
-- the catalog exactly as production writes would.
insert into storage.objects (bucket_id, name, metadata)
values ('qorpera-profile-objects',
	current_setting('qorpera_test.cutover_profile') || '/' || repeat('c', 64),
	'{"size":"42"}');

do $$
declare v_profile uuid := current_setting('qorpera_test.cutover_profile')::uuid;
begin
	if not public.qorpera_object_exists(v_profile, repeat('c', 64)) then
		raise exception 'predicate misses a mirrored object';
	end if;
	if not public.qorpera_object_exists(v_profile, repeat('c', 64), 42) then
		raise exception 'predicate misses the mirrored object at its exact size';
	end if;
	if public.qorpera_object_exists(v_profile, repeat('c', 64), 41) then
		raise exception 'predicate accepts a wrong size';
	end if;
end
$$;

-- A minimal graph over that object, then the divergence experiment. The
-- hardening triggers demand a real root whose creator matches and an
-- auth.uid() equal to that creator, so the fixture builds the honest chain
-- (workspace, snapshot, graph, entry) with user A's claims in place.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);

insert into public.qorpera_company_workspaces
	(id, profile_id, environment_id, client_workspace_id, name, created_by_user_id)
values ('91000000-0000-4000-8000-000000000004',
	current_setting('qorpera_test.cutover_profile')::uuid,
	current_setting('qorpera_test.cutover_environment')::uuid,
	'91000000-0000-4000-8000-000000000005', 'Cutover workspace',
	'80000000-0000-4000-8000-00000000000a');

insert into public.qorpera_company_snapshots
	(id, profile_id, environment_id, workspace_id, client_snapshot_id,
	tree_manifest_sha256, tree_manifest_bytes, tree_contract_version,
	file_count, total_bytes, created_by_user_id)
values ('91000000-0000-4000-8000-000000000002',
	current_setting('qorpera_test.cutover_profile')::uuid,
	current_setting('qorpera_test.cutover_environment')::uuid,
	'91000000-0000-4000-8000-000000000004',
	'91000000-0000-4000-8000-000000000006',
	repeat('c', 64), 42, 2, 1, 42,
	'80000000-0000-4000-8000-00000000000a');

insert into public.qorpera_object_reachability_graphs
	(id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count, storage_bytes,
	status, created_by_user_id)
values ('91000000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.cutover_profile')::uuid,
	current_setting('qorpera_test.cutover_environment')::uuid,
	'company_snapshot', '91000000-0000-4000-8000-000000000002',
	'91000000-0000-4000-8000-000000000003',
	repeat('c', 64), 1, repeat('d', 64), 1, 42,
	'uploading', '80000000-0000-4000-8000-00000000000a');

insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
values ('91000000-0000-4000-8000-000000000001', repeat('c', 64), 42);

select set_config('request.jwt.claims', '', false);

do $$
begin
	if not public.qorpera_object_graph_objects_available('91000000-0000-4000-8000-000000000001') then
		raise exception 'graph unavailable while its object is catalogued';
	end if;
end
$$;

-- Force the catalog and storage apart: remove the catalog row while the
-- bytes stay in storage. Before the cutover this changed nothing; after it,
-- every existence answer must flip, proving storage.objects is no longer
-- what the retention system believes.
delete from public.qorpera_profile_objects
where profile_id = current_setting('qorpera_test.cutover_profile')::uuid
	and sha256 = repeat('c', 64);

do $$
declare v_profile uuid := current_setting('qorpera_test.cutover_profile')::uuid; v_seen integer;
begin
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-profile-objects'
		and name = v_profile::text || '/' || repeat('c', 64);
	if v_seen <> 1 then
		raise exception 'experiment invalid: storage side lost the object';
	end if;
	if public.qorpera_object_exists(v_profile, repeat('c', 64)) then
		raise exception 'predicate still answers from storage.objects';
	end if;
	if public.qorpera_object_graph_objects_available('91000000-0000-4000-8000-000000000001') then
		raise exception 'graph availability still answers from storage.objects';
	end if;
	if public.qorpera_object_catalog_drift() <> 1 then
		raise exception 'drift check failed to see the forced divergence';
	end if;
end
$$;

-- Heal the divergence and confirm everything converges back.
insert into public.qorpera_profile_objects (profile_id, sha256, bytes)
values (current_setting('qorpera_test.cutover_profile')::uuid, repeat('c', 64), 42);

do $$
begin
	if not public.qorpera_object_graph_objects_available('91000000-0000-4000-8000-000000000001') then
		raise exception 'graph did not recover after healing the catalog';
	end if;
	if public.qorpera_object_catalog_drift() <> 0 then
		raise exception 'drift remains after healing: %', public.qorpera_object_catalog_drift();
	end if;
end
$$;

-- The predicate is service-side: client roles cannot call it directly.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare v_ok boolean;
begin
	v_ok := false;
	begin
		perform public.qorpera_object_exists(
			current_setting('qorpera_test.cutover_profile')::uuid, repeat('c', 64));
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'authenticated can call the existence predicate'; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

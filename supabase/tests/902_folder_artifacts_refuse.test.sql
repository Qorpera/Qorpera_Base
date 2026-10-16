-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core: artifacts refuse folder-v2 companies (migration 20260930041000). The member's graph completion
-- answers 0A000 for a folder-v2 company, as its first statement, whichever of its environments the graph names; a
-- company that is not folder-v2 gets past the refusal. That the refusal comes before any lock is pinned by 838. (The
-- runner broker's artifact lane went with legacy sweep D5, 20260930334000, and the member's registration, index,
-- retention hold and GC plan functions with E1, 20260930400000.)

-- Runs a statement that must be refused for folder-v2 (0A000), or must not be (any other outcome).
create function pg_temp.refused(p_sql text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected 0A000 from %', p_sql using errcode = 'QTF03';
exception when sqlstate '0A000' then null;
end $$;
create function pg_temp.not_refused(p_sql text) returns void language plpgsql as $$
begin
	execute p_sql;
exception when sqlstate '0A000' then
	raise exception 'Not refused for folder-v2 expected: %', p_sql using errcode = 'QTF04';
when others then null;
end $$;

-- A second environment of the folder-v2 company that is not itself folder-v2, and another company that is not
-- folder-v2 at all (member 2 belongs to it too); an artifact in the folder-v2 company and one in the other, and a graph
-- in each of the folder-v2 company's environments and one in the other company (written with triggers and foreign keys
-- off: no folder-v2 path can make them).
set local session_replication_role = replica;
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('63400000-0000-4000-8000-000000000029', '63400000-0000-4000-8000-000000000010', 'Old environment', 1,
		'63400000-0000-4000-8000-000000000001');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('90200000-0000-4000-8000-000000000010', 'Not folder-v2', '63400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('90200000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', 'authority-owner@example.test', 'Owner', 'owner'),
	('90200000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002', 'authority-member@example.test', 'Member', 'contributor');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('90200000-0000-4000-8000-000000000020', '90200000-0000-4000-8000-000000000010', 'Environment', 1,
		'63400000-0000-4000-8000-000000000001');
insert into public.qorpera_artifacts(id, profile_id, environment_id, client_artifact_id, artifact_type, name, root_object_sha256,
	content_sha256, bytes, media_type, created_by_user_id) values
	('90200000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), 'report', 'Folder-v2 artifact', repeat('a', 64), repeat('a', 64), 1, 'text/plain',
		'63400000-0000-4000-8000-000000000002'),
	('90200000-0000-4000-8000-0000000000a2', '90200000-0000-4000-8000-000000000010', '90200000-0000-4000-8000-000000000020',
		extensions.gen_random_uuid(), 'report', 'Old artifact', repeat('b', 64), repeat('b', 64), 1, 'text/plain',
		'63400000-0000-4000-8000-000000000002');
insert into public.qorpera_object_reachability_graphs(id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count, storage_bytes, created_by_user_id) values
	('90200000-0000-4000-8000-0000000000b1', '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		'artifact', '90200000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(), repeat('a', 64), 1, repeat('a', 64), 1, 1,
		'63400000-0000-4000-8000-000000000002'),
	('90200000-0000-4000-8000-0000000000b2', '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000029',
		'artifact', '90200000-0000-4000-8000-0000000000a3', extensions.gen_random_uuid(), repeat('a', 64), 1, repeat('a', 64), 1, 1,
		'63400000-0000-4000-8000-000000000002'),
	('90200000-0000-4000-8000-0000000000b3', '90200000-0000-4000-8000-000000000010', '90200000-0000-4000-8000-000000000020',
		'artifact', '90200000-0000-4000-8000-0000000000a2', extensions.gen_random_uuid(), repeat('b', 64), 1, repeat('b', 64), 1, 1,
		'63400000-0000-4000-8000-000000000002');
set local session_replication_role = origin;
-- The fence is the company's: the second environment has no folder of its own, but its company is folder-v2.
do $$
begin
	if public.qorpera_environment_is_folder_v2('63400000-0000-4000-8000-000000000029')
		or not public.qorpera_company_is_folder_v2('63400000-0000-4000-8000-000000000010')
		or public.qorpera_company_is_folder_v2('90200000-0000-4000-8000-000000000010') then
		raise exception 'Fixture: a folder-v2 company with a second environment, and a company that is not folder-v2'; end if;
end $$;

-- 1. A member's graph completion, as the member ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"63400000-0000-4000-8000-000000000002","role":"authenticated"}', true) \g /dev/null
set local role authenticated;
do $$
begin
	perform pg_temp.refused($q$select public.qorpera_complete_object_reachability_graph('90200000-0000-4000-8000-0000000000b1')$q$);
	-- The folder-v2 company's other environment is refused too: the fence is the company's.
	perform pg_temp.refused($q$select public.qorpera_complete_object_reachability_graph('90200000-0000-4000-8000-0000000000b2')$q$);
	-- A company that is not folder-v2 goes on to the function's own checks.
	perform pg_temp.not_refused($q$select public.qorpera_complete_object_reachability_graph('90200000-0000-4000-8000-0000000000b3')$q$);
	-- An id that names nothing is no folder-v2 company: the function refuses it as before.
	perform pg_temp.not_refused($q$select public.qorpera_complete_object_reachability_graph(gen_random_uuid())$q$);
end $$;
reset role;

-- 2. Nothing was written, and the patched body carries the marker ---------------------------------------------------------
do $$
begin
	if exists (select 1 from public.qorpera_object_reachability_graphs
			where id in ('90200000-0000-4000-8000-0000000000b1', '90200000-0000-4000-8000-0000000000b2') and status <> 'uploading') then
		raise exception 'A refused graph completion writes nothing'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_complete_object_reachability_graph(uuid)'::regprocedure),
			'20260930041000') = 0 then
		raise exception 'The artifacts refusal marker is missing from qorpera_complete_object_reachability_graph'; end if;
end $$;

rollback;

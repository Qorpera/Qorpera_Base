-- Summary trees M1b, part 3b (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §8, §9, §10): zoom's summary lines are
-- released as platform reads of their blocks.
--
-- 1. qorpera_memory_release, a native host call (scope binding): the run check, then the run's read record of the tree
--    blocks a zoom result showed, by path and version, under the nil resource 00000000-0000-0000-0000-000000000000 with
--    authority {"platform": true}. The blocks are the platform's (§9), so the release needs no folder grant, writes no
--    read-set rows and is never re-checked. A file's erasure finds the record by path like any other (P18 phase 3).
-- 2. The consumers that re-check a run's records under an agent's authority leave the nil resource's out: the run's own
--    re-check (qorpera_folder_run_reads_current) and a coworker wake's parent-reads check
--    (qorpera_folder_parent_reads_allowed).
-- 3. A coworker wake's read copy (qorpera_folder_read_wake) re-resolves the parent's other reads under the recipient, as
--    before, and copies its platform reads as they are, under the nil resource.
-- Every patched body carries the marker 20260930203000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; zoom comes first.
do $$ begin
	if to_regprocedure('public.qorpera_memory_release(jsonb,jsonb)') is not null then
		raise exception 'M1b-3b (20260930203000) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_zoom(jsonb,jsonb)') is null then
		raise exception 'M1b-3b (20260930203000) needs M1b-3a (20260930202000)'; end if;
end $$;

create function pg_temp.m1b3b_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'M1b-3b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The release ------------------------------------------------------------------------------------------------------

-- The release of the tree blocks one zoom result showed (§8), for the binding's run. The request is {releaseId,
-- outputSha256, blocks}: a lowercase uuid, the result's sha256, and 1 to 10,000 {path, version} of memory blocks
-- (`t<tier>/<8 digits>.jsonl` under a tree's root), each the version of a block written at that path. A release id is
-- used once: the same request replays, another is refused (22023), as qorpera_folder_record_release does. The run check
-- comes first, so a pause refuses even a replay, as it does a zoom. The version's erasure is not checked: what the
-- result showed is recorded either way, and the erasure finds the record by path.
create function public.qorpera_memory_release(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_nil constant uuid := '00000000-0000-0000-0000-000000000000';
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
	v_run public.qorpera_execution_runs%rowtype; v_release uuid; v_content text;
	v_existing public.qorpera_folder_run_releases%rowtype; v_block jsonb; v_version public.qorpera_folder_path_versions%rowtype;
	v_reads jsonb; v_result jsonb;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) as key(name) where key.name not in ('releaseId','outputSha256','blocks'))
		or jsonb_typeof(p_request -> 'releaseId') is distinct from 'string' or p_request ->> 'releaseId' !~ c_uuid
		or jsonb_typeof(p_request -> 'outputSha256') is distinct from 'string' or p_request ->> 'outputSha256' !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(p_request -> 'blocks') is distinct from 'array'
		or jsonb_array_length(p_request -> 'blocks') not between 1 and 10000
		or exists (select 1 from jsonb_array_elements(p_request -> 'blocks') b
			where case when jsonb_typeof(b) = 'object' then b - array['path','version'] <> '{}'::jsonb else true end
				or jsonb_typeof(b -> 'path') is distinct from 'string'
				or not public.qorpera_company_path_valid(coalesce(b ->> 'path', ''))
				or jsonb_typeof(b -> 'version') is distinct from 'string' or b ->> 'version' !~ c_uuid) then
		raise exception 'memory release is malformed' using errcode = '22023'; end if;
	v_release := (p_request ->> 'releaseId')::uuid;
	v_content := encode(extensions.digest(convert_to(jsonb_build_array(p_request -> 'blocks', p_request ->> 'outputSha256')::text,
		'utf8'), 'sha256'), 'hex');

	-- The id is claimed first, as a folder release claims it: a concurrent release of the same id waits, then replays.
	insert into public.qorpera_folder_run_releases(run_id, release_id, environment_id, content_sha256, result)
	values (v_run.id, v_release, v_run.environment_id, v_content, '{}'::jsonb) on conflict do nothing;
	if not found then
		select * into strict v_existing from public.qorpera_folder_run_releases where run_id = v_run.id and release_id = v_release;
		if v_existing.content_sha256 <> v_content then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		return v_existing.result || jsonb_build_object('replay', true);
	end if;
	-- A wake's read copy files records under the wake's id with no release row: an id with records is never reused.
	if exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_run.id and release_id = v_release) then
		raise exception 'Release id was used for other reads' using errcode = '22023'; end if;

	-- Each block is the version of a memory block written at that exact path in the run's company.
	for v_block in select value from jsonb_array_elements(p_request -> 'blocks') loop
		select * into v_version from public.qorpera_folder_path_versions where version = (v_block ->> 'version')::uuid;
		if v_version.version is null or v_version.environment_id <> v_run.environment_id
			or v_version.path is distinct from v_block ->> 'path' or v_version.kind is distinct from 'file'
			or v_version.op not in ('write','move_in')
			or public.qorpera_structured_path_kind(public.qorpera_folder_key(v_version.path)) is distinct from 'memory-block' then
			raise exception 'memory release names a block that is not one' using errcode = '22023'; end if;
	end loop;

	select jsonb_agg(jsonb_build_object('path', b.path, 'version', b.version, 'authority', jsonb_build_object('platform', true))
		order by public.qorpera_folder_key(b.path), b.version)
	into v_reads
	from (select distinct x ->> 'path' as path, x ->> 'version' as version from jsonb_array_elements(p_request -> 'blocks') x) b;
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	values (v_run.id, v_release, v_run.environment_id, c_nil, v_reads, p_request ->> 'outputSha256');
	v_result := jsonb_build_object('schema', 'qorpera.memory-release/v1', 'releaseId', v_release,
		'reads', jsonb_array_length(v_reads), 'replay', false);
	update public.qorpera_folder_run_releases set result = v_result where run_id = v_run.id and release_id = v_release;
	return v_result;
end $$;
revoke all on function public.qorpera_memory_release(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_release(jsonb, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_release', 'binding');

-- 2. The re-checks leave platform reads out ---------------------------------------------------------------------------

-- The run's own re-check: a platform read is no agent's to lose.
select pg_temp.m1b3b_replace('public.qorpera_folder_run_reads_current(uuid,uuid,jsonb)'::regprocedure,
	$old$where rec.run_id = v_run and ($old$,
	$new$where rec.run_id = v_run and rec.resource_id <> '00000000-0000-0000-0000-000000000000'::uuid /* 20260930203000 (M1b-3) */ and ($new$);

-- A coworker wake's check of its parent's reads: the recipient needs only the reads it is given under its own authority.
select pg_temp.m1b3b_replace('public.qorpera_folder_parent_reads_allowed(public.qorpera_wake_occurrences)'::regprocedure,
	$old$where rec.run_id = p_wake.parent_run_id and ($old$,
	$new$where rec.run_id = p_wake.parent_run_id and rec.resource_id <> '00000000-0000-0000-0000-000000000000'::uuid /* 20260930203000 (M1b-3) */ and ($new$);

-- 3. A coworker wake's read copy --------------------------------------------------------------------------------------

-- The re-resolved copy leaves the platform reads out ...
select pg_temp.m1b3b_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$where rec.run_id = v_wake.parent_run_id order by x ->> 'path', rec.created_at desc, rec.release_id) latest;$old$,
	$new$where rec.run_id = v_wake.parent_run_id and rec.resource_id <> '00000000-0000-0000-0000-000000000000'::uuid /* 20260930203000 (M1b-3) */
			order by x ->> 'path', rec.created_at desc, rec.release_id) latest;$new$);

-- ... and they are copied first, as they are.
select pg_temp.m1b3b_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$		-- One read per path: the parent's latest record of it.$old$,
	$new$		-- 20260930203000 (M1b-3): the parent's platform reads of memory blocks, under the nil resource, copied as they
		-- are: they are the platform's, never re-resolved under the recipient's authority.
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		select v_run.id, v_wake.id, v_run.environment_id, '00000000-0000-0000-0000-000000000000'::uuid,
			jsonb_agg(latest.x order by public.qorpera_folder_key(latest.x ->> 'path')), repeat('0', 64)
		from (select distinct on (x ->> 'path') x from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.resource_id = '00000000-0000-0000-0000-000000000000'::uuid and rec.run_id = v_wake.parent_run_id
			order by x ->> 'path', rec.created_at desc, rec.release_id) latest
		having count(*) > 0;
		-- One read per path: the parent's latest record of it.$new$);

drop function pg_temp.m1b3b_replace(regprocedure, text, text);

-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core, P24b (migration 20260930019500): a read set is re-resolved in one set-based pass. The set-based
-- lookups give what the one-path functions give, path by path, on every rule; the run's re-check, a release with stale
-- receipts and an agent wake's parent-reads check keep their meaning; 5,000 paths are re-checked after a re-grant in
-- well under the 4 s result fence (one by one, appending receipts, took about 13 s). 634's fixture, rolled back.

-- A. The covering resources: exact and subtree resources, nesting, letter case, the root, credentials/ and secrets/, a
-- member's private folder with and without its owner's resource, and a folder key two resources share.
select public.qorpera_folder_set_resource('63400000-0000-4000-8000-000000000020', pg_temp.member(1), path, match, 'company_shared', 'normal')
from (values ('teams/sales', 'subtree'), ('teams/sales/q1', 'exact'), ('docs', 'subtree'), ('docs/deep/a', 'subtree')) r(path, match) \g /dev/null
select public.qorpera_folder_set_resource('63400000-0000-4000-8000-000000000020', pg_temp.member(2),
	'members/63400000-0000-4000-8000-000000000002/private', 'subtree', 'member_private', 'normal') \g /dev/null
-- Two resources whose folder keys are one ('Østen' folds to 'østen'; the shared unique key folds ASCII only).
select pg_temp.fx($q$insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	select environment_id, p, 'subtree', 'company_shared', 'normal', created_by_user_id
	from public.qorpera_company_path_resources, unnest(array['Østen', 'østen']) p
	where environment_id = '63400000-0000-4000-8000-000000000020' and path = ''$q$) \g /dev/null
do $$
declare
	v_paths text[] := array['a.md', 'teams/sales/a.md', 'teams/sales', 'teams/sales/q1', 'teams/sales/q1/x.md', 'teams/other.md',
		'TEAMS/Sales/b.md', 'docs/deep/a/b/c.md', 'docs/deep/b.md', 'credentials/x.md', 'secrets/y.md',
		'members/63400000-0000-4000-8000-000000000002/private/n.md', 'members/63400000-0000-4000-8000-000000000003/private/n.md',
		'members/63400000-0000-4000-8000-000000000002/notes.md', 'Østen/f.md', 'østen/g.md', 'teams/sales/a.md'];
	v_bad text[];
begin
	if (select count(*) from public.qorpera_company_path_resources where environment_id = '63400000-0000-4000-8000-000000000020'
		and path in ('Østen', 'østen')) <> 2 then raise exception 'A: the fixture needs two resources sharing a folder key'; end if;
	select array_agg(p) into v_bad from unnest(v_paths) p
	where (select c.resource from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', v_paths) c where c.path = p)
		is distinct from public.qorpera_folder_path_resource('63400000-0000-4000-8000-000000000020', p);
	if v_bad is not null then raise exception 'A: covering resources differ for %', v_bad; end if;
	-- A null path has no resource (and so nobody reads it), as a path the one-path lookup refuses.
	if (select count(*) from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', array['a.md', null]) c
		where c.path is null and c.resource is null) <> 1 then raise exception 'A: a null path has no resource'; end if;
	if (select count(*) from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', v_paths))
		<> (select count(distinct p) from unnest(v_paths) p) then raise exception 'A: one row per distinct path'; end if;
	-- The cases the rules decide are really there: no resource, the exact one, the nested one.
	if (select (c.resource).id from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', v_paths) c
		where c.path = 'Østen/f.md') is not null
		or (select (c.resource).path from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', v_paths) c
			where c.path = 'teams/sales/q1') <> 'teams/sales/q1'
		or (select (c.resource).path from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', v_paths) c
			where c.path = 'teams/sales/q1/x.md') <> 'teams/sales'
		or (select (c.resource).id from public.qorpera_folder_paths_resources('63400000-0000-4000-8000-000000000020', v_paths) c
			where c.path = 'members/63400000-0000-4000-8000-000000000003/private/n.md') is not null then
		raise exception 'A: the edge cases are not exercised'; end if;
end $$;

-- B. The checks and receipts: for agent A (read on teams/sales) and agent B (no grant there), each path's ok and receipt
-- are qorpera_folder_actor_allowed and qorpera_folder_read_receipt.
select public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1),
	(select id from public.qorpera_company_path_resources where environment_id = '63400000-0000-4000-8000-000000000020' and path = 'teams/sales'),
	'staff_agent', '63400000-0000-4000-8000-0000000000a1', array['read']) \g /dev/null
do $$
declare
	v_paths text[] := array['a.md', 'teams/sales/a.md', 'teams/sales/q1', 'teams/sales/q1/x.md', 'TEAMS/Sales/b.md', 'docs/deep/a/b/c.md',
		'credentials/x.md', 'Østen/f.md', 'members/63400000-0000-4000-8000-000000000002/private/n.md', 'QorperaOS/rules/r.md'];
	v_run jsonb; v_actor jsonb; v_actor_a jsonb; v_actor_b jsonb; v_bad text[]; v_staff uuid;
begin
	-- A run is built in one statement and resolved in the next (a stable function reads its statement's snapshot).
	foreach v_staff in array array['63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-0000000000a2']::uuid[] loop
		v_run := pg_temp.run(v_staff, 'human', '63400000-0000-4000-8000-000000000002');
		v_actor := pg_temp.resolved(v_run);
		if v_staff = '63400000-0000-4000-8000-0000000000a1' then v_actor_a := v_actor; else v_actor_b := v_actor; end if;
		select array_agg(a.path) into v_bad
		from public.qorpera_folder_paths_authority('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', v_actor,
			v_paths) a
		where a.ok is distinct from public.qorpera_folder_actor_allowed('63400000-0000-4000-8000-000000000020',
				'63400000-0000-4000-8000-000000000010', v_actor, a.path, 'read')
			or a.receipt is distinct from public.qorpera_folder_read_receipt('63400000-0000-4000-8000-000000000020',
				'63400000-0000-4000-8000-000000000010', v_actor, a.path);
		if v_bad is not null then raise exception 'B: agent % differs on %', v_staff, v_bad; end if;
	end loop;
	if not exists (select 1 from public.qorpera_folder_paths_authority('63400000-0000-4000-8000-000000000020',
			'63400000-0000-4000-8000-000000000010', v_actor_a, v_paths) a where a.path = 'teams/sales/a.md' and a.ok)
		or exists (select 1 from public.qorpera_folder_paths_authority('63400000-0000-4000-8000-000000000020',
			'63400000-0000-4000-8000-000000000010', v_actor_b, v_paths) a where a.path = 'teams/sales/a.md' and a.ok) then
		raise exception 'B: the grant must decide teams/sales'; end if;
end $$;

-- C. A run of agent A reads 5,000 paths under teams/sales (one release, current receipts), then the area is re-granted:
-- the re-check re-resolves all of them in one pass, quickly, and re-files the read set under the new grant; after a
-- revoke it refuses.
select set_config('qorpera_test.big_run', pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human',
	'63400000-0000-4000-8000-000000000002')::text, false) \g /dev/null
do $$
declare
	v_run jsonb := current_setting('qorpera_test.big_run')::jsonb; v_actor jsonb := pg_temp.resolved(v_run);
	v_receipt jsonb := public.qorpera_folder_read_receipt('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
		v_actor, 'teams/sales/f1.md');
	v_resource uuid := (v_receipt ->> 'resourceId')::uuid; v_old uuid := (v_receipt ->> 'grantId')::uuid; v_new uuid;
	v_started timestamptz; v_ms numeric; v_changed integer;
begin
	perform public.qorpera_folder_record_release('63400000-0000-4000-8000-000000000020', v_run, extensions.gen_random_uuid(),
		(select jsonb_agg(jsonb_build_object('path', 'teams/sales/f' || n || '.md', 'version', extensions.gen_random_uuid(),
			'authority', v_receipt)) from generate_series(1, 5000) n), repeat('0', 64));
	if (select count(*) from pg_temp.reads(v_run)) <> 1 then raise exception 'C: one read-set row after the release'; end if;
	v_new := (public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a1', array['read']) ->> 'grantId')::uuid;
	v_started := clock_timestamp();
	v_changed := public.qorpera_folder_run_reads_current('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
		v_actor);
	v_ms := extract(epoch from clock_timestamp() - v_started) * 1000;
	if v_changed <> 1 then raise exception 'C: one row changed, got %', v_changed; end if;
	if v_ms > 2000 then raise exception 'C: re-checking 5,000 paths took % ms', round(v_ms); end if;
	if (select array_agg(grant_id) from pg_temp.reads(v_run)) is distinct from array[v_new] then
		raise exception 'C: the read set must be filed under the new grant only, got %', (select jsonb_agg(to_jsonb(r)) from pg_temp.reads(v_run) r); end if;
	-- Stamped now: nothing to do.
	if public.qorpera_folder_run_reads_current('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', v_actor) <> 0 then
		raise exception 'C: a stamped read set changes nothing'; end if;
	perform public.qorpera_folder_revoke('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, v_new);
	perform pg_temp.raises(format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', v_actor), '42501');
end $$;

-- D. A release whose receipts went stale (a re-grant between the reads and the release) re-resolves its paths: each
-- read is filed with its path's new receipt, and the pair goes to the read set once.
do $$
declare
	v_run jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	v_actor jsonb := pg_temp.resolved(v_run); v_resource uuid; v_receipt jsonb; v_new uuid; v_release uuid := extensions.gen_random_uuid();
begin
	select id into v_resource from public.qorpera_company_path_resources
	where environment_id = '63400000-0000-4000-8000-000000000020' and path = 'teams/sales';
	perform public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a1', array['read']);
	v_receipt := public.qorpera_folder_read_receipt('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
		v_actor, 'teams/sales/f1.md');
	v_new := (public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a1', array['read']) ->> 'grantId')::uuid;
	perform public.qorpera_folder_record_release('63400000-0000-4000-8000-000000000020', v_run, v_release,
		(select jsonb_agg(jsonb_build_object('path', 'teams/sales/g' || n || '.md', 'version', extensions.gen_random_uuid(),
			'authority', v_receipt)) from generate_series(1, 300) n)
		|| jsonb_build_array(jsonb_build_object('path', 'teams/sales/g1.md', 'version', extensions.gen_random_uuid(), 'authority', v_receipt)),
		repeat('0', 64));
	if (select sum(jsonb_array_length(reads)) from public.qorpera_folder_run_read_records
		where run_id = (v_run ->> 'runId')::uuid and release_id = v_release) <> 301 then
		raise exception 'D: every read is filed, a repeated path too'; end if;
	if exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.run_id = (v_run ->> 'runId')::uuid and rec.release_id = v_release
			and (x -> 'authority' ->> 'grantId')::uuid is distinct from v_new) then
		raise exception 'D: each read is filed with its new receipt'; end if;
	if (select array_agg(grant_id) from pg_temp.reads(v_run)) is distinct from array[v_new] then
		raise exception 'D: one read-set pair, under the new grant'; end if;
	-- A stale release the agent may no longer read refuses.
	perform public.qorpera_folder_revoke('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, v_new);
	perform pg_temp.raises(format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		v_run, extensions.gen_random_uuid(), jsonb_build_array(jsonb_build_object('path', 'teams/sales/h.md',
			'version', extensions.gen_random_uuid(), 'authority', v_receipt)), repeat('0', 64)), '42501');
end $$;

-- E. An agent wake's parent-reads check, once the parent's row changed (its grant was replaced): the recipient must
-- read every path again. Agent B cannot until it is granted teams/sales.
do $$
declare
	v_parent jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	v_actor jsonb := pg_temp.resolved(v_parent); v_resource uuid; v_receipt jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_child jsonb;
begin
	select id into v_resource from public.qorpera_company_path_resources
	where environment_id = '63400000-0000-4000-8000-000000000020' and path = 'teams/sales';
	perform public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a1', array['read']);
	v_receipt := public.qorpera_folder_read_receipt('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
		v_actor, 'teams/sales/f1.md');
	perform public.qorpera_folder_record_release('63400000-0000-4000-8000-000000000020', v_parent, extensions.gen_random_uuid(),
		(select jsonb_agg(jsonb_build_object('path', 'teams/sales/p' || n || '.md', 'version', extensions.gen_random_uuid(),
			'authority', v_receipt)) from generate_series(1, 200) n), repeat('0', 64));
	-- The parent's grant is replaced: its read-set row no longer matches, so the check goes path by path.
	perform public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a1', array['read']);
	v_child := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'agent', '63400000-0000-4000-8000-000000000002', 'coworker', v_parent);
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = (v_child ->> 'runId')::uuid;
	if public.qorpera_folder_parent_reads_allowed(v_wake) then
		raise exception 'E: agent B cannot read the parent''s teams/sales reads'; end if;
	perform public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_resource, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a2', array['read']);
	if not public.qorpera_folder_parent_reads_allowed(v_wake) then
		raise exception 'E: agent B, granted teams/sales, reads them'; end if;
end $$;

-- F. The new functions are internal, and every patched body carries the marker.
do $$
begin
	if exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) r,
			unnest(array['public.qorpera_folder_paths_resources(uuid,text[])',
				'public.qorpera_folder_paths_authority(uuid,uuid,jsonb,text[])']) f
		where has_function_privilege(r, f, 'execute')) then
		raise exception 'F: the set-based lookups must be internal'; end if;
	if exists (select 1 from unnest(array['public.qorpera_folder_run_reads_current(uuid,uuid,jsonb)',
			'public.qorpera_folder_view_reads_current(uuid,uuid,uuid,jsonb)', 'public.qorpera_folder_release_pairs(uuid,uuid,jsonb,jsonb)',
			'public.qorpera_folder_parent_reads_allowed(public.qorpera_wake_occurrences)']) f
		where position('20260930019500' in pg_get_functiondef(f::regprocedure)) = 0) then
		raise exception 'F: a patched body lacks its marker'; end if;
end $$;

rollback;

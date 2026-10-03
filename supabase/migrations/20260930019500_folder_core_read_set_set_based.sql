-- Company folder core, P24b (C1e's first finding; deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §9, C1B-2 §3): a read
-- set is re-resolved in one set-based pass. Before, every path of a changed read-set row was re-resolved one by one (its
-- covering resource looked up against every resource of the company, its check and receipt each looking it up again),
-- and each receipt was appended to a jsonb array, which copies the array every time: quadratic. The C1e load test
-- measured a run that read 25,000 paths: one read-set check after a re-grant of their area took 252 s alone (9 ms while
-- its stamps were current), so under PostgREST's 8 s statement timeout the run could never make a model request again.
--
-- * qorpera_folder_paths_resources(environment, paths): qorpera_folder_path_resource for many paths at once, by one
--   hash join of each path's ancestor keys with the company's resources (every rule of the one-path lookup: exact and
--   subtree matches, the longest key, a folder key two resources share covers nothing, credentials/ and secrets/ have
--   no resource, members/<id>/private only its owner's member_private resource). For paths already valid: every caller
--   passes paths a release accepted (qorpera_company_path_valid), so validity is not checked again.
-- * qorpera_folder_paths_authority(environment, company, actor, paths): per path its covering resource, whether the
--   actor may read it and its receipt, in one statement. The check and the receipt depend only on the resource and the
--   actor, so each is computed once per distinct resource. One statement, so no receipt is newer than its check.
-- * The run's and the view's read-set re-check (run_reads_current, view_reads_current), the release's pairs (both the
--   pass check and the re-resolution of a group whose receipts are stale) and an agent wake's parent-reads check use
--   them. The receipts go to the read-set writer once per (resource, grant), deduplicated as it already did.
-- The meaning of a read set is unchanged, and so is the lock order: plain reads first, then the read-set writer (rank 10).
-- No new lock; every patched body carries the marker 20260930019500.

create function pg_temp.p24b_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P24b anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Many paths' covering resources at once ----------------------------------------------------------------------------

create function public.qorpera_folder_paths_resources(p_environment_id uuid, p_paths text[])
returns table(path text, resource public.qorpera_company_path_resources)
language sql stable security definer set search_path = '' as $$
	-- P24b (20260930019500): qorpera_folder_path_resource for valid paths, set-based.
	with resources as materialized (
		select r as res, public.qorpera_folder_key(r.path) as key
		from public.qorpera_company_path_resources r where r.environment_id = p_environment_id),
	shared as materialized (select resources.key from resources group by resources.key having count(*) > 1),
	paths as materialized (
		select distinct given.path, public.qorpera_folder_key(given.path) as key
		from unnest(p_paths) as given(path) where given.path is not null),
	-- Each path's candidates: the root, every ancestor folder's key, and its own key.
	candidates as (
		select paths.path, paths.key, '' as candidate from paths
		union all
		select paths.path, paths.key, array_to_string(parts.part[1:depth.n], '/')
		from paths
		cross join lateral (select string_to_array(paths.key, '/') as part) parts
		cross join lateral generate_series(1, cardinality(parts.part)) as depth(n)
		where paths.key <> ''),
	covering as (
		select distinct on (candidates.path) candidates.path, resources.res, resources.key as resource_key
		from candidates join resources on resources.key = candidates.candidate
		-- Its own key matches any resource; an ancestor's (or the root's) only a subtree resource.
		where resources.key = candidates.key or (resources.res).path_match = 'subtree'
		order by candidates.path, length(resources.key) desc, (resources.res).id)
	select paths.path,
		case
			when split_part(paths.key, '/', 1) in ('credentials', 'secrets') then null
			-- Two resources can share one folder key (the unique key folds ASCII only): neither is picked.
			when exists (select 1 from shared where shared.key = covering.resource_key) then null
			when split_part(paths.key, '/', 1) = 'members' and split_part(paths.key, '/', 3) = 'private'
				and ((covering.res).scope is distinct from 'member_private'
					or (covering.res).owner_user_id::text is distinct from split_part(paths.key, '/', 2)) then null
			else covering.res
		end
	from paths left join covering on covering.path = paths.path
$$;

-- 2. Many paths' checks and receipts at once ----------------------------------------------------------------------------

create function public.qorpera_folder_paths_authority(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_paths text[])
returns table(path text, resource_id uuid, ok boolean, receipt jsonb)
language sql stable security definer set search_path = '' as $$
	-- P24b (20260930019500): qorpera_folder_actor_allowed(…, 'read') and qorpera_folder_read_receipt for valid paths, in
	-- one statement, each decided once per covering resource.
	with covered as materialized (
		select c.path, c.resource from public.qorpera_folder_paths_resources(p_environment_id, p_paths) c),
	decided as materialized (
		select distinct_resources.resource,
			public.qorpera_folder_actor_resource_allowed(p_profile_id, p_actor, distinct_resources.resource, 'read') as ok,
			public.qorpera_folder_agent_grant(distinct_resources.resource, (p_actor ->> 'staffAgentId')::uuid, 'read') as agent_grant
		from (select distinct on ((covered.resource).id) covered.resource from covered order by (covered.resource).id)
			as distinct_resources)
	select covered.path, (covered.resource).id, coalesce(decided.ok, false),
		case when (covered.resource).id is not null then jsonb_build_object('resourceId', (covered.resource).id,
			'resourceRevision', (covered.resource).authority_revision, 'grantId', (decided.agent_grant).id,
			'grantRevision', (decided.agent_grant).revision) end
	from covered join decided on (decided.resource).id is not distinct from (covered.resource).id
$$;

revoke all on function public.qorpera_folder_paths_resources(uuid, text[]),
	public.qorpera_folder_paths_authority(uuid, uuid, jsonb, text[])
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. The run's read-set re-check -------------------------------------------------------------------------------------------

select pg_temp.p24b_replace('public.qorpera_folder_run_reads_current(uuid,uuid,jsonb)'::regprocedure,
$old$		for v_path in
			select distinct x ->> 'path' from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = v_run and (
				(v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix)))
		loop
			-- The check and the receipt in one statement: the receipt is never newer than the check (see record_release).
			select public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_path, 'read'),
				public.qorpera_folder_read_receipt(p_environment_id, p_profile_id, p_actor, v_path)
			into v_ok, v_receipt;
			if not v_ok then raise exception 'A read is no longer readable' using errcode = '42501'; end if;
			if v_receipt is not null then v_upserts := v_upserts || jsonb_build_array(v_receipt); end if;
		end loop;$old$,
$new$		-- P24b (20260930019500): every path at once. The check and the receipt in one statement: the receipt is never
		-- newer than the check (see record_release).
		select coalesce(bool_and(a.ok), true), coalesce(jsonb_agg(distinct a.receipt) filter (where a.receipt is not null), '[]')
		into v_ok, v_receipt
		from public.qorpera_folder_paths_authority(p_environment_id, p_profile_id, p_actor, array(
			select distinct x ->> 'path' from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = v_run and (
				(v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix))))) a;
		if not v_ok then raise exception 'A read is no longer readable' using errcode = '42501'; end if;
		v_upserts := v_upserts || v_receipt;$new$);

-- 4. The view's read-set re-check ----------------------------------------------------------------------------------------

select pg_temp.p24b_replace('public.qorpera_folder_view_reads_current(uuid,uuid,uuid,jsonb)'::regprocedure,
$old$		for v_path in
			select distinct x ->> 'path' from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.view_id = p_view_id and (
				(v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix)))
		loop
			select public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_path, 'read'),
				public.qorpera_folder_read_receipt(p_environment_id, p_profile_id, p_actor, v_path)
			into v_ok, v_receipt;
			if not v_ok then raise exception 'A read is no longer readable' using errcode = '42501'; end if;
			if v_receipt is not null then v_upserts := v_upserts || jsonb_build_array(v_receipt); end if;
		end loop;$old$,
$new$		-- P24b (20260930019500): every path at once, the check and the receipt in one statement.
		select coalesce(bool_and(a.ok), true), coalesce(jsonb_agg(distinct a.receipt) filter (where a.receipt is not null), '[]')
		into v_ok, v_receipt
		from public.qorpera_folder_paths_authority(p_environment_id, p_profile_id, p_actor, array(
			select distinct x ->> 'path' from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.view_id = p_view_id and (
				(v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix))))) a;
		if not v_ok then raise exception 'A read is no longer readable' using errcode = '42501'; end if;
		v_upserts := v_upserts || v_receipt;$new$);

-- 5. A release's pairs: the pass check and a stale group's re-resolution ---------------------------------------------

select pg_temp.p24b_replace('public.qorpera_folder_release_pairs(uuid,uuid,jsonb,jsonb)'::regprocedure,
$old$					and not exists (select 1 from jsonb_array_elements(v_group.reads) x
						where (public.qorpera_folder_path_resource(p_environment_id, x ->> 'path')).id is distinct from res.id)$old$,
$new$					-- P24b (20260930019500): every path's covering resource at once.
					and not exists (select 1 from public.qorpera_folder_paths_resources(p_environment_id,
							array(select x ->> 'path' from jsonb_array_elements(v_group.reads) x)) covered
						where (covered.resource).id is distinct from res.id)$new$);
select pg_temp.p24b_replace('public.qorpera_folder_release_pairs(uuid,uuid,jsonb,jsonb)'::regprocedure,
$old$			for v_read in select value from jsonb_array_elements(v_group.reads) loop
				-- The check and the receipt in one statement: the receipt is never newer than the check (C1b-2).
				select public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_read ->> 'path', 'read'),
					public.qorpera_folder_read_receipt(p_environment_id, p_profile_id, p_actor, v_read ->> 'path')
				into v_ok, v_receipt;
				if not v_ok then raise exception 'A released read is no longer readable' using errcode = '42501'; end if;
				v_upserts := v_upserts || jsonb_build_array(v_receipt);
				v_filed := v_filed || jsonb_build_array(v_read || jsonb_build_object('authority', v_receipt));
			end loop;$old$,
$new$			-- P24b (20260930019500): every path at once. The check and the receipt in one statement: the receipt is
			-- never newer than the check (C1b-2). Each read is filed with its path's receipt.
			with authority as materialized (
				select a.path, a.ok, a.receipt from public.qorpera_folder_paths_authority(p_environment_id, p_profile_id, p_actor,
					array(select distinct x ->> 'path' from jsonb_array_elements(v_group.reads) x)) a)
			select coalesce(bool_and(authority.ok), true),
				coalesce(jsonb_agg(distinct authority.receipt) filter (where authority.receipt is not null), '[]'),
				(select coalesce(jsonb_agg(r.value || jsonb_build_object('authority', filed.receipt)), '[]')
					from jsonb_array_elements(v_group.reads) r join authority filed on filed.path = r.value ->> 'path')
			into v_ok, v_receipt, v_read
			from authority;
			if not v_ok then raise exception 'A released read is no longer readable' using errcode = '42501'; end if;
			v_upserts := v_upserts || v_receipt;
			v_filed := v_filed || v_read;$new$);

-- 6. An agent wake's parent-reads check -----------------------------------------------------------------------------------

select pg_temp.p24b_replace('public.qorpera_folder_parent_reads_allowed(public.qorpera_wake_occurrences)'::regprocedure,
$old$			for v_path in
				select distinct x ->> 'path' from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
				where rec.run_id = p_wake.parent_run_id and (rec.resource_id = v_row.resource_id or (v_resource.id is not null
					and public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), public.qorpera_folder_key(v_resource.path))))
			loop
				if not public.qorpera_folder_actor_allowed(p_wake.environment_id, p_wake.profile_id, v_recipient, v_path, 'read') then
					return false; end if;
			end loop;$old$,
$new$			-- P24b (20260930019500): every path at once.
			if exists (select 1 from public.qorpera_folder_paths_authority(p_wake.environment_id, p_wake.profile_id, v_recipient, array(
					select distinct x ->> 'path' from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
					where rec.run_id = p_wake.parent_run_id and (rec.resource_id = v_row.resource_id or (v_resource.id is not null
						and public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), public.qorpera_folder_key(v_resource.path))))))
					a where not a.ok) then
				return false; end if;$new$);

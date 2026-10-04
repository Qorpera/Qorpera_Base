-- Company folder core, P24c (the C1e load test's second finding; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §3.1,
-- RUNTIME-COMPANY-FOLDER-CORE.md §9): an upload's presence check reads only what it must.
--
-- qorpera_folder_open_upload lists the objects of an upload the catalog already has and the actor may read. It filtered
-- the company's catalog rows with qorpera_folder_object_readable in the same statement as the join to the upload's own
-- objects. With stale statistics the planner scanned the company's catalog first and ran the filter on every object
-- the company stores, before the join narrowed them to the upload's two or three. qorpera_folder_object_readable walks
-- every path that names an object and runs the full authority check on each until one is readable, so one widely shared
-- object the actor cannot read (the load test's 5,000-file area only one agent reads) made every upload of every agent
-- cost seconds of CPU: up to 6.8 s, past the 4 s result fence, in about one load run in three.
--
-- * open_upload collects the upload's own objects the catalog has first, and checks readability on those alone; the
--   lock (FOR KEY SHARE in hash order, G1) and the GC mark check that follows are unchanged.
-- * qorpera_folder_object_readable decides the paths that name an object once per covering resource, through P24b's
--   set-based qorpera_folder_paths_authority: an object many unreadable paths name costs one pass, not one authority
--   check per path. Its meaning is unchanged: readable when the actor may read any path whose manifest is the object,
--   or whose version-2 manifest has it as a chunk, an old version's path too.
-- No new lock. Every patched body carries the marker 20260930039500.

create function pg_temp.p24c_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P24c anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Whether an actor may read an object: its paths, decided once per covering resource -------------------------------

create or replace function public.qorpera_folder_object_readable(p_environment_id uuid, p_profile_id uuid, p_auth jsonb,
	p_sha256 text)
returns boolean language sql stable security definer set search_path = '' as $$
	-- P24c (20260930039500): every path that names the object (its manifest's, or a manifest's that has it as a chunk;
	-- live entries and path versions), then P24b's set-based authority over those paths.
	select coalesce(bool_or(decided.ok), false)
	from public.qorpera_folder_paths_authority(p_environment_id, p_profile_id, p_auth, array(
		select distinct named.path from (select p_sha256 as manifest
				union all
				select c.manifest_sha256 from public.qorpera_folder_file_chunks c
				where c.profile_id = p_profile_id and c.chunk_sha256 = p_sha256) m
			cross join lateral (
				select e.path from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind = 'file' and e.manifest_sha256 = m.manifest
				union all
				select v.path from public.qorpera_folder_path_versions v
				where v.environment_id = p_environment_id and v.manifest_sha256 = m.manifest) named)) decided
$$;

-- 2. The upload's presence check: its own objects first -------------------------------------------------------------------

select pg_temp.p24c_replace('public.qorpera_folder_open_upload(uuid,jsonb,text)',
	$old$declare v_actor jsonb; v_profile uuid; v_manifest jsonb; v_intent public.qorpera_folder_upload_intents%rowtype; v_present jsonb;$old$,
	$new$declare v_actor jsonb; v_profile uuid; v_manifest jsonb; v_intent public.qorpera_folder_upload_intents%rowtype; v_present jsonb;
	v_candidates text[]; -- P24c (20260930039500)$new$);
select pg_temp.p24c_replace('public.qorpera_folder_open_upload(uuid,jsonb,text)',
	$old$	select coalesce(jsonb_agg(p.sha256 order by p.sha256 collate "C"), '[]'::jsonb) into v_present from (
		select o.sha256 from public.qorpera_profile_objects o
		join public.qorpera_folder_upload_intent_objects i on i.intent_id = v_intent.id and i.sha256 = o.sha256 and i.bytes = o.bytes
		where o.profile_id = v_profile
			and (v_actor ->> 'kind' = 'platform'
				or public.qorpera_folder_object_readable(p_environment_id, v_profile, v_actor -> 'auth', o.sha256))
		order by o.sha256 collate "C" for key share of o) p;$old$,
	$new$	-- P24c (20260930039500): the upload's own objects the catalog has, then the readability check on those alone. In one
	-- statement with the catalog, a plan that scanned the company's catalog first ran it on every object it stores.
	select array_agg(o.sha256) into v_candidates from public.qorpera_profile_objects o
	join public.qorpera_folder_upload_intent_objects i on i.intent_id = v_intent.id and i.sha256 = o.sha256 and i.bytes = o.bytes
	where o.profile_id = v_profile;
	select coalesce(jsonb_agg(p.sha256 order by p.sha256 collate "C"), '[]'::jsonb) into v_present from (
		select o.sha256 from public.qorpera_profile_objects o
		where o.profile_id = v_profile
			and o.sha256 = any (array(select candidate.sha256 from unnest(coalesce(v_candidates, '{}'::text[])) as candidate(sha256)
				where v_actor ->> 'kind' = 'platform'
					or public.qorpera_folder_object_readable(p_environment_id, v_profile, v_actor -> 'auth', candidate.sha256)))
		order by o.sha256 collate "C" for key share of o) p;$new$);

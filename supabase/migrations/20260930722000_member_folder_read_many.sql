-- 20260930722000: a member reads several paths of their company's folder in one call (Jonas, 11 Nov 2026, on opening
-- an agent's app: "Yes, do it", to putting the per-file reads together).
--
-- Opening an app reads each file its page names as the member, one qorpera_member_folder_read each, just before the
-- file's bytes (the bytes may then come from the member's file cache in the tab). Fjeldtur's brand app, 19 files, made
-- 25 calls in three rounds of up to eight, about 200 ms of its ~450 ms open. qorpera_member_folder_read_many answers
-- the same reads, of up to 64 paths (an app's limit of files), in one call: what each path's own
-- qorpera_member_folder_read answers, in the order asked, read with one actor in one snapshot.
--
-- It changes nothing, and decides nothing the single read does not: the member's actor is checked once, as
-- qorpera_member_folder_read checks it (a member of a folder-v2 company, else 42501), and each path goes through the
-- core's own qorpera_folder_read with that actor, so a path the member may not read answers `found: false` and an
-- invalid path refuses the whole call (22023), as it refuses the single read. A client that finds the function
-- missing (a database before this migration) reads each path alone, as before.

create function public.qorpera_member_folder_read_many(p_environment_id uuid, p_paths text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id);
begin
	-- Member folder reads at once (20260930722000)
	if p_paths is null or cardinality(p_paths) not between 1 and 64 or array_position(p_paths, null) is not null then
		raise exception 'Read request is invalid' using errcode = '22023'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-read-many/v1', 'reads', (
		select jsonb_agg(public.qorpera_folder_read(p_environment_id, v_actor, item.path) order by item.position)
		from unnest(p_paths) with ordinality as item(path, position)));
end $$;

revoke all on function public.qorpera_member_folder_read_many(uuid, text[]) from public, anon;
grant execute on function public.qorpera_member_folder_read_many(uuid, text[]) to authenticated;

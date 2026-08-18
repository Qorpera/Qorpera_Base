-- The canonical graph-hash separator in 20260816017000 was written as the
-- two-character sequence backslash-n while every client joins entries with a
-- real newline, so completing any graph with more than one entry failed with
-- a declaration mismatch. Single-entry graphs never use the separator, which
-- is why all previous QA and fixtures passed. The source file is corrected in
-- the same change; this redeploys the corrected completion function (with the
-- current creator and direct-artifact checks) to environments that applied
-- the original.

create or replace function public.qorpera_complete_object_reachability_graph(p_graph_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_object_count integer;
	v_storage_bytes bigint;
	v_content_sha256 text;
	v_direct_artifact_bytes bigint;
begin
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
	for update;
	if auth.uid() is null or not found or v_graph.created_by_user_id <> auth.uid()
		or not public.qorpera_can_write_profile(v_graph.profile_id) then
		raise exception 'object reachability requires graph-creator access' using errcode = '42501';
	end if;
	if v_graph.status = 'complete' then
		return public.qorpera_object_reachability_graph_json(v_graph);
	end if;

	select count(*), coalesce(sum(entry.bytes), 0), encode(
		extensions.digest(
			convert_to(coalesce(string_agg(
				entry.object_sha256 || ':' || entry.bytes::text,
				E'\n' order by entry.object_sha256
			), ''), 'utf8'),
			'sha256'
		),
		'hex'
	)
	into v_object_count, v_storage_bytes, v_content_sha256
	from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = p_graph_id;
	if v_object_count <> v_graph.object_count
		or v_storage_bytes <> v_graph.storage_bytes
		or v_content_sha256 <> v_graph.content_sha256
		or not exists (
			select 1
			from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = p_graph_id
				and entry.object_sha256 = v_graph.root_object_sha256
		)
		or not public.qorpera_object_graph_objects_available(p_graph_id) then
		raise exception 'object reachability graph does not match its declaration' using errcode = '22023';
	end if;
	if v_graph.root_kind = 'artifact' then
		select artifact.bytes into v_direct_artifact_bytes
		from public.qorpera_artifacts as artifact
		where artifact.id = v_graph.root_id and artifact.root_contract = 'qorpera.object/v1';
		if found and (v_object_count <> 1 or v_storage_bytes <> v_direct_artifact_bytes) then
			raise exception 'direct artifact reachability must contain exactly its root object' using errcode = '22023';
		end if;
	end if;

	update public.qorpera_object_reachability_graphs
	set status = 'complete', completed_at = statement_timestamp()
	where id = p_graph_id
	returning * into v_graph;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

-- NAS-disconnected acceptance is an explicit deployment mode, not an
-- automatic storage failover. A service operator may promote one exact,
-- verified Company File graph to Supabase authority only after independently
-- downloading and hashing its immutable Supabase Storage closure. This RPC
-- revalidates the complete durable graph and Storage metadata, holds the
-- profile GC fence, and changes every catalog row in one transaction.

create function public.qorpera_promote_company_file_graph_to_supabase(
	p_profile_id uuid,
	p_graph_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_entry_count bigint;
	v_entry_bytes bigint;
	v_catalog_objects bigint;
	v_storage_objects bigint;
	v_changed_objects bigint;
begin
	if auth.role() is distinct from 'service_role'
		or p_profile_id is null
		or p_graph_id is null then
		raise exception 'Supabase graph promotion is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'profile object cleanup is in progress' using errcode = '40001';
	end if;
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	join public.qorpera_company_files as file
		on file.profile_id = graph.profile_id
		and file.environment_id = graph.environment_id
		and file.head_snapshot_id = graph.root_id
	where graph.id = p_graph_id
		and graph.profile_id = p_profile_id
		and graph.root_kind = 'company_snapshot'
		and graph.status = 'complete'
		and graph.closure_verified
	for update of graph;
	if not found then
		raise exception 'current verified Company File graph is unavailable' using errcode = '55000';
	end if;
	select count(*), coalesce(sum(entry.bytes), 0)
	into v_entry_count, v_entry_bytes
	from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = v_graph.id;
	if v_entry_count <> v_graph.object_count or v_entry_bytes <> v_graph.storage_bytes then
		raise exception 'Company File graph totals are invalid' using errcode = '55000';
	end if;
	perform 1
	from public.qorpera_object_reachability_entries as entry
	join public.qorpera_profile_objects as object
		on object.profile_id = p_profile_id
		and object.sha256 = entry.object_sha256
		and object.bytes = entry.bytes
	where entry.graph_id = v_graph.id
	for update of object;
	get diagnostics v_catalog_objects = row_count;
	if v_catalog_objects <> v_entry_count then
		raise exception 'Company File catalog closure is unavailable' using errcode = '55000';
	end if;
	perform 1
	from public.qorpera_object_reachability_entries as entry
	join storage.objects as storage_object
		on storage_object.bucket_id = 'qorpera-profile-objects'
		and storage_object.name = p_profile_id::text || '/' || entry.object_sha256
		and case
			when (storage_object.metadata ->> 'size') ~ '^[0-9]+$'
				then (storage_object.metadata ->> 'size')::bigint
			else -1
		end = entry.bytes
	where entry.graph_id = v_graph.id
	for key share of storage_object;
	get diagnostics v_storage_objects = row_count;
	if v_storage_objects <> v_entry_count then
		raise exception 'verified Supabase Company File closure is unavailable' using errcode = '55000';
	end if;
	update public.qorpera_profile_objects as object
	set backend = 'supabase-storage'
	where object.profile_id = p_profile_id
		and object.backend <> 'supabase-storage'
		and exists (
			select 1
			from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = v_graph.id
				and entry.object_sha256 = object.sha256
				and entry.bytes = object.bytes
		);
	get diagnostics v_changed_objects = row_count;
	return jsonb_build_object(
		'profile_id', p_profile_id,
		'graph_id', v_graph.id,
		'snapshot_id', v_graph.root_id,
		'object_count', v_entry_count,
		'storage_bytes', v_entry_bytes,
		'backend', 'supabase-storage',
		'changed_objects', v_changed_objects
	);
end
$$;

revoke all on function public.qorpera_promote_company_file_graph_to_supabase(uuid, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_promote_company_file_graph_to_supabase(uuid, uuid)
	to service_role;

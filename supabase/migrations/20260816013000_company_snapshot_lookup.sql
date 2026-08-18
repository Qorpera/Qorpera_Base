-- Resolve any readable DAG node by immutable snapshot id. A fork workspace may
-- still point at a base created by another workspace, so listing only the
-- workspace's own snapshots cannot resolve every valid head.

create function public.qorpera_get_company_snapshot(p_snapshot_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_snapshot public.qorpera_company_snapshots%rowtype;
begin
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_snapshot_id;
	if not found or not public.qorpera_can_read_profile(v_snapshot.profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'snapshot_id', v_snapshot.id,
		'profile_id', v_snapshot.profile_id,
		'environment_id', v_snapshot.environment_id,
		'workspace_id', v_snapshot.workspace_id,
		'client_snapshot_id', v_snapshot.client_snapshot_id,
		'parent_snapshot_id', v_snapshot.parent_snapshot_id,
		'tree_manifest_sha256', v_snapshot.tree_manifest_sha256,
		'tree_manifest_bytes', v_snapshot.tree_manifest_bytes,
		'tree_contract_version', v_snapshot.tree_contract_version,
		'file_count', v_snapshot.file_count,
		'total_bytes', v_snapshot.total_bytes,
		'created_by_user_id', v_snapshot.created_by_user_id,
		'created_at', v_snapshot.created_at
	);
end
$$;

revoke all on function public.qorpera_get_company_snapshot(uuid) from public;
grant execute on function public.qorpera_get_company_snapshot(uuid) to authenticated;

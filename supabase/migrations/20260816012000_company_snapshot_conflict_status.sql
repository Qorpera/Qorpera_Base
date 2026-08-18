-- Return stale workspace heads as an explicit HTTP 409 application conflict.
-- SQLSTATE 40001 is retryable transaction state and the hosted request path
-- can retry it even though this compare-and-swap conflict is deterministic.

create or replace function public.qorpera_commit_company_snapshot(
	p_workspace_id uuid,
	p_client_snapshot_id uuid,
	p_expected_head_snapshot_id uuid,
	p_tree_manifest_sha256 text,
	p_tree_manifest_bytes integer,
	p_tree_contract_version integer,
	p_file_count integer,
	p_total_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_workspace public.qorpera_company_workspaces%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select workspace.* into v_workspace
	from public.qorpera_company_workspaces as workspace
	where workspace.id = p_workspace_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_workspace.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_snapshot_id is null
		or p_tree_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or p_tree_manifest_bytes not between 1 and 8388608
		or p_tree_contract_version is null or p_tree_contract_version < 1
		or p_file_count not between 0 and 50000
		or p_total_bytes not between 0 and 1099511627776 then
		raise exception 'company snapshot is invalid' using errcode = '22023';
	end if;

	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.profile_id = v_workspace.profile_id
		and snapshot.client_snapshot_id = p_client_snapshot_id;
	if found then
		if v_snapshot.workspace_id <> p_workspace_id
			or v_snapshot.parent_snapshot_id is distinct from p_expected_head_snapshot_id
			or v_snapshot.tree_manifest_sha256 <> p_tree_manifest_sha256
			or v_snapshot.tree_manifest_bytes <> p_tree_manifest_bytes
			or v_snapshot.tree_contract_version <> p_tree_contract_version
			or v_snapshot.file_count <> p_file_count
			or v_snapshot.total_bytes <> p_total_bytes then
			raise exception 'snapshot id is already bound to different content' using errcode = '23505';
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
	end if;
	if v_workspace.head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise sqlstate 'PT409' using message = 'company workspace head changed';
	end if;

	insert into public.qorpera_company_snapshots (
		profile_id, environment_id, workspace_id, client_snapshot_id, parent_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count,
		total_bytes, created_by_user_id
	)
	values (
		v_workspace.profile_id, v_workspace.environment_id, v_workspace.id, p_client_snapshot_id,
		p_expected_head_snapshot_id, p_tree_manifest_sha256, p_tree_manifest_bytes,
		p_tree_contract_version, p_file_count, p_total_bytes, v_user_id
	)
	returning * into v_snapshot;

	update public.qorpera_company_workspaces
	set head_snapshot_id = v_snapshot.id, updated_at = v_snapshot.created_at
	where id = v_workspace.id;

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

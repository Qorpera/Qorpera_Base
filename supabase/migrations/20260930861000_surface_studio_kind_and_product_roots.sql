create function public.qorpera_surface_shared_product_folder_roots(
	p_profile_id uuid
)
returns text[]
language sql stable security definer set search_path = '' as $$
	select coalesce(
		array(
			select root
			from (
				select distinct on (root)
					root,
					surface_group,
					sort_order,
					created_at
				from (
					select
						nullif(btrim(coalesce(s.folder_root, ''), '/ '), '') as root,
						s.surface_group,
						s.sort_order,
						s.created_at
					from public.qorpera_surfaces s
					where s.profile_id = p_profile_id
						and s.status = 'active'
						and s.archetype = 'studio'
						and s.surface_kind = 'product'
				) candidates
				where root is not null
				order by root, surface_group asc, sort_order asc, created_at asc
			) ranked
			order by surface_group asc, sort_order asc, created_at asc, root asc
		),
		'{}'::text[]
	);
$$;
revoke all on function public.qorpera_surface_shared_product_folder_roots(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_shared_product_folder_roots(uuid) to service_role;

create or replace function public.qorpera_native_surface_read_session_turn(
	p_profile_id uuid,
	p_session_id uuid,
	p_lease_token uuid
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_conflict_paths text[];
begin
	if p_lease_token is null then
		raise exception 'Surface session turn read requires lease token' using errcode = '42501';
	end if;
	select * into v_session
	from public.qorpera_surface_sessions s
	where s.id = p_session_id and s.profile_id = p_profile_id;
	if v_session.id is null then
		raise exception 'Surface session does not belong to profile' using errcode = '42501';
	end if;
	if v_session.state not in ('running', 'reconciling_running') or v_session.lease_token is distinct from p_lease_token then
		raise exception 'Surface session lease is not active' using errcode = '42501';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id and profile_id = p_profile_id;
	if v_surface.id is null then
		raise exception 'Surface not found for profile' using errcode = 'P0002';
	end if;
	select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
	from public.qorpera_surface_changes c, unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
	where c.session_id = v_session.id and c.status = 'conflicted';
	return jsonb_build_object(
		'sessionId', v_session.id,
		'surfaceId', v_surface.id,
		'surfaceSlug', v_surface.slug,
		'surfaceTitle', v_surface.title,
		'surfaceKind', v_surface.surface_kind,
		'sourceKind', v_surface.source_kind,
		'prompt', v_session.prompt,
		'state', case when v_session.state = 'reconciling_running' then 'reconciling' else 'queued' end,
		'repositoryKey', v_surface.repository_key,
		'folderRoot', v_surface.folder_root,
		'productFolderRoots', to_jsonb(public.qorpera_surface_shared_product_folder_roots(p_profile_id)),
		'briefSummary', v_surface.brief_summary,
		'explorationVariantLabel', v_session.exploration_variant_label,
		'originKind', v_session.origin_kind,
		'originRef', v_session.origin_ref,
		'baseSha', v_session.base_sha,
		'branchHeadSha', v_session.branch_head_sha,
		'conflictPaths', to_jsonb(coalesce(v_conflict_paths, '{}'::text[]))
	);
end $$;
revoke all on function public.qorpera_native_surface_read_session_turn(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_read_session_turn(uuid, uuid, uuid) to service_role;

-- Step 3 sync agent: service-plane head resolution for the standing guest.
-- The member RPCs qorpera_get_company_file / qorpera_get_company_snapshot
-- require a member session, so the Company Computer's delta-sync agent —
-- which runs continuously outside any job or member session — resolves the
-- verified head through this computer-scoped service read instead. The RPC
-- answers only for a registered Company Computer and only with a published
-- snapshot; a head pointing at an unpublished snapshot is a control-plane
-- integrity failure and fails loudly rather than syncing.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create function public.qorpera_company_computer_sync_head(p_company_computer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_registry public.qorpera_company_computers%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_json jsonb;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer sync head requires provider authority' using errcode = '42501';
	end if;
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.id = p_company_computer_id;
	if not found then
		raise exception 'company computer is unknown' using errcode = '55000';
	end if;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = v_registry.environment_id;
	if not found or v_file.state <> 'ready' or v_file.head_snapshot_id is null then
		return null;
	end if;
	select snapshot.* into strict v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = v_file.head_snapshot_id;
	v_json := public.qorpera_company_snapshot_json(v_snapshot);
	if v_json->>'publication_state' <> 'published' then
		raise exception 'company file head is not a published snapshot' using errcode = '55000';
	end if;
	return v_json;
end
$$;

revoke all on function public.qorpera_company_computer_sync_head(uuid) from public;
grant execute on function public.qorpera_company_computer_sync_head(uuid) to service_role;

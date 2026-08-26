-- Step 3 screens: the member shell learns where a computer's viewer gateway
-- lives from the registry instead of local configuration. The endpoint is a
-- private Tailscale/management address set by node operations; publishing it
-- to members is safe because the gateway itself only answers redeemed
-- single-use capabilities.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

alter table public.qorpera_compute_nodes
	add column screen_viewer_endpoint text check (
		screen_viewer_endpoint is null
		or screen_viewer_endpoint ~ '^[a-z0-9][a-z0-9.-]{0,253}:[0-9]{2,5}$'
	);

create or replace function public.qorpera_describe_company_computer_screens(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_registry public.qorpera_company_computers%rowtype;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or auth.uid() is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company computer description requires read access' using errcode = '42501';
	end if;
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.environment_id = p_environment_id and registry.lifecycle_state <> 'retired';
	if not found then
		return null;
	end if;
	return jsonb_build_object(
		'computer', public.qorpera_company_computer_json(v_registry),
		'viewer_endpoint', (
			select node.screen_viewer_endpoint from public.qorpera_compute_nodes as node
			where node.id = v_registry.node_id
		),
		'screens', coalesce((
			select jsonb_agg(public.qorpera_company_computer_screen_json(screen) order by screen.screen_ordinal)
			from public.qorpera_company_computer_screens as screen
			where screen.company_computer_id = v_registry.id and screen.status = 'active'
		), '[]'::jsonb)
	);
end
$$;

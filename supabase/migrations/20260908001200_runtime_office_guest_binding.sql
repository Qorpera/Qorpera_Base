-- Read-only guest lifetime authority. This does not activate an office or
-- attest a physical guest. Verify protected bootstrap/adoption, boot and mounts.
create function public.qorpera_check_runtime_office_guest_binding(
	p_scope jsonb,p_computer_generation bigint,p_allocation_id uuid,
	p_instance_sha256 text,p_image_sha256 text,p_bootstrap_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_computer_generation is null
		or p_computer_generation<1 or p_allocation_id is null
		or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$'
		or coalesce(p_image_sha256,'') !~ '^[0-9a-f]{64}$'
		or coalesce(p_bootstrap_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Invalid office guest binding' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices
		where id=(p_scope->>'companyComputerId')::uuid for share;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation<>p_computer_generation or v_office.state<>'active'
		or v_office.image_sha256<>p_image_sha256 or v_office.bootstrap_sha256<>p_bootstrap_sha256
		or public.qorpera_company_execution_paused(v_office.profile_id)
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
			and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=v_office.logical_computer_id
			and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
		raise exception 'Office guest authority unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_runtime_machine_allocations
		where id=p_allocation_id and profile_id=v_office.profile_id and office_id=v_office.id
		and computer_generation=v_office.generation and provider_adapter='lxd'
		and instance_sha256=p_instance_sha256 and released_at is null for share;
	if not found then raise exception 'Office machine allocation differs' using errcode='42501'; end if;
	return jsonb_build_object('state','authorized','computerGeneration',v_office.generation,'validForMs',5000);
end
$$;
revoke all on function public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)
	to service_role;

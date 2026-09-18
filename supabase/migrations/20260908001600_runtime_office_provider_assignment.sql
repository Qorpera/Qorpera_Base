-- Infrastructure enrollment is independent of member/native start demand.
-- One provider host/policy owns each office generation. There is no timeout
-- reassignment: losing its journal or host requires physical recovery/fencing.
create table public.qorpera_runtime_office_providers (
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null check(computer_generation between 1 and 9007199254740991),
	provider_id uuid not null,
	policy_sha256 text not null check(policy_sha256 ~ '^[0-9a-f]{64}$'),
	version bigint not null check(version between 1 and 9007199254740991),
	preparation_enabled boolean not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key(office_id,computer_generation)
);

create function public.qorpera_set_runtime_office_provider(p_scope jsonb,p_computer_generation bigint,
	p_provider_id uuid,p_policy_sha256 text,p_expected_version bigint,p_preparation_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_provider public.qorpera_runtime_office_providers%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_provider_id is null or coalesce(p_policy_sha256,'') !~ '^[0-9a-f]{64}$'
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991
		or p_expected_version is null or p_expected_version not between 0 and 9007199254740990 or p_preparation_enabled is null then
		raise exception 'Invalid office provider enrollment' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office provider scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation then
		raise exception 'Office provider scope differs' using errcode='42501'; end if;
	select * into v_provider from public.qorpera_runtime_office_providers where office_id=v_office.id
		and computer_generation=v_office.generation for update;
	if not found then
		if p_expected_version<>0 or not p_preparation_enabled or v_office.state not in ('provisioning','recovering')
			or exists(select 1 from public.qorpera_runtime_machine_allocations where office_id=v_office.id
				and computer_generation=v_office.generation) then
			raise exception 'Office provider cannot adopt an allocated generation' using errcode='42501'; end if;
		insert into public.qorpera_runtime_office_providers(office_id,computer_generation,provider_id,policy_sha256,version,preparation_enabled)
		values(v_office.id,v_office.generation,p_provider_id,p_policy_sha256,1,true) returning * into v_provider;
	else
		if v_provider.provider_id<>p_provider_id or v_provider.policy_sha256<>p_policy_sha256 then
			raise exception 'Office provider cannot be rebound' using errcode='42501'; end if;
		if v_provider.version<>p_expected_version then raise exception 'Office provider version differs' using errcode='40001'; end if;
		update public.qorpera_runtime_office_providers set version=version+1,preparation_enabled=p_preparation_enabled
			where office_id=v_office.id and computer_generation=v_office.generation returning * into v_provider;
	end if;
	return jsonb_build_object('providerId',v_provider.provider_id,'policySha256',v_provider.policy_sha256,
		'computerGeneration',v_provider.computer_generation,'version',v_provider.version,'preparationEnabled',v_provider.preparation_enabled);
end
$$;

-- Internal lock order matches start admission: profile, office, provider,
-- then start intent/allocation in the existing implementation.
create function public.qorpera_assert_runtime_office_provider(p_scope jsonb,p_computer_generation bigint,
	p_provider_id uuid,p_policy_sha256 text,p_require_preparation boolean)
returns public.qorpera_runtime_office_providers language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_provider public.qorpera_runtime_office_providers%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_provider_id is null or coalesce(p_policy_sha256,'') !~ '^[0-9a-f]{64}$'
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991 or p_require_preparation is null then
		raise exception 'Invalid office provider authority' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office provider scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation then
		raise exception 'Office provider scope differs' using errcode='42501'; end if;
	select * into v_provider from public.qorpera_runtime_office_providers where office_id=v_office.id
		and computer_generation=v_office.generation for share;
	if not found or v_provider.provider_id<>p_provider_id or v_provider.policy_sha256<>p_policy_sha256
		or (p_require_preparation and not v_provider.preparation_enabled) then
		raise exception 'Office provider authority unavailable' using errcode='42501'; end if;
	return v_provider;
end
$$;

alter function public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text)
	rename to qorpera_reserve_runtime_office_start_unbound;
alter function public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text)
	rename to qorpera_check_runtime_office_start_unbound;

create function public.qorpera_reserve_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_allocation_id uuid,p_instance_sha256 text,p_image_sha256 text,p_bootstrap_sha256 text,p_provider_binding_sha256 text,
	p_provider_id uuid,p_provider_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);
	return public.qorpera_reserve_runtime_office_start_unbound(p_scope,p_computer_generation,p_intent_id,p_allocation_id,
		p_instance_sha256,p_image_sha256,p_bootstrap_sha256,p_provider_binding_sha256);
end
$$;

create function public.qorpera_check_runtime_office_start(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_allocation_id uuid,p_instance_sha256 text,p_provider_binding_sha256 text,p_provider_id uuid,p_provider_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);
	return public.qorpera_check_runtime_office_start_unbound(p_scope,p_computer_generation,p_intent_id,p_allocation_id,
		p_instance_sha256,p_provider_binding_sha256);
end
$$;

-- A configured provider can discover retained demand even after cancellation
-- or preparation-disable, so its local journal can reconcile pending physical
-- outcomes. Metadata grants no preparation, cleanup or capacity release.
create function public.qorpera_runtime_office_provider_status(p_scope jsonb,p_computer_generation bigint,
	p_provider_id uuid,p_provider_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_provider public.qorpera_runtime_office_providers%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	v_provider:=public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_provider.office_id;
	select * into v_intent from public.qorpera_runtime_office_start_intents where office_id=v_office.id
		and computer_generation=v_office.generation for share;
	return jsonb_build_object('schema','qorpera.office-provider-status/v1','scope',public.qorpera_runtime_office_scope(v_office),
		'computerGeneration',v_office.generation,'officeState',v_office.state,
		'providerId',v_provider.provider_id,'providerPolicySha256',v_provider.policy_sha256,
		'providerVersion',v_provider.version,'preparationEnabled',v_provider.preparation_enabled,
		'imageSha256',v_office.image_sha256,'bootstrapSha256',v_office.bootstrap_sha256,
		'intent',case when v_intent.id is null then null else public.qorpera_runtime_office_start_result(v_intent) end,
		'reservation',case when v_intent.allocation_id is null then null else jsonb_build_object('allocationId',v_intent.allocation_id,
			'instanceSha256',v_intent.instance_sha256,'providerBindingSha256',v_intent.provider_binding_sha256) end);
end
$$;

alter table public.qorpera_runtime_office_providers enable row level security;
revoke all on public.qorpera_runtime_office_providers from public,anon,authenticated,service_role;
revoke all on function public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean),
	public.qorpera_reserve_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text,text,text),
	public.qorpera_check_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text),
	public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean),
	public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text,uuid,text),
	public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,uuid,text),
	public.qorpera_runtime_office_provider_status(jsonb,bigint,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean),
	public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text,uuid,text),
	public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,uuid,text),
	public.qorpera_runtime_office_provider_status(jsonb,bigint,uuid,text) to service_role;

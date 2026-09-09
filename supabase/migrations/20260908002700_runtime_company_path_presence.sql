-- Order 4: lossy Company File presence. These tables hold routing secrets and
-- short-lived signing identity only, never activity, working paths or events.
create table public.qorpera_company_presence_secrets (
	environment_id uuid primary key references public.qorpera_company_files(environment_id) on delete cascade,
	secret bytea not null default extensions.gen_random_bytes(32) check (octet_length(secret)=32)
);
create table public.qorpera_native_presence_devices (
	client_id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	run_id uuid not null unique references public.qorpera_execution_runs(id) on delete cascade,
	user_id uuid not null,
	binding jsonb not null check(jsonb_typeof(binding)='object'),
	public_key text not null check(public_key ~ '^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$'),
	expires_at timestamptz not null,
	foreign key(profile_id,user_id) references public.qorpera_profile_members(profile_id,user_id) on delete cascade
);
alter table public.qorpera_company_presence_secrets enable row level security;
alter table public.qorpera_native_presence_devices enable row level security;
revoke all on public.qorpera_company_presence_secrets,public.qorpera_native_presence_devices from public,anon,authenticated,service_role;

create function public.qorpera_presence_paths_valid(p_paths text[])
returns boolean language sql immutable set search_path='' as $$
	select coalesce(array_ndims(p_paths)=1 and cardinality(p_paths) between 1 and 8
		and not exists(select 1 from unnest(p_paths) path where not public.qorpera_company_path_valid(path,true)
			or path is null or cardinality(string_to_array(path,'/'))>16),false)
$$;

-- Path tokens are unguessable without this private secret, unlike hashes of
-- predictable file names. No token is a grant or an object-storage capability.
create function public.qorpera_presence_path_routes(p_actor jsonb,p_paths text[],p_require_target boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_secret bytea; v_path text; v_prefix text; v_parts text[]; v_index integer;
	v_routes jsonb; v_result jsonb:='[]'::jsonb; v_env uuid:=(p_actor->>'environmentId')::uuid;
	v_resource public.qorpera_company_path_resources%rowtype; v_grants jsonb; v_members jsonb;
begin
	if not public.qorpera_presence_paths_valid(p_paths) then raise exception 'Invalid presence paths' using errcode='22023'; end if;
	insert into public.qorpera_company_presence_secrets(environment_id) values(v_env) on conflict do nothing;
	select secret into strict v_secret from public.qorpera_company_presence_secrets where environment_id=v_env;
	-- A retained token must not identify new activity after ACL revocation or
	-- expiry. The policy and membership fingerprint changes the HMAC namespace.
	select coalesce(jsonb_agg(jsonb_build_array(m.user_id,m.role,m.joined_at,coalesce(r.version,0)) order by m.user_id),'[]')
	into v_members from public.qorpera_profile_members m
	left join public.qorpera_runtime_browser_membership_revocations r on r.profile_id=m.profile_id and r.user_id=m.user_id
	where m.profile_id=(p_actor->>'companyId')::uuid;
	foreach v_path in array p_paths loop
		if p_require_target then perform public.qorpera_company_path_require(p_actor,v_path,'read'); end if;
		v_parts:=string_to_array(v_path,'/'); v_routes:='[]'::jsonb;
		for v_index in 0..cardinality(v_parts) loop
			v_prefix:=case when v_index=0 then '' else array_to_string(v_parts[1:v_index],'/') end;
			if public.qorpera_company_path_allowed(p_actor,v_prefix,'read') then
				v_resource:=public.qorpera_company_path_require(p_actor,v_prefix,'read');
				select coalesce(jsonb_agg(jsonb_build_array(g.id,g.permissions,g.expires_at) order by g.id),'[]') into v_grants
				from public.qorpera_company_path_grants g where g.resource_id=v_resource.id and g.resource_version=v_resource.version
					and g.revoked_at is null and (g.expires_at is null or g.expires_at>clock_timestamp());
				v_routes:=v_routes||jsonb_build_array(jsonb_build_object('path',v_prefix,'token',encode(
					extensions.hmac(convert_to(jsonb_build_array(v_prefix,v_resource.id,v_resource.version,v_members,v_grants)::text,'utf8'),v_secret,'sha256'),'hex')));
			end if;
		end loop;
		v_result:=v_result||jsonb_build_array(jsonb_build_object('path',v_path,'routes',v_routes));
	end loop;
	return v_result;
end
$$;

create function public.qorpera_native_presence_register(p_binding jsonb,p_client_id uuid,p_public_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_until timestamptz; v_count integer;
begin
	v_run:=public.qorpera_native_tool_locked_run(p_binding);
	v_actor:=public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	if v_actor->>'audience' is distinct from 'company' then raise exception 'Shared presence audience unavailable' using errcode='42501'; end if;
	if p_client_id is null or p_public_key is null or p_public_key !~ '^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$' then
		raise exception 'Invalid presence signing identity' using errcode='22023'; end if;
	v_until:=clock_timestamp()+interval '30 seconds';
	delete from public.qorpera_native_presence_devices where run_id=v_run.id and expires_at<=clock_timestamp();
	insert into public.qorpera_native_presence_devices(client_id,profile_id,environment_id,run_id,user_id,binding,public_key,expires_at)
	values(p_client_id,v_run.profile_id,v_run.environment_id,v_run.id,v_run.requested_by_user_id,p_binding,p_public_key,v_until)
	on conflict(client_id) do update set expires_at=excluded.expires_at
	where qorpera_native_presence_devices.binding=excluded.binding
		and qorpera_native_presence_devices.public_key=excluded.public_key;
	get diagnostics v_count=row_count;
	if v_count<>1 then raise exception 'Presence identity already registered' using errcode='23505'; end if;
	return jsonb_build_object('schema','qorpera.native-presence-identity/v1','companyId',v_run.profile_id,
		'environmentId',v_run.environment_id,'clientId',p_client_id,'runId',v_run.id,'staffAgentId',v_run.staff_agent_id,
		'publicKey',p_public_key,'expiresAt',floor(extract(epoch from v_until)*1000)::bigint);
end
$$;

-- Caller authorization and subject authorization are separate RPC transactions.
-- Never lock two runs in one presence lookup: normal effects lock their job
-- before the Company File. Presence must not invert that order across runs.
create function public.qorpera_company_presence_scope(p_environment_id uuid,p_binding jsonb,p_paths text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor jsonb;
begin
	v_actor:=public.qorpera_company_path_actor(p_environment_id,p_binding);
	if p_binding is not null and v_actor->>'audience' is distinct from 'company' then
		raise exception 'Shared presence audience unavailable' using errcode='42501'; end if;
	return jsonb_build_object('schema','qorpera.company-presence-scope/v1','companyId',v_actor->>'companyId',
		'environmentId',p_environment_id,'paths',public.qorpera_presence_path_routes(v_actor,p_paths));
end
$$;

-- Host-only resolution authenticates the publisher anew, including native
-- lease, sponsor, membership, run and path grants. It never returns its binding.
create function public.qorpera_native_presence_subject(p_environment_id uuid,p_client_id uuid,p_paths text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_device public.qorpera_native_presence_devices%rowtype; v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Presence host required' using errcode='42501'; end if;
	if p_client_id is null or not public.qorpera_presence_paths_valid(p_paths) then
		raise exception 'Invalid presence lookup' using errcode='22023'; end if;
	select * into v_device from public.qorpera_native_presence_devices
	where client_id=p_client_id and environment_id=p_environment_id and expires_at>clock_timestamp();
	if not found then return null; end if;
	v_actor:=public.qorpera_company_path_actor(p_environment_id,v_device.binding);
	if v_actor->>'audience' is distinct from 'company' then return null; end if;
	if not exists(select 1 from public.qorpera_native_presence_devices where client_id=v_device.client_id
		and binding=v_device.binding and public_key=v_device.public_key and expires_at>clock_timestamp()) then return null; end if;
	return jsonb_build_object('schema','qorpera.native-presence-subject/v1',
		'identity',jsonb_build_object('schema','qorpera.native-presence-identity/v1','companyId',v_device.profile_id,
			'environmentId',v_device.environment_id,'clientId',v_device.client_id,'runId',v_device.run_id,
			'staffAgentId',v_actor->>'staffAgentId','publicKey',v_device.public_key,
			'expiresAt',floor(extract(epoch from v_device.expires_at)*1000)::bigint),
		'paths',public.qorpera_presence_path_routes(v_actor,p_paths,false));
exception when insufficient_privilege then
	-- Keep anonymous/member callers refused; revoked native subjects are absent.
	if auth.role() is distinct from 'service_role' then raise; end if;
	return null;
end
$$;

create function public.qorpera_native_presence_forget(p_binding jsonb,p_client_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Presence host required' using errcode='42501'; end if;
	-- Exact cleanup remains possible after the native run has ended or revoked.
	delete from public.qorpera_native_presence_devices where client_id=p_client_id and binding=p_binding;
end
$$;

revoke all on function public.qorpera_presence_paths_valid(text[]),public.qorpera_presence_path_routes(jsonb,text[],boolean),
	public.qorpera_native_presence_register(jsonb,uuid,text),public.qorpera_company_presence_scope(uuid,jsonb,text[]),
	public.qorpera_native_presence_subject(uuid,uuid,text[]),public.qorpera_native_presence_forget(jsonb,uuid)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_company_presence_scope(uuid,jsonb,text[]) to authenticated,service_role;
grant execute on function public.qorpera_native_presence_register(jsonb,uuid,text),
	public.qorpera_native_presence_subject(uuid,uuid,text[]),public.qorpera_native_presence_forget(jsonb,uuid) to service_role;

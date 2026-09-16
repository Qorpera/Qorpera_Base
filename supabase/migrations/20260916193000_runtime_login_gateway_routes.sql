-- Per-node login gateways (16 Sep 2026). A member login is bridged by the
-- native-provider-login edge function to one provider login gateway. With two
-- symmetric nodes the chooser places logins least-loaded, so a gateway on the
-- wrong node is refused (LOGIN_COMPANY_ADMISSION_REFUSED, seen on the first
-- node-2 login attempt) and the login fails. Each login provider now registers
-- its public gateway URL; the edge function asks the backend which gateway to
-- use and the chooser and the gateway agree on the node. Registration is a
-- service-role write; the choice follows the login placement candidates
-- (least-loaded eligible node that fits), falling back to any registered
-- gateway when no candidate is eligible so a login can still be attempted.

create table public.qorpera_runtime_login_gateways (
	provider_id text primary key check (provider_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	node_id uuid not null references public.qorpera_runtime_nodes(id),
	url text not null check (url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?/$'),
	registered_at timestamptz not null default statement_timestamp()
);
alter table public.qorpera_runtime_login_gateways enable row level security;
revoke all on table public.qorpera_runtime_login_gateways from public, anon, authenticated;
grant select, insert, update, delete on table public.qorpera_runtime_login_gateways to service_role;

create function public.qorpera_register_runtime_login_gateway(p_provider_id text, p_node_id uuid, p_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Login gateway authority required' using errcode = '42501';
	end if;
	if not exists (select 1 from public.qorpera_runtime_node_providers p where p.provider_kind = 'login' and p.provider_id = p_provider_id and p.node_id = p_node_id) then
		raise exception 'Login provider is not enrolled on that node' using errcode = '22023';
	end if;
	insert into public.qorpera_runtime_login_gateways(provider_id, node_id, url) values (p_provider_id, p_node_id, p_url)
	on conflict (provider_id) do update set node_id = excluded.node_id, url = excluded.url, registered_at = statement_timestamp();
	return jsonb_build_object('providerId', p_provider_id, 'nodeId', p_node_id, 'url', p_url);
end
$$;
grant execute on function public.qorpera_register_runtime_login_gateway(text, uuid, text) to service_role;

create function public.qorpera_runtime_login_gateway_choose()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_candidates jsonb; v_pick jsonb; v_gateway public.qorpera_runtime_login_gateways%rowtype; v_reason text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Login gateway authority required' using errcode = '42501';
	end if;
	v_candidates := public.qorpera_runtime_node_placement_candidates('login');
	select c into v_pick from jsonb_array_elements(v_candidates) c
		join public.qorpera_runtime_login_gateways g on g.provider_id = c->>'providerId' and g.node_id = (c->>'nodeId')::uuid
		where (c->>'eligible')::boolean and (c->>'fits')::boolean
		order by (c->>'freeSlots')::bigint desc, (c->>'allocatedCpuMillis')::bigint asc, (c->>'allocatedMemoryBytes')::bigint asc, c->>'nodeId' asc
		limit 1;
	if v_pick is not null then
		select * into v_gateway from public.qorpera_runtime_login_gateways where provider_id = v_pick->>'providerId';
		v_reason := 'LEAST_LOADED';
	else
		select * into v_gateway from public.qorpera_runtime_login_gateways order by registered_at desc, provider_id limit 1;
		v_reason := 'NO_ELIGIBLE_NODE';
	end if;
	if v_gateway.provider_id is null then return jsonb_build_object('url', null, 'reason', 'NO_GATEWAY'); end if;
	return jsonb_build_object('url', v_gateway.url, 'providerId', v_gateway.provider_id, 'nodeId', v_gateway.node_id, 'reason', v_reason);
end
$$;
grant execute on function public.qorpera_runtime_login_gateway_choose() to service_role;

-- Company delete, step D4 (deploy/first-node/RUNTIME-COMPANY-DELETE.md): a deleted company's sign-in
-- (Compute Identity) volumes leave the nodes. A sign-in machine or a run of a node-held identity leaves
-- a custom LXD volume named after the identity on its node; on a node with a shared execution host
-- the volume is also attached to that host. Nothing ever removed either, so the purge waited for good
-- once a company had signed in on a node (holdings "identities").
--
-- Now each node's LXD provider asks for the identities of deleting companies it may hold, once none of
-- the company's machines has been released for ten minutes (a parked execution-host slot keeps an
-- identity mounted up to five). It detaches the execution-host device, deletes the volume, confirms
-- both are gone, and records that here. The ledger has no link to the company, so a provider that lost
-- the reply can still read its receipt after the purge. Holdings wait for every (node, identity) pair
-- the company may have left: each identity that ever had a sign-in machine (only those hold their key
-- on a node volume; a run of such an identity makes the volume on its own node too), on each node where
-- the company had a reserved node demand. A company without node sign-ins (Vault By Default, or none)
-- leaves no pair and purges as before.
--
-- The node inventory keeps accepting the attached device from the company's login demands until the
-- purge, and the purge now waits for the detach, so a node never reports a device it no longer accepts.
-- No new volume can appear once the deletion is requested: every node reservation refuses a paused
-- company, and a deleting company is always paused.
-- Lock order: the company fence (qorpera_lock_profile_gc_fence), then the ledger.

create table public.qorpera_runtime_identity_retirements (
	node_id uuid not null,
	compute_identity_id uuid not null,
	provider_id text not null check (provider_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
	volume text not null check (volume in ('deleted', 'absent')),
	-- 'none': the node has no shared execution host.
	device text not null check (device in ('detached', 'absent', 'none')),
	retired_at timestamptz not null default clock_timestamp(),
	primary key (node_id, compute_identity_id)
);
alter table public.qorpera_runtime_identity_retirements enable row level security;
revoke all on public.qorpera_runtime_identity_retirements from public, anon, authenticated, service_role;

-- Where a company may have left a sign-in volume: each identity that ever had a sign-in machine, on
-- each node where the company had a reserved node demand (a sign-in machine's node, and the nodes its
-- runs made the volume on). This covers every device the node inventory accepts.
create function public.qorpera_company_identity_placements(p_profile_id uuid)
returns table (node_id uuid, compute_identity_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
	select nodes.node_id, identities.compute_identity_id
	from (select distinct demand.node_id
		from public.qorpera_runtime_node_demands as demand
		join public.qorpera_runtime_machine_allocations as allocation on allocation.id = demand.allocation_id
		where allocation.profile_id = p_profile_id and demand.reserved_at is not null) as nodes
	cross join (select distinct allocation.login_compute_identity_id as compute_identity_id
		from public.qorpera_runtime_machine_allocations as allocation
		where allocation.profile_id = p_profile_id and allocation.login_compute_identity_id is not null) as identities
$$;
revoke all on function public.qorpera_company_identity_placements(uuid) from public, anon, authenticated, service_role;

-- The node an LXD provider runs on: its provider id (run and sign-in providers share it) and the host's
-- machine id digest.
create function public.qorpera_runtime_identity_retirement_node(p_provider_id text, p_machine_id_sha256 text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_nodes uuid[];
begin
	if p_provider_id is null or p_provider_id !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_machine_id_sha256 is null or p_machine_id_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'Invalid node provider' using errcode = '22023';
	end if;
	select array_agg(distinct provider.node_id) into v_nodes
	from public.qorpera_runtime_node_providers as provider
	join public.qorpera_runtime_nodes as node on node.id = provider.node_id
	where provider.provider_id = p_provider_id and provider.provider_kind in ('native', 'login')
		and node.machine_id_sha256 = p_machine_id_sha256;
	if coalesce(cardinality(v_nodes), 0) <> 1 then
		raise exception 'Node provider unavailable' using errcode = '42501';
	end if;
	return v_nodes[1];
end
$$;
revoke all on function public.qorpera_runtime_identity_retirement_node(text, text) from public, anon, authenticated, service_role;

-- A deleting company's identities are due once none of its machines is held or was released in the
-- last ten minutes.
create function public.qorpera_company_identities_retirable(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (select 1 from public.qorpera_company_deletions
			where profile_id = p_profile_id and purged_at is null)
		and not exists (select 1 from public.qorpera_runtime_machine_allocations
			where profile_id = p_profile_id
				and (released_at is null or released_at > clock_timestamp() - interval '10 minutes'))
$$;
revoke all on function public.qorpera_company_identities_retirable(uuid) from public, anon, authenticated, service_role;

create function public.qorpera_runtime_identity_retirement_json(p_retirement public.qorpera_runtime_identity_retirements)
returns jsonb
language sql
immutable
set search_path = ''
as $$
	select jsonb_build_object('schema', 'qorpera.identity-retirement/v1', 'nodeId', p_retirement.node_id,
		'computeIdentityId', p_retirement.compute_identity_id, 'volume', p_retirement.volume,
		'device', p_retirement.device, 'retiredAt', p_retirement.retired_at)
$$;
revoke all on function public.qorpera_runtime_identity_retirement_json(public.qorpera_runtime_identity_retirements)
	from public, anon, authenticated, service_role;

-- The identities this node is to retire now, at most 64.
create function public.qorpera_runtime_identity_retirements_due(p_provider_id text, p_machine_id_sha256 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_node uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Node provider required' using errcode = '42501';
	end if;
	v_node := public.qorpera_runtime_identity_retirement_node(p_provider_id, p_machine_id_sha256);
	return jsonb_build_object('schema', 'qorpera.identity-retirements-due/v1', 'nodeId', v_node,
		'computeIdentityIds', coalesce((select jsonb_agg(due.compute_identity_id order by due.compute_identity_id)
			from (select placement.compute_identity_id
				from public.qorpera_company_deletions as deletion
				cross join lateral public.qorpera_company_identity_placements(deletion.profile_id) as placement
				where deletion.purged_at is null and placement.node_id = v_node
					and public.qorpera_company_identities_retirable(deletion.profile_id)
					and not exists (select 1 from public.qorpera_runtime_identity_retirements as retired
						where retired.node_id = v_node and retired.compute_identity_id = placement.compute_identity_id)
				order by placement.compute_identity_id
				limit 64) as due), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_runtime_identity_retirements_due(text, text) from public, anon, authenticated;
grant execute on function public.qorpera_runtime_identity_retirements_due(text, text) to service_role;

-- The node's provider found the identity's volume and execution-host device gone (or removed them).
-- A replay answers the same receipt, also after the purge. A provider that lost the reply finds what it
-- removed already gone, so a replay may report 'absent' where the receipt says 'deleted' or 'detached'.
create function public.qorpera_confirm_runtime_identity_retirement(p_provider_id text, p_machine_id_sha256 text,
	p_compute_identity_id uuid, p_evidence jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_node uuid;
	v_profile uuid;
	v_retirement public.qorpera_runtime_identity_retirements%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Node provider required' using errcode = '42501';
	end if;
	if p_compute_identity_id is null or jsonb_typeof(p_evidence) is distinct from 'object'
		or p_evidence - array['schema', 'volume', 'device'] <> '{}'::jsonb
		or p_evidence ->> 'schema' is distinct from 'qorpera.identity-retirement-evidence/v1'
		or p_evidence ->> 'volume' is null or p_evidence ->> 'volume' not in ('deleted', 'absent')
		or p_evidence ->> 'device' is null or p_evidence ->> 'device' not in ('detached', 'absent', 'none') then
		raise exception 'Invalid identity retirement evidence' using errcode = '22023';
	end if;
	v_node := public.qorpera_runtime_identity_retirement_node(p_provider_id, p_machine_id_sha256);
	select profile_id into v_profile from public.qorpera_member_compute_identities where id = p_compute_identity_id;
	if found then
		perform public.qorpera_lock_profile_gc_fence(v_profile);
	end if;
	select * into v_retirement from public.qorpera_runtime_identity_retirements
	where node_id = v_node and compute_identity_id = p_compute_identity_id;
	if found then
		if v_retirement.provider_id <> p_provider_id
			or (v_retirement.volume <> p_evidence ->> 'volume' and p_evidence ->> 'volume' <> 'absent')
			or (v_retirement.device <> p_evidence ->> 'device'
				and not (v_retirement.device = 'detached' and p_evidence ->> 'device' = 'absent')) then
			raise exception 'Identity retirement differs' using errcode = '42501';
		end if;
		return public.qorpera_runtime_identity_retirement_json(v_retirement);
	end if;
	if v_profile is null or not exists (select 1 from public.qorpera_company_identity_placements(v_profile) as placement
			where placement.node_id = v_node and placement.compute_identity_id = p_compute_identity_id) then
		raise exception 'Identity retirement unavailable' using errcode = '42501';
	end if;
	if not public.qorpera_company_identities_retirable(v_profile) then
		raise exception 'Identity retirement is not due' using errcode = '55000';
	end if;
	insert into public.qorpera_runtime_identity_retirements (node_id, compute_identity_id, provider_id, volume, device)
	values (v_node, p_compute_identity_id, p_provider_id, p_evidence ->> 'volume', p_evidence ->> 'device')
	returning * into v_retirement;
	return public.qorpera_runtime_identity_retirement_json(v_retirement);
end
$$;
revoke all on function public.qorpera_confirm_runtime_identity_retirement(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_confirm_runtime_identity_retirement(text, text, uuid, jsonb) to service_role;

-- Holdings: "identities" counts the company's (node, identity) placements not yet retired. Before, it
-- counted every identity that ever had a sign-in machine, released or not, and nothing retired them.
do $guard$
begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_company_node_holdings(uuid)'::regprocedure), 'sha256'), 'hex')
		<> 'bcbbe0c8b8c52ac24abeaafd220d6553baf3cc83f025ce0ffbedfc989fa589da' then
		raise exception 'Reviewed function definition changed: public.qorpera_company_node_holdings(uuid)';
	end if;
end
$guard$;
create or replace function public.qorpera_company_node_holdings(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'machines', (select count(*) from public.qorpera_runtime_machine_allocations as allocation
			where allocation.profile_id = p_profile_id and allocation.released_at is null),
		'identities', (select count(*) from public.qorpera_company_identity_placements(p_profile_id) as placement
			where not exists (select 1 from public.qorpera_runtime_identity_retirements as retired
				where retired.node_id = placement.node_id and retired.compute_identity_id = placement.compute_identity_id)),
		'node_updates', (select count(*) from (
			select distinct on (target.node_id) target.company_ids
			from public.qorpera_node_update_targets as target
			order by target.node_id, target.revision desc) as latest
			where p_profile_id = any(latest.company_ids)))
$$;
revoke all on function public.qorpera_company_node_holdings(uuid) from public, anon, authenticated, service_role;

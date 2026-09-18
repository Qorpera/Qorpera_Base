-- Governed replacement of a node's inventory policy (17 Sep 2026). The policy
-- was enrolled once and immutable: node 1's policy still reserved two image-
-- build VMs that were deleted after the capacity amendment, so the node could
-- not gain the standard slots the amendment sizes for. A replacement keeps the
-- previous policy in a history table, requires the caller to name the exact
-- previous digest, and re-runs the enrolment validation for the new policy.
-- The node's observer must be reconfigured to the new policy in the same
-- pass: until it reports the new digest its observations do not resolve.

create table public.qorpera_runtime_node_inventory_policy_history (
	node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
	policy jsonb not null,
	policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
	enrolled_at timestamptz not null,
	replaced_at timestamptz not null default clock_timestamp(),
	replaced_by_sha256 text not null check (replaced_by_sha256 ~ '^[0-9a-f]{64}$'),
	primary key (node_id, policy_sha256, replaced_at)
);
alter table public.qorpera_runtime_node_inventory_policy_history enable row level security;
revoke all on table public.qorpera_runtime_node_inventory_policy_history from public, anon, authenticated;
grant select on table public.qorpera_runtime_node_inventory_policy_history to service_role;

create function public.qorpera_replace_runtime_node_inventory(p_policy jsonb, p_previous_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_previous public.qorpera_runtime_node_inventory_policies%rowtype; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_previous_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Node inventory authority required' using errcode = '42501'; end if;
	begin v_id := (p_policy->>'nodeId')::uuid;
	exception when others then raise exception 'Invalid node inventory identity' using errcode = '42501'; end;
	select * into v_previous from public.qorpera_runtime_node_inventory_policies where node_id = v_id for update;
	if not found then raise exception 'Node inventory policy is not enrolled' using errcode = '42501'; end if;
	if v_previous.policy_sha256 <> p_previous_sha256 then
		raise exception 'Node inventory policy changed' using errcode = '40001'; end if;
	if v_previous.policy = p_policy then
		return jsonb_build_object('nodeId', v_id, 'policySha256', v_previous.policy_sha256, 'replaced', false); end if;
	insert into public.qorpera_runtime_node_inventory_policy_history(node_id, policy, policy_sha256, enrolled_at, replaced_by_sha256)
	values (v_id, v_previous.policy, v_previous.policy_sha256, v_previous.enrolled_at, encode(extensions.digest(p_policy::text,'sha256'),'hex'));
	delete from public.qorpera_runtime_node_inventory_policies where node_id = v_id;
	-- The enrolment validates host identity, infrastructure shape and headroom exactly as for a first enrolment.
	v_result := public.qorpera_enroll_runtime_node_inventory(p_policy);
	return v_result || jsonb_build_object('replaced', true, 'previousSha256', p_previous_sha256);
end
$$;
grant execute on function public.qorpera_replace_runtime_node_inventory(jsonb, text) to service_role;

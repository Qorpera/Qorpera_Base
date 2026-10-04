-- Agent exit E2d, part 1 of 2: the exit's health reaches the database (20260930037000). Inert: nothing reads it until
-- part 2 (20260930037100) puts it in placement. Contract: section 19, 2026-10-03 amendment "agent traffic leaves through
-- the agent exit", item 10. Design: deploy/first-node/RUNTIME-AGENT-EXIT.md §3 ("Health"), §12. Rollout:
-- deploy/agent-exit/ROLLOUT.md: every node's exit, then this migration, then the node observer that posts to it; part 2
-- only once every node reports a healthy exit (there is no switch).
--
-- The node observer reads the exit's own answer (/run/qorpera-agent-exit/health.json, written every 10 s by
-- `qorpera-agent-exit.sh health`) and posts it through qorpera_observe_runtime_node_agent_exit, apart from the node's
-- inventory observation: an unhealthy exit stops agent road machines only, never runs or sign-ins (the platform road).
-- Only the answer (healthy, a problem count, when it was checked) reaches the database; the exit's problem texts name
-- instances and addresses and stay on the node.
--
-- A node's exit is ready (qorpera_runtime_node_agent_exit_ready) while its latest answer is healthy, at most 60 seconds
-- old by the observer's clock and by the exit's own check.

set local lock_timeout = '3s';

create table public.qorpera_runtime_node_agent_exit (
	node_id uuid primary key references public.qorpera_runtime_nodes(id) on delete restrict,
	observation_id uuid not null,
	observed_at timestamptz not null check (isfinite(observed_at)),
	checked_at timestamptz check (checked_at is null or isfinite(checked_at)),
	healthy boolean not null,
	problem_count integer not null check (problem_count between 0 and 1000),
	received_at timestamptz not null default clock_timestamp(),
	check (not healthy or (checked_at is not null and problem_count = 0))
);
alter table public.qorpera_runtime_node_agent_exit enable row level security;
revoke all on public.qorpera_runtime_node_agent_exit from public, anon, authenticated, service_role;

create function public.qorpera_assert_runtime_node_agent_exit(p_value jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare k text;
begin
	if not public.qorpera_node_health_object(p_value, array['schema','nodeId','machineIdSha256','policySha256',
		'observationId','observedAt','checkedAt','healthy','problemCount'])
		or octet_length(p_value::text) > 4096 or p_value->>'schema' is distinct from 'qorpera.runtime-node-agent-exit/v1'
		or jsonb_typeof(p_value->'healthy') is distinct from 'boolean'
		or not public.qorpera_node_health_uint(p_value->'problemCount', 1000) then
		raise exception 'Invalid agent exit health record' using errcode = '22023';
	end if;
	foreach k in array array['nodeId','observationId'] loop
		if jsonb_typeof(p_value->k) is distinct from 'string'
			or p_value->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid agent exit health identity' using errcode = '22023';
		end if;
	end loop;
	foreach k in array array['machineIdSha256','policySha256'] loop
		if jsonb_typeof(p_value->k) is distinct from 'string' or p_value->>k !~ '^[0-9a-f]{64}$' then
			raise exception 'Invalid agent exit health binding' using errcode = '22023';
		end if;
	end loop;
	perform public.qorpera_node_health_time(p_value->'observedAt');
	if p_value->'checkedAt' <> 'null'::jsonb then perform public.qorpera_node_health_time(p_value->'checkedAt'); end if;
	-- Healthy means the exit's own check said so, with no problem: an answer the observer could not read is unhealthy.
	if (p_value->>'healthy')::boolean and (p_value->'checkedAt' = 'null'::jsonb or (p_value->>'problemCount')::integer <> 0) then
		raise exception 'A healthy agent exit has a check and no problem' using errcode = '22023';
	end if;
end
$$;

create function public.qorpera_observe_runtime_node_agent_exit(p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_observation uuid; v_at timestamptz; v_checked timestamptz; v_kept public.qorpera_runtime_node_agent_exit%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Node observer required' using errcode = '42501'; end if;
	perform public.qorpera_assert_runtime_node_agent_exit(p_observation);
	v_id := (p_observation->>'nodeId')::uuid; v_observation := (p_observation->>'observationId')::uuid;
	if not exists (select 1 from public.qorpera_runtime_nodes n join public.qorpera_runtime_node_inventory_policies p on p.node_id = n.id
		where n.id = v_id and n.machine_id_sha256 = p_observation->>'machineIdSha256' and p.policy_sha256 = p_observation->>'policySha256') then
		raise exception 'Agent exit health host or policy differs' using errcode = '42501';
	end if;
	v_at := public.qorpera_node_health_time(p_observation->'observedAt');
	if v_at > clock_timestamp() + interval '2 seconds' or v_at < clock_timestamp() - interval '60 seconds' then
		raise exception 'Agent exit health observation is not current' using errcode = '22023';
	end if;
	v_checked := case when p_observation->'checkedAt' = 'null'::jsonb then null
		else public.qorpera_node_health_time(p_observation->'checkedAt') end;
	-- Only the latest answer is kept. Out-of-order delivery never replaces a newer one, and a replay changes nothing.
	insert into public.qorpera_runtime_node_agent_exit(node_id, observation_id, observed_at, checked_at, healthy, problem_count)
		values (v_id, v_observation, v_at, v_checked, (p_observation->>'healthy')::boolean, (p_observation->>'problemCount')::integer)
		on conflict (node_id) do update set observation_id = excluded.observation_id, observed_at = excluded.observed_at,
			checked_at = excluded.checked_at, healthy = excluded.healthy, problem_count = excluded.problem_count,
			received_at = clock_timestamp()
		where (excluded.observed_at, excluded.observation_id)
			> (qorpera_runtime_node_agent_exit.observed_at, qorpera_runtime_node_agent_exit.observation_id);
	select * into strict v_kept from public.qorpera_runtime_node_agent_exit where node_id = v_id;
	return jsonb_build_object('nodeId', v_id, 'observationId', v_kept.observation_id, 'observedAt', v_kept.observed_at,
		'healthy', v_kept.healthy);
end
$$;

-- The node's exit takes agent road machines: its latest answer is healthy and current, by the observer's clock and by
-- the exit's own check.
create function public.qorpera_runtime_node_agent_exit_ready(p_node_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select e.healthy and e.observed_at > clock_timestamp() - interval '60 seconds'
		and e.observed_at <= clock_timestamp() + interval '2 seconds'
		and e.checked_at > clock_timestamp() - interval '60 seconds' and e.checked_at <= clock_timestamp() + interval '2 seconds'
		from public.qorpera_runtime_node_agent_exit e where e.node_id = p_node_id), false)
$$;

revoke all on function public.qorpera_assert_runtime_node_agent_exit(jsonb), public.qorpera_observe_runtime_node_agent_exit(jsonb),
	public.qorpera_runtime_node_agent_exit_ready(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_observe_runtime_node_agent_exit(jsonb), public.qorpera_runtime_node_agent_exit_ready(uuid)
	to service_role;

-- Company delete, step D3a (deploy/first-node/RUNTIME-COMPANY-DELETE.md): a deleted company's Company
-- Computers are retired for good. D1 makes a deleting company's office idle check request power_off.
-- After that power-off (stop acknowledged, node demand suspended), the office provider asks here for
-- retirement, takes a short challenge, deletes the VM under its operation journal, confirms it is
-- absent, and then one call releases the allocation (the release trigger releases the node demand),
-- drops the node instance binding, sets the office 'retired' and cancels its start intent. Only then
-- does the company hold no machine, so the finisher can purge it.
-- New functions only: no existing reply changes, so providers without the retirement step are
-- unaffected. The ledger has no link to the company and outlives the purge, so a provider that lost
-- the reply to its retire call can still read its receipt afterwards and stop for good.
-- Lock order: the company fence and the office (qorpera_assert_runtime_office_provider), the
-- activation, the allocation, the lifecycle transition, then the ledger.

-- The purge's "rows of another company" check read every profile_id column as a company id. Two tables
-- of the Company Computer's browser use profile_id for a browser profile, so a company whose computer
-- had a browser was refused for good once its computer could be retired. They are skipped now.
do $guard$
begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_purge_company(uuid)'::regprocedure), 'sha256'), 'hex')
		<> '5bfe9b2c60aa205b166e7361ec0d6beb9a725441b0f9c0f2688daf2c15727346' then
		raise exception 'Reviewed function definition changed: public.qorpera_purge_company(uuid)';
	end if;
end
$guard$;
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_purge_company(uuid)'::regprocedure);
	v_old text := E'\t\t\tand company_column.attname = ''profile_id'' and not company_column.attisdropped\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Company purge differs';
	end if;
	execute replace(v_definition, v_old, v_old
		|| E'\t\twhere found.table_id not in (''public.qorpera_runtime_browser_grants''::regclass,\n'
		|| E'\t\t\t''public.qorpera_runtime_office_browser_opens''::regclass)\n');
end
$$;

create table public.qorpera_runtime_office_retirements (
	office_id uuid not null,
	computer_generation bigint not null,
	profile_id uuid not null,
	provider_id uuid not null,
	provider_policy_sha256 text not null check (provider_policy_sha256 ~ '^[0-9a-f]{64}$'),
	allocation_id uuid not null unique,
	instance_sha256 text not null check (instance_sha256 ~ '^[0-9a-f]{64}$'),
	transition_id uuid not null unique,
	-- The provider journals the LXD delete under this id; it is issued here, once.
	delete_command_id uuid not null unique default extensions.gen_random_uuid(),
	requested_at timestamptz not null default clock_timestamp(),
	delete_operation_id text check (delete_operation_id is null or char_length(delete_operation_id) between 1 and 200),
	retired_at timestamptz,
	primary key (office_id, computer_generation),
	check ((retired_at is null) = (delete_operation_id is null))
);
alter table public.qorpera_runtime_office_retirements enable row level security;
revoke all on public.qorpera_runtime_office_retirements from public, anon, authenticated, service_role;

create table public.qorpera_runtime_office_retirement_challenges (
	id uuid primary key,
	office_id uuid not null,
	computer_generation bigint not null,
	issued_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	check (expires_at = issued_at + interval '5 seconds')
);
alter table public.qorpera_runtime_office_retirement_challenges enable row level security;
revoke all on public.qorpera_runtime_office_retirement_challenges from public, anon, authenticated, service_role;
create index qorpera_runtime_office_retirement_challenges_office
	on public.qorpera_runtime_office_retirement_challenges (office_id, computer_generation);

create function public.qorpera_runtime_office_retirement_json(p_retirement public.qorpera_runtime_office_retirements)
returns jsonb
language sql
immutable
set search_path = ''
as $$
	select jsonb_build_object('schema', 'qorpera.office-retirement/v1',
		'companyComputerId', p_retirement.office_id, 'computerGeneration', p_retirement.computer_generation,
		'allocationId', p_retirement.allocation_id, 'instanceSha256', p_retirement.instance_sha256,
		'transitionId', p_retirement.transition_id, 'deleteCommandId', p_retirement.delete_command_id,
		'deleteOperationId', p_retirement.delete_operation_id,
		'state', case when p_retirement.retired_at is null then 'retiring' else 'retired' end)
$$;
revoke all on function public.qorpera_runtime_office_retirement_json(public.qorpera_runtime_office_retirements)
	from public, anon, authenticated, service_role;

-- Checks a power_off request against the office's current state and answers the retirement row, or
-- null when the office is not to be retired (its company is not being deleted). Creates the row once.
-- Refuses (42501) while anything could still bring the VM back or holds it: the stop not yet
-- acknowledged, the node demand not suspended, a later transition or a boot intent for this one, an
-- open root reset.
create function public.qorpera_lock_runtime_office_retirement(p_request jsonb)
returns public.qorpera_runtime_office_retirements
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_office public.qorpera_runtime_offices%rowtype;
	v_retirement public.qorpera_runtime_office_retirements%rowtype;
begin
	if p_request ->> 'action' is distinct from 'power_off' then
		raise exception 'Office retirement follows a power_off' using errcode = '22023';
	end if;
	-- The provider, office (maintenance), activation, unreleased allocation and transition checks.
	v_transition := public.qorpera_lock_runtime_office_stop(p_request);
	select * into strict v_office from public.qorpera_runtime_offices where id = v_transition.office_id;
	if not public.qorpera_company_deleting(v_office.profile_id) then return null; end if;
	if not exists (select 1 from public.qorpera_runtime_office_stops where transition_id = v_transition.id)
		or exists (select 1 from public.qorpera_runtime_node_demands as demand
			where demand.allocation_id = v_transition.allocation_id and demand.suspended_at is null
				and demand.released_at is null)
		or exists (select 1 from public.qorpera_runtime_office_lifecycle_transitions as later
			where later.office_id = v_office.id and later.id <> v_transition.id
				and later.requested_at > v_transition.requested_at)
		or exists (select 1 from public.qorpera_runtime_office_boot_intents where transition_id = v_transition.id)
		or exists (select 1 from public.qorpera_runtime_office_resets as reset
			where reset.office_id = v_office.id and reset.phase <> 'active') then
		raise exception 'Office is not ready to retire' using errcode = '42501';
	end if;
	insert into public.qorpera_runtime_office_retirements (office_id, computer_generation, profile_id, provider_id,
		provider_policy_sha256, allocation_id, instance_sha256, transition_id)
	values (v_office.id, v_office.generation, v_office.profile_id, (p_request ->> 'providerId')::uuid,
		p_request ->> 'providerPolicySha256', v_transition.allocation_id, p_request #>> '{startup,instanceSha256}',
		v_transition.id)
	on conflict (office_id, computer_generation) do nothing;
	select * into strict v_retirement from public.qorpera_runtime_office_retirements
	where office_id = v_office.id and computer_generation = v_office.generation for update;
	if v_retirement.transition_id <> v_transition.id or v_retirement.allocation_id <> v_transition.allocation_id
		or v_retirement.provider_id::text <> p_request ->> 'providerId'
		or v_retirement.provider_policy_sha256 <> p_request ->> 'providerPolicySha256'
		or v_retirement.instance_sha256 <> p_request #>> '{startup,instanceSha256}' then
		raise exception 'Office retirement differs' using errcode = '42501';
	end if;
	return v_retirement;
end
$$;
revoke all on function public.qorpera_lock_runtime_office_retirement(jsonb) from public, anon, authenticated, service_role;

-- The provider asks after its power_off: null (keep the office), or the retirement with the delete
-- command id to journal. After the retirement completed it answers the retired receipt.
create function public.qorpera_runtime_office_retirement(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_retirement public.qorpera_runtime_office_retirements%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Office provider required' using errcode = '42501';
	end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	select * into v_retirement from public.qorpera_runtime_office_retirements
	where transition_id = (p_request ->> 'transitionId')::uuid and retired_at is not null;
	if found then
		if v_retirement.provider_id::text <> p_request ->> 'providerId'
			or v_retirement.provider_policy_sha256 <> p_request ->> 'providerPolicySha256' then
			raise exception 'Office retirement differs' using errcode = '42501';
		end if;
		return public.qorpera_runtime_office_retirement_json(v_retirement);
	end if;
	v_retirement := public.qorpera_lock_runtime_office_retirement(p_request);
	if v_retirement.office_id is null then return null; end if;
	return public.qorpera_runtime_office_retirement_json(v_retirement);
end
$$;
revoke all on function public.qorpera_runtime_office_retirement(jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_runtime_office_retirement(jsonb) to service_role;

-- A five-second window for dispatching the delete, bound to a fresh check of everything above. At most
-- 64 windows per retirement.
create function public.qorpera_prepare_runtime_office_retirement(p_request jsonb, p_challenge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_retirement public.qorpera_runtime_office_retirements%rowtype;
	v_challenge public.qorpera_runtime_office_retirement_challenges%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Office provider required' using errcode = '42501';
	end if;
	if p_challenge_id is null then
		raise exception 'Office retirement challenge is required' using errcode = '22023';
	end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	v_retirement := public.qorpera_lock_runtime_office_retirement(p_request);
	if v_retirement.office_id is null or v_retirement.retired_at is not null
		or p_challenge_id = v_retirement.delete_command_id then
		raise exception 'Office retirement is unavailable' using errcode = '42501';
	end if;
	select * into v_challenge from public.qorpera_runtime_office_retirement_challenges where id = p_challenge_id;
	if found then
		if v_challenge.office_id <> v_retirement.office_id
			or v_challenge.computer_generation <> v_retirement.computer_generation then
			raise exception 'Office retirement challenge differs' using errcode = '42501';
		end if;
	else
		if (select count(*) from public.qorpera_runtime_office_retirement_challenges
			where office_id = v_retirement.office_id and computer_generation = v_retirement.computer_generation) >= 64 then
			raise exception 'Office retirement challenges are exhausted' using errcode = '54000';
		end if;
		insert into public.qorpera_runtime_office_retirement_challenges (id, office_id, computer_generation, issued_at, expires_at)
		values (p_challenge_id, v_retirement.office_id, v_retirement.computer_generation, clock_timestamp(),
			clock_timestamp() + interval '5 seconds')
		returning * into v_challenge;
	end if;
	return jsonb_build_object('schema', 'qorpera.office-retirement-challenge/v1', 'challengeId', v_challenge.id,
		'deleteCommandId', v_retirement.delete_command_id,
		'expiresInMs', greatest(0, floor(extract(epoch from (v_challenge.expires_at - clock_timestamp())) * 1000))::integer);
end
$$;
revoke all on function public.qorpera_prepare_runtime_office_retirement(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_prepare_runtime_office_retirement(jsonb, uuid) to service_role;

-- The VM is gone (the provider journaled the delete under deleteCommandId and confirmed its absence):
-- release its capacity and retire the office. The same evidence answers the same receipt again.
create function public.qorpera_retire_runtime_office(p_request jsonb, p_evidence jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_retirement public.qorpera_runtime_office_retirements%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Office provider required' using errcode = '42501';
	end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	if jsonb_typeof(p_evidence) is distinct from 'object'
		or p_evidence - array['schema', 'deleteCommandId', 'deleteOperationId'] <> '{}'::jsonb
		or p_evidence ->> 'schema' is distinct from 'qorpera.office-retirement-evidence/v1'
		or jsonb_typeof(p_evidence -> 'deleteCommandId') is distinct from 'string'
		or jsonb_typeof(p_evidence -> 'deleteOperationId') is distinct from 'string'
		or char_length(p_evidence ->> 'deleteOperationId') not between 1 and 200 then
		raise exception 'Invalid office retirement evidence' using errcode = '22023';
	end if;
	select * into v_retirement from public.qorpera_runtime_office_retirements
	where transition_id = (p_request ->> 'transitionId')::uuid and retired_at is not null;
	if found then
		if v_retirement.delete_command_id::text <> p_evidence ->> 'deleteCommandId'
			or v_retirement.delete_operation_id <> p_evidence ->> 'deleteOperationId'
			or v_retirement.provider_id::text <> p_request ->> 'providerId'
			or v_retirement.provider_policy_sha256 <> p_request ->> 'providerPolicySha256' then
			raise exception 'Office retirement differs' using errcode = '42501';
		end if;
		return public.qorpera_runtime_office_retirement_json(v_retirement);
	end if;
	v_retirement := public.qorpera_lock_runtime_office_retirement(p_request);
	if v_retirement.office_id is null or v_retirement.delete_command_id::text <> p_evidence ->> 'deleteCommandId'
		or not exists (select 1 from public.qorpera_runtime_office_retirement_challenges
			where office_id = v_retirement.office_id and computer_generation = v_retirement.computer_generation) then
		raise exception 'Office retirement differs' using errcode = '42501';
	end if;
	-- The node demand follows the allocation's release (qorpera_release_runtime_node_machine); it was
	-- suspended, so the computer-hours meter already ended its stretch.
	update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
	where id = v_retirement.allocation_id and released_at is null;
	delete from public.qorpera_runtime_node_instance_bindings where allocation_id = v_retirement.allocation_id;
	update public.qorpera_runtime_offices set state = 'retired', revision = revision + 1 where id = v_retirement.office_id;
	update public.qorpera_runtime_office_start_intents set state = 'cancelled', cancelled_at = coalesce(cancelled_at, clock_timestamp())
	where office_id = v_retirement.office_id and computer_generation = v_retirement.computer_generation and state <> 'cancelled';
	update public.qorpera_runtime_office_retirements
	set retired_at = clock_timestamp(), delete_operation_id = p_evidence ->> 'deleteOperationId'
	where office_id = v_retirement.office_id and computer_generation = v_retirement.computer_generation
	returning * into v_retirement;
	return public.qorpera_runtime_office_retirement_json(v_retirement);
end
$$;
revoke all on function public.qorpera_retire_runtime_office(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_retire_runtime_office(jsonb, jsonb) to service_role;

-- What a provider reads when its office is gone (the company was purged): the retired receipt, if any.
-- Reads only the ledger, which has no link to the company.
create function public.qorpera_runtime_office_retirement_receipt(p_scope jsonb, p_computer_generation bigint,
	p_provider_id uuid, p_provider_policy_sha256 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_retirement public.qorpera_runtime_office_retirements%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Office provider required' using errcode = '42501';
	end if;
	select * into v_retirement from public.qorpera_runtime_office_retirements
	where office_id = (p_scope ->> 'companyComputerId')::uuid and computer_generation = p_computer_generation
		and provider_id = p_provider_id and provider_policy_sha256 = p_provider_policy_sha256 and retired_at is not null;
	if not found then return null; end if;
	return public.qorpera_runtime_office_retirement_json(v_retirement);
end
$$;
revoke all on function public.qorpera_runtime_office_retirement_receipt(jsonb, bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.qorpera_runtime_office_retirement_receipt(jsonb, bigint, uuid, text) to service_role;

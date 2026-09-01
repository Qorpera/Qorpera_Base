-- Contract section 7.4 (ratified 2026-09-01, low priority; Order 1 placement
-- in section 19): kernel-owned per-company spend and token ceilings per
-- period for sponsors with no provider-side usage wall, such as company
-- API-billing accounts. Enforced at run admission by the control plane, never
-- by model prose; a tripped ceiling notifies the founder from the control
-- plane, not from the agent that tripped it. Subscription-sponsored runs are
-- bounded by the provider's own usage limits and the section 17 usage-limit
-- signal instead. Wake-rate ceilings, the running-machine ceiling and the
-- founder stop land with Orders 3 and 4.

create table public.qorpera_company_execution_ceilings (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	period text not null default 'month' check (period in ('month')),
	spend_microusd_per_period bigint not null check (spend_microusd_per_period between 1 and 9007199254740991),
	tokens_per_period bigint not null check (tokens_per_period between 1 and 9007199254740991),
	version bigint not null default 1 check (version > 0),
	updated_by_user_id uuid not null references auth.users(id) on delete restrict,
	updated_at timestamptz not null default statement_timestamp()
);
alter table public.qorpera_company_execution_ceilings enable row level security;
revoke all on public.qorpera_company_execution_ceilings from public,anon,authenticated,service_role;

-- Durable evidence of every refused admission: what was attempted, what the
-- period already held, and the ceiling that held. Identities only. The run
-- id is retained without a foreign key because admission callers delete the
-- refused run in the same transaction.
create table public.qorpera_company_ceiling_trips (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	run_id uuid not null,
	period_start timestamptz not null,
	dimension text not null check (dimension in ('spend','tokens')),
	attempted bigint not null check (attempted >= 0),
	used bigint not null check (used >= 0),
	ceiling bigint not null check (ceiling > 0),
	tripped_at timestamptz not null default clock_timestamp()
);
create index qorpera_company_ceiling_trips_profile on public.qorpera_company_ceiling_trips(profile_id,tripped_at desc);
alter table public.qorpera_company_ceiling_trips enable row level security;
revoke all on public.qorpera_company_ceiling_trips from public,anon,authenticated,service_role;

-- Every company has ceilings: a configured row, else the kernel default.
create function public.qorpera_company_execution_ceiling(p_profile_id uuid)
returns table (spend_microusd_per_period bigint,tokens_per_period bigint,configured boolean,version bigint)
language sql stable security definer set search_path = '' as $$
	select coalesce(ceiling.spend_microusd_per_period,250000000::bigint),
		coalesce(ceiling.tokens_per_period,100000000::bigint),
		ceiling.profile_id is not null,coalesce(ceiling.version,0::bigint)
	from (select null::uuid dummy) singleton
	left join public.qorpera_company_execution_ceilings ceiling on ceiling.profile_id = p_profile_id
$$;

create function public.qorpera_company_execution_ceiling_json(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_ceiling record; v_period_start timestamptz := date_trunc('month',statement_timestamp());
	v_spend_used bigint; v_tokens_used bigint;
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'company ceiling access denied' using errcode = '42501'; end if;
	select * into strict v_ceiling from public.qorpera_company_execution_ceiling(p_profile_id);
	select coalesce(sum(coalesce(reservation.actual_microusd,reservation.reserved_microusd)),0),
		coalesce(sum(policy.max_input_tokens + policy.max_output_tokens),0)
	into v_spend_used,v_tokens_used
	from public.qorpera_execution_sponsor_reservations reservation
	join public.qorpera_provider_connection_versions version
		on version.connection_id = reservation.provider_connection_id
		and version.version = reservation.provider_connection_version
	left join public.qorpera_runner_model_policies policy on policy.job_id = reservation.job_id
	where reservation.profile_id = p_profile_id and reservation.period_start = v_period_start
		and version.authentication_mode <> 'native_subscription';
	return jsonb_build_object('schema','qorpera.company-execution-ceiling/v1','profile_id',p_profile_id,
		'period','month','period_start',v_period_start,'configured',v_ceiling.configured,'version',v_ceiling.version,
		'spend_microusd_per_period',v_ceiling.spend_microusd_per_period,'tokens_per_period',v_ceiling.tokens_per_period,
		'spend_microusd_used',v_spend_used,'tokens_used',v_tokens_used,
		'trips',(select count(*) from public.qorpera_company_ceiling_trips trip
			where trip.profile_id = p_profile_id and trip.period_start = v_period_start));
end
$$;

create function public.qorpera_set_company_execution_ceiling(
	p_profile_id uuid,p_spend_microusd_per_period bigint,p_tokens_per_period bigint,p_expected_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role; v_current bigint;
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = auth.uid();
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'company ceilings require founder authority' using errcode = '42501'; end if;
	if p_spend_microusd_per_period is null or p_spend_microusd_per_period < 1
		or p_tokens_per_period is null or p_tokens_per_period < 1 or p_expected_version is null then
		raise exception 'company ceiling is invalid' using errcode = '22023'; end if;
	select version into v_current from public.qorpera_company_execution_ceilings where profile_id = p_profile_id for update;
	if coalesce(v_current,0) <> p_expected_version then
		raise exception 'company ceiling version conflict' using errcode = 'PT412'; end if;
	insert into public.qorpera_company_execution_ceilings(profile_id,spend_microusd_per_period,tokens_per_period,
		version,updated_by_user_id)
	values (p_profile_id,p_spend_microusd_per_period,p_tokens_per_period,1,auth.uid())
	on conflict (profile_id) do update set spend_microusd_per_period = excluded.spend_microusd_per_period,
		tokens_per_period = excluded.tokens_per_period,version = qorpera_company_execution_ceilings.version + 1,
		updated_by_user_id = excluded.updated_by_user_id,updated_at = statement_timestamp();
	return public.qorpera_company_execution_ceiling_json(p_profile_id);
end
$$;

-- Admission refuses a run whose sponsor has no provider-side usage wall when
-- the company's period spend or token ceiling would be exceeded, records the
-- trip, and notifies the founders. The existing per-connection quota and
-- concurrency checks are unchanged. CREATE OR REPLACE preserves the
-- production owner of this function.
create or replace function public.qorpera_reserve_execution_sponsor_authority(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_existing public.qorpera_execution_sponsor_reservations%rowtype;
	v_period_start timestamptz := date_trunc('month', statement_timestamp());
	v_monthly bigint;
	v_reservation bigint;
	v_max_concurrent integer;
	v_reserved_total bigint;
	v_actual_total bigint;
	v_active integer;
	v_ceiling record;
	v_company_spend bigint;
	v_company_tokens bigint;
	v_run_tokens bigint;
	v_dimension text;
	v_founder uuid;
begin
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	select reservation.* into v_existing
	from public.qorpera_execution_sponsor_reservations as reservation where reservation.run_id = v_run.id;
	if found then
		return v_existing.job_id = v_run.job_id and v_existing.binding_id = v_run.sponsor_binding_id
			and v_existing.sponsor_version = v_run.sponsor_version;
	end if;
	select binding.* into v_binding
	from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = v_run.sponsor_binding_id and binding.profile_id = v_run.profile_id
		and binding.status = 'active';
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id
		and connection.profile_id = v_run.profile_id and connection.status = 'active'
	for update;
	select version.* into v_connection_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_sponsor.provider_connection_id
		and version.version = v_sponsor.provider_connection_version
	for update;
	select staff.* into v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id
		and staff.version = v_run.staff_version and staff.employment_status = 'active';
	if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
		or v_connection_version.connection_id is null or v_staff.staff_agent_id is null
		or v_run.model_provider is distinct from v_connection.provider or v_run.model_id is null
		or (v_run.model_id = 'provider-default'
			and v_connection_version.authentication_mode <> 'native_subscription')
		or (v_sponsor.sponsor_kind = 'member_connection' and not exists (
			select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_run.profile_id and member.user_id = v_connection.owner_user_id
		)) or not public.qorpera_provider_quota_policy_valid(v_connection_version.quota_policy) then
		return false;
	end if;
	v_monthly := (v_connection_version.quota_policy ->> 'monthly_microusd')::bigint;
	v_reservation := (v_connection_version.quota_policy ->> 'reservation_microusd')::bigint;
	v_max_concurrent := (v_connection_version.quota_policy ->> 'max_concurrent_runs')::integer;
	select count(*) filter (where reservation.status = 'reserved'),
		coalesce(sum(reservation.reserved_microusd) filter (where reservation.status = 'reserved'), 0),
		coalesce(sum(reservation.actual_microusd) filter (where reservation.status = 'settled'), 0)
	into v_active, v_reserved_total, v_actual_total
	from public.qorpera_execution_sponsor_reservations as reservation
	where reservation.provider_connection_id = v_connection.id
		and reservation.period_start = v_period_start;
	if v_active >= v_max_concurrent or v_reserved_total + v_actual_total + v_reservation > v_monthly then
		return false;
	end if;
	-- Contract 7.4: company ceilings for sponsors without a provider usage wall.
	if v_connection_version.authentication_mode <> 'native_subscription' then
		select * into strict v_ceiling from public.qorpera_company_execution_ceiling(v_run.profile_id);
		v_run_tokens := (v_connection_version.quota_policy ->> 'max_input_tokens_per_run')::bigint
			+ (v_connection_version.quota_policy ->> 'max_output_tokens_per_run')::bigint;
		select coalesce(sum(coalesce(reservation.actual_microusd,reservation.reserved_microusd)),0),
			coalesce(sum(policy.max_input_tokens + policy.max_output_tokens),0)
		into v_company_spend,v_company_tokens
		from public.qorpera_execution_sponsor_reservations reservation
		join public.qorpera_provider_connection_versions version
			on version.connection_id = reservation.provider_connection_id
			and version.version = reservation.provider_connection_version
		left join public.qorpera_runner_model_policies policy on policy.job_id = reservation.job_id
		where reservation.profile_id = v_run.profile_id and reservation.period_start = v_period_start
			and version.authentication_mode <> 'native_subscription';
		v_dimension := case
			when v_company_spend + v_reservation > v_ceiling.spend_microusd_per_period then 'spend'
			when v_company_tokens + v_run_tokens > v_ceiling.tokens_per_period then 'tokens'
			else null end;
		if v_dimension is not null then
			insert into public.qorpera_company_ceiling_trips(profile_id,run_id,period_start,dimension,attempted,used,ceiling)
			values (v_run.profile_id,v_run.id,v_period_start,v_dimension,
				case when v_dimension = 'spend' then v_reservation else v_run_tokens end,
				case when v_dimension = 'spend' then v_company_spend else v_company_tokens end,
				case when v_dimension = 'spend' then v_ceiling.spend_microusd_per_period else v_ceiling.tokens_per_period end);
			for v_founder in select member.user_id from public.qorpera_profile_members member
				where member.profile_id = v_run.profile_id and member.role in ('owner','admin') order by member.user_id loop
				insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
				values (v_run.profile_id,v_founder,'company_ceiling_tripped',jsonb_build_object(
					'schema','qorpera.member-notification.company-ceiling-tripped/v1','dimension',v_dimension,
					'periodStart',v_period_start,'runId',v_run.id,'sponsorBindingId',v_run.sponsor_binding_id,
					'sponsorVersion',v_run.sponsor_version,'connectionId',v_connection.id,
					'ceiling',case when v_dimension = 'spend' then v_ceiling.spend_microusd_per_period
						else v_ceiling.tokens_per_period end),
					v_run.profile_id::text || ':' || v_period_start::date::text || ':' || v_dimension)
				on conflict (profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
			end loop;
			return false;
		end if;
	end if;
	insert into public.qorpera_execution_sponsor_reservations (
		run_id, job_id, profile_id, binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, period_start, reserved_microusd
	) values (
		v_run.id, v_run.job_id, v_run.profile_id, v_sponsor.binding_id, v_sponsor.version,
		v_connection.id, v_connection_version.version, v_period_start, v_reservation
	);
	insert into public.qorpera_execution_run_budgets (run_id) values (v_run.id);
	insert into public.qorpera_runner_model_policies (
		job_id, profile_id, environment_id, allowed_models, max_calls,
		max_input_tokens, max_output_tokens, max_cost_microusd, authorized_by_user_id
	) values (
		v_run.job_id, v_run.profile_id, v_run.environment_id,
		jsonb_build_array(jsonb_build_object('provider', v_run.model_provider, 'model', v_run.model_id)),
		(v_connection_version.quota_policy ->> 'max_calls_per_run')::integer,
		(v_connection_version.quota_policy ->> 'max_input_tokens_per_run')::bigint,
		(v_connection_version.quota_policy ->> 'max_output_tokens_per_run')::bigint,
		v_reservation, v_sponsor.created_by_user_id
	);
	return true;
end
$$;

revoke all on function public.qorpera_company_execution_ceiling(uuid),
	public.qorpera_company_execution_ceiling_json(uuid),
	public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_company_execution_ceiling_json(uuid),
	public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint) to authenticated;
-- The retained production owner of the reservation function must be able to
-- read the ceiling helper it now calls; it is not exposed to API roles.
do $$
declare v_owner name;
begin
	select role.rolname into strict v_owner from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role') then
		raise exception 'Sponsor reservation function is owned by an API role'; end if;
	execute format('grant execute on function public.qorpera_company_execution_ceiling(uuid) to %I',v_owner);
end
$$;

-- Job-scoped model gateway authority and immutable provider usage facts.
--
-- The runner never receives a provider or gateway credential. An owner or
-- admin explicitly authorizes a bounded model set and token budget for one
-- queued job. The job creator remains the usage actor; the authorizer is
-- recorded separately and is not treated as the final billing account.

create table public.qorpera_runner_model_policies (
	job_id uuid primary key references public.qorpera_runner_jobs(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	allowed_models jsonb not null check (
		jsonb_typeof(allowed_models) = 'array'
		and jsonb_array_length(allowed_models) between 1 and 32
	),
	max_calls integer not null check (max_calls between 1 and 128),
	max_input_tokens bigint not null check (max_input_tokens between 1 and 100000000),
	max_output_tokens bigint not null check (max_output_tokens between 1 and 100000000),
	authorized_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp()
);

create table public.qorpera_runner_model_requests (
	id uuid primary key default extensions.gen_random_uuid(),
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	runner_id uuid not null references public.qorpera_runners(id) on delete restrict,
	actor_user_id uuid not null references auth.users(id) on delete restrict,
	authorized_by_user_id uuid not null references auth.users(id) on delete restrict,
	client_request_id uuid not null,
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	model text not null check (
		char_length(model) between 1 and 160
		and model = btrim(model)
		and model !~ E'[\r\n]'
	),
	request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
	input_token_reservation bigint not null check (input_token_reservation between 1 and 100000000),
	output_token_reservation bigint not null check (output_token_reservation between 1 and 1000000),
	status text not null default 'reserved' check (status in ('reserved', 'completed', 'failed')),
	response jsonb check (response is null or pg_column_size(response) <= 589824),
	error_code text check (
		error_code is null
		or (error_code ~ '^[a-z][a-z0-9_]{0,63}$' and char_length(error_code) <= 64)
	),
	reservation_expires_at timestamptz not null default statement_timestamp() + interval '5 minutes',
	created_at timestamptz not null default statement_timestamp(),
	finalized_at timestamptz,
	unique (job_id, client_request_id),
	check (
		(status = 'reserved' and response is null and error_code is null and finalized_at is null)
		or (status = 'completed' and response is not null and error_code is null and finalized_at is not null)
		or (status = 'failed' and response is null and error_code is not null and finalized_at is not null)
	)
);

create index qorpera_runner_model_requests_job on public.qorpera_runner_model_requests (job_id, created_at);

create table public.qorpera_runner_model_usage_observations (
	id bigint generated always as identity primary key,
	request_id uuid not null unique references public.qorpera_runner_model_requests(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete cascade,
	runner_id uuid not null references public.qorpera_runners(id) on delete restrict,
	actor_user_id uuid not null references auth.users(id) on delete restrict,
	authorized_by_user_id uuid not null references auth.users(id) on delete restrict,
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	model text not null check (char_length(model) between 1 and 160 and model !~ E'[\r\n]'),
	outcome text not null check (outcome in ('completed', 'failed')),
	input_tokens bigint not null check (input_tokens between 0 and 100000000),
	output_tokens bigint not null check (output_tokens between 0 and 100000000),
	cost_microusd bigint not null check (cost_microusd between 0 and 9007199254740991),
	created_at timestamptz not null default statement_timestamp()
);

create index qorpera_runner_model_usage_profile_sequence
	on public.qorpera_runner_model_usage_observations (profile_id, id);

alter table public.qorpera_runner_model_policies enable row level security;
alter table public.qorpera_runner_model_requests enable row level security;
alter table public.qorpera_runner_model_usage_observations enable row level security;
revoke all on public.qorpera_runner_model_policies from anon, authenticated;
revoke all on public.qorpera_runner_model_requests from anon, authenticated;
revoke all on public.qorpera_runner_model_usage_observations from anon, authenticated;

create function public.qorpera_runner_model_policy_json(
	p_policy public.qorpera_runner_model_policies
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'job_id', p_policy.job_id,
		'profile_id', p_policy.profile_id,
		'environment_id', p_policy.environment_id,
		'allowed_models', p_policy.allowed_models,
		'max_calls', p_policy.max_calls,
		'max_input_tokens', p_policy.max_input_tokens,
		'max_output_tokens', p_policy.max_output_tokens,
		'authorized_by_user_id', p_policy.authorized_by_user_id,
		'created_at', p_policy.created_at
	)
$$;

create function public.qorpera_configure_runner_model_policy(
	p_job_id uuid,
	p_allowed_models jsonb,
	p_max_calls integer,
	p_max_input_tokens bigint,
	p_max_output_tokens bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_job public.qorpera_runner_jobs%rowtype;
	v_policy public.qorpera_runner_model_policies%rowtype;
	v_allowed_models jsonb;
begin
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_job.profile_id) then
		raise exception 'runner model policy requires authorization access' using errcode = '42501';
	end if;
	if v_job.status <> 'queued'
		or coalesce(jsonb_typeof(p_allowed_models), '') <> 'array'
		or p_max_calls is null or p_max_calls not between 1 and 128
		or p_max_input_tokens is null or p_max_input_tokens not between 1 and 100000000
		or p_max_output_tokens is null or p_max_output_tokens not between 1 and 100000000 then
		raise exception 'runner model policy is invalid' using errcode = '22023';
	end if;
	if jsonb_array_length(p_allowed_models) not between 1 and 32
		or exists (
			select 1 from jsonb_array_elements(p_allowed_models) as candidate(value)
			where jsonb_typeof(candidate.value) <> 'object'
		) then
		raise exception 'runner model policy is invalid' using errcode = '22023';
	end if;
	if exists (
			select 1 from jsonb_array_elements(p_allowed_models) as candidate(value)
			where exists (
					select 1 from jsonb_object_keys(candidate.value) as field(name)
					where field.name not in ('provider', 'model')
				)
				or coalesce(candidate.value ->> 'provider', '') !~ '^[a-z][a-z0-9_-]{0,63}$'
				or char_length(coalesce(candidate.value ->> 'model', '')) not between 1 and 160
				or candidate.value ->> 'model' <> btrim(candidate.value ->> 'model')
				or candidate.value ->> 'model' ~ E'[\r\n]'
		) then
		raise exception 'runner model policy is invalid' using errcode = '22023';
	end if;
	select jsonb_agg(
		jsonb_build_object('provider', candidate.value ->> 'provider', 'model', candidate.value ->> 'model')
		order by candidate.value ->> 'provider', candidate.value ->> 'model'
	) into v_allowed_models
	from jsonb_array_elements(p_allowed_models) as candidate(value);
	if jsonb_array_length(v_allowed_models) <> (
		select count(distinct (candidate.value ->> 'provider', candidate.value ->> 'model'))
		from jsonb_array_elements(v_allowed_models) as candidate(value)
	) then
		raise exception 'runner model policy contains duplicate models' using errcode = '22023';
	end if;

	select policy.* into v_policy
	from public.qorpera_runner_model_policies as policy where policy.job_id = v_job.id;
	if found then
		if v_policy.allowed_models <> v_allowed_models
			or v_policy.max_calls <> p_max_calls
			or v_policy.max_input_tokens <> p_max_input_tokens
			or v_policy.max_output_tokens <> p_max_output_tokens
			or v_policy.authorized_by_user_id <> v_user_id then
			raise exception 'runner model policy is already bound to other authority' using errcode = '23505';
		end if;
		return public.qorpera_runner_model_policy_json(v_policy);
	end if;
	insert into public.qorpera_runner_model_policies (
		job_id, profile_id, environment_id, allowed_models,
		max_calls, max_input_tokens, max_output_tokens, authorized_by_user_id
	) values (
		v_job.id, v_job.profile_id, v_job.environment_id, v_allowed_models,
		p_max_calls, p_max_input_tokens, p_max_output_tokens, v_user_id
	) returning * into v_policy;
	return public.qorpera_runner_model_policy_json(v_policy);
end
$$;

create function public.qorpera_runner_broker_reserve_model_request(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_request_id uuid,
	p_provider text,
	p_model text,
	p_request_sha256 text,
	p_input_token_reservation bigint,
	p_output_token_reservation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_policy public.qorpera_runner_model_policies%rowtype;
	v_request public.qorpera_runner_model_requests%rowtype;
	v_calls bigint;
	v_input_tokens bigint;
	v_output_tokens bigint;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select policy.* into v_policy
	from public.qorpera_runner_model_policies as policy where policy.job_id = v_job.id for update;
	if not found then
		raise exception 'runner job has no model authority' using errcode = '42501';
	end if;
	if p_request_id is null
		or coalesce(p_provider, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(coalesce(p_model, '')) not between 1 and 160
		or p_model <> btrim(p_model) or p_model ~ E'[\r\n]'
		or coalesce(p_request_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_input_token_reservation is null
		or p_input_token_reservation not between 1 and 100000000
		or p_output_token_reservation is null
		or p_output_token_reservation not between 1 and 1000000
		or not exists (
			select 1 from jsonb_array_elements(v_policy.allowed_models) as allowed(value)
			where allowed.value ->> 'provider' = p_provider and allowed.value ->> 'model' = p_model
		) then
		raise exception 'runner model request is outside its policy' using errcode = '42501';
	end if;

	select request.* into v_request
	from public.qorpera_runner_model_requests as request
	where request.job_id = v_job.id and request.client_request_id = p_request_id
	for update;
	if found then
		if v_request.provider <> p_provider
			or v_request.model <> p_model
			or v_request.request_sha256 <> p_request_sha256
			or v_request.input_token_reservation <> p_input_token_reservation
			or v_request.output_token_reservation <> p_output_token_reservation then
			raise exception 'runner model request id is already bound to other work' using errcode = '23505';
		end if;
		if v_request.status = 'completed' then
			return jsonb_build_object('state', 'completed', 'response', v_request.response);
		end if;
		if v_request.status = 'failed' then return jsonb_build_object('state', 'failed'); end if;
		if v_request.reservation_expires_at <= statement_timestamp() then
			update public.qorpera_runner_model_requests
			set status = 'failed', error_code = 'reservation_expired', finalized_at = statement_timestamp()
			where id = v_request.id;
			insert into public.qorpera_runner_model_usage_observations (
				request_id, profile_id, environment_id, job_id, runner_id,
				actor_user_id, authorized_by_user_id, provider, model,
				outcome, input_tokens, output_tokens, cost_microusd
			) values (
				v_request.id, v_request.profile_id, v_request.environment_id, v_request.job_id, v_request.runner_id,
				v_request.actor_user_id, v_request.authorized_by_user_id, v_request.provider, v_request.model,
				'failed', 0, 0, 0
			) on conflict (request_id) do nothing;
			return jsonb_build_object('state', 'failed');
		end if;
		update public.qorpera_runner_model_requests
		set runner_id = p_runner_id
		where id = v_request.id;
		-- The controlled gateway must use the client request UUID as its
		-- idempotency key, so an ambiguous Edge retry can safely recover and
		-- finalize the same provider result.
		return jsonb_build_object('state', 'reserved', 'replay', true);
	end if;

	select count(*) into v_calls
	from public.qorpera_runner_model_requests as request where request.job_id = v_job.id;
	select
		coalesce(sum(observation.input_tokens), 0)
			+ coalesce((select sum(request.input_token_reservation)
				from public.qorpera_runner_model_requests as request
				where request.job_id = v_job.id and request.status = 'reserved'), 0),
		coalesce(sum(observation.output_tokens), 0)
			+ coalesce((select sum(request.output_token_reservation)
				from public.qorpera_runner_model_requests as request
				where request.job_id = v_job.id and request.status = 'reserved'), 0)
	into v_input_tokens, v_output_tokens
	from public.qorpera_runner_model_usage_observations as observation
	where observation.job_id = v_job.id;
	if v_calls >= v_policy.max_calls
		or v_input_tokens + p_input_token_reservation > v_policy.max_input_tokens
		or v_output_tokens + p_output_token_reservation > v_policy.max_output_tokens then
		raise exception 'runner model policy budget is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_runner_model_requests (
		job_id, profile_id, environment_id, runner_id, actor_user_id, authorized_by_user_id,
		client_request_id, provider, model, request_sha256,
		input_token_reservation, output_token_reservation
	) values (
		v_job.id, v_job.profile_id, v_job.environment_id, p_runner_id,
		v_job.created_by_user_id, v_policy.authorized_by_user_id,
		p_request_id, p_provider, p_model, p_request_sha256,
		p_input_token_reservation, p_output_token_reservation
	);
	return jsonb_build_object('state', 'reserved');
end
$$;

create function public.qorpera_runner_broker_finalize_model_request(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_request_id uuid,
	p_request_sha256 text,
	p_outcome text,
	p_input_tokens bigint,
	p_output_tokens bigint,
	p_cost_microusd bigint,
	p_response jsonb,
	p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_request public.qorpera_runner_model_requests%rowtype;
	v_observation public.qorpera_runner_model_usage_observations%rowtype;
	v_response jsonb;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select request.* into v_request
	from public.qorpera_runner_model_requests as request
	where request.job_id = v_job.id and request.client_request_id = p_request_id
	for update;
	if not found or v_request.runner_id <> p_runner_id or v_request.request_sha256 <> p_request_sha256 then
		raise exception 'runner model reservation is unavailable' using errcode = '40001';
	end if;
	if coalesce(p_outcome, '') not in ('completed', 'failed')
		or p_input_tokens is null or p_input_tokens not between 0 and v_request.input_token_reservation
		or p_output_tokens is null or p_output_tokens not between 0 and v_request.output_token_reservation
		or p_cost_microusd is null or p_cost_microusd not between 0 and 9007199254740991
		or (p_outcome = 'completed' and (p_error_code is not null or pg_column_size(coalesce(p_response, 'null'::jsonb)) > 589824))
		or (p_outcome = 'failed' and (
			p_response is not null
			or p_error_code is null
			or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$'
			or char_length(p_error_code) > 64
		)) then
		raise exception 'runner model result is invalid' using errcode = '22023';
	end if;
	v_response := case when p_outcome = 'completed' then jsonb_build_object(
		'request_id', v_request.client_request_id,
		'provider', v_request.provider,
		'model', v_request.model,
		'output', coalesce(p_response, 'null'::jsonb),
		'usage', jsonb_build_object(
			'input_tokens', p_input_tokens,
			'output_tokens', p_output_tokens,
			'cost_microusd', p_cost_microusd
		)
	) else null end;

	if v_request.status <> 'reserved' then
		select observation.* into strict v_observation
		from public.qorpera_runner_model_usage_observations as observation
		where observation.request_id = v_request.id;
		if v_request.status <> p_outcome
			or v_request.response is distinct from v_response
			or v_request.error_code is distinct from p_error_code
			or v_observation.input_tokens <> p_input_tokens
			or v_observation.output_tokens <> p_output_tokens
			or v_observation.cost_microusd <> p_cost_microusd then
			raise exception 'runner model result replay differs' using errcode = '23505';
		end if;
		return coalesce(v_request.response, jsonb_build_object('state', 'failed'));
	end if;
	if v_request.reservation_expires_at <= statement_timestamp() then
		raise exception 'runner model reservation expired' using errcode = '40001';
	end if;
	update public.qorpera_runner_model_requests
	set status = p_outcome, response = v_response, error_code = p_error_code, finalized_at = statement_timestamp()
	where id = v_request.id returning * into v_request;
	insert into public.qorpera_runner_model_usage_observations (
		request_id, profile_id, environment_id, job_id, runner_id,
		actor_user_id, authorized_by_user_id, provider, model,
		outcome, input_tokens, output_tokens, cost_microusd
	) values (
		v_request.id, v_request.profile_id, v_request.environment_id, v_request.job_id, v_request.runner_id,
		v_request.actor_user_id, v_request.authorized_by_user_id, v_request.provider, v_request.model,
		p_outcome, p_input_tokens, p_output_tokens, p_cost_microusd
	);
	return coalesce(v_response, jsonb_build_object('state', 'failed'));
end
$$;

create function public.qorpera_list_runner_model_usage(
	p_profile_id uuid,
	p_after_id bigint default 0,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'runner model usage list requires profile access' using errcode = '42501';
	end if;
	if p_after_id < 0 or p_limit not between 1 and 500 then
		raise exception 'runner model usage page is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'observation_id', observation.id,
			'profile_id', observation.profile_id,
			'environment_id', observation.environment_id,
			'job_id', observation.job_id,
			'request_id', request.client_request_id,
			'runner_id', observation.runner_id,
			'actor_user_id', observation.actor_user_id,
			'authorized_by_user_id', observation.authorized_by_user_id,
			'provider', observation.provider,
			'model', observation.model,
			'outcome', observation.outcome,
			'input_tokens', observation.input_tokens,
			'output_tokens', observation.output_tokens,
			'cost_microusd', observation.cost_microusd,
			'created_at', observation.created_at
		) order by observation.id)
		from (
			select candidate.*
			from public.qorpera_runner_model_usage_observations as candidate
			where candidate.profile_id = p_profile_id and candidate.id > p_after_id
			order by candidate.id
			limit p_limit
		) as observation
		join public.qorpera_runner_model_requests as request on request.id = observation.request_id
	), '[]'::jsonb);
end
$$;

create function public.qorpera_complete_runner_job_v4(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_client_artifact_index_id uuid,
	p_client_substrate_version_id uuid,
	p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_expired public.qorpera_runner_model_requests%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	for v_expired in
		update public.qorpera_runner_model_requests
		set status = 'failed', error_code = 'reservation_expired', finalized_at = statement_timestamp()
		where job_id = v_job.id and status = 'reserved'
			and reservation_expires_at <= statement_timestamp()
		returning *
	loop
		insert into public.qorpera_runner_model_usage_observations (
			request_id, profile_id, environment_id, job_id, runner_id,
			actor_user_id, authorized_by_user_id, provider, model,
			outcome, input_tokens, output_tokens, cost_microusd
		) values (
			v_expired.id, v_expired.profile_id, v_expired.environment_id, v_expired.job_id, v_expired.runner_id,
			v_expired.actor_user_id, v_expired.authorized_by_user_id, v_expired.provider, v_expired.model,
			'failed', 0, 0, 0
		) on conflict (request_id) do nothing;
	end loop;
	if exists (
		select 1 from public.qorpera_runner_model_requests as request
		where request.job_id = v_job.id and request.status = 'reserved'
	) then
		raise exception 'runner job has an active model request' using errcode = '55000';
	end if;
	return public.qorpera_complete_runner_job_v3(
		p_runner_id,
		p_session_token_sha256,
		p_job_id,
		p_lease_token_sha256,
		p_client_artifact_index_id,
		p_client_substrate_version_id,
		p_result
	);
end
$$;

revoke all on function public.qorpera_runner_model_policy_json(public.qorpera_runner_model_policies) from public;
revoke all on function public.qorpera_configure_runner_model_policy(uuid, jsonb, integer, bigint, bigint) from public;
revoke all on function public.qorpera_runner_broker_reserve_model_request(uuid, text, uuid, text, uuid, text, text, text, bigint, bigint) from public;
revoke all on function public.qorpera_runner_broker_finalize_model_request(uuid, text, uuid, text, uuid, text, text, bigint, bigint, bigint, jsonb, text) from public;
revoke all on function public.qorpera_list_runner_model_usage(uuid, bigint, integer) from public;
revoke all on function public.qorpera_complete_runner_job_v4(uuid, text, uuid, text, uuid, uuid, jsonb) from public;
revoke execute on function public.qorpera_complete_runner_job_v3(uuid, text, uuid, text, uuid, uuid, jsonb) from service_role;

grant execute on function public.qorpera_configure_runner_model_policy(uuid, jsonb, integer, bigint, bigint) to authenticated;
grant execute on function public.qorpera_runner_broker_reserve_model_request(uuid, text, uuid, text, uuid, text, text, text, bigint, bigint) to service_role;
grant execute on function public.qorpera_runner_broker_finalize_model_request(uuid, text, uuid, text, uuid, text, text, bigint, bigint, bigint, jsonb, text) to service_role;
grant execute on function public.qorpera_list_runner_model_usage(uuid, bigint, integer) to authenticated;
grant execute on function public.qorpera_complete_runner_job_v4(uuid, text, uuid, text, uuid, uuid, jsonb) to service_role;

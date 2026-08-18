-- Immutable runner resource observations.
--
-- These records describe where work happened and which profile member caused
-- it. They deliberately do not choose a billing account. Entitlement and
-- sponsorship policy may attribute an immutable observation later without
-- changing the underlying execution fact.

create table public.qorpera_runner_usage_observations (
	id bigint generated always as identity primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	job_id uuid not null unique references public.qorpera_runner_jobs(id) on delete cascade,
	runner_id uuid not null references public.qorpera_runners(id) on delete restrict,
	actor_user_id uuid not null references auth.users(id) on delete restrict,
	execution_ms integer not null check (execution_ms between 1 and 86400000),
	input_bytes bigint not null check (input_bytes between 0 and 17179869184),
	output_bytes bigint not null check (output_bytes between 0 and 268435456),
	result_bytes integer not null check (result_bytes between 1 and 65536),
	wall_time_limit_ms integer not null check (wall_time_limit_ms between 10 and 86400000),
	memory_limit_bytes bigint not null check (memory_limit_bytes between 67108864 and 274877906944),
	cpu_limit_millis integer not null check (cpu_limit_millis between 100 and 64000),
	pid_limit integer not null check (pid_limit between 1 and 4096),
	input_limit_bytes bigint not null check (input_limit_bytes between 1 and 17179869184),
	output_limit_bytes bigint not null check (output_limit_bytes between 0 and 268435456),
	result_limit_bytes integer not null check (result_limit_bytes between 2 and 65536),
	reserved_cpu_milliseconds bigint not null,
	reserved_memory_mib_milliseconds bigint not null,
	created_at timestamptz not null default statement_timestamp(),
	check (execution_ms <= wall_time_limit_ms),
	check (input_bytes <= input_limit_bytes),
	check (output_bytes <= output_limit_bytes),
	check (result_bytes <= result_limit_bytes),
	check (
		reserved_cpu_milliseconds = ceil(execution_ms::numeric * cpu_limit_millis::numeric / 1000)::bigint
	),
	check (
		reserved_memory_mib_milliseconds =
			ceil(memory_limit_bytes::numeric / 1048576)::bigint * execution_ms::bigint
	)
);

create index qorpera_runner_usage_profile_sequence
	on public.qorpera_runner_usage_observations (profile_id, id);

alter table public.qorpera_runner_usage_observations enable row level security;
revoke all on public.qorpera_runner_usage_observations from anon, authenticated;

create function public.qorpera_runner_usage_json(
	p_observation public.qorpera_runner_usage_observations
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'observation_id', p_observation.id,
		'profile_id', p_observation.profile_id,
		'environment_id', p_observation.environment_id,
		'job_id', p_observation.job_id,
		'runner_id', p_observation.runner_id,
		'actor_user_id', p_observation.actor_user_id,
		'usage', jsonb_build_object(
			'schema', 'qorpera.runner-usage/v1',
			'execution_ms', p_observation.execution_ms,
			'input_bytes', p_observation.input_bytes,
			'output_bytes', p_observation.output_bytes,
			'result_bytes', p_observation.result_bytes,
			'limits', jsonb_build_object(
				'wall_time_ms', p_observation.wall_time_limit_ms,
				'memory_bytes', p_observation.memory_limit_bytes,
				'cpu_millis', p_observation.cpu_limit_millis,
				'max_pids', p_observation.pid_limit,
				'max_input_bytes', p_observation.input_limit_bytes,
				'max_output_bytes', p_observation.output_limit_bytes,
				'max_result_bytes', p_observation.result_limit_bytes
			)
		),
		'reserved_cpu_milliseconds', p_observation.reserved_cpu_milliseconds,
		'reserved_memory_mib_milliseconds', p_observation.reserved_memory_mib_milliseconds,
		'created_at', p_observation.created_at
	)
$$;

create function public.qorpera_complete_runner_job_v3(
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
	v_usage jsonb := p_result -> 'usage';
	v_limits jsonb;
	v_completed jsonb;
	v_job public.qorpera_runner_jobs%rowtype;
	v_existing public.qorpera_runner_usage_observations%rowtype;
	v_execution_ms integer;
	v_input_bytes bigint;
	v_output_bytes bigint;
	v_result_bytes integer;
	v_wall_time_limit_ms integer;
	v_memory_limit_bytes bigint;
	v_cpu_limit_millis integer;
	v_pid_limit integer;
	v_input_limit_bytes bigint;
	v_output_limit_bytes bigint;
	v_result_limit_bytes integer;
	v_reserved_cpu_milliseconds bigint;
	v_reserved_memory_mib_milliseconds bigint;
begin
	if p_result is null
		or jsonb_typeof(p_result) <> 'object'
		or p_result ->> 'schema' <> 'qorpera.runner-result/v1'
		or jsonb_typeof(v_usage) <> 'object'
		or v_usage ->> 'schema' <> 'qorpera.runner-usage/v1' then
		raise exception 'runner usage observation is invalid' using errcode = '22023';
	end if;
	v_limits := v_usage -> 'limits';
	if jsonb_typeof(v_limits) <> 'object' then
		raise exception 'runner usage observation is invalid' using errcode = '22023';
	end if;
	if exists (
			select 1 from jsonb_object_keys(v_usage) as field(name)
			where field.name not in ('schema', 'execution_ms', 'input_bytes', 'output_bytes', 'result_bytes', 'limits')
		)
		or exists (
			select 1 from jsonb_object_keys(v_limits) as field(name)
			where field.name not in (
				'wall_time_ms', 'memory_bytes', 'cpu_millis', 'max_pids',
				'max_input_bytes', 'max_output_bytes', 'max_result_bytes'
			)
		)
		or coalesce(v_usage ->> 'execution_ms', '') !~ '^[0-9]+$'
		or coalesce(v_usage ->> 'input_bytes', '') !~ '^[0-9]+$'
		or coalesce(v_usage ->> 'output_bytes', '') !~ '^[0-9]+$'
		or coalesce(v_usage ->> 'result_bytes', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'wall_time_ms', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'memory_bytes', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'cpu_millis', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'max_pids', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'max_input_bytes', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'max_output_bytes', '') !~ '^[0-9]+$'
		or coalesce(v_limits ->> 'max_result_bytes', '') !~ '^[0-9]+$'
		or coalesce(p_result ->> 'output_bytes', '') !~ '^[0-9]+$'
		or (v_usage ->> 'execution_ms')::numeric not between 1 and 86400000
		or (v_usage ->> 'input_bytes')::numeric not between 0 and 17179869184
		or (v_usage ->> 'output_bytes')::numeric not between 0 and 268435456
		or (v_usage ->> 'result_bytes')::numeric not between 1 and 65536
		or (v_limits ->> 'wall_time_ms')::numeric not between 10 and 86400000
		or (v_limits ->> 'memory_bytes')::numeric not between 67108864 and 274877906944
		or (v_limits ->> 'cpu_millis')::numeric not between 100 and 64000
		or (v_limits ->> 'max_pids')::numeric not between 1 and 4096
		or (v_limits ->> 'max_input_bytes')::numeric not between 1 and 17179869184
		or (v_limits ->> 'max_output_bytes')::numeric not between 0 and 268435456
		or (v_limits ->> 'max_result_bytes')::numeric not between 2 and 65536
		or (v_usage ->> 'execution_ms')::numeric > (v_limits ->> 'wall_time_ms')::numeric
		or (v_usage ->> 'input_bytes')::numeric > (v_limits ->> 'max_input_bytes')::numeric
		or (v_usage ->> 'output_bytes')::numeric > (v_limits ->> 'max_output_bytes')::numeric
		or (v_usage ->> 'result_bytes')::numeric > (v_limits ->> 'max_result_bytes')::numeric
		or (v_usage ->> 'output_bytes')::numeric <> (p_result ->> 'output_bytes')::numeric then
		raise exception 'runner usage observation is invalid' using errcode = '22023';
	end if;

	v_execution_ms := (v_usage ->> 'execution_ms')::integer;
	v_input_bytes := (v_usage ->> 'input_bytes')::bigint;
	v_output_bytes := (v_usage ->> 'output_bytes')::bigint;
	v_result_bytes := (v_usage ->> 'result_bytes')::integer;
	v_wall_time_limit_ms := (v_limits ->> 'wall_time_ms')::integer;
	v_memory_limit_bytes := (v_limits ->> 'memory_bytes')::bigint;
	v_cpu_limit_millis := (v_limits ->> 'cpu_millis')::integer;
	v_pid_limit := (v_limits ->> 'max_pids')::integer;
	v_input_limit_bytes := (v_limits ->> 'max_input_bytes')::bigint;
	v_output_limit_bytes := (v_limits ->> 'max_output_bytes')::bigint;
	v_result_limit_bytes := (v_limits ->> 'max_result_bytes')::integer;
	v_reserved_cpu_milliseconds := ceil(
		v_execution_ms::numeric * v_cpu_limit_millis::numeric / 1000
	)::bigint;
	v_reserved_memory_mib_milliseconds :=
		ceil(v_memory_limit_bytes::numeric / 1048576)::bigint * v_execution_ms::bigint;

	v_completed := public.qorpera_complete_runner_job_v2(
		p_runner_id,
		p_session_token_sha256,
		p_job_id,
		p_lease_token_sha256,
		p_client_artifact_index_id,
		p_client_substrate_version_id,
		p_result
	);
	select job.* into strict v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id;

	select observation.* into v_existing
	from public.qorpera_runner_usage_observations as observation
	where observation.job_id = v_job.id
	for update;
	if found then
		if v_existing.profile_id <> v_job.profile_id
			or v_existing.environment_id <> v_job.environment_id
			or v_existing.runner_id <> p_runner_id
			or v_existing.actor_user_id <> v_job.created_by_user_id
			or v_existing.execution_ms <> v_execution_ms
			or v_existing.input_bytes <> v_input_bytes
			or v_existing.output_bytes <> v_output_bytes
			or v_existing.result_bytes <> v_result_bytes
			or v_existing.wall_time_limit_ms <> v_wall_time_limit_ms
			or v_existing.memory_limit_bytes <> v_memory_limit_bytes
			or v_existing.cpu_limit_millis <> v_cpu_limit_millis
			or v_existing.pid_limit <> v_pid_limit
			or v_existing.input_limit_bytes <> v_input_limit_bytes
			or v_existing.output_limit_bytes <> v_output_limit_bytes
			or v_existing.result_limit_bytes <> v_result_limit_bytes then
			raise exception 'runner usage replay differs from the stored observation' using errcode = '23505';
		end if;
		return v_completed;
	end if;

	insert into public.qorpera_runner_usage_observations (
		profile_id, environment_id, job_id, runner_id, actor_user_id,
		execution_ms, input_bytes, output_bytes, result_bytes,
		wall_time_limit_ms, memory_limit_bytes, cpu_limit_millis, pid_limit,
		input_limit_bytes, output_limit_bytes, result_limit_bytes,
		reserved_cpu_milliseconds, reserved_memory_mib_milliseconds
	) values (
		v_job.profile_id, v_job.environment_id, v_job.id, p_runner_id, v_job.created_by_user_id,
		v_execution_ms, v_input_bytes, v_output_bytes, v_result_bytes,
		v_wall_time_limit_ms, v_memory_limit_bytes, v_cpu_limit_millis, v_pid_limit,
		v_input_limit_bytes, v_output_limit_bytes, v_result_limit_bytes,
		v_reserved_cpu_milliseconds, v_reserved_memory_mib_milliseconds
	);
	return v_completed;
end
$$;

create function public.qorpera_list_runner_usage(
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
		raise exception 'runner usage list requires profile access' using errcode = '42501';
	end if;
	if p_after_id < 0 or p_limit not between 1 and 500 then
		raise exception 'runner usage page is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(public.qorpera_runner_usage_json(observation) order by observation.id)
		from (
			select candidate.*
			from public.qorpera_runner_usage_observations as candidate
			where candidate.profile_id = p_profile_id and candidate.id > p_after_id
			order by candidate.id
			limit p_limit
		) as observation
	), '[]'::jsonb);
end
$$;

revoke all on function public.qorpera_runner_usage_json(public.qorpera_runner_usage_observations) from public;
revoke all on function public.qorpera_complete_runner_job_v3(uuid, text, uuid, text, uuid, uuid, jsonb) from public;
revoke all on function public.qorpera_list_runner_usage(uuid, bigint, integer) from public;
revoke execute on function public.qorpera_complete_runner_job_v2(uuid, text, uuid, text, uuid, uuid, jsonb) from service_role;

grant execute on function public.qorpera_complete_runner_job_v3(uuid, text, uuid, text, uuid, uuid, jsonb) to service_role;
grant execute on function public.qorpera_list_runner_usage(uuid, bigint, integer) to authenticated;

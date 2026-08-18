-- Keep ambiguous runner and provider operations recoverable, and preserve
-- usage observations as append-only financial facts.

create function public.qorpera_reject_usage_observation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	raise exception 'usage observations are immutable' using errcode = '55000';
end
$$;

revoke all on function public.qorpera_reject_usage_observation_mutation() from public;

create trigger qorpera_runner_usage_immutable
before update or delete on public.qorpera_runner_usage_observations
for each row execute function public.qorpera_reject_usage_observation_mutation();

create trigger qorpera_runner_model_usage_immutable
before update or delete on public.qorpera_runner_model_usage_observations
for each row execute function public.qorpera_reject_usage_observation_mutation();

alter table public.qorpera_runner_usage_observations
	drop constraint qorpera_runner_usage_observations_profile_id_fkey,
	drop constraint qorpera_runner_usage_observations_environment_id_fkey,
	drop constraint qorpera_runner_usage_observations_job_id_fkey,
	add constraint qorpera_runner_usage_observations_profile_id_fkey
		foreign key (profile_id) references public.qorpera_profiles(id) on delete restrict,
	add constraint qorpera_runner_usage_observations_environment_id_fkey
		foreign key (environment_id) references public.qorpera_company_environments(id) on delete restrict,
	add constraint qorpera_runner_usage_observations_job_id_fkey
		foreign key (job_id) references public.qorpera_runner_jobs(id) on delete restrict;

alter table public.qorpera_runner_model_usage_observations
	drop constraint qorpera_runner_model_usage_observations_request_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_profile_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_environment_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_job_id_fkey,
	add constraint qorpera_runner_model_usage_observations_request_id_fkey
		foreign key (request_id) references public.qorpera_runner_model_requests(id) on delete restrict,
	add constraint qorpera_runner_model_usage_observations_profile_id_fkey
		foreign key (profile_id) references public.qorpera_profiles(id) on delete restrict,
	add constraint qorpera_runner_model_usage_observations_environment_id_fkey
		foreign key (environment_id) references public.qorpera_company_environments(id) on delete restrict,
	add constraint qorpera_runner_model_usage_observations_job_id_fkey
		foreign key (job_id) references public.qorpera_runner_jobs(id) on delete restrict;

create or replace function public.qorpera_reissue_runner_activation(
	p_runner_id uuid,
	p_activation_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_previous_status text;
begin
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner registration requires full access' using errcode = '42501';
	end if;
	if v_runner.status = 'revoked' or p_activation_token_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner activation cannot be reissued' using errcode = '55000';
	end if;
	v_previous_status := v_runner.status;

	if v_runner.status = 'active' then
		for v_job in
			select job.* from public.qorpera_runner_jobs as job
			where job.runner_id = p_runner_id and job.status = 'leased' for update
		loop
			if v_job.attempt_count >= 8 then
				update public.qorpera_runner_jobs
				set status = 'failed', terminal_lease_token_sha256 = lease_token_sha256,
					lease_token_sha256 = null, lease_expires_at = null,
					finished_at = statement_timestamp(),
					last_error = 'Runner session expired after the final lease attempt'
				where id = v_job.id returning * into v_job;
				perform public.qorpera_append_runner_audit(
					v_job.profile_id, p_runner_id, v_job.id, 'job_failed',
					jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'runner_repaired'), v_user_id
				);
			else
				update public.qorpera_runner_jobs
				set status = 'queued', runner_id = null, client_lease_id = null,
					terminal_lease_token_sha256 = lease_token_sha256,
					lease_token_sha256 = null, lease_expires_at = null,
					last_error = 'Runner session was reset for re-pairing'
				where id = v_job.id returning * into v_job;
				perform public.qorpera_append_runner_audit(
					v_job.profile_id, p_runner_id, v_job.id, 'job_requeued',
					jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'runner_repaired'), v_user_id
				);
			end if;
		end loop;
	end if;

	update public.qorpera_runners
	set status = 'pending', activation_token_sha256 = p_activation_token_sha256,
		activation_expires_at = statement_timestamp() + interval '15 minutes',
		session_token_sha256 = null, session_expires_at = null,
		previous_session_token_sha256 = null, previous_session_expires_at = null,
		last_renewal_id = null, platform = null, runner_version = null,
		activated_at = null
	where id = p_runner_id returning * into v_runner;
	perform public.qorpera_append_runner_audit(
		v_runner.profile_id, v_runner.id, null, 'runner_registered',
		jsonb_build_object(
			'reissued', true,
			'previous_status', v_previous_status,
			'activation_expires_at', v_runner.activation_expires_at
		), v_user_id
	);
	return public.qorpera_runner_json(v_runner);
end
$$;

create or replace function public.qorpera_runner_broker_reserve_model_request(
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
		update public.qorpera_runner_model_requests
		set runner_id = p_runner_id,
			reservation_expires_at = statement_timestamp() + interval '5 minutes'
		where id = v_request.id;
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

create or replace function public.qorpera_runner_broker_finalize_model_request(
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
		or p_input_tokens is null or p_input_tokens not between 0 and 100000000
		or p_output_tokens is null or p_output_tokens not between 0 and 100000000
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

create or replace function public.qorpera_complete_runner_job_v4(
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
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if exists (
		select 1 from public.qorpera_runner_model_requests as request
		where request.job_id = v_job.id and request.status = 'reserved'
	) then
		raise exception 'runner job has an unresolved model request' using errcode = '55000';
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

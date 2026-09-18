-- The founder's ceiling view counted only trips stamped with the month's own start. Wake-rate trips are stamped with
-- their hour (they dedupe the founder notification per hour), so a tripped wake ceiling always read "trips: 0"
-- (found live 2026-09-18). Count every trip that happened inside the current period instead. No other change.
create or replace function public.qorpera_company_execution_ceiling_json(p_profile_id uuid)
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
		'wakes_per_hour',v_ceiling.wakes_per_hour,'wakes_last_hour',public.qorpera_company_wakes_last_hour(p_profile_id),
		'paused',public.qorpera_company_execution_paused(p_profile_id),
		'spend_microusd_used',v_spend_used,'tokens_used',v_tokens_used,
		'trips',(select count(*) from public.qorpera_company_ceiling_trips trip
			where trip.profile_id = p_profile_id and trip.period_start >= v_period_start
				and trip.period_start < v_period_start + interval '1 month'));
end
$$;

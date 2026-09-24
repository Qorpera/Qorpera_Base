-- No company execution ceilings (Jonas, 2026-09-24): "get rid of this ... not
-- just in settings, but as policy configurations/settings", about Settings ->
-- Company execution. This removes the per-company monthly spend ceiling, the
-- monthly token ceiling and the hourly autonomous-wake ceiling as policy:
-- their table, their trip records, their member RPCs, and the checks at run
-- admission (qorpera_reserve_execution_sponsor_authority), at wake admission
-- (qorpera_pin_wake_occurrence) and in the worker drain
-- (qorpera_drain_worker_wakes). Per-connection provider quotas and the
-- provider's own usage limits are unchanged, and so is the running-machine
-- limit, whose refusals keep the company_ceiling_tripped notification kind.
--
-- The company pause stays as the operator brake every runtime cut uses (pause,
-- migrate, activate, resume). Members can no longer call it, and it no longer
-- notifies members: the web client has no pause and no ceiling controls
-- (web PR #247). The function keeps its signature and its founder check, so
-- an operator session that sets a founder's claims pauses exactly as before.

create function pg_temp.ceiling_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Ceiling removal differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- Run admission: only the sponsor's own quota and concurrency remain
-- ---------------------------------------------------------------------------
select pg_temp.ceiling_patch('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
	$old$	-- Contract 7.4: company ceilings for sponsors without a provider usage wall.
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
$old$,
	'');

select pg_temp.ceiling_patch('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
	$old$	v_active integer;
	v_ceiling record;
	v_company_spend bigint;
	v_company_tokens bigint;
	v_run_tokens bigint;
	v_dimension text;
	v_founder uuid;
begin$old$,
	$new$	v_active integer;
begin$new$);

-- ---------------------------------------------------------------------------
-- Wake admission: the pause still holds; there is no wake-rate ceiling
-- ---------------------------------------------------------------------------
select pg_temp.ceiling_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$	-- Contract 7.4: the founder stop and the wake-rate ceiling hold at admission$old$,
	$new$	-- The company pause (the operator brake) holds at admission$new$);

select pg_temp.ceiling_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$			return new;
		end if;
		select * into strict v_ceiling from public.qorpera_company_execution_ceiling(new.profile_id);
		v_used := public.qorpera_company_wakes_last_hour(new.profile_id);
		if v_used >= v_ceiling.wakes_per_hour then
			insert into public.qorpera_company_ceiling_trips(profile_id,run_id,period_start,dimension,attempted,used,ceiling)
			values (new.profile_id,new.id,date_trunc('hour',clock_timestamp()),'wakes',1,v_used,v_ceiling.wakes_per_hour);
			for v_founder in select member.user_id from public.qorpera_profile_members member
				where member.profile_id = new.profile_id and member.role in ('owner','admin') order by member.user_id loop
				insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
				values (new.profile_id,v_founder,'company_ceiling_tripped',jsonb_build_object(
					'schema','qorpera.member-notification.company-ceiling-tripped/v1','dimension','wakes',
					'periodStart',date_trunc('hour',clock_timestamp()),'occurrenceId',new.id,'wakeKind',new.wake_kind,
					'staffAgentId',new.staff_agent_id,'ceiling',v_ceiling.wakes_per_hour,'used',v_used),
					new.profile_id::text || ':' || to_char(date_trunc('hour',clock_timestamp()) at time zone 'UTC','YYYYMMDDHH24') || ':wakes')
				on conflict (profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
			end loop;
			new.status := 'cancelled'; new.finished_at := clock_timestamp();
			new.blocked_reason := 'Company wake ceiling tripped';
		end if;
	elsif$old$,
	$new$			return new;
		end if;
	elsif$new$);

select pg_temp.ceiling_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$	v_ceiling record; v_used bigint; v_founder uuid;
$old$,
	'');

select pg_temp.ceiling_patch('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
			select * into strict v_ceiling from public.qorpera_company_execution_ceiling(v_worker.profile_id);
			if public.qorpera_company_wakes_last_hour(v_worker.profile_id) >= v_ceiling.wakes_per_hour then continue; end if;
$old$,
	$new$			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
$new$);

select pg_temp.ceiling_patch('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$
	v_ceiling record;
begin$old$,
	$new$
begin$new$);

select pg_temp.ceiling_patch('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$(ceiling, pause)$old$,
	$new$(pause)$new$);

-- ---------------------------------------------------------------------------
-- The pause: an operator brake, no longer a member control
-- ---------------------------------------------------------------------------
select pg_temp.ceiling_patch('public.qorpera_set_company_execution_pause(uuid,boolean,text)'::regprocedure,
	$old$		update public.qorpera_company_wake_admission_fences set revision=revision+1 where profile_id=p_profile_id;
		v_kind := case when p_paused then 'company_execution_paused' else 'company_execution_resumed' end;
		for v_founder in select member.user_id from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.role in ('owner','admin') order by member.user_id loop
			insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
			values (p_profile_id,v_founder,v_kind,jsonb_build_object('schema','qorpera.member-notification.company-execution-stop/v1',
				'paused',p_paused,'byUserId',auth.uid(),'reason',p_reason,'at',clock_timestamp()),
				p_profile_id::text || ':' || to_char(clock_timestamp() at time zone 'UTC','YYYYMMDDHH24MISSUS'))
			on conflict (profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
		end loop;
	end if;$old$,
	$new$		update public.qorpera_company_wake_admission_fences set revision=revision+1 where profile_id=p_profile_id;
	end if;$new$);

select pg_temp.ceiling_patch('public.qorpera_set_company_execution_pause(uuid,boolean,text)'::regprocedure,
	$old$declare v_role public.qorpera_profile_role; v_founder uuid; v_was boolean; v_kind text;$old$,
	$new$declare v_role public.qorpera_profile_role; v_was boolean;$new$);

revoke all on function public.qorpera_set_company_execution_pause(uuid,boolean,text)
	from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Drop the ceilings, their trips and their member RPCs
-- ---------------------------------------------------------------------------
drop function public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint);
drop function public.qorpera_company_execution_ceiling_json(uuid);
drop function public.qorpera_company_wakes_last_hour(uuid);
drop function public.qorpera_company_execution_ceiling(uuid);
drop table public.qorpera_company_ceiling_trips;
drop table public.qorpera_company_execution_ceilings;

-- Notices of a tripped spend, token or wake ceiling and of a pause or resume
-- describe controls that no longer exist. Machine-capacity notices keep the
-- company_ceiling_tripped kind; the pause kinds go.
delete from public.qorpera_member_notifications
where kind in ('company_execution_paused','company_execution_resumed')
	or (kind = 'company_ceiling_tripped'
		and subject ->> 'schema' = 'qorpera.member-notification.company-ceiling-tripped/v1');
alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind;
alter table public.qorpera_member_notifications add constraint qorpera_member_notifications_kind
	check (kind in ('provider_usage_limit','company_ceiling_tripped','sponsor_handoff',
		'routine_needs_model_account','routine_suspended'));

-- Nothing that runs may still name a removed object.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and (procedure.prosrc like '%qorpera_company_execution_ceiling%'
				or procedure.prosrc like '%qorpera_company_ceiling_trips%'
				or procedure.prosrc like '%qorpera_company_wakes_last_hour%'
				or procedure.prosrc like '%company_execution_paused''%'
				or procedure.prosrc like '%company_execution_resumed%')
	loop
		raise exception 'Function % still names a removed company ceiling or pause notice', v_name;
	end loop;
end
$$;

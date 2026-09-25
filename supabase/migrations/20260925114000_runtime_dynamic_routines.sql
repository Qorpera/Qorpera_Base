-- Dynamic routines (founder request 2026-09-25, contract 16.3 amendment).
--
-- A dynamic routine has no cadence. Each version holds exactly one next run
-- (trigger kind "once": at, timeZone, replyPolicy), and the run it wakes decides
-- what happens next: the next run at a time it chooses, optionally with changed
-- instructions (a new version, so history stays), or the routine's conclusion.
--
-- - The kernel keeps exactly one pending run for an active dynamic routine. A
--   save inserts the version's run at once; the control-plane tick restores a
--   run that ended without deciding (failed, crashed, refused): three retries at
--   once, then after 15 minutes, 30, an hour and so on, at most a day apart. It
--   never gives up by itself (founder, 2026-09-25); no count caps anything.
-- - A dynamic run may not send its final message, and cannot complete, until
--   the routine moved on: a newer version, a conclusion, or a member's pause or
--   removal. The runtime shows the agent the reason before the kernel refuses.
-- - Quiet hours, expiry, the unattended sponsor and the authorization-failure
--   suspension apply as to any routine.
-- - A new version cancels queued occurrences of older versions at once, and a
--   concluded routine cancels its queued ones; admission already refused both.
-- - Fixed routines (schedule, listener) are unchanged. The orchestrator lists
--   routines with schedule cursors only, and a dynamic routine has none.

create function pg_temp.dynamic_patch(p_target regprocedure, variadic p_pairs text[])
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_index integer := 1;
begin
	while v_index < cardinality(p_pairs) loop
		if (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]) <> 1 then
			raise exception 'Dynamic routine patch differs: % near %', p_target, left(p_pairs[v_index], 60); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
		v_index := v_index + 2;
	end loop;
	execute v_definition;
end
$$;

-- ---------------------------------------------------------------------------
-- The routine row: a conclusion with its reason
-- ---------------------------------------------------------------------------
alter table public.qorpera_cloud_routines
	drop constraint qorpera_cloud_routines_status_check,
	add constraint qorpera_cloud_routines_status_check
		check (status in ('active','paused','retired','expired','concluded')),
	add column conclusion text,
	add column concluded_at timestamptz,
	add column concluded_by_run_id uuid,
	add constraint qorpera_cloud_routines_conclusion check (
		(status = 'concluded' and concluded_at is not null and conclusion is not null
			and octet_length(conclusion) between 1 and 2000)
		or (status <> 'concluded' and concluded_at is null and conclusion is null and concluded_by_run_id is null));

-- Any path that moves a routine out of "concluded" (a new save, a member's
-- pause or resume, a removal) drops the old conclusion with it, and a pause
-- reason lasts only while the routine is paused (the member save path kept it).
create function public.qorpera_routine_conclusion_follows_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.status <> 'paused' then new.pause_reason := null; end if;
	if new.status <> 'concluded' then
		new.conclusion := null; new.concluded_at := null; new.concluded_by_run_id := null;
	end if;
	return new;
end
$$;
create trigger qorpera_cloud_routine_conclusion before update of status on public.qorpera_cloud_routines
	for each row execute function public.qorpera_routine_conclusion_follows_status();

-- ---------------------------------------------------------------------------
-- The trigger: "once" is one run at one instant
-- ---------------------------------------------------------------------------
select pg_temp.dynamic_patch('public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure,
	$old$	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'$old$,
	$new$	if p_trigger ->> 'kind' = 'once' then
		return coalesce(p_trigger ?& array['id','kind','at','timeZone']
			and p_trigger - array['id','kind','at','timeZone','replyPolicy'] = '{}'::jsonb
			and jsonb_typeof(p_trigger -> 'id') = 'string'
			and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
			and jsonb_typeof(p_trigger -> 'at') = 'string'
			and p_trigger ->> 'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
			and (p_trigger ->> 'at')::timestamptz is not null
			and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
			and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'),false);
	end if;
	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'$new$);

-- A once occurrence is a scheduled occurrence, with its trigger's reply policy.
select pg_temp.dynamic_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$or (new.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')$old$,
	$new$or (new.source_kind = 'schedule' and v_trigger ->> 'kind' not in ('schedule','once'))$new$);
select pg_temp.dynamic_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$(v_wake.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')$old$,
	$new$(v_wake.source_kind = 'schedule' and v_trigger ->> 'kind' not in ('schedule','once'))$new$);

-- The run that concluded its routine still completes (and any continuation of
-- its own work); a conclusion by anyone else stops a started run as a pause
-- does, and nothing queued survives it (the trigger below cancels it).
select pg_temp.dynamic_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$(r.status = 'active' or (r.status = 'expired' and r.expired_while_active))$old$,
	$new$(r.status = 'active' or (r.status = 'expired' and r.expired_while_active)
			or (r.status = 'concluded' and r.concluded_by_run_id = p_wake.run_id))$new$);

create function public.qorpera_routine_pending_follows_routine()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.status = 'concluded' and old.status <> 'concluded' then
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
			blocked_reason = 'Routine was concluded'
		where routine_id = new.id and wake_kind = 'routine' and status = 'queued';
	end if;
	if new.current_version > old.current_version then
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
			blocked_reason = 'Superseded by a newer version'
		where routine_id = new.id and wake_kind = 'routine' and status = 'queued' and routine_version < new.current_version;
	end if;
	return null;
end
$$;
create trigger qorpera_cloud_routine_pending after update of status, current_version on public.qorpera_cloud_routines
	for each row execute function public.qorpera_routine_pending_follows_routine();

-- ---------------------------------------------------------------------------
-- Exactly one pending run
-- ---------------------------------------------------------------------------
-- The occurrence of this version still to run: queued, or admitted with its run unfinished.
create function public.qorpera_dynamic_routine_pending_occurrence(p_routine_id uuid, p_version bigint)
returns uuid language sql stable security definer set search_path = '' as $$
	select wake.id from public.qorpera_wake_occurrences wake
	where wake.routine_id = p_routine_id and wake.routine_version = p_version
		and (wake.status = 'queued' or (wake.status = 'materialized' and exists (
			select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
			where run.id = wake.run_id and job.status in ('queued','leased'))))
	order by wake.created_at desc limit 1
$$;

-- Inserts the run an active dynamic routine is missing. The version's own run is
-- due at its chosen instant (now, if that has passed). A run that ended without
-- deciding is retried at once three times, then 15 minutes after the fourth end,
-- doubling to at most a day. The company pause, expiry and quiet hours hold as for
-- every routine occurrence (qorpera_routine_occurrence_lifecycle).
create function public.qorpera_ensure_dynamic_routine_run(p_routine_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_trigger jsonb; v_ended integer; v_at timestamptz; v_id uuid; v_last public.qorpera_wake_occurrences%rowtype;
begin
	-- SKIP LOCKED: the tick never waits on a routine an agent is saving; the next tick retries.
	-- A caller that already holds the row (a save) still gets it.
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id for update skip locked;
	-- Dynamic routines belong to agents (a member save cannot create one).
	if not found or v_routine.status <> 'active' or v_routine.origin <> 'agent' then return null; end if;
	select * into strict v_version from public.qorpera_cloud_routine_versions
	where routine_id = v_routine.id and version = v_routine.current_version;
	v_trigger := v_version.triggers -> 0;
	if jsonb_array_length(v_version.triggers) <> 1 or v_trigger ->> 'kind' is distinct from 'once' then return null; end if;
	v_id := public.qorpera_dynamic_routine_pending_occurrence(v_routine.id, v_routine.current_version);
	if v_id is not null or public.qorpera_company_execution_paused(v_routine.profile_id) then return v_id; end if;
	-- Runs of one routine never overlap: a run of an older version that is still
	-- working (it decided, or someone changed the routine meanwhile) ends first,
	-- and the tick inserts this version's run after it.
	if exists (select 1 from public.qorpera_wake_occurrences wake where wake.routine_id = v_routine.id
		and wake.status = 'materialized' and public.qorpera_wake_run_live(wake.run_id)) then return null; end if;
	-- A member's Stop of the routine's latest run stops the routine: it pauses, visibly,
	-- instead of running again, also when that run had already chosen its next run
	-- (a newer version).
	select wake.* into v_last from public.qorpera_wake_occurrences wake
	where wake.routine_id = v_routine.id
	order by wake.created_at desc, wake.id desc limit 1;
	-- It acts once: the stopped occurrence is marked, so a resume runs the routine again.
	if v_last.run_id is not null and v_last.blocked_reason is distinct from 'A member stopped this run; the routine paused'
		and exists (select 1 from public.qorpera_execution_runs run
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = v_last.run_id and job.status = 'cancelled' and job.cancelled_by_user_id is not null) then
		update public.qorpera_wake_occurrences set blocked_reason = 'A member stopped this run; the routine paused'
		where id = v_last.id;
		update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'member', updated_at = statement_timestamp()
		where id = v_routine.id;
		return null;
	end if;
	select count(*) into v_ended from public.qorpera_wake_occurrences
	where routine_id = v_routine.id and routine_version = v_routine.current_version;
	v_at := case when v_ended = 0 then greatest((v_trigger ->> 'at')::timestamptz, statement_timestamp())
		when v_ended <= 3 then statement_timestamp()
		else statement_timestamp() + least(interval '15 minutes' * power(2, least(v_ended - 4, 12)), interval '1 day') end;
	-- An expired or limited routine is closed by the lifecycle sweep, not here.
	if (v_routine.expires_at is not null and v_at >= v_routine.expires_at)
		or (v_routine.max_occurrences is not null and (select count(*) from public.qorpera_wake_occurrences
			where routine_id = v_routine.id) >= v_routine.max_occurrences) then return null; end if;
	v_id := extensions.gen_random_uuid();
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version,
		trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (v_id, v_routine.profile_id, v_routine.environment_id, v_routine.id, v_routine.current_version,
		v_trigger ->> 'id', 'once:' || v_routine.current_version || ':' || (v_ended + 1), v_at, v_at,
		jsonb_build_object('schema','qorpera.routine-once-occurrence/v1','attempt',v_ended + 1));
	return v_id;
end
$$;

-- The control-plane tick restores a pending run wherever one is missing. It visits
-- only routines that can take a run now: none while one of its runs is still
-- working (that run's own authority checks lock the routine NOWAIT) or while its
-- company is paused. A routine whose run the kernel refuses for want of
-- authority (its audience or agent is gone) is suspended and its member told
-- once, as three refused occurrences suspend any routine, instead of being
-- retried on every tick. One routine never stops the others.
create function public.qorpera_restore_dynamic_routine_runs()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count integer := 0; v_routine public.qorpera_cloud_routines%rowtype; v_owner uuid;
begin
	for v_id in select routine.id from public.qorpera_cloud_routines routine
		join public.qorpera_cloud_routine_versions version
			on version.routine_id = routine.id and version.version = routine.current_version
		where routine.status = 'active' and routine.origin = 'agent' and version.triggers -> 0 ->> 'kind' = 'once'
			and public.qorpera_dynamic_routine_pending_occurrence(routine.id, routine.current_version) is null
			and not exists (select 1 from public.qorpera_wake_occurrences wake where wake.routine_id = routine.id
				and wake.status = 'materialized' and public.qorpera_wake_run_live(wake.run_id))
			and not public.qorpera_company_execution_paused(routine.profile_id)
		order by routine.id
	loop
		begin
			if public.qorpera_ensure_dynamic_routine_run(v_id) is not null then v_count := v_count + 1; end if;
		exception when insufficient_privilege then
			v_routine := null;
			update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'authorization_failed',
				updated_at = statement_timestamp()
			where id = v_id and status = 'active' returning * into v_routine;
			if v_routine.id is not null then
				select version.created_by_user_id into v_owner from public.qorpera_cloud_routine_versions version
				where version.routine_id = v_routine.id and version.version = v_routine.current_version;
				insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
				values (v_routine.profile_id, coalesce(v_owner, v_routine.created_by_user_id), 'routine_suspended',
					jsonb_build_object('routineId', v_routine.id, 'staffAgentId', v_routine.owner_staff_agent_id,
						'reason', 'authorization_failed'), 'routine:' || v_routine.id::text)
				on conflict do nothing;
			end if;
		when others then
			raise warning 'Dynamic routine % has no admissible next run: %', v_id, sqlerrm;
		end;
	end loop;
	return v_count;
end
$$;

select pg_temp.dynamic_patch('public.qorpera_drain_company_file_wakes(integer)'::regprocedure,
	$old$	perform public.qorpera_expire_cloud_routines();$old$,
	$new$	perform public.qorpera_expire_cloud_routines();
	perform public.qorpera_restore_dynamic_routine_runs();$new$);

-- ---------------------------------------------------------------------------
-- The decision a dynamic run owes
-- ---------------------------------------------------------------------------
-- True while this run's dynamic routine still stands where the run found it:
-- active, not past its expiry, and no newer version. A newer version, a
-- conclusion, a pause, a removal or an expiry (by anyone) settles it.
create function public.qorpera_routine_decision_pending(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences wake
		join public.qorpera_cloud_routines routine on routine.id = wake.routine_id
		join public.qorpera_cloud_routine_versions version
			on version.routine_id = wake.routine_id and version.version = wake.routine_version
		where wake.run_id = p_run_id and wake.wake_kind = 'routine' and version.triggers -> 0 ->> 'kind' = 'once'
			and jsonb_array_length(version.triggers) = 1 and routine.origin = 'agent'
			and routine.status = 'active' and routine.current_version = wake.routine_version
			and (routine.expires_at is null or routine.expires_at > statement_timestamp()))
$$;

select pg_temp.dynamic_patch('public.qorpera_assert_wake_completion(uuid)'::regprocedure,
	$old$begin
	select count(*),count(*) filter(where s.phase = 'final')$old$,
	$new$begin
	if public.qorpera_routine_decision_pending(p_run_id) then
		raise exception 'Dynamic routine run ended without deciding its next run' using errcode = '55000'; end if;
	select count(*),count(*) filter(where s.phase = 'final')$new$);

-- The final message closes the turn, so the decision comes first.
select pg_temp.dynamic_patch('public.qorpera_send_native_agent_message(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
	$old$	select runner.session_token_sha256 into strict v_session_token_sha256$old$,
	$new$	if p_phase = 'final' and public.qorpera_routine_decision_pending(p_run_id) then
		raise exception 'Decide this routine''s next run or conclude it before the final message' using errcode = '55000'; end if;
	select runner.session_token_sha256 into strict v_session_token_sha256$new$);

-- The run learns that its routine is dynamic.
select pg_temp.dynamic_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$		select jsonb_build_object('id',routine_id,'version',version,'intent',prompt) into v_routine$old$,
	$new$		select jsonb_build_object('id',routine_id,'version',version,'intent',prompt)
			|| case when triggers -> 0 ->> 'kind' = 'once' and jsonb_array_length(triggers) = 1 and exists (select 1
			from public.qorpera_cloud_routines r where r.id = routine_id and r.origin = 'agent')
			then jsonb_build_object('dynamic',true,'routineKey',(select r.routine_key from public.qorpera_cloud_routines r where r.id = routine_id))
			else '{}'::jsonb end into v_routine$new$);

select pg_temp.dynamic_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'manage_routine','report_work'$old$,
	$new$'manage_routine','decide_routine','report_work'$new$);

-- ---------------------------------------------------------------------------
-- manage_routine: conclude, and a run's decision against the version it found
-- ---------------------------------------------------------------------------
select pg_temp.dynamic_patch('public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure,
	$old$		v_trigger := v_trigger || jsonb_build_object('id', 'agent');
		v_triggers := jsonb_build_array(v_trigger);$old$,
	$new$		v_trigger := v_trigger || jsonb_build_object('id', 'agent');
		-- A dynamic save without a time keeps the next run the routine already has
		-- (a time still ahead), or runs now. The request and its digest stay the model's own.
		if v_trigger ->> 'kind' = 'once' and not v_trigger ? 'at' then
			v_trigger := v_trigger || jsonb_build_object('at', coalesce((select version.triggers -> 0 ->> 'at'
				from public.qorpera_cloud_routines routine join public.qorpera_cloud_routine_versions version
					on version.routine_id = routine.id and version.version = routine.current_version
				where routine.profile_id = v_run.profile_id and routine.environment_id = v_run.environment_id
					and routine.origin = 'agent' and routine.owner_staff_agent_id = v_run.staff_agent_id
					and routine.routine_key = v_key and routine.status = 'active'
					and version.triggers -> 0 ->> 'kind' = 'once'
					and (version.triggers -> 0 ->> 'at')::timestamptz > statement_timestamp()),
				to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
		end if;
		v_triggers := jsonb_build_array(v_trigger);$new$,
	$old$		or v_action not in ('list','upsert','pause','resume','remove') then$old$,
	$new$		or v_action not in ('list','upsert','pause','resume','remove','conclude') then$new$,
	$old$		then array['action','operationKey','routineKey','title','intent','trigger','expiresAt','maxOccurrences','quietHours','effort']
		else array['action','operationKey','routineKey'] end;$old$,
	$new$		then array['action','operationKey','routineKey','title','intent','trigger','expiresAt','maxOccurrences','quietHours','effort','expectedVersion']
		when v_action = 'conclude' then array['action','operationKey','routineKey','summary','expectedVersion']
		else array['action','operationKey','routineKey'] end;$new$,
	$old$	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');$old$,
	$new$	if p_request ? 'expectedVersion' and (jsonb_typeof(p_request -> 'expectedVersion') <> 'number'
		or (p_request ->> 'expectedVersion') !~ '^[1-9][0-9]{0,17}$') then
		raise exception 'Routine request is invalid' using errcode = '22023'; end if;
	-- A dynamic routine ends when its agent concludes it, not after a count.
	if v_action = 'upsert' and v_trigger ->> 'kind' = 'once' and v_max is not null then
		raise exception 'A dynamic routine takes no occurrence limit' using errcode = '22023'; end if;
	if v_action = 'conclude' and (jsonb_typeof(p_request -> 'summary') is distinct from 'string'
		or octet_length(convert_to(btrim(p_request ->> 'summary'),'utf8')) not between 1 and 2000) then
		raise exception 'Routine conclusion is invalid' using errcode = '22023'; end if;
	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');$new$,
	$old$		and routine.routine_key = v_key for update;$old$,
	$new$		and routine.routine_key = v_key for update;
	-- A dynamic run decides its own routine through decide_routine (which passes
	-- expectedVersion): saving or resuming it here would drop that decision, and
	-- pausing or removing it would revoke this very run. Concluding stays open.
	if v_action in ('upsert','pause','resume','remove') and not p_request ? 'expectedVersion' and v_routine.id is not null
		and exists (select 1 from public.qorpera_wake_occurrences wake
			join public.qorpera_cloud_routine_versions version
				on version.routine_id = wake.routine_id and version.version = wake.routine_version
			where wake.run_id = v_run.id and wake.wake_kind = 'routine' and wake.routine_id = v_routine.id
				and version.triggers -> 0 ->> 'kind' = 'once') then
		if v_action in ('pause','remove') then
			raise exception 'This run cannot pause or remove its own routine; conclude it instead' using errcode = '55000'; end if;
		if public.qorpera_routine_decision_pending(v_run.id) then
			raise exception 'This run decides its own routine through decide_routine' using errcode = '55000'; end if;
	end if;
	-- A run's decision applies only to the routine as that run found it.
	if p_request ? 'expectedVersion' and (v_routine.id is null or v_routine.status <> 'active'
		or v_routine.current_version <> (p_request ->> 'expectedVersion')::bigint) then
		raise exception 'Routine changed after this run started' using errcode = '55000'; end if;$new$,
	$old$		if v_version.content_sha256 is distinct from v_sha then$old$,
	$new$		if v_version.content_sha256 is distinct from v_sha or p_request ? 'expectedVersion' then$new$,
	$old$			quiet_time_zone = v_quiet ->> 'timeZone', updated_at = statement_timestamp()
		where id = v_routine.id returning * into v_routine;$old$,
	$new$			quiet_time_zone = v_quiet ->> 'timeZone', updated_at = statement_timestamp()
		where id = v_routine.id returning * into v_routine;
		perform public.qorpera_ensure_dynamic_routine_run(v_routine.id);
		select * into v_routine from public.qorpera_cloud_routines where id = v_routine.id;$new$,
	$old$		if v_action = 'pause' then$old$,
	$new$		if v_action = 'conclude' then
			update public.qorpera_cloud_routines set status = 'concluded', pause_reason = null,
				conclusion = btrim(p_request ->> 'summary'), concluded_at = statement_timestamp(), concluded_by_run_id = v_run.id,
				updated_at = statement_timestamp()
			where id = v_routine.id and status in ('active','paused','expired') returning * into v_routine;
		elsif v_action = 'pause' then$new$,
	$old$			if v_routine.status = 'expired' then$old$,
	$new$			if v_routine.status = 'concluded' then
				raise exception 'Routine was concluded; save it again to restart it' using errcode = '55000'; end if;
			if v_routine.status = 'expired' then$new$,
	$old$				authorization_failures = 0, updated_at = statement_timestamp()
			where id = v_routine.id returning * into v_routine;$old$,
	$new$				authorization_failures = 0, updated_at = statement_timestamp()
			where id = v_routine.id returning * into v_routine;
			perform public.qorpera_ensure_dynamic_routine_run(v_routine.id);
			select * into v_routine from public.qorpera_cloud_routines where id = v_routine.id;$new$);

-- What an agent and a member see: the next run, and how a routine ended.
create function public.qorpera_routine_next_run_at(p_routine_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select case when routine.status <> 'active' then null else coalesce(
		(select min(wake.not_before) from public.qorpera_wake_occurrences wake
			where wake.routine_id = routine.id and wake.routine_version = routine.current_version and wake.status = 'queued'),
		(select min(cursor.next_due_at) from public.qorpera_cloud_routine_schedule_cursors cursor
			where cursor.routine_id = routine.id and cursor.routine_version = routine.current_version
				and cursor.last_scheduled_for is not null and cursor.next_due_at > '-infinity'::timestamptz),
		-- A dynamic routine's chosen time, before the tick inserts its run (not while
		-- a run of this version works: then the next run is not chosen yet).
		(select greatest((version.triggers -> 0 ->> 'at')::timestamptz, statement_timestamp())
			from public.qorpera_cloud_routine_versions version
			where version.routine_id = routine.id and version.version = routine.current_version
				and version.triggers -> 0 ->> 'kind' = 'once' and routine.origin = 'agent'
				and not exists (select 1 from public.qorpera_wake_occurrences wake
					where wake.routine_id = routine.id and wake.routine_version = routine.current_version))) end
	from public.qorpera_cloud_routines routine where routine.id = p_routine_id
$$;
select pg_temp.dynamic_patch('public.qorpera_agent_routine_view(public.qorpera_cloud_routines)'::regprocedure,
	$old$'occurrences', (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine.id))$old$,
	$new$'occurrences', (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine.id),
		'nextRunAt', public.qorpera_routine_next_run_at(p_routine.id), 'conclusion', p_routine.conclusion,
		'concludedAt', p_routine.concluded_at)$new$);
select pg_temp.dynamic_patch('public.qorpera_list_cloud_routines(uuid)'::regprocedure,
	$old$			'updated_at', routine.updated_at
		) order by routine.created_at, routine.id)$old$,
	$new$			'updated_at', routine.updated_at,
			'next_run_at', public.qorpera_routine_next_run_at(routine.id),
			'conclusion', routine.conclusion,
			'concluded_at', routine.concluded_at
		) order by routine.created_at, routine.id)$new$);

-- Dynamic routines belong to agents: a member save (the web's pause and resume)
-- may keep an agent routine's one next run, never create one or turn a fixed
-- routine into one.
select pg_temp.dynamic_patch('public.qorpera_upsert_cloud_routine(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid,bigint,uuid,text,text,boolean,text,text,uuid[])'::regprocedure,
	$old$	elsif v_routine.environment_id <> p_environment_id or v_routine.status = 'retired' then
		raise exception 'cloud routine identity is unavailable' using errcode = '55000';
	end if;$old$,
	$new$	elsif v_routine.environment_id <> p_environment_id or v_routine.status = 'retired' then
		raise exception 'cloud routine identity is unavailable' using errcode = '55000';
	end if;
	if exists (select 1 from jsonb_array_elements(p_triggers) trigger(value) where trigger.value ->> 'kind' = 'once')
		and (v_routine.origin is distinct from 'agent' or jsonb_array_length(p_triggers) <> 1
			or not exists (select 1 from public.qorpera_cloud_routine_versions version where version.routine_id = v_routine.id
				and version.version = v_routine.current_version and version.triggers -> 0 ->> 'kind' = 'once')) then
		raise exception 'cloud routine triggers are invalid' using errcode = '22023'; end if;$new$);

-- ---------------------------------------------------------------------------
-- decide_routine: the dynamic run's own decision
-- ---------------------------------------------------------------------------
-- Only a run woken by a dynamic routine of its own agent decides it, and only
-- about the version it found. next saves a new version whose one run is at the
-- chosen instant (a past or present instant means now), with the instructions,
-- title, effort and reporting it gives or the current ones; conclude ends the
-- routine with a one-line reason. Both go through manage_agent_routine, so the
-- sponsor, quiet hours, expiry, receipts and replay are the ordinary ones. If the
-- routine already moved on (a member paused, removed or changed it), nothing is
-- owed: the result says so instead of failing.
create function public.qorpera_decide_agent_routine(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_routine public.qorpera_cloud_routines%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_action text := p_request ->> 'action'; v_key text := p_request ->> 'operationKey';
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id and wake_kind = 'routine';
	if found then
		select * into v_routine from public.qorpera_cloud_routines where id = v_wake.routine_id;
		select * into v_version from public.qorpera_cloud_routine_versions
		where routine_id = v_wake.routine_id and version = v_wake.routine_version;
	end if;
	if v_wake.id is null or v_routine.origin is distinct from 'agent'
		or v_routine.owner_staff_agent_id is distinct from v_run.staff_agent_id
		or v_version.triggers -> 0 ->> 'kind' is distinct from 'once' then
		raise exception 'Only a run of a dynamic routine decides it' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or v_action is null or v_action not in ('next','conclude')
		or coalesce(v_key,'') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or exists (select 1 from jsonb_object_keys(p_request) k where k <> all(case when v_action = 'next'
			then array['action','operationKey','at','intent','title','effort','report']
			else array['action','operationKey','summary'] end))
		or (v_action = 'next' and (jsonb_typeof(p_request -> 'at') is distinct from 'string'
			or (p_request ->> 'at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$')) then
		raise exception 'Routine decision is invalid' using errcode = '22023'; end if;
	v_key := 'decide.' || encode(extensions.digest(convert_to(v_key,'utf8'),'sha256'),'hex');
	if v_routine.expires_at is null or v_routine.expires_at > statement_timestamp() then
		-- Only a decision still owed can be refused; a routine that moved on is settled below.
		if v_action = 'next' and v_routine.expires_at is not null and (p_request ->> 'at')::timestamptz >= v_routine.expires_at
			and public.qorpera_routine_decision_pending(v_run.id) then
			return jsonb_build_object('schema','qorpera.agent-routine-decision/v1','runId',v_run.id,'state','refused',
				'reason','The routine ends at ' || to_char(v_routine.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
					|| '. Choose an earlier time or conclude it.');
		end if;
		begin
			if v_action = 'conclude' then
				return public.qorpera_manage_agent_routine(p_binding, jsonb_build_object('action','conclude','operationKey',v_key,
					'routineKey',v_routine.routine_key,'summary',p_request -> 'summary','expectedVersion',v_wake.routine_version));
			end if;
			return public.qorpera_manage_agent_routine(p_binding, jsonb_build_object('action','upsert','operationKey',v_key,
				'routineKey',v_routine.routine_key,
				'title',coalesce(p_request -> 'title', to_jsonb(v_version.title)),
				'intent',coalesce(p_request -> 'intent', to_jsonb(v_version.prompt)),
				'trigger',jsonb_build_object('kind','once','at',p_request ->> 'at',
					'timeZone',v_version.triggers -> 0 ->> 'timeZone',
					'replyPolicy',coalesce(p_request ->> 'report', v_version.triggers -> 0 ->> 'replyPolicy', 'optional')),
				'expectedVersion',v_wake.routine_version)
				|| case when p_request ? 'effort' then jsonb_build_object('effort',p_request -> 'effort') else '{}'::jsonb end
				|| case when v_routine.quiet_start is null then '{}'::jsonb else jsonb_build_object('quietHours',jsonb_build_object(
					'start',to_char(v_routine.quiet_start,'HH24:MI'),'end',to_char(v_routine.quiet_end,'HH24:MI'),
					'timeZone',v_routine.quiet_time_zone)) end
				|| case when v_routine.expires_at is null then '{}'::jsonb else jsonb_build_object('expiresAt',
					to_char(v_routine.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end);
		exception when sqlstate '55000' or sqlstate '23505' then
			-- A replay of this decision returns its receipt above. A routine that moved on
			-- without it lands here, and so does a replay whose delegated request changed
			-- because someone edited the routine since (quiet hours, expiry): both settled.
			if sqlerrm not in ('Routine changed after this run started','logical operation key is already bound to other work')
				then raise; end if;
		end;
	end if;
	select * into v_routine from public.qorpera_cloud_routines where id = v_wake.routine_id;
	return jsonb_build_object('schema','qorpera.agent-routine-decision/v1','runId',v_run.id,'state','settled',
		'routine',case when v_routine.status = 'retired'
			then jsonb_build_object('routineKey',v_routine.routine_key,'status','retired')
			else public.qorpera_agent_routine_view(v_routine) end);
end
$$;
revoke all on function public.qorpera_decide_agent_routine(jsonb, jsonb) from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_decide_agent_routine(jsonb, jsonb) to service_role;

-- Internal only: definer functions and triggers call these. PostgreSQL grants
-- EXECUTE to PUBLIC on creation, and the secret broker keeps its three calls (306).
revoke all on function public.qorpera_routine_conclusion_follows_status() from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_routine_pending_follows_routine() from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_dynamic_routine_pending_occurrence(uuid, bigint) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_ensure_dynamic_routine_run(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_restore_dynamic_routine_runs() from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_routine_decision_pending(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_routine_next_run_at(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

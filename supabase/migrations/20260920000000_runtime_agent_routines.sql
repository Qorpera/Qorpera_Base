-- Order 8, part 1: an agent sets up its own standing work.
--
-- Until now a routine could only be saved by an owner or admin member
-- (qorpera_upsert_cloud_routine, auth.uid()). An agent could not give itself a
-- cadence, which is how a responsibility is meant to stay alive (contract 14.3,
-- 16.3). This adds the run-bound operation for that, and the scheduler rules the
-- contract requires to be code rather than prose:
--
--   * expiry and finite watches (expires_at, max_occurrences -> status 'expired');
--   * a quiet window per routine: an occurrence admitted inside it waits for
--     the window's end instead of waking people at night;
--   * suspension after repeated authorization failures, with one durable
--     notification to the member whose account the routine runs on.
--
-- Founder decision 2026-09-19: an agent's routine needs no member approval.
-- What an unattended run does need is a model account whose owner has allowed
-- unattended use (allow_autonomous). That is an account setting made once, not
-- a per-routine approval. When none is available the routine is saved paused
-- with reason 'needs_model_account' and the member is told once.

alter table public.qorpera_cloud_routines
	drop constraint qorpera_cloud_routines_status_check,
	add constraint qorpera_cloud_routines_status_check
		check (status in ('active','paused','retired','expired')),
	add column origin text not null default 'member' check (origin in ('member','agent','responsibility')),
	add column owner_staff_agent_id uuid,
	add column routine_key text check (routine_key is null or routine_key ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
	add column expires_at timestamptz,
	add column max_occurrences integer check (max_occurrences is null or max_occurrences between 1 and 100000),
	add column quiet_start time,
	add column quiet_end time,
	add column quiet_time_zone text,
	add column pause_reason text check (pause_reason is null or pause_reason in
		('agent','member','needs_model_account','authorization_failed')),
	add column authorization_failures integer not null default 0 check (authorization_failures >= 0),
	add constraint qorpera_cloud_routines_agent_identity check (
		(origin = 'member' and owner_staff_agent_id is null and routine_key is null)
		or (origin <> 'member' and owner_staff_agent_id is not null and routine_key is not null)),
	add constraint qorpera_cloud_routines_quiet check (
		(quiet_start is null and quiet_end is null and quiet_time_zone is null)
		or (quiet_start is not null and quiet_end is not null and quiet_time_zone is not null
			and quiet_start <> quiet_end)),
	add constraint qorpera_cloud_routines_owner_staff foreign key (profile_id, owner_staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete restrict;
create unique index qorpera_cloud_routines_agent_key
	on public.qorpera_cloud_routines(profile_id, environment_id, owner_staff_agent_id, routine_key)
	where origin <> 'member';
create index qorpera_cloud_routines_expiry on public.qorpera_cloud_routines(expires_at)
	where status in ('active','paused') and expires_at is not null;

alter table public.qorpera_member_notifications
	drop constraint qorpera_member_notifications_kind,
	add constraint qorpera_member_notifications_kind check (kind in (
		'provider_usage_limit','company_ceiling_tripped','company_execution_paused',
		'company_execution_resumed','sponsor_handoff','routine_needs_model_account','routine_suspended'));

-- The model account an unattended run of this agent may use, or null. Prefers
-- the account the current run already uses; otherwise the requesting member's
-- most recent account that allows unattended use.
create function public.qorpera_agent_routine_sponsor(p_run public.qorpera_execution_runs)
returns table(binding_id uuid, version bigint, owner_user_id uuid)
language sql stable security definer set search_path = '' as $$
	select binding.id, sponsor.version, connection.owner_user_id
	from public.qorpera_execution_sponsor_bindings binding
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
	join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
	where binding.profile_id = p_run.profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_run.profile_id and connection.status = 'active'
		and public.qorpera_provider_autonomous_authority(connection.id, sponsor.provider_connection_version)
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions latest
			where latest.binding_id = binding.id)
		and (binding.id = p_run.sponsor_binding_id
			or sponsor.sponsor_kind <> 'member_connection'
			or connection.owner_user_id = p_run.requested_by_user_id)
	order by (binding.id = p_run.sponsor_binding_id) desc, sponsor.created_at desc, binding.id
	limit 1
$$;
revoke all on function public.qorpera_agent_routine_sponsor(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role;

create function public.qorpera_agent_routine_view(p_routine public.qorpera_cloud_routines)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('routineKey', p_routine.routine_key, 'routineId', p_routine.id, 'origin', p_routine.origin,
		'version', p_routine.current_version, 'status', p_routine.status, 'pauseReason', p_routine.pause_reason,
		'title', version.title, 'intent', version.prompt, 'trigger', version.triggers -> 0,
		'expiresAt', p_routine.expires_at, 'maxOccurrences', p_routine.max_occurrences,
		'quietHours', case when p_routine.quiet_start is null then null else jsonb_build_object(
			'start', to_char(p_routine.quiet_start, 'HH24:MI'), 'end', to_char(p_routine.quiet_end, 'HH24:MI'),
			'timeZone', p_routine.quiet_time_zone) end,
		'occurrences', (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine.id))
	from public.qorpera_cloud_routine_versions version
	where version.routine_id = p_routine.id and version.version = p_routine.current_version
$$;
revoke all on function public.qorpera_agent_routine_view(public.qorpera_cloud_routines)
	from public, anon, authenticated, service_role;

-- One run-bound operation: list, upsert, pause, resume, remove. The routine
-- always belongs to the calling agent; the model cannot choose another agent,
-- a sponsor, a requester or a computer.
create function public.qorpera_manage_agent_routine(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb;
	v_action text := p_request ->> 'action'; v_key text := p_request ->> 'routineKey';
	v_routine public.qorpera_cloud_routines%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_trigger jsonb; v_triggers jsonb; v_sponsor_binding uuid; v_sponsor_version bigint; v_has_sponsor boolean; v_content jsonb; v_sha text;
	v_digest text; v_receipt uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_quiet jsonb := p_request -> 'quietHours'; v_expires timestamptz; v_max integer; v_next bigint;
	v_status text; v_reason text; v_allowed text[];
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null then
		raise exception 'Routine authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or v_action is null
		or v_action not in ('list','upsert','pause','resume','remove') then
		raise exception 'Routine request is invalid' using errcode = '22023'; end if;

	if v_action = 'list' then
		if (select count(*) from jsonb_object_keys(p_request)) <> 1 then
			raise exception 'Routine request is invalid' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.agent-routines/v1','runId',v_run.id,'routines',coalesce((
			select jsonb_agg(public.qorpera_agent_routine_view(routine) order by routine.routine_key)
			from public.qorpera_cloud_routines routine
			where routine.profile_id = v_run.profile_id and routine.environment_id = v_run.environment_id
				-- A responsibility's cadence is shown so the agent does not duplicate it; only its own are editable.
				and routine.origin in ('agent','responsibility') and routine.owner_staff_agent_id = v_run.staff_agent_id
				and routine.status <> 'retired'), '[]'::jsonb));
	end if;

	v_allowed := case when v_action = 'upsert'
		then array['action','operationKey','routineKey','title','intent','trigger','expiresAt','maxOccurrences','quietHours']
		else array['action','operationKey','routineKey'] end;
	if exists (select 1 from jsonb_object_keys(p_request) key where key <> all(v_allowed))
		or coalesce(p_request ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(v_key,'') !~ '^[a-z0-9][a-z0-9._-]{0,95}$' then
		raise exception 'Routine request is invalid' using errcode = '22023'; end if;

	if v_action = 'upsert' then
		v_trigger := p_request -> 'trigger';
		if jsonb_typeof(v_trigger) is distinct from 'object' or v_trigger ? 'id' then
			raise exception 'Routine trigger is invalid' using errcode = '22023'; end if;
		v_trigger := v_trigger || jsonb_build_object('id', 'agent');
		v_triggers := jsonb_build_array(v_trigger);
		if not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or octet_length(convert_to(btrim(coalesce(p_request ->> 'title','')),'utf8')) not between 1 and 160
			or (p_request ->> 'title') ~ E'[\r\n]'
			or octet_length(convert_to(btrim(coalesce(p_request ->> 'intent','')),'utf8')) not between 1 and 32768 then
			raise exception 'Routine trigger or intent is invalid' using errcode = '22023'; end if;
		-- A file listener may only watch what this agent and its requester may read.
		if v_trigger ->> 'kind' = 'listener' and not public.qorpera_wake_path_authorized(
			v_run.environment_id, v_run.requested_by_user_id, v_run.staff_agent_id, v_trigger ->> 'path') then
			raise exception 'Routine listener path is unavailable' using errcode = '42501'; end if;
		if p_request ? 'expiresAt' and p_request -> 'expiresAt' <> 'null'::jsonb then
			begin v_expires := (p_request ->> 'expiresAt')::timestamptz;
			exception when others then raise exception 'Routine expiry is invalid' using errcode = '22023'; end;
			if v_expires <= statement_timestamp() or v_expires > statement_timestamp() + interval '5 years' then
				raise exception 'Routine expiry is invalid' using errcode = '22023'; end if;
		end if;
		if p_request ? 'maxOccurrences' and p_request -> 'maxOccurrences' <> 'null'::jsonb then
			if jsonb_typeof(p_request -> 'maxOccurrences') <> 'number'
				or (p_request ->> 'maxOccurrences') !~ '^[0-9]{1,6}$'
				or (p_request ->> 'maxOccurrences')::integer not between 1 and 100000 then
				raise exception 'Routine occurrence limit is invalid' using errcode = '22023'; end if;
			v_max := (p_request ->> 'maxOccurrences')::integer;
		end if;
		if v_quiet is not null and v_quiet <> 'null'::jsonb then
			if jsonb_typeof(v_quiet) <> 'object'
				or (select count(*) from jsonb_object_keys(v_quiet)) <> 3
				or coalesce(v_quiet ->> 'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
				or coalesce(v_quiet ->> 'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
				or v_quiet ->> 'start' = v_quiet ->> 'end'
				or not public.qorpera_runtime_time_zone_name_valid(v_quiet ->> 'timeZone') then
				raise exception 'Routine quiet hours are invalid' using errcode = '22023'; end if;
		else v_quiet := null; end if;
	end if;

	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding, v_receipt,
		'routine:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':routine:' || (p_request ->> 'operationKey'),'utf8'),'sha256'),'hex'),
		false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'state' <> 'executing' or (v_begun ->> 'receiptId')::uuid <> v_receipt then
		raise exception 'Routine operation needs reconciliation' using errcode = '55000'; end if;

	select * into v_routine from public.qorpera_cloud_routines routine
	where routine.profile_id = v_run.profile_id and routine.environment_id = v_run.environment_id
		and routine.origin = 'agent' and routine.owner_staff_agent_id = v_run.staff_agent_id
		and routine.routine_key = v_key for update;

	if v_action = 'upsert' then
		select sponsor.binding_id, sponsor.version into v_sponsor_binding, v_sponsor_version
		from public.qorpera_agent_routine_sponsor(v_run) sponsor;
		v_has_sponsor := v_sponsor_binding is not null;
		if not v_has_sponsor then
			-- The version row must pin a sponsor. Pin the run's own; it cannot run
			-- unattended until its owner allows that, so the routine stays paused.
			v_sponsor_binding := v_run.sponsor_binding_id; v_sponsor_version := v_run.sponsor_version;
		end if;
		v_content := jsonb_build_object('staff_agent_id', v_run.staff_agent_id, 'title', btrim(p_request ->> 'title'),
			'prompt', btrim(p_request ->> 'intent'), 'triggers', v_triggers, 'effort', 'low',
			'sponsor_binding_id', v_sponsor_binding, 'sponsor_version', v_sponsor_version,
			'logical_computer_id', null, 'required_capability', 'agent_turn', 'job_type', 'agent_turn',
			'publication_mode', 'automatic', 'review_policy_key', null, 'reviewer_staff_ids', '[]'::jsonb);
		v_sha := encode(extensions.digest(convert_to(v_content::text,'utf8'),'sha256'),'hex');
		v_status := case when v_has_sponsor then 'active' else 'paused' end;
		v_reason := case when v_has_sponsor then null else 'needs_model_account' end;
		if v_routine.id is null then
			if (select count(*) from public.qorpera_cloud_routines routine
				where routine.profile_id = v_run.profile_id and routine.origin = 'agent'
					and routine.owner_staff_agent_id = v_run.staff_agent_id
					and routine.status in ('active','paused')) >= 32 then
				raise exception 'Agent routine limit reached' using errcode = '54000'; end if;
			insert into public.qorpera_cloud_routines(profile_id, environment_id, client_routine_id, status,
				created_by_user_id, origin, owner_staff_agent_id, routine_key)
			values (v_run.profile_id, v_run.environment_id, extensions.gen_random_uuid(), 'paused',
				v_run.requested_by_user_id, 'agent', v_run.staff_agent_id, v_key)
			returning * into v_routine;
		elsif v_routine.status = 'retired' then
			raise exception 'Routine key was removed; use a new key' using errcode = '55000';
		end if;
		select * into v_version from public.qorpera_cloud_routine_versions version
		where version.routine_id = v_routine.id and version.version = v_routine.current_version;
		if v_version.content_sha256 is distinct from v_sha then
			v_next := v_routine.current_version + 1;
			insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id,
				environment_id, staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version,
				logical_computer_id, required_capability, job_type, publication_mode, review_policy_key,
				reviewer_staff_ids, content_sha256, created_by_user_id)
			values (v_routine.id, v_next, extensions.gen_random_uuid(), v_run.profile_id, v_run.environment_id,
				v_run.staff_agent_id, btrim(p_request ->> 'title'), btrim(p_request ->> 'intent'), v_triggers, 'low',
				v_sponsor_binding, v_sponsor_version, null, 'agent_turn', 'agent_turn', 'automatic', null, '{}',
				v_sha, v_run.requested_by_user_id);
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id)
			select v_routine.id, v_next, 'agent' where v_trigger ->> 'kind' = 'schedule';
		else v_next := v_routine.current_version; end if;
		update public.qorpera_cloud_routines set current_version = v_next, status = v_status, pause_reason = v_reason,
			expires_at = v_expires, max_occurrences = v_max, authorization_failures = 0,
			quiet_start = (v_quiet ->> 'start')::time, quiet_end = (v_quiet ->> 'end')::time,
			quiet_time_zone = v_quiet ->> 'timeZone', updated_at = statement_timestamp()
		where id = v_routine.id returning * into v_routine;
		if not v_has_sponsor then
			insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
			values (v_run.profile_id, v_run.requested_by_user_id, 'routine_needs_model_account',
				jsonb_build_object('staffAgentId', v_run.staff_agent_id, 'routineId', v_routine.id,
					'title', btrim(p_request ->> 'title')), 'agent:' || v_run.staff_agent_id::text)
			on conflict do nothing;
		end if;
	else
		if v_routine.id is null or v_routine.status = 'retired' then
			raise exception 'Routine is unavailable' using errcode = 'P0002'; end if;
		if v_action = 'pause' then
			update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'agent',
				updated_at = statement_timestamp()
			where id = v_routine.id and status = 'active' returning * into v_routine;
		elsif v_action = 'resume' then
			if v_routine.status = 'expired' then
				raise exception 'Routine has expired; save it again with a new expiry' using errcode = '55000'; end if;
			select * into v_version from public.qorpera_cloud_routine_versions version
			where version.routine_id = v_routine.id and version.version = v_routine.current_version;
			if not exists (select 1 from public.qorpera_agent_routine_sponsor(v_run) sponsor
				where sponsor.binding_id = v_version.sponsor_binding_id and sponsor.version = v_version.sponsor_version) then
				raise exception 'Routine model account is unavailable; save the routine again' using errcode = '55000'; end if;
			update public.qorpera_cloud_routines set status = 'active', pause_reason = null,
				authorization_failures = 0, updated_at = statement_timestamp()
			where id = v_routine.id returning * into v_routine;
		else
			update public.qorpera_cloud_routines set status = 'retired', pause_reason = null,
				updated_at = statement_timestamp()
			where id = v_routine.id returning * into v_routine;
		end if;
		if v_routine.id is null then
			select * into v_routine from public.qorpera_cloud_routines routine
			where routine.profile_id = v_run.profile_id and routine.origin = 'agent'
				and routine.owner_staff_agent_id = v_run.staff_agent_id and routine.routine_key = v_key;
		end if;
	end if;

	v_result := jsonb_build_object('schema','qorpera.agent-routine-receipt/v1','runId',v_run.id,'receiptId',v_receipt,
		'action',v_action,'routine',case when v_routine.status = 'retired'
			then jsonb_build_object('routineKey',v_key,'status','retired')
			else public.qorpera_agent_routine_view(v_routine) end);
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_result);
	return v_result;
end
$$;
revoke all on function public.qorpera_manage_agent_routine(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_manage_agent_routine(jsonb, jsonb) to service_role;

-- Expiry and finite watches. The schedule reconciler lists active routines only
-- and a listener cursor is active only while its routine is, so one status
-- change stops both trigger types.
create function public.qorpera_expire_cloud_routines()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
	with expired as (
		update public.qorpera_cloud_routines routine set status = 'expired', pause_reason = null,
			updated_at = statement_timestamp()
		where routine.status in ('active','paused') and routine.expires_at is not null
			and routine.expires_at <= statement_timestamp()
		returning 1)
	select count(*) into v_count from expired;
	return v_count;
end
$$;
revoke all on function public.qorpera_expire_cloud_routines() from public, anon, authenticated, service_role;

-- Quiet hours, the occurrence limit and the expiry boundary are applied where
-- every routine occurrence is born, whichever trigger type produced it.
create function public.qorpera_routine_occurrence_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_local timestamp; v_now time; v_end timestamp;
begin
	if new.wake_kind <> 'routine' or new.routine_id is null then return new; end if;
	select * into v_routine from public.qorpera_cloud_routines where id = new.routine_id for update;
	if v_routine.expires_at is not null and new.scheduled_for >= v_routine.expires_at then
		raise exception 'Routine has expired' using errcode = '55000'; end if;
	if v_routine.max_occurrences is not null and (select count(*) from public.qorpera_wake_occurrences wake
		where wake.routine_id = new.routine_id) >= v_routine.max_occurrences then
		raise exception 'Routine occurrence limit reached' using errcode = '55000'; end if;
	if v_routine.quiet_start is not null then
		v_local := greatest(new.not_before, statement_timestamp()) at time zone v_routine.quiet_time_zone;
		v_now := v_local::time;
		if (v_routine.quiet_start < v_routine.quiet_end and v_now >= v_routine.quiet_start and v_now < v_routine.quiet_end)
			or (v_routine.quiet_start > v_routine.quiet_end and (v_now >= v_routine.quiet_start or v_now < v_routine.quiet_end)) then
			v_end := date_trunc('day', v_local) + v_routine.quiet_end
				+ case when v_now >= v_routine.quiet_end then interval '1 day' else interval '0' end;
			new.not_before := v_end at time zone v_routine.quiet_time_zone;
		end if;
	end if;
	return new;
end
$$;
create trigger qorpera_wake_routine_lifecycle before insert on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_routine_occurrence_lifecycle();

create function public.qorpera_routine_occurrence_recorded()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.wake_kind = 'routine' and new.routine_id is not null then
		update public.qorpera_cloud_routines routine set status = 'expired', pause_reason = null,
			updated_at = statement_timestamp()
		where routine.id = new.routine_id and routine.status in ('active','paused')
			and routine.max_occurrences is not null
			and (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = routine.id)
				>= routine.max_occurrences;
	end if;
	return null;
end
$$;
create trigger qorpera_wake_routine_recorded after insert on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_routine_occurrence_recorded();

-- Contract 16.3: a repeated authorization failure pauses the routine and tells
-- an authorized member through one durable event. The materializer cancels an
-- occurrence whose sponsor can no longer run unattended; three in a row suspend.
create function public.qorpera_routine_authorization_outcome()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_owner uuid;
begin
	if new.wake_kind <> 'routine' or new.routine_id is null or new.status = old.status then return null; end if;
	if new.status = 'materialized' then
		update public.qorpera_cloud_routines set authorization_failures = 0
		where id = new.routine_id and authorization_failures <> 0;
	elsif new.status = 'cancelled' and new.blocked_reason = 'Wake execution authority is unavailable' then
		update public.qorpera_cloud_routines set authorization_failures = authorization_failures + 1
		where id = new.routine_id returning * into v_routine;
		if v_routine.authorization_failures >= 3 and v_routine.status = 'active' then
			update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'authorization_failed',
				updated_at = statement_timestamp() where id = v_routine.id;
			select connection.owner_user_id into v_owner
			from public.qorpera_execution_sponsor_versions sponsor
			join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
			where sponsor.binding_id = new.sponsor_binding_id and sponsor.version = new.sponsor_version;
			insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
			values (new.profile_id, coalesce(v_owner, new.requested_by_user_id), 'routine_suspended',
				jsonb_build_object('routineId', v_routine.id, 'staffAgentId', new.staff_agent_id,
					'reason', 'authorization_failed'), 'routine:' || v_routine.id::text)
			on conflict do nothing;
		end if;
	end if;
	return null;
end
$$;
create trigger qorpera_wake_routine_authorization after update of status on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_routine_authorization_outcome();

-- Run the expiry sweep where the control plane already visits every tick.
alter function public.qorpera_drain_company_file_wakes(integer) rename to qorpera_drain_company_file_wakes_before_lifecycle;
create function public.qorpera_drain_company_file_wakes(p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File wake drain requires control-plane authority' using errcode = '42501'; end if;
	perform public.qorpera_expire_cloud_routines();
	return public.qorpera_drain_company_file_wakes_before_lifecycle(p_limit);
end
$$;
revoke all on function public.qorpera_drain_company_file_wakes(integer) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_drain_company_file_wakes(integer) to service_role;
revoke all on function public.qorpera_drain_company_file_wakes_before_lifecycle(integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_drain_company_file_wakes_before_lifecycle(integer) to service_role;

-- No function here is callable by default: PostgreSQL grants EXECUTE to PUBLIC on creation, and the secret
-- broker must keep exactly its three custody calls (306_governed_company_computer_privileges).
revoke all on function public.qorpera_agent_routine_sponsor(public.qorpera_execution_runs) from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_agent_routine_view(public.qorpera_cloud_routines) from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_manage_agent_routine(jsonb, jsonb) from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_expire_cloud_routines() from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_routine_occurrence_lifecycle() from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_routine_occurrence_recorded() from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_routine_authorization_outcome() from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_drain_company_file_wakes(integer) from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_drain_company_file_wakes_before_lifecycle(integer) from public, anon, authenticated, qorpera_secret_broker;

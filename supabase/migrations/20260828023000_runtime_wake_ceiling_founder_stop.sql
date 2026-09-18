-- Runtime Step 3 (contract 7.4, Order 3 placement): the wake-rate ceiling and
-- the founder stop. Every company has a kernel-owned ceiling on autonomous
-- wakes per hour (routine, agent and room wakes; human input is not a loop),
-- enforced at wake admission: a wake beyond the ceiling is admitted only as a
-- cancelled, durable occurrence with its reason, a trip is recorded and the
-- founders are notified from the control plane. The founder stop pauses a
-- company: no new wakes or turns are admitted and running work is fenced at
-- its next governed effect; resuming lifts the pause. Queued wakes wait.

alter table public.qorpera_company_execution_ceilings
	add column wakes_per_hour bigint not null default 240 check (wakes_per_hour between 1 and 1000000);
alter table public.qorpera_company_ceiling_trips drop constraint qorpera_company_ceiling_trips_dimension_check;
alter table public.qorpera_company_ceiling_trips
	add constraint qorpera_company_ceiling_trips_dimension_check check (dimension in ('spend','tokens','wakes'));
alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind;
alter table public.qorpera_member_notifications add constraint qorpera_member_notifications_kind
	check (kind in ('provider_usage_limit','company_ceiling_tripped','company_execution_paused','company_execution_resumed'));

create table public.qorpera_company_execution_pauses (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	paused_by_user_id uuid not null references auth.users(id) on delete restrict,
	reason text check (reason is null or char_length(reason) between 1 and 1024),
	paused_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_company_execution_pauses enable row level security;
revoke all on public.qorpera_company_execution_pauses from public, anon, authenticated, service_role;
grant select on public.qorpera_company_execution_pauses to service_role;

create function public.qorpera_company_execution_paused(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id)
$$;
revoke all on function public.qorpera_company_execution_paused(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_company_execution_paused(uuid) to service_role;

drop function public.qorpera_company_execution_ceiling(uuid);
create function public.qorpera_company_execution_ceiling(p_profile_id uuid)
returns table (spend_microusd_per_period bigint,tokens_per_period bigint,wakes_per_hour bigint,configured boolean,version bigint)
language sql stable security definer set search_path = '' as $$
	select coalesce(ceiling.spend_microusd_per_period,250000000::bigint),
		coalesce(ceiling.tokens_per_period,100000000::bigint),
		coalesce(ceiling.wakes_per_hour,240::bigint),
		ceiling.profile_id is not null,coalesce(ceiling.version,0::bigint)
	from (select null::uuid dummy) singleton
	left join public.qorpera_company_execution_ceilings ceiling on ceiling.profile_id = p_profile_id
$$;
revoke all on function public.qorpera_company_execution_ceiling(uuid) from public, anon, authenticated;

-- Autonomous wakes admitted (not cancelled) for the company in the last hour.
create function public.qorpera_company_wakes_last_hour(p_profile_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
	select count(*) from public.qorpera_wake_occurrences
	where profile_id = p_profile_id and wake_kind in ('routine','agent','room') and status <> 'cancelled'
		and created_at > clock_timestamp() - interval '1 hour'
$$;
revoke all on function public.qorpera_company_wakes_last_hour(uuid) from public, anon, authenticated, service_role;

drop function public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint);
create function public.qorpera_set_company_execution_ceiling(
	p_profile_id uuid,p_spend_microusd_per_period bigint,p_tokens_per_period bigint,p_expected_version bigint,
	p_wakes_per_hour bigint default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role; v_current bigint; v_wakes bigint;
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = auth.uid();
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'company ceilings require founder authority' using errcode = '42501'; end if;
	if p_spend_microusd_per_period is null or p_spend_microusd_per_period < 1
		or p_tokens_per_period is null or p_tokens_per_period < 1 or p_expected_version is null
		or (p_wakes_per_hour is not null and p_wakes_per_hour not between 1 and 1000000) then
		raise exception 'company ceiling is invalid' using errcode = '22023'; end if;
	select version,wakes_per_hour into v_current,v_wakes from public.qorpera_company_execution_ceilings
	where profile_id = p_profile_id for update;
	if coalesce(v_current,0) <> p_expected_version then
		raise exception 'company ceiling version conflict' using errcode = 'PT412'; end if;
	insert into public.qorpera_company_execution_ceilings(profile_id,spend_microusd_per_period,tokens_per_period,
		wakes_per_hour,version,updated_by_user_id)
	values (p_profile_id,p_spend_microusd_per_period,p_tokens_per_period,coalesce(p_wakes_per_hour,240),1,auth.uid())
	on conflict (profile_id) do update set spend_microusd_per_period = excluded.spend_microusd_per_period,
		tokens_per_period = excluded.tokens_per_period,
		wakes_per_hour = coalesce(p_wakes_per_hour,qorpera_company_execution_ceilings.wakes_per_hour),
		version = qorpera_company_execution_ceilings.version + 1,
		updated_by_user_id = excluded.updated_by_user_id,updated_at = statement_timestamp();
	return public.qorpera_company_execution_ceiling_json(p_profile_id);
end
$$;
revoke all on function public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint) from public, anon;
grant execute on function public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint) to authenticated;

-- The founder stop. Owners and admins pause or resume; every founder is
-- notified from the control plane either way.
create function public.qorpera_set_company_execution_pause(p_profile_id uuid,p_paused boolean,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role; v_founder uuid; v_was boolean; v_kind text;
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = auth.uid();
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'company stop requires founder authority' using errcode = '42501'; end if;
	if p_paused is null or (p_reason is not null and char_length(p_reason) not between 1 and 1024) then
		raise exception 'company stop request is invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	v_was := public.qorpera_company_execution_paused(p_profile_id);
	if p_paused then
		insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id,reason)
		values (p_profile_id,auth.uid(),p_reason) on conflict (profile_id) do nothing;
	else
		delete from public.qorpera_company_execution_pauses where profile_id = p_profile_id;
	end if;
	if v_was is distinct from p_paused then
		v_kind := case when p_paused then 'company_execution_paused' else 'company_execution_resumed' end;
		for v_founder in select member.user_id from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.role in ('owner','admin') order by member.user_id loop
			insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
			values (p_profile_id,v_founder,v_kind,jsonb_build_object('schema','qorpera.member-notification.company-execution-stop/v1',
				'paused',p_paused,'byUserId',auth.uid(),'reason',p_reason,'at',clock_timestamp()),
				p_profile_id::text || ':' || to_char(clock_timestamp() at time zone 'UTC','YYYYMMDDHH24MISSUS'))
			on conflict (profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
		end loop;
	end if;
	return jsonb_build_object('schema','qorpera.company-execution-stop/v1','profileId',p_profile_id,'paused',p_paused,
		'changed',v_was is distinct from p_paused);
end
$$;
revoke all on function public.qorpera_set_company_execution_pause(uuid,boolean,text) from public, anon;
grant execute on function public.qorpera_set_company_execution_pause(uuid,boolean,text) to authenticated;

-- The ceiling view reports the wake ceiling, the last hour and the pause (was 20260828019995_company_execution_ceilings.sql).
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
			where trip.profile_id = p_profile_id and trip.period_start = v_period_start));
end
$$;

-- Wake admission applies the founder stop and the wake ceiling (was 20260828022000_runtime_company_rooms.sql).
create or replace function public.qorpera_pin_wake_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_version public.qorpera_cloud_routine_versions%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_trigger jsonb; v_ancestry jsonb; v_actor uuid; v_room public.qorpera_company_rooms%rowtype;
	v_ceiling record; v_used bigint; v_founder uuid;
begin
	if new.wake_schema <> 'qorpera.wake-envelope/v1' then
		raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
	if new.wake_kind = 'routine' then
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = new.routine_id and version = new.routine_version
			and profile_id = new.profile_id and environment_id = new.environment_id;
		select value into v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = new.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or (new.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (new.source_kind = 'company-file' and (v_trigger ->> 'kind' <> 'listener' or new.file_event_id is null))
			or new.source_kind not in ('schedule','company-file') then
			raise exception 'Wake source does not match its routine' using errcode = '22023'; end if;
		new.staff_agent_id := v_version.staff_agent_id; new.requested_by_user_id := v_version.created_by_user_id;
		new.sponsor_binding_id := v_version.sponsor_binding_id; new.sponsor_version := v_version.sponsor_version;
		new.logical_computer_id := v_version.logical_computer_id;
		new.time_zone := coalesce(v_trigger ->> 'timeZone','UTC');
		new.source_id := coalesce(new.file_event_id,new.routine_id);
		if new.source_kind = 'company-file' then
			select run_id,actor_staff_id into new.parent_run_id,v_actor from public.qorpera_company_path_revisions
			where snapshot_id = new.file_event_id and environment_id = new.environment_id;
			if not found then raise exception 'Wake event is unavailable' using errcode = '42501'; end if;
		else
			if new.parent_run_id is not null or new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
		end if;
	elsif new.wake_kind in ('human','first-run') then
		select * into strict v_run from public.qorpera_execution_runs where id = new.run_id and source_kind = 'session_turn';
		if new.source_kind <> 'input' or new.profile_id <> v_run.profile_id or new.environment_id <> v_run.environment_id
			or not exists(select 1 from public.qorpera_session_inputs where id = new.source_id and id = any(v_run.input_ids)
				and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
				and kind = case when new.wake_kind = 'first-run' then 'kickoff' else 'user_message' end) then
			raise exception 'Wake input identity is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := v_run.staff_agent_id; new.requested_by_user_id := v_run.requested_by_user_id;
		new.sponsor_binding_id := v_run.sponsor_binding_id; new.sponsor_version := v_run.sponsor_version;
		new.logical_computer_id := v_run.logical_computer_id;
		new.session_id := v_run.session_id;
		if new.parent_run_id is not null or new.file_event_id is not null then
			raise exception 'Input wake cannot replace causal identity' using errcode = '42501'; end if;
	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id
			and profile_id = new.profile_id and environment_id = new.environment_id;
		if new.source_kind <> 'coworker' then raise exception 'Coworker source is invalid' using errcode = '22023'; end if;
		v_actor := v_run.staff_agent_id; new.source_id := new.id; new.requested_by_user_id := v_run.requested_by_user_id;
		select * into strict v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id for share;
		new.sponsor_binding_id := v_authority.sponsor_binding_id; new.sponsor_version := v_authority.sponsor_version;
		new.logical_computer_id := v_authority.logical_computer_id; new.session_id := null;
		if new.file_event_id is not null then raise exception 'Coworker event identity is invalid' using errcode = '42501'; end if;
	elsif new.wake_kind = 'room' then
		if new.source_kind <> 'room' or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null
			or new.session_id is null or new.source_id is null or new.staff_agent_id is null or new.requested_by_user_id is null
			or new.sponsor_binding_id is null or new.sponsor_version is null then
			raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
		select * into v_room from public.qorpera_company_rooms where session_id = new.session_id
			and profile_id = new.profile_id and environment_id = new.environment_id and status = 'active';
		if not found
			or not exists (select 1 from public.qorpera_session_inputs input where input.id = new.source_id
				and input.session_id = new.session_id and input.author_user_id = new.requested_by_user_id and input.kind = 'user_message')
			or not exists (select 1 from public.qorpera_company_room_members member where member.room_id = v_room.id
				and member.principal_kind = 'member' and member.principal_id = new.requested_by_user_id and member.status = 'active')
			or not exists (select 1 from public.qorpera_company_room_members member where member.room_id = v_room.id
				and member.principal_kind = 'staff_agent' and member.principal_id = new.staff_agent_id and member.status = 'active')
			or not exists (select 1 from public.qorpera_execution_sponsor_bindings binding
				join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id
					and version.version = new.sponsor_version
				where binding.id = new.sponsor_binding_id and binding.profile_id = new.profile_id and binding.status = 'active') then
			raise exception 'Room wake authority is unavailable' using errcode = '42501'; end if;
		v_actor := null; new.logical_computer_id := null;
	else raise exception 'Wake admission is unsupported' using errcode = '42501';
	end if;
	if new.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
		where id = new.parent_run_id and profile_id = new.profile_id and environment_id = new.environment_id) then
		raise exception 'Wake parent belongs to another company' using errcode = '42501'; end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id
		and staff_agent_id = new.staff_agent_id and employment_status = 'active' for share;
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = new.profile_id and user_id = new.requested_by_user_id) then
		raise exception 'Wake recipient authority is unavailable' using errcode = '42501'; end if;
	new.staff_version := coalesce(v_run.staff_version,v_staff.version);
	if new.wake_kind = 'agent' then new.staff_version := v_staff.version; end if;
	if new.wake_kind = 'routine' then
		new.session_id := public.qorpera_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,new.requested_by_user_id);
		if coalesce(v_trigger ->> 'replyPolicy','required') = 'required' and new.session_id is null then
			raise exception 'Wake public audience is unavailable' using errcode = '42501';
		end if;
	end if;
	v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id));
	if v_ancestry is null then raise exception 'Wake causal ancestry is fenced' using errcode = '55000'; end if;
	new.causal_root_id := (v_ancestry ->> 'rootId')::uuid;
	new.causal_agent_ids := array(select jsonb_array_elements_text(v_ancestry -> 'agentIds')::uuid);
	-- Contract 7.4: the founder stop and the wake-rate ceiling hold at admission
	-- without agent cooperation. A refused autonomous wake stays durable and
	-- cancelled with its reason; a human turn under a pause is refused at request.
	if new.wake_kind in ('routine','agent','room') and new.status = 'queued' then
		if public.qorpera_company_execution_paused(new.profile_id) then
			new.status := 'cancelled'; new.finished_at := clock_timestamp();
			new.blocked_reason := 'Company execution is paused';
			return new;
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
	elsif new.wake_kind in ('human','first-run') and public.qorpera_company_execution_paused(new.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000';
	end if;
	return new;
end
$$;

-- Running work is fenced at its next governed effect while paused (was 20260828020000_runtime_wake_bus.sql).
create or replace function public.qorpera_assert_wake_work_allowed(p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_policy jsonb := public.qorpera_runtime_wake_policy(p_run_id);
begin
	if exists (select 1 from public.qorpera_execution_runs run join public.qorpera_company_execution_pauses pause
			on pause.profile_id = run.profile_id where run.id = p_run_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	if v_policy ->> 'initial' = 'required' and not exists (
		select 1 from public.qorpera_agent_sends s join public.qorpera_session_events e on e.event_id = s.event_id
		where s.run_id = p_run_id and e.execution_id = p_run_id and s.phase = 'progress'
	) then raise exception 'Wake requires an acknowledgement before work' using errcode = '55000'; end if;
	if exists(select 1 from public.qorpera_agent_sends where run_id = p_run_id and phase = 'final') then
		raise exception 'Wake public output is already final' using errcode = '55000'; end if;
end
$$;

-- A paused company's queued wakes wait (was 20260828022000_runtime_company_rooms.sql).
create or replace function public.qorpera_materialize_wake_execution_runs(p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_wake public.qorpera_wake_occurrences%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_file public.qorpera_company_files%rowtype; v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_id uuid; v_payload jsonb; v_digest text; v_capability text; v_job_type text;
	v_publication text; v_review text; v_reviewers uuid[]; v_sequence bigint; v_runs jsonb := '[]';
	v_compute uuid; v_mode text; v_worker_class text; v_now timestamptz;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Wake materialization authority or bound is invalid' using errcode = '42501'; end if;
	perform public.qorpera_drain_company_file_wakes(p_limit);
	v_now := clock_timestamp();
	for v_wake in select * from public.qorpera_wake_occurrences
		where status = 'queued' and not_before <= v_now
		order by not_before,created_at,id for update skip locked limit p_limit
	loop
		perform public.qorpera_lock_profile_gc_fence(v_wake.profile_id);
		if public.qorpera_company_execution_paused(v_wake.profile_id) then
			update public.qorpera_wake_occurrences set blocked_reason = 'Company execution is paused' where id = v_wake.id;
			continue;
		end if;
		select * into v_file from public.qorpera_company_files
		where environment_id = v_wake.environment_id and profile_id = v_wake.profile_id for update;
		perform 1 from public.qorpera_profile_members
		where profile_id = v_wake.profile_id and user_id = v_wake.requested_by_user_id for share;
		perform 1 from public.qorpera_profile_staff
		where profile_id = v_wake.profile_id and staff_agent_id = v_wake.staff_agent_id for share;
		if v_wake.wake_kind not in ('routine','agent','room') or not public.qorpera_wake_authorized(v_wake) then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake recipient or source authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		v_capability := 'agent_turn'; v_job_type := 'agent_turn';
		v_publication := 'automatic'; v_review := null; v_reviewers := '{}';
		if v_wake.wake_kind = 'routine' then
			select * into strict v_version from public.qorpera_cloud_routine_versions
			where routine_id = v_wake.routine_id and version = v_wake.routine_version;
			v_capability := v_version.required_capability; v_job_type := v_version.job_type;
			v_publication := v_version.publication_mode; v_review := v_version.review_policy_key;
			v_reviewers := v_version.reviewer_staff_ids;
		end if;
		perform 1 from public.qorpera_execution_sponsor_bindings b
		join public.qorpera_execution_sponsor_versions s on s.binding_id = b.id and s.version = v_wake.sponsor_version
		join public.qorpera_provider_connections c on c.id = s.provider_connection_id
		where b.id = v_wake.sponsor_binding_id and b.profile_id = v_wake.profile_id and b.status = 'active'
			and (s.allow_autonomous or v_wake.wake_kind = 'room') and c.profile_id = v_wake.profile_id and c.status = 'active' for share of b,c;
		if not found then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake execution authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		select * into v_substrate from public.qorpera_company_substrate_versions
		where profile_id = v_wake.profile_id and environment_id = v_wake.environment_id
			and company_snapshot_id = v_file.head_snapshot_id order by created_at desc,id desc limit 1;
		if v_file.head_snapshot_id is null or v_substrate.id is null or (v_wake.logical_computer_id is not null
			and not exists(select 1 from public.qorpera_logical_computers where id = v_wake.logical_computer_id
				and profile_id = v_wake.profile_id and status = 'active' and capabilities ? v_capability)) then
			update public.qorpera_wake_occurrences set blocked_reason = 'Pinned Company File or computer is unavailable'
			where id = v_wake.id;
			continue;
		end if;
		-- Resolve compute from the already authorized immutable sponsor/capsule,
		-- then let the existing native provenance trigger verify ownership.
		select c.compute_identity_id,v.authentication_mode into v_compute,v_mode
		from public.qorpera_execution_sponsor_versions s join public.qorpera_provider_connection_versions v
			on v.connection_id = s.provider_connection_id and v.version = s.provider_connection_version
		left join public.qorpera_native_credential_capsules c on c.id = v.credential_capsule_id and c.status = 'active'
		where s.binding_id = v_wake.sponsor_binding_id and s.version = v_wake.sponsor_version;
		v_worker_class := 'managed_sandbox';
		if v_wake.logical_computer_id is not null then
			select computer_class into v_worker_class from public.qorpera_logical_computers where id = v_wake.logical_computer_id
				and (v_compute is null or compute_identity_id = v_compute);
			if v_compute is null then
				select compute_identity_id into v_compute from public.qorpera_logical_computers where id = v_wake.logical_computer_id;
			end if;
		end if;
		if (v_mode = 'native_subscription' and v_compute is null) or v_worker_class is null then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake compute authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		v_id := extensions.gen_random_uuid();
		v_payload := jsonb_build_object('schema','qorpera.wake-run/v1','occurrenceId',v_wake.id);
		v_digest := encode(extensions.digest(convert_to(v_payload::text,'utf8'),'sha256'),'hex');
		-- A room post enters the room conversation once, before any agent's run.
		if v_wake.wake_kind = 'room' then
			perform public.qorpera_append_execution_input_events(v_wake.session_id,array[v_wake.source_id]);
		end if;
		select coalesce(max(sequence),0) into v_sequence from public.qorpera_session_events where session_id = v_wake.session_id;
		insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
			required_capability,job_type,payload,created_by_user_id)
		values(v_wake.profile_id,v_wake.environment_id,v_wake.session_id,v_substrate.id,v_id,
			v_capability,v_job_type,v_payload,v_wake.requested_by_user_id) returning * into v_job;
		insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
			substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
			required_capability,job_type,payload_sha256,publication_mode,review_policy_key,reviewer_staff_ids,logical_computer_id,
			compute_identity_id,worker_class,transcript_start_sequence,created_by_user_id)
		values(v_id,v_wake.profile_id,v_wake.environment_id,case when v_wake.wake_kind = 'room' then 'room_delivery' else 'wake' end,
			v_wake.id,v_wake.session_id,v_job.id,
			v_substrate.id,v_file.head_snapshot_id,v_wake.staff_agent_id,v_wake.staff_version,'{}',
			v_wake.sponsor_binding_id,v_wake.sponsor_version,v_capability,v_job_type,v_digest,
			v_publication,v_review,v_reviewers,v_wake.logical_computer_id,v_compute,v_worker_class,v_sequence,v_wake.requested_by_user_id)
		returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_wake_occurrences set blocked_reason = 'Execution sponsor authority or quota is unavailable'
			where id = v_wake.id;
			continue;
		end if;
		update public.qorpera_wake_occurrences set status = 'materialized',run_id = v_run.id,blocked_reason = null where id = v_wake.id;
		insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run.id,'queued');
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;

-- A paused company refuses new room posts (was 20260828022000_runtime_company_rooms.sql).
create or replace function public.qorpera_post_company_room_message(
	p_room_id uuid, p_client_input_id uuid, p_body jsonb, p_sponsor_binding_id uuid, p_sponsor_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room public.qorpera_company_rooms%rowtype; v_user uuid := auth.uid();
	v_input public.qorpera_session_inputs%rowtype; v_staff uuid; v_ids uuid[] := '{}'::uuid[]; v_id uuid; v_text text;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Room posting requires a member' using errcode = '42501'; end if;
	select * into v_room from public.qorpera_company_rooms where id = p_room_id for share;
	if not found or v_room.status <> 'active' or v_room.session_id is null
		or not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = v_room.profile_id and member.user_id = v_user)
		or not exists (select 1 from public.qorpera_company_room_members member
			where member.room_id = v_room.id and member.principal_kind = 'member' and member.principal_id = v_user
				and member.status = 'active') then
		raise exception 'Room is unavailable' using errcode = '42501'; end if;
	if p_client_input_id is null or jsonb_typeof(p_body) is distinct from 'object'
		or p_body ->> 'schema' is distinct from 'qorpera.session-prompt/v1'
		or p_body - array['schema','text','images'] <> '{}'::jsonb
		or jsonb_typeof(p_body -> 'text') <> 'string'
		or (p_body ? 'images' and (jsonb_typeof(p_body -> 'images') <> 'array' or jsonb_array_length(p_body -> 'images') > 0)) then
		raise exception 'Room message is invalid' using errcode = '22023'; end if;
	v_text := p_body ->> 'text';
	if v_text !~ '[^[:space:]]' or octet_length(convert_to(v_text,'utf8')) > 65536 then
		raise exception 'Room message is invalid' using errcode = '22023'; end if;
	if p_sponsor_binding_id is null or p_sponsor_version is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings binding
			join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id and version.version = p_sponsor_version
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_room.profile_id and binding.status = 'active'
				and binding.created_by_user_id = v_user) then
		raise exception 'Room sponsor is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_room.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_shared_sessions where id = v_room.session_id and status = 'open' for update;
	if not found then raise exception 'Room conversation is unavailable' using errcode = '42501'; end if;
	select * into v_input from public.qorpera_session_inputs
	where session_id = v_room.session_id and client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user or v_input.body <> p_body then
			raise exception 'Room input id is bound to different content' using errcode = '23505'; end if;
		select coalesce(array_agg(id order by staff_agent_id),'{}'::uuid[]) into v_ids from public.qorpera_wake_occurrences
		where wake_kind = 'room' and source_kind = 'room' and source_id = v_input.id;
	else
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body,completed_at)
		values (v_room.session_id,p_client_input_id,'user_message',v_user,p_body,clock_timestamp()) returning * into v_input;
		for v_staff in
			select member.principal_id from public.qorpera_company_room_members member
			join public.qorpera_profile_staff staff on staff.profile_id = v_room.profile_id
				and staff.staff_agent_id = member.principal_id and staff.employment_status = 'active'
			where member.room_id = v_room.id and member.principal_kind = 'staff_agent' and member.status = 'active'
			order by member.principal_id
		loop
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,
				staff_agent_id,requested_by_user_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,
				scheduled_for,not_before,payload)
			values (v_id,v_room.profile_id,v_room.environment_id,'room','room',v_input.id,v_staff,v_user,
				p_sponsor_binding_id,p_sponsor_version,v_room.session_id,'room',
				'room:' || v_room.id::text || ':' || v_input.id::text || ':' || v_staff::text,
				clock_timestamp(),clock_timestamp(),
				jsonb_build_object('roomId',v_room.id,'inputIds',jsonb_build_array(v_input.id),'recipientStaffId',v_staff));
			v_ids := array_append(v_ids,v_id);
		end loop;
	end if;
	return jsonb_build_object('schema','qorpera.company-room-post/v1','roomId',v_room.id,'sessionId',v_room.session_id,
		'inputId',v_input.id,'occurrenceIds',to_jsonb(v_ids));
end
$$;

-- A paused company refuses new turns at request (was 20260821009000_step1_security_fencing.sql).
create or replace function public.qorpera_request_session_turn_v2(
	p_session_id uuid,
	p_client_input_id uuid,
	p_client_request_id uuid,
	p_body jsonb,
	p_sponsor_mode text,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_requested_sponsor_user_id uuid,
	p_compute_identity_id uuid,
	p_logical_computer_id uuid,
	p_worker_class text default 'managed_sandbox',
	p_required_capability text default 'agent_turn',
	p_job_type text default 'agent_turn',
	p_publication_mode text default 'automatic',
	p_review_policy_key text default null,
	p_reviewer_staff_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_request public.qorpera_session_turn_requests%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
begin
	if exists (select 1 from public.qorpera_shared_sessions session join public.qorpera_company_execution_pauses pause
			on pause.profile_id = session.profile_id where session.id = p_session_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if v_user_id is null or not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'session turn request is unavailable' using errcode = '42501';
	end if;
	select request.* into v_request
	from public.qorpera_session_turn_requests as request
	where request.session_id = p_session_id and request.client_request_id = p_client_request_id;
	if found then
		select input.* into v_input
		from public.qorpera_session_inputs as input
		where input.id = v_request.input_id;
		if v_request.requested_by_user_id is distinct from v_user_id
			or v_input.client_input_id is distinct from p_client_input_id
			or v_input.author_user_id is distinct from v_user_id
			or v_input.kind is distinct from 'user_message'
			or v_input.body is distinct from p_body
			or v_request.sponsor_mode is distinct from p_sponsor_mode
			or v_request.sponsor_binding_id is distinct from p_sponsor_binding_id
			or v_request.sponsor_version is distinct from p_sponsor_version
			or v_request.requested_sponsor_user_id is distinct from p_requested_sponsor_user_id
			or v_request.compute_identity_id is distinct from p_compute_identity_id
			or v_request.logical_computer_id is distinct from p_logical_computer_id
			or v_request.worker_class is distinct from p_worker_class
			or v_request.required_capability is distinct from p_required_capability
			or v_request.job_type is distinct from p_job_type
			or v_request.publication_mode is distinct from p_publication_mode
			or v_request.review_policy_key is distinct from nullif(btrim(p_review_policy_key), '')
			or v_request.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[]) then
			raise exception 'session turn client request id is bound to another request' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'turn_request_id', v_request.id,
			'input_id', v_request.input_id,
			'status', v_request.status,
			'sponsor_mode', v_request.sponsor_mode
		);
	end if;
	return public.qorpera_request_session_turn(
		p_session_id, p_client_input_id, p_client_request_id, p_body, p_sponsor_mode,
		p_sponsor_binding_id, p_sponsor_version, p_requested_sponsor_user_id,
		p_compute_identity_id, p_logical_computer_id, p_worker_class, p_required_capability,
		p_job_type, p_publication_mode, p_review_policy_key, p_reviewer_staff_ids
	);
end
$$;

-- 20260930007000: the Company Computer under one idle rule for every machine
-- (founder decision of 3 October 2026; contract, 2026-10-03 amendment "one
-- idle rule for every machine", items 3 and 5).
-- 1. Sleep stops what still runs in a shell: the idle policy ends its
--    commands as slept before it powers the computer off, and any other stop
--    of the computer ends them as closed.
-- 2. The agent's next run in the conversation that started a command the
--    platform stopped is told, once: a list in the open work the host reads at
--    the start of every company run (qorpera_describe_agent_open_work).
-- 3. Check-ins. A shell that stays busy since its agent last worked with it
--    (started or typed into a command) has its agent asked whether it still
--    needs it, after 1, 3 and 7 hours, then every 24, each time only while
--    busy, in the conversation of the run that worked with it last. The
--    question arrives as a new kind of wake, machine-checkin, which agents'
--    machines and coding sessions use too. A question is a notice, never a
--    stop.
-- 2 and 3 wait for a switch (qorpera_idle_rule_settings), off here: a runtime
-- before this one refuses a machine-checkin wake (the run fails) and ignores
-- the open-work list (its rows would be marked told unseen). Sleep ends
-- commands either way.
--
-- Lock order: the report and the idle policy take the office row first (as
-- today); the drain takes a check-in (skip locked), then the company's wake
-- admission fence, then the wake row (the pin trigger's own order).

create function pg_temp.office_shell_idle_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office shell idle rule integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;

-- The switch for telling and asking. The coordinator turns it on once every
-- host that runs agents has a runtime that reads both.
create table public.qorpera_idle_rule_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false,
	-- When it was last turned on: only what stopped after that is told, never a backlog.
	enabled_at timestamptz
);
insert into public.qorpera_idle_rule_settings(singleton) values (true);
create function public.qorpera_idle_rule_settings_stamp() returns trigger language plpgsql set search_path = '' as $$
begin
	if new.enabled and not old.enabled then new.enabled_at := clock_timestamp(); end if;
	return new;
end $$;
revoke all on function public.qorpera_idle_rule_settings_stamp() from public,anon,authenticated,service_role;
create trigger qorpera_idle_rule_settings_stamp before update on public.qorpera_idle_rule_settings
	for each row execute function public.qorpera_idle_rule_settings_stamp();
alter table public.qorpera_idle_rule_settings enable row level security;
revoke all on table public.qorpera_idle_rule_settings from public,anon,authenticated,service_role,qorpera_secret_broker;
comment on table public.qorpera_idle_rule_settings is
	'One idle rule (20260930007000) switch: while off, agents are neither told what the platform stopped nor asked about busy machines, because an older runtime refuses machine-checkin wakes and ignores openWork.computerStopped. The coordinator turns it on, once every host runs a runtime that reads both, with: update public.qorpera_idle_rule_settings set enabled = true;';

-- ---------------------------------------------------------------------------
-- 1. Sleep and other stops end what still runs
-- ---------------------------------------------------------------------------
select pg_temp.office_shell_idle_patch('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure,
	$old$		perform public.qorpera_begin_runtime_office_lifecycle(v_request);$old$,
	$new$		-- Sleep stops what still runs in its shells; their runs are told (20260930007000).
		update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='slept'
			where office_id=o.id and ended_at is null;
		perform public.qorpera_begin_runtime_office_lifecycle(v_request);$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure,
	$old$	update public.qorpera_runtime_office_viewers set state='draining' where office_id=v_office.id and state in ('issued','active');$old$,
	$new$	update public.qorpera_runtime_office_viewers set state='draining' where office_id=v_office.id and state in ('issued','active');
	-- Any stop of the computer stops what still runs in its shells (20260930007000).
	update public.qorpera_runtime_office_shell_commands set ended_at=clock_timestamp(),end_reason='closed'
		where office_id=v_office.id and ended_at is null;$new$);

-- ---------------------------------------------------------------------------
-- 2. The next run is told what stopped, once
-- ---------------------------------------------------------------------------
-- The agent's commands that the platform stopped since telling was turned on
-- and that belong to this run's conversation, oldest first, at most 32 a run.
-- A row belongs to the first run that took it; the same run (a restart after a
-- usage limit) takes it again. A run outside any conversation is told nothing.
create function public.qorpera_take_agent_computer_stopped(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_taken jsonb; v_settings public.qorpera_idle_rule_settings%rowtype;
begin
	select * into v_settings from public.qorpera_idle_rule_settings;
	if p_run.staff_agent_id is null or p_run.session_id is null or not coalesce(v_settings.enabled,false) then return null; end if;
	with taken as (
		select command.id from public.qorpera_runtime_office_shell_commands command
		where command.staff_agent_id=p_run.staff_agent_id and command.session_id=p_run.session_id
			and command.end_reason in ('slept','closed','paused','pressure','lost')
			and command.ended_at>=v_settings.enabled_at
			and (command.told_run_id is null or command.told_run_id=p_run.id)
		order by command.ended_at,command.id limit 32 for update skip locked),
	marked as (
		update public.qorpera_runtime_office_shell_commands command
		set told_run_id=p_run.id,told_at=coalesce(command.told_at,clock_timestamp())
		from taken where command.id=taken.id returning command.*)
	select jsonb_agg(jsonb_build_object('command',marked.command,'startedAt',marked.started_at,'endedAt',marked.ended_at,
		'reason',marked.end_reason) order by marked.ended_at,marked.id) into v_taken from marked;
	return v_taken;
end $$;
revoke all on function public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs) from public,anon,authenticated,service_role;

select pg_temp.office_shell_idle_patch('public.qorpera_describe_agent_open_work(jsonb)'::regprocedure,
	$old$				and todo.state in ('open','blocked')));$old$,
	$new$				and todo.state in ('open','blocked')))
		-- Commands the computer stopped, told once in their conversation (20260930007000).
		|| coalesce((select jsonb_build_object('computerStopped',taken.list)
			from (select public.qorpera_take_agent_computer_stopped(v_run) as list) taken where taken.list is not null),'{}'::jsonb);$new$);

-- The functions above may have a private owner in production.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure,
		'public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure,
		'public.qorpera_describe_agent_open_work(jsonb)'::regprocedure)) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Office shell idle rule function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select,update on public.qorpera_runtime_office_shell_commands to %I',v_owner);
			execute format('grant execute on function public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs) to %I',v_owner);
		end if;
	end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Check-ins: a question to an agent about a machine it keeps busy
-- ---------------------------------------------------------------------------
-- One row per question asked. Any machine kind adds rows; the drain wakes
-- the run whose conversation is asked, one question per wake.
create table public.qorpera_machine_checkins (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	-- The run whose conversation is asked: the one that worked with it last.
	parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	-- computer: a Company Computer's shell; machine: an agent's machine; coding: a coding session.
	machine_kind text not null check (machine_kind in ('computer','machine','coding')),
	-- The screen, machine or coding session asked about.
	subject_id uuid not null,
	-- When the count started, and the hour mark this question is for.
	since timestamptz not null,
	mark_hours integer not null check (mark_hours > 0),
	-- What the agent reads: a bounded description of what is busy.
	body jsonb not null check (octet_length(body::text) <= 4096),
	created_at timestamptz not null default clock_timestamp(),
	delivery text not null default 'waiting' check (delivery in ('waiting','delivered','suppressed','undeliverable')),
	occurrence_id uuid,
	scanned_at timestamptz not null default '-infinity',
	unique (machine_kind, subject_id, since, mark_hours)
);
create index qorpera_machine_checkins_waiting on public.qorpera_machine_checkins (scanned_at, created_at, id) where delivery = 'waiting';
create index qorpera_machine_checkins_occurrence on public.qorpera_machine_checkins (occurrence_id) where occurrence_id is not null;
alter table public.qorpera_machine_checkins enable row level security;
revoke all on public.qorpera_machine_checkins from public,anon,authenticated,service_role;

-- The latest mark reached after p_hours busy hours: 1, 3, 7, then every 24
-- (31, 55, ...); null before the first.
create function public.qorpera_machine_checkin_mark(p_hours double precision)
returns integer language sql immutable set search_path = '' as $$
	select case when p_hours is null or p_hours < 1 then null when p_hours < 3 then 1 when p_hours < 7 then 3
		else 7 + 24 * floor((p_hours - 7) / 24)::integer end
$$;
revoke all on function public.qorpera_machine_checkin_mark(double precision) from public,anon,authenticated,service_role;

-- The Company Computer's questions. A screen whose shell is busy, whose agent
-- still runs a command there and has not worked with that shell (started or
-- typed into any command on the screen) for at least an hour, is asked about
-- once per mark, of the run that worked with it last (for a worker, the run
-- that dispatched it). An archived agent is not asked, nor a folder-v2
-- company; a paused company is asked when the pause ends (the drain waits).
-- One shell's trouble never stops the others or the materializer.
create function public.qorpera_ask_busy_office_shells(p_limit integer default 32)
returns void language plpgsql security definer set search_path = '' as $$
declare v_shell record; v_body jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Office shell check-in authority or bound is invalid' using errcode = '42501'; end if;
	if not coalesce((select settings.enabled from public.qorpera_idle_rule_settings settings),false) then return; end if;
	for v_shell in
		select asking.* from (
			select activity.office_id,activity.screen_id,office.profile_id,office.environment_id,screen.staff_agent_id,
				latest.conversation_run_id,latest.worked_at,
				public.qorpera_machine_checkin_mark(extract(epoch from clock_timestamp()-latest.worked_at)/3600) as mark
			from public.qorpera_runtime_office_shell_activity activity
			join public.qorpera_runtime_offices office on office.id=activity.office_id and office.generation=activity.computer_generation
			join public.qorpera_runtime_office_screens screen on screen.id=activity.screen_id
			cross join lateral (select command.conversation_run_id,command.worked_at
				from public.qorpera_runtime_office_shell_commands command
				where command.screen_id=activity.screen_id and command.staff_agent_id=screen.staff_agent_id
				order by command.worked_at desc,command.id desc limit 1) latest
			where activity.busy_until>clock_timestamp() and latest.worked_at<=clock_timestamp()-interval '1 hour'
				and not public.qorpera_company_is_folder_v2(office.profile_id)
				and exists(select 1 from public.qorpera_runtime_office_shell_commands open_command
					where open_command.office_id=activity.office_id and open_command.screen_id=activity.screen_id
						and open_command.staff_agent_id=screen.staff_agent_id and open_command.ended_at is null)
				and exists(select 1 from public.qorpera_profile_staff staff where staff.profile_id=office.profile_id
					and staff.staff_agent_id=screen.staff_agent_id and staff.employment_status='active')) asking
		-- Only questions not asked yet count against the limit.
		where not exists(select 1 from public.qorpera_machine_checkins asked where asked.machine_kind='computer'
			and asked.subject_id=asking.screen_id and asked.since=asking.worked_at and asked.mark_hours=asking.mark)
		order by asking.worked_at,asking.screen_id limit p_limit
	loop
		begin
			-- What still runs, as many as fit: 8 at most and 3000 bytes of commands, the rest counted.
			with listed as (
				select command.id,command.started_at,
					jsonb_build_object('command',left(command.command,200),'startedAt',command.started_at) as item
				from public.qorpera_runtime_office_shell_commands command
				where command.office_id=v_shell.office_id and command.screen_id=v_shell.screen_id
					and command.staff_agent_id=v_shell.staff_agent_id and command.ended_at is null),
			ordered as (
				select listed.item,row_number() over (order by listed.started_at,listed.id) as n,
					sum(octet_length(listed.item::text)) over (order by listed.started_at,listed.id) as bytes
				from listed)
			select jsonb_build_object('machine','your computer','busyHours',v_shell.mark,
				'running',coalesce(jsonb_agg(ordered.item order by ordered.n) filter (where ordered.n<=8 and ordered.bytes<=3000),'[]'::jsonb),
				'more',count(*) filter (where ordered.n>8 or ordered.bytes>3000))
			into v_body from ordered;
			insert into public.qorpera_machine_checkins(profile_id,environment_id,staff_agent_id,parent_run_id,machine_kind,subject_id,
				since,mark_hours,body)
			values(v_shell.profile_id,v_shell.environment_id,v_shell.staff_agent_id,v_shell.conversation_run_id,'computer',
				v_shell.screen_id,v_shell.worked_at,v_shell.mark,v_body)
			on conflict (machine_kind,subject_id,since,mark_hours) do nothing;
		exception when check_violation or not_null_violation or foreign_key_violation or program_limit_exceeded then
			-- This question cannot be carried; the others still are.
			null;
		end;
	end loop;
end $$;
revoke all on function public.qorpera_ask_busy_office_shells(integer) from public,anon,authenticated,service_role;

-- A question as the agent reads it.
create function public.qorpera_machine_checkin_payload(p_checkin public.qorpera_machine_checkins)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.machine-checkin/v1','parentRunId',p_checkin.parent_run_id,
		'checkin',jsonb_build_object('kind',p_checkin.machine_kind,'subjectId',p_checkin.subject_id,'since',p_checkin.since,
			'hours',p_checkin.mark_hours,'detail',p_checkin.body))
$$;
revoke all on function public.qorpera_machine_checkin_payload(public.qorpera_machine_checkins) from public,anon,authenticated,service_role;

-- The wake's ancestry, as for a machine event: the question continues the run
-- whose conversation is asked.
create function public.qorpera_machine_checkin_wake_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_checkin public.qorpera_machine_checkins%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	select * into v_checkin from public.qorpera_machine_checkins where id = p_wake.source_id;
	select * into v_parent from public.qorpera_execution_runs where id = p_wake.parent_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	if v_checkin.id is null or v_parent.id is null or v_wake.id is null or p_wake.wake_kind <> 'agent'
		or p_wake.source_kind <> 'machine-checkin' or p_wake.trigger_id is distinct from 'machine-checkin'
		or v_checkin.parent_run_id is distinct from v_parent.id
		or v_checkin.profile_id is distinct from p_wake.profile_id or v_checkin.environment_id is distinct from p_wake.environment_id
		or v_checkin.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.profile_id is distinct from p_wake.profile_id or v_parent.environment_id is distinct from p_wake.environment_id
		or v_parent.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.requested_by_user_id is distinct from p_wake.requested_by_user_id
		or p_wake.file_event_id is not null or p_wake.session_id is distinct from v_parent.session_id
		or v_wake.causal_root_id is null or cardinality(v_wake.causal_agent_ids) < 1
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_parent.staff_agent_id then
		return null; end if;
	return jsonb_build_object('rootId', v_wake.causal_root_id, 'agentIds', to_jsonb(v_wake.causal_agent_ids));
end
$$;
revoke all on function public.qorpera_machine_checkin_wake_ancestry(public.qorpera_wake_occurrences) from public,anon,authenticated,service_role;

-- A person stopped a check-in of this run: like stopping the run, nothing more is asked of it.
create function public.qorpera_machine_checkin_stopped(p_parent_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences revival
		join public.qorpera_execution_runs revival_run on revival_run.id = revival.run_id
		join public.qorpera_runner_jobs revival_job on revival_job.id = revival_run.job_id
		where revival.parent_run_id = p_parent_run_id and revival.source_kind = 'machine-checkin' and revival_job.status = 'cancelled')
$$;
revoke all on function public.qorpera_machine_checkin_stopped(uuid) from public,anon,authenticated,service_role;

-- Whether a question still stands when it would be delivered: no later mark
-- was asked for the same count, and (on a Company Computer) the shell is busy
-- now, its seat is the same agent's and nobody worked with it since.
create function public.qorpera_machine_checkin_current(p_checkin public.qorpera_machine_checkins)
returns boolean language sql stable security definer set search_path = '' as $$
	select not exists(select 1 from public.qorpera_machine_checkins later where later.machine_kind=p_checkin.machine_kind
			and later.subject_id=p_checkin.subject_id and later.since=p_checkin.since and later.mark_hours>p_checkin.mark_hours)
		and case p_checkin.machine_kind
			when 'computer' then exists(select 1 from public.qorpera_runtime_office_shell_activity activity
				join public.qorpera_runtime_offices office on office.id=activity.office_id and office.generation=activity.computer_generation
				join public.qorpera_runtime_office_screens screen on screen.id=activity.screen_id
				where activity.screen_id=p_checkin.subject_id and activity.busy_until>clock_timestamp()
					and screen.staff_agent_id=p_checkin.staff_agent_id
					and (select max(command.worked_at) from public.qorpera_runtime_office_shell_commands command
						where command.screen_id=screen.id and command.staff_agent_id=screen.staff_agent_id)=p_checkin.since)
			-- Other machines judge their questions when they ask them.
			else true end
$$;
revoke all on function public.qorpera_machine_checkin_current(public.qorpera_machine_checkins) from public,anon,authenticated,service_role;

-- Delivery, as for machine events: the parent's own run ends first; one
-- question at a time per parent; a question that no longer stands is dropped;
-- a run a person stopped hears nothing more; a paused company waits; a
-- folder-v2 company is not asked yet. Nothing one question does stops the drain.
create function public.qorpera_drain_machine_checkin_wakes(p_limit integer default 32)
returns void language plpgsql security definer set search_path = '' as $$
declare v_checkin public.qorpera_machine_checkins%rowtype; v_parent public.qorpera_execution_runs%rowtype; v_status text;
	v_id uuid; v_inserted public.qorpera_wake_occurrences%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Machine check-in admission authority or bound is invalid' using errcode = '42501'; end if;
	if not coalesce((select settings.enabled from public.qorpera_idle_rule_settings settings),false) then return; end if;
	for v_checkin in select * from public.qorpera_machine_checkins where delivery = 'waiting'
		and not public.qorpera_company_is_folder_v2(profile_id)
		order by scanned_at, created_at, id for update skip locked limit p_limit loop
		begin
			update public.qorpera_machine_checkins set scanned_at = clock_timestamp() where id = v_checkin.id;
			select * into v_parent from public.qorpera_execution_runs where id = v_checkin.parent_run_id;
			if v_parent.id is null or v_parent.job_id is null then
				update public.qorpera_machine_checkins set delivery = 'undeliverable' where id = v_checkin.id; continue; end if;
			select status into v_status from public.qorpera_runner_jobs where id = v_parent.job_id;
			if v_status is null or v_status in ('queued','leased') then continue; end if;
			if v_status = 'cancelled' or public.qorpera_machine_checkin_stopped(v_parent.id)
				or not public.qorpera_machine_checkin_current(v_checkin) then
				update public.qorpera_machine_checkins set delivery = 'suppressed' where id = v_checkin.id; continue; end if;
			if public.qorpera_company_execution_paused(v_parent.profile_id) then continue; end if;
			perform public.qorpera_serialize_wake_admission(v_parent.profile_id);
			if exists (select 1 from public.qorpera_wake_occurrences pending
				left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
				left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
				where pending.parent_run_id = v_parent.id and pending.source_kind = 'machine-checkin'
					and (pending.status = 'queued' or (pending.status = 'materialized'
						and (pending_job.id is null or pending_job.status in ('queued','leased'))))) then continue; end if;
			-- Each attempt is its own wake: one a pause cancelled at admission never blocks the next.
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
				parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
			values (v_id, v_parent.profile_id, v_parent.environment_id, 'agent', 'machine-checkin', v_checkin.id, v_parent.staff_agent_id,
				v_parent.id, 'machine-checkin', 'machine-checkin:' || v_id::text, clock_timestamp(), clock_timestamp(),
				public.qorpera_machine_checkin_payload(v_checkin))
			returning * into v_inserted;
			-- A pause at admission cancels the wake; the question stays waiting for the next drain.
			if v_inserted.status <> 'queued' then continue; end if;
			update public.qorpera_machine_checkins set delivery = 'delivered', occurrence_id = v_id where id = v_checkin.id;
		exception when lock_not_available or deadlock_detected then continue;
			when insufficient_privilege or no_data_found or object_not_in_prerequisite_state
				or check_violation or unique_violation or program_limit_exceeded then
				-- The agent, the requester or the conversation is gone, or the question cannot be carried.
				update public.qorpera_machine_checkins set delivery = 'undeliverable' where id = v_checkin.id;
		end;
	end loop;
end
$$;
revoke all on function public.qorpera_drain_machine_checkin_wakes(integer) from public,anon,authenticated,service_role;

-- The continuation of a question: what the asked run already did, as for a
-- machine event, with the question in place of the events.
create function public.qorpera_machine_checkin_run_continuation(p_run public.qorpera_execution_runs, p_depth integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_parent_wake public.qorpera_wake_occurrences%rowtype; v_inputs jsonb; v_receipts jsonb; v_sends jsonb; v_result jsonb;
	v_receipt_count bigint; v_send_count bigint;
begin
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run.id and source_kind = 'machine-checkin';
	if not found then return null; end if;
	if p_depth > 2 then return jsonb_build_object('schema','qorpera.machine-checkin-continuation/v1','omitted','earlier history'); end if;
	select * into strict v_parent from public.qorpera_execution_runs where id = v_wake.parent_run_id
		and profile_id = p_run.profile_id and environment_id = p_run.environment_id and staff_agent_id = p_run.staff_agent_id;
	select * into strict v_parent_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	select coalesce(jsonb_agg(public.qorpera_company_context_source(v_parent,'input',input_id) order by ordinal),'[]') into v_inputs
	from unnest(v_parent.input_ids) with ordinality ids(input_id, ordinal);
	select coalesce(jsonb_agg(kept.item order by kept.completed_at, kept.id),'[]') into v_receipts
	from (select receipt.id, receipt.completed_at, listed.item,
			sum(octet_length(listed.item::text)) over (order by receipt.completed_at desc, receipt.id desc) as tail
		from public.qorpera_run_operation_receipts receipt
		cross join lateral (select jsonb_build_object('receiptId',receipt.id,'logicalOperationKey',receipt.logical_operation_key,'completedAt',receipt.completed_at,
			'result',receipt.result,'outputSnapshotId',receipt.output_snapshot_id,'companyPathProposalId',receipt.company_path_proposal_id) as item) listed
		where receipt.run_id = v_parent.id and receipt.status = 'completed') kept
	where kept.tail <= 6291456;
	select count(*) into v_receipt_count from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_parent.id and receipt.status = 'completed';
	select coalesce(jsonb_agg(kept.item order by kept.sequence, kept.event_id),'[]') into v_sends
	from (select event.sequence, event.event_id, listed.item,
			sum(octet_length(listed.item::text)) over (order by event.sequence desc, event.event_id desc) as tail
		from public.qorpera_agent_sends send join public.qorpera_session_events event on event.event_id = send.event_id
		cross join lateral (select jsonb_build_object('eventId',event.event_id,'sequence',event.sequence,'body',event.body) as item) listed
		where send.run_id = v_parent.id) kept
	where kept.tail <= 2097152;
	select count(*) into v_send_count from public.qorpera_agent_sends send
		join public.qorpera_session_events event on event.event_id = send.event_id where send.run_id = v_parent.id;
	v_result := jsonb_build_object('schema','qorpera.machine-checkin-continuation/v1','runId',p_run.id,'parentRunId',v_parent.id,
		'parentOutcome',(select status from public.qorpera_runner_jobs where id = v_parent.job_id),
		'checkin',(select public.qorpera_machine_checkin_payload(checkin)->'checkin'
			from public.qorpera_machine_checkins checkin where checkin.occurrence_id = v_wake.id),
		'parentInputs',v_inputs,
		'parentWake',jsonb_build_object('kind',v_parent_wake.wake_kind,'sourceKind',v_parent_wake.source_kind,
			'routineIntent',(select prompt from public.qorpera_cloud_routine_versions
				where routine_id = v_parent_wake.routine_id and version = v_parent_wake.routine_version),
			'roomPost',(select jsonb_build_object('kind','historical_room_input','id',id,'authorUserId',author_user_id,'body',body)
				from public.qorpera_session_inputs where v_parent_wake.source_kind = 'room' and id = v_parent_wake.source_id
					and session_id = v_parent.session_id and kind = 'user_message')),
		'receipts',v_receipts,'priorSends',v_sends,
		'earlier',coalesce(public.qorpera_machine_checkin_run_continuation(v_parent, p_depth + 1),
			public.qorpera_machine_run_continuation(v_parent, p_depth + 1), public.qorpera_worker_run_continuation(v_parent, p_depth + 1)))
		|| jsonb_strip_nulls(jsonb_build_object(
			'receiptsOmitted',nullif(v_receipt_count - jsonb_array_length(v_receipts),0),
			'priorSendsOmitted',nullif(v_send_count - jsonb_array_length(v_sends),0)));
	if octet_length(v_result::text) > 33554432 then raise exception 'Machine check-in continuation exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;
revoke all on function public.qorpera_machine_checkin_run_continuation(public.qorpera_execution_runs,integer) from public,anon,authenticated,service_role;

-- A new wake source kind, keeping whatever kinds master already has.
do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_wake_occurrences_source_kind_check'
		and conrelid = 'public.qorpera_wake_occurrences'::regclass)) is distinct from
		'CHECK ((source_kind = ANY (ARRAY[''input''::text, ''schedule''::text, ''company-file''::text, ''coworker''::text, ''room''::text, ''office-activation''::text, ''worker-dispatch''::text, ''worker-completion''::text, ''machine-event''::text, ''event''::text])))' then
		raise exception 'Wake source kinds differ from 20260928269290';
	end if;
end
$$;
alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
	check (source_kind in ('input','schedule','company-file','coworker','room','office-activation','worker-dispatch','worker-completion',
		'machine-event','event','machine-checkin'));

-- The wake bus admits, authorizes and describes a question exactly where it
-- does a machine event.
select pg_temp.office_shell_idle_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$if new.source_kind in ('office-activation', 'machine-event') then$old$,
	$new$if new.source_kind in ('office-activation', 'machine-event', 'machine-checkin') then$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$'worker-completion','machine-event') then raise exception 'Agent source is invalid'$old$,
	$new$'worker-completion','machine-event','machine-checkin') then raise exception 'Agent source is invalid'$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$new.session_id := case when new.source_kind in ('worker-completion','machine-event') then v_run.session_id$old$,
	$new$new.session_id := case when new.source_kind in ('worker-completion','machine-event','machine-checkin') then v_run.session_id$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$ elsif new.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(new);$old$,
	$new$ elsif new.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(new);
 elsif new.source_kind = 'machine-checkin' then v_ancestry := public.qorpera_machine_checkin_wake_ancestry(new);$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$p_wake.source_kind in ('worker-completion','machine-event')$old$,
	$new$p_wake.source_kind in ('worker-completion','machine-event','machine-checkin')$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$ elsif p_wake.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(p_wake);$old$,
	$new$ elsif p_wake.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(p_wake);
 elsif p_wake.source_kind = 'machine-checkin' then v_ancestry := public.qorpera_machine_checkin_wake_ancestry(p_wake);$new$);
-- Folder companies take questions as they take machine events (not yet).
select pg_temp.office_shell_idle_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$or p_wake.source_kind in ('company-file','office-activation','machine-event','event') then return false;$old$,
	$new$or p_wake.source_kind in ('company-file','office-activation','machine-event','event','machine-checkin') then return false;$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event'))$old$,
	$new$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin'))$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$if v_wake.source_kind in ('worker-completion','machine-event') and v_wake.session_id is not null$old$,
	$new$if v_wake.source_kind in ('worker-completion','machine-event','machine-checkin') and v_wake.session_id is not null$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$ if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event') then v_sender:=null; v_actor_user:=null; end if;$old$,
	$new$ if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin') then v_sender:=null; v_actor_user:=null; end if;$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$	perform public.qorpera_drain_machine_wakes(p_limit);$old$,
	$new$	perform public.qorpera_drain_machine_wakes(p_limit);
	-- Questions about busy machines: asked, then delivered (20260930007000).
	perform public.qorpera_ask_busy_office_shells(p_limit);
	perform public.qorpera_drain_machine_checkin_wakes(p_limit);$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$elsif v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event') then$old$,
	$new$elsif v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin') then$new$);
select pg_temp.office_shell_idle_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
	$old$public.qorpera_machine_run_continuation(p_run))$old$,
	$new$public.qorpera_machine_run_continuation(p_run), public.qorpera_machine_checkin_run_continuation(p_run))$new$);

-- The wake bus's functions may have private owners in production.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_pin_wake_occurrence()'::regprocedure,
		'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
		'public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
		'public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure)) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Wake bus function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select,insert,update on public.qorpera_machine_checkins to %I',v_owner);
			execute format('grant select on public.qorpera_runtime_office_shell_activity, public.qorpera_runtime_office_shell_commands to %I',v_owner);
			execute format('grant execute on function public.qorpera_machine_checkin_wake_ancestry(public.qorpera_wake_occurrences),
				public.qorpera_ask_busy_office_shells(integer), public.qorpera_drain_machine_checkin_wakes(integer),
				public.qorpera_machine_checkin_run_continuation(public.qorpera_execution_runs,integer) to %I',v_owner);
		end if;
	end loop;
end $$;

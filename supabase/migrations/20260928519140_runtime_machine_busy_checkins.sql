-- 20260930181000: check-ins for agents' machines under one idle rule for every machine (the 2026-10-03 amendment,
-- item 5, its machine part). Folder-v2 only by the founder's decision of 3 October. A task machine that stays busy since
-- an agent last worked with it (started a command there) has that agent asked whether it still needs it, after 1, 3 and
-- 7 hours, then every 24, each time only while busy. A question is a notice, never a stop. It rides 20260930098000's
-- check-ins: one qorpera_machine_checkins row per question (kind 'machine', the machine as its subject), asked and
-- delivered by the same folder drain (machine_checkins, LISTENER §9). An always-on machine is not asked here: its weekly
-- check-in (item 6) takes the place of these.
-- 1. Busy: the executor measures the whole machine (20260928489140) and records a busy look as before, which now also
--    keeps when (busy_at). A machine is busy now while it should run, its current placement runs, and a look under a
--    minute and a half old found it busy.
-- 2. Who is asked: the whole machine is measured, so a busy machine is asked about in each conversation whose runs
--    started a command still running there (a worker's: the conversation that dispatched it), of the agent that started
--    it. With no such command, the busy work is outside its commands (containers, programs left behind): the agent that
--    started the machine is asked, in the conversation of the run that started it. The count starts at the later of the
--    machine's boot and that agent's last command started there, from whichever conversation.
-- 3. Delivery: a question still stands only while the same agent and conversation would be asked about the machine
--    now, from the same start; one that no longer stands is suppressed.
-- Every patched or new body names this migration (20260930181000).

set local lock_timeout = '3s';

-- 1. Busy --------------------------------------------------------------------------------------------------------------

alter table public.qorpera_company_machines
	-- When the executor last found the machine busy (a look in its current boot): what its check-ins ask about.
	add column busy_at timestamptz;
-- When an agent last started a command on a machine: its last work there.
create index qorpera_company_machine_commands_worked on public.qorpera_company_machine_commands (machine_id, staff_agent_id, started_at);

create function pg_temp.machine_busy_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Machine busy check-in anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- A busy look moves the idle clock, as before, and keeps when the machine was last found busy.
select pg_temp.machine_busy_patch(
	'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)'::regprocedure,
	$old$	if p_busy then update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = v_machine.id; end if;$old$,
	$new$	if p_busy then update public.qorpera_company_machines set last_used_at = clock_timestamp(), busy_at = clock_timestamp()
		where id = v_machine.id; end if; -- 20260930181000$new$);

-- 2. Asking ------------------------------------------------------------------------------------------------------------

-- Who would be asked about a task machine that is busy now, and since when: each agent and conversation whose runs
-- started a command still running there; with none, the agent that started the machine, in the conversation of the
-- run that started it. The count starts at the later of the machine's boot and that agent's last command started there.
-- Nothing for an always-on machine, or one that is not busy now.
create function public.qorpera_company_machine_busy_since(p_machine public.qorpera_company_machines)
returns table (staff_agent_id uuid, conversation_run_id uuid, since timestamptz)
language sql stable security definer set search_path = '' as $$
	-- 20260930181000.
	with boot as (
		select placement.id, placement.running_at from public.qorpera_company_machine_placements placement
		where placement.machine_id = p_machine.id and placement.retired_at is null and placement.removed_at is null
			and placement.running_at is not null
			and p_machine.lifetime = 'task' and p_machine.desired_state = 'running' and p_machine.removed_at is null
			and p_machine.busy_at > clock_timestamp() - interval '90 seconds'),
	programs as (
		select distinct command.staff_agent_id, command.conversation_run_id
		from boot join public.qorpera_company_machine_commands command on command.machine_id = p_machine.id
			and command.placement_id = boot.id and command.ended_at is null
		where command.conversation_run_id is not null),
	asking as (
		select programs.staff_agent_id, programs.conversation_run_id from programs
		union all
		-- Busy outside its commands.
		select p_machine.started_by_staff_agent_id, p_machine.started_conversation_run_id
		where p_machine.started_conversation_run_id is not null and not exists (select 1 from programs))
	select asking.staff_agent_id, asking.conversation_run_id,
		greatest(boot.running_at, (select max(command.started_at) from public.qorpera_company_machine_commands command
			where command.machine_id = p_machine.id and command.staff_agent_id = asking.staff_agent_id)) as since
	from boot cross join asking
$$;
revoke all on function public.qorpera_company_machine_busy_since(public.qorpera_company_machines)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The questions due and not asked yet, in one folder-v2 environment (or all, for the due list): for each task machine
-- busy for at least an hour since the count started, one question per agent and conversation asked, at the mark
-- reached. An archived agent is not asked.
create function public.qorpera_company_machine_busy_checkins_unasked(p_environment_id uuid)
returns table (machine_id uuid, profile_id uuid, environment_id uuid, staff_agent_id uuid, conversation_run_id uuid,
	since timestamptz, mark integer)
language sql stable security definer set search_path = '' as $$
	-- 20260930181000.
	select asking.* from (
		select machine.id as machine_id, machine.profile_id, machine.environment_id, busy.staff_agent_id, busy.conversation_run_id,
			busy.since, public.qorpera_machine_checkin_mark(extract(epoch from clock_timestamp() - busy.since) / 3600) as mark
		from public.qorpera_company_machines machine
		cross join lateral public.qorpera_company_machine_busy_since(machine) busy
		where (p_environment_id is null or machine.environment_id = p_environment_id)
			and machine.lifetime = 'task' and machine.desired_state = 'running' and machine.removed_at is null
			and machine.busy_at > clock_timestamp() - interval '90 seconds'
			and busy.since <= clock_timestamp() - interval '1 hour'
			and public.qorpera_environment_is_folder_v2(machine.environment_id)
			and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = machine.profile_id
				and staff.staff_agent_id = busy.staff_agent_id and staff.employment_status = 'active')) asking
	where not exists (select 1 from public.qorpera_machine_checkins asked where asked.machine_kind = 'machine'
		and asked.subject_id = asking.machine_id and asked.parent_run_id = asking.conversation_run_id
		and asked.since = asking.since and asked.mark_hours = asking.mark)
$$;
revoke all on function public.qorpera_company_machine_busy_checkins_unasked(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One folder-v2 company's busy task machines, as questions (at most p_limit, longest busy first). One machine's trouble
-- never stops the others. Returns how many it asked. Its caller holds the folder fence KEY SHARE; a question's parent
-- run is locked only KEY SHARE, by its foreign key; the machine is only read.
create function public.qorpera_ask_busy_company_machines(p_environment_id uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_busy record; v_body jsonb; v_asked integer := 0; v_count integer;
begin
	-- 20260930181000.
	if p_environment_id is null or p_limit is null or p_limit not between 1 and 256 then
		raise exception 'Machine check-in bound is invalid' using errcode = '22023'; end if;
	for v_busy in select * from public.qorpera_company_machine_busy_checkins_unasked(p_environment_id) unasked
		order by unasked.since, unasked.machine_id, unasked.conversation_run_id limit p_limit loop
		begin
			-- What this agent's runs in this conversation started that still runs there, as many as fit: 8 at most and 3000
			-- bytes of commands, the rest counted, each with the handle machine_cancel takes. None: the machine is busy
			-- outside its commands.
			with listed as (
				select command.id, command.started_at,
					jsonb_build_object('command', left(command.command_head, 200), 'startedAt', command.started_at,
						'commandId', command.id) as item
				from public.qorpera_company_machine_commands command
				join public.qorpera_company_machine_placements placement on placement.id = command.placement_id
					and placement.retired_at is null and placement.removed_at is null
				where command.machine_id = v_busy.machine_id and command.staff_agent_id = v_busy.staff_agent_id
					and command.conversation_run_id = v_busy.conversation_run_id and command.ended_at is null),
			ordered as (
				select listed.item, row_number() over (order by listed.started_at, listed.id) as n,
					sum(octet_length(listed.item::text)) over (order by listed.started_at, listed.id) as bytes
				from listed)
			select jsonb_build_object('machine', (select machine.name from public.qorpera_company_machines machine
					where machine.id = v_busy.machine_id), 'busyHours', v_busy.mark,
				'running', coalesce(jsonb_agg(ordered.item order by ordered.n) filter (where ordered.n <= 8 and ordered.bytes <= 3000), '[]'::jsonb),
				'more', count(*) filter (where ordered.n > 8 or ordered.bytes > 3000))
			into v_body from ordered;
			insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id, machine_kind,
				subject_id, since, mark_hours, body)
			values (v_busy.profile_id, v_busy.environment_id, v_busy.staff_agent_id, v_busy.conversation_run_id, 'machine',
				v_busy.machine_id, v_busy.since, v_busy.mark, v_body)
			on conflict (machine_kind, subject_id, parent_run_id, since, mark_hours) do nothing;
			get diagnostics v_count = row_count;
			v_asked := v_asked + v_count;
		exception when check_violation or not_null_violation or foreign_key_violation or program_limit_exceeded then
			-- This question cannot be carried; the others still are.
			null;
		end;
	end loop;
	return v_asked;
end $$;
revoke all on function public.qorpera_ask_busy_company_machines(uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. Delivery ----------------------------------------------------------------------------------------------------------

-- A machine's question still stands while the machine is busy now and the same agent would be asked about it in the
-- same conversation, from the same start: a new command of that agent there, a new boot, or that conversation's
-- commands ended (with others still running) leave it standing no more.
select pg_temp.machine_busy_patch('public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)'::regprocedure,
	$old$			-- Other machines judge their questions when they ask them.
			else true end$old$,
	$new$			when 'machine' then exists (select 1 from public.qorpera_company_machines machine
				cross join lateral public.qorpera_company_machine_busy_since(machine) busy
				where machine.id = p_checkin.subject_id and busy.staff_agent_id = p_checkin.staff_agent_id
					and busy.conversation_run_id = p_checkin.parent_run_id and busy.since = p_checkin.since) -- 20260930181000
			-- Other machines judge their questions when they ask them.
			else true end$new$);

-- 4. The drain ---------------------------------------------------------------------------------------------------------

-- The shared drains' page: a company with a machine's question to ask is due as one with a shell's.
select pg_temp.machine_busy_patch('public.qorpera_folder_machine_checkins_due(uuid,integer)'::regprocedure,
	$old$		select unasked.environment_id, unasked.profile_id from public.qorpera_coding_busy_checkins_unasked(null) unasked -- 20260930109000
		union$old$,
	$new$		select unasked.environment_id, unasked.profile_id from public.qorpera_coding_busy_checkins_unasked(null) unasked -- 20260930109000
		union
		select unasked.environment_id, unasked.profile_id from public.qorpera_company_machine_busy_checkins_unasked(null) unasked -- 20260930181000
		union$new$);
-- The company's step asks the machines' questions with the shells' and the coding sessions'.
select pg_temp.machine_busy_patch('public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure,
	$old$		and not exists (select 1 from public.qorpera_coding_busy_checkins_unasked(p_environment_id)) then -- 20260930109000$old$,
	$new$		and not exists (select 1 from public.qorpera_coding_busy_checkins_unasked(p_environment_id)) -- 20260930109000
		and not exists (select 1 from public.qorpera_company_machine_busy_checkins_unasked(p_environment_id)) then -- 20260930181000$new$);
select pg_temp.machine_busy_patch('public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure,
	$old$			+ public.qorpera_ask_busy_coding_sessions(p_environment_id, 64); -- 20260930109000$old$,
	$new$			+ public.qorpera_ask_busy_coding_sessions(p_environment_id, 64) -- 20260930109000
			+ public.qorpera_ask_busy_company_machines(p_environment_id, 64); -- 20260930181000$new$);

-- The patched functions may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)'::regprocedure,
		'public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)'::regprocedure,
		'public.qorpera_folder_machine_checkins_due(uuid,integer)'::regprocedure,
		'public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Machine check-in function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select, update on public.qorpera_company_machines to %I', v_owner);
			execute format('grant execute on function public.qorpera_company_machine_busy_since(public.qorpera_company_machines), '
				'public.qorpera_company_machine_busy_checkins_unasked(uuid), '
				'public.qorpera_ask_busy_company_machines(uuid, integer) to %I', v_owner);
		end if;
	end loop;
end $$;

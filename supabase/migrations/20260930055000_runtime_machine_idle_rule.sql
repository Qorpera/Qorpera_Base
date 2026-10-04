-- 20260930055000: agents' machines under one idle rule for every machine (the 2026-10-03 amendment, items 1, 3 and 7;
-- the busy measure decided 4 October 2026, the coordinator). Folder-v2 only by the founder's decision of 3 October:
-- every function here is shared by both cores and gets no snapshot-v1 branch.
-- 1. A task machine sleeps after its quiet window (the node's sleep_after_seconds, an hour) with nothing keeping it
--    awake: an agent's use (a start, a wake, a command started, read or cancelled) or a busy program. A command no
--    longer keeps it awake by running, only while it is busy: at least 5% of one core, or 512 KiB read or written in
--    a 30-second sample (`@qorpera/contracts` idle-rule). Work outside its commands (containers, programs left
--    behind) counts while the whole machine's processors, beyond its commands' own use, are at least 2% busy. The
--    executor measures both every pass and records them here (qorpera_record_company_machine_commands).
-- 2. A command the machine's stop or restart ends says why (end_reason): slept (the idle sleep), hours (an hour after
--    the company ran out of computer hours), stopped (an agent or a member stopped or deleted the machine), lost (it
--    restarted or moved, or its node was given up). Outside work seen busy since the machine last stopped ends with it.
-- 3. The next run of the agent that started a command so ended, in the conversation of the run that started it (a
--    worker's: the conversation that dispatched it), is told once in its open work (machineStopped). Busy outside work
--    is told to the agent that started the machine, in the conversation of the run that started it.
-- Check-ins (item 5) follow on S3's per-company delivery (3i-b), with qorpera_machine_checkins.
-- 4. A stop that has begun (its custody granted and the machine still wanted stopped, or asleep at zero hours) records
--    no ends the guest shows: they are the stop's own work, and the suspension ends those commands with the stop's
--    reason. The executor's list says so (stopping), and the executor takes no last look then.
-- Lock order: unchanged. The record keeps its custody's order (the machine, then the placement, then the command
-- rows). Ends run where the caller holds the machine row, as before. The told list takes command and outside-stop
-- rows with SKIP LOCKED only.

alter table public.qorpera_company_machine_commands
	-- Told here: the run that started it, or for a worker the run that dispatched it, and that run's conversation.
	add column conversation_run_id uuid,
	add column session_id uuid,
	-- When the executor last saw it busy.
	add column busy_at timestamptz,
	-- Why the machine's stop or restart ended it (its state is lost); none for an end the guest saw.
	add column end_reason text check (end_reason in ('slept','hours','stopped','lost')),
	add column told_run_id uuid,
	add column told_at timestamptz,
	add constraint qorpera_company_machine_commands_end_reason check (end_reason is null or state = 'lost');
-- What a conversation's next run of the agent is told: a few rows, each once.
create index qorpera_company_machine_commands_told on public.qorpera_company_machine_commands (staff_agent_id, session_id, ended_at)
	where end_reason is not null;

alter table public.qorpera_company_machines
	-- When the executor last saw work outside the machine's commands busy, since the machine last stopped.
	add column outside_busy_at timestamptz,
	-- Where its outside work is told, kept when it is started: the starting run's conversation (for a worker, the one
	-- that dispatched it then, whatever the worker's later follow-ups are steered from).
	add column started_conversation_run_id uuid,
	add column started_session_id uuid;

-- Busy work outside a machine's commands that its stop or restart ended, told to the agent that started the machine.
create table public.qorpera_company_machine_outside_stops (
	id uuid primary key default extensions.gen_random_uuid(),
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	staff_agent_id uuid not null,
	conversation_run_id uuid not null,
	session_id uuid,
	-- When it was last seen busy.
	busy_at timestamptz not null,
	ended_at timestamptz not null default clock_timestamp(),
	end_reason text not null check (end_reason in ('slept','hours','stopped','lost')),
	told_run_id uuid,
	told_at timestamptz
);
create index qorpera_company_machine_outside_stops_told on public.qorpera_company_machine_outside_stops (staff_agent_id, session_id, ended_at);
create index qorpera_company_machine_outside_stops_machine on public.qorpera_company_machine_outside_stops (machine_id);
alter table public.qorpera_company_machine_outside_stops enable row level security;
revoke all on public.qorpera_company_machine_outside_stops from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Where a command is told, kept when it is recorded: its run's conversation (qorpera_office_shell_conversation_run).
create function public.qorpera_company_machine_command_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_conversation public.qorpera_execution_runs%rowtype;
begin
	select * into v_run from public.qorpera_execution_runs where id = new.run_id;
	v_conversation := public.qorpera_office_shell_conversation_run(v_run);
	new.conversation_run_id := v_conversation.id;
	new.session_id := v_conversation.session_id;
	return new;
end $$;
revoke all on function public.qorpera_company_machine_command_conversation() from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_company_machine_command_conversation before insert on public.qorpera_company_machine_commands
	for each row execute function public.qorpera_company_machine_command_conversation();
create function public.qorpera_company_machine_start_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_conversation public.qorpera_execution_runs%rowtype;
begin
	select * into v_run from public.qorpera_execution_runs where id = new.started_by_run_id;
	v_conversation := public.qorpera_office_shell_conversation_run(v_run);
	new.started_conversation_run_id := v_conversation.id;
	new.started_session_id := v_conversation.session_id;
	return new;
end $$;
revoke all on function public.qorpera_company_machine_start_conversation() from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_company_machine_start_conversation before insert on public.qorpera_company_machines
	for each row execute function public.qorpera_company_machine_start_conversation();

-- Whether a stop of the placement has begun: its custody was granted, and the machine is still wanted stopped (or
-- deleted), or asleep after the company ran out of computer hours. Ends the guest shows then are the stop's work.
create function public.qorpera_company_machine_stopping(p_placement public.qorpera_company_machine_placements,
	p_machine public.qorpera_company_machines)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930055000.
	select p_placement.stop_authorized_at is not null and (p_machine.desired_state <> 'running'
		or public.qorpera_computer_hour_finish_window_over(p_machine.profile_id, clock_timestamp()))
$$;
revoke all on function public.qorpera_company_machine_stopping(public.qorpera_company_machine_placements, public.qorpera_company_machines)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Ends every open command of a machine that stopped, restarted or moved, with why, and queues the notifications they
-- asked for; or, observed, the ones the guest saw end. A command the guest does not know yet may still be on its way
-- there: it is lost only two minutes after its start was last sent. Busy outside work ends with a stop or restart
-- too. Internal: the caller holds the machine row. (Replaced whole by 20260930055000: end reasons and outside work.)
create or replace function public.qorpera_end_company_machine_commands(p_machine public.qorpera_company_machines, p_state text,
	p_ended jsonb default '[]'::jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_command public.qorpera_company_machine_commands%rowtype; v_item jsonb; v_count integer := 0; v_reason text;
begin
	-- Why the machine's stop or restart ended them: who wanted it stopped, the computer hours' finishing window, or
	-- neither (it restarted or moved under them) (20260930055000).
	v_reason := case when p_state = 'observed' then null
		when p_machine.desired_state <> 'running' then case when p_machine.desired_by = 'kernel' then 'slept' else 'stopped' end
		when public.qorpera_computer_hour_finish_window_over(p_machine.profile_id, clock_timestamp()) then 'hours'
		else 'lost' end;
	for v_command in select * from public.qorpera_company_machine_commands where machine_id = p_machine.id and ended_at is null
		order by started_at, id for update loop
		select item into v_item from jsonb_array_elements(p_ended) item where item ->> 'commandId' = v_command.id::text;
		if p_state = 'observed' and (v_item is null
			or (v_item ->> 'state' = 'lost' and v_command.sent_at > clock_timestamp() - interval '2 minutes')) then continue; end if;
		update public.qorpera_company_machine_commands set ended_at = clock_timestamp(),
			state = case when p_state = 'observed' then v_item ->> 'state' else p_state end,
			exit_code = case when p_state = 'observed' and v_item ->> 'state' in ('succeeded','failed') then (v_item ->> 'exitCode')::integer end,
			output_tail = case when p_state = 'observed' then public.qorpera_machine_text_tail(v_item ->> 'outputTail', 4000) end,
			end_reason = v_reason
		where id = v_command.id;
		if v_command.notify then
			insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind, command_id)
			values (p_machine.id, p_machine.profile_id, p_machine.environment_id, v_command.staff_agent_id, v_command.run_id, 'command', v_command.id);
		end if;
		v_count := v_count + 1;
	end loop;
	if v_reason is not null and p_machine.outside_busy_at is not null then
		insert into public.qorpera_company_machine_outside_stops(machine_id, staff_agent_id, conversation_run_id, session_id, busy_at, end_reason)
		values (p_machine.id, p_machine.started_by_staff_agent_id, p_machine.started_conversation_run_id, p_machine.started_session_id,
			p_machine.outside_busy_at, v_reason);
		update public.qorpera_company_machines set outside_busy_at = null where id = p_machine.id;
	end if;
	return v_count;
end
$$;

-- The executor's look inside a running machine: the commands that ended since (each {commandId, state, exitCode,
-- outputTail}), the running commands it saw busy (their ids, at most 256: only this machine's open ones count), and
-- whether work outside its commands was busy. Busy work keeps a task machine awake (the idle clock), and when each
-- was last busy is kept. While a stop has begun nothing is recorded (stopping): the suspension ends what still runs.
drop function public.qorpera_record_company_machine_commands(uuid, text, text, text, uuid, jsonb, boolean);
create function public.qorpera_record_company_machine_commands(p_placement_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text, p_boot_id uuid, p_ended jsonb, p_busy_commands jsonb, p_outside_busy boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_count integer; v_busy integer; v_at timestamptz := clock_timestamp();
begin
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	if jsonb_typeof(p_ended) is distinct from 'array' or jsonb_array_length(p_ended) > 64
		or exists (select 1 from jsonb_array_elements(p_ended) item where jsonb_typeof(item) is distinct from 'object'
			or item - array['commandId','state','exitCode','outputTail'] <> '{}'::jsonb
			or coalesce(item ->> 'commandId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or coalesce(item ->> 'state','') not in ('succeeded','failed','cancelled','lost')
			or (item ->> 'state' in ('succeeded','failed') and (jsonb_typeof(item -> 'exitCode') is distinct from 'number'
				or (item ->> 'exitCode') !~ '^[0-9]{1,3}$' or (item ->> 'exitCode')::integer > 255))
			or (item -> 'outputTail' is not null and jsonb_typeof(item -> 'outputTail') is distinct from 'string'))
		or jsonb_typeof(p_busy_commands) is distinct from 'array' or jsonb_array_length(p_busy_commands) > 256
		or exists (select 1 from jsonb_array_elements(p_busy_commands) id where jsonb_typeof(id) is distinct from 'string'
			or (id #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
		or p_outside_busy is null then
		raise exception 'Machine commands invalid' using errcode = '22023'; end if;
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	-- Only what the executor saw in the current placement's current boot counts.
	if v_placement.removed_at is not null or v_placement.retired_at is not null or v_placement.boot_id is distinct from p_boot_id then
		return '{"state":"stale"}'::jsonb; end if;
	if public.qorpera_company_machine_stopping(v_placement, v_machine) then return '{"state":"stopping"}'::jsonb; end if;
	v_count := public.qorpera_end_company_machine_commands(v_machine, 'observed', p_ended);
	update public.qorpera_company_machine_commands set busy_at = v_at
	where machine_id = v_machine.id and ended_at is null
		and id in (select (busy.value #>> '{}')::uuid from jsonb_array_elements(p_busy_commands) busy);
	get diagnostics v_busy = row_count;
	if v_busy > 0 or p_outside_busy then
		update public.qorpera_company_machines set last_used_at = v_at,
			outside_busy_at = case when p_outside_busy then v_at else outside_busy_at end
		where id = v_machine.id;
	end if;
	return jsonb_build_object('state','recorded','ended',v_count,'busy',v_busy);
end
$$;
revoke all on function public.qorpera_record_company_machine_commands(uuid, text, text, text, uuid, jsonb, jsonb, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_company_machine_commands(uuid, text, text, text, uuid, jsonb, jsonb, boolean) to service_role;

-- Patched in place, so other patches commute.
create function pg_temp.machine_idle_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Machine idle rule integration differs: %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;
-- The executor's list says whether a stop has begun.
select pg_temp.machine_idle_patch('public.qorpera_list_executor_machines(text,text)'::regprocedure,
	$old$			'stopDue',(placement.retired_at is not null or machine.desired_state <> 'running') and state.reserved,$old$,
	$new$			'stopDue',(placement.retired_at is not null or machine.desired_state <> 'running') and state.reserved,
			'stopping',public.qorpera_company_machine_stopping(placement, machine), -- 20260930055000$new$);
-- The executor's list: a task machine is due to sleep after its quiet window whatever still runs on it.
select pg_temp.machine_idle_patch('public.qorpera_list_executor_machines(text,text)'::regprocedure,
	$old$				and not exists (select 1 from public.qorpera_company_machine_commands where machine_id = machine.id and ended_at is null)
				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds))$old$,
	$new$				-- A command keeps it awake only while busy: the executor's record moves the idle clock (20260930055000).
				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds))$new$);
-- The stop custody agrees on the same terms.
select pg_temp.machine_idle_patch('public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure,
	$old$				or exists (select 1 from public.qorpera_company_machine_commands where machine_id = v_machine.id and ended_at is null)
$old$,
	$new$				-- A command that only waits keeps nothing awake (20260930055000).
$new$);

-- The agent's machine commands that a stop or restart ended, and busy outside work on machines it started, that belong
-- to this run's conversation: oldest first, at most 32 a run. A row belongs to the first run that took it; the same
-- run (a restart after a usage limit) takes it again. A run outside any conversation is told nothing.
create function public.qorpera_take_agent_machine_stopped(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_taken jsonb;
begin
	if p_run.staff_agent_id is null or p_run.session_id is null then return null; end if;
	with commands as (
		select command.id, command.ended_at from public.qorpera_company_machine_commands command
		where command.staff_agent_id = p_run.staff_agent_id and command.session_id = p_run.session_id and command.end_reason is not null
			and (command.told_run_id is null or command.told_run_id = p_run.id)
		order by command.ended_at, command.id limit 32 for update skip locked),
	outside as (
		select stop.id, stop.ended_at from public.qorpera_company_machine_outside_stops stop
		where stop.staff_agent_id = p_run.staff_agent_id and stop.session_id = p_run.session_id
			and (stop.told_run_id is null or stop.told_run_id = p_run.id)
		order by stop.ended_at, stop.id limit 32 for update skip locked),
	chosen as (
		select listed.kind, listed.id from (select 'command' as kind, id, ended_at from commands
			union all select 'outside', id, ended_at from outside) listed
		order by listed.ended_at, listed.id limit 32),
	told_commands as (
		update public.qorpera_company_machine_commands command
		set told_run_id = p_run.id, told_at = coalesce(command.told_at, clock_timestamp())
		from chosen where chosen.kind = 'command' and command.id = chosen.id returning command.*),
	told_outside as (
		update public.qorpera_company_machine_outside_stops stop
		set told_run_id = p_run.id, told_at = coalesce(stop.told_at, clock_timestamp())
		from chosen where chosen.kind = 'outside' and stop.id = chosen.id returning stop.*)
	select jsonb_agg(told.item order by told.ended_at, told.id) into v_taken from (
		select jsonb_build_object('machine', machine.name, 'work', 'command', 'command', command.command_head,
			'startedAt', command.started_at, 'endedAt', command.ended_at, 'reason', command.end_reason) as item, command.ended_at, command.id
		from told_commands command join public.qorpera_company_machines machine on machine.id = command.machine_id
		union all
		select jsonb_build_object('machine', machine.name, 'work', 'outside', 'busyAt', stop.busy_at, 'endedAt', stop.ended_at,
			'reason', stop.end_reason), stop.ended_at, stop.id
		from told_outside stop join public.qorpera_company_machines machine on machine.id = stop.machine_id) told;
	return v_taken;
end $$;
revoke all on function public.qorpera_take_agent_machine_stopped(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.machine_idle_patch('public.qorpera_describe_agent_open_work(jsonb)'::regprocedure,
	$old$			from (select public.qorpera_take_agent_computer_stopped(v_run) as list) taken where taken.list is not null),'{}'::jsonb);$old$,
	$new$			from (select public.qorpera_take_agent_computer_stopped(v_run) as list) taken where taken.list is not null),'{}'::jsonb)
		-- Machine commands and outside work a machine's stop ended, told once in their conversation (20260930055000).
		|| coalesce((select jsonb_build_object('machineStopped',taken.list)
			from (select public.qorpera_take_agent_machine_stopped(v_run) as list) taken where taken.list is not null),'{}'::jsonb);$new$);

-- The functions above may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_list_executor_machines(text,text)'::regprocedure,
		'public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure,
		'public.qorpera_end_company_machine_commands(public.qorpera_company_machines,text,jsonb)'::regprocedure,
		'public.qorpera_describe_agent_open_work(jsonb)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Machine idle rule function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select, insert, update on public.qorpera_company_machine_outside_stops to %I', v_owner);
			execute format('grant select, update on public.qorpera_company_machine_commands, public.qorpera_company_machines to %I',
				v_owner);
			execute format('grant execute on function public.qorpera_take_agent_machine_stopped(public.qorpera_execution_runs), '
				'public.qorpera_computer_hour_finish_window_over(uuid,timestamptz), '
				'public.qorpera_company_machine_stopping(public.qorpera_company_machine_placements, public.qorpera_company_machines) '
				'to %I', v_owner);
		end if;
	end loop;
end $$;

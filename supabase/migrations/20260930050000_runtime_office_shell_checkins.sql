-- 20260930050000: check-ins for the Company Computer's shells under one idle rule for every machine (the 2026-10-03
-- amendment, item 5). Folder-v2 only by the founder's decision of 3 October. A shell that stays busy since its agent
-- last worked with it (started or typed into any command on that screen) has its agent asked whether it still needs
-- it, after 1, 3 and 7 hours, then every 24, each time only while busy, in the conversation of the run that worked
-- with it last (a worker's: the conversation that dispatched it). A question is a notice, never a stop.
-- This migration is the asking side:
-- - qorpera_machine_checkins: one row per question (agents' machines and coding sessions use it too);
-- - qorpera_ask_busy_office_shells(environment, limit): one company's questions;
-- - qorpera_folder_machine_checkins_due: the folder drains' due list (RUNTIME-COMPANY-FOLDER-LISTENER.md §9);
-- - qorpera_machine_checkin_current: whether a question still stands when it would be delivered.
-- Delivery (the drain's per-company action) follows on the per-company "deliver to a parent run" helper of 3i-b.
-- Lock order: the ask reads the busy shells, their offices, screens and commands and the agents' staff rows without
-- locks, and inserts its questions; a question's parent run is locked only KEY SHARE, by its foreign key.

create table public.qorpera_machine_checkins (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	-- The run whose conversation is asked: the one that worked with it last (for a worker, the run that dispatched it).
	parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	-- computer: a Company Computer's shell; machine: an agent's machine; coding: a coding session.
	machine_kind text not null check (machine_kind in ('computer', 'machine', 'coding')),
	-- The screen, machine or coding session asked about.
	subject_id uuid not null,
	-- When the count started, and the hour mark this question is for.
	since timestamptz not null,
	mark_hours integer not null check (mark_hours > 0),
	-- What the agent reads: a bounded description of what is busy.
	body jsonb not null check (octet_length(body::text) <= 4096),
	created_at timestamptz not null default clock_timestamp(),
	delivery text not null default 'waiting' check (delivery in ('waiting', 'delivered', 'suppressed', 'undeliverable')),
	occurrence_id uuid,
	scanned_at timestamptz not null default '-infinity',
	unique (machine_kind, subject_id, since, mark_hours)
);
create index qorpera_machine_checkins_waiting on public.qorpera_machine_checkins (environment_id, scanned_at, created_at, id)
	where delivery = 'waiting';
create index qorpera_machine_checkins_occurrence on public.qorpera_machine_checkins (occurrence_id) where occurrence_id is not null;
alter table public.qorpera_machine_checkins enable row level security;
revoke all on public.qorpera_machine_checkins from public, anon, authenticated, service_role;
-- When an agent last worked with its shell on a screen.
create index qorpera_runtime_office_shell_commands_worked on public.qorpera_runtime_office_shell_commands (screen_id, staff_agent_id, worked_at);

-- The latest mark reached after p_hours busy hours: 1, 3, 7, then every 24 (31, 55, ...); null before the first.
create function public.qorpera_machine_checkin_mark(p_hours double precision)
returns integer language sql immutable set search_path = '' as $$
	select case when p_hours is null or p_hours < 1 then null when p_hours < 3 then 1 when p_hours < 7 then 3
		else 7 + 24 * floor((p_hours - 7) / 24)::integer end
$$;
revoke all on function public.qorpera_machine_checkin_mark(double precision) from public, anon, authenticated, service_role;

-- One folder-v2 company's busy shells, as questions: each screen whose shell is busy, whose agent still runs a command
-- there and has not worked with that shell for at least an hour, once per mark, asked of the run that worked with it
-- last. An archived agent is not asked. One shell's trouble never stops the others. Returns how many it asked.
create function public.qorpera_ask_busy_office_shells(p_environment_id uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_shell record; v_body jsonb; v_asked integer := 0; v_count integer;
begin
	if p_environment_id is null or p_limit is null or p_limit not between 1 and 256 then
		raise exception 'Office shell check-in bound is invalid' using errcode = '22023'; end if;
	if not public.qorpera_environment_is_folder_v2(p_environment_id) then return 0; end if;
	for v_shell in
		select asking.* from (
			select activity.office_id, activity.screen_id, office.profile_id, office.environment_id, screen.staff_agent_id,
				latest.conversation_run_id, latest.worked_at,
				public.qorpera_machine_checkin_mark(extract(epoch from clock_timestamp() - latest.worked_at) / 3600) as mark
			from public.qorpera_runtime_offices office
			join public.qorpera_runtime_office_shell_activity activity on activity.office_id = office.id
				and activity.computer_generation = office.generation
			join public.qorpera_runtime_office_screens screen on screen.id = activity.screen_id
			cross join lateral (select command.conversation_run_id, command.worked_at
				from public.qorpera_runtime_office_shell_commands command
				where command.screen_id = activity.screen_id and command.staff_agent_id = screen.staff_agent_id
				order by command.worked_at desc, command.id desc limit 1) latest
			where office.environment_id = p_environment_id and activity.busy_until > clock_timestamp()
				and latest.worked_at <= clock_timestamp() - interval '1 hour'
				and exists (select 1 from public.qorpera_runtime_office_shell_commands open_command
					where open_command.office_id = activity.office_id and open_command.screen_id = activity.screen_id
						and open_command.staff_agent_id = screen.staff_agent_id and open_command.ended_at is null)
				and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = office.profile_id
					and staff.staff_agent_id = screen.staff_agent_id and staff.employment_status = 'active')) asking
		-- Only questions not asked yet count against the limit.
		where not exists (select 1 from public.qorpera_machine_checkins asked where asked.machine_kind = 'computer'
			and asked.subject_id = asking.screen_id and asked.since = asking.worked_at and asked.mark_hours = asking.mark)
		order by asking.worked_at, asking.screen_id limit p_limit
	loop
		begin
			-- What still runs, as many as fit: 8 at most and 3000 bytes of commands, the rest counted.
			with listed as (
				select command.id, command.started_at,
					jsonb_build_object('command', left(command.command, 200), 'startedAt', command.started_at) as item
				from public.qorpera_runtime_office_shell_commands command
				where command.office_id = v_shell.office_id and command.screen_id = v_shell.screen_id
					and command.staff_agent_id = v_shell.staff_agent_id and command.ended_at is null),
			ordered as (
				select listed.item, row_number() over (order by listed.started_at, listed.id) as n,
					sum(octet_length(listed.item::text)) over (order by listed.started_at, listed.id) as bytes
				from listed)
			select jsonb_build_object('machine', 'your computer', 'busyHours', v_shell.mark,
				'running', coalesce(jsonb_agg(ordered.item order by ordered.n) filter (where ordered.n <= 8 and ordered.bytes <= 3000), '[]'::jsonb),
				'more', count(*) filter (where ordered.n > 8 or ordered.bytes > 3000))
			into v_body from ordered;
			insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id, machine_kind,
				subject_id, since, mark_hours, body)
			values (v_shell.profile_id, v_shell.environment_id, v_shell.staff_agent_id, v_shell.conversation_run_id, 'computer',
				v_shell.screen_id, v_shell.worked_at, v_shell.mark, v_body)
			on conflict (machine_kind, subject_id, since, mark_hours) do nothing;
			get diagnostics v_count = row_count;
			v_asked := v_asked + v_count;
		exception when check_violation or not_null_violation or foreign_key_violation or program_limit_exceeded then
			-- This question cannot be carried; the others still are.
			null;
		end;
	end loop;
	return v_asked;
end $$;
revoke all on function public.qorpera_ask_busy_office_shells(uuid, integer) from public, anon, authenticated, service_role;

-- Whether a question still stands when it would be delivered: no later mark was asked for the same count, and (on a
-- Company Computer) the shell is busy now, its seat is the same agent's and nobody worked with it since.
create function public.qorpera_machine_checkin_current(p_checkin public.qorpera_machine_checkins)
returns boolean language sql stable security definer set search_path = '' as $$
	select not exists (select 1 from public.qorpera_machine_checkins later where later.machine_kind = p_checkin.machine_kind
			and later.subject_id = p_checkin.subject_id and later.since = p_checkin.since and later.mark_hours > p_checkin.mark_hours)
		and case p_checkin.machine_kind
			when 'computer' then exists (select 1 from public.qorpera_runtime_office_shell_activity activity
				join public.qorpera_runtime_offices office on office.id = activity.office_id and office.generation = activity.computer_generation
				join public.qorpera_runtime_office_screens screen on screen.id = activity.screen_id
				where activity.screen_id = p_checkin.subject_id and activity.busy_until > clock_timestamp()
					and screen.staff_agent_id = p_checkin.staff_agent_id
					and (select max(command.worked_at) from public.qorpera_runtime_office_shell_commands command
						where command.screen_id = screen.id and command.staff_agent_id = screen.staff_agent_id) = p_checkin.since)
			-- Other machines judge their questions when they ask them.
			else true end
$$;
revoke all on function public.qorpera_machine_checkin_current(public.qorpera_machine_checkins) from public, anon, authenticated, service_role;

-- The folder drains' due list (LISTENER.md §9): folder-v2 environments, in id order after the cursor, with a busy
-- shell on their current computer generation or a question waiting, leaving out paused companies (the drain does
-- nothing while paused: a pause ends every shell command). A company being deleted counts as paused
-- (qorpera_company_execution_paused), so it is left out too.
create function public.qorpera_folder_machine_checkins_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_count integer; v_last uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder drain requires service authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder drain page bound is invalid' using errcode = '22023'; end if;
	with due as (
		select office.environment_id, office.profile_id from public.qorpera_runtime_office_shell_activity activity
		join public.qorpera_runtime_offices office on office.id = activity.office_id and office.generation = activity.computer_generation
		where activity.busy_until > clock_timestamp()
		union
		select checkin.environment_id, checkin.profile_id from public.qorpera_machine_checkins checkin where checkin.delivery = 'waiting'),
	page as (
		select distinct due.environment_id from due
		where (p_after_environment is null or due.environment_id > p_after_environment)
			and public.qorpera_environment_is_folder_v2(due.environment_id)
			and not public.qorpera_company_execution_paused(due.profile_id)
		order by due.environment_id limit p_limit)
	select coalesce(jsonb_agg(jsonb_build_object('environment_id', page.environment_id) order by page.environment_id), '[]'::jsonb),
		count(*), max(page.environment_id::text)::uuid
	into v_items, v_count, v_last from page;
	return jsonb_build_object('items', v_items, 'has_more', v_count = p_limit,
		'next_after_environment_id', case when v_count = p_limit then v_last end);
end $$;
revoke all on function public.qorpera_folder_machine_checkins_due(uuid, integer) from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_folder_machine_checkins_due(uuid, integer) to service_role;

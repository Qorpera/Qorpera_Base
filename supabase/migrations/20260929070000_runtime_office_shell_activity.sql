-- 20260929070000: Company Computer shells under one idle rule for every
-- machine (founder decisions of 28 September 2026, a shell with no 15-second
-- stop, and of 3 October 2026, the 2026-10-03 amendment "one idle rule for
-- every machine"). Each screen has its agent's shell. Every 30 seconds the
-- office reports each shell: whether it was busy (more than about 5% of one
-- core since the last sample), the commands still open and those that ended
-- since, each with the run that started it.
-- - A busy shell is demand and keeps its agent's seat (20260929070100) while
--   the report is fresh (90 seconds). A shell that only waits is neither: the
--   computer may sleep, and sleep ends its commands (20260930007000).
-- - One row per command keeps who started it, so that run's conversation is
--   told once if the platform stopped it (20260930007000), and asked about it
--   if it keeps the computer busy.
-- - A report is not a wake: it counts only for the office's current
--   generation, and an office already powering off is not woken by it.
-- - While the operator has paused the company, a report records nothing but
--   the pause and tells the office, which stops every shell.

create table public.qorpera_runtime_office_shell_activity (
	screen_id uuid primary key references public.qorpera_runtime_office_screens(id) on delete cascade,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete cascade,
	computer_generation bigint not null,
	busy_until timestamptz not null,
	reported_at timestamptz not null
);
create index qorpera_runtime_office_shell_activity_office on public.qorpera_runtime_office_shell_activity(office_id);
alter table public.qorpera_runtime_office_shell_activity enable row level security;
revoke all on public.qorpera_runtime_office_shell_activity from public,anon,authenticated,service_role;

-- One row per command, from the office's reports. Ended by the office
-- (exited, stopped by the agent, the memory guard, the pause, the shell
-- closing with its screen) or by the platform (slept, closed, paused, lost).
create table public.qorpera_runtime_office_shell_commands (
	id uuid primary key,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete cascade,
	computer_generation bigint not null,
	screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete cascade,
	staff_agent_id uuid not null,
	run_id uuid not null,
	-- The conversation of the run that started it: told and asked there.
	session_id uuid,
	command text not null check (char_length(command) between 1 and 300),
	started_at timestamptz not null,
	worked_at timestamptz not null,
	recorded_at timestamptz not null default clock_timestamp(),
	ended_at timestamptz,
	end_reason text check (end_reason in ('exited','stopped','pressure','paused','closed','slept','lost')),
	told_run_id uuid,
	told_at timestamptz,
	check ((ended_at is null) = (end_reason is null))
);
create index qorpera_runtime_office_shell_commands_open on public.qorpera_runtime_office_shell_commands(office_id, screen_id)
	where ended_at is null;
create index qorpera_runtime_office_shell_commands_ended on public.qorpera_runtime_office_shell_commands(office_id, ended_at)
	where ended_at is not null;
-- What a conversation's next run of the agent is told: a few rows, each once.
create index qorpera_runtime_office_shell_commands_untold on public.qorpera_runtime_office_shell_commands(staff_agent_id, session_id, ended_at)
	where told_at is null and end_reason in ('slept','closed','paused','pressure','lost');
alter table public.qorpera_runtime_office_shell_commands enable row level security;
revoke all on public.qorpera_runtime_office_shell_commands from public,anon,authenticated,service_role;

-- A report names each screen that has a shell (open or just closed with its
-- screen). A screen missing from it has no busy shell, and its commands still
-- open on the platform's side ended with it.
create function public.qorpera_report_runtime_office_shell_activity(p_scope jsonb,p_computer_generation bigint,p_report jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_at timestamptz:=clock_timestamp();
	v_screen jsonb; v_item jsonb; v_row public.qorpera_runtime_office_screens%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_reported uuid[]:='{}'; v_busy uuid[]:='{}';
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	if jsonb_typeof(p_report) is distinct from 'object' or p_report-'schema'-'screens'<>'{}'::jsonb
		or p_report->>'schema' is distinct from 'qorpera.office-shell-report/v1'
		or jsonb_typeof(p_report->'screens') is distinct from 'array' or jsonb_array_length(p_report->'screens')>64 then
		raise exception 'Invalid office shell activity' using errcode='22023'; end if;
	for v_screen in select value from jsonb_array_elements(p_report->'screens') loop
		if jsonb_typeof(v_screen) is distinct from 'object' or v_screen-'screenId'-'busy'-'open'-'ended'<>'{}'::jsonb
			or coalesce(v_screen->>'screenId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or (v_screen->>'screenId')::uuid=any(v_reported)
			or jsonb_typeof(v_screen->'busy') is distinct from 'boolean'
			or jsonb_typeof(v_screen->'open') is distinct from 'array' or jsonb_array_length(v_screen->'open')>64
			or jsonb_typeof(v_screen->'ended') is distinct from 'array' or jsonb_array_length(v_screen->'ended')>64 then
			raise exception 'Invalid office shell activity' using errcode='22023'; end if;
		v_reported:=v_reported||(v_screen->>'screenId')::uuid;
	end loop;
	-- The same office row lock the idle reconciler and the supervisor take.
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation then
		raise exception 'Office shell activity binding differs' using errcode='42501'; end if;
	if exists(select 1 from unnest(v_reported) as reported(id) where not exists(
		select 1 from public.qorpera_runtime_office_screens s where s.id=reported.id and s.office_id=v_office.id)) then
		raise exception 'Office shell activity screen differs' using errcode='42501'; end if;
	-- A week after it ended, a command's row has done its work.
	delete from public.qorpera_runtime_office_shell_commands where id in (select id from public.qorpera_runtime_office_shell_commands
		where office_id=v_office.id and ended_at<v_at-interval '7 days' order by ended_at limit 64);
	-- Commands of an earlier generation that nobody ended went with it.
	update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='lost'
		where office_id=v_office.id and computer_generation<v_office.generation and ended_at is null;
	if public.qorpera_company_execution_paused(v_office.profile_id) then
		delete from public.qorpera_runtime_office_shell_activity where office_id=v_office.id;
		update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='paused'
			where office_id=v_office.id and ended_at is null;
		return jsonb_build_object('schema','qorpera.office-shell-activity/v1','screens','[]'::jsonb,'paused',true);
	end if;
	for v_screen in select value from jsonb_array_elements(p_report->'screens') loop
		select * into strict v_row from public.qorpera_runtime_office_screens where id=(v_screen->>'screenId')::uuid;
		if (v_screen->>'busy')::boolean then v_busy:=v_busy||v_row.id; end if;
		for v_item in select value from jsonb_array_elements(v_screen->'open') loop
			v_run:=public.qorpera_office_shell_command_run(v_office,v_row,v_item,false);
			insert into public.qorpera_runtime_office_shell_commands(id,office_id,computer_generation,screen_id,staff_agent_id,run_id,
				session_id,command,started_at,worked_at)
			values((v_item->>'id')::uuid,v_office.id,v_office.generation,v_row.id,v_run.staff_agent_id,v_run.id,v_run.session_id,
				v_item->>'command',(v_item->>'startedAt')::timestamptz,(v_item->>'workedAt')::timestamptz)
			on conflict(id) do update set worked_at=greatest(public.qorpera_runtime_office_shell_commands.worked_at,excluded.worked_at)
				where public.qorpera_runtime_office_shell_commands.office_id=v_office.id
					and public.qorpera_runtime_office_shell_commands.screen_id=v_row.id
					and public.qorpera_runtime_office_shell_commands.ended_at is null;
		end loop;
		for v_item in select value from jsonb_array_elements(v_screen->'ended') loop
			v_run:=public.qorpera_office_shell_command_run(v_office,v_row,v_item,true);
			insert into public.qorpera_runtime_office_shell_commands(id,office_id,computer_generation,screen_id,staff_agent_id,run_id,
				session_id,command,started_at,worked_at,ended_at,end_reason)
			values((v_item->>'id')::uuid,v_office.id,v_office.generation,v_row.id,v_run.staff_agent_id,v_run.id,v_run.session_id,
				v_item->>'command',(v_item->>'startedAt')::timestamptz,(v_item->>'startedAt')::timestamptz,
				least(v_at,(v_item->>'endedAt')::timestamptz),v_item->>'reason')
			on conflict(id) do update set ended_at=excluded.ended_at,end_reason=excluded.end_reason
				where public.qorpera_runtime_office_shell_commands.office_id=v_office.id
					and public.qorpera_runtime_office_shell_commands.screen_id=v_row.id
					and public.qorpera_runtime_office_shell_commands.ended_at is null;
		end loop;
	end loop;
	-- A screen the report does not name has no shell: what was still open ended with it.
	update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='closed'
		where office_id=v_office.id and ended_at is null and screen_id<>all(v_reported);
	delete from public.qorpera_runtime_office_shell_activity where office_id=v_office.id and screen_id<>all(v_busy);
	insert into public.qorpera_runtime_office_shell_activity(screen_id,office_id,computer_generation,busy_until,reported_at)
		select busy.id,v_office.id,v_office.generation,v_at+interval '90 seconds',v_at from unnest(v_busy) as busy(id)
		on conflict(screen_id) do update set office_id=excluded.office_id,computer_generation=excluded.computer_generation,
			busy_until=excluded.busy_until,reported_at=excluded.reported_at;
	return jsonb_build_object('schema','qorpera.office-shell-activity/v1','screens',to_jsonb(v_busy),'paused',false);
end $$;
revoke all on function public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb) to service_role;

-- One reported command: its exact shape, and the run that started it, which
-- must be the screen's agent's run in the office's company and environment.
create function public.qorpera_office_shell_command_run(p_office public.qorpera_runtime_offices,
	p_screen public.qorpera_runtime_office_screens,p_item jsonb,p_ended boolean)
returns public.qorpera_execution_runs language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_uuid text:='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
	v_time text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$';
begin
	if jsonb_typeof(p_item) is distinct from 'object'
		or (not p_ended and p_item-'id'-'runId'-'command'-'startedAt'-'workedAt'<>'{}'::jsonb)
		or (p_ended and p_item-'id'-'runId'-'command'-'startedAt'-'reason'-'endedAt'<>'{}'::jsonb)
		or coalesce(p_item->>'id','') !~ v_uuid or coalesce(p_item->>'runId','') !~ v_uuid
		or jsonb_typeof(p_item->'command') is distinct from 'string' or char_length(p_item->>'command') not between 1 and 300
		or coalesce(p_item->>'startedAt','') !~ v_time
		or (not p_ended and coalesce(p_item->>'workedAt','') !~ v_time)
		or (p_ended and (coalesce(p_item->>'endedAt','') !~ v_time
			or coalesce(p_item->>'reason','') not in ('exited','stopped','pressure','paused','closed'))) then
		raise exception 'Invalid office shell activity' using errcode='22023'; end if;
	select * into v_run from public.qorpera_execution_runs where id=(p_item->>'runId')::uuid;
	if not found or v_run.profile_id is distinct from p_office.profile_id or v_run.environment_id is distinct from p_office.environment_id
		or v_run.staff_agent_id is distinct from p_screen.staff_agent_id then
		raise exception 'Office shell activity run differs' using errcode='42501'; end if;
	return v_run;
end $$;
revoke all on function public.qorpera_office_shell_command_run(public.qorpera_runtime_offices,public.qorpera_runtime_office_screens,jsonb,boolean)
	from public,anon,authenticated,service_role;

-- Patched in place, like 20260919020000 does, so other demand patches commute.
create function pg_temp.office_shell_activity_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office shell activity integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.office_shell_activity_patch('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure,
	$old$and (w.status='queued' or j.status in ('queued','leased','running')))$old$,
	$new$and (w.status='queued' or j.status in ('queued','leased','running')))
		-- A busy Company Computer shell (20260929070000).
		or exists(select 1 from public.qorpera_runtime_office_shell_activity a where a.office_id=p_office.id
			and a.computer_generation=p_office.generation and a.busy_until>clock_timestamp())$new$);

-- The demand function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid='public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office demand function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_runtime_office_shell_activity to %I',v_owner); end if;
end $$;

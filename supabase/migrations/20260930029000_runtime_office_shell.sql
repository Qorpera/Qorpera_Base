-- 20260930029000: the Company Computer's long-running shells under one idle
-- rule for every machine (founder decisions of 28 September 2026, a shell that
-- runs as long as the work needs, and of 3 October 2026, the amendment "one
-- idle rule for every machine"). Folder-v2 only by the founder's decision of 3
-- October: every function here is shared by both cores and has no snapshot-v1
-- branch; the office paths it rides take the folder order since C1c-3j/3k.
-- Each screen has its agent's shell. Every 30 seconds the office reports each
-- shell: whether it was busy (more than about 5% of one core since the last
-- sample), the commands still open and those that ended since, each with the
-- run that started it and the receipt of that start.
-- 1. A busy shell is demand and keeps its agent's seat for 90 seconds after its
--    last busy report. A shell that only waits is neither: the computer may
--    sleep.
-- 2. One row per command keeps who started it. A command counts only when its
--    start is the screen's own recorded effect for that run
--    (qorpera_runtime_office_resources); anything else in a report is left
--    out, never refused, so one stale item cannot stop every report.
-- 3. Sleep ends what still runs (slept); any other stop of the computer, a
--    screen gone, a seat that changed hands, a pause or a lost generation end
--    it as closed, paused or lost; one the office stops listing without
--    reporting its end, as unknown.
-- 4. The agent's next run in the conversation that started a command the
--    platform stopped (a worker's: the conversation that dispatched it) is
--    told, once: a list in the open work the host reads at the start of every
--    company run (qorpera_describe_agent_open_work, computerStopped).
-- 5. The office's operation check takes every computer_shell action.
-- A report is not a wake: it counts only for the office's current generation,
-- and an office already powering off is not woken by it. While the operator
-- has paused the company, a report ends every command as paused and tells the
-- office, which stops every shell.
-- Lock order: the report and the idle policy take the office row (the idle
-- policy after the folder machine fence, C1c-3j), then the command rows. The
-- told list takes command rows with SKIP LOCKED only.

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
-- closing with its screen) or by the platform (slept, closed, paused, lost,
-- unknown).
create table public.qorpera_runtime_office_shell_commands (
	id uuid primary key,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete cascade,
	computer_generation bigint not null,
	screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete cascade,
	staff_agent_id uuid not null,
	run_id uuid not null,
	-- The start's effect receipt: the screen's own record of that run's action.
	receipt_id uuid not null,
	-- Told and asked here: the run that started it, or for a worker the run that
	-- dispatched it, and that run's conversation.
	conversation_run_id uuid not null,
	session_id uuid,
	command text not null check (char_length(command) between 1 and 300),
	started_at timestamptz not null,
	worked_at timestamptz not null,
	recorded_at timestamptz not null default clock_timestamp(),
	ended_at timestamptz,
	-- unknown: the office no longer lists it, and never reported its end (it let that go). Never told.
	end_reason text check (end_reason in ('exited','stopped','pressure','paused','closed','slept','lost','unknown')),
	told_run_id uuid,
	told_at timestamptz,
	check ((ended_at is null) = (end_reason is null))
);
create index qorpera_runtime_office_shell_commands_open on public.qorpera_runtime_office_shell_commands(office_id, screen_id)
	where ended_at is null;
create index qorpera_runtime_office_shell_commands_ended on public.qorpera_runtime_office_shell_commands(office_id, ended_at)
	where ended_at is not null;
-- What a conversation's next run of the agent is told: a few rows, each once.
create index qorpera_runtime_office_shell_commands_told on public.qorpera_runtime_office_shell_commands(staff_agent_id, session_id, ended_at)
	where end_reason in ('slept','closed','paused','pressure','lost');
alter table public.qorpera_runtime_office_shell_commands enable row level security;
revoke all on public.qorpera_runtime_office_shell_commands from public,anon,authenticated,service_role;

-- A report names each screen that has a shell (open or just closed with its
-- screen). A screen missing from it has no shell: its commands still open on
-- the platform's side ended with it.
create function public.qorpera_report_runtime_office_shell_activity(p_scope jsonb,p_computer_generation bigint,p_report jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_at timestamptz:=clock_timestamp();
	v_screen jsonb; v_item jsonb; v_row public.qorpera_runtime_office_screens%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_conversation public.qorpera_execution_runs%rowtype; v_ended boolean; v_reported uuid[]:='{}'; v_busy uuid[]:='{}';
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
		for v_item in select value from jsonb_array_elements(v_screen->'open') loop
			perform public.qorpera_valid_office_shell_command(v_item,false); end loop;
		for v_item in select value from jsonb_array_elements(v_screen->'ended') loop
			perform public.qorpera_valid_office_shell_command(v_item,true); end loop;
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
	-- Every command the report names, also under a pause (it ends as paused below). One whose start is not
	-- this screen's own effect for that run is left out.
	for v_screen in select value from jsonb_array_elements(p_report->'screens') loop
		select * into strict v_row from public.qorpera_runtime_office_screens where id=(v_screen->>'screenId')::uuid;
		if (v_screen->>'busy')::boolean then v_busy:=v_busy||v_row.id; end if;
		for v_item,v_ended in select value,false from jsonb_array_elements(v_screen->'open')
			union all select value,true from jsonb_array_elements(v_screen->'ended') loop
			v_run:=public.qorpera_office_shell_command_run(v_office,v_row,v_item);
			if v_run.id is null then continue; end if;
			v_conversation:=public.qorpera_office_shell_conversation_run(v_run);
			insert into public.qorpera_runtime_office_shell_commands(id,office_id,computer_generation,screen_id,staff_agent_id,run_id,
				receipt_id,conversation_run_id,session_id,command,started_at,worked_at,ended_at,end_reason)
			values((v_item->>'id')::uuid,v_office.id,v_office.generation,v_row.id,v_run.staff_agent_id,v_run.id,
				(v_item->>'receiptId')::uuid,v_conversation.id,v_conversation.session_id,v_item->>'command',
				(v_item->>'startedAt')::timestamptz,
				case when v_ended then (v_item->>'startedAt')::timestamptz else (v_item->>'workedAt')::timestamptz end,
				case when v_ended then least(v_at,(v_item->>'endedAt')::timestamptz) end,
				case when v_ended then v_item->>'reason' end)
			on conflict(id) do update set
				worked_at=greatest(public.qorpera_runtime_office_shell_commands.worked_at,excluded.worked_at),
				ended_at=excluded.ended_at,end_reason=excluded.end_reason
				where public.qorpera_runtime_office_shell_commands.office_id=v_office.id
					and public.qorpera_runtime_office_shell_commands.screen_id=v_row.id
					and public.qorpera_runtime_office_shell_commands.run_id=v_run.id
					and public.qorpera_runtime_office_shell_commands.ended_at is null;
		end loop;
	end loop;
	-- A seat that changed hands: the previous agent's commands there ended with it.
	update public.qorpera_runtime_office_shell_commands command set ended_at=v_at,end_reason='closed'
		from public.qorpera_runtime_office_screens screen
		where command.office_id=v_office.id and command.ended_at is null and screen.id=command.screen_id
			and screen.staff_agent_id is distinct from command.staff_agent_id;
	-- A screen whose lists are whole names every command it still has: one it neither lists open nor reports
	-- ended was let go of by the office (its end never arrived), so nobody is told a stop that did not happen.
	for v_screen in select value from jsonb_array_elements(p_report->'screens')
		where jsonb_array_length(value->'open')<64 and jsonb_array_length(value->'ended')<64 loop
		update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='unknown'
			where office_id=v_office.id and screen_id=(v_screen->>'screenId')::uuid and ended_at is null
				and id<>all(array(select (item->>'id')::uuid from jsonb_array_elements(v_screen->'open') item));
	end loop;
	if public.qorpera_company_execution_paused(v_office.profile_id) then
		delete from public.qorpera_runtime_office_shell_activity where office_id=v_office.id;
		update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='paused'
			where office_id=v_office.id and ended_at is null;
		return jsonb_build_object('schema','qorpera.office-shell-activity/v1','screens','[]'::jsonb,'paused',true);
	end if;
	-- A screen the report does not name has no shell: what was still open ended with it.
	update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='closed'
		where office_id=v_office.id and ended_at is null and screen_id<>all(v_reported);
	-- A busy report keeps its screen's demand for 90 seconds; a quiet one does not cut that short, a closed shell does.
	delete from public.qorpera_runtime_office_shell_activity where office_id=v_office.id
		and (screen_id<>all(v_reported) or busy_until<=v_at);
	insert into public.qorpera_runtime_office_shell_activity(screen_id,office_id,computer_generation,busy_until,reported_at)
		select busy.id,v_office.id,v_office.generation,v_at+interval '90 seconds',v_at from unnest(v_busy) as busy(id)
		on conflict(screen_id) do update set office_id=excluded.office_id,computer_generation=excluded.computer_generation,
			busy_until=excluded.busy_until,reported_at=excluded.reported_at;
	return jsonb_build_object('schema','qorpera.office-shell-activity/v1','screens',to_jsonb(v_busy),'paused',false);
end $$;
revoke all on function public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb) to service_role;

-- One reported command's exact shape. A shape the office never sends is refused.
create function public.qorpera_valid_office_shell_command(p_item jsonb,p_ended boolean)
returns void language plpgsql immutable set search_path = '' as $$
declare v_uuid text:='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
	v_time text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$';
begin
	if jsonb_typeof(p_item) is distinct from 'object'
		or (not p_ended and p_item-'id'-'runId'-'receiptId'-'command'-'startedAt'-'workedAt'<>'{}'::jsonb)
		or (p_ended and p_item-'id'-'runId'-'receiptId'-'command'-'startedAt'-'reason'-'endedAt'<>'{}'::jsonb)
		or coalesce(p_item->>'id','') !~ v_uuid or coalesce(p_item->>'runId','') !~ v_uuid
		or jsonb_typeof(p_item->'receiptId') is distinct from 'string'
		or jsonb_typeof(p_item->'command') is distinct from 'string' or char_length(p_item->>'command') not between 1 and 300
		or coalesce(p_item->>'startedAt','') !~ v_time
		or (not p_ended and coalesce(p_item->>'workedAt','') !~ v_time)
		or (p_ended and (coalesce(p_item->>'endedAt','') !~ v_time
			or coalesce(p_item->>'reason','') not in ('exited','stopped','pressure','paused','closed'))) then
		raise exception 'Invalid office shell activity' using errcode='22023'; end if;
end $$;
revoke all on function public.qorpera_valid_office_shell_command(jsonb,boolean) from public,anon,authenticated,service_role;

-- The run that started a reported command, when its start is this screen's own effect for that run in the office's
-- company; otherwise none, and the command is left out.
create function public.qorpera_office_shell_command_run(p_office public.qorpera_runtime_offices,
	p_screen public.qorpera_runtime_office_screens,p_item jsonb)
returns public.qorpera_execution_runs language sql stable security definer set search_path = '' as $$
	select run.* from public.qorpera_runtime_office_resources resource
	join public.qorpera_execution_runs run on run.id=resource.run_id
	-- A receipt id that is not a uuid matches nothing (the cast waits for the pattern).
	where resource.receipt_id=case when p_item->>'receiptId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			then (p_item->>'receiptId')::uuid end
		and resource.office_id=p_office.id and resource.screen_id=p_screen.id
		and resource.run_id=(p_item->>'runId')::uuid
		and run.profile_id=p_office.profile_id and run.environment_id=p_office.environment_id and run.staff_agent_id is not null
$$;
revoke all on function public.qorpera_office_shell_command_run(public.qorpera_runtime_offices,public.qorpera_runtime_office_screens,jsonb)
	from public,anon,authenticated,service_role;

-- Where a run's commands are told and asked about: its own conversation, or for a worker the run that dispatched it.
create function public.qorpera_office_shell_conversation_run(p_run public.qorpera_execution_runs)
returns public.qorpera_execution_runs language sql stable security definer set search_path = '' as $$
	select coalesce((select steering from public.qorpera_execution_runs steering
		where steering.id=(public.qorpera_run_worker(p_run.id)).steering_run_id),p_run)
$$;
revoke all on function public.qorpera_office_shell_conversation_run(public.qorpera_execution_runs)
	from public,anon,authenticated,service_role;

-- Patched in place, so other patches commute.
create function pg_temp.office_shell_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office shell integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.office_shell_patch('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure,
	$old$and (w.status='queued' or j.status in ('queued','leased','running')))$old$,
	$new$and (w.status='queued' or j.status in ('queued','leased','running')))
		-- A busy Company Computer shell (20260930029000).
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

-- A busy shell keeps its agent's seat as it keeps the machine awake: patched into
-- qorpera_runtime_office_screen_in_use (20260928237200).
select pg_temp.office_shell_patch('public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens)'::regprocedure,
	$old$or exists(select 1 from public.qorpera_runtime_office_resources r where r.screen_id = p_screen.id and r.state <> 'drained')$old$,
	$new$or exists(select 1 from public.qorpera_runtime_office_resources r where r.screen_id = p_screen.id and r.state <> 'drained')
		-- A busy shell on the computer (20260930029000).
		or exists(select 1 from public.qorpera_runtime_office_shell_activity a
			join public.qorpera_runtime_offices o on o.id = a.office_id
			where a.screen_id = p_screen.id and a.computer_generation = o.generation and a.busy_until > clock_timestamp())$new$);

-- The seat function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid='public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office seat function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_runtime_office_shell_activity to %I',v_owner); end if;
end $$;

-- The office's operation check takes every computer_shell action the tool
-- sends, and the 15-second form of the runtime before this one (until the
-- legacy cleanup pass removes it): each action's own keys, a command or input
-- of at most 16 KiB, a wait of at most 15 seconds, and a command id the office
-- issued. Anything else, including a shape it cannot judge, is refused.
create function public.qorpera_valid_office_shell_action(p_args jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
	v_keys text[];
	v_wait jsonb:=p_args->'waitMs';
	v_session text:=p_args->>'sessionId';
begin
	if jsonb_typeof(p_args) is distinct from 'object' or p_args->>'kind' is distinct from 'shell' then return false; end if;
	-- The 15-second form of older runtime bundles.
	if not p_args ? 'action' then
		return coalesce(p_args-'kind'-'command'-'timeoutMs'='{}'::jsonb
			and jsonb_typeof(p_args->'command')='string'
			and p_args->>'command' ~ '[^[:space:]]' and octet_length(p_args->>'command')<=16384
			and jsonb_typeof(p_args->'timeoutMs')='number'
			and case when coalesce(p_args->>'timeoutMs','') ~ '^[0-9]{1,5}$'
				then (p_args->>'timeoutMs')::integer between 1 and 15000 else false end,false);
	end if;
	select array_agg(key order by key collate "C") into v_keys from jsonb_object_keys(p_args) as key;
	if p_args ? 'waitMs' and not (case when jsonb_typeof(v_wait)='number' and v_wait::text ~ '^[0-9]{1,5}$'
		then v_wait::text::integer<=15000 else false end) then return false; end if;
	if p_args ? 'sessionId' and (jsonb_typeof(p_args->'sessionId') is distinct from 'string'
		or v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then return false; end if;
	return coalesce(case p_args->>'action'
		when 'start' then v_keys=array['action','command','kind','waitMs']
			and jsonb_typeof(p_args->'command')='string'
			and p_args->>'command' ~ '[^[:space:]]' and octet_length(p_args->>'command')<=16384
		when 'read' then v_keys=array['action','kind','sessionId','waitMs']
		when 'write' then v_keys=array['action','endInput','kind','sessionId','text','waitMs']
			and jsonb_typeof(p_args->'text')='string' and octet_length(p_args->>'text')<=16384
			and jsonb_typeof(p_args->'endInput')='boolean'
			and (p_args->>'text'<>'' or p_args->'endInput'='true'::jsonb)
		when 'stop' then v_keys=array['action','kind'] or v_keys=array['action','kind','sessionId']
		when 'list' then v_keys=array['action','kind']
		else false
	end,false);
end $$;
revoke all on function public.qorpera_valid_office_shell_action(jsonb) from public,anon,authenticated,service_role;

select pg_temp.office_shell_patch(
	'public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure,
	$old$		if (v_operation->'arguments')-'kind'-'command'-'timeoutMs'<>'{}'::jsonb
			or jsonb_typeof(v_operation#>'{arguments,command}') is distinct from 'string'
			or length(btrim(v_operation#>>'{arguments,command}'))=0 or octet_length(v_operation#>>'{arguments,command}')>16384
			or coalesce(v_operation#>>'{arguments,timeoutMs}','') !~ '^[0-9]{1,5}$'
			or (v_operation#>>'{arguments,timeoutMs}')::integer not between 1 and 15000 then$old$,
	$new$		-- Every computer_shell action and the older 15-second form (20260930029000).
		if not coalesce(public.qorpera_valid_office_shell_action(v_operation->'arguments'),false) then$new$);

-- The operation function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid='public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office operation function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant execute on function public.qorpera_valid_office_shell_action(jsonb) to %I',v_owner); end if;
end $$;

-- Sleep stops what still runs in a shell before the idle policy powers the
-- computer off, and any other stop of the computer ends it as closed.
select pg_temp.office_shell_patch('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure,
	$old$		perform public.qorpera_begin_runtime_office_lifecycle(v_request);$old$,
	$new$		-- Sleep stops what still runs in its shells; their runs are told (20260930029000).
		update public.qorpera_runtime_office_shell_commands set ended_at=v_at,end_reason='slept'
			where office_id=o.id and ended_at is null;
		perform public.qorpera_begin_runtime_office_lifecycle(v_request);$new$);
select pg_temp.office_shell_patch('public.qorpera_begin_runtime_office_lifecycle(jsonb)'::regprocedure,
	$old$	update public.qorpera_runtime_office_viewers set state='draining' where office_id=v_office.id and state in ('issued','active');$old$,
	$new$	update public.qorpera_runtime_office_viewers set state='draining' where office_id=v_office.id and state in ('issued','active');
	-- Any stop of the computer stops what still runs in its shells (20260930029000).
	update public.qorpera_runtime_office_shell_commands set ended_at=clock_timestamp(),end_reason='closed'
		where office_id=v_office.id and ended_at is null;$new$);

-- The agent's commands that the platform stopped and that belong to this
-- run's conversation, oldest first, at most 32 a run.
-- A row belongs to the first run that took it; the same run (a restart after a
-- usage limit) takes it again. A run outside any conversation is told nothing.
create function public.qorpera_take_agent_computer_stopped(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_taken jsonb;
begin
	if p_run.staff_agent_id is null or p_run.session_id is null then return null; end if;
	with taken as (
		select command.id from public.qorpera_runtime_office_shell_commands command
		where command.staff_agent_id=p_run.staff_agent_id and command.session_id=p_run.session_id
			and command.end_reason in ('slept','closed','paused','pressure','lost')
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

select pg_temp.office_shell_patch('public.qorpera_describe_agent_open_work(jsonb)'::regprocedure,
	$old$				and todo.state in ('open','blocked')));$old$,
	$new$				and todo.state in ('open','blocked')))
		-- Commands the computer stopped, told once in their conversation (20260930029000).
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

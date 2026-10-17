-- Shell command views: F3 step 4, slice 4b (deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md), which builds C1b-3b
-- (RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views" §8). An offline computer_shell command works in the company folder
-- through a view of its own, opened before the command runs and closed by its last publish.
-- 1. A row per command from its start. qorpera_runtime_office_shell_commands is keyed by the start effect's receipt
--    (id = receipt_id) and keeps the guest's session id in command_id. The native operation's begin of a shell start
--    makes the row, before the guest runs anything, with the screen's generation, the run's member and whether the
--    command uses the network (the start's new "network" argument; absent, it does not). The office's 30 s report
--    fills in command_id; its sweeps spare a row it has not named yet for 60 seconds after its start's effect ended,
--    and only commands it named are told as stopped.
-- 2. The view, kind computer_shell_command, opened by the platform for an offline command that has not ended, while
--    the command's run holds the screen, in the screen's and the office's generation the command started in. It acts
--    through the command's run while the run's job is leased, then detached as the agent (in_house), company-wide as a
--    desktop. It stands while the screen keeps that generation, the office the view's activation and the agent its
--    access. Not the command's end: an ended command's view still renews, for its final publish.
-- 3. The final publish: the view actor's "final": true. Once its command has ended, a command view saves only its
--    final change set. The final closes the view in the commit's transaction, whether it saved anything or not (it may
--    carry no change at all); only a command view sends one.
--
-- Exact-text patch: it fails unless the function has the text given exactly once. Body marker "20260930183000".

set local lock_timeout = '3s';

do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_runtime_office_shell_commands'::regclass
		and attname = 'command_id' and not attisdropped) then
		raise exception 'Shell command views (20260930183000) are already applied'; end if;
end $$;

create function pg_temp.folder_view_shell_commands_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. A row per command from its start -------------------------------------------------------------------------------

-- The row's key is the start effect's receipt (C1B §8); command_id is the guest's session id, which the report fills
-- in. network: whether the command uses the network (a row the report made, and every older row, says true, so it gets
-- no view). requested_by_user_id: the run's member. screen_generation: the screen's generation at the start (null on a
-- row the report made, and on older rows).
alter table public.qorpera_runtime_office_shell_commands add column command_id uuid,
	add column network boolean not null default true, add column requested_by_user_id uuid, add column screen_generation bigint;
-- One row per start: the newest of an older start's rows stays.
delete from public.qorpera_runtime_office_shell_commands command where exists (select 1
	from public.qorpera_runtime_office_shell_commands newer
	where newer.receipt_id = command.receipt_id and (newer.recorded_at, newer.id) > (command.recorded_at, command.id));
update public.qorpera_runtime_office_shell_commands command set command_id = command.id, id = command.receipt_id,
	requested_by_user_id = (select run.requested_by_user_id from public.qorpera_execution_runs run where run.id = command.run_id);
alter table public.qorpera_runtime_office_shell_commands add constraint qorpera_runtime_office_shell_commands_start
	check (id = receipt_id);

-- A start's own row that the office has not named yet may still be starting: its effect is open, or ended less than
-- 60 seconds ago (the next 30 s report names a command that started).
create function public.qorpera_office_shell_command_starting(p_command public.qorpera_runtime_office_shell_commands,
	p_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930183000.
	select p_command.command_id is null and exists (select 1 from public.qorpera_runtime_office_resources resource
		where resource.receipt_id = p_command.id and coalesce(resource.drained_at, resource.expires_at) > p_at - interval '60 seconds')
$$;
revoke all on function public.qorpera_office_shell_command_starting(public.qorpera_runtime_office_shell_commands, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The start's row, made by the native operation's begin, before the guest runs anything.
select pg_temp.folder_view_shell_commands_patch(
	'public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure,
	$old$			where id=v_resource.id returning * into v_resource;
		end if;
	else$old$,
	$new$			where id=v_resource.id returning * into v_resource;
		end if;
		-- 20260930183000 (C1B §8): a shell start's row, keyed by its receipt, before the guest runs anything; a command's
		-- view opens on it. The report fills in the guest's session id (command_id).
		if v_operation#>>'{arguments,kind}'='shell' and v_operation#>>'{arguments,action}'='start' then
			insert into public.qorpera_runtime_office_shell_commands(id,receipt_id,office_id,computer_generation,screen_id,
				screen_generation,staff_agent_id,run_id,requested_by_user_id,conversation_run_id,session_id,command,network,
				started_at,worked_at)
			select p_receipt_id,p_receipt_id,o.id,o.generation,s.id,s.generation,r.staff_agent_id,r.id,r.requested_by_user_id,
				conversation.id,conversation.session_id,left(v_operation#>>'{arguments,command}',300),
				coalesce((v_operation#>>'{arguments,network}')::boolean,false),clock_timestamp(),clock_timestamp()
			from public.qorpera_runtime_offices o
			join public.qorpera_runtime_office_screens s on s.id=v_resource.screen_id and s.office_id=o.id
			join public.qorpera_execution_runs r on r.id=v_receipt.run_id
			cross join lateral public.qorpera_office_shell_conversation_run(r) conversation
			where o.id=v_resource.office_id and r.staff_agent_id is not null
				and r.profile_id=o.profile_id and r.environment_id=o.environment_id
			on conflict (id) do nothing;
		end if;
	else$new$);

-- A start may say whether the command uses the network.
select pg_temp.folder_view_shell_commands_patch('public.qorpera_valid_office_shell_action(jsonb)'::regprocedure,
	$old$		when 'start' then v_keys=array['action','command','kind','waitMs']
$old$,
	$new$		-- 20260930183000: a start may say whether the command uses the network (absent: it does not).
		when 'start' then (v_keys=array['action','command','kind','waitMs']
			or (v_keys=array['action','command','kind','network','waitMs'] and jsonb_typeof(p_args->'network')='boolean'))
$new$);

-- The report: the row it names by the start's receipt, with the guest's session id; the sweeps spare a starting row.
select pg_temp.folder_view_shell_commands_patch(
	'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)'::regprocedure,
	$old$			insert into public.qorpera_runtime_office_shell_commands(id,office_id,computer_generation,screen_id,staff_agent_id,run_id,
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
					and public.qorpera_runtime_office_shell_commands.ended_at is null;$old$,
	$new$			-- 20260930183000 (C1B §8): the row is the start's, keyed by its receipt (the native operation made it at the
			-- start); the report fills in the guest's session id. A row that has another session id is not this command's.
			insert into public.qorpera_runtime_office_shell_commands(id,command_id,office_id,computer_generation,screen_id,
				staff_agent_id,run_id,requested_by_user_id,receipt_id,conversation_run_id,session_id,command,started_at,worked_at,
				ended_at,end_reason)
			values((v_item->>'receiptId')::uuid,(v_item->>'id')::uuid,v_office.id,v_office.generation,v_row.id,
				v_run.staff_agent_id,v_run.id,v_run.requested_by_user_id,(v_item->>'receiptId')::uuid,v_conversation.id,
				v_conversation.session_id,v_item->>'command',
				(v_item->>'startedAt')::timestamptz,
				case when v_ended then (v_item->>'startedAt')::timestamptz else (v_item->>'workedAt')::timestamptz end,
				case when v_ended then least(v_at,(v_item->>'endedAt')::timestamptz) end,
				case when v_ended then v_item->>'reason' end)
			on conflict(id) do update set
				command_id=coalesce(public.qorpera_runtime_office_shell_commands.command_id,excluded.command_id),
				worked_at=greatest(public.qorpera_runtime_office_shell_commands.worked_at,excluded.worked_at),
				ended_at=excluded.ended_at,end_reason=excluded.end_reason
				where public.qorpera_runtime_office_shell_commands.office_id=v_office.id
					and public.qorpera_runtime_office_shell_commands.screen_id=v_row.id
					and public.qorpera_runtime_office_shell_commands.run_id=v_run.id
					and public.qorpera_runtime_office_shell_commands.ended_at is null
					and (public.qorpera_runtime_office_shell_commands.command_id is null
						or public.qorpera_runtime_office_shell_commands.command_id=excluded.command_id);$new$);
select pg_temp.folder_view_shell_commands_patch(
	'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)'::regprocedure,
	$old$				and id<>all(array(select (item->>'id')::uuid from jsonb_array_elements(v_screen->'open') item));$old$,
	$new$				-- 20260930183000: the office names a command by its session id; a start's own row it has not named
				-- yet may still be starting.
				and not coalesce(command_id=any(array(select (item->>'id')::uuid
					from jsonb_array_elements(v_screen->'open') item)),false)
				and not public.qorpera_office_shell_command_starting(qorpera_runtime_office_shell_commands,v_at);$new$);
select pg_temp.folder_view_shell_commands_patch(
	'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)'::regprocedure,
	$old$		where office_id=v_office.id and ended_at is null and screen_id<>all(v_reported);$old$,
	$new$		where office_id=v_office.id and ended_at is null and screen_id<>all(v_reported)
			and not public.qorpera_office_shell_command_starting(qorpera_runtime_office_shell_commands,v_at); -- 20260930183000$new$);

-- Only commands the office named are told as stopped.
select pg_temp.folder_view_shell_commands_patch(
	'public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs)'::regprocedure,
	$old$			and command.end_reason in ('slept','closed','paused','pressure','lost')
$old$,
	$new$			and command.end_reason in ('slept','closed','paused','pressure','lost')
			-- 20260930183000: only commands the office listed: a start's own row that no report named may never have run.
			and command.command_id is not null
$new$);

-- 2. The view -------------------------------------------------------------------------------------------------------

-- A command's view (C1b-3b): its command row; no screen of its own (the screen's desktop view keeps the screen's
-- unique index); the screen generation the command started in and the office activation it opened under. No foreign
-- key: a command's row is deleted a week after it ends, and the view's history stays.
alter table public.qorpera_folder_views add column shell_command_id uuid;
alter table public.qorpera_folder_views drop constraint qorpera_folder_views_kind_check1,
	add constraint qorpera_folder_views_built_kind
		check (kind in ('run_box','computer_desktop','computer_shell_command','coding_session')),
	add constraint qorpera_folder_views_shell_command check (kind <> 'computer_shell_command' or (shell_command_id is not null
		and screen_generation is not null and activation_id is not null and screen_id is null and holder_run_id is null
		and holder_user_id is null)),
	add constraint qorpera_folder_views_shell_command_kind check (shell_command_id is null or kind = 'computer_shell_command');
-- One view per command.
create unique index qorpera_folder_views_one_per_command on public.qorpera_folder_views (shell_command_id)
	where shell_command_id is not null;

-- Valid while the screen keeps the command's generation, the office the view's activation and the agent its access.
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
	$old$		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs$old$,
	$new$		-- 20260930183000: a command view stands while its command's screen keeps the generation the command started
		-- in, the office keeps the view's activation and the agent its access. Not the command's end: an ended
		-- command's view takes one final publish (C1B §8), which closes it.
		when 'computer_shell_command' then exists (select 1 from public.qorpera_runtime_office_shell_commands c
			join public.qorpera_runtime_office_screens s on s.id = c.screen_id
			join public.qorpera_runtime_offices o on o.id = s.office_id
			where c.id = p_view.shell_command_id and s.generation = p_view.screen_generation
				and exists (select 1 from public.qorpera_runtime_office_activations a
					where a.activation_id = p_view.activation_id and a.office_id = o.id and a.superseded_at is null)
				and exists (select 1 from public.qorpera_runtime_office_access x
					where x.office_id = o.id and x.staff_agent_id = p_view.staff_agent_id and x.state = 'active'))
		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs$new$);

-- It acts through the command's run while the run's job is leased.
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
	$old$		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,$old$,
	$new$		-- 20260930183000: a command acts through its run while the run's job is leased.
		when 'computer_shell_command' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,
				'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
			from public.qorpera_runtime_office_shell_commands c
			join public.qorpera_execution_runs r on r.id = c.run_id
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where c.id = p_view.shell_command_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp())
		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,$new$);

-- It resolves as its live run, else detached as the agent; company-wide, as a desktop.
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	v_view_json := jsonb_build_object('id', v_view.id, 'kind', v_view.kind, 'companyWide', v_view.kind = 'computer_desktop');$old$,
	$new$	-- 20260930183000: a command's view is company-wide, as a desktop's.
	v_view_json := jsonb_build_object('id', v_view.id, 'kind', v_view.kind,
		'companyWide', v_view.kind in ('computer_desktop','computer_shell_command'));$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	if v_view.kind = 'run_box' or (v_view.kind = 'computer_desktop' and v_run is not null) then$old$,
	$new$	if v_view.kind = 'run_box' or (v_view.kind in ('computer_desktop','computer_shell_command') and v_run is not null) then$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	-- Detached: a desktop whose run has ended, or a coding session. The agent and member must still stand.$old$,
	$new$	-- Detached: a desktop or a command (20260930183000) whose run has ended, or a coding session. The agent and member
	-- must still stand.$new$);

-- The open: the platform opens an offline command's view before the command runs.
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	v_node text; v_pass text; v_root public.qorpera_company_path_resources%rowtype; v_previous uuid;
$old$,
	$new$	v_node text; v_pass text; v_root public.qorpera_company_path_resources%rowtype; v_previous uuid;
	v_command public.qorpera_runtime_office_shell_commands%rowtype; -- 20260930183000
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_kind not in ('run_box','computer_desktop','coding_session') or jsonb_typeof(p_anchor) is distinct from 'object' then$old$,
	$new$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session') -- 20260930183000
		or jsonb_typeof(p_anchor) is distinct from 'object' then$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	else
		if coalesce(p_anchor ->> 'workerId', '')$old$,
	$new$	elsif p_kind = 'computer_shell_command' then
		-- 20260930183000 (C1b-3b): an offline command, before it runs: its row not ended, its run holding the screen in
		-- the screen's and the office's generation it started in, privacy shared, no view of it yet. The screen first,
		-- FOR SHARE (the command row takes no lock here: a folder path never locks both); then the checks, in new
		-- statements. The agent and the run's member read through it.
		if p_anchor - 'shellCommandId' <> '{}'::jsonb
			or coalesce(p_anchor ->> 'shellCommandId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'Folder view anchor is invalid' using errcode = '22023'; end if;
		perform 1 from public.qorpera_runtime_office_screens where id = (select c.screen_id
			from public.qorpera_runtime_office_shell_commands c where c.id = (p_anchor ->> 'shellCommandId')::uuid) for share;
		select * into v_command from public.qorpera_runtime_office_shell_commands where id = (p_anchor ->> 'shellCommandId')::uuid;
		select * into v_screen from public.qorpera_runtime_office_screens where id = v_command.screen_id;
		select * into v_office from public.qorpera_runtime_offices where id = v_screen.office_id;
		-- coalesce: a missing row must refuse, not compare to null.
		if not coalesce(v_office.environment_id = p_environment_id and not v_command.network and v_command.ended_at is null
				and not v_screen.drain_pending and v_screen.run_id = v_command.run_id
				and v_screen.staff_agent_id = v_command.staff_agent_id and v_screen.lease_expires_at > clock_timestamp()
				and v_office.privacy_state = 'shared' and v_screen.generation = v_command.screen_generation
				and v_office.generation = v_command.computer_generation, false)
			or exists (select 1 from public.qorpera_folder_views v where v.shell_command_id = v_command.id) then
			raise exception 'Folder view command is not current' using errcode = '42501'; end if;
		v_staff := v_command.staff_agent_id; v_member := v_command.requested_by_user_id;
		v_access := (public.qorpera_run_worker(v_command.run_id)).access;
		select a.activation_id, a.allocation_id into v_activation, v_machine from public.qorpera_runtime_office_activations a
		where a.office_id = v_office.id and a.superseded_at is null order by a.computer_generation desc limit 1;
		if v_activation is null or not exists (select 1 from public.qorpera_runtime_office_access x
			where x.office_id = v_office.id and x.staff_agent_id = v_staff and x.state = 'active') then
			raise exception 'Folder view computer is unavailable' using errcode = '42501'; end if;
	else
		if coalesce(p_anchor ->> 'workerId', '')$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_kind = 'computer_desktop' then
		select * into v_root$old$,
	$new$	if p_kind in ('computer_desktop','computer_shell_command') then -- 20260930183000
		select * into v_root$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	-- The machine's previous view, open or not (locked above)$old$,
	$new$	-- 20260930183000: a command's one view; nothing to carry or supersede. A second open that raced past the check
	-- above finds the view here.
	if p_kind = 'computer_shell_command' then
		insert into public.qorpera_folder_views(environment_id, profile_id, kind, staff_agent_id, member_user_id, worker_access,
			shell_command_id, screen_generation, activation_id, node_id, machine_id, pass_sha256, lease_until)
		values (p_environment_id, v_file.profile_id, p_kind, v_staff, v_member, v_access,
			v_command.id, v_command.screen_generation, v_activation, v_node, v_machine, extensions.digest(v_pass, 'sha256'),
			clock_timestamp() + interval '120 seconds')
		on conflict (shell_command_id) where shell_command_id is not null do nothing
		returning * into v_view;
		if not found then raise exception 'Folder view command is not current' using errcode = '42501'; end if;
		return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,'leaseUntil',v_view.lease_until);
	end if;
	-- The machine's previous view, open or not (locked above)$new$);

-- 3. The final publish ----------------------------------------------------------------------------------------------

select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_view public.qorpera_folder_views%rowtype; v_view_early jsonb; v_run_actor jsonb; v_view_agent boolean := false; v_turn_run uuid;
$old$,
	$new$	v_view public.qorpera_folder_views%rowtype; v_view_early jsonb; v_run_actor jsonb; v_view_agent boolean := false; v_turn_run uuid;
	v_final boolean := false; -- 20260930183000: a command view's last change set (C1B §8)
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if p_actor - array['kind','viewId','pass'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'viewId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or coalesce(p_actor ->> 'pass', '') !~ '^[A-Za-z0-9_-]{43}$' then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_scope := (p_actor ->> 'viewId')::uuid;
$old$,
	$new$		-- 20260930183000: a command view's last change set says "final" (C1B §8).
		if p_actor - array['kind','viewId','pass','final'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'viewId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or coalesce(p_actor ->> 'pass', '') !~ '^[A-Za-z0-9_-]{43}$'
			or (p_actor ? 'final' and jsonb_typeof(p_actor -> 'final') is distinct from 'boolean') then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_scope := (p_actor ->> 'viewId')::uuid;
		-- The view's own functions take the actor without it.
		v_final := coalesce((p_actor ->> 'final')::boolean, false);
		p_actor := p_actor - 'final'; v_bytes_actor := p_actor;
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if jsonb_typeof(p_units) is distinct from 'array' or jsonb_array_length(p_units) not between 1 and 1000 then
$old$,
	$new$	-- 20260930183000: a final may carry no change; it still closes its view.
	if jsonb_typeof(p_units) is distinct from 'array'
		or jsonb_array_length(p_units) not between (case when v_final then 0 else 1 end) and 1000 then
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		when v_actor_kind = 'view' then jsonb_build_object('kind','view','viewId',p_actor ->> 'viewId') else p_actor end;
$old$,
	$new$		-- 20260930183000: a final is another change set than the same units unmarked.
		when v_actor_kind = 'view' then jsonb_build_object('kind','view','viewId',p_actor ->> 'viewId')
			|| case when v_final then '{"final":true}'::jsonb else '{}'::jsonb end
		else p_actor end;
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		v_view_early := public.qorpera_folder_view_resolve(p_environment_id, v_file.profile_id, p_actor);
$old$,
	$new$		v_view_early := public.qorpera_folder_view_resolve(p_environment_id, v_file.profile_id, p_actor);
		if v_final and v_view_early -> 'view' ->> 'kind' is distinct from 'computer_shell_command' then -- 20260930183000
			raise exception 'Only a command view publishes a final change set' using errcode = '22023'; end if;
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$				public.qorpera_folder_run_reader(v_file.profile_id, v_view.holder_run_id));
		elsif v_turn_run is not null then$old$,
	$new$				public.qorpera_folder_run_reader(v_file.profile_id, v_view.holder_run_id));
		elsif v_view.kind = 'computer_shell_command' then
			-- 20260930183000: a detached command view: what its run read may be in the command's files.
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, (select command.run_id
					from public.qorpera_runtime_office_shell_commands command where command.id = v_view.shell_command_id)));
		elsif v_turn_run is not null then$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_saved = 0 and v_kept = 0 and jsonb_array_length(v_parked) = 0 then
$old$,
	$new$	-- 20260930183000: a final that saved nothing still closes its view, below.
	if v_saved = 0 and v_kept = 0 and jsonb_array_length(v_parked) = 0 and not v_final then
$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		elsif v_view.kind = 'coding_session' then
			perform 1 from public.qorpera_coding_sessions where worker_id = v_view.worker_id for share;
		end if;
		select * into v_view from public.qorpera_folder_views where id = v_view.id;
		if not public.qorpera_folder_view_valid(v_view) then
			raise exception 'Folder view has ended' using errcode = '42501'; end if;
	end if;$old$,
	$new$		elsif v_view.kind = 'coding_session' then
			perform 1 from public.qorpera_coding_sessions where worker_id = v_view.worker_id for share;
		elsif v_view.kind = 'computer_shell_command' then
			-- 20260930183000: the command row, which every end of the command (the report's, its sweeps', the
			-- platform's sleep and stop) waits for.
			perform 1 from public.qorpera_runtime_office_shell_commands where id = v_view.shell_command_id for share;
		end if;
		select * into v_view from public.qorpera_folder_views where id = v_view.id;
		if not public.qorpera_folder_view_valid(v_view) then
			raise exception 'Folder view has ended' using errcode = '42501'; end if;
		-- 20260930183000 (C1B §8): once its command has ended, a command view saves only its final change set.
		if v_view.kind = 'computer_shell_command' and not v_final and not exists (select 1
			from public.qorpera_runtime_office_shell_commands where id = v_view.shell_command_id and ended_at is null) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;
	end if;$new$);
select pg_temp.folder_view_shell_commands_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	-- 20260930042000 (P17): a commit that kept copies and saved nothing has passed the authority check; it takes no seq.
$old$,
	$new$	-- 20260930183000 (C1B §8): a command view's final closes it here, saved or not; a save that is not the final finds
	-- the view still open. Both see a close that committed before this commit took the clock.
	if v_view.kind = 'computer_shell_command' then
		if v_final then
			update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'closed'
			where id = v_view.id and state = 'open';
		else
			perform 1 from public.qorpera_folder_views where id = v_view.id and state = 'open';
		end if;
		if not found then raise exception 'Folder view has ended' using errcode = '42501'; end if;
	end if;
	-- 20260930042000 (P17): a commit that kept copies and saved nothing has passed the authority check; it takes no seq.
$new$);

-- The patched functions may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure,
		'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)'::regprocedure,
		'public.qorpera_take_agent_computer_stopped(public.qorpera_execution_runs)'::regprocedure,
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Shell command view function has an API owner'; end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select, insert on public.qorpera_runtime_office_shell_commands to %I', v_owner);
			execute format('grant select on public.qorpera_execution_runs, public.qorpera_runtime_offices, '
				'public.qorpera_runtime_office_screens to %I', v_owner);
			execute format('grant execute on function public.qorpera_office_shell_conversation_run(public.qorpera_execution_runs) '
				'to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_office_shell_command_starting('
				'public.qorpera_runtime_office_shell_commands, timestamptz) to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_runtime_office_shell_commands to %I', v_owner);
		end if;
	end loop;
	-- The commit takes the command row FOR SHARE and closes the view.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select, update on public.qorpera_runtime_office_shell_commands, '
				'public.qorpera_folder_views to %I', v_owner);
		end if;
	end loop;
end $$;

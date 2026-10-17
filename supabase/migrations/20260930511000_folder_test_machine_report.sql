-- The test machine's report: F3 step 6, slice 6e-2a (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md, "The report").
-- The executor's receipts for machine_run, machine_read and machine_cancel say whether the boot has /company, why output
-- is held back and which paths were not saved (it knows those itself). Two things only SQL keeps: why a machine lost a
-- command when the executor restarted it or moved it to a new disk, and why a notify continuation holds a command's output.
-- 1. Why a command was lost (folder_lost_reason), set before the command ends lost, and shown only when it did:
--    - moved_<cause>: the retirement (20260930424000) moves the machine to a new disk for its cause (unchecked, starter,
--      unreadable); its open commands get the cause before they end lost.
--    - restart_<why>: the executor restarts a boot whose folder can never be proven again (6d-2): its reads stay unproven,
--      or its own view was closed or is gone. It asks here first (qorpera_mark_company_machine_folder_restart, under its
--      custody, for the placement's current boot), and the boot's open commands get the cause; they end lost when SQL
--      takes the next boot. A boot SQL no longer runs, or a placement retired or removed, answers "stale". The executor
--      never waits for this to restart the guest: a command whose mark did not land ends lost without a cause.
--    An end the guest saw after the mark keeps its own state, and then the cause is not shown.
-- 2. The authority for a command (qorpera_authorize_machine_command) returns folderLost, the cause of a lost command,
--    for the executor's receipt, and on its refusal of a command that already ended (MACHINE_COMMAND_ENDED: its
--    placement is gone, as after a move, or a start was given up), for the agent. The executor reads the keys it knows,
--    so an older one ignores it.
-- 3. The notify continuation's command events (qorpera_folder_test_machine_event_report, over the hold of 20260930500000)
--    gain companyFolder: heldBack for a held command, lost for a command lost with a cause. The wake's own events are
--    unchanged: the runtime reads them closed.
-- The new functions are internal except the mark, which only the executor (service_role) calls. Body marker
-- "20260930511000".
set local lock_timeout = '3s';

do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_company_machine_commands'::regclass
		and attname = 'folder_lost_reason' and not attisdropped) then
		raise exception 'The test machine''s report (20260930511000) is already applied'; end if;
end $$;

create function pg_temp.folder_test_machine_report_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function); v_context text;
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	begin
		execute replace(v_definition, p_old, p_new);
	exception when others then
		-- A short message: the statement's own text would be the whole function.
		get stacked diagnostics v_context = pg_exception_context;
		raise exception '% does not compile after the patch: % (%)', p_function, sqlerrm, split_part(v_context, E'\n', 1);
	end;
end
$patch$;

-- 1. Why a command was lost -------------------------------------------------------------------------------------------

alter table public.qorpera_company_machine_commands add column folder_lost_reason text,
	add constraint qorpera_company_machine_commands_folder_lost_reason check (folder_lost_reason is null
		or folder_lost_reason in ('restart_unproven','restart_view_closed','restart_view_gone',
			'moved_unchecked','moved_starter','moved_unreadable'));

-- The cause in the agent's words; the executor and the runtime say the same (contracts' CLOUD_MACHINE_FOLDER_LOST).
create function public.qorpera_company_machine_folder_lost_text(p_reason text)
returns text language sql immutable security definer set search_path = '' as $$
	-- 20260930511000
	select case p_reason
		when 'restart_unproven' then
			'the executor restarted the machine because it could not prove what the machine read in /company'
		when 'restart_view_closed' then 'the executor restarted the machine because its /company view was closed'
		when 'restart_view_gone' then
			'the executor restarted the machine because the company folder service lost its /company view'
		when 'moved_unchecked' then
			'the machine moved to a new disk because a command ran on the old one before /company was checked'
		when 'moved_starter' then 'the machine moved to a new disk because the agent or member who started it no longer'
			|| ' reads the whole company folder'
		when 'moved_unreadable' then
			'the machine moved to a new disk because something it read in /company is no longer readable'
	end
$$;

-- The retirement: its open commands end lost for its cause.
select pg_temp.folder_test_machine_report_patch(
	'public.qorpera_retire_company_machine(uuid,text,text,text,uuid,text)'::regprocedure,
	$old$	-- Its programs stop with it; the runs that asked are told.
	perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
$old$,
	$new$	-- Its programs stop with it; the runs that asked are told. 20260930511000 (6e-2a): each with the cause.
	update public.qorpera_company_machine_commands set folder_lost_reason = 'moved_' || v_cause
	where machine_id = v_machine.id and ended_at is null;
	perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
$new$);

-- The executor's restart: the boot's open commands will end lost, for this cause.
create function public.qorpera_mark_company_machine_folder_restart(p_placement_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text, p_boot_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_marked integer;
begin
	-- 20260930511000
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_boot_id is null or p_reason is null or p_reason not in ('unproven','view_closed','view_gone') then
		raise exception 'Machine folder restart invalid' using errcode = '22023'; end if;
	if v_placement.removed_at is not null or v_placement.retired_at is not null
		or v_placement.boot_id is distinct from p_boot_id then
		return '{"state":"stale"}'::jsonb; end if;
	update public.qorpera_company_machine_commands set folder_lost_reason = 'restart_' || p_reason
	where placement_id = v_placement.id and ended_at is null;
	get diagnostics v_marked = row_count;
	return jsonb_build_object('state','marked','commands',v_marked);
end
$$;

revoke all on function public.qorpera_company_machine_folder_lost_text(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_mark_company_machine_folder_restart(uuid, text, text, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_mark_company_machine_folder_restart(uuid, text, text, text, uuid, text)
	to service_role;

-- 2. The authority -----------------------------------------------------------------------------------------------------

select pg_temp.folder_test_machine_report_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$		'instanceSha256',v_placement.instance_sha256,'bootId',v_placement.boot_id,'identity',v_identity);$old$,
	$new$		'instanceSha256',v_placement.instance_sha256,'bootId',v_placement.boot_id,'identity',v_identity,
		-- 20260930511000 (6e-2a): why the machine lost the command, for the executor's receipt.
		'folderLost',case when v_command.state = 'lost' then v_command.folder_lost_reason end);$new$);
-- A command that already ended is refused before the machine is asked (a command its machine lost when it moved to a new
-- disk is only ever refused): the refusal says why it was lost, for the agent.
select pg_temp.folder_test_machine_report_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$			'machine',v_machine.name,'commandState',v_command.state); end if;$old$,
	$new$			'machine',v_machine.name,'commandState',v_command.state,
			-- 20260930511000 (6e-2a)
			'folderLost',case when v_command.state = 'lost' then v_command.folder_lost_reason end); end if;$new$);

-- 3. The notify continuation -------------------------------------------------------------------------------------------

-- An event as the woken run is shown it (20260930500000), with why its output is held back or its command was lost.
create function public.qorpera_folder_test_machine_event_report(p_run_id uuid, p_wake_id uuid, p_environment_id uuid,
	p_event jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930511000
	select case
		when shown.e ->> 'kind' = 'command' and shown.e ->> 'commandState' = 'held' then shown.e
			|| jsonb_build_object('companyFolder', jsonb_build_object('heldBack', 'this run could not take in what the'
				|| ' machine read in /company: a read is no longer readable to it, or it does not read the whole company'
				|| ' folder'))
		when shown.e ->> 'kind' = 'command' and shown.e ->> 'commandState' = 'lost' and lost.reason is not null then shown.e
			|| jsonb_build_object('companyFolder', jsonb_build_object('lost',
				public.qorpera_company_machine_folder_lost_text(lost.reason)))
		else shown.e end
	from (select public.qorpera_folder_test_machine_event_hold(p_run_id, p_wake_id, p_environment_id, p_event) as e) shown
	left join lateral (select command.folder_lost_reason as reason from public.qorpera_company_machine_commands command
		where command.id = (shown.e ->> 'commandId')::uuid) lost on true
$$;
revoke all on function public.qorpera_folder_test_machine_event_report(uuid, uuid, uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Their owner (this migration's role) reaches what they read.
do $$ declare v_fn text; v_owner name; begin
	foreach v_fn in array array['public.qorpera_folder_test_machine_event_report(uuid,uuid,uuid,jsonb)',
		'public.qorpera_mark_company_machine_folder_restart(uuid,text,text,text,uuid,text)'] loop
		select pg_get_userbyid(proowner) into v_owner from pg_proc where oid = v_fn::regprocedure;
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '% has an API owner', v_fn; end if;
		if not has_function_privilege(v_owner, 'public.qorpera_folder_test_machine_event_hold(uuid,uuid,uuid,jsonb)', 'execute')
			or not has_function_privilege(v_owner, 'public.qorpera_company_machine_folder_lost_text(text)', 'execute')
			or not has_function_privilege(v_owner, 'public.qorpera_company_machine_custody(uuid,text,text,text)', 'execute')
			or not has_table_privilege(v_owner, 'public.qorpera_company_machine_commands', 'select')
			or not has_table_privilege(v_owner, 'public.qorpera_company_machine_commands', 'update') then
			raise exception '% owner cannot reach what it reads', v_fn; end if;
	end loop;
end $$;

select pg_temp.folder_test_machine_report_patch(
	'public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)'::regprocedure,
	$old$		-- 20260930500000 (6d-3c): a command whose machine's reads this run has not taken in shows as held.
		'events',(select coalesce(jsonb_agg(public.qorpera_folder_test_machine_event_hold(p_run.id, v_wake.id,
			p_run.environment_id, public.qorpera_machine_event_view(event, 4000)) order by event.created_at, event.id),'[]')
$old$,
	$new$		-- 20260930500000 (6d-3c): a command whose machine's reads this run has not taken in shows as held.
		-- 20260930511000 (6e-2a): with why, and a command lost with a cause says it.
		'events',(select coalesce(jsonb_agg(public.qorpera_folder_test_machine_event_report(p_run.id, v_wake.id,
			p_run.environment_id, public.qorpera_machine_event_view(event, 4000)) order by event.created_at, event.id),'[]')
$new$);

-- The patched functions may have private owners in production: they reach the new ones.
do $$ declare v_caller text; v_fn text; v_owner name; begin
	for v_caller, v_fn in select pair.caller, pair.fn from (values
		('public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)',
			'public.qorpera_folder_test_machine_event_report(uuid,uuid,uuid,jsonb)')) pair(caller, fn) loop
		select pg_get_userbyid(proowner) into v_owner from pg_proc where oid = v_caller::regprocedure;
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '% has an API owner', v_caller; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function %s to %I', v_fn, v_owner); end if;
		if not has_function_privilege(v_owner, v_fn, 'execute') then
			raise exception '% owner cannot reach %', v_caller, v_fn; end if;
	end loop;
	-- The retirement updates the commands as it ended them.
	select pg_get_userbyid(proowner) into v_owner from pg_proc
	where oid = 'public.qorpera_retire_company_machine(uuid,text,text,text,uuid,text)'::regprocedure;
	if not has_table_privilege(v_owner, 'public.qorpera_company_machine_commands', 'update') then
		raise exception 'The retirement''s owner cannot update the commands'; end if;
end $$;

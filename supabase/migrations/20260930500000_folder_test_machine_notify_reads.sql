-- A notify continuation takes in a test machine's reads: F3 step 6, slice 6d-3c (deploy/first-node/
-- RUNTIME-FOLDER-TEST-MACHINES.md, "Reads", rule 3). A command on a test machine can print what any command on the
-- machine read in the company folder. A command with notify set wakes its run when it ends (the machine events drain,
-- qorpera_folder_machine_events_company), and that continuation shows how the command ended and its output: in the
-- wake's payload (the last 600 bytes) and in the continuation (all 4000 kept). Before either shows them, the woken run
-- now takes in the reads of the machine's view (qorpera_folder_run_inherit_view_reads, C1b-3 §6), as a read of output
-- through the executor does (20260930498000).
-- - Where: when the run reads its wake (qorpera_folder_read_wake) and when it describes its context
--   (qorpera_describe_company_run_context, after its context check; see Locks). Paging the continuation takes in
--   nothing: it shows the events as the run has taken them in by then.
-- - Which view: for each command event of the wake, the newest test_machine view of the command's placement. The newest
--   holds every read the disk was served (20260930498000). A placement that had no view by the command's end had no
--   folder to read: its events show as stored, and nothing is taken in.
-- - The inherit id comes from the wake and the view (qorpera_folder_test_machine_notify_inherit_id), so a second read or
--   describe replays. It is not the wake's id, which files the parent's reads (the parent copy).
-- - Shown or held: a command event shows as stored only when its placement had no view by the command's end, or this run
--   took in one of the placement's views under that id (qorpera_folder_test_machine_event_shown). Otherwise it shows
--   commandState "held", with exitCode and outputTail null. That is so when the take-in was refused because a read is no
--   longer readable to the run ("A released read is no longer readable", "A read is no longer readable") or the run lacks
--   the company-wide view (20260930480000): those refusals are undone and the output is held back. Any other refusal
--   raises. A take-in is never undone and a replay checks nothing again, so an event once shown stays shown.
-- - The stored wake is unchanged: the hold is applied each time the envelope or the continuation is built.
-- - Earlier history: the continuation's "earlier" shows a parent's events as that parent was shown them. This run gets
--   the parent's reads when it reads its wake (the parent copy), as it does for the parent's receipts.
-- - Neither path retires the placement: the executor does that (rule 5) when one of its own take-ins is refused.
-- - Locks: the take-in writes the run's read set (rank 10) and its inheritance row, as the executor's take-in does, so it
--   runs only under the run mutex and the run check's locks (ranks 0 to 7). The wake read always holds them. The context
--   describe reads plain as the runtime's entry point (20260930499000), and a plain read never writes: it now takes the
--   locked path, as any other caller does, when the binding's run has a command event still to take in
--   (qorpera_folder_test_machine_notify_pending), and takes in only on the locked path. The runtime asks for the describe
--   and the wake together; on that one run start they wait for each other on the mutex, and the second replays the
--   first's take-in, so both show a command the same way. The test reads the binding's run id before any lock and before
--   the run check, so a forged binding can only send the describe down the locked path, which refuses it as before. Once
--   the run has taken its events in, its describe reads plain again.
-- The new functions are internal: no API role can call them. Body marker "20260930500000".
set local lock_timeout = '3s';

do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_folder_read_wake(jsonb)'::regprocedure), '20260930500000') > 0 then
		raise exception 'The notify continuation''s take-in (20260930500000) is already applied'; end if;
end $$;

-- 1. Shown or held ---------------------------------------------------------------------------------------------------

-- One take-in per wake and view.
create function public.qorpera_folder_test_machine_notify_inherit_id(p_wake_id uuid, p_view_id uuid)
returns uuid language sql immutable security definer set search_path = '' as $$
	-- 20260930500000
	select md5('test-machine-notify:' || p_wake_id::text || ':' || p_view_id::text)::uuid
$$;

-- A command's end and output show to the run its wake woke when its placement had no view by the command's end, or that
-- run took in one of the placement's views for the wake. A command that is not found is held.
create function public.qorpera_folder_test_machine_event_shown(p_run_id uuid, p_wake_id uuid, p_environment_id uuid,
	p_command_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930500000
	select exists (select 1 from public.qorpera_company_machine_commands command where command.id = p_command_id
		and (not exists (select 1 from public.qorpera_folder_views v where v.kind = 'test_machine'
				and v.placement_id = command.placement_id and v.environment_id = p_environment_id
				and v.created_at <= coalesce(command.ended_at, 'infinity'))
			or exists (select 1 from public.qorpera_folder_views v
				join public.qorpera_folder_run_inheritances i on i.run_id = p_run_id and i.view_id = v.id
					and i.inherit_id = public.qorpera_folder_test_machine_notify_inherit_id(p_wake_id, v.id)
				where v.kind = 'test_machine' and v.placement_id = command.placement_id
					and v.environment_id = p_environment_id)))
$$;

-- An event as the woken run is shown it: a command event that is not shown is held.
create function public.qorpera_folder_test_machine_event_hold(p_run_id uuid, p_wake_id uuid, p_environment_id uuid,
	p_event jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930500000
	select case when p_event ->> 'kind' = 'command' and not public.qorpera_folder_test_machine_event_shown(p_run_id,
			p_wake_id, p_environment_id, (p_event ->> 'commandId')::uuid)
		then p_event || jsonb_build_object('commandState', 'held', 'exitCode', null, 'outputTail', null)
		else p_event end
$$;

-- 2. The take-in -----------------------------------------------------------------------------------------------------

-- For each command event of the run's machine-event wake that is not shown yet, the newest view of its placement.
create function public.qorpera_folder_test_machine_notify_take_in(p_run public.qorpera_execution_runs, p_actor jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wake uuid; v_command record; v_view uuid;
begin
	-- 20260930500000
	select id into v_wake from public.qorpera_wake_occurrences where run_id = p_run.id and source_kind = 'machine-event';
	if v_wake is null then return; end if;
	for v_command in select command.id, command.placement_id from public.qorpera_company_machine_events event
		join public.qorpera_company_machine_commands command on command.id = event.command_id
		where event.occurrence_id = v_wake and event.kind = 'command' order by event.created_at, event.id loop
		if public.qorpera_folder_test_machine_event_shown(p_run.id, v_wake, p_run.environment_id, v_command.id) then
			continue; end if;
		select v.id into v_view from public.qorpera_folder_views v
		where v.kind = 'test_machine' and v.placement_id = v_command.placement_id and v.environment_id = p_run.environment_id
		order by v.created_at desc, v.id desc limit 1;
		begin
			perform public.qorpera_folder_run_inherit_view_reads(p_run.environment_id, p_actor, v_view,
				public.qorpera_folder_test_machine_notify_inherit_id(v_wake, v_view));
		exception when insufficient_privilege then
			-- Held back: the event stays held.
			if sqlerrm not in ('A released read is no longer readable', 'A read is no longer readable',
				'A run inherits a test machine''s reads only with the company-wide view') then raise; end if;
		end;
	end loop;
end $$;

-- Whether the binding's run has a command event its wake has not shown yet: the take-in has work, or was refused. Plain
-- reads; a binding without a run id has none.
create function public.qorpera_folder_test_machine_notify_pending(p_binding jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_run uuid;
begin
	-- 20260930500000
	if coalesce(p_binding ->> 'runId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		return false; end if;
	v_run := (p_binding ->> 'runId')::uuid;
	return exists (select 1 from public.qorpera_execution_runs run
		join public.qorpera_wake_occurrences wake on wake.run_id = run.id and wake.source_kind = 'machine-event'
		join public.qorpera_company_machine_events event on event.occurrence_id = wake.id and event.kind = 'command'
		where run.id = v_run
			and not public.qorpera_folder_test_machine_event_shown(run.id, wake.id, run.environment_id, event.command_id));
end $$;

revoke all on function public.qorpera_folder_test_machine_notify_inherit_id(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_test_machine_event_shown(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_test_machine_event_hold(uuid, uuid, uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_test_machine_notify_take_in(public.qorpera_execution_runs, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_test_machine_notify_pending(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Their owner (this migration's role) reaches what they read and the take-in, which may have a private owner.
do $$ declare v_fn text; v_owner name; begin
	foreach v_fn in array array['public.qorpera_folder_test_machine_notify_inherit_id(uuid,uuid)',
		'public.qorpera_folder_test_machine_event_shown(uuid,uuid,uuid,uuid)',
		'public.qorpera_folder_test_machine_event_hold(uuid,uuid,uuid,jsonb)',
		'public.qorpera_folder_test_machine_notify_take_in(public.qorpera_execution_runs,jsonb)',
		'public.qorpera_folder_test_machine_notify_pending(jsonb)'] loop
		select pg_get_userbyid(proowner) into v_owner from pg_proc where oid = v_fn::regprocedure;
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '% has an API owner', v_fn; end if;
		if not has_function_privilege(v_owner, 'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)', 'execute')
			or exists (select 1 from unnest(array['public.qorpera_execution_runs', 'public.qorpera_wake_occurrences',
				'public.qorpera_company_machine_events',
				'public.qorpera_company_machine_commands', 'public.qorpera_folder_views',
				'public.qorpera_folder_run_inheritances']) t(name)
				where not has_table_privilege(v_owner, t.name, 'select')) then
			raise exception '% owner cannot reach the take-in', v_fn; end if;
	end loop;
end $$;

-- 3. The wake, the describe and the continuation ---------------------------------------------------------------------

-- The patches edit the definition's text in order; each function is replaced once, after its last one.
create temporary table folder_notify_reads_defs (fn regprocedure not null, def text not null);
create function pg_temp.folder_notify_reads_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text;
begin
	select def into v_definition from pg_temp.folder_notify_reads_defs where fn = p_function;
	if v_definition is null then
		v_definition := pg_get_functiondef(p_function);
		insert into pg_temp.folder_notify_reads_defs(fn, def) values (p_function, v_definition);
	end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	update pg_temp.folder_notify_reads_defs set def = replace(v_definition, p_old, p_new) where fn = p_function;
end
$patch$;
create function pg_temp.folder_notify_reads_apply() returns void language plpgsql as $apply$
declare v_fn regprocedure; v_def text; v_context text;
begin
	for v_fn, v_def in select fn, def from pg_temp.folder_notify_reads_defs loop
		begin
			execute v_def;
		exception when others then
			-- A short message: the statement's own text would be the whole function.
			get stacked diagnostics v_context = pg_exception_context;
			raise exception '% does not compile after the patches: % (%)', v_fn, sqlerrm, split_part(v_context, E'\n', 1);
		end;
	end loop;
	drop table pg_temp.folder_notify_reads_defs;
end
$apply$;

-- The wake: take in, then build the envelope from the events as this run is shown them.
select pg_temp.folder_notify_reads_patch('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
$old$,
	$new$	-- 20260930500000 (6d-3c): a run a test machine's command woke takes in the machine's reads before the wake shows
	-- how the command ended; a command whose reads it could not take in shows as held. The stored wake is unchanged.
	if v_wake.source_kind = 'machine-event' then
		perform public.qorpera_folder_test_machine_notify_take_in(v_run, v_tool -> 'actor');
		if jsonb_typeof(v_wake.payload -> 'events') = 'array' then
			v_wake.payload := jsonb_set(v_wake.payload, '{events}', (select coalesce(jsonb_agg(
				public.qorpera_folder_test_machine_event_hold(v_run.id, v_wake.id, v_run.environment_id, x.e) order by x.n),
				'[]'::jsonb) from jsonb_array_elements(v_wake.payload -> 'events') with ordinality x(e, n)));
		end if;
	end if;
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
$new$);

-- The describe: the locked path while a command event waits, and the take-in on it before the continuation is built.
select pg_temp.folder_notify_reads_patch('public.qorpera_describe_company_run_context(jsonb)'::regprocedure,
	$old$	if v_plain then
		v_run := public.qorpera_folder_native_run_plain(p_binding);
$old$,
	$new$	-- 20260930500000 (6d-3c): a run whose wake still has a test machine's command end to take in takes the locked path:
	-- the take-in below writes the run's read set, and a writer keeps the run mutex.
	if v_plain and public.qorpera_folder_test_machine_notify_pending(p_binding) then v_plain := false; end if;
	if v_plain then
		v_run := public.qorpera_folder_native_run_plain(p_binding);
$new$);
select pg_temp.folder_notify_reads_patch('public.qorpera_describe_company_run_context(jsonb)'::regprocedure,
	$old$	if not v_plain then
		perform public.qorpera_company_path_assert_context(v_actor);
$old$,
	$new$	if not v_plain then
		perform public.qorpera_company_path_assert_context(v_actor);
		-- 20260930500000 (6d-3c): a run a test machine's command woke takes in the machine's reads before its
		-- continuation shows how the command ended (a plain read had nothing to take in).
		perform public.qorpera_folder_test_machine_notify_take_in(v_run, v_actor -> 'folder' -> 'actor');
$new$);

-- The continuation: its events as this run is shown them; its "earlier" shows a parent's as the parent was shown them.
select pg_temp.folder_notify_reads_patch(
	'public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)'::regprocedure,
	$old$		'events',(select coalesce(jsonb_agg(public.qorpera_machine_event_view(event, 4000) order by event.created_at, event.id),'[]')
$old$,
	$new$		-- 20260930500000 (6d-3c): a command whose machine's reads this run has not taken in shows as held.
		'events',(select coalesce(jsonb_agg(public.qorpera_folder_test_machine_event_hold(p_run.id, v_wake.id,
			p_run.environment_id, public.qorpera_machine_event_view(event, 4000)) order by event.created_at, event.id),'[]')
$new$);
select pg_temp.folder_notify_reads_apply();

-- The patched functions may have private owners in production: they reach the new ones.
do $$ declare v_caller text; v_fn text; v_owner name; begin
	for v_caller, v_fn in select pair.caller, pair.fn from (values
		('public.qorpera_folder_read_wake(jsonb)', 'public.qorpera_folder_test_machine_notify_take_in(public.qorpera_execution_runs,jsonb)'),
		('public.qorpera_folder_read_wake(jsonb)', 'public.qorpera_folder_test_machine_event_hold(uuid,uuid,uuid,jsonb)'),
		('public.qorpera_describe_company_run_context(jsonb)',
			'public.qorpera_folder_test_machine_notify_take_in(public.qorpera_execution_runs,jsonb)'),
		('public.qorpera_describe_company_run_context(jsonb)', 'public.qorpera_folder_test_machine_notify_pending(jsonb)'),
		('public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)',
			'public.qorpera_folder_test_machine_event_hold(uuid,uuid,uuid,jsonb)')) pair(caller, fn) loop
		select pg_get_userbyid(proowner) into v_owner from pg_proc where oid = v_caller::regprocedure;
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '% has an API owner', v_caller; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function %s to %I', v_fn, v_owner); end if;
		if not has_function_privilege(v_owner, v_fn, 'execute') then
			raise exception '% owner cannot reach %', v_caller, v_fn; end if;
	end loop;
end $$;

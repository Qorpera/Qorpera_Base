-- @fixture 830_runtime_run_no_progress_notice.test.sql until "-- A. A run that just started is working"
-- Gap 4's fix (migration 20260930051000): a tool call in flight is waited on with the records the runtime really writes.
-- Each tool call records its start, then its context authority's start and finish (and an acting call's action review)
-- before it runs, so the newest record was never the tool's start and a tool running past 15 minutes was told as a stall.
-- Now: a tool call's start with no finish of its attempt and no model call after it. 830's run, aged 30 minutes, so only
-- observations are progress.

select pg_temp.age(30);
-- The old rule (20260928459150), to show what the runtime's sequence made it answer.
create function pg_temp.old_waiting() returns boolean language sql as $$
	select coalesce((select recent.phase = 'start' and recent.operation not in ('model_turn', 'model_request',
			'native_result_fence', 'company_context', 'run_authority', 'context_authority', 'diagnostic_export',
			'action_review')
		from (select observation.id, observation.phase, observation.operation
			from public.qorpera_runtime_observations as observation
			where observation.run_id = pg_temp.run() order by observation.id desc limit 400) as recent
		where recent.operation <> 'message_composition' order by recent.id desc limit 1), false)
$$;
create function pg_temp.waiting() returns boolean language sql as $$
	select public.qorpera_run_waiting_on_tool(pg_temp.run())
$$;
-- One tool call's opening, as cloud-native-tool-boundary.ts records it p_minutes ago: its start, its context authority's
-- start and finish, and for an acting call its action review's.
create function pg_temp.tool_opens(p_tool text, p_minutes integer, p_review boolean default false) returns void language plpgsql as $$
begin
	perform pg_temp.observe(p_tool, 'start', p_minutes);
	perform pg_temp.observe('context_authority', 'start', p_minutes);
	perform pg_temp.observe('context_authority', 'finish', p_minutes);
	if p_review then
		perform pg_temp.observe('action_review', 'start', p_minutes);
		perform pg_temp.observe('action_review', 'finish', p_minutes);
	end if;
end $$;

-- A. A 20-minute command: waiting, no stall named and nobody told. The old rule read the context authority's finish
-- and called it a stall. With an action review too, the same.
do $$
begin
	perform pg_temp.tool_opens('machine_run', 20);
	if pg_temp.old_waiting() then raise exception 'A: the old rule must miss the runtime''s sequence (the test''s premise)'; end if;
	if not pg_temp.waiting() or pg_temp.bob() ? 'no_progress_since' or pg_temp.sweep() ->> 'opened' <> '0' then
		raise exception 'A: a tool call in flight is waited on: % %', pg_temp.waiting(), pg_temp.bob(); end if;
	perform pg_temp.forget(true);
	perform pg_temp.tool_opens('send_mail', 20, true);
	if not pg_temp.waiting() or pg_temp.bob() ? 'no_progress_since' then
		raise exception 'A: an acting call after its review is waited on: %', pg_temp.bob(); end if;
	-- "Writing" pulses after it change nothing.
	perform pg_temp.observe('message_composition', 'start', 0);
	perform pg_temp.observe('message_composition', 'finish', 0);
	if not pg_temp.waiting() then raise exception 'A: pulses do not end the wait'; end if;
end $$;

-- B. Once the call finished (17 minutes ago), the stall runs from its finish.
do $$
begin
	perform pg_temp.observe('send_mail', 'finish', 17);
	if pg_temp.waiting() or (pg_temp.bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
			from public.qorpera_runtime_observations where run_id = pg_temp.run() and operation <> 'message_composition') then
		raise exception 'B: a finished call is the last progress: %', pg_temp.bob(); end if;
end $$;

-- C. Parallel calls: while any of them runs, the run waits; once all finished, it does not.
do $$
begin
	perform pg_temp.forget(true);
	perform pg_temp.tool_opens('machine_run', 25);
	perform pg_temp.tool_opens('company_read', 25);
	perform pg_temp.observe('company_read', 'finish', 24);
	if pg_temp.old_waiting() or not pg_temp.waiting() then
		raise exception 'C: one call of two still runs: old %, new %', pg_temp.old_waiting(), pg_temp.waiting(); end if;
	perform pg_temp.observe('machine_run', 'finish', 20);
	if pg_temp.waiting() then raise exception 'C: both calls finished'; end if;
end $$;

-- D. A start whose finish was lost counts until the model's next call: then the run is a run again, and its stall runs
-- from that call.
do $$
begin
	perform pg_temp.forget(true);
	perform pg_temp.tool_opens('machine_run', 40);
	perform pg_temp.observe('model_request', 'start', 20);
	perform pg_temp.observe('model_request', 'finish', 20);
	if pg_temp.waiting() or not pg_temp.bob() ? 'no_progress_since' then
		raise exception 'D: a model call after a lost finish ends the wait: %', pg_temp.bob(); end if;
	-- The runtime's own checks and a model request in flight are no tool calls.
	perform pg_temp.forget(true);
	perform pg_temp.observe('run_authority', 'start', 20);
	perform pg_temp.observe('company_context', 'start', 20);
	perform pg_temp.observe('native_result_fence', 'start', 20);
	perform pg_temp.observe('model_request', 'start', 20);
	if pg_temp.waiting() then raise exception 'D: only tool calls are waited on'; end if;
end $$;

-- E. The marker, and the function stays service-only.
do $$
begin
	if position('20260930051000' in pg_get_functiondef('public.qorpera_run_waiting_on_tool(uuid)'::regprocedure)) = 0 then
		raise exception 'E: the body lacks its marker'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_run_waiting_on_tool(uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_run_waiting_on_tool(uuid)', 'execute') then
		raise exception 'E: the function is not for members'; end if;
end $$;

rollback;

-- Session-buildup audit gap 4, a fix (found in the review of #792): a tool call in flight is waited on, not reported as
-- a stall.
--
-- qorpera_run_waiting_on_tool (20260928459150) asked whether the run's newest observation, "writing" pulses aside, was a
-- tool call's start. It never was: every tool call records its context authority's start and finish right after its own
-- start (cloud-native-tool-boundary.ts, cloud-native-run-tool-session.ts), and an acting call its action review too. So
-- a tool running past the stall minutes (15) got the "no progress" notice.
-- * A run waits on a tool when, among its newest 400 observations, a tool call started (any operation but a model call,
--   a "writing" pulse or one of the runtime's own checks), that attempt has no finish, and no model call came after it.
--   Parallel tool calls count while any of them runs; a start whose finish was lost counts only until the model's next
--   request.
-- No lock; the function stays stable, security definer and service-only. The body carries the marker 20260930051000.

create or replace function public.qorpera_run_waiting_on_tool(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	-- Gap 4 (20260930002600); 20260930051000: a tool call in flight among the run's newest 400 observations: its start,
	-- with no finish of the same attempt and no model call after it. Model calls, "writing" pulses and the runtime's own
	-- checks (each tool call's context authority, an action review, the result fence) are not tool calls.
	with recent as (
		select observation.id, observation.attempt_id, observation.phase, observation.operation
		from public.qorpera_runtime_observations as observation
		where observation.run_id = p_run_id order by observation.id desc limit 400)
	select exists (select 1 from recent as tool
		where tool.phase = 'start'
			and tool.operation not in ('model_turn', 'model_request', 'message_composition', 'native_result_fence',
				'company_context', 'run_authority', 'context_authority', 'diagnostic_export', 'action_review')
			and not exists (select 1 from recent as done where done.attempt_id = tool.attempt_id and done.phase = 'finish')
			and not exists (select 1 from recent as model where model.id > tool.id
				and model.operation in ('model_turn', 'model_request')))
$$;

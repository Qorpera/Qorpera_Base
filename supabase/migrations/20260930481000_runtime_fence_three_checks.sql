-- The one call before each model request makes three calls, not seven (production DB slowness, 16 October 2026).
--
-- qorpera_fence_native_context (20260928339400) made the host's old seven calls in one transaction: describe and the
-- read-set check, both again, the view, then both a third time. On folder-v2 each of the seven makes the run check,
-- qorpera_folder_tool_run, which first takes the run's budget row FOR UPDATE: the run mutex every tool call of the run
-- takes first. Four of them (the three read-set checks and the view) also re-check the run's released reads,
-- qorpera_folder_run_reads_current (20260928279560). So every fence held the run mutex for seven run checks and four
-- read re-checks, on the long budget (25 s, 20260928509130). In production on 16 October the run's other calls waited
-- behind it on the budget row for seconds, and the run's own retries queued up behind them.
--
-- The fence now makes three:
--   1. qorpera_record_native_context_view. On folder-v2 it makes the run check and re-checks the run's released reads
--      itself (qorpera_folder_record_context_view) before it records. Those are the checks the first two rounds made, so
--      its run check is the first statement that locks, and it takes the run mutex and then the job, the order every
--      agent tool call uses (test 838), as describe did.
--   2. qorpera_describe_native_tool_authority, the check after recording; its authority is still what the host keeps,
--      read after the view, as before.
--   3. qorpera_assert_company_path_reads, the read-set check after recording.
-- Steps 2 and 3 are the old fourth round, unchanged. 20260928339400 kept the repeats because, under READ COMMITTED, the
-- checks after recording still see a revocation that committed while the view was being recorded; that round is the
-- one that does, and it stays. What goes is only the first two rounds, whose checks the view's own checks repeat in
-- the next statement. A refusal still records nothing: a check that fails after the view fails the whole call, and the
-- view rolls back with it. A refusal can now come from a different check than before only when a call fails more than
-- one: a null read set is refused by step 3 rather than before the view, and an expired authority (describe's own check)
-- by step 2.
--
-- The fence serves folder-v2 only (the founder's decision of 3 October). The legacy view relied on the read-set check
-- remembering the sent paths before it recorded, so a legacy environment is refused before any check.
--
-- create or replace keeps the grants (service_role only) and the native host call list's long budget; it sets every
-- setting again, so the fence's statement_timeout of 25 s (20260928509130) is set here too.
set local lock_timeout = '3s';

create or replace function public.qorpera_fence_native_context(
	p_environment_id uuid, p_binding jsonb, p_paths text[], p_view jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '25s'
as $$
declare
	v_receipt jsonb;
	v_authority jsonb;
	v_kept jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Context fence requires cloud authority' using errcode = '42501';
	end if;
	if not public.qorpera_environment_is_folder_v2(p_environment_id) then
		raise exception 'The context fence serves folder-v2 companies only' using errcode = '0A000';
	end if;
	-- 1. The view of what is released. It makes the run check and re-checks the run's released reads itself first.
	v_receipt := public.qorpera_record_native_context_view(p_environment_id, p_binding, p_view);
	-- 2. The check after recording; its authority is what the host keeps.
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	-- The sent paths the run's read set holds under exactly that name; the host stops sending only these.
	select coalesce(jsonb_agg(sent.path order by sent.ordinal), '[]'::jsonb) into v_kept
	from unnest(p_paths) with ordinality as sent(path, ordinal)
	where exists (select 1 from public.qorpera_company_run_read_paths kept
		where kept.run_id = (p_binding ->> 'runId')::uuid and kept.path = sent.path collate "C");
	return jsonb_build_object('schema', 'qorpera.native-context-fence/v1', 'authority', v_authority,
		'receipt', v_receipt, 'kept', v_kept);
end
$$;
comment on function public.qorpera_fence_native_context(uuid, jsonb, text[], jsonb) is
	'The check before each model request, in one transaction: record the view (it checks the run and its released reads first), then the authority and read set again. Returns the view receipt, the authority read after it, and the sent paths the run read set holds under exactly that name.';

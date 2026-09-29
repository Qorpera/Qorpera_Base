-- One database call before every model request (stack audit 2026-09-29, fix 9; contract amendment
-- "2026-09-29 amendment: one call before a model request", pending approval).
--
-- Before a model request the runtime host made seven calls in four rounds, each its own transaction:
--   1. the result fence's check: qorpera_describe_native_tool_authority and
--      qorpera_assert_company_path_reads, sent together;
--   2. the check before recording: the same two calls again;
--   3. qorpera_record_native_context_view;
--   4. the check after recording: the same two calls a third time.
-- qorpera_fence_native_context makes exactly those seven calls, in that order, in one transaction,
-- and returns the view's receipt and the run's authority as the last describe read it. It calls
-- the functions themselves, so whatever they check, lock or refuse is what this checks, locks and
-- refuses: nothing is copied and nothing is skipped.
--
-- The repeated checks are kept, not proved redundant. Under READ COMMITTED every statement in this
-- transaction reads what other transactions committed before that statement began, so the checks
-- after recording still see a revocation that committed while the view was being recorded; then
-- the whole call fails and the view is rolled back, and nothing is released to the model (the host
-- releases only after this call returns). The locks the first check takes (the run's job row, then
-- the company's profile fence and Company File row, and the authority rows FOR SHARE, the order
-- every agent tool call uses) are held to the end, so the call can wait but never deadlocks with a
-- tool call.
--
-- The read set is incremental on the host side only. qorpera_assert_company_path_reads remembers
-- every path it is sent in the run's durable read set (qorpera_company_run_read_paths, never pruned
-- during a run) and then re-checks that whole set with qorpera_company_path_assert_context. The
-- host now sends each path until one check that included it succeeded, instead of its whole list
-- every time. The set the database checks is the same as before: it holds every path any earlier
-- successful check was sent, and every path the model read through qorpera_read_company_path_v2 or
-- listed through qorpera_list_company_paths_v2 (those remember it themselves). Omitting a path
-- cannot drop it from the check.
set local lock_timeout = '3s';

create or replace function public.qorpera_fence_native_context(
	p_environment_id uuid, p_binding jsonb, p_paths text[], p_view jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_receipt jsonb;
	v_authority jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Context fence requires cloud authority' using errcode = '42501';
	end if;
	-- 1. The result fence's check before it prepares the results.
	perform public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	-- 2. The check before recording.
	perform public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	-- 3. The view of what is released (it checks the run's actor and whole read set itself).
	v_receipt := public.qorpera_record_native_context_view(p_environment_id, p_binding, p_view);
	-- 4. The check after recording; its authority is what the host keeps.
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, p_paths);
	return jsonb_build_object('schema', 'qorpera.native-context-fence/v1', 'authority', v_authority,
		'receipt', v_receipt);
end
$$;
revoke all on function public.qorpera_fence_native_context(uuid, jsonb, text[], jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_fence_native_context(uuid, jsonb, text[], jsonb) to service_role;
comment on function public.qorpera_fence_native_context(uuid, jsonb, text[], jsonb) is
	'The seven calls a runtime host made before each model request, in their order, in one transaction: authority and read set, again, record the view, again. Returns the view receipt and the last authority read.';

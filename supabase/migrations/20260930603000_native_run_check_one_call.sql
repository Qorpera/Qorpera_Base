-- 20260930603000: the run's check around each tool call, in one database call (perf sprint A3, 7 Nov 2026).
--
-- The native host checks a run's authority three times for a read and four or more for a change: before the call,
-- again before its effect, and before its result goes back. Each check is two round trips, one after the other (R1, 28
-- Oct 2026): qorpera_describe_native_tool_authority, then qorpera_assert_company_path_reads. On the 126 runs of 5-6 Nov
-- that was 14,554 checks, 48 ms each at p50 (686 s), of which the database's part is about 6 ms a call; the rest is the
-- path to the database, once for each call.
--
-- qorpera_check_native_run makes the same two calls, in the same order, in one call of the native host. Nothing is
-- skipped or remembered: both checks run on every check, and under READ COMMITTED each sees what committed before it
-- starts. A refusal from either is the call's refusal. The two are still never in flight at once (R1): they are two
-- statements of one transaction. The read-set check takes the run's budget row with its own lock_timeout of 3 s
-- (20260930540000), which it keeps here; describe reads plain (20260930487000), so nothing holds the row any longer than
-- the read-set check did. The qorpera_fence_native_context call before a model request has done the same since 20260928339400.
--
-- Rollout: record this migration before the runtime that calls it. A runtime on a database without it falls back to
-- the two separate calls (CloudCompanyPathGateway.checkRun), and a database without such a runtime changes nothing.
set local lock_timeout = '3s';

create function public.qorpera_check_native_run(p_environment_id uuid, p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930603000
declare v_authority jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Run check requires cloud authority' using errcode = '42501'; end if;
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, array[]::text[]);
	return v_authority;
end
$$;
revoke all on function public.qorpera_check_native_run(uuid, jsonb) from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_check_native_run(uuid, jsonb) to service_role;
comment on function public.qorpera_check_native_run(uuid, jsonb) is
	'The run''s check around a tool call, in one call: the authority, then the read set. Returns the authority. 20260930603000.';

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_check_native_run', 'binding');

-- The company fence's mode goes by the transaction's entry point (20260928339380): this one reads as its two calls did.
create or replace function public.qorpera_company_fence_shared()
returns boolean
language sql
stable
set search_path = ''
as $$
	select coalesce(substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$') = any (array[
		'qorpera_describe_native_tool_authority',
		'qorpera_assert_company_path_reads',
		'qorpera_check_native_run',
		'qorpera_record_native_context_view',
		'qorpera_read_company_path_v2',
		'qorpera_list_company_paths_v2',
		'qorpera_read_company_path',
		'qorpera_list_company_paths',
		'qorpera_confirm_company_path_read',
		'qorpera_native_presence_register',
		'qorpera_company_presence_scope',
		'qorpera_native_presence_subject',
		'qorpera_describe_company_run_context',
		'qorpera_read_company_run_context',
		'qorpera_fence_native_context'
	]), false)
$$;

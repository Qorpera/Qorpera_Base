-- 20260930603000: the run's check around each tool call, in one database call (perf sprint A3, 7 Nov 2026).
--
-- The native host checks a run's authority three times for a read and four or more for a change: before the call,
-- again before its effect, and before its result goes back. Each check is two round trips, one after the other (R1, 28
-- Oct 2026): qorpera_describe_native_tool_authority, then qorpera_assert_company_path_reads. On the 126 runs of 5-6 Nov
-- that was 14,554 checks, 48 ms each at p50 (686 s), of which the database's part is about 6 ms a call; the rest is the
-- path to the database, once for each call.
--
-- qorpera_check_native_run makes the same two calls in one call of the native host, the read-set check first. Nothing
-- is skipped or remembered: both checks run on every check, and under READ COMMITTED each sees what committed before it
-- starts. A refusal from either is the call's refusal; when both would refuse, the read-set check's is the one seen. The
-- two are still never in flight at once (R1): they are two statements of one transaction, under one 8 s statement budget
-- instead of 8 s each.
--
-- The read-set check comes first because of the order of locks. It takes the run's budget row, with its own lock_timeout
-- of 3 s (20260930540000). Describe on a wake run takes the provider connection FOR SHARE and keeps it to the end of the
-- transaction (20260906000700). The order on every path is the run's row, then the connection, as the fence has made it
-- since 20260930481000. The other way round this call would hold the connection while it waited for the row: a
-- withdrawal of autonomous consent would wait for it, and a step holding the row that takes the login FOR UPDATE would
-- deadlock with it (test 467). So the row is held through describe, a few milliseconds.
--
-- It must ask what the two calls ask. So describe, called directly by this entry point, reads plain as it does when it
-- is the entry point itself (20260930487000, as 20260930499000 did for the context describe); any other caller keeps
-- the locked run check. With the row held the call gives up with 55P03 after about 3 s (test 467), and the checks made
-- are exactly the two calls' (test 1103). Without this describe would make a second, locked run check.
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
	-- The run's row before the connection describe takes on a wake run: the order of every path.
	perform public.qorpera_assert_company_path_reads(p_environment_id, p_binding, array[]::text[]);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	return v_authority;
end
$$;
revoke all on function public.qorpera_check_native_run(uuid, jsonb) from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_check_native_run(uuid, jsonb) to service_role;
comment on function public.qorpera_check_native_run(uuid, jsonb) is
	'The run''s check around a tool call, in one call: the read set, then the authority. Returns the authority. 20260930603000.';

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

-- describe: plain also under this call as the entry point, when it is the frame directly above describe.
create temporary table nc_before as
select prosecdef, proconfig, provolatile, proacl from pg_proc
where oid = 'public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure;

create function pg_temp.nc_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930603000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.nc_replace('public.qorpera_describe_native_tool_authority(jsonb)',
	$old$			or (v_entry is not distinct from 'qorpera_describe_company_run_context'
				and split_part(v_context, E'\n', 2) ~ '^PL/pgSQL function (public\.)?qorpera_describe_company_run_context\(jsonb\) line '))
$old$,
	$new$			or (v_entry is not distinct from 'qorpera_describe_company_run_context'
				and split_part(v_context, E'\n', 2) ~ '^PL/pgSQL function (public\.)?qorpera_describe_company_run_context\(jsonb\) line ')
			-- 20260930603000: or the run's check around a tool call is that entry point and calls describe itself.
			or (v_entry is not distinct from 'qorpera_check_native_run'
				and split_part(v_context, E'\n', 2) ~ '^PL/pgSQL function (public\.)?qorpera_check_native_run\(uuid,jsonb\) line '))
$new$);

do $$
declare v_describe pg_proc; v_before record;
begin
	select * into strict v_describe from pg_proc where oid = 'public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure;
	select * into strict v_before from pg_temp.nc_before;
	if position('20260930603000' in v_describe.prosrc) = 0 or position('20260930487000' in v_describe.prosrc) = 0
		or position('20260930499000' in v_describe.prosrc) = 0
		or v_describe.prosecdef is distinct from v_before.prosecdef or v_describe.proconfig is distinct from v_before.proconfig
		or v_describe.provolatile is distinct from v_before.provolatile or v_describe.proacl is distinct from v_before.proacl then
		raise exception '20260930603000: describe did not change as expected'; end if;
end $$;
drop table pg_temp.nc_before;

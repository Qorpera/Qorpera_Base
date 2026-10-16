-- The runtime's company-context describe reads its run without the run mutex (production DB slowness, 16 October 2026).
--
-- qorpera_describe_company_run_context took the run mutex three times over: qorpera_native_tool_locked_run runs
-- qorpera_folder_tool_run, which takes the run's qorpera_execution_run_budgets row FOR UPDATE (20260928279470); its
-- nested describe took the locked run check again (20260930487000 reads plain only for describe as the entry point);
-- and its context check, qorpera_company_path_assert_context, runs qorpera_folder_run_reads_current, which restamps the
-- run's read set with its receipts (20260928249000, 20260928469330). The runtime asks for it at the start of every run
-- together with qorpera_read_native_wake (stage company-context, cloud-native-company-runtime.ts), which takes the same
-- mutex and writes the read set too (a coworker wake's inherited reads, then the same reads check), so the database ran
-- the pair one after the other. On production on 16 October, after 20260930487000 and 20260930488000 went live (from
-- 19:20Z), every company-context stage took over 1 s (24 runs, p50 2266 ms, max 3710 ms), and run 266741f6's stage
-- (19:41:43.0 to 46.5Z, 3467 ms) overlapped two transactions' waits for a run budget row (19:41:45 to 49Z, the database
-- logs). It is the last call at a run's start that waited on the mutex.
--
-- Now, as the entry point (the rule of 20260930487000 and 20260930488000: request.path names the context describe in
-- PostgREST's form, /rpc/<name> or /rest/v1/rpc/<name>, and no function but it and the host entry,
-- qorpera_native_host_call, qorpera_native_host_call_long or qorpera_native_host_dispatch, is on the call stack; a DO
-- block or a session's own pg_temp function does not count; the host dispatcher sets request.path to the called
-- function, 20260928409985):
-- - it reads its run through qorpera_folder_native_run_plain;
-- - its nested describe reads plain too: describe's rule also takes a request.path that names the context describe when
--   the frame under describe is the context describe, and nothing but the two and the host entry is on the stack; called
--   any other way under that request.path (directly, or from another function), describe keeps the locked check;
-- - it keeps the context check's actor test (the run's resolved Company File actor is its own staff agent run, 42501)
--   and leaves out the context check's reads check (below).
-- Any other caller (direct SQL, another function) keeps qorpera_native_tool_locked_run and the whole context check, and
-- a request.path set by hand gains nothing inside another function. The answer is as before.
--
-- Why the plain read is safe: besides describe's reads, the context reads the run's actor, its session (still FOR
-- SHARE), the agent's staff row and recorded state, the company's folder index, the run's inputs and the history before
-- the run's transcript start, its job and job specification, the coworkers, the agent's folder state, the review origin
-- (20260930497000), its continuation and whether it has sent its progress acknowledgement. A run's own steps write only
-- what the last two read (its operation receipts and sends) and the folder, which other runs write without this run's
-- mutex anyway; the history stops before anything the run adds. So the mutex ordered this read only against the run's
-- own receipts and sends, and the host starts a run's first step only after the context. The continuation lists the
-- receipts and sends from before a sponsor handoff, which never took the mutex either, and the acknowledgement flag is
-- advisory (the wake work gate checks the canonical progress receipt itself). Each is read in one statement, and a
-- receipt or send that commits during the read gives the old or the new answer, the one a locked read that finished
-- just before or just after it would give. Describe's part is safe for the reasons of 20260930487000. The plain run
-- check keeps one lock, as for describe, and so does the run's actor: a wake run's sponsor test takes the provider
-- connection FOR SHARE.
--
-- Why the reads check can stay off the plain path: it writes the run's read set, and a writer keeps the mutex
-- (20260930487000). The run's reads are checked anyway, under the mutex and in the same stage: qorpera_read_native_wake
-- runs the same check for every wake it reads (qorpera_folder_read_wake, 20260928279580, 20260928549470), and the
-- runtime fails the stage when it refuses. Before every model request the context fence (qorpera_fence_native_context,
-- 20260930481000) checks the run's released reads again. The context's answer does not come from the read set.
--
-- What keeps the mutex: every writer, qorpera_read_native_wake, the context fence and its nested describe, and
-- qorpera_assert_company_path_reads. Both functions are patched in place from pg_get_functiondef (the context describe
-- with 20260930497000's origin, describe with 20260930487000's rule and the fast-mode check of 20260927161500); their
-- grants and settings are as before. DB only: no caller changes (the runtime keeps the pair's shared budget).
set local lock_timeout = '3s';

create temporary table c_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in ('public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure,
	'public.qorpera_describe_company_run_context(jsonb)'::regprocedure);

create function pg_temp.c_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930499000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. describe: plain also under the context describe as the entry point.
select pg_temp.c_replace('public.qorpera_describe_native_tool_authority(jsonb)',
	E'\tv_until timestamptz; v_remaining bigint; v_manifest jsonb; v_context text;\n',
	E'\tv_until timestamptz; v_remaining bigint; v_manifest jsonb; v_context text; v_entry text;\n');

select pg_temp.c_replace('public.qorpera_describe_native_tool_authority(jsonb)',
	$old$	get diagnostics v_context = pg_context;
	if substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$')
			is not distinct from 'qorpera_describe_native_tool_authority'
		and v_context ~ '^PL/pgSQL function (public\.)?qorpera_describe_native_tool_authority\(jsonb\) line '
		and not exists (select 1 from regexp_matches(v_context, '^(?:PL/pgSQL function |SQL function ")([^ ("]+)', 'gn') as f(name)
			where regexp_replace(f.name[1], '^public\.', '') not in ('qorpera_describe_native_tool_authority',
				'qorpera_native_host_dispatch', 'qorpera_native_host_call', 'qorpera_native_host_call_long')
$old$,
	$new$	-- 20260930499000: or the context describe is that entry point and calls describe itself (the frame under it).
	get diagnostics v_context = pg_context;
	v_entry := substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$');
	if (v_entry is not distinct from 'qorpera_describe_native_tool_authority'
			or (v_entry is not distinct from 'qorpera_describe_company_run_context'
				and split_part(v_context, E'\n', 2) ~ '^PL/pgSQL function (public\.)?qorpera_describe_company_run_context\(jsonb\) line '))
		and v_context ~ '^PL/pgSQL function (public\.)?qorpera_describe_native_tool_authority\(jsonb\) line '
		and not exists (select 1 from regexp_matches(v_context, '^(?:PL/pgSQL function |SQL function ")([^ ("]+)', 'gn') as f(name)
			where regexp_replace(f.name[1], '^public\.', '') not in ('qorpera_describe_native_tool_authority', v_entry,
				'qorpera_native_host_dispatch', 'qorpera_native_host_call', 'qorpera_native_host_call_long')
$new$);

-- 2. The context describe: the plain run check as the entry point, and its context check's actor test only.
select pg_temp.c_replace('public.qorpera_describe_company_run_context(jsonb)',
	E'\tv_history_count bigint; v_coworker_count bigint; v_result jsonb; v_continuation jsonb; v_recorded jsonb; v_folder jsonb;\n',
	E'\tv_history_count bigint; v_coworker_count bigint; v_result jsonb; v_continuation jsonb; v_recorded jsonb; v_folder jsonb;\n'
	|| E'\tv_context text; v_plain boolean;\n');

select pg_temp.c_replace('public.qorpera_describe_company_run_context(jsonb)',
	$old$	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_run_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
$old$,
	$new$	-- 20260930499000: as the entry point (the host's or PostgREST's request.path names the context describe, and no
	-- function but the host entry calls it), a plain read without the run mutex, and describe below reads plain too; any
	-- other caller keeps the locked run check.
	get diagnostics v_context = pg_context;
	v_plain := substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$')
			is not distinct from 'qorpera_describe_company_run_context'
		and v_context ~ '^PL/pgSQL function (public\.)?qorpera_describe_company_run_context\(jsonb\) line '
		and not exists (select 1 from regexp_matches(v_context, '^(?:PL/pgSQL function |SQL function ")([^ ("]+)', 'gn') as f(name)
			where regexp_replace(f.name[1], '^public\.', '') not in ('qorpera_describe_company_run_context',
				'qorpera_native_host_dispatch', 'qorpera_native_host_call', 'qorpera_native_host_call_long')
				and f.name[1] !~ '^(pg_temp(_[0-9]+)?\.|inline_code_block$)');
	if v_plain then
		v_run := public.qorpera_folder_native_run_plain(p_binding);
	else
		v_run := public.qorpera_native_tool_locked_run(p_binding);
	end if;
	v_actor := public.qorpera_company_run_actor(v_run.environment_id,p_binding);
	if not v_plain then
		perform public.qorpera_company_path_assert_context(v_actor);
	-- The plain read keeps the context check's actor test (20260928279470) and leaves its reads check, a writer of the
	-- run's read set, to qorpera_read_native_wake and the context fence (20260930499000).
	elsif v_actor ->> 'runId' is not null
		and (v_actor -> 'folder' -> 'resolved' ->> 'kind' is distinct from 'staff_agent'
			or v_actor -> 'folder' -> 'resolved' ->> 'runId' is distinct from v_actor ->> 'runId') then
		raise exception 'Company File authority is unavailable' using errcode = '42501';
	end if;
$new$);

comment on function public.qorpera_folder_native_run_plain(jsonb) is
	'The run check of qorpera_native_tool_locked_run as plain reads: the same lookups, refusals and run row, without the '
	'run mutex (no budget row) or the locked check''s other row locks; a wake run''s sponsor test still takes the '
	'provider connection FOR SHARE. Only qorpera_describe_native_tool_authority, qorpera_list_native_connector_tools and '
	'qorpera_describe_company_run_context call it, each as the entry point (describe also when the context describe, as '
	'the entry point, calls it). 20260930487000, 20260930488000, 20260930499000.';

do $$
declare v_describe pg_proc; v_context pg_proc; v_before record;
begin
	select * into strict v_describe from pg_proc where oid = 'public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure;
	select * into strict v_context from pg_proc where oid = 'public.qorpera_describe_company_run_context(jsonb)'::regprocedure;
	select * into strict v_before from pg_temp.c_before where oid = v_describe.oid;
	if position('20260930499000' in v_describe.prosrc) = 0 or position('20260930487000' in v_describe.prosrc) = 0
		or position('v_run := public.qorpera_folder_native_run_plain(p_binding);' in v_describe.prosrc) = 0
		or position('v_run := public.qorpera_native_tool_locked_run(p_binding);' in v_describe.prosrc) = 0
		or position('(v_run.service_tier is null) <> (v_manifest #>> ''{modelPolicy,fastMode}'' is null)' in v_describe.prosrc) = 0
		or v_describe.prosecdef is distinct from v_before.prosecdef or v_describe.proconfig is distinct from v_before.proconfig
		or v_describe.provolatile is distinct from v_before.provolatile or v_describe.proacl is distinct from v_before.proacl then
		raise exception '20260930499000: describe did not change as expected'; end if;
	select * into strict v_before from pg_temp.c_before where oid = v_context.oid;
	if position('20260930499000' in v_context.prosrc) = 0 or position('20260930497000' in v_context.prosrc) = 0
		or position('v_run := public.qorpera_folder_native_run_plain(p_binding);' in v_context.prosrc) = 0
		or position('v_run := public.qorpera_native_tool_locked_run(p_binding);' in v_context.prosrc) = 0
		or position('perform public.qorpera_company_path_assert_context(v_actor);' in v_context.prosrc) = 0
		or position('v_authority := public.qorpera_describe_native_tool_authority(p_binding);' in v_context.prosrc) = 0
		or v_context.prosecdef is distinct from v_before.prosecdef or v_context.proconfig is distinct from v_before.proconfig
		or v_context.provolatile is distinct from v_before.provolatile or v_context.proacl is distinct from v_before.proacl then
		raise exception '20260930499000: the context describe did not change as expected'; end if;
end $$;
